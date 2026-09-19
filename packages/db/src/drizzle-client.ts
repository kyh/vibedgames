import type { D1Database } from "@cloudflare/workers-types";
import { drizzle } from "drizzle-orm/d1";

import { relations } from "./drizzle-relations";

/**
 * Create a Drizzle client bound to a Cloudflare D1 database.
 *
 * Unlike the previous Turso (libsql) setup, D1 is bound per-request via the
 * Worker `env`, so callers must construct the client inside their request
 * handler / oRPC context — there is no module-level singleton.
 *
 * `relations` (not `schema`) is what powers `db.query.*` and what the
 * better-auth drizzle adapter resolves its tables from, so the graph must
 * carry every table — see `drizzle-relations.ts`.
 */
export const createDb = (d1: D1Database) =>
  drizzle(d1, {
    relations,
  });

export type Db = ReturnType<typeof createDb>;
