import { createHash } from "node:crypto";
import {
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
} from "@aws-sdk/lib-dynamodb";
import type { TransactWriteCommandInput } from "@aws-sdk/lib-dynamodb";
import type { PollScope } from "../source-gmail/poll.js";
import type { ObjectStore } from "./ports.js";
import {
  connectedCondition,
  connectionExistsCondition,
  disconnectedCondition,
} from "./gmail-connection.js";

/** The implementation must exclude and drain all tenant writers across processes. */
export interface TenantObjectBarrier {
  exclusive<T>(tenantId: string, task: () => Promise<T>): Promise<T>;
}

export interface GmailObjectReference {
  id: string;
  size: number;
  sha256: string;
}

type TransactionItem = NonNullable<
  TransactWriteCommandInput["TransactItems"]
>[number];
const identity = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const digest = (value: string | Uint8Array) =>
  createHash("sha256").update(value).digest("hex");
const validObjectId = (value: unknown): value is string =>
  typeof value === "string" && /^go_[a-f0-9]{32}$/.test(value);
const error = () => new Error("Gmail object operation failed");
// Transaction actions are restricted to JSON so the hash binds the exact snapshot
// executed. A different property order may conservatively produce a conflict.
function snapshotActions(actions: TransactionItem[]): {
  actions: TransactionItem[];
  hash: string;
} {
  const validate = (value: unknown): void => {
    if (
      value === null ||
      typeof value === "string" ||
      typeof value === "boolean"
    )
      return;
    if (typeof value === "number" && Number.isFinite(value)) return;
    if (Array.isArray(value)) {
      for (const item of value) validate(item);
      return;
    }
    if (
      typeof value !== "object" ||
      Object.getPrototypeOf(value) !== Object.prototype
    )
      throw error();
    for (const item of Object.values(value as Record<string, unknown>))
      validate(item);
  };
  validate(actions);
  const encoded = JSON.stringify(actions);
  return {
    actions: JSON.parse(encoded) as TransactionItem[],
    hash: digest(encoded),
  };
}
function partition(scope: PollScope, fence: string) {
  if (
    !identity(scope.tenantId) ||
    !identity(scope.connectionId) ||
    !identity(scope.sourceId) ||
    typeof fence !== "string" ||
    !/^[1-9]\d{0,15}$/.test(fence) ||
    !Number.isSafeInteger(Number(fence))
  )
    throw error();
  const pk = `gmail#${digest(JSON.stringify([scope.tenantId, scope.connectionId]))}`;
  return {
    pk,
    lease: { pk, sk: "lease" },
    prefix: `object#${digest(scope.sourceId)}#`,
    claim: (objectId: string) => ({
      pk: `gmail-object#${digest(scope.tenantId)}`,
      sk: objectId,
    }),
    initialHold: (objectId: string) => ({
      pk,
      sk: `hold#${digest(scope.sourceId)}#${objectId}#${digest(JSON.stringify(["processing", "initial"]))}`,
    }),
    owner: digest(
      JSON.stringify([scope.tenantId, scope.connectionId, scope.sourceId]),
    ),
  };
}

/**
 * Inactive building block: every writer and collector must share the barrier and
 * reserve go_<UUID> IDs for this lifecycle, including after a write completes.
 * Callers must authenticate scope, atomically publish references, and enforce all
 * holds in deletion actions. None of those integration guarantees exists yet.
 */
export class GmailObjectLifecycle {
  constructor(
    private readonly client: DynamoDBDocumentClient,
    private readonly table: string,
    private readonly objects: ObjectStore,
    private readonly barrier: TenantObjectBarrier,
  ) {
    if (!/^[A-Za-z0-9_.-]{3,255}$/.test(table)) throw error();
  }

