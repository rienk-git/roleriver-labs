import { describe, expect, it, vi } from "vitest";
import {
  createSourcePolicyGate,
  InMemoryRateLimiter,
} from "../source-policy/policy.js";
import { createGmailClient } from "./client.js";
import { pollGmail, type PollDependencies } from "./poll.js";
import { GmailRefreshCoordinator } from "./refresh.js";

const scope = {
  tenantId: "tenant",
  connectionId: "connection",
  sourceId: "gmail",
};
const request = {
  sourceId: "gmail",
  method: "email" as const,
  targetUrl: "https://gmail.googleapis.com/",
};
const config = {
  sources: [
    {
      id: "gmail",
      methods: {
        email: {
          enabled: true,
          evidence: "synthetic approval",
          reviewedOn: "2026-11-01",
          expiresOn: "2026-12-01",
          allowedHosts: ["gmail.googleapis.com"],
          rateLimit: { requests: 5, windowMs: 60000 },
        },
      },
    },
  ],
};
const response = (body: unknown) => new Response(JSON.stringify(body));

describe("Gmail policy composition", () => {
  it("propagates sanitized remediation from a failed refresh through the real client and poller", async () => {
    const policy = createSourcePolicyGate(
      config,
      () => new Date("2026-11-27T12:00:00Z"),
      new InMemoryRateLimiter(),
    );
    const fetcher = vi.fn<typeof fetch>();
    const refresh = new GmailRefreshCoordinator(
      scope,
      {
        get: async () => ({ refreshToken: "old" }),
        put: async () => {
          throw new Error("private persistence failure");
        },
      },
      {
        refresh: async () => ({
          accessToken: "access",
          refreshToken: "rotated-secret",
          expiresIn: 3600,
        }),
        revoke: async () => {
          throw new Error("private provider failure");
        },
      },
      {
        run: async (_key, operation) => ({
          status: "completed",
          value: await operation(),
        }),
      },
      () => 100000,
    );
    const check = async (
      actualScope: typeof scope,
      method: "email",
      host: "gmail.googleapis.com",
    ) =>
      (
        await policy.check({
          sourceId: actualScope.sourceId,
          method,
          targetUrl: `https://${host}/`,
        })
      ).allowed;
    const client = createGmailClient({
      fetch: fetcher,
      gate: { run: async (_scope, operation) => operation() },
      accessToken: (actualScope) => refresh.accessToken(actualScope),
      check,
      authorize: async (actualScope, method, host) =>
        (
          await policy.authorize({
            sourceId: actualScope.sourceId,
            method,
            targetUrl: `https://${host}/`,
          })
        ).allowed,
    });
    const deps: PollDependencies = {
      policy: { check },
      client,
      claims: {
        hasClaim: async () => false,
        claim: async () => ({ status: "created" }),
      },
      attempts: {
        isInitialized: async () => false,
        begin: async () => {},
        publish: async () => true,
      },
      checkpoints: { load: async () => null },
      lease: { acquire: async () => ({ fence: "1" }), release: async () => {} },
      ledger: {
        beginFullSync: async () => {},
        apply: async () => {},
        finishFullSync: async () => {},
      },
    };
    expect(
      await pollGmail(scope, { version: "v1", query: "", labelIds: [] }, deps),
    ).toEqual({ status: "manual_remediation_required" });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("spends exactly one permit for each actual Gmail request, including both message requests", async () => {
    const limiter = new InMemoryRateLimiter();
    const consume = vi.spyOn(limiter, "consume");
    const policy = createSourcePolicyGate(
      config,
      () => new Date("2026-11-27T12:00:00Z"),
      limiter,
    );
    const responses = [
      response({ historyId: "10" }),
      response({ messages: [{ id: "message" }] }),
      response({
        id: "message",
        historyId: "10",
        labelIds: ["INBOX"],
        payload: { mimeType: "text/plain", filename: "" },
      }),
      response({
        id: "message",
        historyId: "10",
        labelIds: ["INBOX"],
        payload: {
          mimeType: "text/plain",
          filename: "",
          body: { data: "aGVsbG8" },
        },
      }),
      response({ historyId: "11" }),
    ];
    const fetcher = vi.fn<typeof fetch>(async () => responses.shift()!);
    const check = async (
      actualScope: typeof scope,
      method: "email",
      host: "gmail.googleapis.com",
    ) =>
      (
        await policy.check({
          sourceId: actualScope.sourceId,
          method,
          targetUrl: `https://${host}/`,
        })
      ).allowed;
    const client = createGmailClient({
      fetch: fetcher,
      gate: { run: async (_scope, operation) => operation() },
      accessToken: async () => "synthetic",
      check,
      authorize: async (actualScope, method, host) =>
        (
          await policy.authorize({
            sourceId: actualScope.sourceId,
            method,
            targetUrl: `https://${host}/`,
          })
        ).allowed,
    });
    const deps: PollDependencies = {
      policy: { check },
      client,
      claims: {
        hasClaim: async () => false,
        claim: async () => ({ status: "created" }),
      },
      attempts: {
        isInitialized: async () => false,
        begin: async () => {},
        publish: async () => true,
      },
      checkpoints: { load: async () => null },
      lease: { acquire: async () => ({ fence: "1" }), release: async () => {} },
      ledger: {
        beginFullSync: async () => {},
        apply: async () => {},
        finishFullSync: async () => {},
      },
    };
    expect(
      await pollGmail(
        scope,
        { version: "v1", query: "", labelIds: ["INBOX"] },
        deps,
      ),
    ).toEqual({ status: "completed", mode: "full" });
    expect(fetcher).toHaveBeenCalledTimes(5);
    expect(consume).toHaveBeenCalledTimes(5);
    expect((await policy.check(request)).allowed).toBe(true);
    expect((await policy.authorize(request)).allowed).toBe(false);
  });
  it("rechecks expiry after credential acquisition and before dispatch", async () => {
    let now = new Date("2026-11-27T12:00:00Z");
    const limiter = new InMemoryRateLimiter();
    const consume = vi.spyOn(limiter, "consume");
    const policy = createSourcePolicyGate(config, () => now, limiter);
    const fetcher = vi.fn<typeof fetch>();
    const client = createGmailClient({
      fetch: fetcher,
      gate: { run: async (_scope, operation) => operation() },
      accessToken: async () => {
        now = new Date("2026-12-02T12:00:00Z");
        return "synthetic";
      },
      check: async (actualScope, method, host) =>
        (
          await policy.check({
            sourceId: actualScope.sourceId,
            method,
            targetUrl: `https://${host}/`,
          })
        ).allowed,
      authorize: async (actualScope, method, host) =>
        (
          await policy.authorize({
            sourceId: actualScope.sourceId,
            method,
            targetUrl: `https://${host}/`,
          })
        ).allowed,
    });
    await expect(client.watermark(scope)).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
    expect(consume).not.toHaveBeenCalled();
  });
  it("uses the supplied source and host and sees a policy disabled before dispatch", async () => {
    let current = config;
    const limiter = new InMemoryRateLimiter();
    const consume = vi.spyOn(limiter, "consume");
    const policy = createSourcePolicyGate(
      () => current,
      () => new Date("2026-11-27T12:00:00Z"),
      limiter,
    );
    const fetcher = vi.fn<typeof fetch>();
    const token = vi.fn(async () => {
      current = { sources: [] };
      return "synthetic";
    });
    const client = createGmailClient({
      fetch: fetcher,
      gate: { run: async (_scope, operation) => operation() },
      accessToken: token,
      check: async (s, method, host) =>
        (
          await policy.check({
            sourceId: s.sourceId,
            method,
            targetUrl: `https://${host}/`,
          })
        ).allowed,
      authorize: async (s, method, host) =>
        (
          await policy.authorize({
            sourceId: s.sourceId,
            method,
            targetUrl: `https://${host}/`,
          })
        ).allowed,
    });
    await expect(
      client.watermark({ ...scope, sourceId: "unknown" }),
    ).rejects.toThrow();
    expect(token).not.toHaveBeenCalled();
    expect(
      (
        await policy.check({
          ...request,
          targetUrl: "https://other.example.test/",
        })
      ).allowed,
    ).toBe(false);
    await expect(client.watermark(scope)).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
    expect(consume).not.toHaveBeenCalled();
  });
});
