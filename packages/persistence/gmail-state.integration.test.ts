import { randomUUID } from "node:crypto";
import {
  CreateTableCommand,
  DeleteTableCommand,
  DynamoDBClient,
} from "@aws-sdk/client-dynamodb";
import { describe, expect, it } from "vitest";
import { createLocalClient } from "./dynamodb.js";
import { GmailStateRepository } from "./gmail-state.js";

describe("Gmail state with DynamoDB Local", () => {
  it("fences leases and atomically checks checkpoint revisions within each tenant", async () => {
    const endpoint = process.env.ROLERIVER_DYNAMODB_TEST_URL;
    if (process.env.ROLERIVER_DYNAMODB_TEST !== "1" || !endpoint)
      throw new Error("Explicit local test opt-in and endpoint are required");
    const document = createLocalClient(endpoint);
    const admin = new DynamoDBClient({
      endpoint,
      region: "local",
      credentials: { accessKeyId: "dummy", secretAccessKey: "dummy" },
      maxAttempts: 1,
    });
    const table = `roleriver_gmail_${randomUUID().replaceAll("-", "")}`;
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
      const state = new GmailStateRepository(document, table, 30000);
      const a = {
        tenantId: "tenant_a",
        connectionId: "connection",
        sourceId: "source",
      };
      const b = { ...a, tenantId: "tenant_b" };
      const [x, y] = await Promise.all([
        state.lease.acquire(a),
        state.lease.acquire(a),
      ]);
      expect([x, y].filter(Boolean)).toHaveLength(1);
      const fence = (x ?? y)!.fence;
      const one = { historyId: "10", configVersion: "v1", revision: 1 };
      expect(await state.checkpoints.compareAndSet(a, null, one, fence)).toBe(
        true,
      );
      expect(await state.checkpoints.compareAndSet(a, null, one, fence)).toBe(
        false,
      );
      expect(await state.checkpoints.load(a)).toEqual(one);
      expect(await state.checkpoints.load(b)).toBeNull();
      expect(await state.lease.acquire(b)).not.toBeNull();
      await state.lease.release(a, fence);
      const newer = await state.lease.acquire(a);
      expect(newer).not.toBeNull();
      expect(newer!.fence).not.toBe(fence);
      await state.lease.release(a, fence);
      expect(await state.lease.acquire(a)).toBeNull();
      const two = { historyId: "11", configVersion: "v1", revision: 2 };
      expect(await state.checkpoints.compareAndSet(a, 1, two, fence)).toBe(
        false,
      );
      expect(
        await state.checkpoints.compareAndSet(a, 1, two, newer!.fence),
      ).toBe(true);
      expect(await state.checkpoints.load(a)).toEqual(two);
      await expect(
        state.checkpoints.compareAndSet(
          a,
          1,
          { ...two, revision: 3 },
          newer!.fence,
        ),
      ).rejects.toThrow("Invalid checkpoint");
    } finally {
      if (created)
        await admin.send(new DeleteTableCommand({ TableName: table }));
      document.destroy();
      admin.destroy();
    }
  }, 30000);
});
