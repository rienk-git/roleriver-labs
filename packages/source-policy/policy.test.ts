import { describe, expect, it, vi } from "vitest";
import {
  createSourcePolicyGate,
  InMemoryRateLimiter,
  type PolicyConfig,
  type RateLimiter,
} from "./policy.js";

const now = new Date("2026-11-27T12:00:00Z");
const capability = {
  enabled: true,
  evidence: "Owner-approved source access",
  reviewedOn: "2026-11-20",
  expiresOn: "2026-12-01",
  allowedHosts: ["jobs.example.test"],
  rateLimit: { requests: 2, windowMs: 60_000 },
};
const config: PolicyConfig = {
  sources: [{ id: "example", methods: { public_html: capability } }],
};
function setup(value: unknown = config, permitted = true) {
  const limiter = {
    consume: vi.fn(async (...args: Parameters<RateLimiter["consume"]>) => {
      void args;
      return permitted;
    }),
  };
  const gate = createSourcePolicyGate(value, () => now, limiter);
  return { gate, limiter };
}
const request = {
  sourceId: "example",
  method: "public_html" as const,
  targetUrl: "https://jobs.example.test/role",
};

describe("source access policy", () => {
  it("allows only the explicit method and exact permitted host", async () => {
    const { gate } = setup();
    expect((await gate.authorize(request)).allowed).toBe(true);
    expect(
      (await gate.authorize({ ...request, method: "browser_automation" }))
        .allowed,
    ).toBe(false);
    expect(
      (await gate.authorize({ ...request, sourceId: "unknown" })).allowed,
    ).toBe(false);
    expect(
      (
        await gate.authorize({
          ...request,
          targetUrl: "https://other.example.test/role",
        })
      ).allowed,
    ).toBe(false);
    expect(
      (
        await gate.authorize({
          ...request,
          targetUrl: "https://jobs.example.test.evil.test/role",
        })
      ).allowed,
    ).toBe(false);
  });
  it("rechecks a redirect target before dispatch", async () => {
    const { gate } = setup();
    const dispatch = vi.fn(async () => "ok");
    const first = await gate.dispatch(request, dispatch);
    const redirected = await gate.dispatch(
      { ...request, targetUrl: "https://other.example.test/" },
      dispatch,
    );
    expect(first).toEqual({ allowed: true, value: "ok" });
    expect(redirected.allowed).toBe(false);
    expect(dispatch).toHaveBeenCalledTimes(1);
  });
  it("denies disabled, missing evidence, invalid dates, stale or future reviews before rate limiting", async () => {
    for (const altered of [
      { enabled: false },
      { evidence: " " },
      { reviewedOn: "2026-02-30" },
      { expiresOn: "2026-11-26" },
      { reviewedOn: "2026-11-28" },
      { rateLimit: { requests: 0, windowMs: 60_000 } },
    ]) {
      const { gate, limiter } = setup({
        sources: [
          {
            id: "example",
            methods: { public_html: { ...capability, ...altered } },
          },
        ],
      });
      expect((await gate.authorize(request)).allowed).toBe(false);
      expect(limiter.consume).not.toHaveBeenCalled();
    }
  });
  it("enforces rate limits atomically via the injected limiter and fails closed on limiter errors", async () => {
    const { gate, limiter } = setup(config, false);
    expect((await gate.authorize(request)).allowed).toBe(false);
    expect(limiter.consume).toHaveBeenCalledTimes(1);
    limiter.consume.mockRejectedValueOnce(new Error("private source payload"));
    expect((await gate.authorize(request)).allowed).toBe(false);
  });
  it("denies unsafe URL forms and requires a target for network methods", async () => {
    const { gate } = setup();
    for (const targetUrl of [
      undefined,
      "http://jobs.example.test/a",
      "https://user:secret@jobs.example.test/a",
      "https://jobs.example.test/a#fragment",
      "https://jobs.example.test\\@evil.test/",
    ]) {
      expect((await gate.authorize({ ...request, targetUrl })).allowed).toBe(
        false,
      );
    }
  });
  it("prohibits LinkedIn scraping and browser automation even if explicitly configured", async () => {
    const linked = { ...capability, allowedHosts: ["www.linkedin.com"] };
    const { gate } = setup({
      sources: [
        {
          id: "linkedin",
          methods: {
            public_html: linked,
            browser_automation: linked,
            official_api: linked,
          },
        },
      ],
    });
    const base = {
      sourceId: "linkedin",
      targetUrl: "https://www.linkedin.com/jobs/1",
    };
    for (const method of [
      "public_html",
      "browser_automation",
      "official_api",
    ] as const) {
      expect((await gate.authorize({ ...base, method })).allowed).toBe(false);
    }
  });
  it("allows LinkedIn official API only with explicit official authorization, never HTML even under a different source", async () => {
    const allowed = {
      ...capability,
      allowedHosts: ["api.linkedin.com"],
      officialApi: true,
    };
    const { gate } = setup({
      sources: [
        { id: "linkedin", methods: { official_api: allowed } },
        {
          id: "other",
          methods: {
            public_html: { ...capability, allowedHosts: ["www.linkedin.com"] },
          },
        },
      ],
    });
    expect(
      (
        await gate.authorize({
          sourceId: "linkedin",
          method: "official_api",
          targetUrl: "https://api.linkedin.com/v2/jobs",
        })
      ).allowed,
    ).toBe(true);
    expect(
      (
        await gate.authorize({
          sourceId: "other",
          method: "public_html",
          targetUrl: "https://www.linkedin.com/jobs",
        })
      ).allowed,
    ).toBe(false);
  });
  it("cannot relabel direct LinkedIn retrieval as a feed or email", async () => {
    const configured = { ...capability, allowedHosts: ["www.linkedin.com"] };
    const { gate } = setup({
      sources: [
        { id: "other", methods: { feed: configured, email: configured } },
      ],
    });
    for (const method of ["feed", "email"] as const) {
      expect(
        (
          await gate.authorize({
            sourceId: "other",
            method,
            targetUrl: "https://www.linkedin.com/jobs",
          })
        ).allowed,
      ).toBe(false);
    }
  });
  it("shares each capability rate limit across its allowed hosts", async () => {
    const { gate, limiter } = setup({
      sources: [
        {
          id: "example",
          methods: {
            public_html: {
              ...capability,
              allowedHosts: ["jobs.example.test", "other.example.test"],
            },
          },
        },
      ],
    });
    await gate.authorize(request);
    await gate.authorize({
      ...request,
      targetUrl: "https://other.example.test/",
    });
    expect(limiter.consume.mock.calls[0]?.[0].key).toBe(
      limiter.consume.mock.calls[1]?.[0].key,
    );
  });
  it("fails closed on malformed runtime requests", async () => {
    const { gate, limiter } = setup();
    const malformed = { ...request, targetUrl: 42 } as unknown as Parameters<
      typeof gate.authorize
    >[0];
    expect((await gate.authorize(malformed)).allowed).toBe(false);
    expect(
      (
        await gate.authorize(
          null as unknown as Parameters<typeof gate.authorize>[0],
        )
      ).allowed,
    ).toBe(false);
    expect(limiter.consume).not.toHaveBeenCalled();
  });
  it("fails closed if the injected clock fails", async () => {
    const gate = createSourcePolicyGate(
      config,
      () => {
        throw new Error("clock failure");
      },
      { consume: vi.fn() },
    );
    expect((await gate.authorize(request)).allowed).toBe(false);
  });
  it("supports independently enabled manual import without a network URL", async () => {
    const { gate } = setup({
      sources: [
        {
          id: "manual",
          methods: { manual_import: { ...capability, allowedHosts: [] } },
        },
      ],
    });
    expect(
      (await gate.authorize({ sourceId: "manual", method: "manual_import" }))
        .allowed,
    ).toBe(true);
    expect(
      (
        await gate.authorize({
          sourceId: "manual",
          method: "manual_import",
          targetUrl: "https://jobs.example.test",
        })
      ).allowed,
    ).toBe(false);
  });
  it("does not trust changes to the original config object after creation", async () => {
    const mutable = structuredClone(config);
    const { gate } = setup(mutable);
    mutable.sources[0]!.methods.public_html!.enabled = false;
    expect((await gate.authorize(request)).allowed).toBe(true);
  });
});

