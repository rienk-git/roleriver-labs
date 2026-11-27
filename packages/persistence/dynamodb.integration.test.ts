import { createHash, randomUUID } from "node:crypto";
import {
  DynamoDBClient,
  CreateTableCommand,
  DeleteTableCommand,
} from "@aws-sdk/client-dynamodb";
import { describe, expect, it } from "vitest";
import {
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
  type DynamoDBDocumentClient,
} from "@aws-sdk/lib-dynamodb";
import { createLocalClient, VacancyRepository } from "./dynamodb.js";

/** Simulate a transport failure after DynamoDB committed a transaction. */
function loseFirstTransactionResponse(
  client: DynamoDBDocumentClient,
): DynamoDBDocumentClient {
  let lose = true;
  return new Proxy(client, {
    get(target, property, receiver) {
      if (property !== "send") return Reflect.get(target, property, receiver);
      return async (command: unknown, options: unknown) => {
        const result: unknown = await Reflect.apply(target.send, target, [
          command,
          options,
        ]);
        if (lose && command instanceof TransactWriteCommand) {
          lose = false;
          throw new Error("synthetic lost response");
        }
        return result;
      };
    },
  });
}

const endpoint = process.env.ROLERIVER_DYNAMODB_TEST_URL;
const enabled = process.env.ROLERIVER_DYNAMODB_TEST === "1";

