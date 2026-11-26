import { describe, expect, it } from "vitest";
import { OpenAIAssessmentProvider } from "../openai.js";

// Synthetic, versioned fixture; never use real candidate or vacancy data here.
const fixture = {
  version: "kotlin-absence-v1",
  cv: "Synthetic candidate: I have never worked with Kotlin. I build PHP APIs.",
  vacancy:
    "Synthetic vacancy: At least two years of Kotlin experience is required.",
  vacancyMetadata: { completeness: "full" as const },
};

const env =
  (globalThis as { process?: { env?: Record<string, string | undefined> } })
    .process?.env ?? {};

describe("opt-in live assessment evaluation", () => {
  it("identifies a confirmed unmet hard requirement using cited evidence", async () => {
    // This check runs before credential access or any network request.
    expect(env.ROLERIVER_LIVE_EVAL).toBe("1");
    const apiKey = env.OPENAI_API_KEY;
    const model = env.ROLERIVER_OPENAI_MODEL;
    expect(Boolean(apiKey?.trim())).toBe(true);
    expect(Boolean(model?.trim())).toBe(true);
    if (!apiKey?.trim() || !model?.trim()) return;

    const provider = new OpenAIAssessmentProvider({ apiKey, model });
    const result = await provider.assess(
      {
        cv: fixture.cv,
        vacancy: fixture.vacancy,
        vacancyMetadata: fixture.vacancyMetadata,
      },
      "allowed",
    );
    expect(result.ok, `${fixture.version}: provider assessment failed`).toBe(
      true,
    );
    if (!result.ok) return;
    const requirement = result.assessment.requirements.find((item) =>
      item.vacancyEvidence.quote.toLowerCase().includes("kotlin"),
    );
    expect(requirement?.kind).toBe("hard");
    expect(requirement?.status).toBe("not_met");
    expect(requirement?.candidateEvidence.length).toBeGreaterThan(0);
    expect(result.assessment.recommendation).not.toBe("apply");
  }, 150_000);
});
