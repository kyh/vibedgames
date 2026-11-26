import { runInOrder } from "@repo/contract/run-in-order";
import assert from "node:assert/strict";
import { after, afterEach, before, describe, test } from "node:test";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { uploadInput } from "@repo/contract/deploy/deploy-schema";

import { decodeInlineFiles, MAX_FETCHED_BYTES, sha256Hex } from "./inline-files";

const parse = (files: unknown[]) => uploadInput.parse({ files, slug: "my-game" }).files;

const isBadRequest = { code: "BAD_REQUEST" };

describe("decodeInlineFiles", () => {
  test("encodes text as UTF-8 and types it by its path", async () => {
    const [file] = await decodeInlineFiles(parse([{ content: "<p>é</p>", path: "index.html" }]));
    assert.deepStrictEqual([...(file?.bytes ?? [])], [...Buffer.from("<p>é</p>", "utf-8")]);
    assert.strictEqual(file?.contentType, "text/html; charset=utf-8");
  });

  test("falls back to octet-stream for an unknown extension", async () => {
    const [file] = await decodeInlineFiles(parse([{ content: "x", path: "data.unknownext" }]));
    assert.strictEqual(file?.contentType, "application/octet-stream");
  });

  test("refuses base64: binary bytes go in presign", () => {
    assert.throws(() => parse([{ content: "AAAA", encoding: "base64", path: "a.png" }]));
  });

  test("refuses a path given twice in one call", async () => {
    await assert.rejects(
      decodeInlineFiles(
        parse([
          { content: "a", path: "index.html" },
          { content: "b", path: "index.html" },
        ]),
      ),
      isBadRequest,
    );
  });

  test("the schema refuses an absolute or climbing path", () => {
    assert.throws(() => parse([{ content: "x", path: "/etc/passwd" }]));
    assert.throws(() => parse([{ content: "x", path: "../escape.js" }]));
  });
});

const network = setupServer();

const serve = (body: Uint8Array<ArrayBuffer>, redirectTo?: string) => {
  const asked: string[] = [];

  network.use(
    http.all("*", ({ request }) => {
      asked.push(request.url);

      if (redirectTo !== undefined && request.url !== redirectTo) {
        return HttpResponse.redirect(redirectTo, 302);
      }

      return HttpResponse.arrayBuffer(body.buffer);
    }),
  );

  return asked;
};

const urlFile = (content: string, path = "art/hero.png") =>
  parse([{ content, encoding: "url", path }]);

describe("decodeInlineFiles with url files", () => {
  before(() => {
    network.listen({ onUnhandledRequest: "error" });
  });

  afterEach(() => {
    network.resetHandlers();
  });

  after(() => {
    network.close();
  });

  test("fetches a generated asset and types it by its path", async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    serve(png);
    const [file] = await decodeInlineFiles(urlFile("https://v3.fal.media/files/a/hero.png"));
    assert.deepStrictEqual([...(file?.bytes ?? [])], [...png]);
    assert.strictEqual(file?.contentType, "image/png");
  });

  test("refuses any other host before fetching anything", async () => {
    await runInOrder(
      [
        "https://example.com/hero.png",
        "http://v3.fal.media/files/a/hero.png",
        "https://fal.media.example.com/hero.png",
        "https://v3.fal.media@example.com/hero.png",
        "not a url",
      ],
      async (url) => {
        const asked = serve(new Uint8Array([1]));
        await assert.rejects(decodeInlineFiles(urlFile(url)), isBadRequest, url);
        assert.deepStrictEqual(asked, [], url);
      },
    );
  });

  test("refuses a redirect off the media hosts", async () => {
    serve(new Uint8Array([1]), "https://internal.example/secret");
    await assert.rejects(
      decodeInlineFiles(urlFile("https://v3.fal.media/files/a/hero.png")),
      isBadRequest,
    );
  });

  test("refuses a file past what one call may fetch", async () => {
    serve(new Uint8Array(MAX_FETCHED_BYTES + 1));
    await assert.rejects(
      decodeInlineFiles(urlFile("https://v3.fal.media/files/a/world.bin", "world.bin")),
      isBadRequest,
    );
  });
});

describe("sha256Hex", () => {
  test("matches the CLI's manifest digest", async () => {
    const bytes = new Uint8Array(new TextEncoder().encode("abc"));
    assert.strictEqual(
      await sha256Hex(bytes),
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });
});
