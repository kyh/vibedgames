import { APIError } from "better-auth/api";
import { ORPCError } from "@orpc/server";
import { z } from "zod";

import { sessionOnlyProcedure } from "../orpc";

const DAY_SECONDS = 24 * 60 * 60;

// better-auth APIError statuses (HTTP-status name strings) that name an oRPC
// error code too, so they pass straight through. `as const` keeps the literal
// union — `ORPCError` takes any string, so a typo here would otherwise compile
// and quietly become an unknown code served as a 500. Anything not listed
// falls back to INTERNAL_SERVER_ERROR.
const PASSTHROUGH_API_ERROR_STATUSES = [
  "NOT_FOUND",
  "UNAUTHORIZED",
  "FORBIDDEN",
  "BAD_REQUEST",
  "TOO_MANY_REQUESTS",
] as const;

// Thin oRPC wrappers over the @better-auth/api-key plugin's server API. They
// use `sessionOnlyProcedure`, so managing keys requires a real session (web
// cookie or a `vg login` token) — an API-key-authenticated caller is rejected,
// which is the posture we want for CI credentials (a leaked key can't mint or
// revoke siblings). They run with the request's headers so the plugin scopes
// keys to the session user.
//
// Field names are mapped to the shape the CLI/web already consume:
// `keyPrefix` ← the plugin's `start` (first chars incl. prefix),
// `lastUsedAt` ← `lastRequest`.
export const apiKeyRouter = {
  list: sessionOnlyProcedure.handler(async ({ context }) => {
    const { apiKeys } = await context.auth.api.listApiKeys({ headers: context.headers });
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
    .handler(async ({ context, input }) => {
      const created = await context.auth.api.createApiKey({
        headers: context.headers,
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
    .handler(async ({ context, input }) => {
      try {
        await context.auth.api.deleteApiKey({
          headers: context.headers,
          body: { keyId: input.id },
        });
        return { id: input.id };
      } catch (err) {
        // Translate the plugin's APIError to the matching oRPC code (a missing
        // key is NOT_FOUND, a bad input BAD_REQUEST, etc.) instead of flattening
        // everything — so callers see the real failure. Unknown statuses fall
        // back to INTERNAL_SERVER_ERROR.
        if (err instanceof APIError) {
          const status = String(err.status);
          throw new ORPCError(
            PASSTHROUGH_API_ERROR_STATUSES.find((code) => code === status) ??
              "INTERNAL_SERVER_ERROR",
            { message: err.message || "Failed to revoke key" },
          );
        }
        throw err;
      }
    }),
};
