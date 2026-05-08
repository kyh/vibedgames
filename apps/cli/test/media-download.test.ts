import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, test } from "node:test";

import { downloadMedia, extractMediaRefs } from "../src/lib/media-download.js";
import { makeCleanups, makeTmpDir } from "./_helpers.js";

const { cleanups, drain } = makeCleanups();
afterEach(drain);

const tmpDir = () => makeTmpDir(cleanups, "vg-dl-");

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

test("downloadMedia treats '.' / './' / 'out/' as a destination directory", async () => {
  // Stand up a tiny HTTP server so this test exercises the actual fetch +
  // template path. Easier than mocking — keeps `renderTemplate` honest.
  const { createServer } = await import("node:http");
  const server = createServer((_, res) => {
    res.setHeader("content-type", "image/png");
    res.end(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  });
  const port: number = await new Promise((r) => {
    server.listen(0, () => {
      const addr = server.address();
      r(typeof addr === "object" && addr ? addr.port : 0);
    });
  });
  cleanups.push(() => server.close());

  const dir = tmpDir();
  const ref = {
    url: `http://127.0.0.1:${port}/a.png`,
    filename: "a.png",
    contentType: "image/png" as const,
  };

  for (const template of [dir, dir + "/", join(dir, "nested") + "/"]) {
    const result = await downloadMedia({ refs: [ref], template, requestId: "rid" });
    assert.equal(result.failed.length, 0);
    assert.equal(result.downloaded.length, 1);
    const written = result.downloaded[0]!;
    assert.equal(written, resolve(template, "a.png"));
    assert.equal(readFileSync(written).length, 4);
  }
});

test("downloadMedia renders {placeholder} templates as paths", async () => {
  const { createServer } = await import("node:http");
  const server = createServer((_, res) => {
    res.setHeader("content-type", "image/png");
    res.end(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  });
  const port: number = await new Promise((r) => {
    server.listen(0, () => {
      const addr = server.address();
      r(typeof addr === "object" && addr ? addr.port : 0);
    });
  });
  cleanups.push(() => server.close());

  const dir = tmpDir();
  const result = await downloadMedia({
    refs: [{ url: `http://127.0.0.1:${port}/a.png`, filename: "a.png", contentType: "image/png" }],
    template: join(dir, "{request_id}-{name}.{ext}"),
    requestId: "rid42",
  });
  assert.equal(result.failed.length, 0);
  assert.equal(result.downloaded[0], resolve(join(dir, "rid42-a.png")));
});
