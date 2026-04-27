import type { Db } from "@repo/db/drizzle-client";
import { and, eq, gt, isNull, lt, or, sql } from "@repo/db";
import { inviteCode } from "@repo/db/drizzle-schema";
import { APIError } from "better-auth/api";

export const normalizeInviteCode = (raw: unknown) =>
  String(raw ?? "")
    .trim()
    .toUpperCase();

export const inviteCodeAvailabilityClause = (now: Date) =>
  and(
    isNull(inviteCode.revokedAt),
    or(isNull(inviteCode.expiresAt), gt(inviteCode.expiresAt, now)),
    or(isNull(inviteCode.maxUses), lt(inviteCode.usedCount, inviteCode.maxUses)),
  );

/**
 * Read-only validation. Throws `APIError` (surfaced as 4xx by better-auth)
 * when the code is missing, unknown, expired, revoked, or fully used. The
 * user-facing message is intentionally generic so we don't leak which codes
 * exist. Returns the normalized (upper-case, trimmed) code string.
 *
 * The actual claim happens after user creation succeeds — see `tryClaim`.
 * Splitting validate/claim means a downstream user-create failure (e.g.
 * duplicate email) won't burn a single-use code.
 */
export const validateInviteCode = async (db: Db, rawCode: unknown): Promise<string> => {
  const code = normalizeInviteCode(rawCode);
  if (!code) {
    throw new APIError("BAD_REQUEST", { message: "Invite code is required." });
  }

  const rows = await db
    .select({ id: inviteCode.id })
    .from(inviteCode)
    .where(and(eq(inviteCode.code, code), inviteCodeAvailabilityClause(new Date())))
    .limit(1);

  if (rows.length === 0) {
    throw new APIError("FORBIDDEN", { message: "Invalid or expired invite code." });
  }
  return code;
};

/**
 * Atomically claim a single use of `code`. The check + increment is one
 * conditional UPDATE so two concurrent signups with the same single-use
 * code can't both succeed — only the row that still has capacity will be
 * updated. Returns true on success, false if the code raced and lost.
 */
export const tryClaimInviteCode = async (db: Db, code: string): Promise<boolean> => {
  const claimed = await db
    .update(inviteCode)
    .set({ usedCount: sql`${inviteCode.usedCount} + 1` })
    .where(and(eq(inviteCode.code, code), inviteCodeAvailabilityClause(new Date())))
    .returning({ id: inviteCode.id });
  return claimed.length > 0;
};
