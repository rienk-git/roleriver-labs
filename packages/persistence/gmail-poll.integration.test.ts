import { GmailObjectLifecycle } from "./gmail-objects.js";
import { GmailConnectionRepository } from "./gmail-connection.js";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CreateTableCommand,
  DeleteTableCommand,
  DynamoDBClient,
} from "@aws-sdk/client-dynamodb";
import { describe, expect, it } from "vitest";
import { pollGmail, type PollDependencies } from "../source-gmail/poll.js";
import { createLocalClient } from "./dynamodb.js";
import { GmailLedgerRepository } from "./gmail-ledger.js";
import { GmailStateRepository } from "./gmail-state.js";
import { GmailAttemptRepository } from "./gmail-attempt.js";
import { GmailConfigRepository } from "./gmail-config.js";
import { LocalObjectStore } from "./object-store.js";

describe("Gmail polling persistence integration", () => {
  it("replays a completed reconciliation after checkpoint publication fails", async () => {
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
    const table = `roleriver_poll_${randomUUID().replaceAll("-", "")}`;
    const root = await mkdtemp(join(tmpdir(), "roleriver-poll-"));
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
      const state = new GmailStateRepository(document, table, 30000);
      const lifecycle = new GmailObjectLifecycle(document, table, objects, {
        exclusive: async <T>(_tenant: string, task: () => Promise<T>) => task(),
      });
      const ledger = new GmailLedgerRepository(document, table, lifecycle);
      const attempts = new GmailAttemptRepository(document, table);
      const claims = new GmailConfigRepository(document, table);
      const scope = {
        tenantId: "tenant",
        connectionId: "connection",
        sourceId: "source",
      };
      await new GmailConnectionRepository(document, table).initialize(scope);
      const config = { version: "v1", query: "", labelIds: [] };
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
          reconcile: async (_scope, messageId) => ({
            kind: "eligible",
            messageId,
            revision: "10",
            text: "synthetic vacancy",
          }),
        },
        lease: state.lease,
        checkpoints: state.checkpoints,
        claims,
        attempts: {
          isInitialized: attempts.isInitialized.bind(attempts),
          begin: attempts.begin.bind(attempts),
          publish: async () => false,
        },
        ledger: ledger.ledger,
      };
      expect(await pollGmail(scope, config, deps)).toEqual({
        status: "checkpoint_conflict",
      });
      expect(await state.checkpoints.load(scope)).toBeNull();
      deps.attempts = {
        isInitialized: attempts.isInitialized.bind(attempts),
        begin: attempts.begin.bind(attempts),
        publish: attempts.publish.bind(attempts),
      };
      expect(await pollGmail(scope, config, deps)).toEqual({
        status: "completed",
        mode: "full",
      });
      expect(await state.checkpoints.load(scope)).toEqual({
        historyId: "11",
        configVersion: "v1",
        revision: 1,
      });
    } finally {
      if (created)
        await admin.send(new DeleteTableCommand({ TableName: table }));
      document.destroy();
      admin.destroy();
      await rm(root, { recursive: true, force: true });
    }
  }, 30000);
});
