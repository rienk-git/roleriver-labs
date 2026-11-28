/* Provider errors may contain private data and must not be exposed as causes. */
/* eslint-disable preserve-caught-error */
import { createHash } from "node:crypto";
import {
  DynamoDBDocumentClient,
  GetCommand,
  TransactWriteCommand,
} from "@aws-sdk/lib-dynamodb";
import type { PollConfig, PollScope } from "../source-gmail/poll.js";
import { connectedCondition } from "./gmail-connection.js";

const identity = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const hash = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

/**
 * Claims are immutable and must be retained for as long as a version may be reused.
 * A trusted caller must authorize the scope and successfully claim before any poll
 * mutation, while holding the connection lease. Poll integration is tested, but
 * no production composition root is wired. Fingerprints are sensitive
 * derived data, not anonymization; query text is not persisted here.
 */
export class GmailConfigRepository {
  constructor(
    private readonly client: DynamoDBDocumentClient,
    private readonly table: string,
  ) {
    if (!/^[A-Za-z0-9_.-]{3,255}$/.test(table))
      throw new Error("Invalid Gmail configuration store");
  }

  /** A prior checkpoint is usable only when its immutable claim already exists. */
  async hasClaim(
    scope: PollScope,
    version: string,
    fence: string,
  ): Promise<boolean> {
    if (
      !scope ||
      !identity(scope.tenantId) ||
      !identity(scope.connectionId) ||
      !identity(scope.sourceId) ||
      !identity(version) ||
      typeof fence !== "string" ||
      !/^[1-9]\d{0,15}$/.test(fence) ||
      !Number.isSafeInteger(Number(fence))
    )
      throw new Error("Invalid Gmail configuration");
    const pk = `gmail#${hash(JSON.stringify([scope.tenantId, scope.connectionId]))}`;
    const key = {
      pk,
      sk: `config#${hash(JSON.stringify([scope.sourceId, version]))}`,
    };
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
        typeof item.fingerprint !== "string" ||
        !/^[a-f0-9]{64}$/.test(item.fingerprint)
      )
        throw new Error("Invalid claim");
      await this.client.send(
        new TransactWriteCommand({
          TransactItems: [
            connectedCondition(this.table, scope),
            {
              ConditionCheck: {
                TableName: this.table,
                Key: { pk, sk: "lease" },
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
            },
            {
              ConditionCheck: {
                TableName: this.table,
                Key: key,
                ConditionExpression: "fingerprint = :value",
                ExpressionAttributeValues: { ":value": item.fingerprint },
              },
            },
          ],
        }),
        { abortSignal: AbortSignal.timeout(5000) },
      );
      return true;
    } catch {
      throw new Error("Gmail configuration operation failed");
    }
  }

  async claim(
    scope: PollScope,
    config: PollConfig,
    fence: string,
  ): Promise<{ status: "created" | "existing" | "conflict" }> {
    if (
      !scope ||
      !identity(scope.tenantId) ||
      !identity(scope.connectionId) ||
      !identity(scope.sourceId) ||
      !config ||
      !identity(config.version) ||
      typeof config.query !== "string" ||
      config.query.length > 4096 ||
      !config.query.isWellFormed() ||
      !Array.isArray(config.labelIds) ||
      config.labelIds.length > 100 ||
      !config.labelIds.every(identity) ||
      typeof fence !== "string" ||
      !/^[1-9]\d{0,15}$/.test(fence) ||
      !Number.isSafeInteger(Number(fence))
    )
      throw new Error("Invalid Gmail configuration");
    const key = {
      pk: `gmail#${hash(JSON.stringify([scope.tenantId, scope.connectionId]))}`,
      sk: `config#${hash(JSON.stringify([scope.sourceId, config.version]))}`,
    };
    const fingerprint = hash(
      JSON.stringify([
        "gmail-config-v1",
        config.query,
        [...new Set(config.labelIds)].sort(),
      ]),
    );
    const leaseCondition = () => ({
      ConditionCheck: {
        TableName: this.table,
        Key: { pk: key.pk, sk: "lease" },
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
    });
    try {
      await this.client.send(
        new TransactWriteCommand({
          TransactItems: [
            leaseCondition(),
            connectedCondition(this.table, scope),
            {
              Put: {
                TableName: this.table,
                Item: { ...key, fingerprint },
                ConditionExpression: "attribute_not_exists(pk)",
              },
            },
          ],
        }),
        { abortSignal: AbortSignal.timeout(5000) },
      );
      return { status: "created" };
    } catch (error) {
      if (
        !(error instanceof Error) ||
        error.name !== "TransactionCanceledException"
      )
        throw new Error("Gmail configuration operation failed");
    }
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
      if (
        !item ||
        typeof item.fingerprint !== "string" ||
        !/^[a-f0-9]{64}$/.test(item.fingerprint)
      )
        throw new Error("Invalid stored configuration claim");
      await this.client.send(
        new TransactWriteCommand({
          TransactItems: [
            leaseCondition(),
            connectedCondition(this.table, scope),
            {
              ConditionCheck: {
                TableName: this.table,
                Key: key,
                ConditionExpression: "fingerprint = :value",
                ExpressionAttributeValues: { ":value": item.fingerprint },
              },
            },
          ],
        }),
        { abortSignal: AbortSignal.timeout(5000) },
      );
      return {
        status: item.fingerprint === fingerprint ? "existing" : "conflict",
      };
    } catch {
      throw new Error("Gmail configuration operation failed");
    }
  }
}
