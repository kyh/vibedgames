import type { Config } from "drizzle-kit";

import { localD1File } from "./local-d1.ts";

// `drizzle-kit push` against the LOCAL Miniflare D1. The default `drizzle.config.ts` pushes to
// remote prod (d1-http driver); this one points the sqlite driver at the local file.
export default {
  dbCredentials: { url: `file:${localD1File()}` },
  dialect: "sqlite",
  schema: ["./src/drizzle-schema-auth.ts", "./src/drizzle-schema.ts"],
} satisfies Config;
