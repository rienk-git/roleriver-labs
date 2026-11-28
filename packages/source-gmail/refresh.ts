/* Provider failures may contain credentials; never attach them as causes. */
/* eslint-disable preserve-caught-error */
import { createHash } from "node:crypto";
import type { PollScope } from "./poll.js";
import type { GoogleTokens } from "./oauth.js";
import type { StoredGmailTokens } from "./token-store.js";

/** Issued credentials could not be stored or revoked; do not log provider data. */
export class GmailCredentialRemediationRequired extends Error {
  readonly code = "manual_remediation_required";
  constructor() {
    super("Gmail credentials require manual remediation");
  }
}

export interface RefreshLock {
  run<T>(
    key: string,
    operation: () => Promise<T>,
  ): Promise<{ status: "busy" } | { status: "completed"; value: T }>;
}
/** Stable private lock namespace for one tenant/connection; not anonymization. */
export function gmailRefreshLockKey(scope: PollScope): string {
  if (
    !scope ||
    typeof scope.tenantId !== "string" ||
    !/^[A-Za-z0-9_-]{1,64}$/.test(scope.tenantId) ||
    typeof scope.connectionId !== "string" ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(scope.connectionId)
  )
    throw new Error("Gmail refresh failed");
  return `rf_${createHash("sha256")
    .update(JSON.stringify([scope.tenantId, scope.connectionId]))
    .digest("hex")
    .slice(0, 60)}`;
}

/**
 * The cross-process refresh lock must use a separate root from the non-reentrant
 * tenant dispatch gate. All refreshers for a connection must share that root.
 * Token storage and OAuth refresh each independently gate against disconnect.
 */
export class GmailRefreshCoordinator {
  private readonly tenant: string;
  private readonly connection: string;
  private readonly lockKey: string;
  constructor(
    scope: PollScope,
    private readonly tokens: {
      get(
        tenant: string,
        connection: string,
      ): Promise<StoredGmailTokens | null>;
      put(
        tenant: string,
        connection: string,
        tokens: StoredGmailTokens,
      ): Promise<void>;
    },
    private readonly oauth: {
      refresh(token: string): Promise<GoogleTokens>;
      revoke(token: string): Promise<void>;
    },
    private readonly lock: RefreshLock,
    private readonly now: () => number = Date.now,
  ) {
    if (
      !scope ||
      typeof scope.tenantId !== "string" ||
      !/^[A-Za-z0-9_-]{1,64}$/.test(scope.tenantId) ||
      typeof scope.connectionId !== "string" ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(scope.connectionId)
    )
      throw new Error("Gmail refresh failed");
    this.tenant = scope.tenantId;
    this.connection = scope.connectionId;
    this.lockKey = gmailRefreshLockKey(scope);
  }
  /** Busy is a sanitized failure; callers may retry. Never log token material. */
  async accessToken(scope: PollScope): Promise<string> {
    if (
      !scope ||
      scope.tenantId !== this.tenant ||
      scope.connectionId !== this.connection
    )
      throw new Error("Gmail refresh failed");
    try {
      const result = await this.lock.run(this.lockKey, async () => {
        const stored = await this.tokens.get(this.tenant, this.connection);
        const before = this.now();
        if (
          !stored ||
          typeof stored.refreshToken !== "string" ||
          !stored.refreshToken ||
          !Number.isSafeInteger(before) ||
          before < 0
        )
          throw new Error("invalid credentials");
        if (
          stored.accessToken &&
          Number.isSafeInteger(stored.expiresAt) &&
          stored.expiresAt! > before &&
          stored.expiresAt! - before > 30000
        )
          return stored.accessToken;
        const refreshed = await this.oauth.refresh(stored.refreshToken);
        try {
          const after = this.now();
          const expiresAt = after + refreshed.expiresIn * 1000;
          if (
            !Number.isSafeInteger(after) ||
            after < 0 ||
            typeof refreshed.accessToken !== "string" ||
            !refreshed.accessToken ||
            !Number.isSafeInteger(refreshed.expiresIn) ||
            refreshed.expiresIn < 1 ||
            !Number.isSafeInteger(expiresAt) ||
            (refreshed.refreshToken !== undefined &&
              (typeof refreshed.refreshToken !== "string" ||
                !refreshed.refreshToken))
          )
            throw new Error("invalid provider response");
          await this.tokens.put(this.tenant, this.connection, {
            accessToken: refreshed.accessToken,
            refreshToken: refreshed.refreshToken ?? stored.refreshToken,
            expiresAt,
          });
        } catch (error) {
          if (
            typeof refreshed?.refreshToken === "string" &&
            refreshed.refreshToken
          ) {
            try {
              await this.oauth.revoke(refreshed.refreshToken);
            } catch {
              throw new GmailCredentialRemediationRequired();
            }
          }
          throw error;
        }
        return refreshed.accessToken;
      });
      if (
        result.status !== "completed" ||
        typeof result.value !== "string" ||
        !result.value
      )
        throw new Error("refresh busy");
      return result.value;
    } catch (error) {
      if (error instanceof GmailCredentialRemediationRequired) throw error;
      throw new Error("Gmail refresh failed");
    }
  }
}

