import { getCloudflareEnv } from "@/lib/cloudflare";

export function getBaseUrl() {
  if (typeof window !== "undefined") {
    return window.location.origin;
  }
  // On Cloudflare Workers, derive from the PRODUCTION_URL binding.
  // In dev, getCloudflareEnv() may throw — fall back to localhost.
  try {
    const env = getCloudflareEnv();
    if (env.PRODUCTION_URL) return env.PRODUCTION_URL;
  } catch {
    // Not in a CF request context (e.g. dev SSR before bindings are ready)
  }
  // eslint-disable-next-line no-restricted-properties
  return `http://localhost:${process.env.PORT ?? 3000}`;
}
