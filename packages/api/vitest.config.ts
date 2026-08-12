import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

/**
 * Runs these tests INSIDE workerd, against real D1 and R2 bindings rather than
 * mocks. The credits ledger leans on D1-specific behaviour — `db.batch()`
 * atomicity, `INSERT … SELECT` guarded by a status predicate, `ON CONFLICT DO
 * NOTHING` on deterministic ids — none of which a fake in-memory driver would
 * reproduce faithfully. A mocked test here would pass while the real thing
 * double-charged.
 */
export default defineConfig({
  plugins: [
    cloudflareTest({
      miniflare: {
        compatibilityDate: "2026-04-12",
        compatibilityFlags: ["nodejs_compat"],
        d1Databases: ["DB"],
        r2Buckets: ["GAMES_BUCKET"],
      },
    }),
  ],
  test: {
    // Generates the schema DDL from the Drizzle TS schema in a Node context.
    // The Workers pool cannot run drizzle-kit itself.
    globalSetup: ["./test/global-setup.ts"],
  },
});
