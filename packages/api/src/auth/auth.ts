import type { Db } from "@repo/db/drizzle-client";
import { apiKey } from "@better-auth/api-key";
import { expo } from "@better-auth/expo";
import { eq } from "@repo/db";
import { user as userTable } from "@repo/db/drizzle-schema-auth";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError } from "better-auth/api";
import { admin, bearer, oAuthProxy } from "better-auth/plugins";

import { normalizeInviteCode, tryClaimInviteCode, validateInviteCode } from "./invite-claim";

export type AuthOptions = {
  db: Db;
  baseURL: string;
  secret: string;
  productionURL?: string;
  trustedOrigins?: string[];
};

export const createAuth = (opts: AuthOptions) => {
  const { db, baseURL, secret, productionURL = baseURL } = opts;

  const auth = betterAuth({
    database: drizzleAdapter(db, {
      provider: "sqlite",
    }),
    baseURL,
    secret,
    plugins: [
      oAuthProxy({
        currentURL: baseURL,
        productionURL,
      }),
      bearer(),
      expo(),
      admin(),
      // Long-lived API keys for CLI/CI. Keys carry the `vg_` prefix so the
      // tRPC context can tell them apart from session tokens on the shared
      // `Authorization: Bearer` header. We do NOT enable session-mocking for
      // keys (the plugin flags it as not production-safe); instead the tRPC
      // context resolves keys explicitly via `verifyApiKey`. Rate limiting is
      // off — these are deploy/automation keys, not public-facing.
      apiKey({
        defaultPrefix: "vg_",
        requireName: true,
        rateLimit: { enabled: false },
      }),
    ],
    emailAndPassword: {
      enabled: true,
    },
    user: {
      // `invited_by_code` exists on the user table (see drizzle-schema-auth)
      // but is never set via client input — `input: false` blocks request
      // bodies from populating it, and the `after` hook below writes it
      // directly via Drizzle once the invite code is claimed.
      additionalFields: {
        invitedByCode: { type: "string", required: false, input: false },
      },
    },
    databaseHooks: {
      user: {
        create: {
          // Gate signup behind an invite code while the platform is in
          // early preview. Only enforced on the public email sign-up path —
          // admin-initiated user creation (`/admin/create-user`) is exempt
          // so admins can mint accounts without burning a code.
          //
          // We split the work so a downstream failure (e.g. duplicate
          // email) doesn't burn a single-use code:
          //   before — read-only validation; throws on bad code so no user
          //            row is ever inserted
          //   after  — atomic claim from the request body (NOT from the
          //            user object: better-auth's additionalFields can be
          //            stripped before reaching hooks, see better-auth
          //            issues #6593 / #7061). Persist invitedByCode via
          //            Drizzle. If we lose a concurrent race, delete the
          //            just-created user and surface a 409.
          before: async (user, ctx) => {
            if (ctx?.path !== "/sign-up/email") {
              return { data: user };
            }
            await validateInviteCode(db, ctx.body?.inviteCode);
            return { data: user };
          },
          after: async (user, ctx) => {
            if (ctx?.path !== "/sign-up/email") return;
            const code = normalizeInviteCode(ctx.body?.inviteCode);
            if (!code) return; // before-hook would have thrown; defensive
            const claimed = await tryClaimInviteCode(db, code);
            if (!claimed) {
              await db.delete(userTable).where(eq(userTable.id, user.id));
              throw new APIError("CONFLICT", {
                message: "Invite code was just claimed by someone else.",
              });
            }
            await db
              .update(userTable)
              .set({ invitedByCode: code })
              .where(eq(userTable.id, user.id));
          },
        },
      },
    },
    trustedOrigins: opts.trustedOrigins ?? ["expo://"],
    // Persist rate-limit counters in D1. The default in-memory store keeps
    // per-isolate counters, so on Cloudflare Workers the effective limit
    // multiplies across isolates and resets on eviction — no real protection.
    // 10 requests/60s per IP throttles credential-stuffing against auth routes.
    rateLimit: {
      enabled: true,
      storage: "database",
      window: 60,
      max: 10,
    },
    // Keep the session cookie host-only so user-uploaded games served from
    // `{slug}.vibedgames.com` never see it. We explicitly DO NOT enable
    // crossSubDomainCookies — the platform domain hosts untrusted code.
    advanced: {
      crossSubDomainCookies: { enabled: false },
      defaultCookieAttributes: {
        sameSite: "lax",
        secure: true,
      },
      // Rate-limit buckets key on client IP. `cf-connecting-ip` is set by
      // the Cloudflare edge (not client-forgeable there); `x-forwarded-for`
      // is the local-dev fallback so the limiter doesn't collapse into one
      // shared per-path bucket.
      ipAddress: {
        ipAddressHeaders: ["cf-connecting-ip", "x-forwarded-for"],
      },
    },
  });

  return auth;
};

export type Auth = ReturnType<typeof createAuth>;
export type Session = Auth["$Infer"]["Session"];
