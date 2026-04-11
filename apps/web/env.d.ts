/// <reference types="@cloudflare/workers-types" />
/// <reference types="vite/client" />

interface CloudflareEnv {
  DB: D1Database;
  ASSETS: Fetcher;
  GAMES_BUCKET: R2Bucket;
  AUTH_SECRET: string;
  PRODUCTION_URL: string;
  R2_BUCKET_NAME: string;
  R2_ACCOUNT_ID: string;
  R2_ACCESS_KEY_ID: string;
  R2_SECRET_ACCESS_KEY: string;
  V0_API_KEY?: string;
  AI_GATEWAY_API_KEY?: string;
}
