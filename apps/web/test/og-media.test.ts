import assert from "node:assert/strict";
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";

import { aboutDoc } from "@/content/about";
import { buildDoc } from "@/content/build";
import { contactDoc } from "@/content/contact";
import { discoverDoc } from "@/content/discover";
import { docsDoc } from "@/content/docs";
import { homeDoc } from "@/content/home";
import { privacyDoc } from "@/content/privacy";
import { SITEMAP_PAGES, SITEMAP_PATHS, pageLastModified } from "@/content/site-map";
import { termsDoc } from "@/content/terms";
import { docHead } from "@/lib/doc-route";
import {
  PAGE_CARD_PATHS,
  SITE_IMAGE,
  SITE_IMAGE_ALT,
  pageImage,
  pageImageAlt,
  siteVideo,
} from "@/lib/og-media";
import { siteConfig } from "@/lib/site-config";
import { pageGraph, siteGraph } from "@/lib/structured-data";

const PUBLIC = path.resolve(import.meta.dirname, "../public");
const publicFile = (sitePath: string) => path.join(PUBLIC, sitePath);

const docs = [homeDoc, discoverDoc, buildDoc, docsDoc, aboutDoc, contactDoc, privacyDoc, termsDoc];

describe("committed og media", () => {
  test("the trailer and its poster exist, and the trailer stays under 2.5 MB", () => {
    for (const file of [siteVideo.path, siteVideo.poster, SITE_IMAGE]) {
      assert.ok(existsSync(publicFile(file)), `public${file} is missing`);
    }
    assert.ok(statSync(publicFile(siteVideo.path)).size < 2.5 * 1024 * 1024);
  });

  test("every prose page with a card has its card on disk", () => {
    for (const cardPath of PAGE_CARD_PATHS) {
      assert.ok(existsSync(publicFile(pageImage(cardPath))), `no card for ${cardPath}`);
    }
  });

  test("a page without a card falls back to the site image", () => {
    assert.equal(pageImage("/"), SITE_IMAGE);
    assert.equal(pageImage("/does-not-exist"), SITE_IMAGE);
  });

  test("the site image's alt is its own, and a card's is its page's title", () => {
    assert.equal(pageImageAlt("/", "Home"), SITE_IMAGE_ALT);
    assert.equal(pageImageAlt("/about", "About"), "About");
    const alt = docHead(homeDoc).meta.find(
      (entry) => "property" in entry && entry.property === "og:image:alt",
    );
    assert.ok(alt && "content" in alt && alt.content === SITE_IMAGE_ALT);
  });

  test("the clip's description names no upstream brand", () => {
    assert.doesNotMatch(
      `${siteVideo.name} ${siteVideo.description} ${SITE_IMAGE_ALT}`,
      /\bfal\b/iu,
    );
  });

  test("the duration is ISO 8601 and the upload date is an ISO date", () => {
    assert.match(siteVideo.duration, /^PT\d+S$/u);
    assert.match(siteVideo.uploadDate, /^\d{4}-\d{2}-\d{2}$/u);
  });
});

describe("site graph video", () => {
  test("carries a VideoObject with absolute URLs, and the app points at it", () => {
    const nodes = siteGraph()["@graph"];
    const video = nodes.find((node) => node["@type"] === "VideoObject");
    const app = nodes.find((node) => node["@type"] === "SoftwareApplication");
    assert.ok(video && video["@type"] === "VideoObject");
    assert.ok(app && app["@type"] === "SoftwareApplication");
    assert.equal(video.contentUrl, `${siteConfig.url}${siteVideo.path}`);
    assert.equal(video.thumbnailUrl, `${siteConfig.url}${siteVideo.poster}`);
    assert.equal(video.width, 1200);
    assert.equal(video.height, 630);
    assert.deepEqual(app.video, { "@id": video["@id"] });
  });
});

describe("per-page head", () => {
  for (const doc of docs) {
    describe(doc.path, () => {
      const head = docHead(doc);
      const graph = head.meta.find((tag) => "script:ld+json" in tag);

      test("names its own og:image and twitter image", () => {
        const image = `${siteConfig.url}${pageImage(doc.path)}`;
        for (const key of ["og:image", "twitter:image"]) {
          const tag = head.meta.find(
            (entry) =>
              ("property" in entry && entry.property === key) ||
              ("name" in entry && entry.name === key),
          );
          assert.ok(tag && "content" in tag && tag.content === image, `${key} on ${doc.path}`);
        }
      });

      test("carries a page node in its JSON-LD", () => {
        assert.ok(graph, `${doc.path} has no JSON-LD`);
        const [page] = pageGraph(doc)["@graph"];
        assert.ok(page);
        assert.equal(page.url, doc.path === "/" ? siteConfig.url : `${siteConfig.url}${doc.path}`);
        assert.equal(page.dateModified, pageLastModified(doc.path));
        assert.equal(page.breadcrumb === undefined, doc.path === "/");
      });
    });
  }

  test("the docs are a TechArticle about the product", () => {
    const [page] = pageGraph(docsDoc)["@graph"];
    assert.equal(page?.["@type"], "TechArticle");
    assert.ok(page?.about);
  });

  test("the trust pages say what they are", () => {
    assert.equal(pageGraph(aboutDoc)["@graph"][0]?.["@type"], "AboutPage");
    assert.equal(pageGraph(contactDoc)["@graph"][0]?.["@type"], "ContactPage");
  });
});

describe("sitemap dates", () => {
  test("every page has an ISO lastmod", () => {
    for (const page of SITEMAP_PAGES) {
      assert.match(page.lastModified, /^\d{4}-\d{2}-\d{2}$/u, page.path);
    }
    assert.equal(SITEMAP_PATHS.length, SITEMAP_PAGES.length);
  });
});
