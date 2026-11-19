import { z } from "zod";

import { INVITE_CODE_LENGTH, MAX_INVITE_BATCH } from "./auth-limits";

const MICRO_PER_USD = 1_000_000;

const creditUsd = z
  .number()
  .positive()
  .max(1000)
  .refine((n) => Math.round(n * MICRO_PER_USD) > 0, "credit must be at least one micro-USD");

const customInviteCode = z
  .string()
  .trim()
  .toUpperCase()
  .regex(
    new RegExp(`^[A-Z0-9]{${INVITE_CODE_LENGTH}}$`, "u"),
    `code must be ${INVITE_CODE_LENGTH} letters or digits`,
  )
  .describe(
    `${INVITE_CODE_LENGTH} letters or digits; surrounding whitespace is trimmed and letters are upper-cased first.`,
  );

export const createInvitesInput = z.object({
  code: customInviteCode.nullable().default(null),
  count: z.number().int().min(1).max(MAX_INVITE_BATCH).default(1),
  creditUsd: creditUsd.default(20),
  expiresAt: z.date().nullable().default(null),
  maxUses: z.number().int().min(1).nullable().default(1),
  note: z.string().max(200).nullable().default(null),
});

export const updateInviteInput = z.object({
  creditUsd: creditUsd.optional(),
  id: z.string(),
  maxUses: z.number().int().min(1).nullable().optional(),
  revoked: z.boolean().optional(),
});
