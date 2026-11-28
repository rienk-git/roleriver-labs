import type { PollScope } from "../source-gmail/poll.js";
import {
  gmailRefreshLockKey,
  type RefreshLock,
} from "../source-gmail/refresh.js";
import type {
  EncryptedTokenStore,
  GmailDisconnectedRevocation,
} from "../source-gmail/token-store.js";
import type { SourcePolicyGate } from "../source-policy/policy.js";
import { GmailConnectionRepository } from "./gmail-connection.js";
import { GmailDisconnectedTokenGate } from "./gmail-dispatch.js";

/** Only trusted bootstrap code may construct and pass this binding to token storage. */
export function bindGmailRevocation(
  scope: PollScope,
  connections: GmailConnectionRepository,
  gate: GmailDisconnectedTokenGate,
  policy: SourcePolicyGate,
  fetcher: typeof fetch,
): GmailDisconnectedRevocation {
  scope = Object.freeze({ ...scope });
  return {
    tenant: scope.tenantId,
    connection: scope.connectionId,
    gate,
    state: () => connections.revocationState(scope),
    authorize: async () =>
      (
        await policy.authorize({
          sourceId: scope.sourceId,
          method: "email",
          targetUrl: "https://oauth2.googleapis.com/revoke",
        })
      ).allowed,
    markRevoked: () => connections.markProviderRevoked(scope),
    markNoIssuance: () => connections.markNoIssuance(scope),
    markDeleted: () => connections.markTokensDeleted(scope),
    fetcher,
  };
}

/** Narrow provider-revocation path; this does not claim overall disconnect completion. */
export class GmailRevocationCoordinator {
  constructor(
    private readonly tokens: EncryptedTokenStore,
    private readonly refreshLock: RefreshLock,
  ) {}
  /** Caller must authorize the connection; all refreshers share this refresh lock. */
  async revoke(scope: PollScope): Promise<void> {
    if (!scope) throw new Error("Gmail revocation failed");
    scope = Object.freeze({ ...scope });
    try {
      const result = await this.refreshLock.run(
        gmailRefreshLockKey(scope),
        () => this.tokens.revokeAndDelete(scope.tenantId, scope.connectionId),
      );
      if (result.status !== "completed") throw new Error("refresh in progress");
    } catch {
      throw new Error("Gmail revocation failed");
    }
  }
}
