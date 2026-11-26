import type { Config } from "drizzle-kit";

export default {
  dialect: "sqlite",
  schema: ["./src/drizzle-schema-auth.ts", "./src/drizzle-schema.ts"],
} satisfies Config;
