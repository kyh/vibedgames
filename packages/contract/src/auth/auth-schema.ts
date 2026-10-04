import { z } from "zod";

import { INVITE_CODE_LENGTH, MAX_INVITE_BATCH } from "./auth-limits";

// Device codes and invite codes alike, so deliberately loose. An invite is
// matched trimmed and upper-cased, and invites minted before 6-character codes
// were `XXXX-XXXX`: any still live validates today. A device code is matched
// exactly, and an unknown one is answered (`expired`, or 404 on confirm), not
// refused as malformed.
export const codeInput = z.object({ code: z.string() });

// What `buildInviteRows` stores and signup can redeem: the code trimmed and
// upper-cased, then exactly INVITE_CODE_LENGTH letters or digits (the signup
// form's fixed-length OTP field).
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
  expiresAt: z.date().nullable().default(null),
  maxUses: z.number().int().min(1).nullable().default(1),
  note: z.string().max(200).nullable().default(null),
});

export const updateInviteInput = z.object({
  id: z.string(),
  // `null` = unlimited uses; omit to leave unchanged.
  maxUses: z.number().int().min(1).nullable().optional(),
  // `true` revokes now, `false` clears an existing revocation.
  revoked: z.boolean().optional(),
});
