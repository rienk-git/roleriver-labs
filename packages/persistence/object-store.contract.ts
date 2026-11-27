import { expect, it } from "vitest";
import type { ObjectStore } from "./ports.js";

/** Apply the same synthetic behavioral contract to every object-store adapter. */
export function objectStoreContract(factory: () => Promise<ObjectStore>): void {
  it("stores objects with integrity metadata and isolates tenants", async () => {
    const store = await factory();
    const bytes = new TextEncoder().encode("synthetic content");
    const metadata = await store.put("tenant-a", "object-1", bytes);
    expect(metadata.size).toBe(bytes.length);
    expect(metadata.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(await store.get("tenant-a", "object-1", metadata)).toEqual(bytes);
    expect(await store.get("tenant-b", "object-1")).toBeNull();
    await store.delete("tenant-b", "object-1");
    expect(await store.get("tenant-a", "object-1", metadata)).toEqual(bytes);
    expect(await store.put("tenant-a", "object-1", bytes)).toEqual(metadata);
    await expect(
      store.put("tenant-a", "object-1", new TextEncoder().encode("different")),
    ).rejects.toThrow();
    await store.delete("tenant-a", "object-1");
    expect(await store.get("tenant-a", "object-1")).toBeNull();
  });
}
