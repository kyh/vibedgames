import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { Doc } from "@/lib/doc";
import { docToMarkdown, docToText, parseInline } from "@/lib/doc";

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
