import { createHash, randomUUID } from "node:crypto";
import {
  CreateTableCommand,
  DeleteTableCommand,
  DynamoDBClient,
} from "@aws-sdk/client-dynamodb";
import { GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { describe, expect, it } from "vitest";
import { createLocalClient } from "./dynamodb.js";
import { GmailConnectionRepository } from "./gmail-connection.js";
import { GmailHoldRepository } from "./gmail-holds.js";
import { GmailStateRepository } from "./gmail-state.js";
import { GmailAttemptRepository } from "./gmail-attempt.js";

const testRefreshLock = {
  run: async <T>(_key: string, operation: () => Promise<T>) => ({
    status: "completed" as const,
    value: await operation(),
  }),
};

describe("Gmail holds with DynamoDB Local", () => {
  it("keeps other holds on release and fails closed for missing or disconnected content", async () => {
    const endpoint = process.env.ROLERIVER_DYNAMODB_TEST_URL;
    if (process.env.ROLERIVER_DYNAMODB_TEST !== "1" || !endpoint)
      throw new Error("Explicit local test opt-in and endpoint are required");
    const client = createLocalClient(endpoint);
    const admin = new DynamoDBClient({
      endpoint,
      region: "local",
      credentials: { accessKeyId: "dummy", secretAccessKey: "dummy" },
      maxAttempts: 1,
    });
    const table = `holds_${randomUUID().replaceAll("-", "")}`;
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
      const scope = {
        tenantId: "tenant",
        connectionId: "connection",
        sourceId: "source",
      };
      const objectId = `go_${randomUUID().replaceAll("-", "")}`;
      const hash = (value: string) =>
        createHash("sha256").update(value).digest("hex");
      const key = {
        pk: `gmail#${hash(JSON.stringify([scope.tenantId, scope.connectionId]))}`,
        sk: `object#${hash(scope.sourceId)}#${objectId}`,
      };
      const holds = new GmailHoldRepository(client, table);
      const connection = new GmailConnectionRepository(client, table);
      const processing = { kind: "processing" as const, id: "initial" };
      const role = { kind: "role" as const, id: "role" };
      await expect(
        holds.add(scope, objectId, processing, "1"),
      ).rejects.toThrow();
      await connection.initialize(scope);
      const state = new GmailStateRepository(client, table, 30000);
      const attempts = new GmailAttemptRepository(client, table);
      const fence = (await state.lease.acquire(scope))!.fence;
      await attempts.begin(scope, fence, "full");
      expect(
        await attempts.publish(scope, fence, null, {
          historyId: "1",
          configVersion: "v1",
          revision: 1,
        }),
      ).toBe(true);
      await expect(
        holds.add(scope, objectId, processing, fence),
      ).rejects.toThrow();
      await client.send(
        new PutCommand({
          TableName: table,
          Item: { ...key, objectId, status: "committed" },
        }),
      );
      await expect(
        holds.add(scope, objectId, processing, fence),
      ).rejects.toThrow();
      await client.send(
        new PutCommand({
          TableName: table,
          Item: { ...key, objectId, status: "committed", holdCount: 0 },
        }),
      );
      await expect(
        holds.add(scope, objectId, processing, fence),
      ).rejects.toThrow();
      await client.send(
        new PutCommand({
          TableName: table,
          Item: {
            ...key,
            objectId,
            status: "committed",
            holdCount: 1,
            ownerMessageId: "message",
          },
        }),
      );
      const ownerKey = {
        pk: key.pk,
        sk: `ledger#${hash(scope.sourceId)}#message#${hash("message")}`,
      };
      await client.send(
        new PutCommand({
          TableName: table,
          Item: {
            ...ownerKey,
            generation: 1,
            active: true,
            object: { id: objectId },
          },
        }),
      );
      await client.send(
        new PutCommand({
          TableName: table,
          Item: {
            pk: key.pk,
            sk: `hold#${hash(scope.sourceId)}#${objectId}#${hash(JSON.stringify([processing.kind, processing.id]))}`,
            kind: processing.kind,
            holdId: processing.id,
            status: "held",
          },
        }),
      );
      await Promise.all([
        holds.add(scope, objectId, processing, fence),
        holds.add(scope, objectId, role, fence),
      ]);
      await expect(
        holds.add(scope, objectId, processing, fence),
      ).resolves.toBeUndefined();
      await expect(
        holds.add(scope, objectId, { kind: "evidence", id: "stale" }, "999999"),
      ).rejects.toThrow();
      expect(
        await attempts.read(scope, async () => {
          const mutableScope = { ...scope };
          const pending = holds.release(
            mutableScope,
            objectId,
            processing,
            fence,
          );
          mutableScope.tenantId = "other";
          expect(await pending).toEqual({
            deletionPending: false,
          });
          return "private";
        }),
      ).toEqual({ status: "unavailable" });
      expect(
        (
          await client.send(
            new GetCommand({
              TableName: table,
              Key: key,
              ConsistentRead: true,
            }),
          )
        ).Item?.holdCount,
      ).toBe(1);
      expect(await holds.release(scope, objectId, role, fence)).toEqual({
        deletionPending: true,
      });
      expect(
        (
          await client.send(
            new GetCommand({
              TableName: table,
              Key: ownerKey,
              ConsistentRead: true,
            }),
          )
        ).Item,
      ).toMatchObject({ active: false, contentPurged: true, generation: 2 });
      expect(
        (
          await client.send(
            new GetCommand({
              TableName: table,
              Key: ownerKey,
              ConsistentRead: true,
            }),
          )
        ).Item?.object,
      ).toBeUndefined();
      expect(await holds.release(scope, objectId, role, fence)).toEqual({
        deletionPending: true,
      });
      expect(
        (
          await client.send(
            new GetCommand({
              TableName: table,
              Key: key,
              ConsistentRead: true,
            }),
          )
        ).Item,
      ).toMatchObject({ holdCount: 0, deletionPending: true });
      await expect(
        holds.add(scope, objectId, { kind: "evidence", id: "evidence" }, fence),
      ).rejects.toThrow();
      await connection.withRefreshLock(testRefreshLock).disconnect(scope);
      await expect(
        holds.add(scope, objectId, processing, fence),
      ).rejects.toThrow();
    } finally {
      if (created)
        await admin.send(new DeleteTableCommand({ TableName: table }));
      client.destroy();
      admin.destroy();
    }
  }, 30000);
});