/** Code exchange and initial token persistence share the refresh/disconnect lock. */
export class GmailConnectionProvisioner {
  private readonly scope: PollScope;
  private readonly lockKey: string;
  constructor(
    scope: PollScope,
    private readonly tokens: {
      get(
        tenant: string,
        connection: string,
      ): Promise<StoredGmailTokens | null>;
      put(
        tenant: string,
        connection: string,
        tokens: StoredGmailTokens,
      ): Promise<void>;
    },
    private readonly oauth: {
      complete(callbackUrl: string): Promise<GoogleTokens>;
      revoke(token: string): Promise<void>;
    },
    private readonly lock: RefreshLock,
    private readonly now: () => number = Date.now,
  ) {
    this.lockKey = gmailRefreshLockKey(scope);
    this.scope = Object.freeze({ ...scope });
  }
  async complete(callbackUrl: string): Promise<void> {
    try {
      const result = await this.lock.run(this.lockKey, async () => {
        if (await this.tokens.get(this.scope.tenantId, this.scope.connectionId))
          throw new Error("existing connection requires identity review");
        const issued = await this.oauth.complete(callbackUrl);
        try {
          const refreshToken = issued.refreshToken;
          const time = this.now();
          const expiresAt = time + issued.expiresIn * 1000;
          if (
            typeof refreshToken !== "string" ||
            !refreshToken ||
            typeof issued.accessToken !== "string" ||
            !issued.accessToken ||
            !Number.isSafeInteger(issued.expiresIn) ||
            issued.expiresIn < 1 ||
            !Number.isSafeInteger(time) ||
            time < 0 ||
            !Number.isSafeInteger(expiresAt)
          )
            throw new Error("invalid credentials");
          await this.tokens.put(this.scope.tenantId, this.scope.connectionId, {
            refreshToken,
            accessToken: issued.accessToken,
            expiresAt,
          });
        } catch (error) {
          // The provider has issued credentials, but local persistence failed.
          // Best effort only: a process crash or failed revoke needs manual remediation.
          const token =
            typeof issued?.refreshToken === "string" && issued.refreshToken
              ? issued.refreshToken
              : issued?.accessToken;
          if (typeof token === "string" && token) {
            try {
              await this.oauth.revoke(token);
            } catch {
              throw new GmailCredentialRemediationRequired();
            }
          } else throw new GmailCredentialRemediationRequired();
          throw error;
        }
      });
      if (result.status !== "completed") throw new Error("refresh in progress");
    } catch (error) {
      if (error instanceof GmailCredentialRemediationRequired) throw error;
      throw new Error("Gmail connection failed");
    }
  }
}
