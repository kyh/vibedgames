import { and, desc, eq, isNull } from "@repo/db";
import { inviteCode } from "@repo/db/drizzle-schema";
import { user } from "@repo/db/drizzle-schema-auth";
import { TRPCError } from "@trpc/server";
import { z } from "zod";

import { generateShortCode } from "../auth/utils";
import { adminProcedure, createTRPCRouter } from "../trpc";

export const inviteRouter = createTRPCRouter({
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
