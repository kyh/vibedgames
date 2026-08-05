/**
 * Bindings available to tests running in the Workers pool. These mirror the
 * `miniflare` block in vitest.config.ts — `cloudflare:test` types its exported
 * `env` as `Cloudflare.Env`, so declaring them here is what makes `env.DB` and
 * `env.GAMES_BUCKET` type-safe inside tests.
 */
declare namespace Cloudflare {
  interface Env {
    DB: D1Database;
    GAMES_BUCKET: R2Bucket;
  }
}
