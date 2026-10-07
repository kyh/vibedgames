import { z } from "zod";

import { INVITE_CODE_LENGTH, MAX_INVITE_BATCH } from "./auth-limits";

// CLI device codes, deliberately loose: a device code is matched exactly, and
// an unknown one is answered (`expired`, or 404 on confirm), not refused as
// malformed.
export const codeInput = z.object({ code: z.string() });

// The ledger records whole micro-USD (`usdToMicro` in the service).
const MICRO_PER_USD = 1_000_000;

// Dollars one redemption of a credit code grants, bounded to catch
// fat-fingered amounts; stored as micro-USD.
const creditUsd = z
  .number()
  .positive()
  .max(1000)
  .refine((n) => Math.round(n * MICRO_PER_USD) > 0, "credit must be at least one micro-USD");

// What `buildInviteRows` stores and the settings page can redeem: the code
// trimmed and upper-cased, then exactly INVITE_CODE_LENGTH letters or digits
// (the redeem form's fixed-length OTP field).
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
  // Explicit code instead of random generation; overrides `count`.
  code: customInviteCode.nullable().default(null),
  count: z.number().int().min(1).max(MAX_INVITE_BATCH).default(1),
  creditUsd: creditUsd.default(20),
  expiresAt: z.date().nullable().default(null),
  maxUses: z.number().int().min(1).nullable().default(1),
  note: z.string().max(200).nullable().default(null),
});

export const updateInviteInput = z.object({
  // Applies to redemptions from now on; omit to leave unchanged.
  creditUsd: creditUsd.optional(),
  id: z.string(),
  // `null` = unlimited uses; omit to leave unchanged.
  maxUses: z.number().int().min(1).nullable().optional(),
  // `true` revokes now, `false` clears an existing revocation.
  revoked: z.boolean().optional(),
});
