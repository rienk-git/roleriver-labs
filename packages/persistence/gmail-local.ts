import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, realpath, readdir } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { CreateTableCommand } from "@aws-sdk/client-dynamodb";
import {
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  type DynamoDBDocumentClient,
} from "@aws-sdk/lib-dynamodb";
import { createGoogleOAuth } from "../source-gmail/oauth.js";
import { createGmailClient } from "../source-gmail/client.js";
import {
  pollGmail,
  type PollConfig,
  type PollResult,
  type PollScope,
} from "../source-gmail/poll.js";
import {
  GmailConnectionProvisioner,
  GmailRefreshCoordinator,
} from "../source-gmail/refresh.js";
import { EncryptedTokenStore } from "../source-gmail/token-store.js";
import type { SourcePolicyGate } from "../source-policy/policy.js";
import { createLocalClient } from "./dynamodb.js";
import { GmailAttemptRepository } from "./gmail-attempt.js";
import { GmailConfigRepository } from "./gmail-config.js";
import {
  connectedCondition,
  GmailConnectionRepository,
} from "./gmail-connection.js";
import { GmailDisconnectCoordinator } from "./gmail-disconnect.js";
import {
  GmailDispatchGate,
  GmailDisconnectedTokenGate,
  GmailTokenGate,
} from "./gmail-dispatch.js";
import { GmailLedgerRepository } from "./gmail-ledger.js";
import { GmailHoldRepository } from "./gmail-holds.js";
import { GmailObjectLifecycle } from "./gmail-objects.js";
import {
  bindGmailRevocation,
  GmailRevocationCoordinator,
} from "./gmail-revocation.js";
import { GmailStateRepository } from "./gmail-state.js";
import { LocalTenantBarrier } from "./local-barrier.js";
import { LocalObjectStore } from "./object-store.js";

export interface GmailLocalOptions {
  scope: PollScope;
  /** This trusted callback must authenticate and authorize the exact scope. */
  authorize(scope: PollScope): Promise<boolean>;
  /** Trusted authorization for the specific durable role/evidence owner. */
  authorizeHold?(
    scope: PollScope,
    kind: "role" | "evidence",
    id: string,
  ): Promise<boolean>;
  endpoint: string;
  table: string;
  objectRoot: string;
  tenantLockRoot: string;
  refreshLockRoot: string;
  tokenRoot: string;
  tokenKey: Uint8Array;
  clientId: string;
  clientSecret?: string;
  redirectUri: string;
  policy: SourcePolicyGate;
  fetcher: typeof fetch;
}

export type GmailLocalMessages =
  | { status: "unavailable" }
  | {
      status: "ready";
      items: { messageId: string; objectId: string; text: string }[];
      more: boolean;
    };
