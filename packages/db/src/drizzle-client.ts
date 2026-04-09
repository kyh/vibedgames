import type { D1Database } from "@cloudflare/workers-types";
import { drizzle } from "drizzle-orm/d1";

import * as schema from "./drizzle-schema";
import * as schemaAuth from "./drizzle-schema-auth";

const combinedSchema = { ...schema, ...schemaAuth };

/**
 * Create a Drizzle client bound to a Cloudflare D1 database.
 *
 * Unlike the previous Turso (libsql) setup, D1 is bound per-request via the
 * Worker `env`, so callers must construct the client inside their request
 * handler / tRPC context — there is no module-level singleton.
 */
export const createDb = (d1: D1Database) =>
  drizzle(d1, {
    schema: combinedSchema,
    casing: "snake_case",
  });

export type Db = ReturnType<typeof createDb>;
