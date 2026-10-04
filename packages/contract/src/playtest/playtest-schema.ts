import { z } from "zod";

import { jsonValueSchema } from "../json";

/** Serialized `state`, per call. The provider's own ceiling is far higher. */
export const MAX_STATE_BYTES = 64 * 1024;
export const MAX_QUESTIONS = 32;
export const MAX_CHOICE_OPTIONS = 64;

const entry = z.string().min(1).max(2000);
const label = z.string().min(1).max(64);

const noulQuestion = z.object({
  criteria: z.object({ false: entry.optional(), true: entry.optional() }).optional(),
  instructions: entry,
  type: z.literal("noul"),
});

const choiceQuestion = z.object({
  criteria: z
    .record(label, entry)
    .refine((criteria) => Object.keys(criteria).length >= 2, "needs at least two options")
    .refine(
      (criteria) => Object.keys(criteria).length <= MAX_CHOICE_OPTIONS,
      `at most ${MAX_CHOICE_OPTIONS} options`,
    ),
  instructions: entry,
  type: z.literal("choice"),
});

const scoreQuestion = z.object({
  criteria: z.array(entry).min(2).max(10),
  instructions: entry,
  type: z.literal("score"),
});

const question = z.discriminatedUnion("type", [noulQuestion, choiceQuestion, scoreQuestion]);

const stateSchema = jsonValueSchema;

export const decideInput = z.object({
  model: z
    .string()
    .regex(/^[a-z0-9][a-z0-9.-]{0,63}$/u, "model must be a provider model id")
    .optional(),
  questions: z
    .record(label, question)
    .refine((questions) => Object.keys(questions).length >= 1, "needs at least one question")
    .refine(
      (questions) => Object.keys(questions).length <= MAX_QUESTIONS,
      `at most ${MAX_QUESTIONS} questions`,
    ),
  // Any JSON. Size-checked in the handler, where the bytes are what matter
  // rather than the shape.
  state: stateSchema,
});

export type DecideInput = z.infer<typeof decideInput>;