  /** Caller actions must invalidate all references and prove no holds remain atomically. */
  async scheduleDeletion(
    scope: PollScope,
    fence: string,
    id: string,
    release: TransactionItem[],
  ): Promise<void> {
    if (!scope) throw error();
    scope = Object.freeze({ ...scope });
    const k = partition(scope, fence);
    if (
      !validObjectId(id) ||
      !Array.isArray(release) ||
      release.length === 0 ||
      release.length > 96
    )
      throw error();
    const snapshot = snapshotActions(release);
    const releaseHash = snapshot.hash;
    try {
      await this.barrier.exclusive(scope.tenantId, async () => {
        await this.transaction([
          this.fence(scope, fence),
          connectionExistsCondition(this.table, scope),
          {
            ConditionCheck: {
              TableName: this.table,
              Key: k.claim(id),
              ConditionExpression: "#owner = :owner",
              ExpressionAttributeNames: { "#owner": "owner" },
              ExpressionAttributeValues: { ":owner": k.owner },
            },
          },
          {
            Update: {
              TableName: this.table,
              Key: { pk: k.pk, sk: `${k.prefix}${id}` },
              UpdateExpression:
                "SET #status = :deleting, releaseHash = :releaseHash",
              ConditionExpression:
                "#status = :committed AND objectId = :id AND holdCount = :zero AND deletionPending = :yes",
              ExpressionAttributeNames: { "#status": "status" },
              ExpressionAttributeValues: {
                ":committed": "committed",
                ":deleting": "deleting",
                ":id": id,
                ":releaseHash": releaseHash,
                ":zero": 0,
                ":yes": true,
              },
            },
          },
          ...snapshot.actions,
        ]);
      });
    } catch {
      // A successful transaction can lose its response. Reconcile only after
      // rechecking the active fence and the durable deletion state atomically.
      try {
        await this.barrier.exclusive(scope.tenantId, async () => {
          await this.transaction([
            this.fence(scope, fence),
            connectionExistsCondition(this.table, scope),
            {
              ConditionCheck: {
                TableName: this.table,
                Key: k.claim(id),
                ConditionExpression: "#owner = :owner",
                ExpressionAttributeNames: { "#owner": "owner" },
                ExpressionAttributeValues: { ":owner": k.owner },
              },
            },
            {
              ConditionCheck: {
                TableName: this.table,
                Key: { pk: k.pk, sk: `${k.prefix}${id}` },
                ConditionExpression:
                  "objectId = :id AND releaseHash = :releaseHash AND (#status = :deleting OR #status = :deleted)",
                ExpressionAttributeNames: { "#status": "status" },
                ExpressionAttributeValues: {
                  ":id": id,
                  ":releaseHash": releaseHash,
                  ":deleting": "deleting",
                  ":deleted": "deleted",
                },
              },
            },
          ]);
        });
      } catch {
        throw error();
      }
    }
  }

  private fence(scope: PollScope, fence: string): TransactionItem {
    return {
      ConditionCheck: {
        TableName: this.table,
        Key: partition(scope, fence).lease,
        ConditionExpression: "#generation = :fence AND #expires > :now",
        ExpressionAttributeNames: {
          "#generation": "generation",
          "#expires": "expiresAt",
        },
        ExpressionAttributeValues: {
          ":fence": Number(fence),
          ":now": Date.now(),
        },
      },
    };
  }

  private async transaction(items: TransactionItem[]) {
    await this.client.send(new TransactWriteCommand({ TransactItems: items }), {
      abortSignal: AbortSignal.timeout(5000),
    });
  }

