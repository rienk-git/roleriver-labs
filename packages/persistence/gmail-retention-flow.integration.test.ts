import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CreateTableCommand,
  DeleteTableCommand,
  DynamoDBClient,
} from "@aws-sdk/client-dynamodb";
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { describe, expect, it } from "vitest";
import { pollGmail, type PollDependencies } from "../source-gmail/poll.js";
import { createLocalClient } from "./dynamodb.js";
import { GmailAttemptRepository } from "./gmail-attempt.js";
import { GmailConfigRepository } from "./gmail-config.js";
import { GmailConnectionRepository } from "./gmail-connection.js";
import { GmailHoldRepository } from "./gmail-holds.js";
import { GmailLedgerRepository } from "./gmail-ledger.js";
import { GmailObjectLifecycle } from "./gmail-objects.js";
import { GmailStateRepository } from "./gmail-state.js";
import { LocalObjectStore } from "./object-store.js";
import { LocalTenantBarrier } from "./local-barrier.js";

describe("Gmail retention flow with DynamoDB Local", () => {
  it("purges a last-held message and does not restore it on a later full sync", async () => {
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
    const table = `retention_${randomUUID().replaceAll("-", "")}`;
    const root = await mkdtemp(join(tmpdir(), "gmail-retention-"));
    const lockRoot = await mkdtemp(join(tmpdir(), "gmail-barrier-"));
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
      const barrier = await LocalTenantBarrier.open(lockRoot);
      const lifecycle = new GmailObjectLifecycle(db, table, objects, {
        exclusive: async (tenant, task) => {
          const outcome = await barrier.run(tenant, task);
          if (outcome.status === "busy") throw new Error("barrier busy");
          return outcome.value;
        },
      });
      const state = new GmailStateRepository(db, table, 30000);
      const attempts = new GmailAttemptRepository(db, table);
      const claims = new GmailConfigRepository(db, table);
      const holds = new GmailHoldRepository(db, table);
      const ledger = new GmailLedgerRepository(db, table, lifecycle);
      const scope = {
        tenantId: "tenant",
        connectionId: "connection",
        sourceId: "source",
      };
      await new GmailConnectionRepository(db, table).initialize(scope);
      const deps: PollDependencies = {
        policy: { check: async () => true },
        client: {
          watermark: async () => "10",
          list: async () => ({ messageIds: ["message"], nextPageToken: null }),
          history: async () => ({
            messageIds: [],
            nextPageToken: null,
            historyId: "11",
          }),
          reconcile: async (_scope, messageId) => ({
            kind: "eligible",
            messageId,
            revision: "10",
            text: "synthetic role",
          }),
        },
        lease: state.lease,
        checkpoints: state.checkpoints,
        claims,
        attempts,
        ledger: ledger.ledger,
      };
      const config = { version: "v1", query: "", labelIds: [] };
      expect(await pollGmail(scope, config, deps)).toEqual({
        status: "completed",
        mode: "full",
      });
      const hash = (value: string) =>
        createHash("sha256").update(value).digest("hex");
      const key = {
        pk: `gmail#${hash(JSON.stringify([scope.tenantId, scope.connectionId]))}`,
        sk: `ledger#${hash(scope.sourceId)}#message#${hash("message")}`,
      };
      const read = async () =>
        (
          await db.send(
            new GetCommand({
              TableName: table,
              Key: key,
              ConsistentRead: true,
            }),
          )
        ).Item;
      const record = (await read())!;
      const objectId = record.object.id as string;
      expect(await objects.get(scope.tenantId, objectId)).not.toBeNull();
      const fence = (await state.lease.acquire(scope))!.fence;
      expect(
        await holds.release(
          scope,
          objectId,
          { kind: "processing", id: "initial" },
          fence,
        ),
      ).toEqual({ deletionPending: true });
      expect(await read()).toMatchObject({
        active: false,
        contentPurged: true,
      });
      await lifecycle.scheduleDeletion(scope, fence, objectId, [
        {
          ConditionCheck: {
            TableName: table,
            Key: key,
            ConditionExpression:
              "contentPurged = :yes AND attribute_not_exists(#object)",
            ExpressionAttributeNames: { "#object": "object" },
            ExpressionAttributeValues: { ":yes": true },
          },
        },
      ]);
      await lifecycle.recover(scope, fence);
      expect(await objects.get(scope.tenantId, objectId)).toBeNull();
      await state.lease.release(scope, fence);
      expect(
        await pollGmail(scope, { ...config, version: "v2" }, deps),
      ).toEqual({ status: "completed", mode: "full" });
      expect(await attempts.read(scope, read)).toMatchObject({
        status: "ready",
        value: { active: false, contentPurged: true },
      });
      expect((await read())!.object).toBeUndefined();
      expect(await objects.get(scope.tenantId, objectId)).toBeNull();
    } finally {
      if (created)
        await admin.send(new DeleteTableCommand({ TableName: table }));
      db.destroy();
      admin.destroy();
      await rm(root, { recursive: true, force: true });
      await rm(lockRoot, { recursive: true, force: true });
    }
  }, 30000);
});
