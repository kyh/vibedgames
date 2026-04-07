import { createAuth } from "@repo/api/auth/auth";
import { createDb } from "@repo/db/drizzle-client";

/**
 * Build the per-request server context (db + auth) from a Cloudflare Worker
 * `env` binding. Called from each route handler / tRPC fetch handler.
 */
export const createServerContext = (env: CloudflareEnv, request: Request) => {
  const db = createDb(env.DB);
  const url = new URL(request.url);
  const baseURL = `${url.protocol}//${url.host}`;
  const productionURL = env.PRODUCTION_URL || baseURL;

  const auth = createAuth({
    db,
    baseURL,
    secret: env.AUTH_SECRET,
    productionURL,
  });

  return { db, auth, baseURL, productionURL };
};
