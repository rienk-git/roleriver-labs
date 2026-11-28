import type { PollScope } from "../source-gmail/poll.js";
import type { TenantObjectBarrier } from "./gmail-objects.js";
import { GmailConnectionRepository } from "./gmail-connection.js";

/** Must share the same process-wide tenant barrier as object writes and purge. */
export class GmailDispatchGate {
  constructor(
    private readonly connections: GmailConnectionRepository,
    private readonly barrier: TenantObjectBarrier,
  ) {}
  async run<T>(scope: PollScope, operation: () => Promise<T>): Promise<T> {
    if (!scope) throw new Error("Gmail dispatch denied");
    scope = Object.freeze({ ...scope });
    return this.barrier.exclusive(scope.tenantId, async () => {
      const state = await this.connections.snapshot(scope);
      if (!state || state.status !== "connected")
        throw new Error("Gmail dispatch denied");
      return operation();
    });
  }
}

/** Token storage uses a separate barrier acquisition, never nested in a Gmail request. */
export class GmailTokenGate {
  constructor(private readonly dispatch: GmailDispatchGate) {}
  run<T>(
    tenant: string,
    connection: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    return this.dispatch.run(
      { tenantId: tenant, connectionId: connection, sourceId: "oauth" },
      operation,
    );
  }
}

/** Allows only disconnected revocation cleanup under the tenant barrier. */
export class GmailDisconnectedTokenGate {
  constructor(
    private readonly connections: GmailConnectionRepository,
    private readonly barrier: TenantObjectBarrier,
  ) {}
  async run<T>(
    tenant: string,
    connection: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const scope = Object.freeze({
      tenantId: tenant,
      connectionId: connection,
      sourceId: "oauth",
    });
    return this.barrier.exclusive(tenant, async () => {
      await this.connections.revocationState(scope);
      return operation();
    });
  }
}
