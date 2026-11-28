import { randomUUID } from "node:crypto";
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
import {
  EncryptedTokenStore,
  type StoredGmailTokens,
} from "../source-gmail/token-store.js";
import {
  GmailRefreshCoordinator,
  GmailConnectionProvisioner,
} from "../source-gmail/refresh.js";
import { createLocalClient } from "./dynamodb.js";
import {
  GmailConnectionRepository,
  gmailConnectionKey,
} from "./gmail-connection.js";
import { GmailDisconnectCoordinator } from "./gmail-disconnect.js";
import { GmailDispatchGate, GmailTokenGate } from "./gmail-dispatch.js";
import { GmailObjectLifecycle } from "./gmail-objects.js";
import { GmailStateRepository } from "./gmail-state.js";
import { LocalObjectStore } from "./object-store.js";
import { LocalTenantBarrier } from "./local-barrier.js";

describe("refresh and disconnect coordination", () => {
  it("never tombstones between refresh token rotation and persistence", async () => {
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
    const table = `refresh_disconnect_${randomUUID().replaceAll("-", "")}`;
    const objectRoot = await mkdtemp(join(tmpdir(), "refresh-objects-"));
    const tenantLockRoot = await mkdtemp(
      join(tmpdir(), "refresh-tenant-lock-"),
    );
    const refreshLockRoot = await mkdtemp(
      join(tmpdir(), "refresh-single-lock-"),
    );
    const tokenRoot = await mkdtemp(join(tmpdir(), "refresh-token-"));
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
      const state = new GmailStateRepository(db, table, 30000);
      const fence = (await state.lease.acquire(scope))!.fence;
      const tenantLock = await LocalTenantBarrier.open(tenantLockRoot);
      const refreshLock = await LocalTenantBarrier.open(refreshLockRoot);
      const barrier = {
        exclusive: async <T>(tenant: string, operation: () => Promise<T>) => {
          const result = await tenantLock.run(tenant, operation);
          if (result.status !== "completed") throw new Error("busy");
          return result.value;
        },
      };
      const gate = new GmailDispatchGate(connections, barrier);
      const tokens = await EncryptedTokenStore.open(
        tokenRoot,
        Buffer.alloc(32, 7),
        new GmailTokenGate(gate),
      );
      await tokens.put(scope.tenantId, scope.connectionId, {
        refreshToken: "old",
        accessToken: "expired",
        expiresAt: 1,
      });
      let beforePut!: () => void;
      let resumePut!: () => void;
      const waiting = new Promise<void>((resolve) => {
        beforePut = resolve;
      });
      const resume = new Promise<void>((resolve) => {
        resumePut = resolve;
      });
      const guardedTokens = {
        get: tokens.get.bind(tokens),
        put: async (
          tenant: string,
          connection: string,
          value: StoredGmailTokens,
        ) => {
          beforePut();
          await resume;
          return tokens.put(tenant, connection, value);
        },
      };
      const refresh = new GmailRefreshCoordinator(
        scope,
        guardedTokens,
        {
          revoke: async () => {},
          refresh: async () =>
            gate.run(scope, async () => ({
              accessToken: "new-access",
              refreshToken: "rotated",
              expiresIn: 3600,
            })),
        },
        refreshLock,
        () => 100000,
      );
      const lifecycle = new GmailObjectLifecycle(
        db,
        table,
        await LocalObjectStore.open(objectRoot),
        barrier,
      );
      const disconnect = new GmailDisconnectCoordinator(
        db,
        table,
        connections,
        barrier,
        lifecycle,
        refreshLock,
      );
      const inFlight = refresh.accessToken(scope);
      await waiting;
      await expect(connections.disconnect(scope)).rejects.toThrow();
      await expect(
        connections.withRefreshLock(refreshLock).disconnect(scope),
      ).rejects.toThrow();
      await expect(disconnect.disconnect(scope, fence)).rejects.toThrow();
      expect((await connections.snapshot(scope))?.status).toBe("connected");
      resumePut();
      expect(await inFlight).toBe("new-access");
      expect(
        (await tokens.get(scope.tenantId, scope.connectionId))?.refreshToken,
      ).toBe("rotated");
      expect(await disconnect.disconnect(scope, fence)).toEqual({
        status: "incomplete",
      });
      const stateItem = (
        await db.send(
          new GetCommand({
            TableName: table,
            Key: gmailConnectionKey(scope),
            ConsistentRead: true,
          }),
        )
      ).Item;
      expect(stateItem).toMatchObject({
        status: "disconnected",
        providerRevocationPending: true,
      });
      await expect(
        tokens.get(scope.tenantId, scope.connectionId),
      ).rejects.toThrow();
      // Synthetic test-only offline inspection verifies the encrypted rotated token remains available for revocation.
      const offline = await EncryptedTokenStore.open(
        tokenRoot,
        Buffer.alloc(32, 7),
        { run: async (_tenant, _connection, operation) => operation() },
      );
      expect(
        (await offline.get(scope.tenantId, scope.connectionId))?.refreshToken,
      ).toBe("rotated");
      const initialScope = { ...scope, connectionId: "initial" };
      await connections.initialize(initialScope);
      const initialFence = (await state.lease.acquire(initialScope))!.fence;
      let issued!: () => void;
      let persist!: () => void;
      const issuanceWaiting = new Promise<void>((resolve) => {
        issued = resolve;
      });
      const issuanceResume = new Promise<void>((resolve) => {
        persist = resolve;
      });
      const initialTokens = {
        get: tokens.get.bind(tokens),
        put: async (
          tenant: string,
          connection: string,
          value: StoredGmailTokens,
        ) => {
          issued();
          await issuanceResume;
          await tokens.put(tenant, connection, value);
        },
      };
      const provisioner = new GmailConnectionProvisioner(
        initialScope,
        initialTokens,
        {
          revoke: async () => {},
          complete: async () =>
            gate.run(initialScope, async () => ({
              accessToken: "initial-access",
              refreshToken: "initial-refresh",
              expiresIn: 3600,
            })),
        },
        refreshLock,
        () => 100000,
      );
      const issuance = provisioner.complete("synthetic-callback");
      await issuanceWaiting;
      await expect(
        disconnect.disconnect(initialScope, initialFence),
      ).rejects.toThrow();
      expect((await connections.snapshot(initialScope))?.status).toBe(
        "connected",
      );
      persist();
      await issuance;
      expect(
        (await tokens.get(initialScope.tenantId, initialScope.connectionId))
          ?.refreshToken,
      ).toBe("initial-refresh");
      expect(await disconnect.disconnect(initialScope, initialFence)).toEqual({
        status: "incomplete",
      });
    } finally {
      if (created)
        await admin.send(new DeleteTableCommand({ TableName: table }));
      db.destroy();
      admin.destroy();
      await Promise.all(
        [objectRoot, tenantLockRoot, refreshLockRoot, tokenRoot].map((path) =>
          rm(path, { recursive: true, force: true }),
        ),
      );
    }
  }, 30000);
});
