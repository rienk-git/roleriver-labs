import { constants } from "node:fs";
import { lstat, open, realpath, rename, unlink } from "node:fs/promises";
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import { join, resolve } from "node:path";

export interface StoredGmailTokens {
  refreshToken: string;
  accessToken?: string;
  expiresAt?: number;
}
export interface GmailTokenGate {
  run<T>(
    tenant: string,
    connection: string,
    operation: () => Promise<T>,
  ): Promise<T>;
}
export interface GmailDisconnectedRevocation {
  tenant: string;
  connection: string;
  gate: GmailTokenGate;
  state(): Promise<"never_issued" | "pending" | "revoked" | "complete">;
  authorize(): Promise<boolean>;
  markRevoked(): Promise<void>;
  markNoIssuance(): Promise<void>;
  markDeleted(): Promise<void>;
  fetcher: typeof fetch;
  timeoutMs?: number;
}
const failure = () => new Error("Token storage failed");
function validTokens(value: unknown): value is StoredGmailTokens {
  if (!value || typeof value !== "object") return false;
  const t = value as Record<string, unknown>;
  return (
    Object.keys(t).every((k) =>
      ["refreshToken", "accessToken", "expiresAt"].includes(k),
    ) &&
    typeof t.refreshToken === "string" &&
    t.refreshToken.length > 0 &&
    t.refreshToken.length < 16384 &&
    (t.accessToken === undefined ||
      (typeof t.accessToken === "string" &&
        t.accessToken.length > 0 &&
        t.accessToken.length < 16384)) &&
    (t.expiresAt === undefined ||
      (typeof t.expiresAt === "number" &&
        Number.isSafeInteger(t.expiresAt) &&
        t.expiresAt >= 0))
  );
}

