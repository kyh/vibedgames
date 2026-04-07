/// <reference types="@cloudflare/workers-types" />
/// <reference types="vite/client" />

interface CloudflareEnv {
  DB: D1Database;
  ASSETS: Fetcher;
  AUTH_SECRET: string;
  PRODUCTION_URL: string;
  V0_API_KEY?: string;
  AI_GATEWAY_API_KEY?: string;
}
