import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { Doc } from "@/lib/doc";
import { aboutDoc } from "@/content/about";
import { contactDoc } from "@/content/contact";
import { docsDoc } from "@/content/docs";
import { homeDoc } from "@/content/home";
import { llmsTxt } from "@/content/llms";
import { notFoundMarkdown } from "@/content/not-found";
import { privacyDoc } from "@/content/privacy";
import { SITEMAP_PATHS } from "@/content/site-map";
import { termsDoc } from "@/content/terms";
import { docToMarkdown, docToText, headingId } from "@/lib/doc";
import { siteConfig } from "@/lib/site-config";

const docs: Doc[] = [homeDoc, aboutDoc, contactDoc, privacyDoc, termsDoc, docsDoc];

describe("every prose page", () => {
  for (const doc of docs) {
    describe(doc.path, () => {
      test("has a title, a description and body content", () => {
        assert.ok(doc.title.length > 0);
        assert.ok(doc.description.length > 0);
        assert.ok(doc.lead.length + doc.sections.length > 0);
      });

      test("names the product, so a title-based search can find it", () => {
        assert.match(`${doc.title} ${doc.description}`, new RegExp(siteConfig.name, "iu"));
      });

      test("round-trips to markdown with an H1 and a summary blockquote", () => {
        const markdown = docToMarkdown(doc);
        assert.match(markdown, /^# .+\n\n> .+/u);
      });

      test("has no site-relative link left in its markdown form", () => {
        assert.doesNotMatch(docToMarkdown(doc), /\]\(\/[^)]*\)/u);
      });
    });
  }
});

describe("trust anchor pages", () => {
  // AI agents check /about, /contact, /privacy and /terms to decide whether a
  // business is real. Thin pages read as placeholders, so hold them to a floor.
  for (const doc of [aboutDoc, contactDoc, privacyDoc, termsDoc]) {
    test(`${doc.path} carries at least 500 characters of prose`, () => {
      assert.ok(
        docToText(doc).length >= 500,
        `${doc.path} has only ${docToText(doc).length} characters`,
      );
    });
  }

  test("/contact names a reachable support channel", () => {
    const markdown = docToMarkdown(contactDoc);
    assert.match(markdown, new RegExp(siteConfig.issues.replaceAll(/[/.]/gu, "\\$&"), "u"));
  });

  test("/privacy covers what is stored, who processes it and deletion", () => {
    const markdown = docToMarkdown(privacyDoc).toLowerCase();
    for (const topic of ["cookie", "delet", "retention", "cloudflare"]) {
      assert.match(markdown, new RegExp(topic, "u"));
    }
  });
});

/** The `#fragment` each of a doc's section headings answers to. */
const anchorsOf = (doc: Doc) => new Set(doc.sections.map((section) => headingId(section.heading)));

describe("legal pages", () => {
  const legal = [privacyDoc, termsDoc];
  const docByPath = new Map(legal.map((doc) => [doc.path, doc]));
  const CREDIT = /^This template was prepared and made publicly available by General Legal, PC/u;

  for (const doc of legal) {
    describe(doc.path, () => {
      const markdown = docToMarkdown(doc);

      test("names the operator and the email that takes legal notices", () => {
        assert.match(markdown, new RegExp(siteConfig.operator.name, "u"));
        assert.ok(markdown.includes(`mailto:${siteConfig.operator.email}`));
      });

      test("carries no template placeholder or drafting note", () => {
        for (const leftover of [
          "<mark>",
          "[INSERT",
          "{{",
          "[Company",
          "[DATE",
          "[EMAIL",
          "DecisionLayer",
          "information/know",
        ]) {
          assert.ok(!markdown.includes(leftover), `${doc.path} still contains ${leftover}`);
        }
      });

      test("ends with the General Legal credit, after a rule", () => {
        const [credit] = doc.endnote ?? [];
        assert.ok(credit?.kind === "p" && CREDIT.test(credit.text));
        assert.match(markdown, /\n---\n\nThis template was prepared/u);
      });

      test("every #fragment link lands on a heading of the page it names", () => {
        const links = [...markdown.matchAll(/\]\((?<href>[^)\s]+)\)/gu)].map(
          (match) => match.groups?.href ?? "",
        );
        const fragments = links.filter((href) => href.includes("#"));
        assert.ok(fragments.length > 0);
        for (const href of fragments) {
          const [base = "", fragment = ""] = href.split("#");
          const target = base === "" ? doc : docByPath.get(new URL(base).pathname);
          assert.ok(target, `${href} points at a page with no Doc here`);
          assert.ok(anchorsOf(target).has(fragment), `${href} matches no heading`);
        }
      });
    });
  }

  test("/privacy indexes every top-level section, in order", () => {
    const index = privacyDoc.lead.find(
      (block) => block.kind === "ul" && block.items.every((item) => item.includes("](#")),
    );
    assert.ok(index?.kind === "ul");
    assert.deepEqual(
      index.items,
      privacyDoc.sections.map((section) => `[${section.heading}](#${headingId(section.heading)})`),
    );
  });

  test("/privacy keeps the promises the page has always made", () => {
    const text = docToText(privacyDoc);
    for (const promise of [
      "We do not sell your personal information",
      "we do not show ads",
      "We do not use analytics",
      "We do not store your prompts",
      "deleting a game deletes its files",
      "not intended for use by anyone under 13",
    ]) {
      assert.ok(text.includes(promise), `/privacy no longer says: ${promise}`);
    }
  });

  test("/terms is the JAMS variant, under California law, with a 30-day opt-out", () => {
    const text = docToText(termsDoc);
    for (const clause of [
      "Version 2.0",
      "JAMS",
      "San Francisco County, California",
      "within 30 days",
      "at least 13 years old",
      "MIT License",
    ]) {
      assert.ok(text.includes(clause), `/terms is missing: ${clause}`);
    }
  });

  test("/terms keeps the template's numbering, 1 through 11", () => {
    assert.deepEqual(
      termsDoc.sections.map((section) => section.heading.split(". ")[0]),
      Array.from({ length: 11 }, (_, i) => String(i + 1)),
    );
  });
});

