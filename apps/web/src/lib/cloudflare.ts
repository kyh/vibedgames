import { env } from "cloudflare:workers";

/**
 * Return the Cloudflare bindings (`env`).
 *
 * With the @cloudflare/vite-plugin, bindings are available via the
 * `cloudflare:workers` module in both dev and production — no more
 * Nitro globalThis.__env__ hacks or request-sniffing.
 */
export function getCloudflareEnv(): CloudflareEnv {
  return env as unknown as CloudflareEnv;
}