  /**
   * The caller must generate and persist a cryptographically random, never-reused
   * go_<32 lowercase hex> ID per logical publication and reuse it for retries.
   * Publication items must atomically install this reference in the owning ledger;
   * reusing an ID for a different destination is prohibited by the caller contract.
   */
  async writeAndPublish(
    scope: PollScope,
    fence: string,
    id: string,
    bytes: Uint8Array,
    publication: (reference: GmailObjectReference) => TransactionItem[],
    ownerMessageId: string,
  ): Promise<GmailObjectReference> {
    if (!scope) throw error();
    scope = Object.freeze({ ...scope });
    const k = partition(scope, fence);
    if (
      !validObjectId(id) ||
      !(bytes instanceof Uint8Array) ||
      bytes.byteLength > 1024 * 1024
    )
      throw error();
    if (!identity(ownerMessageId)) throw error();
    const content = Uint8Array.from(bytes);
    const reference = { id, size: content.byteLength, sha256: digest(content) };
    let actions: TransactionItem[];
    try {
      actions = publication(reference);
      if (
        !Array.isArray(actions) ||
        actions.length === 0 ||
        actions.length > 95
      )
        throw error();
    } catch {
      throw error();
    }
    const snapshot = snapshotActions(actions);
    actions = snapshot.actions;
    const publicationHash = snapshot.hash;
    try {
      return await this.barrier.exclusive(scope.tenantId, async () => {
        const key = { pk: k.pk, sk: `${k.prefix}${id}` };
        await this.transaction([
          this.fence(scope, fence),
          connectedCondition(this.table, scope),
        ]);
        const current = (
          await this.client.send(
            new GetCommand({
              TableName: this.table,
              Key: key,
              ConsistentRead: true,
            }),
            { abortSignal: AbortSignal.timeout(5000) },
          )
        ).Item;
        if (!current) {
          // Never create an intent for an ID already used by a legacy object.
          if ((await this.objects.get(scope.tenantId, id)) !== null)
            throw error();
          await this.transaction([
            this.fence(scope, fence),
            connectedCondition(this.table, scope),
            {
              Put: {
                TableName: this.table,
                Item: {
                  ...key,
                  objectId: id,
                  sourceId: scope.sourceId,
                  status: "pending",
                  size: reference.size,
                  sha256: reference.sha256,
                  publicationHash,
                  ownerMessageId,
                },
                ConditionExpression: "attribute_not_exists(pk)",
              },
            },
            {
              Put: {
                TableName: this.table,
                Item: { ...k.claim(id), owner: k.owner },
                ConditionExpression: "attribute_not_exists(pk)",
              },
            },
          ]);
        } else if (
          current.objectId !== id ||
          current.size !== reference.size ||
          current.sha256 !== reference.sha256 ||
          current.publicationHash !== publicationHash ||
          current.ownerMessageId !== ownerMessageId ||
          !["pending", "committed"].includes(current.status)
        )
          throw error();
        if (current?.status === "committed") {
          await this.transaction([
            this.fence(scope, fence),
            connectedCondition(this.table, scope),
            {
              ConditionCheck: {
                TableName: this.table,
                Key: key,
                ConditionExpression:
                  "#status = :committed AND objectId = :id AND #size = :size AND sha256 = :sha256 AND attribute_not_exists(deletionPending)",
                ExpressionAttributeNames: {
                  "#status": "status",
                  "#size": "size",
                },
                ExpressionAttributeValues: {
                  ":committed": "committed",
                  ":id": id,
                  ":size": reference.size,
                  ":sha256": reference.sha256,
                },
              },
            },
            {
              ConditionCheck: {
                TableName: this.table,
                Key: k.claim(id),
                ConditionExpression: "#owner = :owner",
                ExpressionAttributeNames: { "#owner": "owner" },
                ExpressionAttributeValues: { ":owner": k.owner },
              },
            },
          ]);
          const stored = await this.objects.get(scope.tenantId, id, reference);
          if (
            !stored ||
            stored.byteLength !== reference.size ||
            digest(stored) !== reference.sha256
          )
            throw error();
          return reference;
        }
        const stored = await this.objects.put(scope.tenantId, id, content);
        if (
          stored.size !== reference.size ||
          stored.sha256 !== reference.sha256
        )
          throw error();
        const verified = await this.objects.get(scope.tenantId, id, reference);
        if (
          !verified ||
          verified.byteLength !== reference.size ||
          digest(verified) !== reference.sha256
        )
          throw error();
        await this.transaction([
          this.fence(scope, fence),
          connectedCondition(this.table, scope),
          {
            ConditionCheck: {
              TableName: this.table,
              Key: k.claim(id),
              ConditionExpression: "#owner = :owner",
              ExpressionAttributeNames: { "#owner": "owner" },
              ExpressionAttributeValues: { ":owner": k.owner },
            },
          },
          {
            Update: {
              TableName: this.table,
              Key: key,
              UpdateExpression: "SET #status = :committed, holdCount = :one",
              ConditionExpression:
                "#status = :pending AND publicationHash = :publicationHash",
              ExpressionAttributeNames: { "#status": "status" },
              ExpressionAttributeValues: {
                ":committed": "committed",
                ":pending": "pending",
                ":publicationHash": publicationHash,
                ":one": 1,
              },
            },
          },
          {
            Put: {
              TableName: this.table,
              Item: {
                ...k.initialHold(id),
                kind: "processing",
                holdId: "initial",
                status: "held",
              },
              ConditionExpression: "attribute_not_exists(pk)",
            },
          },
          ...actions,
        ]);
        return reference;
      });
    } catch {
      throw error();
    }
  }

