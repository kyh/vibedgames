import { and, desc, eq, isNull } from "@repo/db";
import { apiKey } from "@repo/db/drizzle-schema";
import { TRPCError } from "@trpc/server";
import { z } from "zod";

import { createTRPCRouter, protectedProcedure } from "../trpc";
import { apiKeyDisplayPrefix, generateApiKeyToken, hashApiKey } from "./api-key";

const DAY_MS = 24 * 60 * 60 * 1000;

export const apiKeyRouter = createTRPCRouter({
  // Active (non-revoked) keys for the current user. Never returns the raw key
  // or its hash — only the display prefix and metadata.
  list: protectedProcedure.query(async ({ ctx }) => {
    const keys = await ctx.db
      .select({
        id: apiKey.id,
        name: apiKey.name,
        keyPrefix: apiKey.keyPrefix,
        createdAt: apiKey.createdAt,
        lastUsedAt: apiKey.lastUsedAt,
        expiresAt: apiKey.expiresAt,
      })
      .from(apiKey)
      .where(and(eq(apiKey.userId, ctx.session.user.id), isNull(apiKey.revokedAt)))
      .orderBy(desc(apiKey.createdAt));

    return { keys };
  }),

  // Mint a new key. The raw `key` is returned exactly once here and is never
  // recoverable afterwards — only its hash is stored.
  create: protectedProcedure
    .input(
      z.object({
        name: z.string().trim().min(1).max(100),
        expiresInDays: z.number().int().min(1).max(3650).nullable().default(null),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const token = generateApiKeyToken();
      const keyHash = await hashApiKey(token);
      const keyPrefix = apiKeyDisplayPrefix(token);
      const expiresAt =
        input.expiresInDays == null ? null : new Date(Date.now() + input.expiresInDays * DAY_MS);

      const [created] = await ctx.db
        .insert(apiKey)
        .values({
          id: crypto.randomUUID(),
          userId: ctx.session.user.id,
          name: input.name,
          keyHash,
          keyPrefix,
          expiresAt,
        })
        .returning({
          id: apiKey.id,
          name: apiKey.name,
          keyPrefix: apiKey.keyPrefix,
          createdAt: apiKey.createdAt,
          expiresAt: apiKey.expiresAt,
        });

      // `key` is the only time the caller sees the raw value.
      return { ...created, key: token };
    }),

  revoke: protectedProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const [revoked] = await ctx.db
        .update(apiKey)
        .set({ revokedAt: new Date() })
        .where(
          and(
            eq(apiKey.id, input.id),
            eq(apiKey.userId, ctx.session.user.id),
            isNull(apiKey.revokedAt),
          ),
        )
        .returning({ id: apiKey.id });

      if (!revoked) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Key not found or already revoked" });
      }

      return { id: revoked.id };
    }),
});
