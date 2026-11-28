import { createHash } from "node:crypto";
import {
  DynamoDBDocumentClient,
  GetCommand,
  TransactWriteCommand,
} from "@aws-sdk/lib-dynamodb";
import type { PollScope } from "../source-gmail/poll.js";
import { connectedCondition } from "./gmail-connection.js";
import type { GmailObjectLifecycle } from "./gmail-objects.js";

export type GmailHold = {
  kind: "processing" | "role" | "evidence";
  id: string;
};
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const id = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const failed = () => new Error("Gmail hold operation failed");
function keys(scope: PollScope, objectId: string, hold: GmailHold) {
  if (
    !scope ||
    !id(scope.tenantId) ||
    !id(scope.connectionId) ||
    !id(scope.sourceId) ||
    typeof objectId !== "string" ||
    !/^go_[a-f0-9]{32}$/.test(objectId) ||
    !hold ||
    !id(hold.id) ||
    !["processing", "role", "evidence"].includes(hold.kind)
  )
    throw failed();
  const pk = `gmail#${hash(JSON.stringify([scope.tenantId, scope.connectionId]))}`;
  const source = hash(scope.sourceId);
  return {
    lease: { pk, sk: "lease" },
    object: { pk, sk: `object#${source}#${objectId}` },
    hold: {
      pk,
      sk: `hold#${source}#${objectId}#${hash(JSON.stringify([hold.kind, hold.id]))}`,
    },
    visibility: { pk, sk: `visibility#${source}` },
  };
}

