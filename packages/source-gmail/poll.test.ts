import { describe, expect, it, vi } from "vitest";
import { GmailCredentialRemediationRequired } from "./refresh.js";
import {
  pollGmail,
  GmailBoundaryError,
  type GmailClient,
  type PollDependencies,
} from "./poll.js";

const scope = {
  tenantId: "tenant-1",
  connectionId: "connection-1",
  sourceId: "gmail",
};
const config = {
  version: "v1",
  query: "from:alerts@example.test",
  labelIds: ["jobs"],
};

function setup(
  initial: {
    historyId: string;
    configVersion: string;
    revision: number;
  } | null = null,
) {
  let checkpoint = initial;
  const seen = new Set<string>();
  const policy = { check: vi.fn(async () => true) };
  const client: GmailClient = {
    watermark: vi.fn(async () => "100"),
    list: vi.fn(async () => ({ messageIds: ["m1"], nextPageToken: null })),
    history: vi.fn(async () => ({
      messageIds: ["m1", "m2"],
      nextPageToken: null,
      historyId: "102",
    })),
    reconcile: vi.fn(async (_scope, messageId) => ({
      kind: "eligible" as const,
      messageId,
      revision: "101",
      text: `synthetic ${messageId}`,
    })),
  };
  const checkpoints = {
    load: vi.fn(async () => checkpoint),
  } satisfies PollDependencies["checkpoints"];
  const lease = {
    acquire: vi.fn(async (): Promise<{ fence: string } | null> => ({
      fence: "fence1",
    })),
    release: vi.fn(async () => {}),
  };
  const ledger = {
    beginFullSync: vi.fn(async () => {}),
    finishFullSync: vi.fn(async () => {}),
    apply: vi.fn(async (_scope, item) => {
      seen.add(`${item.messageId}:${item.revision}`);
    }),
  };
  const claims = {
    hasClaim: vi.fn(async () => true),
    claim: vi.fn(
      async (): Promise<{ status: "created" | "existing" | "conflict" }> => ({
        status: initial ? "existing" : "created",
      }),
    ),
  };
  const attempts = {
    isInitialized: vi.fn(async () => true),
    begin: vi.fn(async () => {}),
    publish: vi.fn(async (_scope, _fence, expected, next) => {
      if ((checkpoint?.revision ?? null) !== expected) return false;
      checkpoint = next;
      return true;
    }),
  };
  const deps = {
    policy,
    client,
    checkpoints,
    lease,
    ledger,
    claims,
    attempts,
  } satisfies PollDependencies;
  return { deps, seen, getCheckpoint: () => checkpoint };
}

