import { GmailConnectionRepository } from "./gmail-connection.js";
import { randomUUID } from "node:crypto";
import {
  CreateTableCommand,
  DeleteTableCommand,
  DynamoDBClient,
} from "@aws-sdk/client-dynamodb";
import { describe, expect, it } from "vitest";
import { createLocalClient } from "./dynamodb.js";
import { GmailConfigRepository } from "./gmail-config.js";
import { GmailStateRepository } from "./gmail-state.js";

describe("Gmail configuration version claims", () => {
  it("persists immutable, scoped claims across retries, versions and concurrent writers", async () => {
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
    const table = `gmail_config_${randomUUID().replaceAll("-", "")}`;
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
      const config = {
        version: "v1",
        query: "from:alerts@example.test",
        labelIds: ["b", "a", "a"],
      };
      const repo = new GmailConfigRepository(client, table);
      const state = new GmailStateRepository(client, table, 30000);
      await new GmailConnectionRepository(client, table).initialize(scope);
      const fence = (await state.lease.acquire(scope))!.fence;
      expect(await repo.hasClaim(scope, "v1", fence)).toBe(false);
      const [first, retry] = await Promise.all([
        repo.claim(scope, config, fence),
        repo.claim(scope, { ...config, labelIds: ["a", "b"] }, fence),
      ]);
      expect([first.status, retry.status].sort()).toEqual([
        "created",
        "existing",
      ]);
      expect(await repo.hasClaim(scope, "v1", fence)).toBe(true);
      const restarted = new GmailConfigRepository(client, table);
      expect(
        (
          await restarted.claim(
            scope,
            {
              ...config,
              version: "v2",
              query: "new",
            },
            fence,
          )
        ).status,
      ).toBe("created");
      expect(
        (await restarted.claim(scope, { ...config, query: "changed" }, fence))
          .status,
      ).toBe("conflict");
      expect(
        (await restarted.claim(scope, { ...config, labelIds: ["a"] }, fence))
          .status,
      ).toBe("conflict");
      for (const other of [
        { ...scope, tenantId: "other" },
        { ...scope, connectionId: "other" },
        { ...scope, sourceId: "other" },
      ]) {
        if (
          other.tenantId !== scope.tenantId ||
          other.connectionId !== scope.connectionId
        )
          await new GmailConnectionRepository(client, table).initialize(other);
        const otherFence =
          other.tenantId === scope.tenantId &&
          other.connectionId === scope.connectionId
            ? fence
            : (await state.lease.acquire(other))!.fence;
        expect(
          (
            await restarted.claim(
              other,
              { ...config, query: "changed" },
              otherFence,
            )
          ).status,
        ).toBe("created");
      }
      const racingScope = { ...scope, sourceId: "race" };
      const race = await Promise.all([
        repo.claim(racingScope, config, fence),
        repo.claim(racingScope, { ...config, query: "different" }, fence),
      ]);
      expect(race.map((item) => item.status).sort()).toEqual([
        "conflict",
        "created",
      ]);
      await expect(
        repo.claim(scope, { ...config, query: "\ud800" }, fence),
      ).rejects.toThrow();
      await state.lease.release(scope, fence);
      await expect(repo.hasClaim(scope, "v1", fence)).rejects.toThrow();
      await expect(repo.claim(scope, config, fence)).rejects.toThrow();
      await expect(
        repo.claim(scope, { ...config, version: "expired" }, fence),
      ).rejects.toThrow();
      const fresh = (await state.lease.acquire(scope))!.fence;
      await expect(
        repo.claim(scope, { ...config, version: "stale" }, fence),
      ).rejects.toThrow();
      await expect(repo.claim(scope, config, fence)).rejects.toThrow();
      expect(
        (await repo.claim(scope, { ...config, version: "stale" }, fresh))
          .status,
      ).toBe("created");
    } finally {
      if (created)
        await admin.send(new DeleteTableCommand({ TableName: table }));
      client.destroy();
      admin.destroy();
    }
  }, 30000);
});
