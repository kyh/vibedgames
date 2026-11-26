import { runInOrder } from "@repo/contract/run-in-order";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import path from "node:path";
import { afterEach, test } from "node:test";

import { downloadMedia, extractMediaRefs } from "../media-download.js";
import { makeCleanups, makeTestServer, makeTmpDir } from "../../../test/_helpers.js";

const { cleanups, drain } = makeCleanups();

afterEach(drain);

const tmpDir = () => makeTmpDir(cleanups, "vg-dl-");

test("extractMediaRefs picks up image content_type entries", () => {
  const result = {
    images: [
      { content_type: "image/png", file_name: "a.png", url: "https://v3.fal.media/files/a.png" },
      { content_type: "image/jpeg", file_name: "b.jpg", url: "https://v3.fal.media/files/b.jpg" },
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
  assert.equal(refs.at(0)?.url, "https://v3.fal.media/files/x.mp4");
});

test("extractMediaRefs ignores unrelated URLs", () => {
  const result = {
    docs: { content_type: "text/html", url: "https://docs.fal.ai/some/page" },
    image: { content_type: "image/png", url: "https://v3.fal.media/files/a.png" },
    metadata: { url: "https://api.fal.ai/v1/something" },
  };

  const refs = extractMediaRefs(result);
  assert.equal(refs.length, 1);
  assert.equal(refs.at(0)?.contentType, "image/png");
});

test("extractMediaRefs rejects non-fal hosts even with a media content_type", () => {
  const result = {
    confusable_suffix: {
      content_type: "image/png",
      url: "https://fal.media.evil.com/x.png",
    },
    file_url: {
      content_type: "image/png",
      url: "file:///etc/passwd",
    },
    http_downgrade: {
      content_type: "image/png",
      url: "http://v3.fal.media/files/insecure.png",
    },
    legit: {
      content_type: "image/png",
      file_name: "ok.png",
      url: "https://v3.fal.media/files/ok.png",
    },
    nested_subdomain: {
      content_type: "video/mp4",
      url: "https://cdn.fal.run/files/clip.mp4",
    },
    spoofed: {
      content_type: "image/png",
      file_name: "payload.png",
      url: "https://evil.example.com/payload.png",
    },
  };

  const refs = extractMediaRefs(result);
  const urls = refs.map((r) => r.url).toSorted();
  assert.deepEqual(urls, [
    "https://cdn.fal.run/files/clip.mp4",
    "https://v3.fal.media/files/ok.png",
  ]);
});

test("extractMediaRefs sanitizes fal file_name to prevent download path traversal", () => {
  const result = {
    dot_only: {
      content_type: "image/png",
      file_name: "..",
      url: "https://v3.fal.media/files/z.png",
    },
    traversal: {
      content_type: "image/png",
      file_name: "../../etc/crontab",
      url: "https://v3.fal.media/files/x.png",
    },
    windows: {
      content_type: "image/png",
      file_name: "..\\..\\windows\\system32\\evil.png",
      url: "https://v3.fal.media/files/y.png",
    },
  };

  const refs = extractMediaRefs(result);
  assert.equal(refs.find((r) => r.url.endsWith("x.png"))?.filename, "crontab");
  assert.equal(refs.find((r) => r.url.endsWith("y.png"))?.filename, "evil.png");
  assert.equal(refs.find((r) => r.url.endsWith("z.png"))?.filename, "output.png");
});

test("extractMediaRefs deduplicates the same URL appearing twice in the tree", () => {
  const ref = {
    content_type: "image/png",
    file_name: "a.png",
    url: "https://v3.fal.media/files/a.png",
  };

  const result = { also: { nested: ref }, primary: ref };
  const refs = extractMediaRefs(result);
  assert.equal(refs.length, 1);
});

test("extractMediaRefs handles a nested array of frames", () => {
  const result = {
    frames: Array.from({ length: 3 }, (_, i) => ({
      content_type: "image/png",
      url: `https://v3.fal.media/files/f${i}.png`,
    })),
  };

  const refs = extractMediaRefs(result);
  assert.equal(refs.length, 3);
});

const servePng = (
  _: IncomingMessage,
  res: { setHeader: (k: string, v: string) => void; end: (b: Buffer) => void },
) => {
  res.setHeader("content-type", "image/png");
  res.end(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
};

test("downloadMedia treats '.' / './' / 'out/' as a destination directory", async () => {
  const port = await makeTestServer(cleanups, servePng);
  const dir = tmpDir();

  const ref = {
    contentType: "image/png" as const,
    filename: "a.png",
    url: `http://127.0.0.1:${port}/a.png`,
  };

  await runInOrder([dir, `${dir}/`, `${path.join(dir, "nested")}/`], async (template) => {
    const result = await downloadMedia({ refs: [ref], requestId: "rid", template });
    assert.equal(result.failed.length, 0);
    assert.equal(result.downloaded.length, 1);
    const [written] = result.downloaded;
    assert.ok(written !== undefined);
    assert.equal(written, path.resolve(template, "a.png"));
    assert.equal(readFileSync(written).length, 4);
  });
});

test("downloadMedia writes to a file template literally (not as a directory)", async () => {
  const port = await makeTestServer(cleanups, servePng);
  const dir = tmpDir();
  const target = path.join(dir, "walk.png");

  const ref = {
    contentType: "image/png" as const,
    filename: "source.png",
    url: `http://127.0.0.1:${port}/source.png`,
  };

  const result = await downloadMedia({ refs: [ref], requestId: "rid", template: target });
  assert.equal(result.failed.length, 0);
  assert.deepEqual(result.downloaded, [path.resolve(target)]);
});

test("downloadMedia reports a download whose bytes contradict its extension", async () => {
  const port = await makeTestServer(cleanups, (_, res) => {
    res.setHeader("content-type", "image/jpeg");
    res.end(Buffer.from([0xff, 0xd8, 0xff, 0xe0]));
  });

  const dir = tmpDir();
  const target = path.join(dir, "board.png");

  const ref = {
    contentType: "image/jpeg" as const,
    filename: "source.jpg",
    url: `http://127.0.0.1:${port}/source.jpg`,
  };

  const result = await downloadMedia({ refs: [ref], requestId: "rid", template: target });
  assert.deepEqual(
    result.downloaded,
    [path.resolve(target)],
    "the requested path is still honoured",
  );
  assert.deepEqual(result.mislabeled, [{ actual: "jpg", path: path.resolve(target) }]);
});

test("downloadMedia stays quiet when the extension matches, aliases included", async () => {
  const port = await makeTestServer(cleanups, (_, res) => {
    res.setHeader("content-type", "image/jpeg");
    res.end(Buffer.from([0xff, 0xd8, 0xff, 0xe0]));
  });

  const dir = tmpDir();

  const ref = {
    contentType: "image/jpeg" as const,
    filename: "source.jpg",
    url: `http://127.0.0.1:${port}/source.jpg`,
  };

  await runInOrder(["board.jpg", "board.jpeg"], async (name) => {
    const result = await downloadMedia({
      refs: [ref],
      requestId: "rid",
      template: path.join(dir, name),
    });

    assert.deepEqual(result.mislabeled, [], `${name} names the same format`);
  });
});

test("downloadMedia suffixes colliding targets so multi-output runs don't overwrite", async () => {
  const port = await makeTestServer(cleanups, servePng);
  const dir = tmpDir();

  const ref = (i: number) => ({
    contentType: "image/png" as const,
    filename: "output.png",
    url: `http://127.0.0.1:${port}/output.png?i=${i}`,
  });

  const result = await downloadMedia({
    refs: [ref(0), ref(1), ref(2)],
    requestId: "rid",
    template: `${dir}/`,
  });

  assert.equal(result.failed.length, 0);
  assert.deepEqual(result.downloaded, [
    path.resolve(dir, "output.png"),
    path.resolve(dir, "output_1.png"),
    path.resolve(dir, "output_2.png"),
  ]);
});

test("downloadMedia renders {placeholder} templates as paths", async () => {
  const port = await makeTestServer(cleanups, servePng);
  const dir = tmpDir();

  const result = await downloadMedia({
    refs: [{ contentType: "image/png", filename: "a.png", url: `http://127.0.0.1:${port}/a.png` }],
    requestId: "rid42",
    template: path.join(dir, "{request_id}-{name}.{ext}"),
  });

  assert.equal(result.failed.length, 0);
  assert.equal(result.downloaded[0], path.resolve(path.join(dir, "rid42-a.png")));
});
