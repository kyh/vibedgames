import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import {
  extractLocalFiles,
  parseDownloadFlag,
  parseRunInput,
  substituteTokens,
} from "../src/lib/media-args.js";

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
});

function tmpFile(name: string, content = "x"): string {
  const dir = mkdtempSync(join(tmpdir(), "vg-media-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, name);
  writeFileSync(path, content);
  return path;
}

test("parseRunInput parses string, number, bool, and JSON object values", () => {
  const argv = [
    "--prompt", "a cat",
    "--num_images", "3",
    "--enable_safety", "true",
    "--style", "{\"variant\":\"painterly\"}",
    "--bare_flag",
  ];
  const out = parseRunInput(argv);
  assert.deepEqual(out, {
    prompt: "a cat",
    num_images: 3,
    enable_safety: true,
    style: { variant: "painterly" },
    bare_flag: true,
  });
});

test("parseRunInput collects repeated flags into an array", () => {
  const argv = ["--image_url", "a", "--image_url", "b", "--image_url", "c"];
  const out = parseRunInput(argv);
  assert.deepEqual(out.image_url, ["a", "b", "c"]);
});

test("parseRunInput skips known global flags but keeps their value-bearing neighbors", () => {
  const argv = ["--prompt", "x", "--json", "--async", "--logs"];
  const out = parseRunInput(argv);
  assert.deepEqual(out, { prompt: "x" });
});

test("parseRunInput handles --download with and without a value", () => {
  const withValue = parseRunInput(["--prompt", "x", "--download", "out/{name}.{ext}", "--seed", "42"]);
  assert.deepEqual(withValue, { prompt: "x", seed: 42 });
  const bare = parseRunInput(["--prompt", "x", "--download", "--seed", "42"]);
  assert.deepEqual(bare, { prompt: "x", seed: 42 });
});

test("parseDownloadFlag returns mode + template", () => {
  assert.deepEqual(parseDownloadFlag(["--download", "out/{ext}"]), {
    mode: "on",
    template: "out/{ext}",
  });
  assert.deepEqual(parseDownloadFlag(["--download"]), { mode: "on" });
  assert.deepEqual(parseDownloadFlag(["--prompt", "x"]), { mode: "off" });
});

test("extractLocalFiles only matches paths that exist on disk", () => {
  const realPath = tmpFile("input.png");
  const input = {
    image_url: realPath,
    other_url: "https://example.com/foo.png",
    seed: 42,
    nope: "does/not/exist.png",
  };
  const { files, tokens, rewritten } = extractLocalFiles(input);
  assert.equal(files.length, 1);
  assert.equal(files[0]!.path, realPath);
  assert.equal(tokens.size, 1);
  assert.match(rewritten.image_url as string, /^__vg_upload_\d+__$/);
  assert.equal(rewritten.other_url, "https://example.com/foo.png");
  assert.equal(rewritten.seed, 42);
  assert.equal(rewritten.nope, "does/not/exist.png");
});

test("extractLocalFiles walks arrays and nested objects", () => {
  const a = tmpFile("a.png");
  const b = tmpFile("b.png");
  const input = {
    image_urls: [a, "https://x", b],
    nested: { ref: a },
  };
  const { files, rewritten } = extractLocalFiles(input);
  assert.equal(files.length, 3);
  assert.deepEqual((rewritten.image_urls as unknown[])[1], "https://x");
});

test("substituteTokens replaces tokens with resolved URLs", () => {
  const tokenToUrl = new Map([
    ["__vg_upload_0__", "https://r2/a"],
    ["__vg_upload_1__", "https://r2/b"],
  ]);
  const input = {
    image_url: "__vg_upload_0__",
    array: ["__vg_upload_1__", "passthrough"],
    nested: { x: "__vg_upload_0__" },
  };
  const result = substituteTokens(input, tokenToUrl);
  assert.deepEqual(result, {
    image_url: "https://r2/a",
    array: ["https://r2/b", "passthrough"],
    nested: { x: "https://r2/a" },
  });
});
