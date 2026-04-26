import { and, desc, eq, isNull } from "@repo/db";
import { inviteCode } from "@repo/db/drizzle-schema";
import { user } from "@repo/db/drizzle-schema-auth";
import { TRPCError } from "@trpc/server";
import { z } from "zod";

import { adminProcedure, createTRPCRouter } from "../trpc";

const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I
const CODE_LENGTH = 8;

const generateCode = () => {
  const bytes = crypto.getRandomValues(new Uint8Array(CODE_LENGTH));
  let code = "";
  for (const b of bytes) {
    code += CODE_CHARS[b % CODE_CHARS.length];
  }
  return `${code.slice(0, 4)}-${code.slice(4)}`;
};

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
        code: generateCode(),
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
