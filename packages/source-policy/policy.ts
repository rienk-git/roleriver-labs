import { z } from "zod";

const methods = [
  "email",
  "official_api",
  "feed",
  "public_html",
  "browser_automation",
  "manual_import",
] as const;
export type AccessMethod = (typeof methods)[number];

const dateString = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => {
    const date = new Date(`${value}T00:00:00.000Z`);
    return (
      Number.isFinite(date.getTime()) &&
      date.toISOString().slice(0, 10) === value
    );
  });
const host = z
  .string()
  .regex(
    /^(?=.{1,253}$)[a-z0-9]+(?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9]+(?:[a-z0-9-]*[a-z0-9])?)*$/,
  );
const capabilitySchema = z.strictObject({
  enabled: z.boolean(),
  evidence: z.string().refine((value) => value.trim().length > 0),
  reviewedOn: dateString,
  expiresOn: dateString,
  allowedHosts: z.array(host),
  rateLimit: z.strictObject({
    requests: z.number().int().positive().safe(),
    windowMs: z.number().int().positive().safe(),
  }),
  officialApi: z.boolean().optional(),
});
const configSchema = z
  .strictObject({
    sources: z.array(
      z.strictObject({
        id: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/),
        methods: z.partialRecord(z.enum(methods), capabilitySchema),
      }),
    ),
  })
  .refine(
    ({ sources }) =>
      new Set(sources.map(({ id }) => id)).size === sources.length,
  );
export type PolicyConfig = z.infer<typeof configSchema>;
export type AccessRequest = {
  sourceId: string;
  method: AccessMethod;
  targetUrl?: string;
};
export type Decision =
  | { allowed: true }
  | { allowed: false; reason: "policy_denied" | "rate_limited" };
export interface RateLimiter {
  /** Atomically consume one permit for the source/method/host scope; fail closed on uncertainty. */
  consume(input: {
    key: string;
    requests: number;
    windowMs: number;
    now: Date;
  }): Promise<boolean>;
}
export interface SourcePolicyGate {
  authorize(request: AccessRequest): Promise<Decision>;
  dispatch<T>(
    request: AccessRequest,
    action: () => Promise<T>,
  ): Promise<
    | { allowed: true; value: T }
    | { allowed: false; reason: "policy_denied" | "rate_limited" }
  >;
}

function destination(value: string | undefined): string | undefined {
  if (
    !value ||
    !/^https:\/\//i.test(value) ||
    value.includes("\\") ||
    /\s/u.test(value) ||
    [...value].some((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127;
    })
  )
    return undefined;
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      !url.hostname ||
      url.username ||
      url.password ||
      url.hash ||
      url.port
    )
      return undefined;
    return url.hostname.toLowerCase();
  } catch {
    return undefined;
  }
}
function linkedIn(hostname: string): boolean {
  return hostname === "linkedin.com" || hostname.endsWith(".linkedin.com");
}

/**
 * Config is trusted project policy, never vacancy text or model output. Each network
 * request (including redirects and authenticated session use) needs a new decision.
 * This gate does not replace DNS/IP SSRF checks in the network adapter.
 */
export function createSourcePolicyGate(
  config: unknown,
  clock: () => Date,
  limiter: RateLimiter,
): SourcePolicyGate {
  const parsed = configSchema.safeParse(config);
  const sources = parsed.success ? parsed.data.sources : [];
  async function authorize(request: AccessRequest): Promise<Decision> {
    const validated = z
      .strictObject({
        sourceId: z.string(),
        method: z.enum(methods),
        targetUrl: z.string().optional(),
      })
      .safeParse(request);
    if (!validated.success) return { allowed: false, reason: "policy_denied" };
    request = validated.data;
    const source = sources.find((item) => item.id === request.sourceId);
    const capability = source?.methods[request.method];
    let current: Date;
    try {
      current = clock();
    } catch {
      return { allowed: false, reason: "policy_denied" };
    }
    if (
      !source ||
      !capability?.enabled ||
      !(current instanceof Date) ||
      !Number.isFinite(current.getTime())
    )
      return { allowed: false, reason: "policy_denied" };
    const today = current.toISOString().slice(0, 10);
    if (
      capability.reviewedOn > today ||
      capability.expiresOn < today ||
      capability.expiresOn < capability.reviewedOn
    )
      return { allowed: false, reason: "policy_denied" };
    if (request.method === "manual_import") {
      if (
        request.targetUrl !== undefined ||
        capability.allowedHosts.length !== 0
      )
        return { allowed: false, reason: "policy_denied" };
    } else {
      const hostname = destination(request.targetUrl);
      if (!hostname || !capability.allowedHosts.includes(hostname))
        return { allowed: false, reason: "policy_denied" };
      if (
        (linkedIn(hostname) && request.method !== "official_api") ||
        (source.id === "linkedin" &&
          (request.method === "public_html" ||
            request.method === "browser_automation" ||
            request.method === "feed")) ||
        ((source.id === "linkedin" || linkedIn(hostname)) &&
          request.method === "official_api" &&
          capability.officialApi !== true)
      )
        return { allowed: false, reason: "policy_denied" };
    }
    try {
      const ok = await limiter.consume({
        key: JSON.stringify([source.id, request.method]),
        requests: capability.rateLimit.requests,
        windowMs: capability.rateLimit.windowMs,
        now: new Date(current.getTime()),
      });
      return ok === true
        ? { allowed: true }
        : { allowed: false, reason: "rate_limited" };
    } catch {
      return { allowed: false, reason: "rate_limited" };
    }
  }
  return {
    authorize,
    async dispatch<T>(request: AccessRequest, action: () => Promise<T>) {
      const decision = await authorize(request);
      if (!decision.allowed) return decision;
      return { allowed: true, value: await action() };
    },
  };
}

/** Single-process fixed-window limiter. Multi-process deployments need a shared atomic implementation. */
export class InMemoryRateLimiter implements RateLimiter {
  private readonly buckets = new Map<
    string,
    { start: number; windowMs: number; count: number }
  >();

  constructor(private readonly maxBuckets = 10_000) {
    if (!Number.isSafeInteger(maxBuckets) || maxBuckets < 1)
      throw new Error("Invalid rate limiter capacity");
  }

  async consume(input: {
    key: string;
    requests: number;
    windowMs: number;
    now: Date;
  }): Promise<boolean> {
    const time = input.now.getTime();
    if (
      !input.key ||
      !Number.isFinite(time) ||
      !Number.isSafeInteger(input.requests) ||
      input.requests < 1 ||
      !Number.isSafeInteger(input.windowMs) ||
      input.windowMs < 1
    )
      return false;
    let bucket = this.buckets.get(input.key);
    if (bucket && time < bucket.start) return false;
    if (bucket && time - bucket.start >= bucket.windowMs) {
      this.buckets.delete(input.key);
      bucket = undefined;
    }
    if (!bucket) {
      for (const [key, existing] of this.buckets) {
        if (
          time >= existing.start &&
          time - existing.start >= existing.windowMs
        )
          this.buckets.delete(key);
      }
      if (this.buckets.size >= this.maxBuckets) return false;
      bucket = { start: time, windowMs: input.windowMs, count: 0 };
      this.buckets.set(input.key, bucket);
    }
    if (bucket.windowMs !== input.windowMs || bucket.count >= input.requests)
      return false;
    bucket.count++;
    return true;
  }
}