describe("DynamoDB Local integration", () => {
  it("isolates tenants, deduplicates sources, protects versions and paginates", async () => {
    if (!enabled || !endpoint)
      throw new Error("Explicit local test opt-in and endpoint are required");
    const client = createLocalClient(endpoint);
    const admin = new DynamoDBClient({
      endpoint,
      region: "local",
      credentials: { accessKeyId: "dummy", secretAccessKey: "dummy" },
      maxAttempts: 1,
    });
    const table = `roleriver_test_${randomUUID().replaceAll("-", "")}`;
    try {
      await admin.send(
        new CreateTableCommand({
          TableName: table,
          BillingMode: "PAY_PER_REQUEST",
          AttributeDefinitions: [
            { AttributeName: "pk", AttributeType: "S" },
            { AttributeName: "sk", AttributeType: "S" },
            { AttributeName: "gsi1pk", AttributeType: "S" },
            { AttributeName: "gsi1sk", AttributeType: "S" },
          ],
          KeySchema: [
            { AttributeName: "pk", KeyType: "HASH" },
            { AttributeName: "sk", KeyType: "RANGE" },
          ],
          GlobalSecondaryIndexes: [
            {
              IndexName: "gsi1",
              KeySchema: [
                { AttributeName: "gsi1pk", KeyType: "HASH" },
                { AttributeName: "gsi1sk", KeyType: "RANGE" },
              ],
              Projection: { ProjectionType: "ALL" },
            },
          ],
        }),
      );
      const repo = new VacancyRepository(
        client,
        table,
        "test-cursor-signing-key-32-bytes-long",
      );
      const base = {
        id: "vacancy-1",
        title: "Synthetic role",
        organization: "Example",
        createdAt: "2026-01-01T12:00:00.000Z",
        source: "feed",
        externalId: "requisition-1",
        sourceUrl: "https://employer.example/jobs/requisition-1",
      };
      const first = await repo.create("tenant-a", base);
      expect(first.status).toBe("created");
      expect((await repo.create("tenant-a", base)).status).toBe("duplicate");
      expect(
        (await repo.create("tenant-a", { ...base, id: "vacancy-2" })).status,
      ).toBe("conflict");
      expect(
        (await repo.create("tenant-a", { ...base, title: "Changed" })).status,
      ).toBe("conflict");
      expect(
        (await repo.attachSource("tenant-a", "missing", "feed", "new-id"))
          .status,
      ).toBe("not_found");
      expect(
        (
          await repo.attachSource("tenant-a", base.id, "feed", "another-id", {
            url: "https://recruiter.example/jobs/another-id",
          })
        ).status,
      ).toBe("attached");
      expect(
        (
          await repo.attachSource("tenant-a", base.id, "feed", "another-id", {
            url: "https://recruiter.example/jobs/another-id",
          })
        ).status,
      ).toBe("duplicate");
      expect(
        (await repo.attachSource("tenant-a", "missing", "feed", "another-id"))
          .status,
      ).toBe("not_found");
      await repo.create("tenant-a", {
        ...base,
        id: "another-vacancy",
        externalId: "other-requisition",
      });
      expect(
        (
          await repo.attachSource(
            "tenant-a",
            "another-vacancy",
            "feed",
            "another-id",
          )
        ).status,
      ).toBe("conflict");
      expect(
        (await repo.attachSource("tenant-b", base.id, "feed", "another-id"))
          .status,
      ).toBe("not_found");
      expect(
        (
          await repo.attachSource("tenant-a", base.id, "feed", "another-id", {
            url: "https://different.example/job",
          })
        ).status,
      ).toBe("conflict");
      expect(
        (
          await repo.create("tenant-a", {
            ...base,
            sourceUrl: "https://different.example/job",
          })
        ).status,
      ).toBe("conflict");
      const attachmentRace = await Promise.allSettled([
        repo.attachSource("tenant-a", base.id, "feed", "race-source"),
        repo.attachSource("tenant-a", "another-vacancy", "feed", "race-source"),
      ]);
      expect(
        attachmentRace.filter(
          (result) =>
            result.status === "fulfilled" && result.value.status === "attached",
        ),
      ).toHaveLength(1);
      const sourceOwner = await repo.findBySource(
        "tenant-a",
        "feed",
        "race-source",
      );
      expect([base.id, "another-vacancy"]).toContain(sourceOwner?.id);
      const sourcesPage = await repo.listSources("tenant-a", base.id, {
        limit: 1,
      });
      expect(sourcesPage.items).toHaveLength(1);
      expect(sourcesPage.items[0]?.source).toBe("feed");
      expect(["requisition-1", "another-id", "race-source"]).toContain(
        sourcesPage.items[0]?.externalId,
      );
      expect(sourcesPage.cursor).toBeTruthy();
      const allSources = [...sourcesPage.items];
      let nextSourceCursor = sourcesPage.cursor;
      while (nextSourceCursor) {
        const nextPage = await repo.listSources("tenant-a", base.id, {
          limit: 1,
          cursor: nextSourceCursor,
        });
        allSources.push(...nextPage.items);
        nextSourceCursor = nextPage.cursor;
      }
      expect(allSources).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            source: "feed",
            externalId: "requisition-1",
            url: "https://employer.example/jobs/requisition-1",
          }),
          expect.objectContaining({
            source: "feed",
            externalId: "another-id",
            url: "https://recruiter.example/jobs/another-id",
          }),
        ]),
      );
      const tenantDigest = createHash("sha256")
        .update("tenant-a")
        .digest("hex");
      const rawPartition = await client.send(
        new QueryCommand({
          TableName: table,
          KeyConditionExpression: "#pk = :pk",
          ExpressionAttributeNames: { "#pk": "pk" },
          ExpressionAttributeValues: {
            ":pk": `$roleriver#tenant_${tenantDigest}`,
          },
          ConsistentRead: true,
        }),
      );
      const legacyInput = {
        ...base,
        id: "legacy",
        externalId: "legacy-external",
      };
      await repo.create("tenant-a", legacyInput);
      const afterLegacy = await client.send(
        new QueryCommand({
          TableName: table,
          KeyConditionExpression: "#pk = :pk",
          ExpressionAttributeNames: { "#pk": "pk" },
          ExpressionAttributeValues: {
            ":pk": `$roleriver#tenant_${tenantDigest}`,
          },
          ConsistentRead: true,
        }),
      );
      const legacyRecord = (afterLegacy.Items ?? []).find(
        (item) => item.__edb_e__ === "provenance" && item.id === "legacy",
      );
      expect(legacyRecord).toBeDefined();
      await client.send(
        new UpdateCommand({
          TableName: table,
          Key: { pk: legacyRecord!.pk, sk: legacyRecord!.sk },
          UpdateExpression: "REMOVE #externalId",
          ExpressionAttributeNames: { "#externalId": "externalId" },
        }),
      );
      await expect(
        repo.listSources("tenant-a", "legacy", { limit: 10 }),
      ).rejects.toThrow("requires migration");
      await expect(repo.create("tenant-a", legacyInput)).rejects.toThrow(
        "requires migration",
      );
      await expect(
        repo.findBySource("tenant-a", "feed", "legacy-external"),
      ).rejects.toThrow("requires migration");
      const sourceClaims = (rawPartition.Items ?? []).filter(
        (item) => item.__edb_e__ === "sourceclaim",
      );
      expect(sourceClaims.length).toBeGreaterThan(0);
      expect(JSON.stringify(sourceClaims)).not.toContain("requisition-1");
      expect(JSON.stringify(sourceClaims)).not.toContain(
        "https://employer.example",
      );
      await expect(
        repo.listRecent("tenant-a", { limit: 1, cursor: sourcesPage.cursor! }),
      ).rejects.toThrow();
      await expect(
        repo.listSources("tenant-a", "another-vacancy", {
          limit: 1,
          cursor: sourcesPage.cursor!,
        }),
      ).rejects.toThrow();
      await expect(
        repo.listSources("tenant-b", base.id, {
          limit: 1,
          cursor: sourcesPage.cursor!,
        }),
      ).rejects.toThrow();
      expect(
        (
          await repo.listSources("tenant-a", base.id, {
            limit: 1,
            cursor: sourcesPage.cursor!,
          })
        ).items,
      ).toHaveLength(1);
      expect((await repo.create("tenant-b", base)).status).toBe("created");
      expect(await repo.get("tenant-c", base.id)).toBeNull();
      expect(await repo.getVersion("tenant-c", base.id, 1)).toBeNull();
      expect(
        (
          await repo.replace("tenant-c", base.id, 1, {
            title: "No access",
            organization: "Example",
          })
        ).status,
      ).toBe("conflict");
      expect(
        (await repo.findBySource("tenant-a", "feed", "requisition-1"))?.id,
      ).toBe(base.id);
      expect(
        (
          await repo.replace("tenant-a", base.id, 1, {
            title: "Updated role",
            organization: "Example",
          })
        ).status,
      ).toBe("updated");
      expect(
        (
          await repo.replace("tenant-a", base.id, 1, {
            title: "Stale",
            organization: "Example",
          })
        ).status,
      ).toBe("conflict");
      expect((await repo.getVersion("tenant-a", base.id, 1))?.title).toBe(
        "Synthetic role",
      );
      await repo.create("tenant-a", {
        ...base,
        id: "vacancy-3",
        externalId: "requisition-3",
        createdAt: "2026-01-02T12:00:00.000Z",
      });
      expect(
        (
          await repo.create("tenant-a", {
            ...base,
            id: "Case",
            externalId: "upper",
          })
        ).status,
      ).toBe("created");
      expect(
        (
          await repo.create("tenant-a", {
            ...base,
            id: "case",
            externalId: "lower",
          })
        ).status,
      ).toBe("created");
      expect((await repo.get("tenant-a", "Case"))?.id).toBe("Case");
      expect((await repo.get("tenant-a", "case"))?.id).toBe("case");
      const concurrentA = {
        ...base,
        id: "race-a",
        externalId: "same-external-id",
      };
      const concurrentB = {
        ...base,
        id: "race-b",
        externalId: "same-external-id",
      };
      const race = await Promise.allSettled([
        repo.create("tenant-a", concurrentA),
        repo.create("tenant-a", concurrentB),
      ]);
      expect(
        race.filter(
          (result) =>
            result.status === "fulfilled" && result.value.status === "created",
        ),
      ).toHaveLength(1);
      const winner = await repo.findBySource(
        "tenant-a",
        "feed",
        "same-external-id",
      );
      expect(["race-a", "race-b"]).toContain(winner?.id);
      const loser = winner?.id === "race-a" ? concurrentB : concurrentA;
      expect((await repo.create("tenant-a", loser)).status).toBe("conflict");
      const edits = await Promise.allSettled([
        repo.replace("tenant-a", base.id, 2, {
          title: "Version A",
          organization: "Example",
        }),
        repo.replace("tenant-a", base.id, 2, {
          title: "Version B",
          organization: "Example",
        }),
      ]);
      expect(
        edits.filter(
          (result) =>
            result.status === "fulfilled" && result.value.status === "updated",
        ),
      ).toHaveLength(1);
      expect((await repo.get("tenant-a", base.id))?.version).toBe(3);
      expect((await repo.getVersion("tenant-a", base.id, 3))?.version).toBe(3);
      const lostCreate = new VacancyRepository(
        loseFirstTransactionResponse(client),
        table,
        "test-cursor-signing-key-32-bytes-long",
      );
      const retryInput = {
        ...base,
        id: "lost-create",
        externalId: "lost-create-source",
      };
      await expect(lostCreate.create("tenant-a", retryInput)).rejects.toThrow(
        "Persistence operation failed",
      );
      expect((await lostCreate.create("tenant-a", retryInput)).status).toBe(
        "duplicate",
      );
      const lostAttach = new VacancyRepository(
        loseFirstTransactionResponse(client),
        table,
        "test-cursor-signing-key-32-bytes-long",
      );
      await expect(
        lostAttach.attachSource(
          "tenant-a",
          "lost-create",
          "feed",
          "lost-attach-source",
        ),
      ).rejects.toThrow("Persistence operation failed");
      expect(
        (
          await lostAttach.attachSource(
            "tenant-a",
            "lost-create",
            "feed",
            "lost-attach-source",
          )
        ).status,
      ).toBe("duplicate");
      const lostReplace = new VacancyRepository(
        loseFirstTransactionResponse(client),
        table,
        "test-cursor-signing-key-32-bytes-long",
      );
      await expect(
        lostReplace.replace("tenant-a", "lost-create", 1, {
          title: "Saved before response loss",
          organization: "Example",
        }),
      ).rejects.toThrow("Persistence operation failed");
      expect(
        (
          await lostReplace.replace("tenant-a", "lost-create", 1, {
            title: "Saved before response loss",
            organization: "Example",
          })
        ).status,
      ).toBe("conflict");
      expect(
        (await lostReplace.getVersion("tenant-a", "lost-create", 2))?.title,
      ).toBe("Saved before response loss");
      const page = await repo.listRecent("tenant-a", { limit: 1 });
      expect(page.items).toHaveLength(1);
      expect(page.cursor).toBeTruthy();
      await expect(
        repo.listRecent("tenant-b", { limit: 1, cursor: page.cursor! }),
      ).rejects.toThrow();
      await expect(
        repo.listRecent("tenant-a", { limit: 1, cursor: page.cursor! + "x" }),
      ).rejects.toThrow();
      expect(
        (await repo.listRecent("tenant-a", { limit: 1, cursor: page.cursor! }))
          .items,
      ).toHaveLength(1);
    } finally {
      await admin.send(new DeleteTableCommand({ TableName: table }));
      admin.destroy();
      client.destroy();
    }
  }, 30000);
});
