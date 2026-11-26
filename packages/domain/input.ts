import { z } from "zod";

const nonblankText = z.string().refine((value) => value.trim().length > 0, {
  message: "Text must not be blank",
});

const currency = z
  .string()
  .regex(/^[A-Z]{3}$/, "Use a three-letter currency code");

/** Local input only. Original source text is preserved exactly as supplied. */
export const assessmentInputSchema = z.strictObject({
  cv: nonblankText,
  vacancy: nonblankText,
  supplementaryEvidence: z
    .array(
      z.strictObject({
        kind: z.enum(["supplement", "correction"]),
        text: nonblankText,
      }),
    )
    .optional(),
  preferences: z
    .strictObject({
      contractForms: z.array(nonblankText).optional(),
      location: nonblankText.optional(),
      hoursPerWeek: z.number().finite().nonnegative().max(168).optional(),
      hourlyRate: z
        .strictObject({ amount: z.number().finite().nonnegative(), currency })
        .optional(),
      seniority: nonblankText.optional(),
      notifications: z.boolean().optional(),
    })
    .optional(),
  vacancyMetadata: z
    .strictObject({
      source: nonblankText.optional(),
      completeness: z.enum(["full", "partial", "unknown"]).optional(),
      status: z.enum(["open", "closed", "unknown"]).optional(),
      publicationDate: nonblankText.optional(),
      deadline: z
        .discriminatedUnion("kind", [
          z.strictObject({
            kind: z.literal("date"),
            value: nonblankText,
            verified: z.boolean().optional(),
            timeZone: nonblankText.optional(),
          }),
          z.strictObject({
            kind: z.literal("instant"),
            value: nonblankText,
            verified: z.boolean().optional(),
          }),
        ])
        .optional(),
    })
    .optional(),
});

export type AssessmentInput = z.infer<typeof assessmentInputSchema>;
