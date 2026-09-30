import type { Doc } from "@/lib/doc";
import {
  MARKDOWN,
  markdownResponse,
  negotiate,
  notAcceptableResponse,
  VARY,
} from "@/lib/content-negotiation";
import { docToMarkdown } from "@/lib/doc";
import { siteConfig } from "@/lib/site-config";

/**
 * Server GET handler for a page with a markdown representation.
 *
 * Markdown when the client negotiated it, 406 when it can take neither of our
 * representations, otherwise `next()` — the SSR HTML. The HTML variant's
 * `Vary: Accept` comes from the route's `headers()` option (see
 * {@link varyHeaders}), which is the supported way to decorate a response the
 * framework produces downstream of us.
 */
export const docHandler =
  <TNext>(doc: Doc) =>
  ({ request, next }: { request: Request; next: () => TNext }) => {
    const result = negotiate(request.headers.get("accept"));
    if (result.kind === "not-acceptable") {
      return notAcceptableResponse(request);
    }
    if (result.kind === "match" && result.type === MARKDOWN) {
      return markdownResponse(docToMarkdown(doc));
    }
    return next();
  };

/**
 * Response headers for a negotiated page. Without `Vary: Accept` a CDN can
 * hand the cached HTML to an agent asking for markdown, or the reverse,
 * depending only on which variant primed the cache first.
 */
export const varyHeaders =
  (vary: string = VARY) =>
  () => ({ Vary: vary });

/**
 * Absolute canonical URL for a pathname: no trailing slash, and the apex has
 * no path at all. The search string is never part of it, so the `?game=`
 * variants of `/` all consolidate onto one URL.
 */
export const canonicalUrl = (pathname: string) => {
  const path = pathname.length > 1 ? pathname.replace(/\/+$/u, "") : "";
  return `${siteConfig.url}${path}`;
};

/**
 * `<head>` tags for a prose page: title, description, Open Graph. The
 * `<link rel="canonical">` itself comes from the root route, which covers
 * every page — emitting one here too would give Doc pages two.
 */
export const docHead = (doc: Doc) => {
  const title = doc.title.includes(siteConfig.name)
    ? doc.title
    : `${doc.title} — ${siteConfig.name}`;
  const canonical = canonicalUrl(doc.path);
  return {
    meta: [
      { title },
      { content: doc.description, name: "description" },
      { content: title, property: "og:title" },
      { content: doc.description, property: "og:description" },
      { content: canonical, property: "og:url" },
      { content: "website", property: "og:type" },
    ],
  };
};
