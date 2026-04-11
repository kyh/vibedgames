/// <reference types="@cloudflare/workers-types" />

interface Env {
  DB: D1Database;
  GAMES_BUCKET: R2Bucket;
}
