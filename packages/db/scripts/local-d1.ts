import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const repoRoot = resolve(here, "../../..");

const d1Dir = join(repoRoot, "apps/web/.wrangler/state/v3/d1/miniflare-D1DatabaseObject");

/** Path to the local Miniflare D1 SQLite file the dev Worker binds to. */
export function resolveLocalD1(): string | null {
  if (!existsSync(d1Dir)) return null;
  const sqlite = readdirSync(d1Dir).find((f) => f.endsWith(".sqlite"));
  return sqlite ? join(d1Dir, sqlite) : null;
}

export function requireLocalD1(): string {
  const path = resolveLocalD1();
  if (!path) {
    console.error(
      "Local D1 not found. Start the dev server once to initialize it:\n" +
        "  pnpm dev:web\n" +
        `(looked in ${d1Dir})`,
    );
    process.exit(1);
  }
  return path;
}

/** Read a single var out of apps/web/.dev.vars without pulling in dotenv. */
export function readDevVar(name: string): string | undefined {
  const file = join(repoRoot, "apps/web/.dev.vars");
  if (!existsSync(file)) return undefined;
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const match = line.match(/^([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (match && match[1] === name) {
      return match[2].replace(/^["']|["']$/g, "");
    }
  }
  return undefined;
}