describe("/docs", () => {
  const markdown = docToMarkdown(docsDoc);

  test("names the developer resources an agent searches for", () => {
    for (const needle of ["vg deploy", "vg generate", "oRPC", "better-auth", "VG_TOKEN"]) {
      assert.match(markdown, new RegExp(needle.replaceAll(/[/.]/gu, "\\$&"), "u"));
    }
  });

  test("links the machine-readable endpoints", () => {
    for (const path of ["/llms.txt", "/install", "/sitemap.xml", "/.well-known/agent-skills"]) {
      assert.match(markdown, new RegExp(path.replaceAll(/[/.]/gu, "\\$&"), "u"));
    }
  });
});

describe("llms.txt", () => {
  test("follows the llmstxt.org shape: H1, blockquote, then H2 sections", () => {
    assert.match(llmsTxt, /^# Vibedgames\n\n> .+/u);
    assert.ok(llmsTxt.includes("\n## Start here\n"));
  });

  test("carries explicit when-to-use guidance, not marketing copy", () => {
    assert.ok(llmsTxt.includes("## When to use Vibedgames"));
    assert.match(llmsTxt, /Reach for Vibedgames when/u);
    assert.match(llmsTxt, /Do \*\*not\*\* reach for Vibedgames/u);
  });

  test("tells an agent the first command to run", () => {
    assert.ok(llmsTxt.includes("## How to call it"));
    assert.match(llmsTxt, /npx vibedgames init/u);
  });

  test("links both legal pages", () => {
    assert.ok(llmsTxt.includes(`${siteConfig.url}/privacy`));
    assert.ok(llmsTxt.includes(`${siteConfig.url}/terms`));
  });

  test("uses absolute URLs, since it is read away from its origin", () => {
    const links = [...llmsTxt.matchAll(/\]\((?<href>[^)]+)\)/gu)].map(
      (match) => match.groups?.href ?? "",
    );
    assert.ok(links.length > 0);
    for (const link of links) {
      assert.match(link, /^https:\/\//u);
    }
  });
});

describe("404 body", () => {
  const markdown = notFoundMarkdown("/does-not-exist");

  test("says which path was missed", () => {
    assert.match(markdown, /\/does-not-exist/u);
  });

  test("points at the files an agent can recover from", () => {
    for (const path of ["/llms.txt", "/sitemap.xml", "/docs"]) {
      assert.match(markdown, new RegExp(path.replaceAll(/[/.]/gu, "\\$&"), "u"));
    }
  });

  test("works without a pathname", () => {
    assert.match(notFoundMarkdown(), /^# 404/u);
  });
});

describe("sitemap", () => {
  const paths: readonly string[] = SITEMAP_PATHS;

  test("lists every prose page", () => {
    for (const doc of docs) {
      assert.ok(paths.includes(doc.path), `${doc.path} is missing from SITEMAP_PATHS`);
    }
  });

  test("lists the agent entry points", () => {
    assert.ok(paths.includes("/install"));
    assert.ok(paths.includes("/docs"));
  });

  test("has no duplicates", () => {
    assert.equal(new Set(paths).size, paths.length);
  });
});
