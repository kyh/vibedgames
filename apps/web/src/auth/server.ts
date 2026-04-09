import { createAuth as initAuth } from "@repo/api/auth/auth";
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
export function getServerContext() {
  const env = getCloudflareEnv();
  const db = createDb(env.DB);

  // Derive baseUrl from the actual request so dev/preview/production all work.
  const headers = new Headers(getRequestHeaders());
  const host = headers.get("host") ?? headers.get("x-forwarded-host");
  const isLocalhost = host === "localhost" || host?.startsWith("localhost:");
  const forwardedProto = headers.get("x-forwarded-proto")?.split(",")[0]?.trim();
  const protocol = forwardedProto ?? (isLocalhost ? "http" : "https");
  const baseUrl = host ? `${protocol}://${host}` : "http://localhost:3000";

  const productionUrl = env.PRODUCTION_URL || baseUrl;

  const auth = initAuth({
    db,
    baseURL: baseUrl,
    productionURL: productionUrl,
    secret: env.AUTH_SECRET,
  });
  return { db, auth, baseUrl, productionUrl };
}

/**
 * Shorthand for handlers that only need `auth` (e.g. `api/auth.$.ts`).
 *
 * Builds the context once per access so the same betterAuth instance is
 * reused for both the handler and any internal getSession calls.
 */
export const auth = {
  handler: (request: Request) => {
    const { auth } = getServerContext();
    return auth.handler(request);
  },
};
