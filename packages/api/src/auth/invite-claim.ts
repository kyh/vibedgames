import type { Db } from "@repo/db/drizzle-client";
import { and, eq, gt, isNull, lt, or, sql } from "@repo/db";
import { inviteCode } from "@repo/db/drizzle-schema";
import { APIError } from "better-auth/api";

/**
 * Atomically claim a single use of an invite code.
 *
 * The check + increment is one conditional UPDATE so two concurrent signups
 * with the same single-use code can't both succeed — only the row that still
 * has capacity will be updated.
 *
 * Throws an `APIError` (which better-auth surfaces as a 4xx response) when
 * the code is missing, unknown, expired, revoked, or fully used. We don't
 * distinguish between those cases in the user-facing message to avoid leaking
 * which codes exist.
 */
export const claimInviteCode = async (db: Db, rawCode: unknown): Promise<string> => {
  const code = String(rawCode ?? "")
    .trim()
    .toUpperCase();

  if (!code) {
    throw new APIError("BAD_REQUEST", { message: "Invite code is required." });
  }

  const now = new Date();
  const claimed = await db
    .update(inviteCode)
    .set({ usedCount: sql`${inviteCode.usedCount} + 1` })
    .where(
      and(
        eq(inviteCode.code, code),
        isNull(inviteCode.revokedAt),
        or(isNull(inviteCode.expiresAt), gt(inviteCode.expiresAt, now)),
        or(isNull(inviteCode.maxUses), lt(inviteCode.usedCount, inviteCode.maxUses)),
      ),
    )
    .returning({ id: inviteCode.id });

  if (claimed.length === 0) {
    throw new APIError("FORBIDDEN", { message: "Invalid or expired invite code." });
  }

  return code;
};