  /** Delete a detached, unheld owned object; recovery retries interrupted deletes. */
  async deleteUnheld(
    scope: PollScope,
    fence: string,
    objectId: string,
  ): Promise<void> {
    if (!scope || !validObjectId(objectId)) throw error();
    scope = Object.freeze({ ...scope });
    const k = partition(scope, fence);
    const key = { pk: k.pk, sk: `${k.prefix}${objectId}` };
    try {
      await this.barrier.exclusive(scope.tenantId, async () => {
        const item = (
          await this.client.send(
            new GetCommand({
              TableName: this.table,
              Key: key,
              ConsistentRead: true,
            }),
            { abortSignal: AbortSignal.timeout(5000) },
          )
        ).Item;
        if (
          !item ||
          item.objectId !== objectId ||
          !identity(item.ownerMessageId) ||
          item.holdCount !== 0 ||
          item.deletionPending !== true ||
          !["committed", "deleting", "deleted"].includes(item.status)
        )
          throw error();
        const ownerKey = {
          pk: k.pk,
          sk: `ledger#${digest(scope.sourceId)}#message#${digest(item.ownerMessageId)}`,
        };
        const checks: TransactionItem[] = [
          this.fence(scope, fence),
          connectionExistsCondition(this.table, scope),
          {
            ConditionCheck: {
              TableName: this.table,
              Key: k.claim(objectId),
              ConditionExpression: "#owner = :owner",
              ExpressionAttributeNames: { "#owner": "owner" },
              ExpressionAttributeValues: { ":owner": k.owner },
            },
          },
          {
            ConditionCheck: {
              TableName: this.table,
              Key: ownerKey,
              ConditionExpression:
                "attribute_not_exists(pk) OR attribute_not_exists(#object) OR #object.#id <> :id",
              ExpressionAttributeNames: { "#object": "object", "#id": "id" },
              ExpressionAttributeValues: { ":id": objectId },
            },
          },
        ];
        const condition =
          "objectId = :id AND ownerMessageId = :owner AND holdCount = :zero AND deletionPending = :yes AND #status = :status";
        const values = {
          ":id": objectId,
          ":owner": item.ownerMessageId,
          ":zero": 0,
          ":yes": true,
          ":status": item.status,
        };
        if (item.status === "committed") {
          await this.transaction([
            ...checks,
            {
              Update: {
                TableName: this.table,
                Key: key,
                UpdateExpression: "SET #status = :deleting",
                ConditionExpression: condition,
                ExpressionAttributeNames: { "#status": "status" },
                ExpressionAttributeValues: {
                  ...values,
                  ":deleting": "deleting",
                },
              },
            },
          ]);
        } else {
          await this.transaction([
            ...checks,
            {
              ConditionCheck: {
                TableName: this.table,
                Key: key,
                ConditionExpression: condition,
                ExpressionAttributeNames: { "#status": "status" },
                ExpressionAttributeValues: values,
              },
            },
          ]);
        }
        if (item.status === "deleted") return;
        await this.objects.delete(scope.tenantId, objectId);
        await this.transaction([
          this.fence(scope, fence),
          connectionExistsCondition(this.table, scope),
          {
            Update: {
              TableName: this.table,
              Key: key,
              UpdateExpression: "SET #status = :deleted",
              ConditionExpression:
                "#status = :deleting AND holdCount = :zero AND deletionPending = :yes",
              ExpressionAttributeNames: { "#status": "status" },
              ExpressionAttributeValues: {
                ":deleted": "deleted",
                ":deleting": "deleting",
                ":zero": 0,
                ":yes": true,
              },
            },
          },
        ]);
      });
    } catch {
      throw error();
    }
  }