/** Inactive primitive: initial holds, ledger ownership and object deletion are not wired. */
export class GmailHoldRepository {
  constructor(
    private readonly client: DynamoDBDocumentClient,
    private readonly table: string,
    private readonly cleanup?: GmailObjectLifecycle,
  ) {
    if (!/^[A-Za-z0-9_.-]{3,255}$/.test(table)) throw failed();
  }
  private async read(key: { pk: string; sk: string }) {
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
  private async send(
    items: ConstructorParameters<
      typeof TransactWriteCommand
    >[0]["TransactItems"],
  ) {
    await this.client.send(new TransactWriteCommand({ TransactItems: items }), {
      abortSignal: AbortSignal.timeout(5000),
    });
  }
  private lease(key: { pk: string; sk: string }, fence: string) {
    if (
      typeof fence !== "string" ||
      !/^[1-9]\d{0,15}$/.test(fence) ||
      !Number.isSafeInteger(Number(fence))
    )
      throw failed();
    return {
      ConditionCheck: {
        TableName: this.table,
        Key: key,
        ConditionExpression: "#generation = :generation AND #expires > :now",
        ExpressionAttributeNames: {
          "#generation": "generation",
          "#expires": "expiresAt",
        },
        ExpressionAttributeValues: {
          ":generation": Number(fence),
          ":now": Date.now(),
        },
      },
    };
  }
  /** Create an opaque hold atomically with its lifecycle object's reference count. */
  async add(
    scope: PollScope,
    objectId: string,
    hold: GmailHold,
    fence: string,
  ): Promise<void> {
    if (!scope || !hold) throw failed();
    scope = Object.freeze({ ...scope });
    hold = Object.freeze({ ...hold });
    const k = keys(scope, objectId, hold);
    try {
      await this.send([
        this.lease(k.lease, fence),
        connectedCondition(this.table, scope),
        {
          Update: {
            TableName: this.table,
            Key: k.object,
            UpdateExpression: "ADD #count :one",
            ConditionExpression:
              "#status = :committed AND objectId = :id AND #count >= :one AND #count < :max AND attribute_not_exists(deletionPending)",
            ExpressionAttributeNames: {
              "#status": "status",
              "#count": "holdCount",
            },
            ExpressionAttributeValues: {
              ":one": 1,
              ":committed": "committed",
              ":id": objectId,
              ":max": Number.MAX_SAFE_INTEGER,
            },
          },
        },
        {
          Put: {
            TableName: this.table,
            Item: {
              ...k.hold,
              kind: hold.kind,
              holdId: hold.id,
              status: "held",
            },
            ConditionExpression: "attribute_not_exists(pk)",
          },
        },
      ]);
    } catch {
      try {
        await this.send([
          this.lease(k.lease, fence),
          connectedCondition(this.table, scope),
          {
            ConditionCheck: {
              TableName: this.table,
              Key: k.object,
              ConditionExpression:
                "#status = :committed AND objectId = :id AND #count >= :one AND attribute_not_exists(deletionPending)",
              ExpressionAttributeNames: {
                "#status": "status",
                "#count": "holdCount",
              },
              ExpressionAttributeValues: {
                ":committed": "committed",
                ":id": objectId,
                ":one": 1,
              },
            },
          },
          {
            ConditionCheck: {
              TableName: this.table,
              Key: k.hold,
              ConditionExpression:
                "#status = :held AND kind = :kind AND holdId = :id",
              ExpressionAttributeNames: { "#status": "status" },
              ExpressionAttributeValues: {
                ":held": "held",
                ":kind": hold.kind,
                ":id": hold.id,
              },
            },
          },
        ]);
      } catch {
        throw failed();
      }
    }
  }
  /** Last release marks deletion pending; it does not delete until coordinated cleanup exists. */
  async release(
    scope: PollScope,
    objectId: string,
    hold: GmailHold,
    fence: string,
  ): Promise<{ deletionPending: boolean }> {
    if (!scope || !hold) throw failed();
    scope = Object.freeze({ ...scope });
    hold = Object.freeze({ ...hold });
    const k = keys(scope, objectId, hold);
    try {
      const existing = await this.read(k.hold);
      if (
        existing?.status === "released" &&
        existing.kind === hold.kind &&
        existing.holdId === hold.id &&
        typeof existing.wasLast === "boolean"
      ) {
        await this.send([
          this.lease(k.lease, fence),
          connectedCondition(this.table, scope),
          {
            ConditionCheck: {
              TableName: this.table,
              Key: k.hold,
              ConditionExpression:
                "#status = :released AND kind = :kind AND holdId = :id AND wasLast = :last",
              ExpressionAttributeNames: { "#status": "status" },
              ExpressionAttributeValues: {
                ":released": "released",
                ":kind": hold.kind,
                ":id": hold.id,
                ":last": existing.wasLast,
              },
            },
          },
        ]);
        if (existing.wasLast && this.cleanup) {
          await this.cleanup.deleteUnheld(scope, fence, objectId);
          return { deletionPending: false };
        }
        return { deletionPending: existing.wasLast };
      }
      const object = await this.read(k.object);
      if (
        !object ||
        object.status !== "committed" ||
        object.objectId !== objectId ||
        !Number.isSafeInteger(object.holdCount) ||
        object.holdCount < 1
      )
        throw failed();
      const count = object.holdCount as number;
      let ownerAction: ConstructorParameters<
        typeof TransactWriteCommand
      >[0]["TransactItems"] = [];
      if (count === 1) {
        if (!id(object.ownerMessageId)) throw failed();
        const ownerKey = {
          pk: k.object.pk,
          sk: `ledger#${hash(scope.sourceId)}#message#${hash(object.ownerMessageId)}`,
        };
        const owner = await this.read(ownerKey);
        const currentReference = owner?.object;
        if (
          currentReference &&
          typeof currentReference === "object" &&
          (currentReference as Record<string, unknown>).id === objectId
        ) {
          if (
            !Number.isSafeInteger(owner!.generation) ||
            owner!.generation < 1 ||
            !Number.isSafeInteger(owner!.generation + 1)
          )
            throw failed();
          ownerAction = [
            {
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
                  ":id": objectId,
                  ":previous": owner!.generation,
                },
              },
            },
          ];
        } else {
          ownerAction = [
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
        }
      }
      await this.send([
        this.lease(k.lease, fence),
        connectedCondition(this.table, scope),
        ...ownerAction,
        {
          Update: {
            TableName: this.table,
            Key: k.object,
            UpdateExpression:
              count === 1
                ? "SET #count = :next, deletionPending = :yes"
                : "SET #count = :next",
            ConditionExpression:
              "#status = :committed AND objectId = :id AND #count = :expected",
            ExpressionAttributeNames: {
              "#status": "status",
              "#count": "holdCount",
            },
            ExpressionAttributeValues: {
              ":next": count - 1,
              ":committed": "committed",
              ":id": objectId,
              ":expected": count,
              ...(count === 1 ? { ":yes": true } : {}),
            },
          },
        },
        {
          Update: {
            TableName: this.table,
            Key: k.hold,
            UpdateExpression: "SET #status = :released, wasLast = :last",
            ConditionExpression:
              "#status = :held AND kind = :kind AND holdId = :id",
            ExpressionAttributeNames: { "#status": "status" },
            ExpressionAttributeValues: {
              ":released": "released",
              ":held": "held",
              ":kind": hold.kind,
              ":id": hold.id,
              ":last": count === 1,
            },
          },
        },
        {
          Update: {
            TableName: this.table,
            Key: k.visibility,
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
      if (count === 1 && this.cleanup) {
        await this.cleanup.deleteUnheld(scope, fence, objectId);
        return { deletionPending: false };
      }
      return { deletionPending: count === 1 };
    } catch {
      throw failed();
    }
  }
}
