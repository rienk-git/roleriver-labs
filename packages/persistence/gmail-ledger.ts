/* Provider failures may contain private data; never expose them as causes. */
import { createHash } from "node:crypto";
import {
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
} from "@aws-sdk/lib-dynamodb";
import type {
  PollConfig,
  PollDependencies,
  PollScope,
  ReconciledMessage,
} from "../source-gmail/poll.js";
import type { ObjectStore } from "./ports.js";

const id = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const revision = (value: unknown): value is string =>
  typeof value === "string" && /^\d{1,32}$/.test(value);
const hash = (value: string | Uint8Array): string =>
  createHash("sha256").update(value).digest("hex");
const fail = (): never => {
  throw new Error("Gmail ledger operation failed");
};
function validObject(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const object = value as Record<string, unknown>;
  return (
    typeof object.id === "string" &&
    /^[a-f0-9]{64}$/.test(object.id) &&
    object.sha256 === object.id &&
    typeof object.size === "number" &&
    Number.isSafeInteger(object.size) &&
    object.size >= 0 &&
    object.size <= 1024 * 1024
  );
}
const fenceValue = (value: string): number => {
  if (!/^[1-9]\d{0,15}$/.test(value) || !Number.isSafeInteger(Number(value)))
    return fail();
  return Number(value);
};
function keys(scope: PollScope) {
  if (!id(scope.tenantId) || !id(scope.connectionId) || !id(scope.sourceId))
    return fail();
  const pk = `gmail#${hash(JSON.stringify([scope.tenantId, scope.connectionId]))}`;
  const prefix = `ledger#${hash(scope.sourceId)}#`;
  return {
    pk,
    prefix,
    lease: { pk, sk: "lease" },
    checkpoint: { pk, sk: `checkpoint#${hash(scope.sourceId)}` },
    sync: { pk, sk: `${prefix}sync` },
    message: (messageId: string) => ({
      pk,
      sk: `${prefix}message#${hash(messageId)}`,
    }),
  };
}

type Message = Exclude<ReconciledMessage, { kind: "unknown" }>;
interface LedgerRecord {
  pk: string;
  sk: string;
  messageId: string;
  revision: string;
  kind: "eligible" | "excluded";
  active: boolean;
  seen?: number;
  configVersion?: string;
  generation: number;
  origin: "gmail";
  externalProcessing: "not_authorized";
  object?: { id: string; size: number; sha256: string };
}

/**
 * The caller authenticates the tenant and controls access to the object store.
 * Never delete an object following a failed operation: a retry or another record
 * may reference it. Safe orphan collection requires separate coordination and is not implemented.
 * Full-sync mutations are not atomically visible with checkpoint publication.
 * The caller must serialize operations for an acquired fence; repeating begin with the
 * same fence refers to the same uninterrupted attempt, never a restarted scan. A new
 * scan must acquire a fresh fence. The lease generation
 * must never be reset or reused, and host clocks must be synchronized.
 */
