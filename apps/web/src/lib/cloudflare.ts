import { getRequest } from "@tanstack/react-start/server";

/**
 * Return the per-request Cloudflare bindings (`env`) and context.
 *
 * Nitro's `cloudflare_module` preset attaches the Worker `env` to the request
 * via `augmentReq` (production: `runtime.cloudflare.env`) and the dev plugin
 * (dev: `context.cloudflare.env`). We read from both locations so this works
 * in all environments. Throws if called outside a request.
 */
export function getCloudflareEnv(): CloudflareEnv {
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