  /** Purges known supported objects only; legacy orphans may remain, so this is not complete disconnection. */
  async purgeKnownDisconnectedObjects(
    scope: PollScope,
    fence: string,
  ): Promise<void> {
    if (!scope) throw error();
    scope = Object.freeze({ ...scope });
    const k = partition(scope, fence);
    try {
      await this.barrier.exclusive(scope.tenantId, async () => {
        await this.transaction([
          this.fence(scope, fence),
          disconnectedCondition(this.table, scope),
        ]);
      });
      const sources = new Set<string>();
      const known = new Map<
        string,
        { sourceId: string; ownerMessageId: string; status: string }
      >();
      for (const prefix of ["object#", "ledger#"]) {
        let cursor: Record<string, unknown> | undefined;
        let pages = 0;
        do {
          if (++pages > 1000) throw error();
          const page = await this.client.send(
            new QueryCommand({
              TableName: this.table,
              KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
              ExpressionAttributeValues: { ":pk": k.pk, ":prefix": prefix },
              ConsistentRead: true,
              Limit: 100,
              ...(cursor ? { ExclusiveStartKey: cursor } : {}),
            }),
            { abortSignal: AbortSignal.timeout(5000) },
          );
          for (const item of page.Items ?? []) {
            if (prefix === "object#") {
              if (
                !identity(item.sourceId) ||
                !validObjectId(item.objectId) ||
                !identity(item.ownerMessageId) ||
                !["pending", "committed", "deleting", "deleted"].includes(
                  item.status,
                ) ||
                item.sk !== `object#${digest(item.sourceId)}#${item.objectId}`
              )
                throw error();
              if (known.has(item.objectId) || known.size >= 100000)
                throw error();
              const sourceScope = { ...scope, sourceId: item.sourceId };
              const identityClaim = (
                await this.client.send(
                  new GetCommand({
                    TableName: this.table,
                    Key: k.claim(item.objectId),
                    ConsistentRead: true,
                  }),
                  { abortSignal: AbortSignal.timeout(5000) },
                )
              ).Item;
              if (
                !identityClaim ||
                identityClaim.owner !== partition(sourceScope, fence).owner
              )
                throw error();
              known.set(item.objectId, {
                sourceId: item.sourceId,
                ownerMessageId: item.ownerMessageId,
                status: item.status,
              });
              sources.add(item.sourceId);
              if (sources.size > 1000) throw error();
            } else if (
              typeof item.sk === "string" &&
              item.sk.includes("#message#") &&
              item.object !== undefined
            ) {
              const ref = item.object;
              if (
                !ref ||
                typeof ref !== "object" ||
                !validObjectId((ref as Record<string, unknown>).id)
              )
                throw error();
              const tracked = known.get(
                (ref as Record<string, unknown>).id as string,
              );
              if (
                !tracked ||
                tracked.status !== "committed" ||
                item.sk !==
                  `ledger#${digest(tracked.sourceId)}#message#${digest(tracked.ownerMessageId)}`
              )
                throw error();
            }
          }
          cursor = page.LastEvaluatedKey;
        } while (cursor);
      }
      for (const sourceId of sources)
        await this.purgeDisconnectedSource({ ...scope, sourceId }, fence);
      await this.transaction([
        this.fence(scope, fence),
        disconnectedCondition(this.table, scope),
      ]);
    } catch {
      throw error();
    }
  }