export type GmailLocalDisconnect =
  | { status: "denied" }
  | {
      status: "incomplete";
      reasons: (
        | "connection_stop_pending"
        | "provider_revocation_pending"
        | "sync_busy"
        | "object_purge_pending"
        | "legacy_content_unverified"
        | "quotations_unverified"
      )[];
    };
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const failure = () => new Error("Local Gmail operation failed");
// Role/evidence retention stays unavailable until multiple owners can be coordinated.
const retainedOutcomesSupported = (): boolean => false;
/** A permanent private marker binds all processes using this object root to one storage/lock configuration. */
async function bindRoots(root: string, fingerprint: string): Promise<boolean> {
  const path = join(root, ".roleriver-gmail-binding-v1");
  let created = false;
  let file;
  try {
    try {
      file = await open(
        path,
        constants.O_CREAT |
          constants.O_EXCL |
          constants.O_WRONLY |
          constants.O_NOFOLLOW,
        0o600,
      );
      created = true;
      await file.writeFile(fingerprint, "utf8");
      await file.sync();
      await file.close();
      file = undefined;
      // New roots must not contain untracked legacy objects or credentials.
      // Partial initialization is never repaired or deleted automatically.
      if (
        (await readdir(root)).some(
          (name) => name !== ".roleriver-gmail-binding-v1",
        )
      )
        throw failure();
      const directory = await open(
        root,
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    } catch (error) {
      if (
        created ||
        !(error instanceof Error) ||
        !("code" in error) ||
        error.code !== "EEXIST"
      )
        throw failure();
    }
    const existing = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    try {
      const stats = await existing.stat();
      if (
        !stats.isFile() ||
        stats.uid !== process.getuid!() ||
        (stats.mode & 0o077) !== 0 ||
        stats.nlink !== 1 ||
        stats.size !== 64 ||
        (await existing.readFile("utf8")) !== fingerprint
      )
        throw failure();
    } finally {
      await existing.close();
    }
    return created;
  } finally {
    await file?.close();
  }
}
async function bindTable(
  db: DynamoDBDocumentClient,
  table: string,
  fingerprint: string,
  creating: boolean,
): Promise<void> {
  const key = { pk: "local-gmail-binding", sk: "v1" };
  if (!creating) {
    const existing = (
      await db.send(
        new GetCommand({ TableName: table, Key: key, ConsistentRead: true }),
        { abortSignal: AbortSignal.timeout(5000) },
      )
    ).Item;
    if (!existing || existing.fingerprint !== fingerprint) throw failure();
    return;
  }
  try {
    // Creation must succeed: an existing unbound table may contain legacy data.
    await db.send(
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
      { abortSignal: AbortSignal.timeout(5000) },
    );
    await db.send(
      new PutCommand({
        TableName: table,
        Item: { ...key, fingerprint },
        ConditionExpression: "attribute_not_exists(pk)",
      }),
      { abortSignal: AbortSignal.timeout(5000) },
    );
  } catch {
    throw failure();
  }
}

/**
 * Inactive local composition. Bootstrap must supply trusted authorization, policy,
 * fetch and key dependencies. First initialization requires owner-provided empty,
 * private roots and no concurrent writers, including legacy writers or same-UID
 * processes; the marker does not protect against non-cooperating local processes.
 */
export class GmailLocalConnection {
  private constructor(
    private readonly scope: PollScope,
    private readonly authorize: GmailLocalOptions["authorize"],
    private readonly authorizeHold: GmailLocalOptions["authorizeHold"],
    private readonly db: DynamoDBDocumentClient,
    private readonly table: string,
    private readonly policy: SourcePolicyGate,
    private readonly connections: GmailConnectionRepository,
    private readonly attempts: GmailAttemptRepository,
    private readonly state: GmailStateRepository,
    private readonly objects: LocalObjectStore,
    private readonly holds: GmailHoldRepository,
    private readonly gate: GmailDispatchGate,
    private readonly refreshLock: LocalTenantBarrier,
    private readonly disconnectCoordinator: GmailDisconnectCoordinator,
    private readonly revocation: GmailRevocationCoordinator,
    private readonly oauth: ReturnType<typeof createGoogleOAuth>,
    private readonly provisioner: GmailConnectionProvisioner,
    private readonly pollDeps: Parameters<typeof pollGmail>[2],
  ) {}

  static async open(options: GmailLocalOptions): Promise<GmailLocalConnection> {
    let db: DynamoDBDocumentClient | undefined;
    try {
      if (
        !options ||
        !options.scope ||
        !(options.tokenKey instanceof Uint8Array) ||
        !options.policy ||
        typeof options.policy.check !== "function" ||
        typeof options.policy.authorize !== "function" ||
        typeof options.policy.dispatch !== "function"
      )
        throw failure();
      const boundPolicy = Object.freeze({
        check: options.policy.check.bind(options.policy),
        authorize: options.policy.authorize.bind(options.policy),
        dispatch: options.policy.dispatch.bind(options.policy),
      });
      options = Object.freeze({
        ...options,
        scope: Object.freeze({ ...options.scope }),
        tokenKey: Uint8Array.from(options.tokenKey),
        policy: boundPolicy,
      });
      const scope = Object.freeze({ ...options.scope });
      if (
        typeof scope.tenantId !== "string" ||
        !/^[A-Za-z0-9_-]{1,64}$/.test(scope.tenantId) ||
        typeof scope.connectionId !== "string" ||
        !/^[A-Za-z0-9_-]{1,128}$/.test(scope.connectionId) ||
        typeof scope.sourceId !== "string" ||
        !/^[A-Za-z0-9_-]{1,64}$/.test(scope.sourceId) ||
        typeof options.clientId !== "string" ||
        !options.clientId ||
        options.clientId.length > 512 ||
        (options.clientSecret !== undefined &&
          (typeof options.clientSecret !== "string" ||
            options.clientSecret.length > 4096)) ||
        typeof options.authorize !== "function" ||
        (await options.authorize(scope)) !== true ||
        !options.policy ||
        typeof options.policy.check !== "function" ||
        typeof options.policy.authorize !== "function" ||
        typeof options.fetcher !== "function"
      )
        throw failure();
      const roots = await Promise.all(
        [
          options.objectRoot,
          options.tenantLockRoot,
          options.refreshLockRoot,
          options.tokenRoot,
        ].map(async (path) => {
          const resolved = resolve(path);
          if ((await realpath(resolved)) !== resolved) throw failure();
          return resolved;
        }),
      );
      for (let i = 0; i < roots.length; i++)
        for (let j = i + 1; j < roots.length; j++)
          if (
            roots[i] === roots[j] ||
            roots[i]!.startsWith(`${roots[j]}${sep}`) ||
            roots[j]!.startsWith(`${roots[i]}${sep}`)
          )
            throw failure();
      db = createLocalClient(options.endpoint);
      const objects = await LocalObjectStore.open(roots[0]!);
      const tenantLock = await LocalTenantBarrier.open(roots[1]!);
      const refreshLock = await LocalTenantBarrier.open(roots[2]!);
      const barrier = {
        exclusive: async <T>(tenant: string, operation: () => Promise<T>) => {
          const result = await tenantLock.run(tenant, operation);
          if (result.status !== "completed") throw failure();
          return result.value;
        },
      };
      const connections = new GmailConnectionRepository(db, options.table);
      const gate = new GmailDispatchGate(connections, barrier);
      const lifecycle = new GmailObjectLifecycle(
        db,
        options.table,
        objects,
        barrier,
      );
      const tokenStore = await EncryptedTokenStore.open(
        roots[3]!,
        options.tokenKey,
        new GmailTokenGate(gate),
        bindGmailRevocation(
          scope,
          connections,
          new GmailDisconnectedTokenGate(connections, barrier),
          options.policy,
          options.fetcher,
        ),
      );
      const binding = hash(
        JSON.stringify([
          "gmail-local-v1",
          options.endpoint,
          options.table,
          roots,
        ]),
      );
      const created: boolean[] = [];
      for (const root of roots) created.push(await bindRoots(root!, binding));
      if (created.some(Boolean) && !created.every(Boolean)) throw failure();
      await bindTable(db, options.table, binding, created.every(Boolean));
      const oauth = createGoogleOAuth({
        clientId: options.clientId,
        ...(options.clientSecret ? { clientSecret: options.clientSecret } : {}),
        redirectUri: options.redirectUri,
        fetcher: options.fetcher,
        gate: { run: (operation) => gate.run(scope, operation) },
        exchangeStarted: () => connections.markIssuanceStarted(scope),
        allow: async (url) =>
          (
            await options.policy.authorize({
              sourceId: scope.sourceId,
              method: "email",
              targetUrl: url,
            })
          ).allowed,
      });
      const refresh = new GmailRefreshCoordinator(
        scope,
        tokenStore,
        oauth,
        refreshLock,
      );
      const provisioner = new GmailConnectionProvisioner(
        scope,
        tokenStore,
        oauth,
        refreshLock,
      );
      const attempts = new GmailAttemptRepository(db, options.table);
      const state = new GmailStateRepository(db, options.table, 30000);
      const check = async (
        actual: PollScope,
        method: "email",
        host: "gmail.googleapis.com",
      ) =>
        (
          await options.policy.check({
            sourceId: actual.sourceId,
            method,
            targetUrl: `https://${host}/`,
          })
        ).allowed;
      const client = createGmailClient({
        fetch: options.fetcher,
        gate,
        accessToken: (actual) => refresh.accessToken(actual),
        check,
        authorize: async (actual, method, host) =>
          (
            await options.policy.authorize({
              sourceId: actual.sourceId,
              method,
              targetUrl: `https://${host}/`,
            })
          ).allowed,
      });
      const pollDeps = {
        claims: new GmailConfigRepository(db, options.table),
        attempts,
        policy: { check },
        client,
        checkpoints: state.checkpoints,
        lease: state.lease,
        ledger: new GmailLedgerRepository(db, options.table, lifecycle).ledger,
      };
      return new GmailLocalConnection(
        scope,
        options.authorize,
        options.authorizeHold,
        db,
        options.table,
        options.policy,
        connections,
        attempts,
        state,
        objects,
        new GmailHoldRepository(db, options.table, lifecycle),
        gate,
        refreshLock,
        new GmailDisconnectCoordinator(
          db,
          options.table,
          connections,
          barrier,
          lifecycle,
          refreshLock,
        ),
        new GmailRevocationCoordinator(tokenStore, refreshLock),
        oauth,
        provisioner,
        pollDeps,
      );
    } catch {
      db?.destroy();
      throw failure();
    }
  }

  private async permitted(): Promise<boolean> {
    try {
      return (await this.authorize(this.scope)) === true;
    } catch {
      return false;
    }
  }
  private async holdPermitted(
    kind: "role" | "evidence",
    id: string,
  ): Promise<boolean> {
    try {
      return (
        this.authorizeHold !== undefined &&
        (await this.authorizeHold(this.scope, kind, id)) === true
      );
    } catch {
      return false;
    }
  }
  async initialize(): Promise<void> {
    if (!(await this.permitted())) throw failure();
    try {
      await this.connections.initialize(this.scope);
    } catch {
      throw failure();
    }
  }
  async authorizationUrl(): Promise<string> {
    if (!(await this.permitted())) throw failure();
    try {
      return await this.gate.run(this.scope, async () => {
        const url = await this.oauth.authorizationUrl();
        if (
          !(
            await this.policy.check({
              sourceId: this.scope.sourceId,
              method: "email",
              targetUrl: url,
            })
          ).allowed
        )
          throw failure();
        return url;
      });
    } catch {
      throw failure();
    }
  }
  async completeAuthorization(callbackUrl: string): Promise<void> {
    if (!(await this.permitted())) throw failure();
    await this.provisioner.complete(callbackUrl);
  }
  async poll(config: PollConfig): Promise<PollResult> {
    if (!(await this.permitted())) return { status: "policy_denied" };
    return pollGmail(this.scope, config, this.pollDeps);
  }

  /** One bounded page only. These are raw ingested messages, not promising-role decisions. */
  async listMessages(options: { limit: number }): Promise<GmailLocalMessages> {
    const limit = options?.limit;
    if (
      typeof limit !== "number" ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 20 ||
      !(await this.permitted())
    )
      return { status: "unavailable" };
    try {
      const result = await this.attempts.read(this.scope, async () => {
        const pk = `gmail#${hash(JSON.stringify([this.scope.tenantId, this.scope.connectionId]))}`;
        const prefix = `ledger#${hash(this.scope.sourceId)}#message#`;
        const page = await this.db.send(
          new QueryCommand({
            TableName: this.table,
            KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
            ExpressionAttributeValues: { ":pk": pk, ":prefix": prefix },
            ConsistentRead: true,
            Limit: limit,
          }),
          { abortSignal: AbortSignal.timeout(5000) },
        );
        const items: { messageId: string; objectId: string; text: string }[] =
          [];
        let total = 0;
        for (const row of page.Items ?? []) {
          if (row.active === false) continue;
          if (
            row.active !== true ||
            row.kind !== "eligible" ||
            row.origin !== "gmail" ||
            row.externalProcessing !== "not_authorized" ||
            typeof row.messageId !== "string" ||
            !/^[A-Za-z0-9_-]{1,128}$/.test(row.messageId) ||
            row.sk !== `${prefix}${hash(row.messageId)}` ||
            !row.object ||
            typeof row.object !== "object" ||
            typeof row.object.id !== "string" ||
            !/^go_[a-f0-9]{32}$/.test(row.object.id) ||
            typeof row.object.sha256 !== "string" ||
            !/^[a-f0-9]{64}$/.test(row.object.sha256) ||
            !Number.isSafeInteger(row.object.size) ||
            row.object.size < 0 ||
            row.object.size > 1024 * 1024
          )
            throw failure();
          const [intent, claim] = await Promise.all([
            this.db.send(
              new GetCommand({
                TableName: this.table,
                Key: {
                  pk,
                  sk: `object#${hash(this.scope.sourceId)}#${row.object.id}`,
                },
                ConsistentRead: true,
              }),
              { abortSignal: AbortSignal.timeout(5000) },
            ),
            this.db.send(
              new GetCommand({
                TableName: this.table,
                Key: {
                  pk: `gmail-object#${hash(this.scope.tenantId)}`,
                  sk: row.object.id,
                },
                ConsistentRead: true,
              }),
              { abortSignal: AbortSignal.timeout(5000) },
            ),
          ]);
          if (
            !intent.Item ||
            intent.Item.status !== "committed" ||
            intent.Item.sourceId !== this.scope.sourceId ||
            intent.Item.ownerMessageId !== row.messageId ||
            intent.Item.objectId !== row.object.id ||
            intent.Item.size !== row.object.size ||
            intent.Item.sha256 !== row.object.sha256 ||
            !Number.isSafeInteger(intent.Item.holdCount) ||
            intent.Item.holdCount < 1 ||
            intent.Item.deletionPending !== undefined ||
            claim.Item?.owner !==
              hash(
                JSON.stringify([
                  this.scope.tenantId,
                  this.scope.connectionId,
                  this.scope.sourceId,
                ]),
              )
          )
            throw failure();
          const bytes = await this.gate.run(this.scope, () =>
            this.objects.get(this.scope.tenantId, row.object.id, {
              size: row.object.size,
              sha256: row.object.sha256,
            }),
          );
          if (!bytes || (total += bytes.byteLength) > 2 * 1024 * 1024)
            throw failure();
          items.push({
            messageId: row.messageId,
            objectId: row.object.id,
            text: new TextDecoder("utf-8", { fatal: true }).decode(bytes),
          });
        }
        if (!(await this.permitted())) throw failure();
        return { items, more: !!page.LastEvaluatedKey };
      });
      if (!(await this.permitted())) return { status: "unavailable" };
      return result.status === "ready"
        ? { status: "ready", ...result.value }
        : { status: "unavailable" };
    } catch {
      return { status: "unavailable" };
    }
  }

  /** Discard requires an authorized explicit decision; retain is disabled pending multi-owner coordination. */
  async finishProcessing(input: {
    messageId: string;
    objectId: string;
    outcome:
      | { kind: "discard" }
      | { kind: "retain"; holdKind: "role" | "evidence"; holdId: string };
  }): Promise<{ status: "completed" | "unavailable" }> {
    const messageId = input?.messageId;
    const objectId = input?.objectId;
    const outcome = input?.outcome && { ...input.outcome };
    if (
      typeof messageId !== "string" ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(messageId) ||
      typeof objectId !== "string" ||
      !/^go_[a-f0-9]{32}$/.test(objectId) ||
      !outcome ||
      (outcome.kind !== "discard" &&
        (outcome.kind !== "retain" ||
          !["role", "evidence"].includes(outcome.holdKind) ||
          typeof outcome.holdId !== "string" ||
          !/^[A-Za-z0-9_-]{1,128}$/.test(outcome.holdId))) ||
      !(await this.permitted())
    )
      return { status: "unavailable" };
    if (outcome.kind === "retain" && !retainedOutcomesSupported())
      return { status: "unavailable" };
    if (
      outcome.kind === "retain" &&
      !(await this.holdPermitted(outcome.holdKind, outcome.holdId))
    )
      return { status: "unavailable" };
    const lease = await this.state.lease.acquire(this.scope).catch(() => null);
    if (!lease) return { status: "unavailable" };
    try {
      const pk = `gmail#${hash(JSON.stringify([this.scope.tenantId, this.scope.connectionId]))}`;
      const source = hash(this.scope.sourceId);
      const decision =
        outcome.kind === "discard"
          ? "discard"
          : JSON.stringify([outcome.kind, outcome.holdKind, outcome.holdId]);
      const decisionKey = {
        pk,
        sk: `processing-outcome#${source}#${objectId}`,
      };
      const prior = (
        await this.db.send(
          new GetCommand({
            TableName: this.table,
            Key: decisionKey,
            ConsistentRead: true,
          }),
          { abortSignal: AbortSignal.timeout(5000) },
        )
      ).Item;
      if (prior && prior.decision !== decision) throw failure();
      await this.db.send(
        new TransactWriteCommand({
          TransactItems: [
            connectedCondition(this.table, this.scope),
            ...(!prior
              ? [
                  {
                    ConditionCheck: {
                      TableName: this.table,
                      Key: { pk, sk: `attempt#${source}` },
                      ConditionExpression: "#status = :complete",
                      ExpressionAttributeNames: { "#status": "status" },
                      ExpressionAttributeValues: { ":complete": "complete" },
                    },
                  },
                  {
                    ConditionCheck: {
                      TableName: this.table,
                      Key: {
                        pk,
                        sk: `ledger#${source}#message#${hash(messageId)}`,
                      },
                      ConditionExpression:
                        "active = :active AND #object.#id = :id AND messageId = :message",
                      ExpressionAttributeNames: {
                        "#object": "object",
                        "#id": "id",
                      },
                      ExpressionAttributeValues: {
                        ":active": true,
                        ":id": objectId,
                        ":message": messageId,
                      },
                    },
                  },
                ]
              : []),
            {
              ConditionCheck: {
                TableName: this.table,
                Key: { pk, sk: "lease" },
                ConditionExpression:
                  "#generation = :generation AND expiresAt > :now",
                ExpressionAttributeNames: { "#generation": "generation" },
                ExpressionAttributeValues: {
                  ":generation": Number(lease.fence),
                  ":now": Date.now(),
                },
              },
            },
            {
              ConditionCheck: {
                TableName: this.table,
                Key: { pk, sk: `object#${source}#${objectId}` },
                ConditionExpression:
                  "objectId = :id AND ownerMessageId = :message AND sourceId = :source",
                ExpressionAttributeValues: {
                  ":id": objectId,
                  ":message": messageId,
                  ":source": this.scope.sourceId,
                },
              },
            },
            {
              Update: {
                TableName: this.table,
                Key: decisionKey,
                UpdateExpression:
                  "SET decision = :decision, messageId = :message, objectId = :object, #status = if_not_exists(#status, :pending)",
                ConditionExpression:
                  "attribute_not_exists(pk) OR (decision = :decision AND messageId = :message AND objectId = :object)",
                ExpressionAttributeNames: { "#status": "status" },
                ExpressionAttributeValues: {
                  ":decision": decision,
                  ":message": messageId,
                  ":object": objectId,
                  ":pending": "pending",
                },
              },
            },
          ],
        }),
        { abortSignal: AbortSignal.timeout(5000) },
      );
      if (outcome.kind === "retain")
        await this.holds.add(
          this.scope,
          objectId,
          { kind: outcome.holdKind, id: outcome.holdId },
          lease.fence,
        );
      await this.holds.release(
        this.scope,
        objectId,
        { kind: "processing", id: "initial" },
        lease.fence,
      );
      await this.db.send(
        new TransactWriteCommand({
          TransactItems: [
            connectedCondition(this.table, this.scope),
            {
              ConditionCheck: {
                TableName: this.table,
                Key: { pk, sk: "lease" },
                ConditionExpression:
                  "#generation = :generation AND expiresAt > :now",
                ExpressionAttributeNames: { "#generation": "generation" },
                ExpressionAttributeValues: {
                  ":generation": Number(lease.fence),
                  ":now": Date.now(),
                },
              },
            },
            {
              Update: {
                TableName: this.table,
                Key: decisionKey,
                UpdateExpression: "SET #status = :complete",
                ConditionExpression:
                  "decision = :decision AND messageId = :message AND objectId = :object",
                ExpressionAttributeNames: { "#status": "status" },
                ExpressionAttributeValues: {
                  ":complete": "complete",
                  ":decision": decision,
                  ":message": messageId,
                  ":object": objectId,
                },
              },
            },
          ],
        }),
        { abortSignal: AbortSignal.timeout(5000) },
      );
      return { status: "completed" };
    } catch {
      return { status: "unavailable" };
    } finally {
      await this.state.lease
        .release(this.scope, lease.fence)
        .catch(() => undefined);
    }
  }

  /** Replays a bounded page. Repeat sweeps from the beginning; cursors are not a quiescence proof. */
  async recoverProcessing(
    cursor?: string,
  ): Promise<{ status: "completed" | "unavailable"; next: string | null }> {
    if (!(await this.permitted())) return { status: "unavailable", next: null };
    try {
      const pk = `gmail#${hash(JSON.stringify([this.scope.tenantId, this.scope.connectionId]))}`;
      const prefix = `processing-outcome#${hash(this.scope.sourceId)}#`;
      if (
        cursor !== undefined &&
        (typeof cursor !== "string" ||
          !new RegExp(`^${prefix}go_[a-f0-9]{32}$`).test(cursor))
      )
        throw failure();
      const page = await this.db.send(
        new QueryCommand({
          TableName: this.table,
          KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
          ExpressionAttributeValues: {
            ":pk": pk,
            ":prefix": prefix,
          },
          ConsistentRead: true,
          Limit: 20,
          ...(cursor ? { ExclusiveStartKey: { pk, sk: cursor } } : {}),
        }),
        { abortSignal: AbortSignal.timeout(5000) },
      );
      for (const item of page.Items ?? []) {
        if (
          typeof item.messageId !== "string" ||
          !/^[A-Za-z0-9_-]{1,128}$/.test(item.messageId) ||
          typeof item.objectId !== "string" ||
          !/^go_[a-f0-9]{32}$/.test(item.objectId) ||
          item.sk !== `${prefix}${item.objectId}` ||
          typeof item.decision !== "string" ||
          (item.status !== "pending" && item.status !== "complete")
        )
          throw failure();
        const parts: unknown =
          item.decision === "discard" ? null : JSON.parse(item.decision);
        const outcome =
          item.decision === "discard"
            ? { kind: "discard" as const }
            : Array.isArray(parts) &&
                parts.length === 3 &&
                parts[0] === "retain" &&
                (parts[1] === "role" || parts[1] === "evidence") &&
                typeof parts[2] === "string" &&
                JSON.stringify(parts) === item.decision
              ? {
                  kind: "retain" as const,
                  holdKind: parts[1] as "role" | "evidence",
                  holdId: parts[2],
                }
              : null;
        if (
          !outcome ||
          (outcome.kind === "retain" &&
            !/^[A-Za-z0-9_-]{1,128}$/.test(outcome.holdId))
        )
          throw failure();
        if (item.status === "complete") continue;
        if (
          (
            await this.finishProcessing({
              messageId: item.messageId,
              objectId: item.objectId,
              outcome,
            })
          ).status !== "completed"
        )
          throw failure();
      }
      const next = page.LastEvaluatedKey?.sk;
      if (
        next !== undefined &&
        (typeof next !== "string" ||
          !new RegExp(`^${prefix}go_[a-f0-9]{32}$`).test(next))
      )
        throw failure();
      return { status: "completed", next: next ?? null };
    } catch {
      return { status: "unavailable", next: null };
    }
  }

  /** The trusted caller releases the exact role/evidence ownership it supplied. */
  async releaseRetained(input: {
    messageId: string;
    objectId: string;
    holdKind: "role" | "evidence";
    holdId: string;
  }): Promise<{ status: "completed" | "unavailable" }> {
    if (!retainedOutcomesSupported()) return { status: "unavailable" };
    const { messageId, objectId, holdKind, holdId } = input ?? {};
    if (
      typeof messageId !== "string" ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(messageId) ||
      typeof objectId !== "string" ||
      !/^go_[a-f0-9]{32}$/.test(objectId) ||
      (holdKind !== "role" && holdKind !== "evidence") ||
      typeof holdId !== "string" ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(holdId) ||
      !(await this.permitted())
    )
      return { status: "unavailable" };
    if (!(await this.holdPermitted(holdKind, holdId)))
      return { status: "unavailable" };
    const lease = await this.state.lease.acquire(this.scope).catch(() => null);
    if (!lease) return { status: "unavailable" };
    try {
      const pk = `gmail#${hash(JSON.stringify([this.scope.tenantId, this.scope.connectionId]))}`;
      const source = hash(this.scope.sourceId);
      await this.db.send(
        new TransactWriteCommand({
          TransactItems: [
            connectedCondition(this.table, this.scope),
            {
              ConditionCheck: {
                TableName: this.table,
                Key: { pk, sk: "lease" },
                ConditionExpression:
                  "#generation = :generation AND expiresAt > :now",
                ExpressionAttributeNames: { "#generation": "generation" },
                ExpressionAttributeValues: {
                  ":generation": Number(lease.fence),
                  ":now": Date.now(),
                },
              },
            },
            {
              ConditionCheck: {
                TableName: this.table,
                Key: { pk, sk: `object#${source}#${objectId}` },
                ConditionExpression:
                  "objectId = :id AND ownerMessageId = :message AND sourceId = :source",
                ExpressionAttributeValues: {
                  ":id": objectId,
                  ":message": messageId,
                  ":source": this.scope.sourceId,
                },
              },
            },
            {
              ConditionCheck: {
                TableName: this.table,
                Key: { pk, sk: `processing-outcome#${source}#${objectId}` },
                ConditionExpression: "decision = :decision",
                ExpressionAttributeValues: {
                  ":decision": JSON.stringify(["retain", holdKind, holdId]),
                },
              },
            },
            {
              ConditionCheck: {
                TableName: this.table,
                Key: {
                  pk,
                  sk: `hold#${source}#${objectId}#${hash(JSON.stringify(["processing", "initial"]))}`,
                },
                ConditionExpression: "#status = :released",
                ExpressionAttributeNames: { "#status": "status" },
                ExpressionAttributeValues: { ":released": "released" },
              },
            },
          ],
        }),
        { abortSignal: AbortSignal.timeout(5000) },
      );
      await this.holds.release(
        this.scope,
        objectId,
        { kind: holdKind, id: holdId },
        lease.fence,
      );
      return { status: "completed" };
    } catch {
      return { status: "unavailable" };
    } finally {
      await this.state.lease
        .release(this.scope, lease.fence)
        .catch(() => undefined);
    }
  }

  /** Known objects and provider credentials are retried independently; full deletion is not yet verifiable. */
  async disconnect(): Promise<GmailLocalDisconnect> {
    if (!(await this.permitted())) return { status: "denied" };
    const reasons: Extract<
      GmailLocalDisconnect,
      { status: "incomplete" }
    >["reasons"] = ["legacy_content_unverified", "quotations_unverified"];
    try {
      await this.connections
        .withRefreshLock(this.refreshLock)
        .disconnect(this.scope);
    } catch {
      return {
        status: "incomplete",
        reasons: ["connection_stop_pending", ...reasons],
      };
    }
    try {
      await this.revocation.revoke(this.scope);
    } catch {
      reasons.unshift("provider_revocation_pending");
    }
    let lease: { fence: string } | null;
    try {
      lease = await this.state.lease.acquire(this.scope);
    } catch {
      lease = null;
    }
    if (!lease)
      return { status: "incomplete", reasons: ["sync_busy", ...reasons] };
    try {
      await this.disconnectCoordinator.disconnect(this.scope, lease.fence);
    } catch {
      reasons.unshift("object_purge_pending");
    } finally {
      try {
        await this.state.lease.release(this.scope, lease.fence);
      } catch {
        /* expiry handles release */
      }
    }
    return { status: "incomplete", reasons };
  }
  close(): void {
    this.db.destroy();
  }
}
