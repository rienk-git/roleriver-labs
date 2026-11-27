import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LocalObjectStore } from "./object-store.js";
import { objectStoreContract } from "./object-store.contract.js";

const roots: string[] = [];
async function createRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "roleriver-objects-"));
  roots.push(dir);
  return dir;
}
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("local object storage", () => {
  objectStoreContract(async () => LocalObjectStore.open(await createRoot()));
  it("treats retry of identical content as idempotent and detects conflicting or corrupted objects", async () => {
    const root = await createRoot();
    const store = await LocalObjectStore.open(root);
    const bytes = new TextEncoder().encode("one");
    const metadata = await store.put("tenant-a", "object-1", bytes);
    expect(await store.put("tenant-a", "object-1", bytes)).toEqual(metadata);
    await expect(
      store.put("tenant-a", "object-1", new TextEncoder().encode("other")),
    ).rejects.toThrow("conflict");
    await writeFile(join(root, "tenant-a", "object-1"), "tampered");
    await expect(store.get("tenant-a", "object-1", metadata)).rejects.toThrow(
      "integrity",
    );
  });
  it("handles concurrent identical retries safely", async () => {
    const store = await LocalObjectStore.open(await createRoot());
    const bytes = new TextEncoder().encode("identical");
    const results = await Promise.all([
      store.put("tenant-a", "object-1", bytes),
      store.put("tenant-a", "object-1", bytes),
    ]);
    expect(results[0]).toEqual(results[1]);
    expect(await store.get("tenant-a", "object-1", results[0])).toEqual(bytes);
  });
  it("rejects path traversal, invalid IDs, and oversized objects", async () => {
    const store = await LocalObjectStore.open(await createRoot());
    await expect(
      store.put("tenant-a", "../escape", new Uint8Array()),
    ).rejects.toThrow();
    await expect(store.get("../escape", "object-1")).rejects.toThrow();
    await expect(
      store.put("tenant-a", "object-1", new Uint8Array(1024 * 1024 + 1)),
    ).rejects.toThrow();
  });
  it("fails closed on a symlink where an object is expected", async () => {
    const root = await createRoot();
    const outside = await createRoot();
    const store = await LocalObjectStore.open(root);
    await store.put("tenant-a", "object-1", new TextEncoder().encode("one"));
    await rm(join(root, "tenant-a", "object-1"));
    await symlink(join(outside, "secret"), join(root, "tenant-a", "object-1"));
    await expect(store.get("tenant-a", "object-1")).rejects.toThrow();
  });
  it("rejects a symlink ancestor and does not expose filesystem paths in errors", async () => {
    const root = await createRoot();
    const outside = await createRoot();
    await mkdir(join(outside, "actual"), { mode: 0o700 });
    await symlink(outside, join(root, "alias"));
    await expect(
      LocalObjectStore.open(join(root, "alias", "actual")),
    ).rejects.toThrow();
    await expect(
      LocalObjectStore.open(join(root, "missing-private-path")),
    ).rejects.not.toThrow("missing-private-path");
  });
  it("refuses a symlink root and symlink tenant directory", async () => {
    const root = await createRoot();
    const outside = await createRoot();
    await symlink(outside, join(root, "link"));
    await expect(LocalObjectStore.open(join(root, "link"))).rejects.toThrow();
    await symlink(outside, join(root, "tenant-a"));
    const store = await LocalObjectStore.open(root);
    await expect(
      store.put("tenant-a", "item", new Uint8Array()),
    ).rejects.toThrow();
    await mkdir(join(root, "tenant-b"), { mode: 0o700 });
  });
});
