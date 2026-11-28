/* Provider errors may contain private request data and must not be exposed as causes. */
/* eslint-disable preserve-caught-error */
import { createHash } from "node:crypto";
import {
  DynamoDBDocumentClient,
  GetCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import type {
  Checkpoint,
  PollDependencies,
  PollScope,
} from "../source-gmail/poll.js";

const identifier = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const historyId = (value: unknown): value is string =>
  typeof value === "string" && /^\d{1,32}$/.test(value);
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
function keys(scope: PollScope) {
  if (
    !identifier(scope.tenantId) ||
    !identifier(scope.connectionId) ||
    !identifier(scope.sourceId)
  )
    throw new Error("Invalid Gmail scope");
  const pk = `gmail#${hash(JSON.stringify([scope.tenantId, scope.connectionId]))}`;
  return {
    lease: { pk, sk: "lease" },
    checkpoint: { pk, sk: `checkpoint#${hash(scope.sourceId)}` },
  };
}
function fenceNumber(fence: string): number {
  if (!/^[1-9]\d{0,15}$/.test(fence)) throw new Error("Invalid Gmail fence");
  const number = Number(fence);
  if (!Number.isSafeInteger(number)) throw new Error("Invalid Gmail fence");
  return number;
}
function validCheckpoint(value: unknown): value is Checkpoint {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    historyId(v.historyId) &&
    identifier(v.configVersion) &&
    typeof v.revision === "number" &&
    Number.isSafeInteger(v.revision) &&
    v.revision > 0
  );
}
function conditional(error: unknown): boolean {
  return (
    error instanceof Error && error.name === "ConditionalCheckFailedException"
  );
}
/** Durable lease and checkpoint ports. Lease expiry uses the host clock, which must be synchronized.
 * The lease has no renewal; callers must configure a duration long enough for a bounded poll.
 * This adapter does not implement the Gmail ledger or full-sync reconciliation. */
export class GmailStateRepository {
  readonly #client: DynamoDBDocumentClient;
  readonly #table: string;
  readonly #leaseMs: number;
  constructor(client: DynamoDBDocumentClient, table: string, leaseMs: number) {
    if (
      !/^[A-Za-z0-9_.-]{3,255}$/.test(table) ||
      !Number.isSafeInteger(leaseMs) ||
      leaseMs < 1000 ||
      leaseMs > 86400000
    )
      throw new Error("Invalid Gmail state configuration");
    this.#client = client;
    this.#table = table;
    this.#leaseMs = leaseMs;
  }
  readonly lease: PollDependencies["lease"] = {
    acquire: async (scope) => {
      const key = keys(scope).lease;
      const now = Date.now();
      try {
        const result = await this.#client.send(
          new UpdateCommand({
            TableName: this.#table,
            Key: key,
            UpdateExpression: "SET #expires = :expiry ADD #generation :one",
            ConditionExpression:
              "(attribute_not_exists(#expires) OR #expires <= :now) AND (attribute_not_exists(#generation) OR #generation < :max)",
            ExpressionAttributeNames: {
              "#expires": "expiresAt",
              "#generation": "generation",
            },
            ExpressionAttributeValues: {
              ":expiry": now + this.#leaseMs,
              ":now": now,
              ":one": 1,
              ":max": Number.MAX_SAFE_INTEGER,
            },
            ReturnValues: "ALL_NEW",
          }),
          { abortSignal: AbortSignal.timeout(5000) },
        );
        const generation: unknown = result.Attributes?.generation;
        if (
          typeof generation !== "number" ||
          !Number.isSafeInteger(generation) ||
          generation < 1
        )
          throw new Error("Invalid lease generation");
        return { fence: String(generation) };
      } catch (error) {
        if (conditional(error)) return null;
        throw new Error("Gmail state operation failed");
      }
    },
    release: async (scope, fence) => {
      const key = keys(scope).lease;
      const generation = fenceNumber(fence);
      try {
        await this.#client.send(
          new UpdateCommand({
            TableName: this.#table,
            Key: key,
            UpdateExpression: "SET #expires = :zero",
            ConditionExpression: "#generation = :generation",
            ExpressionAttributeNames: {
              "#expires": "expiresAt",
              "#generation": "generation",
            },
            ExpressionAttributeValues: {
              ":zero": 0,
              ":generation": generation,
            },
          }),
          { abortSignal: AbortSignal.timeout(5000) },
        );
      } catch (error) {
        if (!conditional(error))
          throw new Error("Gmail state operation failed");
      }
    },
  };
  readonly checkpoints: PollDependencies["checkpoints"] = {
    load: async (scope) => {
      const key = keys(scope).checkpoint;
      try {
        const item = (
          await this.#client.send(
            new GetCommand({
              TableName: this.#table,
              Key: key,
              ConsistentRead: true,
            }),
            { abortSignal: AbortSignal.timeout(5000) },
          )
        ).Item;
        if (!item) return null;
        const value: unknown = item.checkpoint;
        if (!validCheckpoint(value)) throw new Error("Invalid checkpoint");
        return {
          historyId: value.historyId,
          configVersion: value.configVersion,
          revision: value.revision,
        };
      } catch {
        throw new Error("Gmail state operation failed");
      }
    },
  };
}
