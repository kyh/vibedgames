import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import {
  extractLocalFiles,
  parseDownloadFlag,
  parseRunInput,
  readExplicitLocalFile,
  substituteTokens,
} from "../src/lib/media-args.js";
import { makeCleanups, makeTmpDir, makeTmpFile } from "./_helpers.js";

const { cleanups, drain } = makeCleanups();
afterEach(drain);

const tmpFile = (name: string, content = "x") => makeTmpFile(cleanups, name, content, "vg-media-");

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
  // `--logs` is a status-only flag, so it stays as a passthrough to
  // the model — here it's a bare boolean (no value follows).
  assert.deepEqual(out, { prompt: "x", logs: true });
});

test("parseRunInput passes --logs N through as a model parameter", () => {
  // Some fal endpoints accept a `logs` parameter; --logs is NOT a
  // `vg media run` CLI flag, only `vg media status` has it. Make sure
  // we don't swallow it.
  assert.deepEqual(parseRunInput(["--prompt", "x", "--logs", "5"]), {
    prompt: "x",
    logs: 5,
  });
});

test("parseRunInput handles GNU --key=value form", () => {
  // Without =-aware splitting, `--prompt=hi` would key as "prompt=hi".
  const out = parseRunInput([
    "--prompt=hello world",
    "--num_images=4",
    "--enable_safety=true",
    "--style={\"variant\":\"painterly\"}",
  ]);
  assert.deepEqual(out, {
    prompt: "hello world",
    num_images: 4,
    enable_safety: true,
    style: { variant: "painterly" },
  });
});

test("parseRunInput strips --async=true via the KNOWN flags guard", () => {
  // Otherwise async=true would leak through as a bogus model param.
  assert.deepEqual(parseRunInput(["--prompt", "x", "--async=true"]), {
    prompt: "x",
  });
});

test("parseDownloadFlag handles --download=template form", () => {
  assert.deepEqual(parseDownloadFlag(["--download=out/{ext}"]), {
    mode: "on",
    template: "out/{ext}",
  });
  // Empty inline value is bare-flag; "true"/"false" too.
  assert.deepEqual(parseDownloadFlag(["--download="]), { mode: "on" });
  assert.deepEqual(parseDownloadFlag(["--download=true"]), { mode: "on" });
  // Last occurrence wins, mixed forms.
  assert.deepEqual(
    parseDownloadFlag(["--download=first", "--prompt", "x", "--download=second"]),
    { mode: "on", template: "second" },
  );
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

test('parseDownloadFlag treats literal "true"/"false" as a bare flag', () => {
  // Otherwise `vg media run … --download true` would create a
  // directory literally named "true".
  assert.deepEqual(parseDownloadFlag(["--download", "true"]), { mode: "on" });
  assert.deepEqual(parseDownloadFlag(["--download", "false"]), { mode: "on" });
});

test("extractLocalFiles infers content type via extname (handles dotted directories)", () => {
  // Create a file inside a directory that *contains* a dot in its name.
  // Earlier the helper used `path.lastIndexOf(".")`, which would have
  // treated "project/file.png" as the extension on a path like
  // "/tmp/my.project/file.png" and then misclassified the MIME.
  const baseDir = makeTmpDir(cleanups, "vg-dot.dir-");
  // Inner directory name with a dot in it.
  const dotted = join(baseDir, "my.project");
  mkdirSync(dotted);
  const target = join(dotted, "frame.png");
  writeFileSync(target, "x");

  const { files } = extractLocalFiles({ image_url: target });
  assert.equal(files.length, 1);
  assert.equal(files[0]!.contentType, "image/png");

  // Extensionless file inside the same dotted directory: must not
  // pick up "project/frame" as a phantom extension.
  const noExt = join(dotted, "frame");
  writeFileSync(noExt, "x");
  const { files: extless } = extractLocalFiles({ image_url: noExt });
  assert.equal(extless[0]!.contentType, "application/octet-stream");
});

test("extractLocalFiles only matches paths that exist on disk", () => {
  const realPath = tmpFile("input.png");
  const input = {
    image_url: realPath,
    other_url: "https://example.com/foo.png",
    seed: 42,
    nope: "does/not/exist.png",
  };
  const { files, rewritten } = extractLocalFiles(input);
  assert.equal(files.length, 1);
  assert.equal(files[0]!.path, realPath);
  assert.match(files[0]!.token, /^__vg_upload_\d+__$/);
  // Token in the rewritten payload matches the one carried by the file
  // ref — single source of truth, no parallel collections.
  assert.equal(rewritten.image_url, files[0]!.token);
  assert.equal(rewritten.other_url, "https://example.com/foo.png");
  assert.equal(rewritten.seed, 42);
  assert.equal(rewritten.nope, "does/not/exist.png");
});

test("readExplicitLocalFile accepts bare non-media filenames (3D/audio/etc)", () => {
  // `vg media upload model.glb` from cwd must work even though .glb
  // isn't in MEDIA_EXT — the upload command is an explicit user
  // intent, not auto-detection.
  const dir = makeTmpDir(cleanups, "vg-explicit-");
  const cwd = process.cwd();
  process.chdir(dir);
  cleanups.push(() => process.chdir(cwd));
  for (const name of ["model.glb", "scene.fbx", "data.ply", "LICENSE"]) {
    writeFileSync(join(dir, name), "x");
    const stat = readExplicitLocalFile(name);
    assert.ok(stat, `expected to find ${name}`);
    assert.equal(stat!.filename, name);
  }
  // Still rejects URLs and missing files.
  assert.equal(readExplicitLocalFile("https://example.com/model.glb"), null);
  assert.equal(readExplicitLocalFile("does-not-exist.glb"), null);
});

test("extractLocalFiles ignores bare tokens that happen to match a local file", () => {
  // `--style painterly` should stay a string even if a file named
  // `painterly` exists in cwd. Only path-like values (with separators
  // or media extensions) qualify for auto-upload.
  const dir = makeTmpDir(cleanups, "vg-bare-");
  const cwd = process.cwd();
  process.chdir(dir);
  cleanups.push(() => process.chdir(cwd));
  writeFileSync(join(dir, "painterly"), "x");
  writeFileSync(join(dir, "cat.png"), "x");

  const { files, rewritten } = extractLocalFiles({
    style: "painterly",
    image_url: "cat.png",
    prompt: "a painterly cat",
  });
  // Only cat.png (media extension) auto-uploads; painterly stays a string.
  assert.equal(files.length, 1);
  assert.equal(rewritten.style, "painterly");
  assert.equal(rewritten.prompt, "a painterly cat");
  assert.match(rewritten.image_url as string, /^__vg_upload_\d+__$/);
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
