import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CreateTableCommand,
  DeleteTableCommand,
  DynamoDBClient,
} from "@aws-sdk/client-dynamodb";
import { GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { describe, expect, it } from "vitest";
import { pollGmail, type PollDependencies } from "../source-gmail/poll.js";
import { EncryptedTokenStore } from "../source-gmail/token-store.js";
import { createLocalClient } from "./dynamodb.js";
import { GmailAttemptRepository } from "./gmail-attempt.js";
import { GmailConfigRepository } from "./gmail-config.js";
import {
  GmailConnectionRepository,
  gmailConnectionKey,
} from "./gmail-connection.js";
import { GmailDisconnectCoordinator } from "./gmail-disconnect.js";
import { GmailDispatchGate, GmailTokenGate } from "./gmail-dispatch.js";
import { GmailLedgerRepository } from "./gmail-ledger.js";
import { GmailObjectLifecycle } from "./gmail-objects.js";
import { GmailStateRepository } from "./gmail-state.js";
import { LocalObjectStore } from "./object-store.js";
import { LocalTenantBarrier } from "./local-barrier.js";

describe("Gmail disconnect flow with DynamoDB Local", () => {
  it("blocks new dispatch, drains in-flight work, preserves token for revocation and purges known sources", async () => {
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
    const table = `disconnect_${randomUUID().replaceAll("-", "")}`;
    const root = await mkdtemp(join(tmpdir(), "gmail-disconnect-"));
    const lockRoot = await mkdtemp(join(tmpdir(), "gmail-disconnect-lock-"));
    const tokenRoot = await mkdtemp(join(tmpdir(), "gmail-disconnect-token-"));
    const refreshRoot = await mkdtemp(
      join(tmpdir(), "gmail-disconnect-refresh-"),
    );
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
      const localBarrier = await LocalTenantBarrier.open(lockRoot);
      const refreshLock = await LocalTenantBarrier.open(refreshRoot);
      const barrier = {
        exclusive: async <T>(
          tenant: string,
          task: () => Promise<T>,
        ): Promise<T> => {
          const result = await localBarrier.run(tenant, task);
          if (result.status === "busy") throw new Error("busy");
          return result.value;
        },
      };
      const state = new GmailStateRepository(db, table, 30000);
      const attempts = new GmailAttemptRepository(db, table);
      const claims = new GmailConfigRepository(db, table);
      const connections = new GmailConnectionRepository(db, table);
      const lifecycle = new GmailObjectLifecycle(db, table, objects, barrier);
      const ledger = new GmailLedgerRepository(db, table, lifecycle);
      const gate = new GmailDispatchGate(connections, barrier);
      const scope = {
        tenantId: "tenant",
        connectionId: "connection",
        sourceId: "source-a",
      };
      const other = { ...scope, sourceId: "source-b" };
      await connections.initialize(scope);
      const tokens = await EncryptedTokenStore.open(
        tokenRoot,
        Buffer.alloc(32, 7),
        new GmailTokenGate(gate),
      );
      await tokens.put(scope.tenantId, scope.connectionId, {
        refreshToken: "synthetic-refresh",
      });
      const deps: PollDependencies = {
        policy: { check: async () => true },
        client: {
          watermark: async () => "10",
          list: async () => ({ messageIds: ["message"], nextPageToken: null }),
          history: async () => ({
            messageIds: [],
            nextPageToken: null,
            historyId: "11",
          }),
          reconcile: async (current, messageId) => ({
            kind: "eligible",
            messageId,
            revision: "10",
            text: `synthetic ${current.sourceId}`,
          }),
        },
        lease: state.lease,
        checkpoints: state.checkpoints,
        claims,
        attempts,
        ledger: ledger.ledger,
      };
      const config = { version: "v1", query: "", labelIds: [] };
      expect((await pollGmail(scope, config, deps)).status).toBe("completed");
      expect((await pollGmail(other, config, deps)).status).toBe("completed");
      const hash = (value: string) =>
        createHash("sha256").update(value).digest("hex");
      const pk = `gmail#${hash(JSON.stringify([scope.tenantId, scope.connectionId]))}`;
      const record = async (sourceId: string) =>
        (
          await db.send(
            new GetCommand({
              TableName: table,
              Key: {
                pk,
                sk: `ledger#${hash(sourceId)}#message#${hash("message")}`,
              },
              ConsistentRead: true,
            }),
          )
        ).Item!;
      const ids = [
        (await record(scope.sourceId)).object.id as string,
        (await record(other.sourceId)).object.id as string,
      ];
      const coordinator = new GmailDisconnectCoordinator(
        db,
        table,
        connections,
        barrier,
        lifecycle,
        refreshLock,
      );
      const fence = (await state.lease.acquire(scope))!.fence;
      let started!: () => void;
      let finish!: () => void;
      const inFlightStarted = new Promise<void>((resolve) => {
        started = resolve;
      });
      const unblock = new Promise<void>((resolve) => {
        finish = resolve;
      });
      const inFlight = gate.run(scope, async () => {
        started();
        await unblock;
        return "done";
      });
      await inFlightStarted;
      await expect(coordinator.disconnect(scope, fence)).rejects.toThrow();
      expect((await connections.snapshot(scope))?.status).toBe("disconnected");
      await expect(gate.run(scope, async () => "forbidden")).rejects.toThrow();
      finish();
      expect(await inFlight).toBe("done");
      expect(await coordinator.disconnect(scope, fence)).toEqual({
        status: "incomplete",
      });
      for (const id of ids)
        expect(await objects.get(scope.tenantId, id)).toBeNull();
      for (const source of [scope.sourceId, other.sourceId])
        expect(await record(source)).toMatchObject({
          active: false,
          contentPurged: true,
        });
      const connection = (
        await db.send(
          new GetCommand({
            TableName: table,
            Key: gmailConnectionKey(scope),
            ConsistentRead: true,
          }),
        )
      ).Item;
      expect(connection).toMatchObject({
        status: "disconnected",
        providerRevocationPending: true,
        knownObjectsPurged: true,
      });
      const retainedFiles = await readdir(tokenRoot);
      expect(retainedFiles).toHaveLength(1);
      expect(
        await readFile(join(tokenRoot, retainedFiles[0]!), "utf8"),
      ).not.toContain("synthetic-refresh");
      await expect(
        tokens.get(scope.tenantId, scope.connectionId),
      ).rejects.toThrow();
      await state.lease.release(scope, fence);

      // A valid-looking reference without an ownership intent is not proof of cleanup.
      const orphanScope = { ...scope, connectionId: "orphan-connection" };
      await connections.initialize(orphanScope);
      const orphanId = `go_${randomUUID().replaceAll("-", "")}`;
      await objects.put(
        orphanScope.tenantId,
        orphanId,
        new TextEncoder().encode("synthetic orphan"),
      );
      await db.send(
        new PutCommand({
          TableName: table,
          Item: {
            pk: `gmail#${hash(JSON.stringify([orphanScope.tenantId, orphanScope.connectionId]))}`,
            sk: `ledger#${hash(orphanScope.sourceId)}#message#${hash("orphan")}`,
            object: { id: orphanId },
          },
        }),
      );
      const orphanFence = (await state.lease.acquire(orphanScope))!.fence;
      await expect(
        coordinator.disconnect(orphanScope, orphanFence),
      ).rejects.toThrow();
      const orphanConnection = (
        await db.send(
          new GetCommand({
            TableName: table,
            Key: gmailConnectionKey(orphanScope),
            ConsistentRead: true,
          }),
        )
      ).Item;
      expect(orphanConnection?.knownObjectsPurged).not.toBe(true);
      expect(await objects.get(orphanScope.tenantId, orphanId)).not.toBeNull();
      await state.lease.release(orphanScope, orphanFence);
    } finally {
      if (created)
        await admin.send(new DeleteTableCommand({ TableName: table }));
      db.destroy();
      admin.destroy();
      await rm(root, { recursive: true, force: true });
      await rm(lockRoot, { recursive: true, force: true });
      await rm(tokenRoot, { recursive: true, force: true });
      await rm(refreshRoot, { recursive: true, force: true });
    }
  }, 30000);
});
