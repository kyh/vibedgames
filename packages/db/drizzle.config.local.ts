import type { Config } from "drizzle-kit";

/**
 * Drizzle Kit config for the LOCAL Miniflare D1 used by `pnpm dev:web`.
 *
 * The default `drizzle.config.ts` talks to remote prod via the `d1-http`
 * driver. This one pushes the same schema into the local SQLite file that
 * the dev Worker binds to, so local and prod stay in sync without ever
 * touching prod. The file path is injected as `LOCAL_D1_URL` by
 * `scripts/push-local.ts`, which resolves it from `.wrangler/state`.
 */
export default {
  dialect: "sqlite",
  schema: ["./src/drizzle-schema-auth.ts", "./src/drizzle-schema.ts"],
  out: "./drizzle",
  casing: "snake_case",
  dbCredentials: {
    url: process.env.LOCAL_D1_URL ?? "file:./local.db",
  },
} satisfies Config;
