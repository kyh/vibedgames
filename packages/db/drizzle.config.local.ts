import type { Config } from "drizzle-kit";

import { localD1File } from "./local-d1.ts";

export default {
  dbCredentials: { url: `file:${localD1File()}` },
  dialect: "sqlite",
  schema: ["./src/drizzle-schema-auth.ts", "./src/drizzle-schema.ts"],
} satisfies Config;
