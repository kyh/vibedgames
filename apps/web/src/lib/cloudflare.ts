import { getRequest } from "@tanstack/react-start/server";

declare const globalThis: { __env__?: CloudflareEnv };

/**
 * Return the per-request Cloudflare bindings (`env`) and context.
 *
 * Nitro's cloudflare_module preset makes env available in multiple ways:
 * - Production: `globalThis.__env__` (set in _module-handler.mjs)
 *   and `request.runtime.cloudflare.env` (set by augmentReq)
 * - Dev: `request.context.cloudflare.env` (set by cloudflare-dev plugin)
 *   and `globalThis.__env__`
 *
 * We check all locations so this works in every environment.
 */
export function getCloudflareEnv(): CloudflareEnv {
  // globalThis.__env__ is the most reliable — set by Nitro in both dev and prod
  if (globalThis.__env__?.DB) {
    return globalThis.__env__;
  }

  const req = getRequest() as Record<string, unknown>;
  const runtime = req.runtime as
    | { cloudflare?: { env?: CloudflareEnv } }
    | undefined;
  const context = req.context as
    | { cloudflare?: { env?: CloudflareEnv } }
    | undefined;
  const env = runtime?.cloudflare?.env ?? context?.cloudflare?.env;
  if (!env) {
    throw new Error(
      "Cloudflare env not available — this code must run inside a request handler with the cloudflare_module preset.",
    );
  }
  return env;
}
