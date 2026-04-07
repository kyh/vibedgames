import type { Config } from "drizzle-kit";

/**
 * Drizzle Kit configuration for Cloudflare D1.
 *
 * For local development, use `wrangler d1 migrations` or point Drizzle Studio
 * at the local SQLite file under `.wrangler/state/v3/d1`.
 *
 * For remote pushes / migrations, set:
 *   CLOUDFLARE_ACCOUNT_ID
 *   CLOUDFLARE_DATABASE_ID
 *   CLOUDFLARE_D1_TOKEN
 */
export default {
  dialect: "sqlite",
  driver: "d1-http",
  schema: ["./src/drizzle-schema-auth.ts", "./src/drizzle-schema.ts"],
  out: "./drizzle",
  casing: "snake_case",
  dbCredentials: {
    accountId: process.env.CLOUDFLARE_ACCOUNT_ID ?? "",
    databaseId: process.env.CLOUDFLARE_DATABASE_ID ?? "",
    token: process.env.CLOUDFLARE_D1_TOKEN ?? "",
  },
} satisfies Config;
