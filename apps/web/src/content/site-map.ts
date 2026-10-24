/**
 * Public, crawlable apex pages, in sitemap order, each with the day its
 * content last changed (`<lastmod>`, and `dateModified` in the page's
 * JSON-LD). User games live on `{slug}.vibedgames.com` subdomains served by a
 * separate worker and are not listed here.
 *
 * Shared with the tests so a page can never be added without appearing in
 * `/sitemap.xml`. Bump a page's date in the same change that edits its copy.
 */
export const SITEMAP_PAGES = [
  { lastModified: "2026-09-27", path: "/" },
  { lastModified: "2026-09-10", path: "/discover" },
  { lastModified: "2026-09-10", path: "/build" },
  { lastModified: "2026-10-24", path: "/docs" },
  { lastModified: "2026-10-08", path: "/install" },
  { lastModified: "2026-09-10", path: "/about" },
  { lastModified: "2026-10-03", path: "/contact" },
  { lastModified: "2026-10-08", path: "/privacy" },
  { lastModified: "2026-10-07", path: "/terms" },
] as const;

export const SITEMAP_PATHS = SITEMAP_PAGES.map((page) => page.path);

/** Newest `lastModified` of any page: the fallback for a path not listed. */
const NEWEST =
  SITEMAP_PAGES.map((page) => page.lastModified)
    .toSorted()
    .at(-1) ?? "";

/** The day a sitemap page last changed, as an ISO date. */
export const pageLastModified = (path: string) =>
  SITEMAP_PAGES.find((page) => page.path === path)?.lastModified ?? NEWEST;
