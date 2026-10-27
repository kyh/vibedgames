import type {
  BillingConfig,
  DecisionProviderConfig,
  MediaProviderConfig,
  R2Config,
  UrlSigning,
} from "@repo/service/orpc";
import { createAuth as initAuth } from "@repo/service/auth/auth";
import { oauthResources } from "@repo/service/auth/oauth-resources";
import { createORPCContext } from "@repo/service/orpc";
import { createDb } from "@repo/db/drizzle-client";
import { getRequestHeaders } from "@tanstack/react-start/server";

import { getCloudflareEnv } from "@/lib/cloudflare";

/**
 * Per-request db + auth factory.
 *
 * D1 is bound per-request via the Worker `env`, so unlike the t3-turbo
 * template (which uses a module-level `db`/`auth` singleton backed by
 * Vercel Postgres HTTP), we construct both inside each handler.
 *
 * The baseUrl is derived from the incoming request's Host header so it
 * correctly reflects localhost in dev, preview domains, and production.
 */
type Env = ReturnType<typeof getCloudflareEnv>;

/**
 * One auth instance per isolate and origin. Building one is not free: the
 * OAuth provider seeds its protected-resource rows at init, a D1 read per
 * resource, which would otherwise run on every request.
 */
const authInstances = new WeakMap<Env, Map<string, ReturnType<typeof initAuth>>>();

const authFor = (
  env: Env,
  db: ReturnType<typeof createDb>,
  baseUrl: string,
  productionUrl: string,
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
      productionURL: productionUrl,
      secret: env.BETTER_AUTH_SECRET,
    });
    byOrigin.set(baseUrl, auth);
  }
  return auth;
};

export const getServerContext = () => {
  const env = getCloudflareEnv();
  const db = createDb(env.DB);

  // Derive baseUrl from the actual request so dev/preview/production all work.
  const headers = new Headers(getRequestHeaders());
  const host = headers.get("host") ?? headers.get("x-forwarded-host");
  // Any loopback host is the dev server, served over plain HTTP.
  const hostname = host ? new URL(`http://${host}`).hostname : null;
  const isLocalhost = hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
  const forwardedProto = headers.get("x-forwarded-proto")?.split(",")[0]?.trim();
  const protocol = forwardedProto || (isLocalhost ? "http" : "https");
  const baseUrl = host ? `${protocol}://${host}` : "http://localhost:3000";

  const productionUrl = env.PRODUCTION_URL || baseUrl;

  const auth = authFor(env, db, baseUrl, productionUrl);

  // Bytes reach R2 only through the binding: `/api/upload` and `/api/download`
  // URLs, signed with the auth secret, point back at this same host, so dev
  // lands in Miniflare, a Preview in its own bucket, and production in prod.
  const r2: R2Config | undefined = env.GAMES_BUCKET ? { bucket: env.GAMES_BUCKET } : undefined;
  // No secret, no URLs: an empty HMAC key is refused, and a guessable one would let anyone write.
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
export const socialSignInProviders = (): ("github" | "google")[] => {
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
