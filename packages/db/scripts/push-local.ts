import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { requireLocalD1 } from "./local-d1";

// Push the current Drizzle schema into the local Miniflare D1 SQLite that
// `pnpm dev:web` binds to, keeping local in sync with prod's schema without
// ever touching prod.

const here = dirname(fileURLToPath(import.meta.url));
const dbPath = requireLocalD1();

console.log(`Pushing schema to local D1: ${dbPath}`);
execFileSync(
  "pnpm",
  ["exec", "drizzle-kit", "push", "--config=drizzle.config.local.ts", "--force"],
  {
    cwd: resolve(here, ".."),
    stdio: "inherit",
    env: { ...process.env, LOCAL_D1_URL: `file:${dbPath}` },
  },
);
