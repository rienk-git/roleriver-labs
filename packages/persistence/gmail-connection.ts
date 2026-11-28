import { createHash } from "node:crypto";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import type { PollScope } from "../source-gmail/poll.js";
import {
  gmailRefreshLockKey,
  type RefreshLock,
} from "../source-gmail/refresh.js";

const failed = () => new Error("Gmail connection operation failed");
export function gmailConnectionKey(scope: PollScope) {
  if (
    !scope ||
    typeof scope.tenantId !== "string" ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(scope.tenantId) ||
    typeof scope.connectionId !== "string" ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(scope.connectionId)
  )
    throw failed();
  const hash = createHash("sha256")
    .update(JSON.stringify([scope.tenantId, scope.connectionId]))
    .digest("hex");
  return { pk: `gmail#${hash}`, sk: "connection" };
}

/** Transaction condition only; caller must independently authenticate scope. */
export function connectedCondition(table: string, scope: PollScope) {
  return {
    ConditionCheck: {
      TableName: table,
      Key: gmailConnectionKey(scope),
      ConditionExpression: "#status = :connected",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: { ":connected": "connected" },
    },
  };
}

/** Allows cleanup after disconnection, but never for an unknown connection. */
export function connectionExistsCondition(table: string, scope: PollScope) {
  return {
    ConditionCheck: {
      TableName: table,
      Key: gmailConnectionKey(scope),
      ConditionExpression: "#status = :connected OR #status = :disconnected",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: {
        ":connected": "connected",
        ":disconnected": "disconnected",
      },
    },
  };
}

export function disconnectedCondition(table: string, scope: PollScope) {
  return {
    ConditionCheck: {
      TableName: table,
      Key: gmailConnectionKey(scope),
      ConditionExpression: "#status = :disconnected",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: { ":disconnected": "disconnected" },
    },
  };
}

