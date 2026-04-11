import { getRequest } from "@tanstack/react-start/server";

declare const globalThis: { __env__?: CloudflareEnv };

/**
 * Shape that Nitro's cloudflare_module preset attaches to the incoming
 * request. `runtime.cloudflare.env` is set by `augmentReq` in production;
 * `context.cloudflare.env` is set by the cloudflare-dev plugin in dev.
 */
type NitroCloudflareRequest = {
  runtime?: { cloudflare?: { env?: CloudflareEnv } };
  context?: { cloudflare?: { env?: CloudflareEnv } };
};

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

  const req = getRequest() as unknown as NitroCloudflareRequest;
  const env = req.runtime?.cloudflare?.env ?? req.context?.cloudflare?.env;
  if (!env) {
    throw new Error(
      "Cloudflare env not available — this code must run inside a request handler with the cloudflare_module preset.",
    );
  }
  return env;
}
