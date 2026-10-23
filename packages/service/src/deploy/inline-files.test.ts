import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { uploadInput } from "@repo/contract/deploy/deploy-schema";

import { decodeInlineFiles, sha256Hex } from "./inline-files";

const parse = (files: unknown[]) => uploadInput.parse({ files, slug: "my-game" }).files;

// `assert.throws` matches an object pattern against the thrown ORPCError.
const isBadRequest = { code: "BAD_REQUEST" };

describe("decodeInlineFiles", () => {
  test("encodes text as UTF-8 and types it by its path", () => {
    const [file] = decodeInlineFiles(parse([{ content: "<p>é</p>", path: "index.html" }]));
    assert.deepStrictEqual([...(file?.bytes ?? [])], [...Buffer.from("<p>é</p>", "utf-8")]);
    assert.strictEqual(file?.contentType, "text/html; charset=utf-8");
  });

  test("decodes base64, tolerating line breaks, and keeps a given type", () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xff, 0x00]);
    const wrapped = png.toString("base64").replaceAll(/(?<quad>.{4})/gu, "$<quad>\n");
    const [file] = decodeInlineFiles(
      parse([{ content: wrapped, contentType: "image/x-test", encoding: "base64", path: "a.bin" }]),
    );
    assert.deepStrictEqual([...(file?.bytes ?? [])], [...png]);
    assert.strictEqual(file?.contentType, "image/x-test");
  });

  test("falls back to octet-stream for an unknown extension", () => {
    const [file] = decodeInlineFiles(parse([{ content: "x", path: "data.unknownext" }]));
    assert.strictEqual(file?.contentType, "application/octet-stream");
  });

  test("refuses content that is not base64", () => {
    assert.throws(
      () =>
        decodeInlineFiles(parse([{ content: "not*base64", encoding: "base64", path: "a.png" }])),
      isBadRequest,
    );
  });

  test("refuses a path given twice in one call", () => {
    assert.throws(
      () =>
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

describe("sha256Hex", () => {
  test("matches the CLI's manifest digest", async () => {
    const bytes = new Uint8Array(new TextEncoder().encode("abc"));
    assert.strictEqual(
      await sha256Hex(bytes),
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });
});
