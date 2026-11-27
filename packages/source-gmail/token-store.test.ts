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
  it("encrypts, retrieves, replaces and deletes tokens", async () => {
    const dir = await directory();
    const store = await EncryptedTokenStore.open(dir, Buffer.alloc(32, 7));
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
    await store.delete("tenant", "connection");
    expect(await store.get("tenant", "connection")).toBeNull();
  });

  it("rejects wrong keys and untrusted directory links", async () => {
    const dir = await directory();
    const store = await EncryptedTokenStore.open(dir, Buffer.alloc(32, 1));
    await store.put("tenant", "connection", { refreshToken: "synthetic" });
    const wrong = await EncryptedTokenStore.open(dir, Buffer.alloc(32, 2));
    await expect(wrong.get("tenant", "connection")).rejects.toThrow(
      "Token storage failed",
    );
    const link = `${dir}-link`;
    await symlink(dir, link);
    try {
      await expect(
        EncryptedTokenStore.open(link, Buffer.alloc(32)),
      ).rejects.toThrow();
    } finally {
      await rm(link);
    }
    await expect(
      EncryptedTokenStore.open(dir, Buffer.alloc(31)),
    ).rejects.toThrow();
  });
  it("rejects tampering and ciphertext copied between connections", async () => {
    const dir = await directory();
    const store = await EncryptedTokenStore.open(dir, Buffer.alloc(32, 7));
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