export class GmailLedgerRepository {
  constructor(
    private readonly client: DynamoDBDocumentClient,
    private readonly table: string,
    private readonly objects: Pick<ObjectStore, "put">,
  ) {
    if (!/^[A-Za-z0-9_.-]{3,255}$/.test(table)) fail();
  }
  private condition(scope: PollScope, fence: number) {
    return {
      ConditionCheck: {
        TableName: this.table,
        Key: keys(scope).lease,
        ConditionExpression: "#generation = :generation AND #expires > :now",
        ExpressionAttributeNames: {
          "#generation": "generation",
          "#expires": "expiresAt",
        },
        ExpressionAttributeValues: { ":generation": fence, ":now": Date.now() },
      },
    };
  }
  private async read(key: {
    pk: string;
    sk: string;
  }): Promise<Record<string, unknown> | undefined> {
    return (
      await this.client.send(
        new GetCommand({
          TableName: this.table,
          Key: key,
          ConsistentRead: true,
        }),
        { abortSignal: AbortSignal.timeout(5000) },
      )
    ).Item;
  }
  private async tx(
    items: ConstructorParameters<
      typeof TransactWriteCommand
    >[0]["TransactItems"],
  ): Promise<void> {
    await this.client.send(new TransactWriteCommand({ TransactItems: items }), {
      abortSignal: AbortSignal.timeout(5000),
    });
  }
  readonly ledger: PollDependencies["ledger"] = {
    beginFullSync: async (
      scope: PollScope,
      config: PollConfig,
      fence: string,
    ) => {
      try {
        const generation = fenceValue(fence);
        if (!id(config.version)) return fail();
        const k = keys(scope);
        const previous = await this.read(k.sync);
        if (
          previous?.attempt === generation &&
          previous.configVersion === config.version
        ) {
          await this.tx([
            this.condition(scope, generation),
            {
              ConditionCheck: {
                TableName: this.table,
                Key: k.sync,
                ConditionExpression:
                  "attempt = :attempt AND configVersion = :version",
                ExpressionAttributeValues: {
                  ":attempt": generation,
                  ":version": config.version,
                },
              },
            },
          ]);
          return;
        }
        await this.tx([
          this.condition(scope, generation),
          {
            Put: {
              TableName: this.table,
              Item: {
                ...k.sync,
                attempt: generation,
                configVersion: config.version,
                status: "active",
              },
              ConditionExpression:
                "attribute_not_exists(attempt) OR attempt < :attempt",
              ExpressionAttributeValues: {
                ":attempt": generation,
              },
            },
          },
        ]);
      } catch {
        return fail();
      }
    },
    apply: async (scope: PollScope, message: Message, fence: string) => {
      try {
        const generation = fenceValue(fence);
        const k = keys(scope);
        if (
          !id(message.messageId) ||
          !revision(message.revision) ||
          (message.kind !== "eligible" && message.kind !== "excluded")
        )
          return fail();
        let object: LedgerRecord["object"];
        if (message.kind === "eligible") {
          if (typeof message.text !== "string" || !message.text.isWellFormed())
            return fail();
          const bytes = new TextEncoder().encode(message.text);
          if (bytes.byteLength > 1024 * 1024) return fail();
          const digest = hash(bytes);
          const stored = await this.objects.put(scope.tenantId, digest, bytes);
          if (stored.sha256 !== digest || stored.size !== bytes.byteLength)
            return fail();
          object = { id: digest, size: bytes.byteLength, sha256: digest };
        }
        const key = k.message(message.messageId);
        const [old, sync, checkpoint] = await Promise.all([
          this.read(key),
          this.read(k.sync),
          this.read(k.checkpoint),
        ]);
        if (
          old &&
          (!revision(old.revision) ||
            !Number.isSafeInteger(old.generation) ||
            !id(old.configVersion) ||
            (old.kind !== "eligible" && old.kind !== "excluded") ||
            old.messageId !== message.messageId)
        )
          return fail();
        if (
          sync &&
          (!Number.isSafeInteger(sync.attempt) ||
            typeof sync.configVersion !== "string" ||
            (sync.status !== "active" && sync.status !== "complete"))
        )
          return fail();
        if (sync?.attempt === generation && sync.status !== "active")
          return fail();
        const seen = sync?.attempt === generation ? generation : undefined;
        const priorCheckpoint = checkpoint?.checkpoint;
        const currentConfig =
          seen !== undefined
            ? sync?.configVersion
            : priorCheckpoint && typeof priorCheckpoint === "object"
              ? (priorCheckpoint as Record<string, unknown>).configVersion
              : undefined;
        if (!id(currentConfig)) return fail();
        const older =
          old && BigInt(old.revision as string) > BigInt(message.revision);
        if (
          older &&
          seen !== undefined &&
          old.configVersion !== sync?.configVersion
        )
          return fail();
        if (
          old &&
          BigInt(old.revision as string) === BigInt(message.revision)
        ) {
          const changedSelection =
            seen !== undefined && old.configVersion !== sync?.configVersion;
          if (
            (old.kind !== message.kind && !changedSelection) ||
            (old.kind === "eligible" &&
              message.kind === "eligible" &&
              (!old.object ||
                typeof old.object !== "object" ||
                (old.object as Record<string, unknown>).id !== object?.id ||
                (old.object as Record<string, unknown>).size !== object?.size ||
                (old.object as Record<string, unknown>).sha256 !==
                  object?.sha256))
          )
            return fail();
        }
        const item = older
          ? {
              ...old,
              ...(seen === undefined ? {} : { seen }),
              generation: (old.generation as number) + 1,
            }
          : {
              ...key,
              messageId: message.messageId,
              revision: message.revision,
              kind: message.kind,
              active: message.kind === "eligible",
              origin: "gmail",
              externalProcessing: "not_authorized",
              ...(object ? { object } : {}),
              ...(seen === undefined ? {} : { seen }),
              configVersion: currentConfig,
              generation: old ? (old.generation as number) + 1 : 1,
            };
        if (!Number.isSafeInteger(item.generation)) return fail();
        await this.tx([
          this.condition(scope, generation),
          {
            Put: {
              TableName: this.table,
              Item: item,
              ConditionExpression: old
                ? "#generation = :previous"
                : "attribute_not_exists(pk)",
              ...(old
                ? {
                    ExpressionAttributeNames: { "#generation": "generation" },
                    ExpressionAttributeValues: { ":previous": old.generation },
                  }
                : {}),
            },
          },
        ]);
      } catch {
        return fail();
      }
    },
    finishFullSync: async (
      scope: PollScope,
      config: PollConfig,
      fence: string,
    ) => {
      try {
        const generation = fenceValue(fence);
        const k = keys(scope);
        if (!id(config.version)) return fail();
        const checkSync = () => ({
          ConditionCheck: {
            TableName: this.table,
            Key: k.sync,
            ConditionExpression:
              "attempt = :attempt AND configVersion = :version AND #status = :active",
            ExpressionAttributeNames: { "#status": "status" },
            ExpressionAttributeValues: {
              ":attempt": generation,
              ":version": config.version,
              ":active": "active",
            },
          },
        });
        const sync = await this.read(k.sync);
        if (
          sync?.attempt !== generation ||
          sync.configVersion !== config.version
        )
          return fail();
        if (sync.status === "complete") {
          await this.tx([this.condition(scope, generation)]);
          return;
        }
        if (sync.status !== "active") return fail();
        let cursor: Record<string, unknown> | undefined;
        do {
          const page = await this.client.send(
            new QueryCommand({
              TableName: this.table,
              KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
              ExpressionAttributeValues: {
                ":pk": k.pk,
                ":prefix": `${k.prefix}message#`,
              },
              ConsistentRead: true,
              Limit: 100,
              ...(cursor ? { ExclusiveStartKey: cursor } : {}),
            }),
            { abortSignal: AbortSignal.timeout(5000) },
          );
          for (const record of page.Items ?? []) {
            if (
              !Number.isSafeInteger(record.generation) ||
              (record.generation as number) < 1 ||
              !id(record.messageId) ||
              !revision(record.revision) ||
              typeof record.active !== "boolean" ||
              (record.kind !== "eligible" && record.kind !== "excluded") ||
              (record.active && record.kind !== "eligible") ||
              (record.kind === "eligible" && !validObject(record.object)) ||
              !id(record.configVersion) ||
              record.pk !== k.pk ||
              record.sk !== k.message(record.messageId as string).sk ||
              record.origin !== "gmail" ||
              record.externalProcessing !== "not_authorized"
            )
              return fail();
            if (record.seen === generation || record.active === false) continue;
            if (!Number.isSafeInteger((record.generation as number) + 1))
              return fail();
            await this.tx([
              this.condition(scope, generation),
              checkSync(),
              {
                Update: {
                  TableName: this.table,
                  Key: { pk: k.pk, sk: record.sk },
                  UpdateExpression:
                    "SET active = :inactive, #generation = :next",
                  ConditionExpression: "#generation = :previous",
                  ExpressionAttributeNames: { "#generation": "generation" },
                  ExpressionAttributeValues: {
                    ":inactive": false,
                    ":next": (record.generation as number) + 1,
                    ":previous": record.generation,
                  },
                },
              },
            ]);
          }
          cursor = page.LastEvaluatedKey;
        } while (cursor);
        await this.tx([
          this.condition(scope, generation),
          {
            Update: {
              TableName: this.table,
              Key: k.sync,
              UpdateExpression: "SET #status = :complete",
              ConditionExpression:
                "attempt = :attempt AND configVersion = :version AND #status = :active",
              ExpressionAttributeNames: { "#status": "status" },
              ExpressionAttributeValues: {
                ":attempt": generation,
                ":version": config.version,
                ":active": "active",
                ":complete": "complete",
              },
            },
          },
        ]);
      } catch {
        return fail();
      }
    },
  };
}
