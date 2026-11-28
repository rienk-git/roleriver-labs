import { DynamoDBDocumentClient, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import type { PollScope } from "../source-gmail/poll.js";
import type { RefreshLock } from "../source-gmail/refresh.js";
import {
  GmailConnectionRepository,
  gmailConnectionKey,
} from "./gmail-connection.js";
import type {
  GmailObjectLifecycle,
  TenantObjectBarrier,
} from "./gmail-objects.js";

/** Partial local cleanup only; external revocation, quotations and legacy migration remain unresolved. */
export class GmailDisconnectCoordinator {
  constructor(
    private readonly client: DynamoDBDocumentClient,
    private readonly table: string,
    private readonly connections: GmailConnectionRepository,
    private readonly barrier: TenantObjectBarrier,
    private readonly lifecycle: GmailObjectLifecycle,
    private readonly refreshLock: RefreshLock,
  ) {}
  private async record(
    scope: PollScope,
    step: "knownObjectsPurged",
  ): Promise<void> {
    await this.client.send(
      new UpdateCommand({
        TableName: this.table,
        Key: gmailConnectionKey(scope),
        UpdateExpression: "SET #step = :yes",
        ConditionExpression: "#status = :disconnected",
        ExpressionAttributeNames: { "#step": step, "#status": "status" },
        ExpressionAttributeValues: {
          ":yes": true,
          ":disconnected": "disconnected",
        },
      }),
      { abortSignal: AbortSignal.timeout(5000) },
    );
  }
  /** The caller must authorize the connection and make every dispatch/token writer use the same barrier. */
  async disconnect(
    scope: PollScope,
    fence: string,
  ): Promise<{ status: "incomplete" }> {
    if (!scope) throw new Error("Gmail disconnect operation failed");
    scope = Object.freeze({ ...scope });
    try {
      await this.connections
        .withRefreshLock(this.refreshLock)
        .disconnect(scope);
      // Keep the encrypted token until provider revocation can be performed safely.
      // The barrier drains cooperating operations that began before disconnection.
      await this.barrier.exclusive(scope.tenantId, async () => {});
      await this.lifecycle.purgeKnownDisconnectedObjects(scope, fence);
      await this.record(scope, "knownObjectsPurged");
      // Never claim complete while legacy, quotation and provider-revocation work remains.
      return { status: "incomplete" };
    } catch {
      throw new Error("Gmail disconnect operation failed");
    }
  }
}
