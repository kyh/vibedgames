import { createAuth as initAuth } from "@repo/api/auth/auth";
import { createDb } from "@repo/db/drizzle-client";

import { getCloudflareEnv } from "~/lib/cloudflare";
import { getBaseUrl } from "~/lib/url";

/**
 * Per-request db + auth factory.
 *
 * D1 is bound per-request via the Worker `env`, so unlike the t3-turbo
 * template (which uses a module-level `db`/`auth` singleton backed by
 * Vercel Postgres HTTP), we construct both inside each handler.
 */
export function getServerContext() {
  const env = getCloudflareEnv();
  const db = createDb(env.DB);
  const baseUrl = getBaseUrl();
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
 * Mirrors the t3-turbo `auth` export shape as closely as possible.
 */
export const auth = {
  handler: (request: Request) => getServerContext().auth.handler(request),
  api: {
    getSession: (opts: { headers: Headers }) =>
      getServerContext().auth.api.getSession(opts),
  },
};
