import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  HTML,
  MARKDOWN,
  markdownResponse,
  negotiate,
  notAcceptableResponse,
  parseAccept,
  prefersMarkdown,
  VARY,
} from "@/lib/content-negotiation";

const chose = (header: string | null | undefined) => {
  const result = negotiate(header);
  return result.kind === "not-acceptable" ? "406" : result.type;
};

describe("negotiate", () => {
  // The published test vectors: https://acceptmarkdown.com/guides/accept-parsing
  const vectors: Array<[string | null, string]> = [
    ["text/markdown", MARKDOWN],
    ["text/markdown, text/html;q=0.8", MARKDOWN],
    ["text/html", HTML],
    ["text/markdown;q=0, text/html", HTML],
    [null, HTML],
    ["*/*", HTML],
  ];

  for (const [header, expected] of vectors) {
    test(`${header ?? "(no Accept)"} -> ${expected}`, () => {
      assert.equal(chose(header), expected);
    });
  }

  test("markdown refused with q=0 and nothing else on offer is a 406", () => {
    const result = negotiate("text/markdown;q=0", [MARKDOWN]);
    assert.equal(result.kind, "not-acceptable");
  });

  test("a type we cannot produce at all is a 406", () => {
    assert.equal(chose("application/pdf"), "406");
  });

  test("real Chrome header picks HTML, not markdown", () => {
    assert.equal(
      chose(
        "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
      ),
      HTML,
    );
  });

  test("agent header with fallbacks picks markdown", () => {
    assert.equal(chose("text/markdown, text/plain;q=0.5, */*;q=0.1"), MARKDOWN);
  });

  test("an empty Accept is treated as no constraint", () => {
    assert.equal(chose(""), HTML);
  });

  test("q ranks above specificity: a q=1 wildcard beats a q=0.6 exact match", () => {
    // Per the ranking rules, q is the primary key and specificity only breaks
    // ties — so `*/*` at q=1 outranks `text/markdown;q=0.6`, and we fall back
    // to the server default.
    assert.equal(chose("text/markdown;q=0.6, */*"), HTML);
  });

  test("specificity breaks a tie at equal q", () => {
    assert.equal(chose("text/markdown;q=0.8, */*;q=0.8"), MARKDOWN);
  });

  test("`text/markdown;q=0, */*` means anything but markdown", () => {
    assert.equal(chose("text/markdown;q=0, */*"), HTML);
  });

  test("subtype wildcards respect server preference order", () => {
    assert.equal(chose("text/*"), HTML);
  });

  test("case and whitespace are insensitive", () => {
    assert.equal(chose("  TEXT/MARKDOWN ;Q=1 "), MARKDOWN);
  });

  test("malformed entries are skipped, not fatal", () => {
    assert.equal(chose("garbage,,;q=x, text/markdown"), MARKDOWN);
  });

  test("an unparseable q falls back to 1 rather than 0", () => {
    assert.equal(chose("text/markdown;q=notanumber"), MARKDOWN);
  });
});

describe("parseAccept", () => {
  test("reads types, q-values and specificity", () => {
    assert.deepEqual(parseAccept("text/markdown, text/*;q=0.5, */*;q=0.1"), [
      { type: "text", subtype: "markdown", q: 1, specificity: 2 },
      { type: "text", subtype: "*", q: 0.5, specificity: 1 },
      { type: "*", subtype: "*", q: 0.1, specificity: 0 },
    ]);
  });

  test("clamps q into [0, 1]", () => {
    assert.deepEqual(
      parseAccept("text/markdown;q=9, text/html;q=-1").map((entry) => entry.q),
      [1, 0],
    );
  });
});

const request = (accept?: string) =>
  new Request("https://vibedgames.com/about", accept ? { headers: { accept } } : undefined);

describe("prefersMarkdown", () => {
  test("true only when markdown actually wins", () => {
    assert.equal(prefersMarkdown(request("text/markdown")), true);
    assert.equal(prefersMarkdown(request("text/html")), false);
    assert.equal(prefersMarkdown(request("*/*")), false);
    assert.equal(prefersMarkdown(request()), false);
  });
});

describe("responses", () => {
  test("markdownResponse declares the type and varies on Accept", () => {
    const response = markdownResponse("# hi");
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "text/markdown; charset=utf-8");
    assert.equal(response.headers.get("vary"), VARY);
    assert.match(VARY, /Accept/);
  });

  test("markdownResponse init overrides status and headers", () => {
    const response = markdownResponse("# gone", {
      status: 404,
      headers: { "Cache-Control": "no-store" },
    });
    assert.equal(response.status, 404);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("vary"), VARY);
  });

  test("406 lists what we can produce and is not cached", async () => {
    const response = notAcceptableResponse(request("application/pdf"));
    assert.equal(response.status, 406);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("vary"), VARY);
    const body = await response.text();
    assert.match(body, /text\/html/);
    assert.match(body, /text\/markdown/);
    assert.match(body, /You requested: application\/pdf/);
  });
});
