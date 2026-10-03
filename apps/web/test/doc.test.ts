import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { Doc } from "@/lib/doc";
import { docToMarkdown, docToText, headingId, p, parseInline, table, ul } from "@/lib/doc";

const doc: Doc = {
  description: "A [sample](/about) doc.",
  lead: [{ kind: "p", text: "Lead **text** with `code`." }],
  path: "/sample",
  sections: [
    {
      blocks: [
        { items: ["[Internal](/docs)", "[External](https://example.com)"], kind: "ul" },
        { code: "vg deploy", kind: "code", lang: "sh" },
      ],
      heading: "Links",
    },
  ],
  title: "Sample",
};

describe("parseInline", () => {
  test("splits links out of surrounding text", () => {
    assert.deepEqual(parseInline("see [docs](/docs) now"), [
      { kind: "text", text: "see " },
      { href: "/docs", kind: "link", text: "docs" },
      { kind: "text", text: " now" },
    ]);
  });

  test("handles bold and inline code", () => {
    assert.deepEqual(parseInline("**Hosting** — run `vg deploy`"), [
      { kind: "strong", text: "Hosting" },
      { kind: "text", text: " — run " },
      { kind: "code", text: "vg deploy" },
    ]);
  });

  test("plain text passes through as one node", () => {
    assert.deepEqual(parseInline("nothing special"), [{ kind: "text", text: "nothing special" }]);
  });

  test("is not stateful across calls", () => {
    const once = parseInline("[a](/a) [b](/b)");
    const twice = parseInline("[a](/a) [b](/b)");
    assert.deepEqual(once, twice);
  });
});

describe("docToMarkdown", () => {
  const markdown = docToMarkdown(doc, "https://vibedgames.com");

  test("emits an H1, a summary blockquote and H2 sections", () => {
    assert.match(markdown, /^# Sample\n/u);
    assert.match(markdown, /\n> A \[sample\]/u);
    assert.match(markdown, /\n## Links\n/u);
  });

  test("makes site-relative links absolute", () => {
    assert.match(markdown, /\[sample\]\(https:\/\/vibedgames\.com\/about\)/u);
    assert.match(markdown, /\[Internal\]\(https:\/\/vibedgames\.com\/docs\)/u);
  });

  test("leaves absolute links alone", () => {
    assert.match(markdown, /\[External\]\(https:\/\/example\.com\)/u);
    assert.doesNotMatch(markdown, /vibedgames\.comhttps/u);
  });

  test("fences code blocks with their language", () => {
    assert.match(markdown, /```sh\nvg deploy\n```/u);
  });

  test("ends with exactly one trailing newline", () => {
    assert.match(markdown, /[^\n]\n$/u);
  });
});

describe("docToText", () => {
  test("strips markup so length assertions measure prose", () => {
    const text = docToText(doc);
    assert.match(text, /A sample doc\./u);
    assert.match(text, /Lead text with code\./u);
    assert.doesNotMatch(text, /\]\(/u);
  });
});

/** A doc with every block the legal pages use, to pin their markdown form. */
const legal: Doc = {
  description: "A sample legal page.",
  endnote: [p("A credit that belongs to no section.")],
  lead: [
    p("**Index**"),
    ul("[Who we are](#who-we-are)", "[Tracking & Other Things](#tracking--other-things)"),
  ],
  path: "/legal",
  sections: [
    {
      blocks: [
        table(
          ["Data", "Shared with"],
          ["**Contact** data", "[Hosting](/about) | storage"],
          ["Device data", "None"],
        ),
      ],
      heading: "Who we are",
    },
    { blocks: [p("Cookies.")], heading: "Tracking & Other Things" },
  ],
  title: "Legal",
};

describe("headingId", () => {
  test("follows GitHub's heading slugs, so fragments work in rendered markdown too", () => {
    assert.equal(headingId("Personal information we collect"), "personal-information-we-collect");
    assert.equal(headingId("Tracking & Other Technologies"), "tracking--other-technologies");
    assert.equal(headingId("1. Accounts"), "1-accounts");
    assert.equal(
      headingId("5. Third-Party Services & Other Users"),
      "5-third-party-services--other-users",
    );
  });
});

describe("tables and endnotes", () => {
  const markdown = docToMarkdown(legal, "https://vibedgames.com");

  test("a table is a GFM pipe table: head, rule, one line per row", () => {
    assert.match(
      markdown,
      /\n\| Data \| Shared with \|\n\| --- \| --- \|\n\| \*\*Contact\*\* data \| .+ \|\n\| Device data \| None \|\n/u,
    );
  });

  test("a cell's own pipe is escaped, and its links are made absolute", () => {
    assert.ok(markdown.includes(String.raw`[Hosting](https://vibedgames.com/about) \| storage`));
  });

  test("#fragment links stay relative to the page", () => {
    assert.ok(markdown.includes("[Tracking & Other Things](#tracking--other-things)"));
  });

  test("the endnote follows the last section, after a thematic break", () => {
    assert.match(markdown, /Cookies\.\n\n---\n\nA credit that belongs to no section\.\n$/u);
  });

  test("docToText keeps table cells and the endnote", () => {
    const text = docToText(legal);
    assert.match(text, /Contact data\tHosting \| storage/u);
    assert.match(text, /A credit that belongs to no section\./u);
  });
});
