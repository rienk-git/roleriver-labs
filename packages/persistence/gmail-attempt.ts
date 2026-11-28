import { createHash } from "node:crypto";
import {
  DynamoDBDocumentClient,
  GetCommand,
  TransactWriteCommand,
} from "@aws-sdk/lib-dynamodb";
import type { Checkpoint, PollScope } from "../source-gmail/poll.js";
import {
  connectedCondition,
  GmailConnectionRepository,
} from "./gmail-connection.js";

const id = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const failure = () => new Error("Gmail attempt operation failed");
function keys(scope: PollScope) {
  if (
    !scope ||
    !id(scope.tenantId) ||
    !id(scope.connectionId) ||
    !id(scope.sourceId)
  )
    throw failure();
  const pk = `gmail#${hash(JSON.stringify([scope.tenantId, scope.connectionId]))}`;
  return {
    lease: { pk, sk: "lease" },
    checkpoint: { pk, sk: `checkpoint#${hash(scope.sourceId)}` },
    attempt: { pk, sk: `attempt#${hash(scope.sourceId)}` },
  };
}
function generation(fence: string): number {
  if (
    typeof fence !== "string" ||
    !/^[1-9]\d{0,15}$/.test(fence) ||
    !Number.isSafeInteger(Number(fence))
  )
    throw failure();
  return Number(fence);
}
function conditional(error: unknown): boolean {
  if (
    !(error instanceof Error) ||
    error.name !== "TransactionCanceledException"
  )
    return false;
  const reasons = (
    error as Error & { CancellationReasons?: { Code?: string }[] }
  ).CancellationReasons;
  return (
    Array.isArray(reasons) &&
    reasons.some((r) => r.Code === "ConditionalCheckFailed") &&
    reasons.every(
      (r) => r.Code === "ConditionalCheckFailed" || r.Code === "None",
    )
  );
}

/**
 * Inactive coordination primitive. All ledger mutations must atomically verify the
 * matching active attempt; every poll must begin before any mutation and publish
 * through this adapter. Existing state/ledger adapters do not yet enforce that.
 * The read callback must buffer data without emitting it or causing side effects.
 * Consumers receive no result if an attempt starts while pages are being read.
 * An abandoned attempt must be recovered by a full scan using a fresh fence.
 * An active incremental attempt may promote to full under the same fence.
 * Fences are concurrency tokens, not authorization; callers authorize the scope.
 */
