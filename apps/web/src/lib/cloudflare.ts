import { env } from "cloudflare:workers";

/**
 * Return the Cloudflare bindings (`env`).
 *
 * With the @cloudflare/vite-plugin, bindings are available via the
 * `cloudflare:workers` module in both dev and production — no more
 * Nitro globalThis.__env__ hacks or request-sniffing.
 */
// `cloudflare:workers` ships its own (empty) `Env` interface, which wins
// over the `declare module` augmentation in env.d.ts — hence the cast.
// Removing it needs `wrangler types` to generate the real bindings type.
export function getCloudflareEnv(): CloudflareEnv {
  return env as unknown as CloudflareEnv;
}
