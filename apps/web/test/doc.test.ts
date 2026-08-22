import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { Doc } from "@/lib/doc";
import { docToMarkdown, docToText, parseInline } from "@/lib/doc";

const doc: Doc = {
  path: "/sample",
  title: "Sample",
  description: "A [sample](/about) doc.",
  lead: [{ kind: "p", text: "Lead **text** with `code`." }],
  sections: [
    {
      heading: "Links",
      blocks: [
        { kind: "ul", items: ["[Internal](/docs)", "[External](https://example.com)"] },
        { kind: "code", lang: "sh", code: "vg deploy" },
      ],
    },
  ],
};

describe("parseInline", () => {
  test("splits links out of surrounding text", () => {
    assert.deepEqual(parseInline("see [docs](/docs) now"), [
      { kind: "text", text: "see " },
      { kind: "link", text: "docs", href: "/docs" },
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
    assert.match(markdown, /^# Sample\n/);
    assert.match(markdown, /\n> A \[sample\]/);
    assert.match(markdown, /\n## Links\n/);
  });

  test("makes site-relative links absolute", () => {
    assert.match(markdown, /\[sample\]\(https:\/\/vibedgames\.com\/about\)/);
    assert.match(markdown, /\[Internal\]\(https:\/\/vibedgames\.com\/docs\)/);
  });

  test("leaves absolute links alone", () => {
    assert.match(markdown, /\[External\]\(https:\/\/example\.com\)/);
    assert.doesNotMatch(markdown, /vibedgames\.comhttps/);
  });

  test("fences code blocks with their language", () => {
    assert.match(markdown, /```sh\nvg deploy\n```/);
  });

  test("ends with exactly one trailing newline", () => {
    assert.match(markdown, /[^\n]\n$/);
  });
});

describe("docToText", () => {
  test("strips markup so length assertions measure prose", () => {
    const text = docToText(doc);
    assert.match(text, /A sample doc\./);
    assert.match(text, /Lead text with code\./);
    assert.doesNotMatch(text, /\]\(/);
  });
});
