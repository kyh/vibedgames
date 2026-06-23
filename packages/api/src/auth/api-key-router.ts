import { TRPCError } from "@trpc/server";
import { z } from "zod";

import { createTRPCRouter, protectedProcedure } from "../trpc";

const DAY_SECONDS = 24 * 60 * 60;

// Thin tRPC wrappers over the @better-auth/api-key plugin's server API. They
// run with the request's headers so the plugin scopes keys to the session
// user — note this means key management requires a real session (web cookie
// or a `vg login` token); an API-key-authenticated caller can't mint or
// revoke keys, which is the posture we want for CI credentials.
//
// Field names are mapped to the shape the CLI/web already consume:
// `keyPrefix` ← the plugin's `start` (first chars incl. prefix),
// `lastUsedAt` ← `lastRequest`.
export const apiKeyRouter = createTRPCRouter({
  list: protectedProcedure.query(async ({ ctx }) => {
    const { apiKeys } = await ctx.auth.api.listApiKeys({ headers: ctx.headers });
    const keys = apiKeys.map((k) => ({
      id: k.id,
      name: k.name,
      keyPrefix: k.start ?? k.prefix ?? "",
      createdAt: k.createdAt,
      lastUsedAt: k.lastRequest,
      expiresAt: k.expiresAt,
    }));
    return { keys };
  }),

  // Mint a new key. The raw `key` is returned exactly once here and is never
  // recoverable afterwards — the plugin stores only its hash.
  create: protectedProcedure
    .input(
      z.object({
        name: z.string().trim().min(1).max(100),
        expiresInDays: z.number().int().min(1).max(3650).nullable().default(null),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const created = await ctx.auth.api.createApiKey({
        headers: ctx.headers,
        body: {
          name: input.name,
          expiresIn: input.expiresInDays == null ? null : input.expiresInDays * DAY_SECONDS,
        },
      });

      return {
        id: created.id,
        name: created.name,
        keyPrefix: created.start ?? created.prefix ?? "",
        createdAt: created.createdAt,
        expiresAt: created.expiresAt,
        // `key` is the only time the caller sees the raw value.
        key: created.key,
      };
    }),

  revoke: protectedProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      try {
        await ctx.auth.api.deleteApiKey({ headers: ctx.headers, body: { keyId: input.id } });
      } catch {
        throw new TRPCError({ code: "NOT_FOUND", message: "Key not found" });
      }
      return { id: input.id };
    }),
});
