import { getRequestEvent } from "@tanstack/react-start/server";

/**
 * Return the per-request Cloudflare bindings (`env`) and context.
 *
 * Nitro's `cloudflare_module` preset attaches the Worker `env` to the request
 * event. We read it here so `db` / `auth` can be constructed per request.
 * Throws if called outside a request (e.g. at module load).
 */
export function getCloudflareEnv(): CloudflareEnv {
  const event = getRequestEvent();
  // @ts-expect-error — nitro cloudflare preset attaches `cloudflare` to context
  const cf = event?.context?.cloudflare as { env?: CloudflareEnv } | undefined;
  if (!cf?.env) {
    throw new Error(
      "Cloudflare env not available — this code must run inside a request handler with the cloudflare_module preset.",
    );
  }
  return cf.env;
}
