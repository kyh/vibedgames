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
  FAL_API_KEY?: string;
  FAL_QUEUE_BASE_URL?: string;
  FAL_PLATFORM_BASE_URL?: string;
  FAL_DOCS_BASE_URL?: string;
  FAL_STORAGE_BASE_URL?: string;
}

declare module "cloudflare:workers" {
  const env: CloudflareEnv;
}