/** Requires a private directory with trusted, non-replaceable ancestors and no hostile same-user processes. */
export class EncryptedTokenStore {
  readonly #key: Buffer;
  private constructor(
    private readonly directory: string,
    key: Uint8Array,
    private readonly gate: GmailTokenGate,
    private readonly revocation?: GmailDisconnectedRevocation,
  ) {
    this.#key = Buffer.from(key);
  }
  static async open(
    directory: string,
    key: Uint8Array,
    gate: GmailTokenGate,
    revocation?: GmailDisconnectedRevocation,
  ): Promise<EncryptedTokenStore> {
    try {
      if (
        key.length !== 32 ||
        !gate ||
        typeof gate.run !== "function" ||
        typeof process.getuid !== "function" ||
        !constants.O_NOFOLLOW
      )
        throw failure();
      const path = resolve(directory);
      if ((await realpath(path)) !== path) throw failure();
      const info = await lstat(path);
      if (
        !info.isDirectory() ||
        info.uid !== process.getuid() ||
        (info.mode & 0o077) !== 0
      )
        throw failure();
      if (revocation && (!revocation.tenant || !revocation.connection))
        throw failure();
      const bound = revocation
        ? Object.freeze({
            ...revocation,
            gate: Object.freeze({
              run: revocation.gate.run.bind(revocation.gate),
            }),
          })
        : undefined;
      return new EncryptedTokenStore(path, key, gate, bound);
    } catch {
      throw failure();
    }
  }
  #location(tenant: string, connection: string) {
    if (
      !tenant ||
      !connection ||
      tenant.length > 256 ||
      connection.length > 256
    )
      throw failure();
    const identity = JSON.stringify([tenant, connection]);
    return {
      path: join(
        this.directory,
        createHash("sha256").update(identity).digest("hex"),
      ),
      aad: Buffer.from(`gmail-token-v1:${identity}`),
    };
  }
  async #syncDirectory(): Promise<void> {
    const directory = await open(
      this.directory,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    try {
      const info = await directory.stat();
      if (
        !info.isDirectory() ||
        info.uid !== process.getuid!() ||
        (info.mode & 0o077) !== 0
      )
        throw failure();
      await directory.sync();
    } finally {
      await directory.close();
    }
  }
  async put(
    tenant: string,
    connection: string,
    tokens: StoredGmailTokens,
  ): Promise<void> {
    if (!validTokens(tokens)) throw failure();
    const snapshot = Object.freeze({ ...tokens });
    try {
      await this.gate.run(tenant, connection, () =>
        this.putUnsafe(tenant, connection, snapshot),
      );
    } catch {
      throw failure();
    }
  }
  private async putUnsafe(
    tenant: string,
    connection: string,
    tokens: StoredGmailTokens,
  ): Promise<void> {
    let temp: string | undefined;
    try {
      if (!validTokens(tokens)) throw failure();
      const { path, aad } = this.#location(tenant, connection);
      const nonce = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", this.#key, nonce);
      cipher.setAAD(aad);
      const ciphertext = Buffer.concat([
        cipher.update(JSON.stringify(tokens), "utf8"),
        cipher.final(),
      ]);
      const payload = JSON.stringify({
        version: 1,
        nonce: nonce.toString("base64url"),
        tag: cipher.getAuthTag().toString("base64url"),
        ciphertext: ciphertext.toString("base64url"),
      });
      temp = join(this.directory, `.tmp-${randomBytes(16).toString("hex")}`);
      const file = await open(
        temp,
        constants.O_CREAT |
          constants.O_EXCL |
          constants.O_WRONLY |
          constants.O_NOFOLLOW,
        0o600,
      );
      try {
        await file.writeFile(payload);
        await file.sync();
      } finally {
        await file.close();
      }
      try {
        const existing = await lstat(path);
        if (!existing.isFile()) throw failure();
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      await rename(temp, path);
      temp = undefined;
      await this.#syncDirectory();
    } catch {
      throw failure();
    } finally {
      if (temp) await unlink(temp).catch(() => undefined);
    }
  }
  async get(
    tenant: string,
    connection: string,
  ): Promise<StoredGmailTokens | null> {
    try {
      return await this.gate.run(tenant, connection, () =>
        this.getUnsafe(tenant, connection),
      );
    } catch {
      throw failure();
    }
  }
  private async getUnsafe(
    tenant: string,
    connection: string,
  ): Promise<StoredGmailTokens | null> {
    try {
      const { path, aad } = this.#location(tenant, connection);
      let file;
      try {
        file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
      try {
        const info = await file.stat();
        if (
          !info.isFile() ||
          info.uid !== process.getuid!() ||
          (info.mode & 0o077) !== 0 ||
          info.size > 65536
        )
          throw failure();
        const body: unknown = JSON.parse(await file.readFile("utf8"));
        if (
          !body ||
          typeof body !== "object" ||
          !("version" in body) ||
          body.version !== 1 ||
          !("nonce" in body) ||
          typeof body.nonce !== "string" ||
          !("tag" in body) ||
          typeof body.tag !== "string" ||
          !("ciphertext" in body) ||
          typeof body.ciphertext !== "string"
        )
          throw failure();
        const nonce = Buffer.from(body.nonce, "base64url");
        const tag = Buffer.from(body.tag, "base64url");
        if (nonce.length !== 12 || tag.length !== 16) throw failure();
        const decipher = createDecipheriv("aes-256-gcm", this.#key, nonce);
        decipher.setAAD(aad);
        decipher.setAuthTag(tag);
        const decoded: unknown = JSON.parse(
          Buffer.concat([
            decipher.update(Buffer.from(body.ciphertext, "base64url")),
            decipher.final(),
          ]).toString("utf8"),
        );
        if (!validTokens(decoded)) throw failure();
        return decoded;
      } finally {
        await file.close();
      }
    } catch {
      throw failure();
    }
  }
  /** Only the disconnected cleanup gate may expose the refresh token to the fixed Google endpoint. */
  async revokeAndDelete(tenant: string, connection: string): Promise<void> {
    const options = this.revocation;
    if (
      !options ||
      tenant !== options.tenant ||
      connection !== options.connection
    )
      throw failure();
    const timeout = options.timeoutMs ?? 10000;
    if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 30000)
      throw failure();
    try {
      await options.gate.run(tenant, connection, async () => {
        const state = await options.state();
        if (state === "complete") {
          if ((await this.getUnsafe(tenant, connection)) !== null)
            throw failure();
          return;
        }
        if (state === "never_issued") {
          if ((await this.getUnsafe(tenant, connection)) !== null)
            throw failure();
          await options.markNoIssuance();
          return;
        }
        if (state === "pending") {
          const tokens = await this.getUnsafe(tenant, connection);
          if (!tokens || !tokens.refreshToken) throw failure();
          if ((await options.authorize()) !== true) throw failure();
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), timeout);
          try {
            const response = await options.fetcher(
              "https://oauth2.googleapis.com/revoke",
              {
                method: "POST",
                headers: {
                  "content-type": "application/x-www-form-urlencoded",
                },
                body: new URLSearchParams({ token: tokens.refreshToken }),
                redirect: "error",
                signal: controller.signal,
              },
            );
            // Hold the cleanup gate until the response body has stopped.
            if (response.body) await response.body.cancel();
            if (response.status !== 200) throw failure();
          } finally {
            clearTimeout(timer);
          }
          await options.markRevoked();
        } else if (state !== "revoked") throw failure();
        await this.deleteUnsafe(tenant, connection);
        await options.markDeleted();
      });
    } catch {
      throw failure();
    }
  }
  private async deleteUnsafe(
    tenant: string,
    connection: string,
  ): Promise<void> {
    try {
      const { path } = this.#location(tenant, connection);
      try {
        const info = await lstat(path);
        if (!info.isFile()) throw failure();
        await unlink(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      await this.#syncDirectory();
    } catch {
      throw failure();
    }
  }
}
