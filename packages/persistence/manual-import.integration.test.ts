import { randomUUID } from "node:crypto";
import {
  CreateTableCommand,
  DeleteTableCommand,
  DynamoDBClient,
} from "@aws-sdk/client-dynamodb";
import { describe, expect, it } from "vitest";
import { createLocalClient } from "./dynamodb.js";
import { ManualImportRepository } from "./manual-import.js";

const endpoint = process.env.ROLERIVER_DYNAMODB_TEST_URL;
const enabled = process.env.ROLERIVER_DYNAMODB_TEST === "1";

describe("manual import persistence with DynamoDB Local", () => {
  it("persists tenant-bound content references idempotently and rejects conflicting changes", async () => {
    if (!enabled || !endpoint)
      throw new Error("Explicit local test opt-in and endpoint are required");
    const document = createLocalClient(endpoint);
    const admin = new DynamoDBClient({
      endpoint,
      region: "local",
      credentials: { accessKeyId: "dummy", secretAccessKey: "dummy" },
      maxAttempts: 1,
    });
    const table = `roleriver_manual_${randomUUID().replaceAll("-", "")}`;
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
      const repo = new ManualImportRepository(document, table);
      const record = {
        tenantId: "tenant-a",
        vacancyId: "vacancy-a",
        sourceId: "manual",
        externalId: "ref-a",
        completeness: "partial" as const,
        origin: "manual" as const,
        externalProcessing: "not_authorized" as const,
        sourceUrl: "https://example.test/job/1",
        object: { id: "a".repeat(64), size: 42, sha256: "a".repeat(64) },
      };
      const [first, concurrent] = await Promise.all([
        repo.commit(record),
        repo.commit(record),
      ]);
      expect([first.status, concurrent.status].sort()).toEqual([
        "created",
        "duplicate",
      ]);
      expect(await repo.get("tenant-a", "manual", "ref-a")).toEqual(record);
      expect(await repo.get("tenant-b", "manual", "ref-a")).toBeNull();
      expect(
        (await repo.commit({ ...record, tenantId: "tenant-b" })).status,
      ).toBe("created");
      expect(
        (
          await repo.commit({
            ...record,
            object: {
              ...record.object,
              id: "b".repeat(64),
              sha256: "b".repeat(64),
            },
          })
        ).status,
      ).toBe("conflict");
      expect(
        (await repo.commit({ ...record, completeness: "full" })).status,
      ).toBe("conflict");
      expect((await repo.commit(record)).status).toBe("duplicate");
      await expect(
        repo.commit({
          ...record,
          sourceUrl: "https://example.test/job?token=synthetic-secret",
        }),
      ).rejects.not.toThrow("synthetic-secret");
    } finally {
      await admin.send(new DeleteTableCommand({ TableName: table }));
      document.destroy();
      admin.destroy();
    }
  }, 30000);
});