  /** Purge one source after local disconnect. Caller must stop and drain Gmail dispatches first. */
  async purgeDisconnectedSource(
    scope: PollScope,
    fence: string,
  ): Promise<void> {
    if (!scope) throw error();
    scope = Object.freeze({ ...scope });
    const k = partition(scope, fence);
    try {
      await this.barrier.exclusive(scope.tenantId, async () => {
        await this.transaction([
          this.fence(scope, fence),
          disconnectedCondition(this.table, scope),
        ]);
        let cursor: Record<string, unknown> | undefined;
        do {
          const page = await this.client.send(
            new QueryCommand({
              TableName: this.table,
              KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
              ExpressionAttributeValues: { ":pk": k.pk, ":prefix": k.prefix },
              ConsistentRead: true,
              Limit: 100,
              ...(cursor ? { ExclusiveStartKey: cursor } : {}),
            }),
            { abortSignal: AbortSignal.timeout(5000) },
          );
          for (const item of page.Items ?? []) {
            if (
              !validObjectId(item.objectId) ||
              item.sourceId !== scope.sourceId ||
              !identity(item.ownerMessageId) ||
              item.sk !== `${k.prefix}${item.objectId}` ||
              !["pending", "committed", "deleting", "deleted"].includes(
                item.status,
              )
            )
              throw error();
            const key = { pk: k.pk, sk: item.sk };
            const ownerKey = {
              pk: k.pk,
              sk: `ledger#${digest(scope.sourceId)}#message#${digest(item.ownerMessageId)}`,
            };
            const owner = (
              await this.client.send(
                new GetCommand({
                  TableName: this.table,
                  Key: ownerKey,
                  ConsistentRead: true,
                }),
                { abortSignal: AbortSignal.timeout(5000) },
              )
            ).Item;
            const reference = owner?.object;
            let ownerAction: TransactionItem;
            if (
              reference &&
              typeof reference === "object" &&
              (reference as Record<string, unknown>).id === item.objectId
            ) {
              if (
                !Number.isSafeInteger(owner!.generation) ||
                owner!.generation < 1 ||
                !Number.isSafeInteger(owner!.generation + 1)
              )
                throw error();
              ownerAction = {
                Update: {
                  TableName: this.table,
                  Key: ownerKey,
                  UpdateExpression:
                    "SET active = :inactive, contentPurged = :yes, #generation = :next REMOVE #object",
                  ConditionExpression:
                    "#object.#id = :id AND #generation = :previous",
                  ExpressionAttributeNames: {
                    "#object": "object",
                    "#id": "id",
                    "#generation": "generation",
                  },
                  ExpressionAttributeValues: {
                    ":inactive": false,
                    ":yes": true,
                    ":next": owner!.generation + 1,
                    ":id": item.objectId,
                    ":previous": owner!.generation,
                  },
                },
              };
            } else {
              ownerAction = {
                ConditionCheck: {
                  TableName: this.table,
                  Key: ownerKey,
                  ConditionExpression:
                    "attribute_not_exists(pk) OR attribute_not_exists(#object) OR #object.#id <> :id",
                  ExpressionAttributeNames: {
                    "#object": "object",
                    "#id": "id",
                  },
                  ExpressionAttributeValues: { ":id": item.objectId },
                },
              };
            }
            const common: TransactionItem[] = [
              this.fence(scope, fence),
              disconnectedCondition(this.table, scope),
              {
                ConditionCheck: {
                  TableName: this.table,
                  Key: k.claim(item.objectId),
                  ConditionExpression: "#owner = :owner",
                  ExpressionAttributeNames: { "#owner": "owner" },
                  ExpressionAttributeValues: { ":owner": k.owner },
                },
              },
              ownerAction,
            ];
            if (item.status === "deleted") {
              await this.transaction([
                ...common,
                {
                  ConditionCheck: {
                    TableName: this.table,
                    Key: key,
                    ConditionExpression:
                      "#status = :deleted AND objectId = :id",
                    ExpressionAttributeNames: { "#status": "status" },
                    ExpressionAttributeValues: {
                      ":deleted": "deleted",
                      ":id": item.objectId,
                    },
                  },
                },
              ]);
              continue;
            }
            await this.transaction([
              ...common,
              {
                Update: {
                  TableName: this.table,
                  Key: key,
                  UpdateExpression:
                    "SET #status = :deleting, holdCount = :zero, deletionPending = :yes",
                  ConditionExpression:
                    "#status = :previous AND objectId = :id AND sourceId = :source AND ownerMessageId = :message",
                  ExpressionAttributeNames: { "#status": "status" },
                  ExpressionAttributeValues: {
                    ":deleting": "deleting",
                    ":zero": 0,
                    ":yes": true,
                    ":previous": item.status,
                    ":id": item.objectId,
                    ":source": scope.sourceId,
                    ":message": item.ownerMessageId,
                  },
                },
              },
              {
                Update: {
                  TableName: this.table,
                  Key: { pk: k.pk, sk: `visibility#${digest(scope.sourceId)}` },
                  UpdateExpression: "ADD #revision :one",
                  ConditionExpression:
                    "attribute_not_exists(#revision) OR #revision < :max",
                  ExpressionAttributeNames: { "#revision": "revision" },
                  ExpressionAttributeValues: {
                    ":one": 1,
                    ":max": Number.MAX_SAFE_INTEGER,
                  },
                },
              },
            ]);
            await this.objects.delete(scope.tenantId, item.objectId);
            await this.transaction([
              this.fence(scope, fence),
              disconnectedCondition(this.table, scope),
              {
                Update: {
                  TableName: this.table,
                  Key: key,
                  UpdateExpression: "SET #status = :deleted",
                  ConditionExpression: "#status = :deleting AND objectId = :id",
                  ExpressionAttributeNames: { "#status": "status" },
                  ExpressionAttributeValues: {
                    ":deleted": "deleted",
                    ":deleting": "deleting",
                    ":id": item.objectId,
                  },
                },
              },
            ]);
          }
          cursor = page.LastEvaluatedKey;
        } while (cursor);
      });
    } catch {
      throw error();
    }
  }

