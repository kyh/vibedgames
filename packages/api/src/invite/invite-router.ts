import { and, desc, eq, isNull } from "@repo/db";
import { inviteCode } from "@repo/db/drizzle-schema";
import { user } from "@repo/db/drizzle-schema-auth";
import { TRPCError } from "@trpc/server";
import { z } from "zod";

import { inviteCodeAvailabilityClause, normalizeInviteCode } from "../auth/invite-claim";
import { generateShortCode } from "../auth/utils";
import { adminProcedure, createTRPCRouter, publicProcedure } from "../trpc";

export const inviteRouter = createTRPCRouter({
  // Pre-flight check used by the register page so users get immediate feedback
  // on a bad code before they fill in email/password. Shares
  // `inviteCodeAvailabilityClause` with the signup hook so the two stay in
  // lockstep — a code that validates here will be accepted by the hook
  // (modulo races on single-use codes). Generic error message matches the
  // hook's so we don't leak which codes exist. The atomic single-use claim
  // still happens inside the hook — success here does NOT reserve the code.
  validate: publicProcedure
    .input(z.object({ code: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const code = normalizeInviteCode(input.code);
      if (!code) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Invite code is required." });
      }

      const rows = await ctx.db
        .select({ id: inviteCode.id })
        .from(inviteCode)
        .where(and(eq(inviteCode.code, code), inviteCodeAvailabilityClause(new Date())))
        .limit(1);

      if (rows.length === 0) {
        throw new TRPCError({ code: "FORBIDDEN", message: "Invalid or expired invite code." });
      }

      return { code };
    }),

  list: adminProcedure.query(async ({ ctx }) => {
    const rows = await ctx.db
      .select({
        id: inviteCode.id,
        code: inviteCode.code,
        createdBy: inviteCode.createdBy,
        createdAt: inviteCode.createdAt,
        expiresAt: inviteCode.expiresAt,
        maxUses: inviteCode.maxUses,
        usedCount: inviteCode.usedCount,
        revokedAt: inviteCode.revokedAt,
        note: inviteCode.note,
        creatorEmail: user.email,
      })
      .from(inviteCode)
      .leftJoin(user, eq(inviteCode.createdBy, user.id))
      .orderBy(desc(inviteCode.createdAt));

    return { codes: rows };
  }),

  create: adminProcedure
    .input(
      z.object({
        count: z.number().int().min(1).max(100).default(1),
        maxUses: z.number().int().min(1).nullable().default(1),
        expiresAt: z.date().nullable().default(null),
        note: z.string().max(200).nullable().default(null),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const rows = Array.from({ length: input.count }, () => ({
        id: crypto.randomUUID(),
        code: generateShortCode(),
        createdBy: ctx.session.user.id,
        maxUses: input.maxUses,
        expiresAt: input.expiresAt,
        note: input.note,
      }));

      const created = await ctx.db.insert(inviteCode).values(rows).returning();
      return { codes: created };
    }),

  revoke: adminProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const [revoked] = await ctx.db
        .update(inviteCode)
        .set({ revokedAt: new Date() })
        .where(and(eq(inviteCode.id, input.id), isNull(inviteCode.revokedAt)))
        .returning();

      if (!revoked) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Code not found or already revoked" });
      }

      return { code: revoked };
    }),
});
