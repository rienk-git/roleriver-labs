import { GmailCredentialRemediationRequired } from "./refresh.js";

/** The caller authenticates and authorizes these identifiers independently. */
export interface PollScope {
  tenantId: string;
  connectionId: string;
  sourceId: string;
}

/** Version must change whenever the selection configuration changes. */
export interface PollConfig {
  version: string;
  query: string;
  labelIds: string[];
}

export interface Checkpoint {
  historyId: string;
  configVersion: string;
  /** Store-issued compare-and-set generation, not a Gmail history ID. */
  revision: number;
}

export type ReconciledMessage =
  | { kind: "eligible"; messageId: string; revision: string; text: string }
  | { kind: "excluded"; messageId: string; revision: string }
  | { kind: "unknown"; messageId: string };

/** Thrown by the boundary adapter without placing provider content in the error. */
export class GmailBoundaryError extends Error {
  constructor(readonly kind: "history_expired" | "revoked") {
    super("Gmail boundary failure");
  }
}

/**
 * Each method represents exactly one bounded Gmail API dispatch. The transport must
 * independently enforce policy for redirects and any additional requests.
 */
export interface GmailClient {
  watermark(scope: PollScope): Promise<string>;
  list(options: {
    scope: PollScope;
    query: string;
    labelIds: string[];
    pageToken?: string;
  }): Promise<{ messageIds: string[]; nextPageToken: string | null }>;
  history(options: {
    scope: PollScope;
    startHistoryId: string;
    pageToken?: string;
  }): Promise<{
    messageIds: string[];
    nextPageToken: string | null;
    historyId: string;
  }>;
  /** Must check the current selection using the Gmail API; unknown cannot be treated as excluded. */
  reconcile(
    scope: PollScope,
    messageId: string,
    config: PollConfig,
  ): Promise<ReconciledMessage>;
}

export interface PollDependencies {
  claims: {
    hasClaim(
      scope: PollScope,
      version: string,
      fence: string,
    ): Promise<boolean>;
    claim(
      scope: PollScope,
      config: PollConfig,
      fence: string,
    ): Promise<{ status: "created" | "existing" | "conflict" }>;
  };
  attempts: {
    isInitialized(scope: PollScope): Promise<boolean>;
    begin(
      scope: PollScope,
      fence: string,
      mode: "full" | "incremental",
    ): Promise<void>;
    publish(
      scope: PollScope,
      fence: string,
      expectedRevision: number | null,
      next: Checkpoint,
    ): Promise<boolean>;
  };
  /** Non-consuming permission preflight; the HTTP adapter must independently authorize each dispatch. */
  policy: {
    check(
      scope: PollScope,
      method: "email",
      host: "gmail.googleapis.com",
    ): Promise<boolean>;
  };
  client: GmailClient;
  checkpoints: {
    load(scope: PollScope): Promise<Checkpoint | null>;
  };
  /** Lease acquisition is exclusive per tenant/connection; fence generations must never repeat. */
  lease: {
    acquire(scope: PollScope): Promise<{ fence: string } | null>;
    release(scope: PollScope, fence: string): Promise<void>;
  };
  /**
   * Durably reconcile an eligible or excluded message idempotently by tenant, connection,
   * message ID and Gmail revision. It must not allow an older revision to overwrite a newer
   * one. Completion means all required writes are durable; failures must throw.
   * Every mutation must reject a stale fence atomically. Full-sync begin/finish must durably
   * reconcile removals and config changes, mark every observed message in the current
   * reconciliation even if its revision was already stored, be idempotent on retry,
   * and reject stale fences. A partial full sync must be safe to restart.
   * This port is not an implementation or a claim of cross-store atomicity.
   */
  ledger: {
    beginFullSync(
      scope: PollScope,
      config: PollConfig,
      fence: string,
    ): Promise<void>;
    finishFullSync(
      scope: PollScope,
      config: PollConfig,
      fence: string,
    ): Promise<void>;
    apply(
      scope: PollScope,
      message: Exclude<ReconciledMessage, { kind: "unknown" }>,
      fence: string,
    ): Promise<void>;
  };
}

