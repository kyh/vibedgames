/**
 * Public, crawlable apex pages, in sitemap order. User games live on
 * `{slug}.vibedgames.com` subdomains served by a separate worker and are not
 * listed here.
 *
 * Shared with the tests so a page can never be added without appearing in
 * `/sitemap.xml`.
 */
export const SITEMAP_PATHS = [
  "/",
  "/discover",
  "/build",
  "/docs",
  "/install",
  "/about",
  "/contact",
  "/privacy",
] as const;