  /** Recover only our uncommitted opaque IDs; never delete legacy or committed objects. */
  async recover(scope: PollScope, fence: string): Promise<void> {
    if (!scope) throw error();
    scope = Object.freeze({ ...scope });
    const k = partition(scope, fence);
    try {
      await this.barrier.exclusive(scope.tenantId, async () => {
        await this.transaction([
          this.fence(scope, fence),
          connectionExistsCondition(this.table, scope),
        ]);
        let cursor: Record<string, unknown> | undefined;
        do {
          const page = await this.client.send(
            new QueryCommand({
              TableName: this.table,
              KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
              ExpressionAttributeValues: { ":pk": k.pk, ":prefix": k.prefix },
              ConsistentRead: true,
              Limit: 100,
              ...(cursor ? { ExclusiveStartKey: cursor } : {}),
            }),
            { abortSignal: AbortSignal.timeout(5000) },
          );
          for (const item of page.Items ?? []) {
            if (
              !validObjectId(item.objectId) ||
              item.pk !== k.pk ||
              item.sk !== `${k.prefix}${item.objectId}` ||
              !["pending", "deleting", "deleted", "committed"].includes(
                item.status,
              )
            )
              throw error();
            if (item.status === "deleted" || item.status === "committed")
              continue;
            const key = { pk: k.pk, sk: item.sk };
            if (item.status === "pending")
              await this.transaction([
                this.fence(scope, fence),
                connectionExistsCondition(this.table, scope),
                {
                  ConditionCheck: {
                    TableName: this.table,
                    Key: k.claim(item.objectId),
                    ConditionExpression: "#owner = :owner",
                    ExpressionAttributeNames: { "#owner": "owner" },
                    ExpressionAttributeValues: { ":owner": k.owner },
                  },
                },
                {
                  Update: {
                    TableName: this.table,
                    Key: key,
                    UpdateExpression: "SET #status = :deleting",
                    ConditionExpression: "#status = :pending",
                    ExpressionAttributeNames: { "#status": "status" },
                    ExpressionAttributeValues: {
                      ":deleting": "deleting",
                      ":pending": "pending",
                    },
                  },
                },
              ]);
            else
              await this.transaction([
                this.fence(scope, fence),
                connectionExistsCondition(this.table, scope),
                {
                  ConditionCheck: {
                    TableName: this.table,
                    Key: k.claim(item.objectId),
                    ConditionExpression: "#owner = :owner",
                    ExpressionAttributeNames: { "#owner": "owner" },
                    ExpressionAttributeValues: { ":owner": k.owner },
                  },
                },
                {
                  ConditionCheck: {
                    TableName: this.table,
                    Key: key,
                    ConditionExpression: "#status = :deleting",
                    ExpressionAttributeNames: { "#status": "status" },
                    ExpressionAttributeValues: { ":deleting": "deleting" },
                  },
                },
              ]);
            await this.objects.delete(scope.tenantId, item.objectId);
            await this.transaction([
              this.fence(scope, fence),
              connectionExistsCondition(this.table, scope),
              {
                Update: {
                  TableName: this.table,
                  Key: key,
                  UpdateExpression: "SET #status = :deleted",
                  ConditionExpression: "#status = :deleting",
                  ExpressionAttributeNames: { "#status": "status" },
                  ExpressionAttributeValues: {
                    ":deleted": "deleted",
                    ":deleting": "deleting",
                  },
                },
              },
            ]);
          }
          cursor = page.LastEvaluatedKey;
        } while (cursor);
      });
    } catch {
      throw error();
    }
  }
}
