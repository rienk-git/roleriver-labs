import { describe, expect, it, vi } from "vitest";
import type {
  AssessmentProvider,
  AssessmentResult,
} from "../../packages/ai/assessment.js";
import { run } from "./run.js";

const assessment: AssessmentResult = {
  ok: true,
  assessment: {
    recommendation: "review",
    roleAlignment: {
      status: "unclear",
      explanation: "Role context is unclear",
      vacancyEvidence: [],
      candidateEvidence: [],
    },
    matchScore: null,
    confidence: "medium",
    vacancyCompleteness: "partial",
    requirements: [
      {
        id: "r1",
        text: "PHP",
        kind: "hard",
        status: "unknown",
        vacancyEvidence: { source: "vacancy", quote: "PHP" },
        candidateEvidence: [],
        explanation: "Verify",
      },
    ],
    disqualifiers: [],
    strengths: [],
    gaps: ["Verify"],
    warnings: [],
    summary: "Review",
  },
  provenance: {
    model: "synthetic",
    promptVersion: "p1",
    schemaVersion: "s1",
    candidateHash: "a",
    vacancyHash: "b",
    preferencesHash: "c",
    assessedAt: "2026-01-01T00:00:00.000Z",
  },
};
const args = [
  "assess",
  "--cv",
  "cv",
  "--vacancy",
  "vacancy",
  "--format",
  "json",
];
function setup(files: Record<string, string> = { cv: "CV", vacancy: "PHP" }) {
  const provider: AssessmentProvider = {
    assess: vi.fn(async () => assessment),
  };
  return {
    read: vi.fn(async (path: string) => {
      if (!(path in files)) throw new Error("private /path");
      return files[path]!;
    }),
    now: () => new Date("2026-01-01T00:00:00Z"),
    provider: vi.fn(() => provider),
    instance: provider,
  };
}

