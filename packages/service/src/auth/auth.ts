import type { Db } from "@repo/db/drizzle-client";
// relations-v2, not `better-auth/adapters/drizzle`: the default entry reads `db._.fullSchema`, gone in
// drizzle 1.0; relations-v2 resolves tables through `db._.relations`, which `createDb` supplies.
import { drizzleAdapter } from "@better-auth/drizzle-adapter/relations-v2";
import { apiKey } from "@better-auth/api-key";
import { expo } from "@better-auth/expo";
import { cimd } from "@better-auth/cimd";
import { mcp } from "@better-auth/mcp";
import {
  DEFAULT_OAUTH_SCOPES,
  DEVICE_CODE_GRANT_TYPE,
  oauthDeviceAuthorization,
} from "@better-auth/oauth-provider";
import { CLI_OAUTH_CLIENT_ID, CLI_OAUTH_SCOPES } from "@repo/contract/cli";
import { OAUTH_SCOPES } from "@repo/contract/auth/oauth-scopes";
import type { BetterAuthPlugin } from "better-auth";
import { betterAuth } from "better-auth";
import { admin, bearer, jwt, oAuthProxy } from "better-auth/plugins";
import { z } from "zod";

import { fetchClientMetadataResource } from "./cimd-fetch";
import { oauthResources } from "./oauth-resources";

/** An OAuth app a person signs in with; either is on only when both halves are set. */
export interface SocialProviderCredentials {
  clientId?: string;
  clientSecret?: string;
}

export interface AuthOptions {
  db: Db;
  baseURL: string;
  secret: string;
  productionURL?: string;
  trustedOrigins?: string[];
  github?: SocialProviderCredentials;
  google?: SocialProviderCredentials;
}

interface SocialProviderConfig {
  clientId: string;
  clientSecret: string;
}

interface SocialProviders {
  github?: SocialProviderConfig;
  google?: SocialProviderConfig;
}

const configured = (
  credentials: SocialProviderCredentials | undefined,
): SocialProviderConfig | undefined =>
  credentials?.clientId && credentials.clientSecret
    ? { clientId: credentials.clientId, clientSecret: credentials.clientSecret }
    : undefined;

export const createAuth = (opts: AuthOptions) => {
  const { db, baseURL, secret, productionURL = baseURL } = opts;
  const resources = oauthResources(baseURL);
  const socialProviders: SocialProviders = {};
  const github = configured(opts.github);
  if (github) {
    socialProviders.github = github;
  }
  const google = configured(opts.google);
  if (google) {
    socialProviders.google = google;
  }

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
    // The JWT plugin's `/token` mints a JWT for any signed-in session; OAuth
    // access tokens come from `/oauth2/token` instead, so it stays off.
    disabledPaths: ["/token"],
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
      // Signs OAuth access tokens (JWTs bound to a resource) and serves the
      // keys at `/api/auth/jwks`.
      jwt(),
      // vibedgames as an OAuth 2.1 authorization server: an MCP client
      // (claude.ai, ChatGPT, Claude Code) or a third-party app sends a person
      // to `/auth/login` and `/oauth/consent`, and gets a token bound to `/mcp`
      // or the API (`oauth-resources.ts`). Clients register themselves (RFC
      // 7591), as today's MCP connectors expect; PKCE is required for them.
      nativeLoopbackClients(),
      seedFailureContained(
        mcp({
          allowDynamicClientRegistration: true,
          allowUnauthenticatedClientRegistration: true,
          // Both resources come from this config, so a per-request D1 read of their rows buys nothing.
          cachedResources: new Set([resources.mcp, resources.api]),
          clientRegistrationAllowedResources: [resources.mcp, resources.api],
          clientRegistrationDefaultResources: [resources.mcp, resources.api],
          consentPage: "/oauth/consent",
          loginPage: "/auth/login",
          // A refresh token rotates on use, and reusing a rotated one revokes
          // the whole family. Parallel `vg` commands (an agent's) can refresh
          // with the same token at once; within this window the loser gets
          // the winner's response replayed instead of a logout.
          refreshTokenReuseInterval: 30,
          resource: resources.mcp,
          resources: [{ identifier: resources.api, name: "vibedgames API" }],
          // OpenID's, plus one per kind of action (`@repo/contract/auth/oauth-scopes`),
          // each checked by `requireSession` against the procedure's own.
          scopes: [...DEFAULT_OAUTH_SCOPES, ...Object.keys(OAUTH_SCOPES)],
        }),
      ),
      // Client ID Metadata Documents, how MCP 2026-07-28 clients identify
      // themselves: the client_id is an HTTPS URL to its metadata. Registration
      // above stays for clients from before it.
      cimd({ fetchClientMetadataResource, metadataProfile: "mcp-2026-07-28" }),
      // RFC 8628 for `vg login`: the CLI asks for a device code, the person
      // approves its user code at `/device`, and the CLI receives OAuth
      // tokens for the API, scoped and refreshable, as the client below.
      oauthDeviceAuthorization({ expiresIn: "10m", verificationUri: "/device" }),
      seedFailureContained(firstPartyCliClient(resources.api)),
    ],
    // Persist rate-limit counters in D1. The default in-memory store keeps
    // per-isolate counters, so on Cloudflare Workers the effective limit
    // multiplies across isolates and resets on eviction — no real protection.
    // 10 requests/60s per IP throttles credential-stuffing against auth routes.
    // The OAuth endpoints are called server to server: every claude.ai user's
    // token exchange and refresh arrives from the same few addresses, so the
    // per-IP sign-in limit would lock all of them out together. Codes and
    // refresh tokens are unguessable, so the token endpoint needs none;
    // registration keeps a looser one, as it writes a row for anyone.
    rateLimit: {
      customRules: {
        "/oauth2/register": { max: 120, window: 60 },
        "/oauth2/token": false,
      },
      enabled: true,
      max: 10,
      storage: "database",
      window: 60,
    },
    secret,
    // Sign in with GitHub or Google, each only once its app's credentials
    // are set. Account linking stays on its default: by verified email.
    socialProviders,
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