export class GmailAttemptRepository {
  constructor(
    private readonly client: DynamoDBDocumentClient,
    private readonly table: string,
  ) {
    if (!/^[A-Za-z0-9_.-]{3,255}$/.test(table)) throw failure();
  }
  private lease(scope: PollScope, fence: string) {
    return {
      ConditionCheck: {
        TableName: this.table,
        Key: keys(scope).lease,
        ConditionExpression: "#generation = :generation AND #expires > :now",
        ExpressionAttributeNames: {
          "#generation": "generation",
          "#expires": "expiresAt",
        },
        ExpressionAttributeValues: {
          ":generation": generation(fence),
          ":now": Date.now(),
        },
      },
    };
  }
  /** Old checkpoints without an attempt marker require explicit migration. */
  async isInitialized(scope: PollScope): Promise<boolean> {
    scope = Object.freeze({ ...scope });
    const key = keys(scope).attempt;
    try {
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
      if (!item) return false;
      if (
        !Number.isSafeInteger(item.epoch) ||
        item.epoch < 1 ||
        (item.status !== "active" && item.status !== "complete") ||
        (item.mode !== "full" && item.mode !== "incremental")
      )
        throw failure();
      return true;
    } catch {
      throw failure();
    }
  }
  async begin(
    scope: PollScope,
    fence: string,
    mode: "full" | "incremental",
  ): Promise<void> {
    scope = Object.freeze({ ...scope });
    const k = keys(scope);
    const epoch = generation(fence);
    if (mode !== "full" && mode !== "incremental") throw failure();
    try {
      await this.client.send(
        new TransactWriteCommand({
          TransactItems: [
            this.lease(scope, fence),
            connectedCondition(this.table, scope),
            {
              Put: {
                TableName: this.table,
                Item: { ...k.attempt, epoch, mode, status: "active" },
                ConditionExpression:
                  "(attribute_not_exists(epoch) AND :mode = :full) OR (epoch < :epoch AND (#status = :complete OR (#status = :active AND :mode = :full))) OR (epoch = :epoch AND #status = :active AND (#mode = :mode OR (#mode = :incremental AND :mode = :full)))",
                ExpressionAttributeNames: {
                  "#status": "status",
                  "#mode": "mode",
                },
                ExpressionAttributeValues: {
                  ":epoch": epoch,
                  ":active": "active",
                  ":complete": "complete",
                  ":full": "full",
                  ":incremental": "incremental",
                  ":mode": mode,
                },
              },
            },
          ],
        }),
        { abortSignal: AbortSignal.timeout(5000) },
      );
    } catch {
      throw failure();
    }
  }
  async publish(
    scope: PollScope,
    fence: string,
    expected: number | null,
    next: Checkpoint,
  ): Promise<boolean> {
    scope = Object.freeze({ ...scope });
    const k = keys(scope);
    const epoch = generation(fence);
    if (
      !next ||
      !/^\d{1,32}$/.test(next.historyId) ||
      !id(next.configVersion) ||
      !Number.isSafeInteger(next.revision) ||
      (expected !== null &&
        (!Number.isSafeInteger(expected) || expected < 1)) ||
      next.revision !== (expected ?? 0) + 1
    )
      throw failure();
    try {
      await this.client.send(
        new TransactWriteCommand({
          TransactItems: [
            this.lease(scope, fence),
            connectedCondition(this.table, scope),
            {
              Update: {
                TableName: this.table,
                Key: k.attempt,
                UpdateExpression: "SET #status = :complete",
                ConditionExpression: "epoch = :epoch AND #status = :active",
                ExpressionAttributeNames: { "#status": "status" },
                ExpressionAttributeValues: {
                  ":epoch": epoch,
                  ":active": "active",
                  ":complete": "complete",
                },
              },
            },
            {
              Put: {
                TableName: this.table,
                Item: { ...k.checkpoint, checkpoint: next },
                ConditionExpression:
                  expected === null
                    ? "attribute_not_exists(pk)"
                    : "#checkpoint.#revision = :expected",
                ...(expected === null
                  ? {}
                  : {
                      ExpressionAttributeNames: {
                        "#checkpoint": "checkpoint",
                        "#revision": "revision",
                      },
                      ExpressionAttributeValues: { ":expected": expected },
                    }),
              },
            },
          ],
        }),
        { abortSignal: AbortSignal.timeout(5000) },
      );
      return true;
    } catch (error) {
      if (conditional(error)) return false;
      throw failure();
    }
  }
  async read<T>(
    scope: PollScope,
    bufferedRead: () => Promise<T>,
  ): Promise<{ status: "ready"; value: T } | { status: "unavailable" }> {
    scope = Object.freeze({ ...scope });
    const k = keys(scope);
    const snapshot = async () =>
      (
        await this.client.send(
          new GetCommand({
            TableName: this.table,
            Key: k.attempt,
            ConsistentRead: true,
          }),
          { abortSignal: AbortSignal.timeout(5000) },
        )
      ).Item;
    const retentionRevision = async () => {
      const item = (
        await this.client.send(
          new GetCommand({
            TableName: this.table,
            Key: { pk: k.attempt.pk, sk: `visibility#${hash(scope.sourceId)}` },
            ConsistentRead: true,
          }),
          { abortSignal: AbortSignal.timeout(5000) },
        )
      ).Item;
      if (!item) return 0;
      if (!Number.isSafeInteger(item.revision) || item.revision < 1)
        throw failure();
      return item.revision as number;
    };
    try {
      const connection = new GmailConnectionRepository(this.client, this.table);
      const connectedBefore = await connection.snapshot(scope);
      if (!connectedBefore || connectedBefore.status !== "connected")
        return { status: "unavailable" };
      const retentionBefore = await retentionRevision();
      const before = await snapshot();
      if (
        !before ||
        before.status !== "complete" ||
        !Number.isSafeInteger(before.epoch) ||
        (before.epoch as number) < 1
      )
        return { status: "unavailable" };
      const value = await bufferedRead();
      const after = await snapshot();
      const retentionAfter = await retentionRevision();
      const connectedAfter = await connection.snapshot(scope);
      if (
        !after ||
        after.status !== "complete" ||
        after.epoch !== before.epoch ||
        !connectedAfter ||
        connectedAfter.status !== "connected" ||
        connectedAfter.revision !== connectedBefore.revision ||
        retentionBefore !== retentionAfter
      )
        return { status: "unavailable" };
      return { status: "ready", value };
    } catch {
      throw failure();
    }
  }
}
