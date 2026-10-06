/// <reference types="@cloudflare/workers-types" />
/// <reference types="vite/client" />

// Merged into the Env cloudflare.config.ts generates. Not secrets: to point at a fal or
// typesafe mock, add them as text bindings in cloudflare.config.ts; production never sets them.
declare namespace Cloudflare {
  interface Env {
    FAL_QUEUE_BASE_URL?: string;
    FAL_PLATFORM_BASE_URL?: string;
    FAL_DOCS_BASE_URL?: string;
    FAL_STORAGE_BASE_URL?: string;
    TYPESAFE_BASE_URL?: string;
  }
}
