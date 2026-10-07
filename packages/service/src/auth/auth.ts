import type { Db } from "@repo/db/drizzle-client";
// relations-v2, not `better-auth/adapters/drizzle`: the default entry reads `db._.fullSchema`, gone in
// drizzle 1.0; relations-v2 resolves tables through `db._.relations`, which `createDb` supplies.
import { drizzleAdapter } from "@better-auth/drizzle-adapter/relations-v2";
import { apiKey } from "@better-auth/api-key";
import { expo } from "@better-auth/expo";
import { betterAuth } from "better-auth";
import { admin, bearer, oAuthProxy } from "better-auth/plugins";

export interface AuthOptions {
  db: Db;
  baseURL: string;
  secret: string;
  productionURL?: string;
  trustedOrigins?: string[];
}

export const createAuth = (opts: AuthOptions) => {
  const { db, baseURL, secret, productionURL = baseURL } = opts;

  const auth = betterAuth({
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
    baseURL,
    database: drizzleAdapter(db, {
      provider: "sqlite",
    }),
    emailAndPassword: {
      enabled: true,
    },
    plugins: [
      oAuthProxy({
        currentURL: baseURL,
        productionURL,
      }),
      bearer(),
      expo(),
      admin(),
      // Long-lived API keys for CLI/CI. Keys carry the `vg_` prefix so the
      // oRPC context can tell them apart from session tokens on the shared
      // `Authorization: Bearer` header. We do NOT enable session-mocking for
      // keys (the plugin flags it as not production-safe); instead the oRPC
      // context resolves keys explicitly via `verifyApiKey`. Rate limiting is
      // off — these are deploy/automation keys, not public-facing.
      apiKey({
        defaultPrefix: "vg_",
        rateLimit: { enabled: false },
        requireName: true,
      }),
    ],
    // Persist rate-limit counters in D1. The default in-memory store keeps
    // per-isolate counters, so on Cloudflare Workers the effective limit
    // multiplies across isolates and resets on eviction — no real protection.
    // 10 requests/60s per IP throttles credential-stuffing against auth routes.
    rateLimit: {
      enabled: true,
      max: 10,
      storage: "database",
      window: 60,
    },
    secret,
    trustedOrigins: opts.trustedOrigins ?? ["expo://"],
    user: {
      // `invited_by_code` records the invite a pre-launch account signed up
      // with; nothing writes it any more. `input: false` keeps request bodies
      // from setting it — it decides who holds the legacy signup grant.
      additionalFields: {
        invitedByCode: { input: false, required: false, type: "string" },
      },
    },
  });

  return auth;
};

export type Auth = ReturnType<typeof createAuth>;
export type Session = Auth["$Infer"]["Session"];
