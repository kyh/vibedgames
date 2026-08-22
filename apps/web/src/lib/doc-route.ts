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
export function docHandler<TNext>(doc: Doc) {
  return ({ request, next }: { request: Request; next: () => TNext }) => {
    const result = negotiate(request.headers.get("accept"));
    if (result.kind === "not-acceptable") return notAcceptableResponse(request);
    if (result.kind === "match" && result.type === MARKDOWN) {
      return markdownResponse(docToMarkdown(doc));
    }
    return next();
  };
}

/**
 * Response headers for a negotiated page. Without `Vary: Accept` a CDN can
 * hand the cached HTML to an agent asking for markdown, or the reverse,
 * depending only on which variant primed the cache first.
 */
export const varyHeaders =
  (vary: string = VARY) =>
  () => ({ Vary: vary });

/** `<head>` tags for a prose page: title, description, canonical, Open Graph. */
export function docHead(doc: Doc) {
  const title = doc.title.includes(siteConfig.name)
    ? doc.title
    : `${doc.title} — ${siteConfig.name}`;
  const canonical = `${siteConfig.url}${doc.path}`;
  return {
    meta: [
      { title },
      { name: "description", content: doc.description },
      { property: "og:title", content: title },
      { property: "og:description", content: doc.description },
      { property: "og:url", content: canonical },
      { property: "og:type", content: "website" },
    ],
    links: [{ rel: "canonical", href: canonical }],
  };
}
