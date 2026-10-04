import { z } from "zod";

import { MAX_INVITE_BATCH } from "./auth-limits";

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
