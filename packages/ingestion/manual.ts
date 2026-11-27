import { createHash } from "node:crypto";
import { z } from "zod";

const MAX_BYTES = 1024 * 1024;
const identifier = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const sourceUrl = z
  .string()
  .max(2048)
  .refine((value) => {
    if (
      !/^https:\/\//i.test(value) ||
      value.includes("\\") ||
      value.includes("?") ||
      value.includes("#") ||
      /^https:\/\/[^/?#]*@/i.test(value) ||
      [...value].some((character) => {
        const code = character.codePointAt(0)!;
        return code < 0x20 || code === 0x7f || /\s/u.test(character);
      })
    )
      return false;
    try {
      const url = new URL(value);
      return (
        url.protocol === "https:" &&
        !!url.hostname &&
        !url.username &&
        !url.password &&
        !url.search &&
        !url.hash
      );
    } catch {
      return false;
    }
  });
const inputSchema = z.strictObject({
  tenantId: identifier,
  vacancyId: identifier,
  sourceId: identifier,
  externalId: z.string().min(1).max(512),
  text: z
    .string()
    .refine(
      (value) =>
        value.length <= MAX_BYTES &&
        value.trim().length > 0 &&
        value.isWellFormed() &&
        new TextEncoder().encode(value).byteLength <= MAX_BYTES,
    ),
  completeness: z.enum(["full", "partial", "unknown"]),
  // This is trusted caller context, not a classification supplied by source content.
  origin: z.enum(["manual", "gmail", "unknown"]),
  sourceUrl: sourceUrl.optional(),
});
export type ManualImportInput = z.infer<typeof inputSchema>;
export interface ManualObjectReference {
  id: string;
  size: number;
  sha256: string;
}
export interface ManualImportRecord {
  tenantId: string;
  vacancyId: string;
  sourceId: string;
  externalId: string;
  completeness: "full" | "partial" | "unknown";
  origin: "manual" | "gmail" | "unknown";
  externalProcessing: "not_authorized";
  sourceUrl?: string;
  object: ManualObjectReference;
}
export interface ManualImportPorts {
  policy: {
    allows(sourceId: string, method: "manual_import"): Promise<boolean>;
  };
  objects: {
    put(
      tenantId: string,
      id: string,
      content: Uint8Array,
    ): Promise<{ size: number; sha256: string }>;
  };
  /** Must atomically enforce tenant/source identity and reject changed metadata or content. */
  records: {
    commit(
      record: ManualImportRecord,
    ): Promise<{ status: "created" | "duplicate" | "conflict" }>;
  };
}
export type ManualImportResult =
  | { ok: true; status: "created" | "duplicate"; object: ManualObjectReference }
  | {
      ok: false;
      error: "invalid_input" | "policy_denied" | "storage_error" | "conflict";
    };

/**
 * The trusted caller must preserve the actual origin. Manual import does not authorize
 * external AI processing or URL fetching. Object and metadata writes are not atomic:
 * if metadata commit fails, an unreferenced object may remain for later reconciliation.
 * Never delete it here because another successful import may reference the same object.
 */
export async function importManual(
  input: ManualImportInput,
  ports: ManualImportPorts,
): Promise<ManualImportResult> {
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "invalid_input" };
  const data = parsed.data;
  try {
    if ((await ports.policy.allows(data.sourceId, "manual_import")) !== true)
      return { ok: false, error: "policy_denied" };
  } catch {
    return { ok: false, error: "policy_denied" };
  }
  const content = new TextEncoder().encode(data.text);
  const sha256 = createHash("sha256").update(content).digest("hex");
  const object = { id: sha256, size: content.byteLength, sha256 };
  try {
    const stored = await ports.objects.put(data.tenantId, object.id, content);
    if (stored.size !== object.size || stored.sha256 !== object.sha256)
      return { ok: false, error: "storage_error" };
    const result = await ports.records.commit({
      tenantId: data.tenantId,
      vacancyId: data.vacancyId,
      sourceId: data.sourceId,
      externalId: data.externalId,
      completeness: data.completeness,
      origin: data.origin,
      externalProcessing: "not_authorized",
      ...(data.sourceUrl === undefined ? {} : { sourceUrl: data.sourceUrl }),
      object,
    });
    if (result.status === "conflict") return { ok: false, error: "conflict" };
    if (result.status !== "created" && result.status !== "duplicate")
      return { ok: false, error: "storage_error" };
    return { ok: true, status: result.status, object };
  } catch {
    return { ok: false, error: "storage_error" };
  }
}
