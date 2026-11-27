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
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
  type DynamoDBDocumentClient,
} from "@aws-sdk/lib-dynamodb";
import { describe, expect, it } from "vitest";
import { createLocalClient } from "./dynamodb.js";
import { GmailLedgerRepository } from "./gmail-ledger.js";
import { GmailStateRepository } from "./gmail-state.js";
import { LocalObjectStore } from "./object-store.js";
import type { PollScope } from "../source-gmail/poll.js";

const endpoint = process.env.ROLERIVER_DYNAMODB_TEST_URL;
const enabled = process.env.ROLERIVER_DYNAMODB_TEST === "1";
const scope: PollScope = {
  tenantId: "tenant-a",
  connectionId: "connection",
  sourceId: "source",
};
const config = { version: "v1", query: "", labelIds: [] };

describe("Gmail ledger with DynamoDB Local", () => {
  it("fences updates, replays full sync and preserves tenant-bound content", async () => {
    if (!enabled || !endpoint)
      throw new Error("Explicit local test opt-in and endpoint are required");
    const client = createLocalClient(endpoint);
    const admin = new DynamoDBClient({
      endpoint,
      region: "local",
      credentials: { accessKeyId: "dummy", secretAccessKey: "dummy" },
      maxAttempts: 1,
    });
    const table = `ledger_${randomUUID().replaceAll("-", "")}`;
    const dir = await mkdtemp(join(tmpdir(), "roleriver-ledger-"));
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
      const objects = await LocalObjectStore.open(dir);
      const state = new GmailStateRepository(client, table, 60000);
      const ledger = new GmailLedgerRepository(client, table, objects).ledger;
      const fence = (await state.lease.acquire(scope))!.fence;
      await ledger.beginFullSync(scope, config, fence);
      await ledger.apply(
        scope,
        {
          kind: "eligible",
          messageId: "first",
          revision: "9",
          text: "Synthetic role",
        },
        fence,
      );
      await ledger.apply(
        scope,
        {
          kind: "eligible",
          messageId: "second",
          revision: "10",
          text: "Another synthetic role",
        },
        fence,
      );
      await ledger.finishFullSync(scope, config, fence);
      await ledger.finishFullSync(scope, config, fence);
      await state.lease.release(scope, fence);
      const next = (await state.lease.acquire(scope))!.fence;
      await expect(
        ledger.beginFullSync(scope, config, fence),
      ).rejects.toThrow();
      await expect(
        ledger.finishFullSync(scope, config, fence),
      ).rejects.toThrow();
      await expect(
        ledger.apply(
          scope,
          {
            kind: "eligible",
            messageId: "stale",
            revision: "11",
            text: "Synthetic",
          },
          fence,
        ),
      ).rejects.toThrow("Gmail ledger operation failed");
      const orphanId = createHash("sha256").update("Synthetic").digest("hex");
      expect(
        Buffer.from((await objects.get(scope.tenantId, orphanId))!).toString(),
      ).toBe("Synthetic");
      await ledger.beginFullSync(scope, config, next);
      await ledger.apply(
        scope,
        {
          kind: "eligible",
          messageId: "stale",
          revision: "11",
          text: "Synthetic",
        },
        next,
      );
      await ledger.apply(
        scope,
        {
          kind: "eligible",
          messageId: "first",
          revision: "9",
          text: "Synthetic role",
        },
        next,
      );
      // Crash during full scan: the new fence restarts the seen set before retiring records.
      await state.lease.release(scope, next);
      const restart = (await state.lease.acquire(scope))!.fence;
      await ledger.beginFullSync(scope, config, restart);
      await ledger.apply(
        scope,
        {
          kind: "eligible",
          messageId: "second",
          revision: "10",
          text: "Another synthetic role",
        },
        restart,
      );
      await ledger.apply(
        scope,
        {
          kind: "eligible",
          messageId: "second",
          revision: "2",
          text: "Older synthetic text",
        },
        restart,
      );
      await ledger.finishFullSync(scope, config, restart);
      const partition = (
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
      const first = partition.find((item) => item.messageId === "first")!;
      const second = partition.find((item) => item.messageId === "second")!;
      expect(first.active).toBe(false);
      expect(second.active).toBe(true);
      expect(second.revision).toBe("10");
      expect(second).toMatchObject({
        origin: "gmail",
        externalProcessing: "not_authorized",
      });
      expect(JSON.stringify(partition)).not.toContain("Another synthetic role");
      expect(
        Buffer.from(
          (await objects.get(scope.tenantId, second.object.id))!,
        ).toString(),
      ).toBe("Another synthetic role");
      expect(await objects.get("tenant-b", second.object.id)).toBeNull();
      await state.lease.release(scope, restart);
      const changed = (await state.lease.acquire(scope))!.fence;
      await ledger.beginFullSync(scope, { ...config, version: "v2" }, changed);
      await ledger.apply(
        scope,
        { kind: "excluded", messageId: "second", revision: "10" },
        changed,
      );
      await ledger.finishFullSync(scope, { ...config, version: "v2" }, changed);
      expect(
        await state.checkpoints.compareAndSet(
          scope,
          null,
          { historyId: "10", configVersion: "v2", revision: 1 },
          changed,
        ),
      ).toBe(true);
      await state.lease.release(scope, changed);
      const retry = (await state.lease.acquire(scope))!.fence;
      await expect(
        ledger.apply(
          scope,
          {
            kind: "eligible",
            messageId: "second",
            revision: "10",
            text: "Another synthetic role",
          },
          retry,
        ),
      ).rejects.toThrow();
      await state.lease.release(scope, retry);
      const tenantB = { ...scope, tenantId: "tenant-b" };
      const bFence = (await state.lease.acquire(tenantB))!.fence;
      await ledger.beginFullSync(tenantB, config, bFence);
      await ledger.apply(
        tenantB,
        {
          kind: "eligible",
          messageId: "second",
          revision: "1",
          text: "Tenant B role",
        },
        bFence,
      );
      await ledger.finishFullSync(tenantB, config, bFence);
      await state.lease.release(tenantB, bFence);

      // Force a crash after one retirement and then repeat across more than one query page.
      const scope3 = { ...scope, sourceId: "large" };
      const initial = (await state.lease.acquire(scope3))!.fence;
      await ledger.beginFullSync(scope3, config, initial);
      for (let index = 0; index < 101; index++) {
        await ledger.apply(
          scope3,
          {
            kind: "eligible",
            messageId: `message${index}`,
            revision: "1",
            text: "Shared synthetic role",
          },
          initial,
        );
      }
      await ledger.finishFullSync(scope3, config, initial);
      await state.lease.release(scope3, initial);
      const partial = (await state.lease.acquire(scope3))!.fence;
      await ledger.beginFullSync(scope3, config, partial);
      let failOnce = true;
      const faultClient = new Proxy(client, {
        get(target, property, receiver) {
          if (property !== "send")
            return Reflect.get(target, property, receiver);
          return async (command: unknown, options: unknown) => {
            const result: unknown = await Reflect.apply(target.send, target, [
              command,
              options,
            ]);
            if (
              failOnce &&
              command instanceof TransactWriteCommand &&
              command.input.TransactItems?.some((item) => item.Update)
            ) {
              failOnce = false;
              throw new Error("Synthetic response loss");
            }
            return result;
          };
        },
      }) as DynamoDBDocumentClient;
      const faulty = new GmailLedgerRepository(faultClient, table, objects)
        .ledger;
      await expect(
        faulty.finishFullSync(scope3, config, partial),
      ).rejects.toThrow();
      await state.lease.release(scope3, partial);
      const resumed = (await state.lease.acquire(scope3))!.fence;
      await ledger.beginFullSync(scope3, config, resumed);
      await ledger.finishFullSync(scope3, config, resumed);
      const largeRows = (
        await client.send(
          new QueryCommand({
            TableName: table,
            KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
            ExpressionAttributeValues: {
              ":pk": `gmail#${createHash("sha256")
                .update(JSON.stringify([scope3.tenantId, scope3.connectionId]))
                .digest("hex")}`,
              ":prefix": `ledger#${createHash("sha256").update(scope3.sourceId).digest("hex")}#message#`,
            },
            ConsistentRead: true,
          }),
        )
      ).Items!;
      expect(largeRows).toHaveLength(101);
      expect(largeRows.every((row) => row.active === false)).toBe(true);
      await state.lease.release(scope3, resumed);

      // A seen record with a missing content reference must not be silently accepted.
      const damaged = (await state.lease.acquire(scope3))!.fence;
      await ledger.beginFullSync(scope3, config, damaged);
      await ledger.apply(
        scope3,
        {
          kind: "eligible",
          messageId: "message0",
          revision: "1",
          text: "Shared synthetic role",
        },
        damaged,
      );
      const damagedRow = largeRows.find((row) => row.messageId === "message0")!;
      await client.send(
        new UpdateCommand({
          TableName: table,
          Key: { pk: damagedRow.pk, sk: damagedRow.sk },
          UpdateExpression: "REMOVE #object",
          ExpressionAttributeNames: { "#object": "object" },
        }),
      );
      await expect(
        ledger.finishFullSync(scope3, config, damaged),
      ).rejects.toThrow();
      await state.lease.release(scope3, damaged);
    } finally {
      await admin.send(new DeleteTableCommand({ TableName: table }));
      admin.destroy();
      client.destroy();
      await rm(dir, { recursive: true, force: true });
    }
  }, 60000);
});
