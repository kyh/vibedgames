/// <reference types="@cloudflare/workers-types" />
/// <reference types="vite/client" />

declare namespace Cloudflare {
  interface Env {
    FAL_QUEUE_BASE_URL?: string;
    FAL_PLATFORM_BASE_URL?: string;
    FAL_DOCS_BASE_URL?: string;
    FAL_STORAGE_BASE_URL?: string;
    TYPESAFE_BASE_URL?: string;
    STRIPE_API_BASE_URL?: string;
  }
}

declare module "virtual:mcp-apps" {
  import type { McpApps } from "@/lib/mcp-gallery";

  export const mcpApps: McpApps;
}
