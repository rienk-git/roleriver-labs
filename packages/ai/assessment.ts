import { z } from "zod";
import type { AssessmentInput } from "../domain/input.js";

export const PROMPT_VERSION = "assessment-v1";
export const SCHEMA_VERSION = "assessment-v1";

const evidence = z.strictObject({ source: z.string(), quote: z.string() });
export const assessmentSchema = z.strictObject({
  recommendation: z.enum(["apply", "review", "skip"]),
  matchScore: z.number().nullable(),
  confidence: z.enum(["low", "medium", "high"]),
  vacancyCompleteness: z.enum(["full", "partial", "unknown"]),
  requirements: z.array(
    z.strictObject({
      id: z.string(),
      text: z.string(),
      kind: z.enum(["hard", "preference", "responsibility", "unclear"]),
      status: z.enum(["met", "not_met", "unknown", "not_applicable"]),
      vacancyEvidence: evidence,
      candidateEvidence: z.array(evidence),
      explanation: z.string(),
    }),
  ),
  disqualifiers: z.array(z.string()),
  strengths: z.array(z.string()),
  gaps: z.array(z.string()),
  warnings: z.array(z.string()),
  summary: z.string(),
});
export type Assessment = z.infer<typeof assessmentSchema>;
export type AssessmentError =
  | "invalid_input"
  | "processing_denied"
  | "provider_error"
  | "timeout"
  | "refused"
  | "incomplete"
  | "invalid_output";
export type AssessmentResult =
  | {
      ok: true;
      assessment: Assessment;
      provenance: {
        model: string;
        promptVersion: string;
        schemaVersion: string;
        candidateHash: string;
        vacancyHash: string;
        preferencesHash: string;
        assessedAt: string;
      };
    }
  | { ok: false; error: AssessmentError };

/** Caller must minimize data and determine external processing permission independently of input text. */
export interface AssessmentProvider {
  assess(
    input: AssessmentInput,
    externalProcessing: "allowed" | "denied",
  ): Promise<AssessmentResult>;
}

export function validateEvidence(
  value: Assessment,
  input: AssessmentInput,
): boolean {
  const sourceText = new Map<string, string>([
    ["cv", input.cv],
    ["vacancy", input.vacancy],
  ]);
  input.supplementaryEvidence?.forEach((item, index) =>
    sourceText.set(`supplement:${index}`, item.text),
  );
  const ids = new Set<string>();
  if (!value.summary.trim()) return false;
  if (
    value.vacancyCompleteness === "full" &&
    input.vacancyMetadata?.completeness !== "full"
  )
    return false;
  const validQuote = (item: { source: string; quote: string }) =>
    item.quote.trim().length > 0 &&
    (sourceText.get(item.source)?.includes(item.quote) ?? false);
  if (
    value.matchScore !== null &&
    (!Number.isFinite(value.matchScore) ||
      value.matchScore < 0 ||
      value.matchScore > 100)
  )
    return false;
  if (
    value.recommendation === "apply" &&
    (value.disqualifiers.length > 0 || value.vacancyCompleteness !== "full")
  )
    return false;
  for (const requirement of value.requirements) {
    if (
      !requirement.id.trim() ||
      !requirement.text.trim() ||
      !requirement.explanation.trim() ||
      ids.has(requirement.id)
    )
      return false;
    ids.add(requirement.id);
    if (
      requirement.vacancyEvidence.source !== "vacancy" ||
      !validQuote(requirement.vacancyEvidence)
    )
      return false;
    if (
      !requirement.candidateEvidence.every(
        (item) => item.source !== "vacancy" && validQuote(item),
      )
    )
      return false;
    if (
      (requirement.status === "met" || requirement.status === "not_met") &&
      requirement.candidateEvidence.length === 0
    )
      return false;
    if (
      value.recommendation === "apply" &&
      requirement.kind === "hard" &&
      requirement.status !== "met"
    )
      return false;
  }
  return true;
}
