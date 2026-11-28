import { siteConfig } from "@/lib/site-config";

const APEX = "vibedgames.com";

const SIGNED_AUTHORIZE_PAGES = new Set(["/auth/login", "/auth/register", "/oauth/consent"]);

const isPrefixedBy = (pathname: string, prefix: string) =>
  pathname === prefix || pathname.startsWith(`${prefix}/`);

/**
 * Whether a request to the apex must be served there rather than redirected.
 *
 * Old `vg` installs saved `https://vibedgames.com` as their base URL and hold
 * tokens bound to it, `fetch` drops `Authorization` on a cross-origin
 * redirect, and Stripe does not follow redirects, so the API, `/mcp` and
 * discovery stay on the apex. An OAuth authorize that began on the apex
 * carries its signed query (`sig`) through sign-in and consent, which only
 * verify on the host that signed them.
 */
export const servedOnApex = (url: URL) =>
  isPrefixedBy(url.pathname, "/api") ||
  url.pathname === "/mcp" ||
  isPrefixedBy(url.pathname, "/.well-known") ||
  (SIGNED_AUTHORIZE_PAGES.has(url.pathname) && url.searchParams.has("sig"));

/**
 * Where a request belongs on the canonical web host, or `null` when it
 * is already there (or must stay on the apex; see {@link servedOnApex}).
 */
export const canonicalLocation = (url: URL) => {
  if (url.hostname !== APEX || servedOnApex(url)) {
    return null;
  }

  return new URL(`${url.pathname}${url.search}`, siteConfig.url).href;
};
