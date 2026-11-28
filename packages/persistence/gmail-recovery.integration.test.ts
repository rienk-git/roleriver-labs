import { GmailObjectLifecycle } from "./gmail-objects.js";
import { GmailHoldRepository } from "./gmail-holds.js";
import { GmailConnectionRepository } from "./gmail-connection.js";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CreateTableCommand,
  DeleteTableCommand,
  DynamoDBClient,
} from "@aws-sdk/client-dynamodb";
import { PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { describe, expect, it } from "vitest";
import {
  pollGmail,
  type GmailClient,
  type PollDependencies,
} from "../source-gmail/poll.js";
import { createLocalClient } from "./dynamodb.js";
import { GmailAttemptRepository } from "./gmail-attempt.js";
import { GmailConfigRepository } from "./gmail-config.js";
import { GmailLedgerRepository } from "./gmail-ledger.js";
import { GmailStateRepository } from "./gmail-state.js";
import { LocalObjectStore } from "./object-store.js";

describe("Gmail recovery integration", () => {
  it("withholds a partial incremental update until a full recovery and rejects unclaimed legacy checkpoints repeatedly", async () => {
    const endpoint = process.env.ROLERIVER_DYNAMODB_TEST_URL;
    if (process.env.ROLERIVER_DYNAMODB_TEST !== "1" || !endpoint)
      throw new Error("Explicit local test opt-in and endpoint are required");
    const db = createLocalClient(endpoint);
    const admin = new DynamoDBClient({
      endpoint,
      region: "local",
      credentials: { accessKeyId: "dummy", secretAccessKey: "dummy" },
      maxAttempts: 1,
    });
    const table = `recovery_${randomUUID().replaceAll("-", "")}`;
    const root = await mkdtemp(join(tmpdir(), "gmail-recovery-"));
    let created = false;
    try {
      await admin.send(
        new CreateTableCommand({
          TableName: table,
          BillingMode: "PAY_PER_REQUEST",
          AttributeDefinitions: [
            { AttributeName: "pk", AttributeType: "S" },
            { AttributeName: "sk", AttributeType: "S" },
          ],
          KeySchema: [
            { AttributeName: "pk", KeyType: "HASH" },
            { AttributeName: "sk", KeyType: "RANGE" },
          ],
        }),
      );
      created = true;
      const objects = await LocalObjectStore.open(root);
      const state = new GmailStateRepository(db, table, 30000);
      const attempts = new GmailAttemptRepository(db, table);
      const claims = new GmailConfigRepository(db, table);
      const lifecycle = new GmailObjectLifecycle(db, table, objects, {
        exclusive: async <T>(_tenant: string, task: () => Promise<T>) => task(),
      });
      const ledger = new GmailLedgerRepository(db, table, lifecycle);
      const scope = {
        tenantId: "tenant",
        connectionId: "connection",
        sourceId: "source",
      };
      await new GmailConnectionRepository(db, table).initialize(scope);
      const config = { version: "v1", query: "", labelIds: [] };
      let phase: "initial" | "failure" | "recovery" = "initial";
      const client: GmailClient = {
        watermark: async () => (phase === "initial" ? "10" : "20"),
        list: async () => ({ messageIds: ["message"], nextPageToken: null }),
        history: async () => ({
          messageIds: phase === "failure" ? ["message", "uncertain"] : [],
          nextPageToken: null,
          historyId: phase === "initial" ? "11" : "21",
        }),
        reconcile: async (_scope, messageId) =>
          phase === "failure"
            ? messageId === "uncertain"
              ? { kind: "unknown", messageId }
              : { kind: "excluded", messageId, revision: "20" }
            : {
                kind: "eligible",
                messageId,
                revision: phase === "initial" ? "10" : "21",
                text: "synthetic role",
              },
      };
      const deps: PollDependencies = {
        policy: { check: async () => true },
        client,
        lease: state.lease,
        checkpoints: state.checkpoints,
        claims,
        attempts,
        ledger: ledger.ledger,
      };
      expect(await pollGmail(scope, config, deps)).toEqual({
        status: "completed",
        mode: "full",
      });
      const connectionPk = `gmail#${createHash("sha256")
        .update(JSON.stringify([scope.tenantId, scope.connectionId]))
        .digest("hex")}`;
      const initialRow = (
        await db.send(
          new QueryCommand({
            TableName: table,
            KeyConditionExpression: "pk = :pk",
            ExpressionAttributeValues: { ":pk": connectionPk },
            ConsistentRead: true,
          }),
        )
      ).Items!.find((item) => item.messageId === "message")!;
      const processingFence = (await state.lease.acquire(scope))!.fence;
      const holds = new GmailHoldRepository(db, table);
      await holds.add(
        scope,
        initialRow.object.id,
        { kind: "role", id: "retained" },
        processingFence,
      );
      await holds.release(
        scope,
        initialRow.object.id,
        { kind: "processing", id: "initial" },
        processingFence,
      );
      await state.lease.release(scope, processingFence);
      phase = "failure";
      expect(await pollGmail(scope, config, deps)).toEqual({
        status: "failed",
      });
      expect((await state.checkpoints.load(scope))?.historyId).toBe("11");
      let readCalled = false;
      expect(
        await attempts.read(scope, async () => {
          readCalled = true;
          return "partial";
        }),
      ).toEqual({ status: "unavailable" });
      expect(readCalled).toBe(false);
      phase = "recovery";
      expect(await pollGmail(scope, config, deps)).toEqual({
        status: "completed",
        mode: "full",
      });
      const result = await attempts.read(scope, async () => {
        const pk = `gmail#${(await import("node:crypto"))
          .createHash("sha256")
          .update(JSON.stringify([scope.tenantId, scope.connectionId]))
          .digest("hex")}`;
        return (
          await db.send(
            new QueryCommand({
              TableName: table,
              KeyConditionExpression: "pk = :pk",
              ExpressionAttributeValues: { ":pk": pk },
              ConsistentRead: true,
            }),
          )
        ).Items!.find((item) => item.messageId === "message");
      });
      expect(result).toMatchObject({
        status: "ready",
        value: { active: true, revision: "21" },
      });
      expect((await state.checkpoints.load(scope))?.historyId).toBe("21");

      const legacy = { ...scope, sourceId: "legacy" };
      const fence = (await state.lease.acquire(legacy))!.fence;
      const hash = (value: string) =>
        createHash("sha256").update(value).digest("hex");
      await db.send(
        new PutCommand({
          TableName: table,
          Item: {
            pk: `gmail#${hash(JSON.stringify([legacy.tenantId, legacy.connectionId]))}`,
            sk: `checkpoint#${hash(legacy.sourceId)}`,
            checkpoint: { historyId: "1", configVersion: "v1", revision: 1 },
          },
        }),
      );
      await attempts.begin(legacy, fence, "full");
      await state.lease.release(legacy, fence);
      expect(await pollGmail(legacy, config, deps)).toEqual({
        status: "failed",
      });
      expect(await pollGmail(legacy, config, deps)).toEqual({
        status: "failed",
      });
      const lease = (await state.lease.acquire(legacy))!.fence;
      expect(await claims.hasClaim(legacy, "v1", lease)).toBe(false);
      await state.lease.release(legacy, lease);
    } finally {
      if (created)
        await admin.send(new DeleteTableCommand({ TableName: table }));
      db.destroy();
      admin.destroy();
      await rm(root, { recursive: true, force: true });
    }
  }, 30000);
});
