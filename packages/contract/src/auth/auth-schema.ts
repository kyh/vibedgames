import { z } from "zod";

/**
 * Length of CLI device-codes and invite codes. The single source of truth for
 * this contract: the web signup form enters invite codes through a fixed-length
 * alphanumeric OTP field of this size, so minting (the service's
 * `generateShortCode`) and redemption (the form) can't drift.
 */
export const INVITE_CODE_LENGTH = 6;

/** Most codes mintable in a single batch — guards against pathological inputs. */
export const MAX_INVITE_BATCH = 100;

export const codeInput = z.object({ code: z.string() });

export const createInvitesInput = z.object({
  // Explicit code instead of random generation; overrides `count`.
  code: z.string().max(50).nullable().default(null),
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
