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

export interface ShareMeta {
  title: string;
  description: string;
  /** Canonical URL of the page being served. */
  url: string;
  /** Absolute URL of the share image. */
  imageUrl: string;
}

/** Conventional deployment-root image paths, in preference order. */
export const OG_IMAGE_CANDIDATES = ["og.jpg", "og.png", "og.webp"];

const escapeAttr = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

const decodeEntities = (value: string): string =>
  value
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&amp;", "&");

const renderShareMeta = (meta: ShareMeta): string => {
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
};

export const hasOwnShareMeta = (html: string): boolean => /<meta[^>]+property=["']og:/iu.test(html);

export const extractTitle = (html: string): string | null => {
  const m = /<title[^>]*>(?<text>[^<]*)<\/title>/iu.exec(html);
  const t = m?.groups?.text?.trim();
  return t ? decodeEntities(t) : null;
};

export const extractDescription = (html: string): string | null => {
  const m =
    /<meta[^>]+name=["']description["'][^>]+content=["'](?<text>[^"']*)["']/iu.exec(html) ??
    /<meta[^>]+content=["'](?<text>[^"']*)["'][^>]+name=["']description["']/iu.exec(html);
  const d = m?.groups?.text?.trim();
  return d ? decodeEntities(d) : null;
};

/**
 * Insert the share-meta block at the end of `<head>`. Returns the original
 * HTML unchanged when no head boundary can be found (malformed documents are
 * served as-is rather than corrupted).
 */
export const injectShareMeta = (html: string, meta: ShareMeta): string => {
  const block = renderShareMeta(meta);
  const headClose = /<\/head\s*>/iu.exec(html);
  if (headClose) {
    return html.slice(0, headClose.index) + block + html.slice(headClose.index);
  }
  const headOpen = /<head[^>]*>/iu.exec(html);
  if (headOpen) {
    const at = headOpen.index + headOpen[0].length;
    return `${html.slice(0, at)}\n${block}${html.slice(at)}`;
  }
  return html;
};
