import assert from "node:assert/strict";
import { test } from "node:test";

import { extractMediaRefs } from "../src/lib/media-download.js";

test("extractMediaRefs picks up image content_type entries", () => {
  const result = {
    images: [
      { url: "https://v3.fal.media/files/a.png", content_type: "image/png", file_name: "a.png" },
      { url: "https://v3.fal.media/files/b.jpg", content_type: "image/jpeg", file_name: "b.jpg" },
    ],
  };
  const refs = extractMediaRefs(result);
  assert.equal(refs.length, 2);
  assert.deepEqual(
    refs.map((r) => r.filename),
    ["a.png", "b.jpg"],
  );
});

test("extractMediaRefs falls back to URL extension when content_type is missing", () => {
  const result = { video: { url: "https://v3.fal.media/files/x.mp4" } };
  const refs = extractMediaRefs(result);
  assert.equal(refs.length, 1);
  assert.equal(refs[0]!.url, "https://v3.fal.media/files/x.mp4");
});

test("extractMediaRefs ignores unrelated URLs", () => {
  const result = {
    image: { url: "https://v3.fal.media/files/a.png", content_type: "image/png" },
    docs: { url: "https://docs.fal.ai/some/page", content_type: "text/html" },
    metadata: { url: "https://api.fal.ai/v1/something" },
  };
  const refs = extractMediaRefs(result);
  assert.equal(refs.length, 1);
  assert.equal(refs[0]!.contentType, "image/png");
});

test("extractMediaRefs deduplicates the same URL appearing twice in the tree", () => {
  const ref = {
    url: "https://v3.fal.media/files/a.png",
    content_type: "image/png",
    file_name: "a.png",
  };
  const result = { primary: ref, also: { nested: ref } };
  const refs = extractMediaRefs(result);
  assert.equal(refs.length, 1);
});

test("extractMediaRefs handles a nested array of frames", () => {
  const result = {
    frames: Array.from({ length: 3 }, (_, i) => ({
      url: `https://v3.fal.media/files/f${i}.png`,
      content_type: "image/png",
    })),
  };
  const refs = extractMediaRefs(result);
  assert.equal(refs.length, 3);
});