describe("in-memory rate limiter", () => {
  it("limits concurrent permits per fixed window and resets only after the window expires", async () => {
    const limiter = new InMemoryRateLimiter();
    const base = { key: "source", requests: 2, windowMs: 60_000, now };
    expect(
      await Promise.all([
        limiter.consume(base),
        limiter.consume(base),
        limiter.consume(base),
      ]),
    ).toEqual([true, true, false]);
    expect(
      await limiter.consume({ ...base, now: new Date(now.getTime() + 59_999) }),
    ).toBe(false);
    expect(
      await limiter.consume({ ...base, now: new Date(now.getTime() + 60_000) }),
    ).toBe(true);
    expect(
      await limiter.consume({ ...base, now: new Date(now.getTime() - 1) }),
    ).toBe(false);
  });
  it("fails closed when capacity is exhausted and reclaims expired buckets", async () => {
    const limiter = new InMemoryRateLimiter(1);
    const base = { requests: 1, windowMs: 60_000, now };
    expect(await limiter.consume({ ...base, key: "a" })).toBe(true);
    expect(await limiter.consume({ ...base, key: "b" })).toBe(false);
    expect(
      await limiter.consume({
        ...base,
        key: "b",
        now: new Date(now.getTime() + 60_000),
      }),
    ).toBe(true);
  });
});
