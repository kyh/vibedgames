/**
 * Fallback share metadata for user games.
 *
 * Most deployed games ship an index.html with no Open Graph tags, so shared
 * links render as bare URLs. When served HTML opts out of managing its own
 * share meta (no `og:` properties at all), the worker injects a default set:
 * title from the game record (or the page `<title>`, or the slug), the page's
 * own meta description when present, and a cover image — either a
 * conventionally named `og.{jpg,png,webp}` at the deployment root or the
 * platform's default card.
 *
 * If the HTML contains ANY `og:` property the author owns share meta and the
 * page is served untouched — partial merging would be unpredictable.
 */

export type ShareMeta = {
  title: string;
  description: string;
  /** Canonical URL of the page being served. */
  url: string;
  /** Absolute URL of the share image. */
  imageUrl: string;
};

/** Conventional deployment-root image paths, in preference order. */
export const OG_IMAGE_CANDIDATES = ["og.jpg", "og.png", "og.webp"];

export function hasOwnShareMeta(html: string): boolean {
  return /<meta[^>]+property=["']og:/i.test(html);
}

export function extractTitle(html: string): string | null {
  const m = /<title[^>]*>([^<]*)<\/title>/i.exec(html);
  const t = m?.[1]?.trim();
  return t ? decodeEntities(t) : null;
}

export function extractDescription(html: string): string | null {
  const m =
    /<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i.exec(html) ??
    /<meta[^>]+content=["']([^"']*)["'][^>]+name=["']description["']/i.exec(html);
  const d = m?.[1]?.trim();
  return d ? decodeEntities(d) : null;
}

/**
 * Insert the share-meta block at the end of `<head>`. Returns the original
 * HTML unchanged when no head boundary can be found (malformed documents are
 * served as-is rather than corrupted).
 */
export function injectShareMeta(html: string, meta: ShareMeta): string {
  const block = renderShareMeta(meta);
  const headClose = /<\/head\s*>/i.exec(html);
  if (headClose) {
    return html.slice(0, headClose.index) + block + html.slice(headClose.index);
  }
  const headOpen = /<head[^>]*>/i.exec(html);
  if (headOpen) {
    const at = headOpen.index + headOpen[0].length;
    return html.slice(0, at) + "\n" + block + html.slice(at);
  }
  return html;
}

function renderShareMeta(meta: ShareMeta): string {
  const title = escapeAttr(meta.title);
  const description = escapeAttr(meta.description);
  const url = escapeAttr(meta.url);
  const imageUrl = escapeAttr(meta.imageUrl);
  return [
    `<meta property="og:type" content="website" />`,
    `<meta property="og:site_name" content="vibedgames" />`,
    `<meta property="og:title" content="${title}" />`,
    `<meta property="og:description" content="${description}" />`,
    `<meta property="og:url" content="${url}" />`,
    `<meta property="og:image" content="${imageUrl}" />`,
    `<meta name="twitter:card" content="summary_large_image" />`,
    `<meta name="twitter:image" content="${imageUrl}" />`,
  ]
    .map((line) => `    ${line}\n`)
    .join("");
}

function escapeAttr(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function decodeEntities(value: string): string {
  return value
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&amp;", "&");
}
