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
import { createLocalClient } from "./dynamodb.js";
import { GmailAttemptRepository } from "./gmail-attempt.js";
import { GmailConnectionRepository } from "./gmail-connection.js";
import { GmailHoldRepository } from "./gmail-holds.js";
import { GmailLedgerRepository } from "./gmail-ledger.js";
import { GmailObjectLifecycle } from "./gmail-objects.js";
import { GmailStateRepository } from "./gmail-state.js";
import { LocalObjectStore } from "./object-store.js";

const testRefreshLock = {
  run: async <T>(_key: string, operation: () => Promise<T>) => ({
    status: "completed" as const,
    value: await operation(),
  }),
};

describe("Gmail ledger retention integration", () => {
  it("detaches the last held object and does not rehydrate the same revision", async () => {
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
    const table = `retention_${randomUUID().replaceAll("-", "")}`;
    const root = await mkdtemp(join(tmpdir(), "gmail-retention-"));
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
      const config = { version: "v1", query: "", labelIds: [] };
      const objects = await LocalObjectStore.open(root);
      const lifecycle = new GmailObjectLifecycle(client, table, objects, {
        exclusive: async <T>(_tenant: string, task: () => Promise<T>) => task(),
      });
      const ledger = new GmailLedgerRepository(client, table, lifecycle).ledger;
      const attempts = new GmailAttemptRepository(client, table);
      const state = new GmailStateRepository(client, table, 30000);
      const holds = new GmailHoldRepository(client, table, lifecycle);
      await new GmailConnectionRepository(client, table).initialize(scope);
      const fence = (await state.lease.acquire(scope))!.fence;
      await attempts.begin(scope, fence, "full");
      await ledger.beginFullSync(scope, config, fence);
      await ledger.apply(
        scope,
        {
          kind: "eligible",
          messageId: "message",
          revision: "10",
          text: "Synthetic vacancy",
        },
        fence,
      );
      await expect(
        ledger.apply(
          scope,
          { kind: "excluded", messageId: "message", revision: "11" },
          fence,
        ),
      ).rejects.toThrow();
      await ledger.finishFullSync(scope, config, fence);
      expect(
        await attempts.publish(scope, fence, null, {
          historyId: "10",
          configVersion: "v1",
          revision: 1,
        }),
      ).toBe(true);
      const hash = (value: string) =>
        createHash("sha256").update(value).digest("hex");
      const key = {
        pk: `gmail#${hash(JSON.stringify([scope.tenantId, scope.connectionId]))}`,
        sk: `ledger#${hash(scope.sourceId)}#message#${hash("message")}`,
      };
      const get = async () =>
        (
          await client.send(
            new GetCommand({
              TableName: table,
              Key: key,
              ConsistentRead: true,
            }),
          )
        ).Item!;
      const original = await get();
      expect(original.object.id).toMatch(/^go_/);
      await holds.add(
        scope,
        original.object.id,
        { kind: "role", id: "role" },
        fence,
      );
      expect(
        await holds.release(
          scope,
          original.object.id,
          { kind: "processing", id: "initial" },
          fence,
        ),
      ).toEqual({ deletionPending: false });
      expect((await get()).object.id).toBe(original.object.id);
      expect(
        await holds.release(
          scope,
          original.object.id,
          { kind: "role", id: "role" },
          fence,
        ),
      ).toEqual({ deletionPending: false });
      expect(await objects.get(scope.tenantId, original.object.id)).toBeNull();
      expect(await get()).toMatchObject({ active: false, contentPurged: true });
      expect((await get()).object).toBeUndefined();
      await state.lease.release(scope, fence);
      const next = (await state.lease.acquire(scope))!.fence;
      await attempts.begin(scope, next, "full");
      await ledger.beginFullSync(scope, config, next);
      await ledger.apply(
        scope,
        {
          kind: "eligible",
          messageId: "message",
          revision: "10",
          text: "Synthetic vacancy",
        },
        next,
      );
      await ledger.apply(
        scope,
        {
          kind: "eligible",
          messageId: "active",
          revision: "11",
          text: "Another synthetic vacancy",
        },
        next,
      );
      await ledger.finishFullSync(scope, config, next);
      expect(await get()).toMatchObject({ active: false, contentPurged: true });
      expect((await get()).object).toBeUndefined();
      const activeKey = {
        pk: key.pk,
        sk: `ledger#${hash(scope.sourceId)}#message#${hash("active")}`,
      };
      const activeRow = (
        await client.send(
          new GetCommand({
            TableName: table,
            Key: activeKey,
            ConsistentRead: true,
          }),
        )
      ).Item!;
      await holds.add(
        scope,
        activeRow.object.id,
        { kind: "role", id: "still-active" },
        next,
      );
      await new GmailConnectionRepository(
        client,
        table,
        testRefreshLock,
      ).disconnect(scope);
      await lifecycle.purgeDisconnectedSource(scope, next);
      await lifecycle.purgeDisconnectedSource(scope, next);
      expect(await objects.get(scope.tenantId, activeRow.object.id)).toBeNull();
      expect(
        (
          await client.send(
            new GetCommand({
              TableName: table,
              Key: activeKey,
              ConsistentRead: true,
            }),
          )
        ).Item,
      ).toMatchObject({ active: false, contentPurged: true });
      await expect(
        holds.release(
          scope,
          activeRow.object.id,
          { kind: "role", id: "still-active" },
          next,
        ),
      ).rejects.toThrow();
    } finally {
      if (created)
        await admin.send(new DeleteTableCommand({ TableName: table }));
      client.destroy();
      admin.destroy();
      await rm(root, { recursive: true, force: true });
    }
  }, 30000);
});
