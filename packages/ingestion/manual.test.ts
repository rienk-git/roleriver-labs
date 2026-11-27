import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  importManual,
  type ManualImportPorts,
  type ManualImportRecord,
} from "./manual.js";

const input = {
  tenantId: "tenant-a",
  vacancyId: "vacancy-1",
  sourceId: "manual",
  externalId: "ref-1",
  text: "  Ontwikkelaar\nErvaring met PHP  ",
  completeness: "partial" as const,
  origin: "manual" as const,
  sourceUrl: "https://example.test/role/1",
};
function setup() {
  const objects = new Map<string, Uint8Array>();
  const records = new Map<string, string>();
  const ports: ManualImportPorts = {
    policy: { allows: vi.fn(async () => true) },
    objects: {
      put: vi.fn(async (tenant, id, content) => {
        objects.set(`${tenant}/${id}`, content);
        return {
          size: content.byteLength,
          sha256: createHash("sha256").update(content).digest("hex"),
        };
      }),
    },
    records: {
      commit: vi.fn(
        async (
          record: ManualImportRecord,
        ): Promise<{ status: "created" | "duplicate" | "conflict" }> => {
          const key = `${record.tenantId}/${record.sourceId}/${record.externalId}`;
          const value = JSON.stringify(record);
          if (records.has(key))
            return {
              status: records.get(key) === value ? "duplicate" : "conflict",
            };
          records.set(key, value);
          return { status: "created" };
        },
      ),
    },
  };
  return { ports, objects, records };
}

describe("manual import", () => {
  it("preserves multilingual text and provenance without fetching URLs", async () => {
    const { ports, objects } = setup();
    const result = await importManual(input, ports);
    expect(result.ok && result.status).toBe("created");
    if (!result.ok) return;
    expect(
      new TextDecoder().decode(objects.get(`tenant-a/${result.object.id}`)),
    ).toBe(input.text);
    expect(ports.policy.allows).toHaveBeenCalledWith("manual", "manual_import");
    expect(ports.records.commit).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: "tenant-a",
        vacancyId: "vacancy-1",
        sourceId: "manual",
        externalId: "ref-1",
        completeness: "partial",
        origin: "manual",
        sourceUrl: input.sourceUrl,
        object: result.object,
      }),
    );
  });
  it("denies before storage when permission is missing or policy fails", async () => {
    const { ports } = setup();
    vi.mocked(ports.policy.allows)
      .mockResolvedValueOnce(false)
      .mockRejectedValueOnce(new Error("secret"));
    expect(await importManual(input, ports)).toEqual({
      ok: false,
      error: "policy_denied",
    });
    expect(await importManual(input, ports)).toEqual({
      ok: false,
      error: "policy_denied",
    });
    expect(ports.objects.put).not.toHaveBeenCalled();
    expect(ports.records.commit).not.toHaveBeenCalled();
  });
  it("uses tenant-scoped idempotency and does not treat changed text as a duplicate", async () => {
    const { ports } = setup();
    expect(await importManual(input, ports)).toMatchObject({
      ok: true,
      status: "created",
    });
    expect(await importManual(input, ports)).toMatchObject({
      ok: true,
      status: "duplicate",
    });
    expect(
      await importManual({ ...input, text: "Different content" }, ports),
    ).toEqual({ ok: false, error: "conflict" });
    expect(
      await importManual({ ...input, tenantId: "tenant-b" }, ports),
    ).toMatchObject({ ok: true, status: "created" });
  });
  it("preserves Gmail and unknown origin, and never marks them as externally authorized", async () => {
    const { ports } = setup();
    for (const origin of ["gmail", "unknown"] as const) {
      const result = await importManual(
        { ...input, externalId: origin, origin },
        ports,
      );
      expect(result.ok).toBe(true);
      expect(ports.records.commit).toHaveBeenLastCalledWith(
        expect.objectContaining({
          origin,
          externalProcessing: "not_authorized",
        }),
      );
    }
  });
  it("fails safely if object or metadata storage fails or returns inconsistent integrity", async () => {
    const { ports } = setup();
    vi.mocked(ports.objects.put).mockRejectedValueOnce(
      new Error("private message"),
    );
    expect(await importManual(input, ports)).toEqual({
      ok: false,
      error: "storage_error",
    });
    expect(ports.records.commit).not.toHaveBeenCalled();
    vi.mocked(ports.objects.put).mockResolvedValueOnce({
      size: 1,
      sha256: "fake",
    });
    expect(await importManual(input, ports)).toEqual({
      ok: false,
      error: "storage_error",
    });
    expect(ports.records.commit).not.toHaveBeenCalled();
    vi.mocked(ports.records.commit).mockRejectedValueOnce(
      new Error("private detail"),
    );
    expect(await importManual(input, ports)).toEqual({
      ok: false,
      error: "storage_error",
    });
  });
  it("reuses the same content address when metadata commit is retried", async () => {
    const { ports } = setup();
    vi.mocked(ports.records.commit).mockRejectedValueOnce(
      new Error("temporary failure"),
    );
    expect(await importManual(input, ports)).toEqual({
      ok: false,
      error: "storage_error",
    });
    const retried = await importManual(input, ports);
    expect(retried).toMatchObject({ ok: true, status: "created" });
    expect(vi.mocked(ports.objects.put).mock.calls[0]?.[1]).toEqual(
      vi.mocked(ports.objects.put).mock.calls[1]?.[1],
    );
  });
  it.each([
    { tenantId: "../tenant" },
    { vacancyId: "" },
    { text: " \n" },
    { text: "a".repeat(1024 * 1024 + 1) },
    { text: "\ud800" },
    { sourceUrl: "https://example.test/role?token=secret" },
    { sourceUrl: "https://example.test/role\n" },
  ])("rejects invalid or oversized input before storage", async (change) => {
    const { ports } = setup();
    expect(await importManual({ ...input, ...change }, ports)).toEqual({
      ok: false,
      error: "invalid_input",
    });
    expect(ports.objects.put).not.toHaveBeenCalled();
    expect(ports.records.commit).not.toHaveBeenCalled();
  });
});
