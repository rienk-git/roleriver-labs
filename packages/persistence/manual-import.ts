import { createHash } from "node:crypto";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
} from "@aws-sdk/lib-dynamodb";
import { z } from "zod";
import type {
  ManualImportPorts,
  ManualImportRecord,
} from "../ingestion/manual.js";

const identifier = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const externalId = z.string().min(1).max(512);
const url = z
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
      const parsed = new URL(value);
      return (
        parsed.protocol === "https:" &&
        !!parsed.hostname &&
        !parsed.username &&
        !parsed.password &&
        !parsed.search &&
        !parsed.hash
      );
    } catch {
      return false;
    }
  });
const object = z
  .strictObject({
    id: z.string().regex(/^[a-f0-9]{64}$/),
    size: z
      .number()
      .int()
      .min(1)
      .max(1024 * 1024),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .refine((value) => value.id === value.sha256);
const recordSchema = z.strictObject({
  tenantId: identifier,
  vacancyId: identifier,
  sourceId: identifier,
  externalId,
  completeness: z.enum(["full", "partial", "unknown"]),
  origin: z.enum(["manual", "gmail", "unknown"]),
  externalProcessing: z.literal("not_authorized"),
  sourceUrl: url.optional(),
  object,
});
const itemSchema = z.strictObject({
  pk: z.string(),
  sk: z.string(),
  record: recordSchema,
});
function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
function key(
  tenant: string,
  source: string,
  external: string,
): { pk: string; sk: string } {
  if (
    !identifier.safeParse(tenant).success ||
    !identifier.safeParse(source).success ||
    !externalId.safeParse(external).success
  )
    throw new Error("Invalid import identity");
  return {
    pk: `manual-import#${hash(tenant)}`,
    sk: `source#${hash(JSON.stringify([source, external]))}`,
  };
}

/**
 * Durable tenant-scoped metadata for the manual import use case. The caller must
 * authenticate/authorize the tenant and enforce source policy before calling this port.
 * Records reference content-addressed objects; no cross-store atomicity is implied.
 */
type ManualImportRecordStore = ManualImportPorts["records"];

export class ManualImportRepository implements ManualImportRecordStore {
  readonly #client: DynamoDBDocumentClient;
  readonly #table: string;
  constructor(client: DynamoDBDocumentClient, table: string) {
    if (!/^[A-Za-z0-9_.-]{3,255}$/.test(table))
      throw new Error("Invalid repository configuration");
    this.#client = client;
    this.#table = table;
  }

  async get(
    tenantId: string,
    sourceId: string,
    reference: string,
  ): Promise<ManualImportRecord | null> {
    const identity = key(tenantId, sourceId, reference);
    let item: unknown;
    try {
      item = (
        await this.#client.send(
          new GetCommand({
            TableName: this.#table,
            Key: identity,
            ConsistentRead: true,
          }),
          { abortSignal: AbortSignal.timeout(5000) },
        )
      ).Item;
    } catch {
      throw new Error("Manual import storage operation failed");
    }
    if (!item) return null;
    const parsed = itemSchema.safeParse(item);
    if (
      !parsed.success ||
      parsed.data.pk !== identity.pk ||
      parsed.data.sk !== identity.sk ||
      parsed.data.record.tenantId !== tenantId ||
      parsed.data.record.sourceId !== sourceId ||
      parsed.data.record.externalId !== reference
    )
      throw new Error("Stored manual import metadata is invalid");
    return parsed.data.record;
  }

  async commit(
    input: ManualImportRecord,
  ): Promise<{ status: "created" | "duplicate" | "conflict" }> {
    const parsed = recordSchema.safeParse(input);
    if (!parsed.success) throw new Error("Invalid manual import metadata");
    const record = parsed.data;
    const identity = key(record.tenantId, record.sourceId, record.externalId);
    try {
      await this.#client.send(
        new PutCommand({
          TableName: this.#table,
          Item: { ...identity, record },
          ConditionExpression:
            "attribute_not_exists(#pk) AND attribute_not_exists(#sk)",
          ExpressionAttributeNames: { "#pk": "pk", "#sk": "sk" },
        }),
        { abortSignal: AbortSignal.timeout(5000) },
      );
      return { status: "created" };
    } catch (error) {
      if (
        !(error instanceof Error) ||
        error.name !== "ConditionalCheckFailedException"
      ) {
        // Provider errors may contain private request data; do not attach them.
        // eslint-disable-next-line preserve-caught-error
        throw new Error("Manual import storage operation failed");
      }
      const existing = await this.get(
        record.tenantId,
        record.sourceId,
        record.externalId,
      );
      return {
        status:
          existing && JSON.stringify(existing) === JSON.stringify(record)
            ? "duplicate"
            : "conflict",
      };
    }
  }
}