export type PollResult =
  | { status: "completed"; mode: "full" | "incremental" }
  | {
      status:
        | "policy_denied"
        | "reconnect_required"
        | "resync_required"
        | "checkpoint_conflict"
        | "busy"
        | "manual_remediation_required"
        | "failed";
    };

class PolicyDenied extends Error {}
const identity = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const historyId = (value: unknown): value is string =>
  typeof value === "string" && /^\d{1,32}$/.test(value);
const token = (value: unknown): value is string | null =>
  value === null ||
  (typeof value === "string" && value.length > 0 && value.length <= 2048);

/**
 * Explicit orchestration only: no credentials, network client, or durable stores are supplied.
 * Full sync takes a watermark before listing and replays history afterwards. A checkpoint is
 * advanced only after every page and reconciliation has been durably processed. The policy
 * gate is consulted before each API call, including reconciliation; provider errors never leak.
 */
export async function pollGmail(
  scope: PollScope,
  config: PollConfig,
  deps: PollDependencies,
  limits: { maxPages?: number; maxMessages?: number } = {},
): Promise<PollResult> {
  const maxPages = limits.maxPages ?? 100;
  const maxMessages = limits.maxMessages ?? 10000;
  if (
    !identity(scope.tenantId) ||
    !identity(scope.connectionId) ||
    !identity(scope.sourceId) ||
    !identity(config.version) ||
    typeof config.query !== "string" ||
    config.query.length > 4096 ||
    !Array.isArray(config.labelIds) ||
    config.labelIds.length > 100 ||
    !config.labelIds.every(identity) ||
    !Number.isSafeInteger(maxPages) ||
    maxPages < 1 ||
    maxPages > 1000 ||
    !Number.isSafeInteger(maxMessages) ||
    maxMessages < 1 ||
    maxMessages > 100000
  )
    return { status: "failed" };

  // Claims, credentials and all requests use the same immutable scope and selection.
  scope = Object.freeze({ ...scope });
  config = Object.freeze({
    ...config,
    labelIds: Object.freeze([...config.labelIds]) as unknown as string[],
  });

  let messageCount = 0;
  let activeFence: string | undefined;
  const dispatch = async <T>(fn: () => Promise<T>): Promise<T> => {
    let permitted = false;
    try {
      permitted =
        (await deps.policy.check(scope, "email", "gmail.googleapis.com")) ===
        true;
    } catch {
      /* deny on policy failure */
    }
    if (!permitted) throw new PolicyDenied();
    return fn();
  };
  const reconcile = async (ids: string[]): Promise<void> => {
    if (!Array.isArray(ids)) throw new Error("Invalid message list");
    for (const messageId of ids) {
      if (!identity(messageId) || ++messageCount > maxMessages)
        throw new Error("Invalid message list");
      const item = await dispatch(() =>
        deps.client.reconcile(scope, messageId, config),
      );
      if (!item || item.messageId !== messageId || item.kind === "unknown")
        throw new Error("Uncertain message eligibility");
      if (
        (item.kind !== "eligible" && item.kind !== "excluded") ||
        !historyId(item.revision)
      )
        throw new Error("Invalid message reconciliation");
      if (
        item.kind === "eligible" &&
        (typeof item.text !== "string" || item.text.length > 1024 * 1024)
      )
        throw new Error("Invalid message content");
      await deps.ledger.apply(scope, item, activeFence!);
    }
  };
  const listAll = async (): Promise<void> => {
    let next: string | null = null;
    const visited = new Set<string>();
    for (let page = 0; page < maxPages; page++) {
      const current: string | null = next;
      const result: Awaited<ReturnType<GmailClient["list"]>> = await dispatch(
        () =>
          deps.client.list({
            scope,
            query: config.query,
            labelIds: config.labelIds,
            ...(current ? { pageToken: current } : {}),
          }),
      );
      if (!result || !token(result.nextPageToken))
        throw new Error("Invalid listing response");
      await reconcile(result.messageIds);
      next = result.nextPageToken;
      if (next === null) return;
      if (visited.has(next)) throw new Error("Repeated page token");
      visited.add(next);
    }
    throw new Error("Page limit reached");
  };
  const historyAll = async (startHistoryId: string): Promise<string> => {
    let next: string | null = null;
    const visited = new Set<string>();
    for (let page = 0; page < maxPages; page++) {
      const current: string | null = next;
      const result: Awaited<ReturnType<GmailClient["history"]>> =
        await dispatch(() =>
          deps.client.history({
            scope,
            startHistoryId,
            ...(current ? { pageToken: current } : {}),
          }),
        );
      if (
        !result ||
        !token(result.nextPageToken) ||
        !historyId(result.historyId)
      )
        throw new Error("Invalid history response");
      await reconcile(result.messageIds);
      next = result.nextPageToken;
      if (next === null) {
        if (BigInt(result.historyId) < BigInt(startHistoryId))
          throw new Error("History regression");
        return result.historyId;
      }
      if (visited.has(next)) throw new Error("Repeated page token");
      visited.add(next);
    }
    throw new Error("Page limit reached");
  };
  try {
    const lease = await deps.lease.acquire(scope);
    if (!lease) return { status: "busy" };
    if (!identity(lease.fence)) return { status: "failed" };
    activeFence = lease.fence;
    const previous = await deps.checkpoints.load(scope);
    if (
      previous &&
      (!historyId(previous.historyId) ||
        !identity(previous.configVersion) ||
        !Number.isSafeInteger(previous.revision) ||
        previous.revision < 1 ||
        previous.revision === Number.MAX_SAFE_INTEGER)
    )
      return { status: "failed" };
    let mode: "full" | "incremental" =
      previous && previous.configVersion === config.version
        ? "incremental"
        : "full";
    if (previous && !(await deps.attempts.isInitialized(scope)))
      return { status: "failed" };
    if (
      previous &&
      !(await deps.claims.hasClaim(scope, previous.configVersion, activeFence))
    )
      return { status: "failed" };
    const claim = await deps.claims.claim(scope, config, activeFence);
    if (
      !claim ||
      (claim.status !== "created" && claim.status !== "existing") ||
      (previous &&
        previous.configVersion === config.version &&
        claim.status === "created")
    )
      return { status: "failed" };
    if (mode === "incremental") {
      try {
        await deps.attempts.begin(scope, activeFence, mode);
      } catch {
        // A previous attempt may have stopped mid-write. Full recovery is required.
        mode = "full";
        await deps.attempts.begin(scope, activeFence, mode);
      }
    } else await deps.attempts.begin(scope, activeFence, mode);
    let nextHistoryId: string;
    const full = async (): Promise<string> => {
      const watermark = await dispatch(() => deps.client.watermark(scope));
      if (!historyId(watermark)) throw new Error("Invalid watermark");
      await deps.ledger.beginFullSync(scope, config, activeFence!);
      await listAll();
      const finalHistoryId = await historyAll(watermark);
      await deps.ledger.finishFullSync(scope, config, activeFence!);
      return finalHistoryId;
    };
    if (mode === "incremental") {
      try {
        nextHistoryId = await historyAll(previous!.historyId);
      } catch (error) {
        if (
          !(error instanceof GmailBoundaryError) ||
          error.kind !== "history_expired"
        )
          throw error;
        mode = "full";
        await deps.attempts.begin(scope, activeFence, mode);
        nextHistoryId = await full();
      }
    } else nextHistoryId = await full();
    if (previous && BigInt(nextHistoryId) < BigInt(previous.historyId))
      return { status: "failed" };
    const updated = await deps.attempts.publish(
      scope,
      activeFence,
      previous?.revision ?? null,
      {
        historyId: nextHistoryId,
        configVersion: config.version,
        revision: (previous?.revision ?? 0) + 1,
      },
    );
    return updated
      ? { status: "completed", mode }
      : { status: "checkpoint_conflict" };
  } catch (error) {
    if (error instanceof GmailCredentialRemediationRequired)
      return { status: "manual_remediation_required" };
    if (error instanceof PolicyDenied) return { status: "policy_denied" };
    if (error instanceof GmailBoundaryError && error.kind === "revoked")
      return { status: "reconnect_required" };
    if (error instanceof GmailBoundaryError && error.kind === "history_expired")
      return { status: "resync_required" };
    return { status: "failed" };
  } finally {
    if (activeFence) {
      try {
        await deps.lease.release(scope, activeFence);
      } catch {
        /* lease expiry handles release failures */
      }
    }
  }
}
