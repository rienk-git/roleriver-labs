import { describe, expect, it, vi } from "vitest";
import { pollGmail, type Checkpoint, type PollDependencies } from "./poll.js";

function fixture() {
  let checkpoint: Checkpoint | null = null;
  let claimed = false;
  let losePublishResponse = false;
  const deps: PollDependencies = {
    claims: {
      hasClaim: vi.fn(async () => claimed),
      claim: vi.fn(async () => {
        const status: "existing" | "created" = claimed ? "existing" : "created";
        claimed = true;
        return { status };
      }),
    },
    attempts: {
      isInitialized: vi.fn(async () => checkpoint !== null),
      begin: vi.fn(async () => {}),
      publish: vi.fn(async (_scope, _fence, expected, next) => {
        if ((checkpoint?.revision ?? null) !== expected) return false;
        checkpoint = next;
        if (losePublishResponse) {
          losePublishResponse = false;
          throw new Error("synthetic timeout after commit");
        }
        return true;
      }),
    },
    checkpoints: { load: vi.fn(async () => checkpoint) },
    lease: {
      acquire: vi.fn(async () => ({ fence: "1" })),
      release: vi.fn(async () => {}),
    },
    policy: { check: vi.fn(async () => true) },
    client: {
      watermark: vi.fn(async () => "10"),
      list: vi.fn(async () => ({
        messageIds: ["message"],
        nextPageToken: null,
      })),
      history: vi.fn(async () => ({
        messageIds: [],
        nextPageToken: null,
        historyId: "11",
      })),
      reconcile: vi.fn(async (_scope, messageId) => ({
        kind: "eligible" as const,
        messageId,
        revision: "10",
        text: "synthetic",
      })),
    },
    ledger: {
      beginFullSync: vi.fn(async () => {}),
      finishFullSync: vi.fn(async () => {}),
      apply: vi.fn(async () => {}),
    },
  };
  return {
    deps,
    loseNextPublish: () => {
      losePublishResponse = true;
    },
    checkpoint: () => checkpoint,
  };
}

describe("poll recovery and configuration snapshot", () => {
  it("uses the original scope and selection even if caller objects change during acquisition", async () => {
    const { deps } = fixture();
    const scope = {
      tenantId: "tenant",
      connectionId: "connection",
      sourceId: "source",
    };
    const config = {
      version: "v1",
      query: "from:jobs@example.test",
      labelIds: ["jobs"],
    };
    vi.mocked(deps.lease.acquire).mockImplementation(async () => {
      scope.tenantId = "other";
      config.version = "v2";
      config.query = "changed";
      config.labelIds.push("other");
      return { fence: "1" };
    });
    expect(await pollGmail(scope, config, deps)).toEqual({
      status: "completed",
      mode: "full",
    });
    const expectedScope = {
      tenantId: "tenant",
      connectionId: "connection",
      sourceId: "source",
    };
    const expectedConfig = {
      version: "v1",
      query: "from:jobs@example.test",
      labelIds: ["jobs"],
    };
    expect(deps.claims.claim).toHaveBeenCalledWith(
      expectedScope,
      expectedConfig,
      "1",
    );
    expect(deps.client.list).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: expectedScope,
        query: expectedConfig.query,
        labelIds: expectedConfig.labelIds,
      }),
    );
    expect(deps.client.reconcile).toHaveBeenCalledWith(
      expectedScope,
      "message",
      expectedConfig,
    );
    expect(deps.attempts.publish).toHaveBeenCalledWith(
      expectedScope,
      "1",
      null,
      expect.objectContaining({ configVersion: "v1" }),
    );
  });

  it("reloads the checkpoint on retry when publication commits but its response is lost", async () => {
    const { deps, checkpoint, loseNextPublish } = fixture();
    const scope = {
      tenantId: "tenant",
      connectionId: "connection",
      sourceId: "source",
    };
    const config = { version: "v1", query: "", labelIds: [] };
    loseNextPublish();
    expect(await pollGmail(scope, config, deps)).toEqual({ status: "failed" });
    expect(checkpoint()).toEqual({
      historyId: "11",
      configVersion: "v1",
      revision: 1,
    });
    expect(await pollGmail(scope, config, deps)).toEqual({
      status: "completed",
      mode: "incremental",
    });
    expect(deps.client.history).toHaveBeenLastCalledWith(
      expect.objectContaining({ startHistoryId: "11" }),
    );
    expect(checkpoint()).toEqual({
      historyId: "11",
      configVersion: "v1",
      revision: 2,
    });
  });
});
