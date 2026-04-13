import { eq } from "@repo/db";
import { verification } from "@repo/db/drizzle-schema-auth";
import { makeSignature } from "better-auth/crypto";
import { TRPCError } from "@trpc/server";
import { z } from "zod";

import { createTRPCRouter, protectedProcedure, publicProcedure } from "../trpc";

const CODE_LENGTH = 8;
const CODE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const IDENTIFIER_PREFIX = "cli-auth:";

function generateCode(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I
  let code = "";
  const bytes = crypto.getRandomValues(new Uint8Array(CODE_LENGTH));
  for (const b of bytes) {
    code += chars[b % chars.length];
  }
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

export const cliAuthRouter = createTRPCRouter({
  create: publicProcedure.mutation(async ({ ctx }) => {
    const code = generateCode();
    const id = crypto.randomUUID();
    const now = new Date();

    await ctx.db.insert(verification).values({
      id,
      identifier: `${IDENTIFIER_PREFIX}${code}`,
      value: "",
      expiresAt: new Date(now.getTime() + CODE_TTL_MS),
      createdAt: now,
      updatedAt: now,
    });

    return { code };
  }),

  confirm: protectedProcedure
    .input(z.object({ code: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const identifier = `${IDENTIFIER_PREFIX}${input.code}`;
      const rows = await ctx.db
        .select()
        .from(verification)
        .where(eq(verification.identifier, identifier))
        .limit(1);

      const row = rows[0];
      if (!row || row.expiresAt < new Date()) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Code expired or invalid" });
      }
      if (row.value !== "") {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Code already confirmed" });
      }

      // Sign the session token so the CLI can use it as a cookie
      const sessionToken = ctx.session.session.token;
      const sig = await makeSignature(sessionToken, ctx.auth.options.secret);
      const signedToken = `${sessionToken}.${sig}`;

      await ctx.db
        .update(verification)
        .set({ value: signedToken, updatedAt: new Date() })
        .where(eq(verification.id, row.id));

      return { ok: true };
    }),

  poll: publicProcedure
    .input(z.object({ code: z.string() }))
    .query(async ({ ctx, input }) => {
      const identifier = `${IDENTIFIER_PREFIX}${input.code}`;
      const rows = await ctx.db
        .select()
        .from(verification)
        .where(eq(verification.identifier, identifier))
        .limit(1);

      const row = rows[0];
      if (!row || row.expiresAt < new Date()) {
        return { status: "expired" as const };
      }

      if (row.value === "") {
        return { status: "pending" as const };
      }

      // Clean up after successful read
      await ctx.db.delete(verification).where(eq(verification.id, row.id));

      return { status: "confirmed" as const, token: row.value };
    }),
});