/**
 * A registration that omits `application_type` is a web client under RFC
 * 7591, and the provider then refuses an `http://localhost` redirect. The
 * native MCP clients (Claude Code, Cursor, VS Code) register exactly that and
 * never send the field, so a registration whose every redirect is a loopback
 * address is read as the native app it is (RFC 8252 §7.3). Anything else is
 * left as sent.
 */
const LOOPBACK_REDIRECT = /^http:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?\//u;

const untypedRegistration = z.looseObject({
  application_type: z.never().optional(),
  redirect_uris: z.array(z.string()).min(1),
});

/**
 * Runs before routing, so the provider's own body validation sees the
 * corrected registration; a hook would run after it.
 */
const nativeLoopbackClients = () =>
  ({
    id: "native-loopback-clients",
    onRequest: async (request: Request) => {
      if (
        request.method !== "POST" ||
        !new URL(request.url).pathname.endsWith("/oauth2/register")
      ) {
        return;
      }
      const registration = untypedRegistration.safeParse(
        await request
          .clone()
          .json()
          .catch(() => null),
      );
      if (
        !registration.success ||
        !registration.data.redirect_uris.every((uri) => LOOPBACK_REDIRECT.test(uri))
      ) {
        return;
      }
      const headers = new Headers(request.headers);
      headers.delete("content-length");
      return {
        request: new Request(request.url, {
          body: JSON.stringify({ ...registration.data, application_type: "native" }),
          headers,
          method: "POST",
        }),
      };
    },
  }) satisfies BetterAuthPlugin;

/**
 * The OAuth provider seeds its `oauth_resource` rows when auth starts, and a
 * failed seed fails the whole auth context: every sign-in, session read and
 * API key with it. A database not yet carrying the OAuth tables (a deploy
 * ahead of its `db:push-remote`, a preview pushed from another branch) must
 * cost OAuth alone, so the failure is logged and auth starts without the
 * provider's init. The seed runs again on the first OAuth request, which
 * fails on its own until the tables exist.
 */
const seedFailureContained = <P extends BetterAuthPlugin>(plugin: P): P => {
  const { init } = plugin;
  if (!init) {
    return plugin;
  }
  return {
    ...plugin,
    init: async (ctx) => {
      try {
        return await init(ctx);
      } catch (error) {
        ctx.logger.error(
          "OAuth provider init failed; OAuth is unavailable until it succeeds",
          error,
        );
      }
    },
  };
};

/**
 * Seeds the OAuth client `vg login` signs in as (`CLI_OAUTH_CLIENT_ID`): a
 * public, first-party client allowed only the device-code and refresh-token
 * grants, every scope, and the API resource. The `/device` page is its
 * consent, so the provider's consent screen is skipped. A row that exists
 * has its scopes brought up to `CLI_OAUTH_SCOPES`, so a scope added later
 * reaches the next `vg login`, and is bound to this origin's API resource.
 */
const firstPartyCliClient = (apiResource: string) =>
  ({
    id: "first-party-cli-client",
    init: async (ctx) => {
      const existing = await ctx.adapter.findOne<{ scopes?: string[] | null }>({
        model: "oauthClient",
        where: [{ field: "clientId", value: CLI_OAUTH_CLIENT_ID }],
      });
      const now = new Date();
      if (!existing) {
        await ctx.adapter.create({
          data: {
            applicationType: "native",
            clientId: CLI_OAUTH_CLIENT_ID,
            createdAt: now,
            disabled: false,
            grantTypes: [DEVICE_CODE_GRANT_TYPE, "refresh_token"],
            name: "vg CLI",
            redirectUris: [],
            requirePKCE: false,
            responseTypes: [],
            scopes: CLI_OAUTH_SCOPES,
            skipConsent: true,
            tokenEndpointAuthMethod: "none",
            updatedAt: now,
            uri: "https://www.npmjs.com/package/vibedgames",
          },
          model: "oauthClient",
        });
      } else if (JSON.stringify(existing.scopes) !== JSON.stringify(CLI_OAUTH_SCOPES)) {
        await ctx.adapter.update({
          model: "oauthClient",
          update: { scopes: CLI_OAUTH_SCOPES, updatedAt: now },
          where: [{ field: "clientId", value: CLI_OAUTH_CLIENT_ID }],
        });
      }
      // Bound per origin: one database can serve several (localhost and
      // 127.0.0.1 locally), each with its own `/api` resource. Checked on
      // every init, so a binding a failed init skipped is made on the next.
      const bound = await ctx.adapter.findOne({
        model: "oauthClientResource",
        where: [
          { field: "clientId", value: CLI_OAUTH_CLIENT_ID },
          { field: "resourceId", value: apiResource },
        ],
      });
      if (!bound) {
        await ctx.adapter.create({
          data: { clientId: CLI_OAUTH_CLIENT_ID, createdAt: now, resourceId: apiResource },
          model: "oauthClientResource",
        });
      }
    },
  }) satisfies BetterAuthPlugin;

export type Auth = ReturnType<typeof createAuth>;
export type Session = Auth["$Infer"]["Session"];
