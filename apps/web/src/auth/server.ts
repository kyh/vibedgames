import type {
  BillingConfig,
  DecisionProviderConfig,
  MediaProviderConfig,
  R2Config,
  UrlSigning,
} from "@repo/service/orpc";
import { createAuth as initAuth } from "@repo/service/auth/auth";
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
export const getServerContext = () => {
  const env = getCloudflareEnv();
  const db = createDb(env.DB);

  // Derive baseUrl from the actual request so dev/preview/production all work.
  const headers = new Headers(getRequestHeaders());
  const host = headers.get("host") ?? headers.get("x-forwarded-host");
  const isLocalhost = host === "localhost" || host?.startsWith("localhost:");
  const forwardedProto = headers.get("x-forwarded-proto")?.split(",")[0]?.trim();
  const protocol = forwardedProto || (isLocalhost ? "http" : "https");
  const baseUrl = host ? `${protocol}://${host}` : "http://localhost:3000";

  const productionUrl = env.PRODUCTION_URL || baseUrl;

  const auth = initAuth({
    baseURL: baseUrl,
    db,
    productionURL: productionUrl,
    secret: env.BETTER_AUTH_SECRET,
  });

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

/**
 * The one place the Worker bindings are mapped onto the oRPC context.
 *
 * Both transports go through it — the `/api/orpc/$` route and the in-process
 * SSR client in `lib/orpc.tsx` — so a binding added here can't reach one and
 * silently miss the other.
 */
export const createRpcContext = (headers: Headers) => {
  const {
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