describe("assessment CLI", () => {
  it("requires explicit external processing and manual-data attestations before credentials", async () => {
    const deps = setup();
    const result = await run(args, deps);
    expect(result.code).not.toBe(0);
    expect(deps.provider).not.toHaveBeenCalled();
    expect(deps.instance.assess).not.toHaveBeenCalled();
  });
  it("returns a versioned JSON assessment using an injected provider", async () => {
    const deps = setup();
    const result = await run(
      [...args, "--live", "--confirm-manual", "--confirm-minimized"],
      deps,
    );
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toMatchObject({
      schemaVersion: "1",
      disposition: null,
      reviewRequired: true,
      assessment: { recommendation: "review" },
    });
    expect(deps.instance.assess).toHaveBeenCalledTimes(1);
  });
  it("only marks an apply recommendation potentially promising when supported by a met requirement", async () => {
    if (!assessment.ok) throw new Error("invalid synthetic fixture");
    const apply = {
      ...assessment.assessment,
      recommendation: "apply" as const,
      roleAlignment: {
        status: "aligned" as const,
        explanation: "Responsibilities align",
        vacancyEvidence: [{ source: "vacancy", quote: "PHP" }],
        candidateEvidence: [{ source: "cv", quote: "CV" }],
      },
      vacancyCompleteness: "full" as const,
      requirements: [
        {
          ...assessment.assessment.requirements[0]!,
          status: "met" as const,
          candidateEvidence: [{ source: "cv", quote: "CV" }],
        },
      ],
    };
    const files = {
      cv: "CV",
      vacancy: "PHP",
      details: JSON.stringify({ vacancyMetadata: { completeness: "full" } }),
    };
    const deps = setup(files);
    deps.instance.assess = vi.fn(async () => ({
      ...assessment,
      assessment: apply,
    }));
    const result = await run(
      [
        ...args,
        "--details",
        "details",
        "--live",
        "--confirm-manual",
        "--confirm-minimized",
      ],
      deps,
    );
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      disposition: "potentially_promising",
      reviewRequired: true,
    });
    deps.instance.assess = vi.fn(async () => ({
      ...assessment,
      assessment: {
        ...apply,
        recommendation: "review" as const,
        requirements: [],
        roleAlignment: {
          status: "unclear" as const,
          explanation: "Generic skill alone is insufficient",
          vacancyEvidence: [],
          candidateEvidence: [],
        },
      },
    }));
    const unsupported = await run(
      [
        ...args,
        "--details",
        "details",
        "--live",
        "--confirm-manual",
        "--confirm-minimized",
      ],
      deps,
    );
    expect(unsupported.code).toBe(0);
    expect(JSON.parse(unsupported.stdout).disposition).toBeNull();
  });
  it("recognizes an evidence-backed aligned role from partial vacancy text without requiring complete requirements", async () => {
    if (!assessment.ok) throw new Error("invalid synthetic fixture");
    const aligned = {
      ...assessment.assessment,
      recommendation: "review" as const,
      roleAlignment: {
        status: "aligned" as const,
        explanation: "Comparable responsibilities",
        vacancyEvidence: [{ source: "vacancy", quote: "PHP" }],
        candidateEvidence: [{ source: "cv", quote: "CV" }],
      },
    };
    const deps = setup();
    deps.instance.assess = vi.fn(async () => ({
      ...assessment,
      assessment: aligned,
    }));
    const result = await run(
      [...args, "--live", "--confirm-manual", "--confirm-minimized"],
      deps,
    );
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      disposition: "potentially_promising",
      reviewRequired: true,
    });
    deps.instance.assess = vi.fn(async () => ({
      ...assessment,
      assessment: {
        ...aligned,
        roleAlignment: {
          ...aligned.roleAlignment,
          candidateEvidence: [{ source: "cv", quote: "invented" }],
        },
      },
    }));
    const invalid = await run(
      [...args, "--live", "--confirm-manual", "--confirm-minimized"],
      deps,
    );
    expect(invalid.code).toBe(1);
    expect(invalid.stderr).toContain("invalid_output");
  });
  it("requires review for model skip, reported disqualifiers, and hard unmet requirements", async () => {
    if (!assessment.ok) throw new Error("invalid synthetic fixture");
    const cases = [
      { ...assessment.assessment, recommendation: "skip" as const },
      { ...assessment.assessment, disqualifiers: ["Possible conflict"] },
      {
        ...assessment.assessment,
        requirements: [
          {
            ...assessment.assessment.requirements[0]!,
            status: "not_met" as const,
            candidateEvidence: [{ source: "cv", quote: "CV" }],
          },
        ],
      },
    ];
    for (const item of cases) {
      const deps = setup();
      deps.instance.assess = vi.fn(async () => ({
        ...assessment,
        assessment: item,
      }));
      const result = await run(
        [...args, "--live", "--confirm-manual", "--confirm-minimized"],
        deps,
      );
      expect(result.code).toBe(0);
      expect(JSON.parse(result.stdout).disposition).toBeNull();
    }
  });
  it("does not trust a JSON verified flag and skips verified-expired preflight only with explicit confirmation", async () => {
    const files = {
      cv: "CV",
      vacancy: "PHP",
      details: JSON.stringify({
        vacancyMetadata: {
          deadline: {
            kind: "instant",
            value: "2025-01-01T00:00:00Z",
            verified: true,
          },
        },
      }),
    };
    const deps = setup(files);
    const unconfirmed = await run([...args, "--details", "details"], deps);
    expect(unconfirmed.code).not.toBe(0);
    expect(deps.provider).not.toHaveBeenCalled();
    const confirmed = await run(
      [...args, "--details", "details", "--confirm-deadline"],
      deps,
    );
    expect(confirmed.code).toBe(0);
    expect(JSON.parse(confirmed.stdout)).toMatchObject({
      disposition: "unsuitable",
      reviewRequired: false,
      reason: "confirmed_expired_deadline",
    });
    expect(deps.provider).not.toHaveBeenCalled();
  });
  it("strips untrusted deadline verification before passing data to the provider", async () => {
    const deps = setup({
      cv: "CV",
      vacancy: "PHP",
      details: JSON.stringify({
        vacancyMetadata: {
          deadline: {
            kind: "instant",
            value: "2025-01-01T00:00:00Z",
            verified: true,
          },
        },
      }),
    });
    const result = await run(
      [
        ...args,
        "--details",
        "details",
        "--live",
        "--confirm-manual",
        "--confirm-minimized",
      ],
      deps,
    );
    expect(result.code).toBe(0);
    expect(deps.instance.assess).toHaveBeenCalledWith(
      expect.objectContaining({
        vacancyMetadata: {
          deadline: {
            kind: "instant",
            value: "2025-01-01T00:00:00Z",
            verified: false,
          },
        },
      }),
      "allowed",
    );
  });
  it("fails safely when an injected provider returns an invalid result", async () => {
    const deps = setup();
    deps.instance.assess = vi.fn(async () => null as never);
    const result = await run(
      [...args, "--live", "--confirm-manual", "--confirm-minimized"],
      deps,
    );
    expect(result.code).toBe(1);
    expect(result.stderr).toBe("Assessment failed: invalid_output.\n");
  });
  it("does not leak read errors or content and rejects invalid options", async () => {
    const deps = setup({});
    const bad = await run(args, deps);
    expect(bad.stderr).not.toContain("/path");
    expect(bad.code).not.toBe(0);
    const option = await run([...args, "--api-key", "synthetic-secret"], deps);
    expect(option.stderr).not.toContain("synthetic-secret");
    expect(option.code).not.toBe(0);
  });
  it("sanitizes provider failures", async () => {
    const deps = setup();
    deps.instance.assess = vi.fn(async () => {
      throw new Error("sensitive provider error");
    });
    const result = await run(
      [...args, "--live", "--confirm-manual", "--confirm-minimized"],
      deps,
    );
    expect(result.code).not.toBe(0);
    expect(result.stderr).not.toContain("sensitive");
  });
});