describe("Gmail polling boundary", () => {
  it("returns a sanitized remediation status when issued credentials cannot be secured", async () => {
    const { deps } = setup();
    vi.mocked(deps.client.watermark).mockRejectedValue(
      new GmailCredentialRemediationRequired(),
    );
    expect(await pollGmail(scope, config, deps)).toEqual({
      status: "manual_remediation_required",
    });
  });
  it("rejects unverified legacy checkpoints and changed version claims before Gmail access", async () => {
    const prior = { historyId: "11", configVersion: "v1", revision: 1 };
    const legacy = setup(prior);
    legacy.deps.claims.claim.mockResolvedValue({ status: "created" });
    expect(await pollGmail(scope, config, legacy.deps)).toEqual({
      status: "failed",
    });
    expect(legacy.deps.client.history).not.toHaveBeenCalled();
    const changed = setup(prior);
    changed.deps.claims.claim.mockResolvedValue({ status: "conflict" });
    expect(await pollGmail(scope, config, changed.deps)).toEqual({
      status: "failed",
    });
    expect(changed.deps.client.history).not.toHaveBeenCalled();
    const missingMarker = setup(prior);
    missingMarker.deps.attempts.isInitialized.mockResolvedValue(false);
    expect(await pollGmail(scope, config, missingMarker.deps)).toEqual({
      status: "failed",
    });
    expect(missingMarker.deps.claims.claim).not.toHaveBeenCalled();
    const missingClaim = setup(prior);
    missingClaim.deps.claims.hasClaim.mockResolvedValue(false);
    expect(await pollGmail(scope, config, missingClaim.deps)).toEqual({
      status: "failed",
    });
    expect(missingClaim.deps.claims.claim).not.toHaveBeenCalled();
  });
  it("uses a watermark before paginated full listing and reconciles history before committing", async () => {
    const { deps, seen, getCheckpoint } = setup();
    vi.mocked(deps.client.list)
      .mockResolvedValueOnce({ messageIds: ["m1"], nextPageToken: "next" })
      .mockResolvedValueOnce({ messageIds: ["m2"], nextPageToken: null });
    const result = await pollGmail(scope, config, deps);
    expect(result).toEqual({ status: "completed", mode: "full" });
    expect(
      vi.mocked(deps.client.watermark).mock.invocationCallOrder[0],
    ).toBeLessThan(vi.mocked(deps.client.list).mock.invocationCallOrder[0]!);
    expect(deps.client.history).toHaveBeenCalledWith(
      expect.objectContaining({ startHistoryId: "100" }),
    );
    expect(seen).toEqual(new Set(["m1:101", "m2:101"]));
    expect(getCheckpoint()).toEqual({
      historyId: "102",
      configVersion: "v1",
      revision: 1,
    });
    expect(deps.policy.check).toHaveBeenCalledTimes(8);
  });
  it("uses the stored history checkpoint and advances only after every page", async () => {
    const { deps, getCheckpoint } = setup({
      historyId: "11",
      configVersion: "v1",
      revision: 4,
    });
    vi.mocked(deps.client.history)
      .mockResolvedValueOnce({
        messageIds: ["m1"],
        nextPageToken: "page2",
        historyId: "12",
      })
      .mockResolvedValueOnce({
        messageIds: ["m2"],
        nextPageToken: null,
        historyId: "14",
      });
    expect(await pollGmail(scope, config, deps)).toEqual({
      status: "completed",
      mode: "incremental",
    });
    expect(deps.client.watermark).not.toHaveBeenCalled();
    expect(getCheckpoint()).toEqual({
      historyId: "14",
      configVersion: "v1",
      revision: 5,
    });
  });
  it("denies before calling Gmail when policy is unavailable, denied or throws", async () => {
    for (const authorize of [
      vi.fn(async () => false),
      vi.fn(async () => {
        throw new Error("sensitive policy");
      }),
    ]) {
      const { deps } = setup();
      deps.policy.check = authorize;
      expect(await pollGmail(scope, config, deps)).toEqual({
        status: "policy_denied",
      });
      expect(deps.client.watermark).not.toHaveBeenCalled();
    }
  });
  it("does not advance on failed page, failed durable write or uncertain eligibility", async () => {
    for (const failure of ["page", "write", "uncertain"]) {
      const { deps, getCheckpoint } = setup({
        historyId: "11",
        configVersion: "v1",
        revision: 2,
      });
      if (failure === "page")
        vi.mocked(deps.client.history).mockRejectedValue(
          new Error("private content"),
        );
      if (failure === "write")
        deps.ledger.apply.mockRejectedValue(new Error("secret"));
      if (failure === "uncertain")
        vi.mocked(deps.client.reconcile).mockResolvedValue({
          kind: "unknown",
          messageId: "m1",
        });
      expect(await pollGmail(scope, config, deps)).toEqual({
        status: "failed",
      });
      expect(getCheckpoint()?.historyId).toBe("11");
      expect(deps.attempts.publish).not.toHaveBeenCalled();
    }
  });
  it("returns reconnect on revoked access without changing checkpoint", async () => {
    const { deps, getCheckpoint } = setup({
      historyId: "11",
      configVersion: "v1",
      revision: 1,
    });
    vi.mocked(deps.client.history).mockRejectedValue(
      new GmailBoundaryError("revoked"),
    );
    expect(await pollGmail(scope, config, deps)).toEqual({
      status: "reconnect_required",
    });
    expect(getCheckpoint()?.historyId).toBe("11");
  });
  it("runs a full reconciliation when history expires or config changes", async () => {
    const { deps } = setup({
      historyId: "11",
      configVersion: "v1",
      revision: 1,
    });
    vi.mocked(deps.client.history).mockRejectedValueOnce(
      new GmailBoundaryError("history_expired"),
    );
    expect(await pollGmail(scope, config, deps)).toEqual({
      status: "completed",
      mode: "full",
    });
    expect(deps.client.watermark).toHaveBeenCalledOnce();
    const changed = setup({
      historyId: "11",
      configVersion: "old",
      revision: 1,
    });
    changed.deps.claims.claim.mockResolvedValue({ status: "created" });
    expect(await pollGmail(scope, config, changed.deps)).toEqual({
      status: "completed",
      mode: "full",
    });
    expect(changed.deps.client.watermark).toHaveBeenCalledOnce();
  });
  it("does not commit when history expires again during full sync", async () => {
    const { deps, getCheckpoint } = setup();
    vi.mocked(deps.client.history).mockRejectedValue(
      new GmailBoundaryError("history_expired"),
    );
    expect(await pollGmail(scope, config, deps)).toEqual({
      status: "resync_required",
    });
    expect(getCheckpoint()).toBeNull();
  });
  it("fails on repeated page tokens and bounds pages", async () => {
    const { deps } = setup();
    vi.mocked(deps.client.list).mockResolvedValue({
      messageIds: [],
      nextPageToken: "same",
    });
    expect(await pollGmail(scope, config, deps)).toEqual({ status: "failed" });
    expect(deps.attempts.publish).not.toHaveBeenCalled();
    const limited = setup();
    vi.mocked(limited.deps.client.list).mockResolvedValueOnce({
      messageIds: [],
      nextPageToken: "next",
    });
    expect(
      await pollGmail(scope, config, limited.deps, { maxPages: 1 }),
    ).toEqual({ status: "failed" });
  });
  it("returns conflict when a concurrent sync wins the checkpoint compare-and-set", async () => {
    const { deps } = setup();
    deps.attempts.publish.mockResolvedValue(false);
    expect(await pollGmail(scope, config, deps)).toEqual({
      status: "checkpoint_conflict",
    });
  });
  it("does not dispatch when an exclusive sync lease is unavailable", async () => {
    const { deps } = setup();
    deps.lease.acquire.mockResolvedValue(null);
    expect(await pollGmail(scope, config, deps)).toEqual({ status: "busy" });
    expect(deps.client.watermark).not.toHaveBeenCalled();
  });
  it("does not commit when full reconciliation cannot complete", async () => {
    const { deps } = setup();
    deps.ledger.finishFullSync.mockRejectedValue(new Error("private"));
    expect(await pollGmail(scope, config, deps)).toEqual({ status: "failed" });
    expect(deps.attempts.publish).not.toHaveBeenCalled();
    expect(deps.lease.release).toHaveBeenCalledWith(scope, "fence1");
  });
  it("rejects history watermark regressions before changing the checkpoint", async () => {
    const { deps, getCheckpoint } = setup({
      historyId: "100",
      configVersion: "v1",
      revision: 1,
    });
    vi.mocked(deps.client.history).mockResolvedValue({
      messageIds: [],
      nextPageToken: null,
      historyId: "99",
    });
    expect(await pollGmail(scope, config, deps)).toEqual({ status: "failed" });
    expect(getCheckpoint()?.historyId).toBe("100");
  });
  it("reconciles excluded messages instead of treating them as unseen", async () => {
    const { deps } = setup();
    vi.mocked(deps.client.reconcile).mockResolvedValue({
      kind: "excluded",
      messageId: "m1",
      revision: "101",
    });
    vi.mocked(deps.client.history).mockResolvedValue({
      messageIds: [],
      nextPageToken: null,
      historyId: "103",
    });
    expect(await pollGmail(scope, config, deps)).toEqual({
      status: "completed",
      mode: "full",
    });
    expect(deps.ledger.apply).toHaveBeenCalledWith(
      scope,
      expect.objectContaining({ kind: "excluded", messageId: "m1" }),
      "fence1",
    );
  });
});
