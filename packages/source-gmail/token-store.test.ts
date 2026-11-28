import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EncryptedTokenStore } from "./token-store.js";

const gate = {
  run: async <T>(
    _tenant: string,
    _connection: string,
    operation: () => Promise<T>,
  ) => operation(),
};
const directories: string[] = [];
async function directory() {
  const dir = await mkdtemp(join(tmpdir(), "gmail-test-"));
  directories.push(dir);
  return dir;
}
afterEach(async () => {
  for (const dir of directories.splice(0))
    await rm(dir, { recursive: true, force: true });
});

describe("encrypted token store", () => {
  it("retains encrypted credentials when provider success is ambiguous or its marker is not durable", async () => {
    const dir = await directory();
    let status: "pending" | "revoked" | "complete" = "pending";
    let loseResponse = false;
    const store = await EncryptedTokenStore.open(
      dir,
      Buffer.alloc(32, 7),
      gate,
      {
        tenant: "tenant",
        connection: "connection",
        gate,
        state: async () => status,
        authorize: async () => true,
        fetcher: async () => {
          if (loseResponse) throw new Error("provider response lost");
          return new Response(null, { status: 200 });
        },
        markRevoked: async () => {
          throw new Error("marker write failed");
        },
        markNoIssuance: async () => {},
        markDeleted: async () => {
          status = "complete";
        },
      },
    );
    await store.put("tenant", "connection", {
      refreshToken: "synthetic-secret",
    });
    await expect(store.revokeAndDelete("tenant", "connection")).rejects.toThrow(
      "Token storage failed",
    );
    expect(status).toBe("pending");
    expect(await readdir(dir)).toHaveLength(1);
    loseResponse = true;
    await expect(store.revokeAndDelete("tenant", "connection")).rejects.toThrow(
      "Token storage failed",
    );
    expect(status).toBe("pending");
    expect((await store.get("tenant", "connection"))?.refreshToken).toBe(
      "synthetic-secret",
    );
  });
  it("encrypts, retrieves, replaces and deletes tokens", async () => {
    const dir = await directory();
    let status: "pending" | "revoked" | "complete" = "pending";
    const store = await EncryptedTokenStore.open(
      dir,
      Buffer.alloc(32, 7),
      gate,
      {
        tenant: "tenant",
        connection: "connection",
        gate,
        state: async () => status,
        authorize: async () => true,
        fetcher: async () => new Response(null, { status: 200 }),
        markRevoked: async () => {
          status = "revoked";
        },
        markNoIssuance: async () => {},
        markDeleted: async () => {
          status = "complete";
        },
      },
    );
    await store.put("tenant", "connection", {
      refreshToken: "synthetic-refresh",
      accessToken: "synthetic-access",
      expiresAt: 123,
    });
    const file = join(dir, (await readdir(dir))[0]!);
    expect(await readFile(file, "utf8")).not.toContain("synthetic");
    expect(await store.get("tenant", "connection")).toEqual({
      refreshToken: "synthetic-refresh",
      accessToken: "synthetic-access",
      expiresAt: 123,
    });
    await store.put("tenant", "connection", { refreshToken: "new-refresh" });
    expect(await store.get("tenant", "connection")).toEqual({
      refreshToken: "new-refresh",
    });
    await store.revokeAndDelete("tenant", "connection");
    expect(await store.get("tenant", "connection")).toBeNull();
  });

  it("rejects wrong keys and untrusted directory links", async () => {
    const dir = await directory();
    const store = await EncryptedTokenStore.open(
      dir,
      Buffer.alloc(32, 1),
      gate,
    );
    await store.put("tenant", "connection", { refreshToken: "synthetic" });
    const wrong = await EncryptedTokenStore.open(
      dir,
      Buffer.alloc(32, 2),
      gate,
    );
    await expect(wrong.get("tenant", "connection")).rejects.toThrow(
      "Token storage failed",
    );
    const link = `${dir}-link`;
    await symlink(dir, link);
    try {
      await expect(
        EncryptedTokenStore.open(link, Buffer.alloc(32), gate),
      ).rejects.toThrow();
    } finally {
      await rm(link);
    }
    await expect(
      EncryptedTokenStore.open(dir, Buffer.alloc(31), gate),
    ).rejects.toThrow();
  });
  it("rejects tampering and ciphertext copied between connections", async () => {
    const dir = await directory();
    const store = await EncryptedTokenStore.open(
      dir,
      Buffer.alloc(32, 7),
      gate,
    );
    await store.put("tenant", "a", { refreshToken: "synthetic-a" });
    const [first] = await readdir(dir);
    const encrypted = await readFile(join(dir, first!), "utf8");
    await store.put("tenant", "b", { refreshToken: "synthetic-b" });
    const second = (await readdir(dir)).find((name) => name !== first)!;
    await writeFile(join(dir, second), encrypted);
    await expect(store.get("tenant", "b")).rejects.toThrow(
      "Token storage failed",
    );
    const body = JSON.parse(encrypted) as { tag: string };
    body.tag = Buffer.alloc(16).toString("base64url");
    await writeFile(join(dir, first!), JSON.stringify(body));
    await expect(store.get("tenant", "a")).rejects.toThrow(
      "Token storage failed",
    );
  });
});
