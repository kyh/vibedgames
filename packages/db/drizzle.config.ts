import type { Config } from "drizzle-kit";

export default {
  dialect: "turso",
  schema: ["./src/drizzle-schema-auth.ts", "./src/drizzle-schema.ts"],
  out: "./drizzle",
  casing: "snake_case",
  dbCredentials: {
    url: process.env.TURSO_DATABASE_URL ?? "",
    authToken: process.env.TURSO_AUTH_TOKEN,
  },
} satisfies Config;
