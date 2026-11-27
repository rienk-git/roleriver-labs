import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
} from "@aws-sdk/lib-dynamodb";
import { Entity } from "electrodb";
import { z } from "zod";

const id = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const text = z
  .string()
  .min(1)
  .max(512)
  .refine((value) => value.trim().length > 0);
const sourceUrl = z
  .string()
  .max(2048)
  .refine((value) => {
    if (
      !/^https:\/\//i.test(value) ||
      value.includes("\\") ||
      [...value].some((character) => {
        const code = character.codePointAt(0)!;
        return code < 0x20 || code === 0x7f || /\s/u.test(character);
      }) ||
      value.includes("?") ||
      value.includes("#") ||
      /^https:\/\/[^/?#]*@/i.test(value)
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
  }, "Source URL must be sanitized HTTPS without userinfo, query or fragment");
const sourceReferenceSchema = z.object({
  source: id,
  externalId: z.string().min(1).max(512),
  sourceHash: z.string().regex(/^[a-f0-9]{64}$/),
  url: sourceUrl.optional(),
});
const canonicalInstant = z.iso.datetime().refine((value) => {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString() === value;
});
const inputSchema = z.strictObject({
  id,
  title: text,
  organization: text,
  createdAt: canonicalInstant,
  source: id,
  externalId: z.string().min(1).max(512),
  sourceUrl: sourceUrl.optional(),
});
const contentSchema = z.strictObject({ title: text, organization: text });
const recordSchema = z.object({
  id,
  title: text,
  organization: text,
  createdAt: z.iso.datetime(),
  version: z.number().int().positive(),
});
import type {
  Vacancy,
  NewVacancy,
  VacancyStore,
  SourceReference,
} from "./ports.js";
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
function tenantHash(tenant: string): string {
  return sha(id.parse(tenant));
}
function sourceHash(source: string, externalId: string): string {
  id.parse(source);
  z.string().min(1).max(512).parse(externalId);
  return sha(JSON.stringify([source, externalId]));
}
const attrs = {
  tenant: { type: "string", required: true },
  id: { type: "string", required: true },
  createdAt: { type: "string", required: true },
  version: { type: "number", required: true },
  title: { type: "string", required: true },
  organization: { type: "string", required: true },
} as const;
const head = new Entity({
  model: { entity: "vacancy", service: "roleriver", version: "1" },
  attributes: attrs,
  indexes: {
    primary: {
      pk: { field: "pk", composite: ["tenant"] },
      sk: { field: "sk", composite: ["id"], casing: "none" },
    },
    recent: {
      index: "gsi1",
      pk: { field: "gsi1pk", composite: ["tenant"] },
      sk: { field: "gsi1sk", composite: ["createdAt", "id"], casing: "none" },
    },
  },
});
const snapshot = new Entity({
  model: { entity: "vacancyversion", service: "roleriver", version: "1" },
  attributes: attrs,
  indexes: {
    primary: {
      pk: { field: "pk", composite: ["tenant"] },
      sk: { field: "sk", composite: ["id", "version"], casing: "none" },
    },
  },
});
const claim = new Entity({
  model: { entity: "sourceclaim", service: "roleriver", version: "1" },
  attributes: {
    tenant: { type: "string", required: true },
    sourceHash: { type: "string", required: true },
    id: { type: "string", required: true },
  },
  indexes: {
    primary: {
      pk: { field: "pk", composite: ["tenant"] },
      sk: { field: "sk", composite: ["sourceHash"] },
    },
  },
});

const provenance = new Entity({
  model: { entity: "provenance", service: "roleriver", version: "1" },
  attributes: {
    tenant: { type: "string", required: true },
    id: { type: "string", required: true },
    sourceHash: { type: "string", required: true },
    source: { type: "string", required: true },
    externalId: { type: "string", required: true },
    url: { type: "string" },
  },
  indexes: {
    primary: {
      pk: { field: "pk", composite: ["tenant"] },
      sk: { field: "sk", composite: ["id", "sourceHash"], casing: "none" },
    },
  },
});

/** Explicit loopback-only development client; never resolves AWS credentials or endpoints. */
export function createLocalClient(endpoint: string): DynamoDBDocumentClient {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new Error("Invalid local DynamoDB endpoint");
  }
  if (
    url.protocol !== "http:" ||
    !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
    !url.port ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  )
    throw new Error(
      "DynamoDB Local endpoint must be an explicit loopback HTTP URL",
    );
  return DynamoDBDocumentClient.from(
    new DynamoDBClient({
      endpoint: url.toString(),
      region: "local",
      credentials: { accessKeyId: "dummy", secretAccessKey: "dummy" },
      maxAttempts: 2,
    }),
  );
}
function conditional(error: unknown): boolean {
  if (
    !(error instanceof Error) ||
    error.name !== "TransactionCanceledException"
  )
    return false;
  const reasons =
    "CancellationReasons" in error ? error.CancellationReasons : undefined;
  return (
    Array.isArray(reasons) &&
    reasons.some(
      (reason: { Code?: string }) => reason.Code === "ConditionalCheckFailed",
    ) &&
    reasons.every(
      (reason: { Code?: string }) =>
        reason.Code === "ConditionalCheckFailed" ||
        reason.Code === "None" ||
        reason.Code === undefined,
    )
  );
}
function validRecord(item: unknown): Vacancy | null {
  if (!item) return null;
  const parsed = recordSchema.safeParse(item);
  if (!parsed.success) throw new Error("Stored vacancy is invalid");
  return parsed.data;
}

/** Caller is responsible for authenticating and authorizing tenant identity. */
export class VacancyRepository implements VacancyStore {
  readonly #cursorSecret: string;
  constructor(
    private readonly client: DynamoDBDocumentClient,
    private readonly table: string,
    cursorSecret: string,
  ) {
    if (
      !/^[A-Za-z0-9_.-]{3,255}$/.test(table) ||
      Buffer.byteLength(cursorSecret) < 32
    )
      throw new Error("Invalid repository configuration");
    this.#cursorSecret = cursorSecret;
  }
  private async getRaw(
    key: Record<string, string>,
  ): Promise<Record<string, unknown> | undefined> {
    try {
      const result = await this.client.send(
        new GetCommand({
          TableName: this.table,
          Key: key,
          ConsistentRead: true,
        }),
        { abortSignal: AbortSignal.timeout(5000) },
      );
      return result.Item;
    } catch {
      throw new Error("Persistence operation failed");
    }
  }
  async get(tenant: string, vacancyId: string): Promise<Vacancy | null> {
    const t = tenantHash(tenant);
    id.parse(vacancyId);
    const key = head
      .get({ tenant: t, id: vacancyId })
      .params({ table: this.table }).Key;
    return validRecord(await this.getRaw(key));
  }
  async getVersion(
    tenant: string,
    vacancyId: string,
    version: number,
  ): Promise<Vacancy | null> {
    const t = tenantHash(tenant);
    id.parse(vacancyId);
    z.number().int().positive().parse(version);
    const key = snapshot
      .get({ tenant: t, id: vacancyId, version })
      .params({ table: this.table }).Key;
    return validRecord(await this.getRaw(key));
  }
  async findBySource(
    tenant: string,
    source: string,
    externalId: string,
  ): Promise<Vacancy | null> {
    const t = tenantHash(tenant);
    const hash = sourceHash(source, externalId);
    const key = claim
      .get({ tenant: t, sourceHash: hash })
      .params({ table: this.table }).Key;
    const item = await this.getRaw(key);
    if (!item) return null;
    const claimed = id.safeParse(item.id);
    if (!claimed.success) throw new Error("Stored source claim is invalid");
    // Fail closed if an older claim has no recoverable provenance, or if the
    // stored reference does not match the requested identity.
    const reference = await this.getSourceReference(t, claimed.data, hash);
    if (
      !reference ||
      reference.source !== source ||
      reference.externalId !== externalId
    )
      throw new Error("Stored provenance is invalid or requires migration");
    return this.get(tenant, claimed.data);
  }
  private async getSourceReference(
    tenant: string,
    vacancyId: string,
    hash: string,
  ): Promise<SourceReference | null> {
    const key = provenance
      .get({ tenant, id: vacancyId, sourceHash: hash })
      .params({ table: this.table }).Key;
    const item = await this.getRaw(key);
    if (!item) return null;
    const parsed = sourceReferenceSchema.safeParse(item);
    if (
      !parsed.success ||
      sourceHash(parsed.data.source, parsed.data.externalId) !== hash
    )
      throw new Error("Stored provenance is invalid or requires migration");
    return parsed.data;
  }
  async create(
    tenant: string,
    input: NewVacancy,
  ): Promise<{ status: "created" | "duplicate" | "conflict" }> {
    const t = tenantHash(tenant);
    const value = inputSchema.parse(input);
    const hash = sourceHash(value.source, value.externalId);
    const data = {
      tenant: t,
      id: value.id,
      title: value.title,
      organization: value.organization,
      createdAt: value.createdAt,
      version: 1,
    };
    const vacancy = head.create(data).params({ table: this.table });
    const version = snapshot.create(data).params({ table: this.table });
    const source = claim
      .create({ tenant: t, sourceHash: hash, id: value.id })
      .params({ table: this.table });
    const provenanceItem = provenance
      .create({
        tenant: t,
        id: value.id,
        sourceHash: hash,
        source: value.source,
        externalId: value.externalId,
        url: value.sourceUrl,
      })
      .params({ table: this.table });
    try {
      await this.client.send(
        new TransactWriteCommand({
          TransactItems: [
            { Put: { ...vacancy, TableName: this.table, Item: vacancy.Item } },
            { Put: { ...version, TableName: this.table, Item: version.Item } },
            { Put: { ...source, TableName: this.table, Item: source.Item } },
            {
              Put: {
                ...provenanceItem,
                TableName: this.table,
                Item: provenanceItem.Item,
              },
            },
          ],
        }),
        { abortSignal: AbortSignal.timeout(5000) },
      );
      return { status: "created" };
    } catch (error) {
      // Do not expose provider error payloads or private request data.
      // eslint-disable-next-line preserve-caught-error
      if (!conditional(error)) throw new Error("Persistence operation failed");
      const existing = await this.findBySource(
        tenant,
        value.source,
        value.externalId,
      );
      if (
        existing?.id !== value.id ||
        existing.title !== value.title ||
        existing.organization !== value.organization ||
        existing.createdAt !== value.createdAt
      )
        return { status: "conflict" };
      const reference = await this.getSourceReference(t, value.id, hash);
      if (!reference) {
        // Do not include provider error details or private request data.
        // eslint-disable-next-line preserve-caught-error
        throw new Error("Stored provenance is invalid or requires migration");
      }
      return {
        status:
          reference.source === value.source &&
          reference.externalId === value.externalId &&
          reference.url === value.sourceUrl
            ? "duplicate"
            : "conflict",
      };
    }
  }
  async attachSource(
    tenant: string,
    vacancyId: string,
    source: string,
    externalId: string,
    options: { url?: string } = {},
  ): Promise<{ status: "attached" | "duplicate" | "conflict" | "not_found" }> {
    const t = tenantHash(tenant);
    id.parse(vacancyId);
    const hash = sourceHash(source, externalId);
    const checkedOptions = z
      .strictObject({ url: sourceUrl.optional() })
      .parse(options);
    const headKey = head
      .get({ tenant: t, id: vacancyId })
      .params({ table: this.table }).Key;
    const claimItem = claim
      .create({ tenant: t, id: vacancyId, sourceHash: hash })
      .params({ table: this.table });
    const provenanceItem = provenance
      .create({
        tenant: t,
        id: vacancyId,
        sourceHash: hash,
        source,
        externalId,
        url: checkedOptions.url,
      })
      .params({ table: this.table });
    try {
      await this.client.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              ConditionCheck: {
                TableName: this.table,
                Key: headKey,
                ConditionExpression:
                  "attribute_exists(#pk) AND attribute_exists(#sk)",
                ExpressionAttributeNames: { "#pk": "pk", "#sk": "sk" },
              },
            },
            {
              Put: {
                ...claimItem,
                TableName: this.table,
                Item: claimItem.Item,
              },
            },
            {
              Put: {
                ...provenanceItem,
                TableName: this.table,
                Item: provenanceItem.Item,
              },
            },
          ],
        }),
        { abortSignal: AbortSignal.timeout(5000) },
      );
      return { status: "attached" };
    } catch (error) {
      if (!conditional(error)) {
        // Provider payloads may contain private request data.
        // eslint-disable-next-line preserve-caught-error
        throw new Error("Persistence operation failed");
      }
      if (!(await this.get(tenant, vacancyId))) return { status: "not_found" };
      const existing = await this.findBySource(tenant, source, externalId);
      if (existing?.id !== vacancyId) return { status: "conflict" };
      const reference = await this.getSourceReference(t, vacancyId, hash);
      if (!reference) {
        // Do not include provider error details or private request data.
        // eslint-disable-next-line preserve-caught-error
        throw new Error("Stored provenance is invalid or requires migration");
      }
      return {
        status:
          reference.source === source &&
          reference.externalId === externalId &&
          reference.url === checkedOptions.url
            ? "duplicate"
            : "conflict",
      };
    }
  }
  async listSources(
    tenant: string,
    vacancyId: string,
    options: { limit: number; cursor?: string },
  ): Promise<{ items: SourceReference[]; cursor: string | null }> {
    const t = tenantHash(tenant);
    id.parse(vacancyId);
    z.number().int().min(1).max(50).parse(options.limit);
    const scope = `${t}:sources:${vacancyId}`;
    const key = options.cursor
      ? this.decodeCursor(scope, options.cursor, "base")
      : undefined;
    const params = provenance.query
      .primary({ tenant: t, id: vacancyId })
      .params({ table: this.table, limit: options.limit });
    let page;
    try {
      page = await this.client.send(
        new QueryCommand({
          ...params,
          ExclusiveStartKey: key,
          ConsistentRead: true,
        }),
        { abortSignal: AbortSignal.timeout(5000) },
      );
    } catch {
      throw new Error("Persistence operation failed");
    }
    const items = (page.Items ?? []).map((item) => {
      const parsed = sourceReferenceSchema.safeParse(item);
      if (
        !parsed.success ||
        sourceHash(parsed.data.source, parsed.data.externalId) !==
          parsed.data.sourceHash
      )
        throw new Error("Stored provenance is invalid or requires migration");
      return parsed.data;
    });
    return {
      items,
      cursor: page.LastEvaluatedKey
        ? this.encodeCursor(scope, page.LastEvaluatedKey)
        : null,
    };
  }
  async replace(
    tenant: string,
    vacancyId: string,
    expectedVersion: number,
    content: { title: string; organization: string },
  ): Promise<{ status: "updated" | "conflict" }> {
    const t = tenantHash(tenant);
    id.parse(vacancyId);
    z.number().int().positive().safe().parse(expectedVersion);
    const c = contentSchema.parse(content);
    const current = await this.get(tenant, vacancyId);
    if (
      !current ||
      current.version !== expectedVersion ||
      expectedVersion === Number.MAX_SAFE_INTEGER
    )
      return { status: "conflict" };
    const next = {
      tenant: t,
      id: vacancyId,
      createdAt: current.createdAt,
      version: expectedVersion + 1,
      ...c,
    };
    const newHead = head.put(next).params({ table: this.table });
    const version = snapshot.create(next).params({ table: this.table });
    try {
      await this.client.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Put: {
                TableName: this.table,
                Item: newHead.Item,
                ConditionExpression: "#version = :expected",
                ExpressionAttributeNames: { "#version": "version" },
                ExpressionAttributeValues: { ":expected": expectedVersion },
              },
            },
            { Put: { ...version, TableName: this.table, Item: version.Item } },
          ],
        }),
        { abortSignal: AbortSignal.timeout(5000) },
      );
      return { status: "updated" };
    } catch (error) {
      if (conditional(error)) return { status: "conflict" };
      // Provider error details may contain private request data.
      // eslint-disable-next-line preserve-caught-error
      throw new Error("Persistence operation failed");
    }
  }
  private encodeCursor(tenant: string, key: Record<string, unknown>): string {
    const payload = Buffer.from(JSON.stringify({ tenant, key })).toString(
      "base64url",
    );
    return `${payload}.${createHmac("sha256", this.#cursorSecret).update(payload).digest("base64url")}`;
  }
  private decodeCursor(
    tenant: string,
    cursor: string,
    kind: "base" | "gsi" = "gsi",
  ): Record<string, string> {
    if (
      cursor.length > 4096 ||
      !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(cursor)
    )
      throw new Error("Invalid cursor");
    const [payload, signature] = cursor.split(".") as [string, string];
    const expected = createHmac("sha256", this.#cursorSecret)
      .update(payload)
      .digest();
    const actual = Buffer.from(signature, "base64url");
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
      throw new Error("Invalid cursor");
    try {
      const value = z
        .strictObject({
          tenant: z.string(),
          key:
            kind === "gsi"
              ? z.strictObject({
                  pk: z.string(),
                  sk: z.string(),
                  gsi1pk: z.string(),
                  gsi1sk: z.string(),
                })
              : z.strictObject({ pk: z.string(), sk: z.string() }),
        })
        .parse(JSON.parse(Buffer.from(payload, "base64url").toString("utf8")));
      if (value.tenant !== tenant) throw new Error();
      return value.key;
    } catch {
      throw new Error("Invalid cursor");
    }
  }
  async listRecent(
    tenant: string,
    options: { limit: number; cursor?: string },
  ): Promise<{ items: Vacancy[]; cursor: string | null }> {
    const t = tenantHash(tenant);
    z.number().int().min(1).max(50).parse(options.limit);
    const params = head.query
      .recent({ tenant: t })
      .params({ table: this.table, limit: options.limit, order: "desc" });
    const key = options.cursor
      ? this.decodeCursor(`${t}:recent`, options.cursor)
      : undefined;
    let page;
    try {
      page = await this.client.send(
        new QueryCommand({ ...params, ExclusiveStartKey: key }),
        { abortSignal: AbortSignal.timeout(5000) },
      );
    } catch {
      throw new Error("Persistence operation failed");
    }
    const items = (page.Items ?? []).map((item) => validRecord(item)!);
    return {
      items,
      cursor: page.LastEvaluatedKey
        ? this.encodeCursor(`${t}:recent`, page.LastEvaluatedKey)
        : null,
    };
  }
}
