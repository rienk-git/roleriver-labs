import { describe, expect, it } from "vitest";
import { assessmentInputSchema } from "./input.js";

describe("assessment input", () => {
  it("accepts a CV and vacancy without a structured profile and preserves original text", () => {
    const input = {
      cv: "  Ervaring\nOntwikkelaar ",
      vacancy: "  Senior ontwikkelaar\n  ",
    };
    expect(assessmentInputSchema.parse(input)).toEqual(input);
  });

  it.each([
    { cv: "  ", vacancy: "Role" },
    { cv: "CV", vacancy: "\n" },
  ])("rejects empty source text", (input) => {
    expect(assessmentInputSchema.safeParse(input).success).toBe(false);
  });

  it("keeps supplements, corrections and optional structured preferences distinct", () => {
    const input = {
      cv: "CV",
      vacancy: "Role",
      supplementaryEvidence: [
        { kind: "correction", text: "Correction" },
        { kind: "supplement", text: "Additional" },
      ],
      preferences: {
        contractForms: ["freelance"],
        location: "Amsterdam",
        hoursPerWeek: 24,
        hourlyRate: { amount: 100, currency: "EUR" },
      },
      vacancyMetadata: {
        completeness: "partial",
        status: "unknown",
        source: "email",
      },
    };
    expect(assessmentInputSchema.parse(input)).toEqual(input);
  });

  it("accepts an explicitly verified deadline without defaulting absent verification to true", () => {
    const base = { cv: "CV", vacancy: "Role" };
    const missing = assessmentInputSchema.parse({
      ...base,
      vacancyMetadata: {
        deadline: { kind: "instant", value: "2020-01-01T00:00:00Z" },
      },
    });
    expect(missing.vacancyMetadata?.deadline).not.toHaveProperty("verified");
    const verified = assessmentInputSchema.parse({
      ...base,
      vacancyMetadata: {
        deadline: {
          kind: "instant",
          value: "2020-01-01T00:00:00Z",
          verified: true,
        },
      },
    });
    expect(verified.vacancyMetadata?.deadline?.verified).toBe(true);
  });

  it("rejects malformed preferences and unknown fields", () => {
    expect(
      assessmentInputSchema.safeParse({
        cv: "CV",
        vacancy: "Role",
        preferences: { hoursPerWeek: -1 },
      }).success,
    ).toBe(false);
    expect(
      assessmentInputSchema.safeParse({
        cv: "CV",
        vacancy: "Role",
        preferences: { hourlyRate: { amount: 100, currency: "euro" } },
      }).success,
    ).toBe(false);
    expect(
      assessmentInputSchema.safeParse({
        cv: "CV",
        vacancy: "Role",
        extra: true,
      }).success,
    ).toBe(false);
  });
});
