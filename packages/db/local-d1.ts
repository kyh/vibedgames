import { existsSync, readdirSync } from "node:fs";
import path from "node:path";

/**
 * The LOCAL Miniflare D1 that `pnpm dev:web` binds to. Miniflare names the SQLite file after its
 * Durable Object id (64 hex characters), so it is resolved from `.wrangler` state rather than
 * hard-coded. Newer Miniflare also keeps a `metadata.sqlite` beside it, and `readdir` lists them
 * in whatever order the filesystem keeps, so the match is the id, not the extension.
 */
export const localD1File = (): string => {
  const d1Dir = path.join(
    import.meta.dirname,
    "../../apps/web/.wrangler/state/v3/d1/miniflare-D1DatabaseObject",
  );
  const file = existsSync(d1Dir)
    ? readdirSync(d1Dir).find((f) => /^[0-9a-f]{64}\.sqlite$/u.test(f))
    : undefined;
  if (!file) {
    throw new Error("Local D1 not found. Run `pnpm dev:web` once to initialize it.");
  }
  return path.join(d1Dir, file);
};
