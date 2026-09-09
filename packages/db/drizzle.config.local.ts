import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import type { Config } from "drizzle-kit";

/**
 * `drizzle-kit push` against the LOCAL Miniflare D1 that `pnpm dev:web` binds
 * to. The default `drizzle.config.ts` pushes to remote prod (d1-http driver);
 * this one points the sqlite driver at the local SQLite file. Miniflare names
 * that file with a content hash, so we resolve it from `.wrangler` state here
 * rather than hard-coding it.
 */
const here = import.meta.dirname;
const d1Dir = path.join(here, "../../apps/web/.wrangler/state/v3/d1/miniflare-D1DatabaseObject");
const file = existsSync(d1Dir) ? readdirSync(d1Dir).find((f) => f.endsWith(".sqlite")) : undefined;
if (!file) {
  throw new Error("Local D1 not found. Run `pnpm dev:web` once to initialize it.");
}

export default {
  casing: "snake_case",
  dbCredentials: { url: `file:${path.join(d1Dir, file)}` },
  dialect: "sqlite",
  schema: ["./src/drizzle-schema-auth.ts", "./src/drizzle-schema.ts"],
} satisfies Config;
