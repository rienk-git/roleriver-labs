import { z } from "zod";
import { assessmentInputSchema } from "../../packages/domain/input.js";
import { deadlineStatus } from "../../packages/domain/objective.js";
import {
  assessmentSchema,
  validateEvidence,
  type AssessmentProvider,
} from "../../packages/ai/assessment.js";

export interface CliDependencies {
  read(path: string): Promise<string>;
  now(): Date;
  /** Must be called only after explicit consent. */
  provider(): AssessmentProvider | undefined;
}
export interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}
const error = (message: string): CliResult => ({
  code: 1,
  stdout: "",
  stderr: `${message}\n`,
});
const usage = `Usage: assess --cv <file> --vacancy <file> [--details <json-file>] [--format text|json] [--confirm-deadline] --live --confirm-manual --confirm-minimized
--live: Explicitly authorize an external, separately billed OpenAI API request.
--confirm-manual: Confirm all inputs are manually supplied and contain no Gmail-derived content.
--confirm-minimized: Confirm inputs are redacted/minimized and authorized for external processing.
--confirm-deadline: Personally confirm the supplied deadline before treating it as verified.
Each input file must be UTF-8 and no larger than 1 MiB.`;
const fields = new Set(["--cv", "--vacancy", "--details", "--format"]);
const switches = new Set([
  "--live",
  "--confirm-manual",
  "--confirm-minimized",
  "--confirm-deadline",
]);
const providerResultSchema = z.discriminatedUnion("ok", [
  z.strictObject({
    ok: z.literal(false),
    error: z.enum([
      "invalid_input",
      "processing_denied",
      "provider_error",
      "timeout",
      "refused",
      "incomplete",
      "invalid_output",
    ]),
  }),
  z.strictObject({
    ok: z.literal(true),
    assessment: assessmentSchema,
    provenance: z.strictObject({
      model: z.string().min(1),
      promptVersion: z.string().min(1),
      schemaVersion: z.string().min(1),
      candidateHash: z.string().min(1),
      vacancyHash: z.string().min(1),
      preferencesHash: z.string().min(1),
      assessedAt: z.string().min(1),
    }),
  }),
]);
const detailSchema = z.strictObject({
  preferences: assessmentInputSchema.shape.preferences,
  supplementaryEvidence: assessmentInputSchema.shape.supplementaryEvidence,
  vacancyMetadata: assessmentInputSchema.shape.vacancyMetadata,
});

export async function run(
  args: string[],
  deps: CliDependencies,
): Promise<CliResult> {
  if (args.length === 1 && (args[0] === "--help" || args[0] === "-h"))
    return { code: 0, stdout: `${usage}\n`, stderr: "" };
  if (args[0] !== "assess") return error(usage);
  const options = new Map<string, string>();
  const flags = new Set<string>();
  for (let i = 1; i < args.length; i++) {
    const arg = args[i]!;
    if (fields.has(arg)) {
      const value = args[++i];
      if (!value || value.startsWith("--") || options.has(arg))
        return error("Invalid command options.");
      options.set(arg, value);
    } else if (switches.has(arg) && !flags.has(arg)) flags.add(arg);
    else return error("Invalid command options.");
  }
  const cvFile = options.get("--cv");
  const vacancyFile = options.get("--vacancy");
  const format = options.get("--format") ?? "text";
  if (!cvFile || !vacancyFile || !["text", "json"].includes(format))
    return error(usage);
  let cv: string;
  let vacancy: string;
  let details: unknown = {};
  try {
    cv = await deps.read(cvFile);
    vacancy = await deps.read(vacancyFile);
    if (options.has("--details"))
      details = JSON.parse(await deps.read(options.get("--details")!));
  } catch {
    return error("Unable to read or parse input files.");
  }
  const parsedDetails = detailSchema.safeParse(details);
  if (!parsedDetails.success) return error("Invalid input data.");
  const parsed = assessmentInputSchema.safeParse({
    ...parsedDetails.data,
    cv,
    vacancy,
  });
  if (!parsed.success) return error("Invalid input data.");
  const input = parsed.data;
  const deadline = input.vacancyMetadata?.deadline;
  if (
    deadline &&
    flags.has("--confirm-deadline") &&
    deadlineStatus({ ...deadline, verified: true }, deps.now()) === "expired"
  ) {
    const output = {
      schemaVersion: "1",
      disposition: "unsuitable",
      reviewRequired: false,
      reason: "confirmed_expired_deadline",
      vacancyStatus: "unknown",
      vacancyCompleteness: input.vacancyMetadata?.completeness ?? "unknown",
    };
    return {
      code: 0,
      stdout:
        format === "json"
          ? `${JSON.stringify(output)}\n`
          : `Disposition: unsuitable\nReview required: no\nReason: confirmed expired deadline\nVacancy status: unknown\nVacancy completeness: ${output.vacancyCompleteness}\n`,
      stderr: "",
    };
  }
  if (
    !flags.has("--live") ||
    !flags.has("--confirm-manual") ||
    !flags.has("--confirm-minimized")
  )
    return error(
      `External processing requires explicit consent and attestations. ${usage}`,
    );
  // Source-supplied verification is not trusted; only an explicit user confirmation can verify it.
  if (deadline) deadline.verified = flags.has("--confirm-deadline");
  let result;
  try {
    const provider = deps.provider();
    if (!provider) return error("Provider configuration is missing.");
    result = await provider.assess(input, "allowed");
  } catch {
    return error("Assessment failed.");
  }
  const checked = providerResultSchema.safeParse(result);
  if (!checked.success) return error("Assessment failed: invalid_output.");
  if (!checked.data.ok)
    return error(`Assessment failed: ${checked.data.error}.`);
  if (!validateEvidence(checked.data.assessment, input))
    return error("Assessment failed: invalid_output.");
  const assessment = checked.data.assessment;
  // Model concern is not a confirmed disqualifier, but it does require human review.
  const disposition =
    assessment.roleAlignment.status === "aligned" &&
    assessment.recommendation !== "skip" &&
    assessment.disqualifiers.length === 0 &&
    !assessment.requirements.some(
      (requirement) =>
        requirement.kind === "hard" && requirement.status === "not_met",
    )
      ? "potentially_promising"
      : null;
  const output = {
    schemaVersion: "1",
    disposition,
    reviewRequired: true,
    vacancyStatus: "unknown",
    assessment,
    provenance: checked.data.provenance,
  };
  // JSON is also embedded in the human-readable output so it carries all evidence and uncertainty.
  return {
    code: 0,
    stdout:
      format === "json"
        ? `${JSON.stringify(output)}\n`
        : `Disposition: ${output.disposition ?? "not classified"}\nReview required: yes\nVacancy status: unknown\nAssessment and evidence:\n${JSON.stringify(output, null, 2)}\n`,
    stderr: "",
  };
}
