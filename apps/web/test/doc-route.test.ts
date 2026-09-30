import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { aboutDoc } from "@/content/about";
import { buildDoc } from "@/content/build";
import { contactDoc } from "@/content/contact";
import { discoverDoc } from "@/content/discover";
import { docsDoc } from "@/content/docs";
import { homeDoc } from "@/content/home";
import { privacyDoc } from "@/content/privacy";
import { canonicalUrl, docHead } from "@/lib/doc-route";
import { siteConfig } from "@/lib/site-config";

describe("canonicalUrl", () => {
  test("the apex has no path and no trailing slash", () => {
    assert.equal(canonicalUrl("/"), siteConfig.url);
  });

  test("strips trailing slashes", () => {
    assert.equal(canonicalUrl("/docs/"), `${siteConfig.url}/docs`);
  });
});

describe("docHead", () => {
  // The root route emits the one `<link rel="canonical">` for every page.
  for (const doc of [homeDoc, aboutDoc, buildDoc, contactDoc, discoverDoc, docsDoc, privacyDoc]) {
    test(`${doc.path} adds no second canonical and its og:url matches the root's`, () => {
      const head = docHead(doc);
      assert.equal("links" in head, false);
      const ogUrl = head.meta.find((tag) => "property" in tag && tag.property === "og:url");
      assert.deepEqual(ogUrl, { content: canonicalUrl(doc.path), property: "og:url" });
    });
  }
});
