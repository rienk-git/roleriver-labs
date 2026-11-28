import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CreateTableCommand,
  DeleteTableCommand,
  DynamoDBClient,
} from "@aws-sdk/client-dynamodb";
import { UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { describe, expect, it, vi } from "vitest";
import { EncryptedTokenStore } from "../source-gmail/token-store.js";
import {
  createSourcePolicyGate,
  InMemoryRateLimiter,
} from "../source-policy/policy.js";
import { createLocalClient } from "./dynamodb.js";
import {
  GmailConnectionRepository,
  gmailConnectionKey,
} from "./gmail-connection.js";
import {
  GmailDispatchGate,
  GmailDisconnectedTokenGate,
  GmailTokenGate,
} from "./gmail-dispatch.js";
import {
  bindGmailRevocation,
  GmailRevocationCoordinator,
} from "./gmail-revocation.js";
import { LocalTenantBarrier } from "./local-barrier.js";

describe("disconnected Gmail provider revocation", () => {
  it("retains tokens on denied/failed revocation and resumes deletion after a lost marker response", async () => {
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
    const table = `revocation_${randomUUID().replaceAll("-", "")}`;
    const tenantRoot = await mkdtemp(join(tmpdir(), "revoke-tenant-"));
    const refreshRoot = await mkdtemp(join(tmpdir(), "revoke-refresh-"));
    const tokenRoot = await mkdtemp(join(tmpdir(), "revoke-token-"));
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
        sourceId: "gmail",
      };
      const connections = new GmailConnectionRepository(db, table);
      await connections.initialize(scope);
      const tenantLock = await LocalTenantBarrier.open(tenantRoot);
      const refreshLock = await LocalTenantBarrier.open(refreshRoot);
      const barrier = {
        exclusive: async <T>(tenant: string, operation: () => Promise<T>) => {
          const result = await tenantLock.run(tenant, operation);
          if (result.status !== "completed") throw new Error("busy");
          return result.value;
        },
      };
      let currentPolicy = { sources: [] } as unknown;
      const policy = createSourcePolicyGate(
        () => currentPolicy,
        () => new Date("2026-11-27"),
        new InMemoryRateLimiter(),
      );
      let status = 500;
      const fetcher = vi.fn<typeof fetch>(
        async () => new Response(null, { status }),
      );
      const gate = new GmailDisconnectedTokenGate(connections, barrier);
      let loseResponse = true;
      const faultConnections = new Proxy(connections, {
        get(target, property, receiver) {
          if (property !== "markProviderRevoked")
            return Reflect.get(target, property, receiver);
          return async (value: typeof scope) => {
            await target.markProviderRevoked(value);
            if (loseResponse) {
              loseResponse = false;
              throw new Error("synthetic lost response");
            }
          };
        },
      });
      const tokens = await EncryptedTokenStore.open(
        tokenRoot,
        Buffer.alloc(32, 7),
        new GmailTokenGate(new GmailDispatchGate(connections, barrier)),
        bindGmailRevocation(scope, faultConnections, gate, policy, fetcher),
      );
      await tokens.put(scope.tenantId, scope.connectionId, {
        refreshToken: "synthetic-secret",
      });
      await connections.markIssuanceStarted(scope);
      await connections.withRefreshLock(refreshLock).disconnect(scope);
      const coordinator = new GmailRevocationCoordinator(tokens, refreshLock);
      await expect(coordinator.revoke(scope)).rejects.toThrow(
        "Gmail revocation failed",
      );
      expect(fetcher).not.toHaveBeenCalled();
      currentPolicy = {
        sources: [
          {
            id: "gmail",
            methods: {
              email: {
                enabled: true,
                evidence: "synthetic",
                reviewedOn: "2026-11-01",
                expiresOn: "2026-12-31",
                allowedHosts: ["oauth2.googleapis.com"],
                rateLimit: { requests: 10, windowMs: 60000 },
              },
            },
          },
        ],
      };
      await expect(coordinator.revoke(scope)).rejects.not.toThrow(
        "synthetic-secret",
      );
      expect(await connections.revocationState(scope)).toBe("pending");
      expect(await readdir(tokenRoot)).toHaveLength(1);
      status = 200;
      await expect(coordinator.revoke(scope)).rejects.toThrow();
      expect(await connections.revocationState(scope)).toBe("revoked");
      expect(await readdir(tokenRoot)).toHaveLength(1);
      await coordinator.revoke(scope);
      expect(await connections.revocationState(scope)).toBe("complete");
      expect(await readdir(tokenRoot)).toHaveLength(0);
      expect(fetcher).toHaveBeenCalledTimes(2);
      expect(fetcher.mock.calls[1]?.[0]).toBe(
        "https://oauth2.googleapis.com/revoke",
      );
      expect(fetcher.mock.calls[1]?.[1]).toMatchObject({
        redirect: "error",
        method: "POST",
      });
      await coordinator.revoke(scope);
      expect(fetcher).toHaveBeenCalledTimes(2);
      for (const [connectionId, started] of [
        ["never", false],
        ["ambiguous", true],
        ["legacy", "legacy"],
      ] as const) {
        const other = { ...scope, connectionId };
        await connections.initialize(other);
        if (started === true) await connections.markIssuanceStarted(other);
        if (started === "legacy")
          await db.send(
            new UpdateCommand({
              TableName: table,
              Key: gmailConnectionKey(other),
              UpdateExpression: "REMOVE issuanceState",
            }),
          );
        await connections.withRefreshLock(refreshLock).disconnect(other);
        const otherTokens = await EncryptedTokenStore.open(
          tokenRoot,
          Buffer.alloc(32, 7),
          new GmailTokenGate(new GmailDispatchGate(connections, barrier)),
          bindGmailRevocation(other, connections, gate, policy, fetcher),
        );
        const otherCoordinator = new GmailRevocationCoordinator(
          otherTokens,
          refreshLock,
        );
        if (started !== false) {
          await expect(otherCoordinator.revoke(other)).rejects.toThrow();
          expect(await connections.revocationState(other)).toBe("pending");
        } else {
          await otherCoordinator.revoke(other);
          expect(await connections.revocationState(other)).toBe("complete");
        }
      }
      expect(fetcher).toHaveBeenCalledTimes(2);
    } finally {
      if (created)
        await admin.send(new DeleteTableCommand({ TableName: table }));
      db.destroy();
      admin.destroy();
      await Promise.all(
        [tenantRoot, refreshRoot, tokenRoot].map((path) =>
          rm(path, { recursive: true, force: true }),
        ),
      );
    }
  }, 30000);
});
