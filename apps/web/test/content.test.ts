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
import { docToMarkdown, docToText } from "@/lib/doc";
import { siteConfig } from "@/lib/site-config";

const docs: Doc[] = [homeDoc, aboutDoc, contactDoc, privacyDoc, docsDoc];

describe("every prose page", () => {
  for (const doc of docs) {
    describe(doc.path, () => {
      test("has a title, a description and body content", () => {
        assert.ok(doc.title.length > 0);
        assert.ok(doc.description.length > 0);
        assert.ok(doc.lead.length + doc.sections.length > 0);
      });

      test("names the product, so a title-based search can find it", () => {
        assert.match(`${doc.title} ${doc.description}`, new RegExp(siteConfig.name, "i"));
      });

      test("round-trips to markdown with an H1 and a summary blockquote", () => {
        const markdown = docToMarkdown(doc);
        assert.match(markdown, /^# .+\n\n> .+/);
      });

      test("has no site-relative link left in its markdown form", () => {
        assert.doesNotMatch(docToMarkdown(doc), /\]\(\/[^)]*\)/);
      });
    });
  }
});

describe("trust anchor pages", () => {
  // AI agents check /about, /contact and /privacy to decide whether a business
  // is real. Thin pages read as placeholders, so hold them to a floor.
  for (const doc of [aboutDoc, contactDoc, privacyDoc]) {
    test(`${doc.path} carries at least 500 characters of prose`, () => {
      assert.ok(
        docToText(doc).length >= 500,
        `${doc.path} has only ${docToText(doc).length} characters`,
      );
    });
  }

  test("/contact names a reachable support channel", () => {
    const markdown = docToMarkdown(contactDoc);
    assert.match(markdown, new RegExp(siteConfig.issues.replace(/[/.]/g, "\\$&")));
  });

  test("/privacy covers what is stored, who processes it and deletion", () => {
    const markdown = docToMarkdown(privacyDoc).toLowerCase();
    for (const topic of ["cookie", "delet", "retention", "cloudflare"]) {
      assert.match(markdown, new RegExp(topic));
    }
  });
});

describe("/docs", () => {
  const markdown = docToMarkdown(docsDoc);

  test("names the developer resources an agent searches for", () => {
    for (const needle of ["vg deploy", "vg generate", "tRPC", "better-auth", "VG_TOKEN"]) {
      assert.match(markdown, new RegExp(needle.replace(/[/.]/g, "\\$&")));
    }
  });

  test("links the machine-readable endpoints", () => {
    for (const path of ["/llms.txt", "/install", "/sitemap.xml", "/.well-known/agent-skills"]) {
      assert.match(markdown, new RegExp(path.replace(/[/.]/g, "\\$&")));
    }
  });
});

describe("llms.txt", () => {
  test("follows the llmstxt.org shape: H1, blockquote, then H2 sections", () => {
    assert.match(llmsTxt, /^# Vibedgames\n\n> .+/);
    assert.ok(llmsTxt.includes("\n## Start here\n"));
  });

  test("carries explicit when-to-use guidance, not marketing copy", () => {
    assert.ok(llmsTxt.includes("## When to use Vibedgames"));
    assert.match(llmsTxt, /Reach for Vibedgames when/);
    assert.match(llmsTxt, /Do \*\*not\*\* reach for Vibedgames/);
  });

  test("tells an agent the first command to run", () => {
    assert.ok(llmsTxt.includes("## How to call it"));
    assert.match(llmsTxt, /npx vibedgames init/);
  });

  test("uses absolute URLs, since it is read away from its origin", () => {
    const links = [...llmsTxt.matchAll(/\]\(([^)]+)\)/g)].map((match) => match[1] ?? "");
    assert.ok(links.length > 0);
    for (const link of links) assert.match(link, /^https:\/\//);
  });
});

describe("404 body", () => {
  const markdown = notFoundMarkdown("/does-not-exist");

  test("says which path was missed", () => {
    assert.match(markdown, /\/does-not-exist/);
  });

  test("points at the files an agent can recover from", () => {
    for (const path of ["/llms.txt", "/sitemap.xml", "/docs"]) {
      assert.match(markdown, new RegExp(path.replace(/[/.]/g, "\\$&")));
    }
  });

  test("works without a pathname", () => {
    assert.match(notFoundMarkdown(), /^# 404/);
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
