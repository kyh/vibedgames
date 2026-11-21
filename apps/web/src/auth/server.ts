import type {
  BillingConfig,
  DecisionProviderConfig,
  MediaProviderConfig,
  R2Config,
  UrlSigning,
} from "@repo/service/orpc";
import type { Mailer } from "@repo/service/email/mailer";
import { createAuth as initAuth } from "@repo/service/auth/auth";
import { consoleMailer, resendMailer } from "@repo/service/email/mailer";
import { oauthResources } from "@repo/service/auth/oauth-resources";
import { createORPCContext } from "@repo/service/orpc";
import { createDb } from "@repo/db/drizzle-client";
import { getRequestHeaders } from "@tanstack/react-start/server";

import { getCloudflareEnv } from "@/lib/cloudflare";

type Env = ReturnType<typeof getCloudflareEnv>;

const authInstances = new WeakMap<Env, Map<string, ReturnType<typeof initAuth>>>();

const authFor = (
  env: Env,
  db: ReturnType<typeof createDb>,
  baseUrl: string,
  productionUrl: string,
  mailer: Mailer | undefined,
) => {
  let byOrigin = authInstances.get(env);

  if (!byOrigin) {
    byOrigin = new Map();
    authInstances.set(env, byOrigin);
  }

  let auth = byOrigin.get(baseUrl);

  if (!auth) {
    auth = initAuth({
      baseURL: baseUrl,
      db,
      github: { clientId: env.GITHUB_CLIENT_ID, clientSecret: env.GITHUB_CLIENT_SECRET },
      google: { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET },
      mailer,
      oauthProxySecret: env.OAUTH_PROXY_SECRET || undefined,
      productionURL: env.OAUTH_PROXY_URL || productionUrl,
      secret: env.BETTER_AUTH_SECRET,
    });
    byOrigin.set(baseUrl, auth);
  }

  return auth;
};

/** Without a key, only the dev server gets a mailer: there the reset link is read off its log. */
const mailerFor = (env: Env, isLocalhost: boolean): Mailer | undefined => {
  if (env.RESEND_API_KEY) {
    return resendMailer({ apiKey: env.RESEND_API_KEY });
  }
  return isLocalhost ? consoleMailer : undefined;
};

export const getServerContext = () => {
  const env = getCloudflareEnv();
  const db = createDb(env.DB);

  const headers = new Headers(getRequestHeaders());
  const host = headers.get("host") ?? headers.get("x-forwarded-host");
  const hostname = host ? new URL(`http://${host}`).hostname : null;
  const isLocalhost = hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
  const forwardedProto = headers.get("x-forwarded-proto")?.split(",")[0]?.trim();
  const protocol = forwardedProto || (isLocalhost ? "http" : "https");
  const baseUrl = host ? `${protocol}://${host}` : "http://localhost:3000";

  const productionUrl = env.PRODUCTION_URL || baseUrl;

  const auth = authFor(env, db, baseUrl, productionUrl, mailerFor(env, isLocalhost));

  const r2: R2Config | undefined = env.GAMES_BUCKET ? { bucket: env.GAMES_BUCKET } : undefined;

  const signing: UrlSigning | undefined = env.BETTER_AUTH_SECRET
    ? { baseUrl, secret: env.BETTER_AUTH_SECRET }
    : undefined;

  const media: MediaProviderConfig = {
    fal: env.FAL_API_KEY,
    falDocsBaseUrl: env.FAL_DOCS_BASE_URL,
    falPlatformBaseUrl: env.FAL_PLATFORM_BASE_URL,
    falQueueBaseUrl: env.FAL_QUEUE_BASE_URL,
    falStorageBaseUrl: env.FAL_STORAGE_BASE_URL,
  };

  const decision: DecisionProviderConfig = {
    tokenSecret: env.BETTER_AUTH_SECRET,
    typesafe: env.TYPESAFE_API_KEY,
    typesafeBaseUrl: env.TYPESAFE_BASE_URL,
  };

  const billing: BillingConfig = {
    stripeApiBaseUrl: env.STRIPE_API_BASE_URL,
    stripeSecretKey: env.STRIPE_SECRET_KEY,
    stripeWebhookSecret: env.STRIPE_WEBHOOK_SECRET,
  };

  return { auth, baseUrl, billing, db, decision, media, productionUrl, r2, signing };
};

/** The social sign-in providers this deployment has credentials for, in button order. */
export const socialSignInProviders = () => {
  const providers = getServerContext().auth.options.socialProviders ?? {};

  return (["github", "google"] as const).filter((id) => id in providers);
};

/**
 * Which protected resource a request is for: OAuth access tokens are
 * audience-bound, so one granted for MCP never drives the API and back.
 */
export type OAuthSurface = keyof ReturnType<typeof oauthResources>;

/**
 * The one place the Worker bindings are mapped onto the oRPC context.
 *
 * Both transports go through it — the `/api/orpc/$` route and the in-process
 * SSR client in `lib/orpc.tsx` — so a binding added here can't reach one and
 * silently miss the other.
 */
export const createRpcContext = (headers: Headers, surface: OAuthSurface = "api") => {
  const {
    baseUrl,
    db,
    auth: betterAuth,
    billing,
    productionUrl,
    r2,
    media,
    decision,
    signing,
  } = getServerContext();

  return createORPCContext({
    auth: betterAuth,
    billing,
    db,
    decision,
    headers,
    media,
    oauthResource: oauthResources(baseUrl)[surface],
    productionURL: productionUrl,
    r2,
    signing,
  });
};

/**
 * Shorthand for handlers that only need `auth` (e.g. `api/auth.$.ts`).
 *
 * Builds the context once per access so the same betterAuth instance is
 * reused for both the handler and any internal getSession calls.
 */
export const auth = {
  handler: (request: Request) => {
    const { auth: betterAuth } = getServerContext();

    return betterAuth.handler(request);
  },
};
