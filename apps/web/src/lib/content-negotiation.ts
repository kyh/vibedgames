/**
 * Accept-header content negotiation, per RFC 9110 §12.5.1 and the
 * acceptmarkdown.com convention (https://acceptmarkdown.com/guides).
 *
 * The rules that matter, and that a naive `accept.includes("text/markdown")`
 * gets wrong:
 *
 * - Rank by q-value descending; ties broken by specificity
 *   (an exact type beats `text/*`, which beats a bare wildcard).
 * - `q=0` is an explicit *refusal*, not a weak preference.
 * - A missing `Accept`, or a bare wildcard, is "no constraint" — serve the default.
 * - Only 406 when every representation we can produce is unmatched or
 *   refused.
 *
 * Every negotiated response must also carry `Vary: Accept`, or a CDN will
 * hand the markdown variant to a browser (or the HTML to an agent) depending
 * on which one primed the cache first.
 */

export const HTML = "text/html";
export const MARKDOWN = "text/markdown";

/** What a negotiated page can produce, in server-preference order. */
export const PAGE_TYPES = [HTML, MARKDOWN] as const;

export const VARY = "Accept, Accept-Encoding";

type AcceptEntry = {
  type: string;
  subtype: string;
  q: number;
  /** 2 = fully specified, 1 = subtype wildcard, 0 = bare wildcard. */
  specificity: number;
};

function parseQ(params: string[]): number {
  for (const param of params) {
    const [rawKey, rawValue] = param.split("=");
    if (rawKey?.trim().toLowerCase() !== "q") continue;
    const q = Number.parseFloat(rawValue?.trim() ?? "");
    if (Number.isNaN(q)) return 1;
    return Math.min(1, Math.max(0, q));
  }
  return 1;
}

/** Parse an `Accept` header into entries. Malformed entries are skipped. */
export function parseAccept(header: string | null | undefined): AcceptEntry[] {
  if (!header) return [];
  const entries: AcceptEntry[] = [];
  for (const raw of header.split(",")) {
    const [mediaRange, ...params] = raw.split(";");
    const media = mediaRange?.trim().toLowerCase();
    if (!media) continue;
    const [type, subtype] = media.split("/");
    if (!type || !subtype) continue;
    entries.push({
      type,
      subtype,
      q: parseQ(params),
      specificity: type === "*" ? 0 : subtype === "*" ? 1 : 2,
    });
  }
  return entries;
}

/** Score one producible type against the parsed Accept list. */
function scoreFor(candidate: string, entries: AcceptEntry[]) {
  const [type, subtype] = candidate.toLowerCase().split("/");
  let best: AcceptEntry | null = null;
  for (const entry of entries) {
    const matches =
      (entry.type === "*" && entry.subtype === "*") ||
      (entry.type === type && entry.subtype === "*") ||
      (entry.type === type && entry.subtype === subtype);
    if (!matches) continue;
    // A more specific match always wins, even at a lower q — that is how
    // `text/markdown;q=0, */*` reads as "anything but markdown".
    if (!best || entry.specificity > best.specificity) best = entry;
  }
  return best ? { q: best.q, specificity: best.specificity } : null;
}

export type Negotiation =
  | { kind: "match"; type: string }
  | { kind: "default"; type: string }
  | { kind: "not-acceptable" };

/**
 * Pick the representation to serve.
 *
 * `produces[0]` is the default, used whenever the client expressed no
 * constraint (no header, or a bare wildcard that ranks everything equally).
 */
export function negotiate(
  header: string | null | undefined,
  produces: readonly string[] = PAGE_TYPES,
): Negotiation {
  const fallback = produces[0] ?? HTML;
  const entries = parseAccept(header);
  if (entries.length === 0) return { kind: "default", type: fallback };

  let winner: { type: string; q: number; specificity: number } | null = null;
  for (const candidate of produces) {
    const score = scoreFor(candidate, entries);
    if (!score || score.q === 0) continue;
    if (
      !winner ||
      score.q > winner.q ||
      (score.q === winner.q && score.specificity > winner.specificity)
    ) {
      winner = { type: candidate, q: score.q, specificity: score.specificity };
    }
  }

  if (!winner) return { kind: "not-acceptable" };
  // Nothing more specific than a wildcard matched: the client stated no real
  // preference, so keep our own default rather than reordering on a tie.
  if (winner.specificity === 0) return { kind: "default", type: fallback };
  return { kind: "match", type: winner.type };
}

/** True when the client explicitly asked for markdown over our other types. */
export function prefersMarkdown(request: Request): boolean {
  const result = negotiate(request.headers.get("accept"));
  return result.kind === "match" && result.type === MARKDOWN;
}

export function markdownResponse(body: string, init: ResponseInit = {}): Response {
  return new Response(body, {
    status: 200,
    ...init,
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
      "Cache-Control": "public, max-age=300",
      Vary: VARY,
      ...init.headers,
    },
  });
}

/**
 * 406 body per RFC 9110 §15.5.7: list what we *can* produce so the client can
 * retry with a usable `Accept`. Never cached — the answer is request-specific.
 */
export function notAcceptableResponse(
  request: Request,
  produces: readonly string[] = PAGE_TYPES,
): Response {
  const requested = request.headers.get("accept") ?? "(none)";
  const body = [
    "This resource is available in:",
    ...produces.map((type) => `- ${type}`),
    "",
    `You requested: ${requested}`,
    "",
  ].join("\n");
  return new Response(body, {
    status: 406,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
      Vary: VARY,
    },
  });
}
