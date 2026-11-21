import type { Db } from "@repo/db/drizzle-client";
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

import type { Mailer } from "../email/mailer";
import { passwordResetEmail } from "../email/templates";
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
  /** Where social sign-in's provider callbacks are registered; oAuthProxy sends other origins through it. */
  productionURL?: string;
  /** Encrypts the profile oAuthProxy hands back; the same on production and every Preview. */
  oauthProxySecret?: string;
  trustedOrigins?: string[];
  github?: SocialProviderCredentials;
  google?: SocialProviderCredentials;
  /** Sends password-reset links; without one, a reset request is refused. */
  mailer?: Mailer;
}

interface SocialProviderConfig {
  clientId: string;
  clientSecret: string;
}

interface SocialProviders {
  github?: SocialProviderConfig;
  google?: SocialProviderConfig;
}

const configured = (credentials: SocialProviderCredentials | undefined) =>
  credentials?.clientId && credentials.clientSecret
    ? { clientId: credentials.clientId, clientSecret: credentials.clientSecret }
    : undefined;

export const createAuth = (opts: AuthOptions) => {
  const { db, baseURL, mailer, secret, productionURL = baseURL } = opts;
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
    // WARNING: never enable crossSubDomainCookies: {slug}.vibedgames.com serves untrusted game code.
    advanced: {
      crossSubDomainCookies: { enabled: false },
      defaultCookieAttributes: {
        sameSite: "lax",
        secure: true,
      },
      ipAddress: {
        ipAddressHeaders: ["cf-connecting-ip", "x-forwarded-for"],
      },
    },
    baseURL,
    database: drizzleAdapter(db, {
      provider: "sqlite",
    }),
    disabledPaths: ["/token"],
    emailAndPassword: {
      enabled: true,
      // A reset usually means the old password leaked, so every session that knew it ends.
      revokeSessionsOnPasswordReset: true,
      sendResetPassword: mailer
        ? ({ user, url }) => mailer({ to: user.email, ...passwordResetEmail(url) })
        : undefined,
    },
    plugins: [
      oAuthProxy({
        currentURL: baseURL,
        productionURL,
        secret: opts.oauthProxySecret,
      }),
      bearer(),
      expo(),
      admin(),
      // WARNING: never enable the API-key plugin's session mocking; keys resolve only through verifyApiKey.
      apiKey({
        defaultPrefix: "vg_",
        rateLimit: { enabled: false },
        requireName: true,
      }),
      jwt(),
      nativeLoopbackClients(),
      seedFailureContained(
        mcp({
          allowDynamicClientRegistration: true,
          allowUnauthenticatedClientRegistration: true,
          cachedResources: new Set([resources.mcp, resources.api]),
          clientRegistrationAllowedResources: [resources.mcp, resources.api],
          clientRegistrationDefaultResources: [resources.mcp, resources.api],
          consentPage: "/oauth/consent",
          loginPage: "/auth/login",
          refreshTokenReuseInterval: 30,
          resource: resources.mcp,
          resources: [{ identifier: resources.api, name: "vibedgames API" }],
          scopes: [...DEFAULT_OAUTH_SCOPES, ...Object.keys(OAUTH_SCOPES)],
        }),
      ),
      cimd({ fetchClientMetadataResource, metadataProfile: "mcp-2026-07-28" }),
      oauthDeviceAuthorization({ expiresIn: "10m", verificationUri: "/device" }),
      seedFailureContained(firstPartyCliClient(resources.api)),
    ],
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
    socialProviders,
    trustedOrigins: opts.trustedOrigins ?? ["expo://"],
    user: {
      additionalFields: {
        invitedByCode: { input: false, required: false, type: "string" },
      },
    },
  });

  return auth;
};

const LOOPBACK_REDIRECT = /^http:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?\//u;

const untypedRegistration = z.looseObject({
  application_type: z.never().optional(),
  redirect_uris: z.array(z.string()).min(1),
});

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

const seedFailureContained: <P extends BetterAuthPlugin>(plugin: P) => P = <
  P extends BetterAuthPlugin,
>(
  plugin: P,
) => {
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
