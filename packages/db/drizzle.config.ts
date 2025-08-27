import type { Config } from "drizzle-kit";

if (!process.env.POSTGRES_URL) {
  throw new Error("Missing POSTGRES_URL");
}

const nonPoolingUrl = process.env.POSTGRES_URL.replace(":6543", ":5432");

export default {
  schema: ["./src/drizzle-schema-auth.ts", "./src/drizzle-schema.ts"],
  out: "./supabase/migrations",
  dialect: "postgresql",
  dbCredentials: {
    url: nonPoolingUrl,
  },
  schemaFilter: ["public"],
  casing: "snake_case",
} satisfies Config;