/** Inactive connection state. Disconnect only revokes access and schedules no deletion. */
export class GmailConnectionRepository {
  constructor(
    private readonly client: DynamoDBDocumentClient,
    private readonly table: string,
    private readonly refreshLock?: RefreshLock,
  ) {
    if (!/^[A-Za-z0-9_.-]{3,255}$/.test(table)) throw failed();
  }
  /** Only trusted composition should bind the same lock used by all refreshers. */
  withRefreshLock(refreshLock: RefreshLock): GmailConnectionRepository {
    return new GmailConnectionRepository(this.client, this.table, refreshLock);
  }
  /** Initialize a fresh connection ID exactly once; never reactivate a disconnected ID. */
  async initialize(scope: PollScope): Promise<void> {
    try {
      await this.client.send(
        new PutCommand({
          TableName: this.table,
          Item: {
            ...gmailConnectionKey(scope),
            status: "connected",
            revision: 1,
            issuanceState: "never_started",
          },
          ConditionExpression: "attribute_not_exists(pk)",
        }),
        { abortSignal: AbortSignal.timeout(5000) },
      );
    } catch {
      throw failed();
    }
  }
  /** Mark before any provider exchange; failure or a crash remains ambiguous. */
  async markIssuanceStarted(scope: PollScope): Promise<void> {
    try {
      await this.client.send(
        new UpdateCommand({
          TableName: this.table,
          Key: gmailConnectionKey(scope),
          UpdateExpression: "SET issuanceState = :started",
          ConditionExpression:
            "#status = :connected AND (attribute_not_exists(issuanceState) OR issuanceState = :never OR issuanceState = :started)",
          ExpressionAttributeNames: { "#status": "status" },
          ExpressionAttributeValues: {
            ":connected": "connected",
            ":never": "never_started",
            ":started": "started",
          },
        }),
        { abortSignal: AbortSignal.timeout(5000) },
      );
    } catch {
      throw failed();
    }
  }
  /** Fail closed immediately; deletion and external revocation remain separate pending work. */
  async disconnect(scope: PollScope): Promise<void> {
    if (!scope || !this.refreshLock) throw failed();
    scope = Object.freeze({ ...scope });
    try {
      const result = await this.refreshLock.run(
        gmailRefreshLockKey(scope),
        () => this.#disconnectUnsafe(scope),
      );
      if (result.status !== "completed") throw failed();
    } catch {
      throw failed();
    }
  }
  async #disconnectUnsafe(scope: PollScope): Promise<void> {
    try {
      await this.client.send(
        new UpdateCommand({
          TableName: this.table,
          Key: gmailConnectionKey(scope),
          UpdateExpression:
            "SET #status = :disconnected, #revision = #revision + :one, providerRevocationPending = :pending",
          ConditionExpression: "#status = :connected AND #revision < :max",
          ExpressionAttributeNames: {
            "#status": "status",
            "#revision": "revision",
          },
          ExpressionAttributeValues: {
            ":connected": "connected",
            ":disconnected": "disconnected",
            ":one": 1,
            ":max": Number.MAX_SAFE_INTEGER,
            ":pending": true,
          },
        }),
        { abortSignal: AbortSignal.timeout(5000) },
      );
    } catch {
      try {
        const current = await this.snapshot(scope);
        if (current?.status === "disconnected") {
          await this.client.send(
            new UpdateCommand({
              TableName: this.table,
              Key: gmailConnectionKey(scope),
              UpdateExpression:
                "SET providerRevocationPending = if_not_exists(providerRevocationPending, :pending)",
              ConditionExpression: "#status = :disconnected",
              ExpressionAttributeNames: { "#status": "status" },
              ExpressionAttributeValues: {
                ":pending": true,
                ":disconnected": "disconnected",
              },
            }),
            { abortSignal: AbortSignal.timeout(5000) },
          );
          return;
        }
      } catch {
        /* report a sanitized error */
      }
      throw failed();
    }
  }
  async snapshot(scope: PollScope): Promise<{
    status: "connected" | "disconnected";
    revision: number;
  } | null> {
    try {
      const item = (
        await this.client.send(
          new GetCommand({
            TableName: this.table,
            Key: gmailConnectionKey(scope),
            ConsistentRead: true,
          }),
          { abortSignal: AbortSignal.timeout(5000) },
        )
      ).Item;
      if (!item) return null;
      if (
        (item.status !== "connected" && item.status !== "disconnected") ||
        !Number.isSafeInteger(item.revision) ||
        item.revision < 1
      )
        throw failed();
      return { status: item.status, revision: item.revision };
    } catch {
      throw failed();
    }
  }

  async revocationState(
    scope: PollScope,
  ): Promise<"never_issued" | "pending" | "revoked" | "complete"> {
    try {
      const item = (
        await this.client.send(
          new GetCommand({
            TableName: this.table,
            Key: gmailConnectionKey(scope),
            ConsistentRead: true,
          }),
          { abortSignal: AbortSignal.timeout(5000) },
        )
      ).Item;
      if (!item || item.status !== "disconnected") throw failed();
      if (
        item.issuanceState === "never_started" &&
        item.providerRevocationPending === true &&
        item.providerRevoked === undefined &&
        item.tokensDeleted === undefined
      )
        return "never_issued";
      if (
        item.providerRevocationPending === true &&
        (item.providerRevoked === undefined ||
          item.providerRevoked === false) &&
        (item.tokensDeleted === undefined || item.tokensDeleted === false)
      )
        return "pending";
      if (
        item.providerRevocationPending === false &&
        item.providerRevoked === true &&
        (item.tokensDeleted === undefined || item.tokensDeleted === false)
      )
        return "revoked";
      if (
        item.providerRevocationPending === false &&
        item.providerRevoked === true &&
        item.tokensDeleted === true
      )
        return "complete";
      if (
        item.providerRevocationPending === false &&
        item.providerNotIssued === true &&
        item.providerRevoked === undefined &&
        item.tokensDeleted === true &&
        item.issuanceState === "never_started"
      )
        return "complete";
      throw failed();
    } catch {
      throw failed();
    }
  }

  /** Only after the token store has verified no encrypted token under the cleanup gate. */
  async markNoIssuance(scope: PollScope): Promise<void> {
    try {
      await this.client.send(
        new UpdateCommand({
          TableName: this.table,
          Key: gmailConnectionKey(scope),
          UpdateExpression:
            "SET providerRevocationPending = :no, providerNotIssued = :yes, tokensDeleted = :yes",
          ConditionExpression:
            "#status = :disconnected AND issuanceState = :never AND providerRevocationPending = :yes AND attribute_not_exists(providerRevoked) AND attribute_not_exists(tokensDeleted)",
          ExpressionAttributeNames: { "#status": "status" },
          ExpressionAttributeValues: {
            ":disconnected": "disconnected",
            ":never": "never_started",
            ":yes": true,
            ":no": false,
          },
        }),
        { abortSignal: AbortSignal.timeout(5000) },
      );
    } catch {
      try {
        if ((await this.revocationState(scope)) === "complete") return;
      } catch {
        /* fail closed */
      }
      throw failed();
    }
  }

  async markProviderRevoked(scope: PollScope): Promise<void> {
    try {
      await this.client.send(
        new UpdateCommand({
          TableName: this.table,
          Key: gmailConnectionKey(scope),
          UpdateExpression:
            "SET providerRevocationPending = :no, providerRevoked = :yes",
          ConditionExpression:
            "#status = :disconnected AND providerRevocationPending = :yes AND (attribute_not_exists(providerRevoked) OR providerRevoked = :no) AND (attribute_not_exists(tokensDeleted) OR tokensDeleted = :no)",
          ExpressionAttributeNames: { "#status": "status" },
          ExpressionAttributeValues: {
            ":disconnected": "disconnected",
            ":yes": true,
            ":no": false,
          },
        }),
        { abortSignal: AbortSignal.timeout(5000) },
      );
    } catch {
      try {
        if (["revoked", "complete"].includes(await this.revocationState(scope)))
          return;
      } catch {
        /* fail closed */
      }
      throw failed();
    }
  }

  async markTokensDeleted(scope: PollScope): Promise<void> {
    try {
      await this.client.send(
        new UpdateCommand({
          TableName: this.table,
          Key: gmailConnectionKey(scope),
          UpdateExpression: "SET tokensDeleted = :yes",
          ConditionExpression:
            "#status = :disconnected AND providerRevocationPending = :no AND providerRevoked = :yes",
          ExpressionAttributeNames: { "#status": "status" },
          ExpressionAttributeValues: {
            ":disconnected": "disconnected",
            ":yes": true,
            ":no": false,
          },
        }),
        { abortSignal: AbortSignal.timeout(5000) },
      );
    } catch {
      try {
        if ((await this.revocationState(scope)) === "complete") return;
      } catch {
        /* fail closed */
      }
      throw failed();
    }
  }
}
