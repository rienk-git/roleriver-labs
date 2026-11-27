import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, link, unlink, realpath } from "node:fs/promises";
import { resolve, join } from "node:path";
import type { ObjectStore } from "./ports.js";

class ObjectStoreError extends Error {}
function sanitize(error: unknown): ObjectStoreError {
  return error instanceof ObjectStoreError
    ? error
    : new ObjectStoreError("Object storage operation failed");
}

const MAX_OBJECT_BYTES = 1024 * 1024;
const idPattern = /^[A-Za-z0-9_-]{1,64}$/;
function checkId(value: string): void {
  if (!idPattern.test(value))
    throw new ObjectStoreError("Invalid object identifier");
}
function missing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
async function privateDirectory(path: string): Promise<void> {
  const stats = await lstat(path);
  const canonical = await realpath(path);
  if (
    canonical !== path ||
    !stats.isDirectory() ||
    stats.isSymbolicLink() ||
    (stats.mode & 0o077) !== 0 ||
    (typeof process.getuid === "function" && stats.uid !== process.getuid())
  ) {
    throw new ObjectStoreError(
      "Storage directory must be private and owned by the current user",
    );
  }
}
function digest(content: Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

/**
 * Uses a trusted private root; every ancestor must also be trusted and must not
 * be writable or replaceable by untrusted users. Path checks are not atomic,
 * so this adapter does not defend against malicious same-UID processes or an
 * adversary capable of replacing an ancestor during an operation.
 */
export class LocalObjectStore implements ObjectStore {
  readonly #root: string;

  private constructor(root: string) {
    this.#root = root;
  }

  static async open(root: string): Promise<LocalObjectStore> {
    if (
      typeof constants.O_NOFOLLOW !== "number" ||
      typeof process.getuid !== "function"
    )
      throw new ObjectStoreError(
        "Private local object storage is not supported on this platform",
      );
    const resolved = resolve(root);
    try {
      await privateDirectory(resolved);
      return new LocalObjectStore(resolved);
    } catch (error) {
      // Do not expose private filesystem paths.
      throw sanitize(error);
    }
  }

  private async directory(
    tenantId: string,
    create: boolean,
  ): Promise<string | null> {
    checkId(tenantId);
    await privateDirectory(this.#root);
    const path = join(this.#root, tenantId);
    if (create) {
      try {
        await mkdir(path, { mode: 0o700 });
      } catch (error) {
        if (!(
          error instanceof Error &&
          "code" in error &&
          error.code === "EEXIST"
        ))
          throw error;
      }
    }
    try {
      await privateDirectory(path);
    } catch (error) {
      if (missing(error) && !create) return null;
      throw error;
    }
    return path;
  }

  async put(
    tenantId: string,
    objectId: string,
    content: Uint8Array,
  ): Promise<{ size: number; sha256: string }> {
    try {
      return await this.putUnsafe(tenantId, objectId, content);
    } catch (error) {
      // Do not expose private filesystem paths.
      throw sanitize(error);
    }
  }

  private async putUnsafe(
    tenantId: string,
    objectId: string,
    content: Uint8Array,
  ): Promise<{ size: number; sha256: string }> {
    checkId(objectId);
    if (content.byteLength > MAX_OBJECT_BYTES)
      throw new ObjectStoreError("Object exceeds size limit");
    const dir = (await this.directory(tenantId, true))!;
    const metadata = { size: content.byteLength, sha256: digest(content) };
    const tmp = join(dir, `tmp_${randomUUID()}`);
    const target = join(dir, objectId);
    const file = await open(
      tmp,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
    try {
      try {
        await file.writeFile(content);
        await file.sync();
      } finally {
        await file.close();
      }
      try {
        await link(tmp, target);
      } catch (error) {
        if (!(
          error instanceof Error &&
          "code" in error &&
          error.code === "EEXIST"
        ))
          throw error;
        const existing = await this.getUnsafe(tenantId, objectId);
        if (
          !existing ||
          existing.byteLength !== metadata.size ||
          digest(existing) !== metadata.sha256
        ) {
          // The underlying filesystem error contains a private path.
          throw new ObjectStoreError("Object identifier conflict");
        }
      }
    } finally {
      await unlink(tmp);
    }
    return metadata;
  }

  async get(
    tenantId: string,
    objectId: string,
    expected?: { size: number; sha256: string },
  ): Promise<Uint8Array | null> {
    try {
      return await this.getUnsafe(tenantId, objectId, expected);
    } catch (error) {
      // Do not expose private filesystem paths.
      throw sanitize(error);
    }
  }

  private async getUnsafe(
    tenantId: string,
    objectId: string,
    expected?: { size: number; sha256: string },
  ): Promise<Uint8Array | null> {
    checkId(objectId);
    const dir = await this.directory(tenantId, false);
    if (!dir) return null;
    let file;
    try {
      file = await open(
        join(dir, objectId),
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
    } catch (error) {
      if (missing(error)) return null;
      throw error;
    }
    try {
      const stats = await file.stat();
      if (!stats.isFile() || stats.size > MAX_OBJECT_BYTES)
        throw new ObjectStoreError("Invalid stored object");
      const data = Buffer.alloc(MAX_OBJECT_BYTES + 1);
      let total = 0;
      while (total < data.length) {
        const { bytesRead } = await file.read(
          data,
          total,
          data.length - total,
          null,
        );
        if (bytesRead === 0) break;
        total += bytesRead;
      }
      if (total > MAX_OBJECT_BYTES)
        throw new ObjectStoreError("Object exceeds size limit");
      const content = new Uint8Array(data.subarray(0, total));
      if (
        expected &&
        (expected.size !== content.byteLength ||
          expected.sha256 !== digest(content))
      )
        throw new ObjectStoreError("Object integrity mismatch");
      return content;
    } finally {
      await file.close();
    }
  }

  async delete(tenantId: string, objectId: string): Promise<void> {
    try {
      await this.deleteUnsafe(tenantId, objectId);
    } catch (error) {
      // Do not expose private filesystem paths.
      throw sanitize(error);
    }
  }

  private async deleteUnsafe(
    tenantId: string,
    objectId: string,
  ): Promise<void> {
    checkId(objectId);
    const dir = await this.directory(tenantId, false);
    if (!dir) return;
    const path = join(dir, objectId);
    try {
      const stats = await lstat(path);
      if (!stats.isFile() || stats.isSymbolicLink())
        throw new ObjectStoreError("Invalid stored object");
      await unlink(path);
    } catch (error) {
      if (!missing(error)) throw error;
    }
  }
}
