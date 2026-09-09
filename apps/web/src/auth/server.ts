import type { MediaProviderConfig, R2Config } from "@repo/api/orpc";
import { createAuth as initAuth } from "@repo/api/auth/auth";
import { createORPCContext } from "@repo/api/orpc";
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

  // R2 config is optional at build time — a missing value here means the
  // deploy router will throw INTERNAL_SERVER_ERROR rather than the whole
  // request blowing up at handler construction.
  //
  // In local dev we route uploads through `/api/r2-upload` so they land in
  // the Miniflare-simulated bucket instead of leaking into prod R2. The
  // proxy URL is HMAC-signed with BETTER_AUTH_SECRET; the S3 keys are still kept
  // for the `deletePrefix` and read paths (those go through the binding,
  // which is local-safe).
  let r2: R2Config | undefined;
  if (env.GAMES_BUCKET && env.R2_ACCOUNT_ID && env.R2_ACCESS_KEY_ID && env.R2_SECRET_ACCESS_KEY) {
    r2 = {
      accessKeyId: env.R2_ACCESS_KEY_ID,
      accountId: env.R2_ACCOUNT_ID,
      bucket: env.GAMES_BUCKET,
      bucketName: env.R2_BUCKET_NAME,
      secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    };
    if (isLocalhost) {
      r2.proxyUploadBaseUrl = baseUrl;
      r2.proxyUploadSecret = env.BETTER_AUTH_SECRET;
    }
  }

  const media: MediaProviderConfig = {
    fal: env.FAL_API_KEY,
    falDocsBaseUrl: env.FAL_DOCS_BASE_URL,
    falPlatformBaseUrl: env.FAL_PLATFORM_BASE_URL,
    falQueueBaseUrl: env.FAL_QUEUE_BASE_URL,
    falStorageBaseUrl: env.FAL_STORAGE_BASE_URL,
  };

  return { auth, baseUrl, db, media, productionUrl, r2 };
};

/**
 * The one place the Worker bindings are mapped onto the oRPC context.
 *
 * Both transports go through it — the `/api/orpc/$` route and the in-process
 * SSR client in `lib/orpc.tsx` — so a binding added here can't reach one and
 * silently miss the other.
 */
export const createRpcContext = (headers: Headers) => {
  const { db, auth: betterAuth, productionUrl, r2, media } = getServerContext();
  return createORPCContext({
    auth: betterAuth,
    db,
    headers,
    media,
    productionURL: productionUrl,
    r2,
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
