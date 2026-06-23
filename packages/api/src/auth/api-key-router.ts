import { APIError } from "better-auth/api";
import { TRPCError } from "@trpc/server";
import { z } from "zod";

import { createTRPCRouter, sessionOnlyProcedure } from "../trpc";

const DAY_SECONDS = 24 * 60 * 60;

// Map better-auth APIError statuses (HTTP-status name strings) to tRPC error
// codes. Anything not listed falls back to INTERNAL_SERVER_ERROR.
const API_ERROR_TO_TRPC: Record<string, TRPCError["code"]> = {
  NOT_FOUND: "NOT_FOUND",
  UNAUTHORIZED: "UNAUTHORIZED",
  FORBIDDEN: "FORBIDDEN",
  BAD_REQUEST: "BAD_REQUEST",
  TOO_MANY_REQUESTS: "TOO_MANY_REQUESTS",
};

// Thin tRPC wrappers over the @better-auth/api-key plugin's server API. They
// use `sessionOnlyProcedure`, so managing keys requires a real session (web
// cookie or a `vg login` token) — an API-key-authenticated caller is rejected,
// which is the posture we want for CI credentials (a leaked key can't mint or
// revoke siblings). They run with the request's headers so the plugin scopes
// keys to the session user.
//
// Field names are mapped to the shape the CLI/web already consume:
// `keyPrefix` ← the plugin's `start` (first chars incl. prefix),
// `lastUsedAt` ← `lastRequest`.
export const apiKeyRouter = createTRPCRouter({
  list: sessionOnlyProcedure.query(async ({ ctx }) => {
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
  create: sessionOnlyProcedure
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

  revoke: sessionOnlyProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      try {
        await ctx.auth.api.deleteApiKey({ headers: ctx.headers, body: { keyId: input.id } });
        return { id: input.id };
      } catch (err) {
        // Translate the plugin's APIError to the matching tRPC code (a missing
        // key is NOT_FOUND, a bad input BAD_REQUEST, etc.) instead of flattening
        // everything — so callers see the real failure. Unknown statuses fall
        // back to INTERNAL_SERVER_ERROR.
        if (err instanceof APIError) {
          throw new TRPCError({
            code: API_ERROR_TO_TRPC[String(err.status)] ?? "INTERNAL_SERVER_ERROR",
            message: err.message || "Failed to revoke key",
          });
        }
        throw err;
      }
    }),
});
