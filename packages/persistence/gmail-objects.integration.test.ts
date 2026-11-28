import { GmailConnectionRepository } from "./gmail-connection.js";
import { GmailHoldRepository } from "./gmail-holds.js";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CreateTableCommand,
  DeleteTableCommand,
  DynamoDBClient,
} from "@aws-sdk/client-dynamodb";
import {
  GetCommand,
  QueryCommand,
  PutCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { describe, expect, it } from "vitest";
import { createLocalClient } from "./dynamodb.js";
import { GmailObjectLifecycle } from "./gmail-objects.js";
import { GmailStateRepository } from "./gmail-state.js";
import { LocalObjectStore } from "./object-store.js";

describe("Gmail object lifecycle with DynamoDB Local", () => {
  it("recovers failed unpublished writes and preserves published and legacy objects", async () => {
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
    const table = `objects_${randomUUID().replaceAll("-", "")}`;
    const root = await mkdtemp(join(tmpdir(), "gmail-objects-"));
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
      const state = new GmailStateRepository(client, table, 30000);
      const scope = {
        tenantId: "tenant",
        connectionId: "connection",
        sourceId: "source",
      };
      await new GmailConnectionRepository(client, table).initialize(scope);
      const fence = (await state.lease.acquire(scope))!.fence;
      const barrier = {
        exclusive: async <T>(_tenant: string, task: () => Promise<T>) => task(),
      };
      const lifecycle = new GmailObjectLifecycle(
        client,
        table,
        objects,
        barrier,
      );
      const text = new TextEncoder().encode("synthetic content");
      const legacy = "a".repeat(64);
      await objects.put(scope.tenantId, legacy, text);
      const pendingId = `go_${randomUUID().replaceAll("-", "")}`;
      const failedStore = {
        put: async () => {
          throw new Error("synthetic object write failure");
        },
        get: objects.get.bind(objects),
        delete: objects.delete.bind(objects),
      };
      const failedLifecycle = new GmailObjectLifecycle(
        client,
        table,
        failedStore,
        barrier,
      );
      await expect(
        failedLifecycle.writeAndPublish(
          scope,
          fence,
          pendingId,
          text,
          (reference) => [
            {
              Put: {
                TableName: table,
                Item: { pk: "first", sk: "record", reference },
              },
            },
          ],
          "message",
        ),
      ).rejects.toThrow();
      expect(await objects.get(scope.tenantId, pendingId)).toBeNull();
      await expect(
        lifecycle.writeAndPublish(
          { ...scope, sourceId: "another_source" },
          fence,
          pendingId,
          text,
          (reference) => [
            {
              Put: {
                TableName: table,
                Item: { pk: "second", sk: "record", reference },
              },
            },
          ],
          "message",
        ),
      ).rejects.toThrow();
      const target = { pk: "synthetic-owner", sk: "record" };
      const operationId = `go_${randomUUID().replaceAll("-", "")}`;
      const orphanId = `go_${randomUUID().replaceAll("-", "")}`;
      const published = await lifecycle.writeAndPublish(
        scope,
        fence,
        operationId,
        text,
        (reference) => [
          { Put: { TableName: table, Item: { ...target, reference } } },
        ],
        "message",
      );
      await expect(
        lifecycle.writeAndPublish(
          scope,
          fence,
          orphanId,
          text,
          (reference) => [
            {
              Put: {
                TableName: table,
                Item: { ...target, reference },
                ConditionExpression: "attribute_not_exists(pk)",
              },
            },
          ],
          "message",
        ),
      ).rejects.toThrow("Gmail object operation failed");
      expect(
        await lifecycle.writeAndPublish(
          scope,
          fence,
          operationId,
          text,
          (reference) => [
            { Put: { TableName: table, Item: { ...target, reference } } },
          ],
          "message",
        ),
      ).toEqual(published);
      await expect(
        lifecycle.writeAndPublish(
          scope,
          fence,
          operationId,
          new Uint8Array([1]),
          () => [],
          "message",
        ),
      ).rejects.toThrow();
      const rows = (
        await client.send(
          new QueryCommand({
            TableName: table,
            KeyConditionExpression: "pk = :pk",
            ExpressionAttributeValues: {
              ":pk": `gmail#${(await import("node:crypto"))
                .createHash("sha256")
                .update(JSON.stringify([scope.tenantId, scope.connectionId]))
                .digest("hex")}`,
            },
            ConsistentRead: true,
          }),
        )
      ).Items!;
      const orphan = rows.find(
        (item) => item.objectId === orphanId && item.status === "pending",
      )!.objectId;
      expect(await objects.get(scope.tenantId, orphan)).toEqual(text);
      await expect(
        lifecycle.writeAndPublish(
          { ...scope, sourceId: "another_source" },
          fence,
          orphanId,
          text,
          (reference) => [
            {
              Put: {
                TableName: table,
                Item: { pk: "another", sk: "record", reference },
              },
            },
          ],
          "message",
        ),
      ).rejects.toThrow();
      await expect(
        lifecycle.writeAndPublish(
          scope,
          fence,
          operationId,
          text,
          (reference) => [
            {
              Put: {
                TableName: table,
                Item: { pk: "other", sk: "record", reference },
              },
            },
          ],
          "message",
        ),
      ).rejects.toThrow();
      await lifecycle.recover(scope, fence);
      await lifecycle.recover(scope, fence);
      expect(await objects.get(scope.tenantId, orphan)).toBeNull();
      expect(await objects.get(scope.tenantId, published.id)).toEqual(text);
      expect(await objects.get(scope.tenantId, legacy)).toEqual(text);
      expect(
        (
          await client.send(
            new GetCommand({
              TableName: table,
              Key: target,
              ConsistentRead: true,
            }),
          )
        ).Item?.reference,
      ).toEqual(published);
      await expect(
        lifecycle.scheduleDeletion(scope, fence, published.id, [
          {
            Delete: {
              TableName: table,
              Key: target,
              ConditionExpression: "attribute_not_exists(pk)",
            },
          },
        ]),
      ).rejects.toThrow();
      expect(await objects.get(scope.tenantId, published.id)).toEqual(text);
      const holds = new GmailHoldRepository(client, table);
      const attachOwner = async (objectId: string, messageId: string) => {
        const hash = (value: string) =>
          createHash("sha256").update(value).digest("hex");
        const pk = `gmail#${hash(JSON.stringify([scope.tenantId, scope.connectionId]))}`;
        await client.send(
          new UpdateCommand({
            TableName: table,
            Key: { pk, sk: `object#${hash(scope.sourceId)}#${objectId}` },
            UpdateExpression: "SET ownerMessageId = :id",
            ExpressionAttributeValues: { ":id": messageId },
          }),
        );
        await client.send(
          new PutCommand({
            TableName: table,
            Item: {
              pk,
              sk: `ledger#${hash(scope.sourceId)}#message#${hash(messageId)}`,
              generation: 1,
              active: true,
              object: { id: objectId },
            },
          }),
        );
      };
      await attachOwner(published.id, "message");
      expect(
        await holds.release(
          scope,
          published.id,
          {
            kind: "processing",
            id: "initial",
          },
          fence,
        ),
      ).toEqual({ deletionPending: true });
      await lifecycle.scheduleDeletion(scope, fence, published.id, [
        {
          Delete: {
            TableName: table,
            Key: target,
            ConditionExpression: "attribute_exists(pk)",
          },
        },
      ]);
      await expect(
        lifecycle.scheduleDeletion(scope, fence, published.id, [
          { Delete: { TableName: table, Key: { pk: "other", sk: "record" } } },
        ]),
      ).rejects.toThrow();
      await lifecycle.scheduleDeletion(scope, fence, published.id, [
        {
          Delete: {
            TableName: table,
            Key: target,
            ConditionExpression: "attribute_exists(pk)",
          },
        },
      ]);
      await lifecycle.recover(scope, fence);
      expect(await objects.get(scope.tenantId, published.id)).toBeNull();
      expect(await objects.get(scope.tenantId, legacy)).toEqual(text);
      const ambiguousId = `go_${randomUUID().replaceAll("-", "")}`;
      const ambiguousTarget = { pk: "ambiguous", sk: "record" };
      let dropResponse = true;
      const lossyBarrier = {
        exclusive: async <T>(_tenant: string, task: () => Promise<T>) => {
          const result = await task();
          if (dropResponse) {
            dropResponse = false;
            throw new Error("synthetic lost response");
          }
          return result;
        },
      };
      const lossy = new GmailObjectLifecycle(
        client,
        table,
        objects,
        lossyBarrier,
      );
      await expect(
        lossy.writeAndPublish(
          scope,
          fence,
          ambiguousId,
          text,
          (reference) => [
            {
              Put: {
                TableName: table,
                Item: { ...ambiguousTarget, reference },
                ConditionExpression: "attribute_not_exists(pk)",
              },
            },
          ],
          "message",
        ),
      ).rejects.toThrow();
      const retried = await lifecycle.writeAndPublish(
        scope,
        fence,
        ambiguousId,
        text,
        (reference) => [
          {
            Put: {
              TableName: table,
              Item: { ...ambiguousTarget, reference },
              ConditionExpression: "attribute_not_exists(pk)",
            },
          },
        ],
        "message",
      );
      expect(retried.id).toBe(ambiguousId);
      await attachOwner(ambiguousId, "ambiguous");
      expect(
        await holds.release(
          scope,
          ambiguousId,
          {
            kind: "processing",
            id: "initial",
          },
          fence,
        ),
      ).toEqual({ deletionPending: true });
      dropResponse = true;
      await lossy.scheduleDeletion(scope, fence, ambiguousId, [
        {
          Delete: {
            TableName: table,
            Key: ambiguousTarget,
            ConditionExpression: "attribute_exists(pk)",
          },
        },
      ]);
      await lifecycle.recover(scope, fence);
      expect(await objects.get(scope.tenantId, ambiguousId)).toBeNull();
      const snapshotId = `go_${randomUUID().replaceAll("-", "")}`;
      const action = {
        Put: { TableName: table, Item: { pk: "snapshot", sk: "original" } },
      };
      const mutatingBarrier = {
        exclusive: async <T>(_tenant: string, task: () => Promise<T>) => {
          action.Put.Item.sk = "mutated";
          return task();
        },
      };
      const snapshotLifecycle = new GmailObjectLifecycle(
        client,
        table,
        objects,
        mutatingBarrier,
      );
      await snapshotLifecycle.writeAndPublish(
        scope,
        fence,
        snapshotId,
        text,
        () => [action],
        "message",
      );
      expect(
        (
          await client.send(
            new GetCommand({
              TableName: table,
              Key: { pk: "snapshot", sk: "original" },
              ConsistentRead: true,
            }),
          )
        ).Item,
      ).toBeDefined();
      expect(
        (
          await client.send(
            new GetCommand({
              TableName: table,
              Key: { pk: "snapshot", sk: "mutated" },
              ConsistentRead: true,
            }),
          )
        ).Item,
      ).toBeUndefined();
      await state.lease.release(scope, fence);
      await expect(lifecycle.recover(scope, fence)).rejects.toThrow(
        "Gmail object operation failed",
      );
      await expect(
        lifecycle.writeAndPublish(
          scope,
          fence,
          `go_${randomUUID().replaceAll("-", "")}`,
          text,
          () => [{ Put: { TableName: table, Item: { pk: "bad", sk: "bad" } } }],
          "message",
        ),
      ).rejects.toThrow("Gmail object operation failed");
    } finally {
      if (created)
        await admin.send(new DeleteTableCommand({ TableName: table }));
      client.destroy();
      admin.destroy();
      await rm(root, { recursive: true, force: true });
    }
  }, 30000);
});
