import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CreateTableCommand,
  DeleteTableCommand,
  DynamoDBClient,
} from "@aws-sdk/client-dynamodb";
import { describe, expect, it, vi } from "vitest";
import { PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { createLocalClient } from "./dynamodb.js";
import {
  createSourcePolicyGate,
  InMemoryRateLimiter,
} from "../source-policy/policy.js";
import { GmailLocalConnection, type GmailLocalOptions } from "./gmail-local.js";

describe("local Gmail synthetic acceptance", () => {
  it.each(["objectRoot", "tokenRoot"] as const)(
    "refuses a pre-populated unbound %s without deleting its contents",
    async (prepopulated) => {
      const endpoint = process.env.ROLERIVER_DYNAMODB_TEST_URL;
      if (process.env.ROLERIVER_DYNAMODB_TEST !== "1" || !endpoint)
        throw new Error("Explicit local test opt-in and endpoint are required");
      const roots = await Promise.all(
        ["objects", "tenant-lock", "refresh-lock", "tokens"].map((name) =>
          mkdtemp(join(tmpdir(), `gmail-unbound-${name}-`)),
        ),
      );
      try {
        const options = {
          scope: {
            tenantId: "tenant",
            connectionId: "connection",
            sourceId: "gmail",
          },
          authorize: async () => true,
          endpoint,
          table: `nonempty_${randomUUID().replaceAll("-", "")}`,
          objectRoot: roots[0]!,
          tenantLockRoot: roots[1]!,
          refreshLockRoot: roots[2]!,
          tokenRoot: roots[3]!,
          tokenKey: Buffer.alloc(32, 7),
          clientId: "synthetic-client",
          redirectUri: "http://127.0.0.1:43210/callback",
          policy: createSourcePolicyGate(
            { sources: [] },
            () => new Date("2026-11-28"),
            new InMemoryRateLimiter(),
          ),
          fetcher: vi.fn<typeof fetch>(),
        };
        const existing = join(options[prepopulated], "existing-synthetic");
        await writeFile(existing, "synthetic existing data");
        await expect(GmailLocalConnection.open(options)).rejects.toThrow();
        expect(await readFile(existing, "utf8")).toBe(
          "synthetic existing data",
        );
      } finally {
        await Promise.all(
          roots.map((root) => rm(root, { recursive: true, force: true })),
        );
      }
    },
    30000,
  );
  it("connects, polls, guards an interrupted view, recovers and disconnects", async () => {
    const endpoint = process.env.ROLERIVER_DYNAMODB_TEST_URL;
    if (process.env.ROLERIVER_DYNAMODB_TEST !== "1" || !endpoint)
      throw new Error("Explicit local test opt-in and endpoint are required");
    const admin = new DynamoDBClient({
      endpoint,
      region: "local",
      credentials: { accessKeyId: "dummy", secretAccessKey: "dummy" },
      maxAttempts: 1,
    });
    const table = `acceptance_${randomUUID().replaceAll("-", "")}`;
    const roots = await Promise.all(
      ["objects", "tenant-lock", "refresh-lock", "tokens"].map((name) =>
        mkdtemp(join(tmpdir(), `gmail-${name}-`)),
      ),
    );
    let created = false;
    let app: GmailLocalConnection | undefined;
    let extraRoot: string | undefined;
    let unboundTable: string | undefined;
    let unboundRoots: string[] = [];
    try {
      const policy = createSourcePolicyGate(
        {
          sources: [
            {
              id: "gmail",
              methods: {
                email: {
                  enabled: true,
                  evidence: "synthetic",
                  reviewedOn: "2026-01-01",
                  expiresOn: "2027-12-31",
                  allowedHosts: [
                    "accounts.google.com",
                    "oauth2.googleapis.com",
                    "gmail.googleapis.com",
                  ],
                  rateLimit: { requests: 100, windowMs: 60000 },
                },
              },
            },
          ],
        },
        () => new Date("2026-11-28"),
        new InMemoryRateLimiter(),
      );
      let failHistory = false;
      let failExchange = false;
      const json = (value: unknown) =>
        new Response(JSON.stringify(value), { status: 200 });
      const fetcher = vi.fn<typeof fetch>(async (input) => {
        const url = new URL(String(input));
        if (url.href === "https://oauth2.googleapis.com/token" && failExchange)
          throw new Error("synthetic response lost after possible grant");
        if (url.href === "https://oauth2.googleapis.com/token")
          return json({
            access_token: "synthetic-access",
            refresh_token: "synthetic-refresh",
            expires_in: 3600,
          });
        if (url.href === "https://oauth2.googleapis.com/revoke")
          return new Response(null, { status: 200 });
        if (url.hostname !== "gmail.googleapis.com")
          throw new Error("unexpected synthetic endpoint");
        if (url.pathname.endsWith("/profile")) return json({ historyId: "10" });
        if (url.pathname.endsWith("/messages"))
          return json({ messages: [{ id: "message" }] });
        if (url.pathname.endsWith("/history")) {
          if (failHistory) {
            failHistory = false;
            return new Response(null, { status: 500 });
          }
          return json({ historyId: "11" });
        }
        if (url.pathname.endsWith("/messages/message")) {
          const payload = url.searchParams.get("fields")?.includes("body(data")
            ? {
                mimeType: "text/plain",
                filename: "",
                body: {
                  data: Buffer.from("synthetic role").toString("base64url"),
                },
              }
            : { mimeType: "text/plain", filename: "" };
          return json({
            id: "message",
            historyId: "10",
            labelIds: ["INBOX"],
            payload,
          });
        }
        throw new Error("unexpected synthetic route");
      });
      const scope = {
        tenantId: "tenant",
        connectionId: "connection",
        sourceId: "gmail",
      };
      let authorize: () => Promise<boolean> = async () => true;
      const authorizeHold: () => Promise<boolean> = async () => true;
      const options: GmailLocalOptions = {
        scope,
        authorize: async () => authorize(),
        authorizeHold: () => authorizeHold(),
        endpoint,
        table,
        objectRoot: roots[0]!,
        tenantLockRoot: roots[1]!,
        refreshLockRoot: roots[2]!,
        tokenRoot: roots[3]!,
        tokenKey: Buffer.alloc(32, 7),
        clientId: "synthetic-client",
        redirectUri: "http://127.0.0.1:43210/callback",
        policy,
        fetcher,
      };
      unboundTable = `unbound_${randomUUID().replaceAll("-", "")}`;
      unboundRoots = await Promise.all(
        ["object", "tenant", "refresh", "token"].map((name) =>
          mkdtemp(join(tmpdir(), `gmail-unbound-${name}-`)),
        ),
      );
      await admin.send(
        new CreateTableCommand({
          TableName: unboundTable,
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
      await expect(
        GmailLocalConnection.open({
          ...options,
          table: unboundTable,
          objectRoot: unboundRoots[0]!,
          tenantLockRoot: unboundRoots[1]!,
          refreshLockRoot: unboundRoots[2]!,
          tokenRoot: unboundRoots[3]!,
        }),
      ).rejects.toThrow();
      app = await GmailLocalConnection.open(options);
      created = true;
      const peer = await GmailLocalConnection.open(options);
      peer.close();
      extraRoot = await mkdtemp(join(tmpdir(), "gmail-alternate-lock-"));
      await expect(
        GmailLocalConnection.open({ ...options, tenantLockRoot: extraRoot }),
      ).rejects.toThrow();
      let releaseOpen!: () => void;
      let openStarted!: () => void;
      const opening = new Promise<void>((resolve) => {
        openStarted = resolve;
      });
      const release = new Promise<void>((resolve) => {
        releaseOpen = resolve;
      });
      authorize = async () => {
        openStarted();
        await release;
        return true;
      };
      const mutableOptions = { ...options, scope: { ...scope } };
      const pendingOpen = GmailLocalConnection.open(mutableOptions);
      await opening;
      mutableOptions.scope.connectionId = "mutated-connection";
      mutableOptions.tenantLockRoot = extraRoot;
      releaseOpen();
      const snapshotPeer = await pendingOpen;
      snapshotPeer.close();
      authorize = async () => true;
      await app.initialize();
      const state = new URL(await app.authorizationUrl()).searchParams.get(
        "state",
      );
      expect(state).toBeTruthy();
      await app.completeAuthorization(
        `http://127.0.0.1:43210/callback?code=synthetic&state=${state}`,
      );
      const config = { version: "v1", query: "", labelIds: ["INBOX"] };
      expect(await app.poll(config)).toEqual({
        status: "completed",
        mode: "full",
      });
      expect(await app.listMessages({ limit: 10 })).toEqual({
        status: "ready",
        items: [
          {
            messageId: "message",
            objectId: expect.stringMatching(/^go_/),
            text: "synthetic role",
          },
        ],
        more: false,
      });
      // Snapshot list options before awaiting the caller's authorization callback.
      let resumeAuthorization!: () => void;
      let authorizationStarted!: () => void;
      const started = new Promise<void>((resolve) => {
        authorizationStarted = resolve;
      });
      const resume = new Promise<void>((resolve) => {
        resumeAuthorization = resolve;
      });
      let authCalls = 0;
      authorize = async () => {
        if (++authCalls === 1) {
          authorizationStarted();
          await resume;
        }
        return true;
      };
      const mutableLimit = { limit: 1 };
      const listing = app.listMessages(mutableLimit);
      await started;
      mutableLimit.limit = 21;
      resumeAuthorization();
      expect(await listing).toMatchObject({
        status: "ready",
        items: [{ messageId: "message" }],
      });
      let checks = 0;
      authorize = async () => ++checks === 1;
      expect(await app.listMessages({ limit: 10 })).toEqual({
        status: "unavailable",
      });
      authorize = async () => true;
      failHistory = true;
      expect(await app.poll(config)).toEqual({ status: "failed" });
      expect(await app.listMessages({ limit: 10 })).toEqual({
        status: "unavailable",
      });
      expect(await app.poll(config)).toEqual({
        status: "completed",
        mode: "full",
      });
      const before = await app.listMessages({ limit: 10 });
      expect(before).toEqual({
        status: "ready",
        items: [
          {
            messageId: "message",
            objectId: expect.stringMatching(/^go_/),
            text: "synthetic role",
          },
        ],
        more: false,
      });
      if (before.status !== "ready") throw new Error("expected message");
      const messageId = "message";
      const objectId = before.items[0]!.objectId;
      for (const holdId of ["role-one", "role-two"]) {
        expect(
          await app.finishProcessing({
            messageId,
            objectId,
            outcome: { kind: "retain", holdKind: "role", holdId },
          }),
        ).toEqual({ status: "unavailable" });
        expect(
          await app.releaseRetained({
            messageId,
            objectId,
            holdKind: "role",
            holdId,
          }),
        ).toEqual({ status: "unavailable" });
      }
      expect(await app.listMessages({ limit: 10 })).toMatchObject({
        status: "ready",
        items: [{ messageId, objectId, text: "synthetic role" }],
      });
      const hash = (value: string) =>
        createHash("sha256").update(value).digest("hex");
      const db = createLocalClient(endpoint);
      try {
        await db.send(
          new PutCommand({
            TableName: table,
            Item: {
              pk: `gmail#${hash(JSON.stringify([scope.tenantId, scope.connectionId]))}`,
              sk: `processing-outcome#${hash(scope.sourceId)}#${objectId}`,
              objectId,
              messageId,
              decision: "discard",
              status: "pending",
            },
            ConditionExpression: "attribute_not_exists(pk)",
          }),
        );
        expect(await app.recoverProcessing()).toEqual({
          status: "completed",
          next: null,
        });
        expect(
          await app.finishProcessing({
            messageId,
            objectId,
            outcome: { kind: "discard" },
          }),
        ).toEqual({ status: "completed" });
        await db.send(
          new UpdateCommand({
            TableName: table,
            Key: {
              pk: `gmail#${hash(JSON.stringify([scope.tenantId, scope.connectionId]))}`,
              sk: `processing-outcome#${hash(scope.sourceId)}#${objectId}`,
            },
            UpdateExpression: "REMOVE #status",
            ExpressionAttributeNames: { "#status": "status" },
          }),
        );
        expect(await app.recoverProcessing()).toEqual({
          status: "unavailable",
          next: null,
        });
      } finally {
        db.destroy();
      }
      expect(await app.listMessages({ limit: 10 })).toMatchObject({
        status: "ready",
        items: [],
      });
      const outcome = await app.disconnect();
      expect(outcome.status).toBe("incomplete");
      expect(await app.listMessages({ limit: 10 })).toEqual({
        status: "unavailable",
      });
      expect(
        fetcher.mock.calls.some(
          ([url]) => String(url) === "https://oauth2.googleapis.com/revoke",
        ),
      ).toBe(true);
      const neverStarted = await GmailLocalConnection.open({
        ...options,
        scope: { ...scope, connectionId: "never-started" },
      });
      try {
        await neverStarted.initialize();
        const result = await neverStarted.disconnect();
        expect(result.status).toBe("incomplete");
        if (result.status === "incomplete")
          expect(result.reasons).not.toContain("provider_revocation_pending");
      } finally {
        neverStarted.close();
      }
      const ambiguous = await GmailLocalConnection.open({
        ...options,
        scope: { ...scope, connectionId: "ambiguous" },
      });
      try {
        await ambiguous.initialize();
        const ambiguousState = new URL(
          await ambiguous.authorizationUrl(),
        ).searchParams.get("state");
        failExchange = true;
        await expect(
          ambiguous.completeAuthorization(
            `http://127.0.0.1:43210/callback?code=synthetic&state=${ambiguousState}`,
          ),
        ).rejects.toThrow();
        failExchange = false;
        const result = await ambiguous.disconnect();
        expect(result.status).toBe("incomplete");
        if (result.status === "incomplete")
          expect(result.reasons).toContain("provider_revocation_pending");
      } finally {
        ambiguous.close();
      }
      app.close();
      app = undefined;
      await admin.send(new DeleteTableCommand({ TableName: table }));
      created = false;
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
      // Recreating the database must not silently rebind existing durable object roots.
      await expect(GmailLocalConnection.open(options)).rejects.toThrow();
    } finally {
      app?.close();
      if (created)
        await admin.send(new DeleteTableCommand({ TableName: table }));
      if (unboundTable)
        await admin.send(new DeleteTableCommand({ TableName: unboundTable }));
      admin.destroy();
      await Promise.all(
        roots.map((root) => rm(root, { recursive: true, force: true })),
      );
      if (extraRoot) await rm(extraRoot, { recursive: true, force: true });
      await Promise.all(
        unboundRoots.map((root) => rm(root, { recursive: true, force: true })),
      );
    }
  }, 30000);
});
