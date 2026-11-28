import {
  GmailConnectionRepository,
  gmailConnectionKey,
} from "./gmail-connection.js";
import { randomUUID } from "node:crypto";
import {
  CreateTableCommand,
  DeleteTableCommand,
  DynamoDBClient,
} from "@aws-sdk/client-dynamodb";
import { describe, expect, it } from "vitest";
import { createLocalClient } from "./dynamodb.js";
import { GmailStateRepository } from "./gmail-state.js";
import { GmailAttemptRepository } from "./gmail-attempt.js";

const testRefreshLock = {
  run: async <T>(_key: string, operation: () => Promise<T>) => ({
    status: "completed" as const,
    value: await operation(),
  }),
};

describe("Gmail sync attempt visibility", () => {
  it("atomically publishes checkpoints and rejects incomplete, stale and overlapping reads", async () => {
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
    const table = `attempt_${randomUUID().replaceAll("-", "")}`;
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
      const state = new GmailStateRepository(db, table, 30000);
      expect(() =>
        gmailConnectionKey({ ...scope, tenantId: 42 as unknown as string }),
      ).toThrow();
      expect(() =>
        gmailConnectionKey({
          ...scope,
          connectionId: null as unknown as string,
        }),
      ).toThrow();
      const attempts = new GmailAttemptRepository(db, table);
      await new GmailConnectionRepository(db, table).initialize(scope);
      const a = (await state.lease.acquire(scope))!.fence;
      expect(await attempts.read(scope, async () => "partial")).toEqual({
        status: "unavailable",
      });
      await attempts.begin(scope, a, "full");
      expect(await attempts.read(scope, async () => "partial")).toEqual({
        status: "unavailable",
      });
      expect(
        await attempts.publish(scope, a, null, {
          historyId: "10",
          configVersion: "v1",
          revision: 1,
        }),
      ).toBe(true);
      expect(await state.checkpoints.load(scope)).toEqual({
        historyId: "10",
        configVersion: "v1",
        revision: 1,
      });
      expect(await attempts.read(scope, async () => "ready")).toEqual({
        status: "ready",
        value: "ready",
      });
      await state.lease.release(scope, a);
      const b = (await state.lease.acquire(scope))!.fence;
      await expect(attempts.begin(scope, a, "incremental")).rejects.toThrow();
      const overlapping = await attempts.read(scope, async () => {
        await attempts.begin(scope, b, "incremental");
        return "partial";
      });
      expect(overlapping).toEqual({ status: "unavailable" });
      // Expired Gmail history can promote the same attempt to a full rescan.
      await attempts.begin(scope, b, "full");
      await expect(attempts.begin(scope, b, "incremental")).rejects.toThrow();
      expect(
        await attempts.publish(scope, b, null, {
          historyId: "11",
          configVersion: "v1",
          revision: 1,
        }),
      ).toBe(false);
      expect(await state.checkpoints.load(scope)).toEqual({
        historyId: "10",
        configVersion: "v1",
        revision: 1,
      });
      expect(await attempts.read(scope, async () => "partial")).toEqual({
        status: "unavailable",
      });
      expect(
        await attempts.publish(scope, b, 1, {
          historyId: "11",
          configVersion: "v1",
          revision: 2,
        }),
      ).toBe(true);
      expect(await attempts.read(scope, async () => "ready2")).toEqual({
        status: "ready",
        value: "ready2",
      });
      await state.lease.release(scope, b);
      const c = (await state.lease.acquire(scope))!.fence;
      await attempts.begin(scope, c, "incremental");
      await expect(
        attempts.publish(scope, b, 2, {
          historyId: "12",
          configVersion: "v1",
          revision: 3,
        }),
      ).resolves.toBe(false);
      expect(await attempts.read(scope, async () => "partial")).toEqual({
        status: "unavailable",
      });
      await state.lease.release(scope, c);
      const d = (await state.lease.acquire(scope))!.fence;
      await expect(attempts.begin(scope, d, "incremental")).rejects.toThrow();
      await attempts.begin(scope, d, "full");
      expect(await attempts.read(scope, async () => "partial")).toEqual({
        status: "unavailable",
      });
      await new GmailConnectionRepository(
        db,
        table,
        testRefreshLock,
      ).disconnect(scope);
      await new GmailConnectionRepository(
        db,
        table,
        testRefreshLock,
      ).disconnect(scope);
      await expect(attempts.begin(scope, d, "full")).rejects.toThrow();
      expect(await attempts.read(scope, async () => "private")).toEqual({
        status: "unavailable",
      });
      await expect(
        new GmailConnectionRepository(db, table).initialize(scope),
      ).rejects.toThrow();
      const overlapScope = { ...scope, connectionId: "overlap" };
      const connection = new GmailConnectionRepository(db, table);
      await connection.initialize(overlapScope);
      const overlapFence = (await state.lease.acquire(overlapScope))!.fence;
      await attempts.begin(overlapScope, overlapFence, "full");
      expect(
        await attempts.publish(overlapScope, overlapFence, null, {
          historyId: "1",
          configVersion: "v1",
          revision: 1,
        }),
      ).toBe(true);
      expect(
        await attempts.read(overlapScope, async () => {
          await connection
            .withRefreshLock(testRefreshLock)
            .disconnect(overlapScope);
          return "private";
        }),
      ).toEqual({ status: "unavailable" });
    } finally {
      if (created)
        await admin.send(new DeleteTableCommand({ TableName: table }));
      db.destroy();
      admin.destroy();
    }
  }, 30000);
});
