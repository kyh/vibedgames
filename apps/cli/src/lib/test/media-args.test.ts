import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, test } from "node:test";

import { parseDownloadFlag, parseRunInput, readExplicitLocalFile } from "../media-args.js";
import { makeCleanups, makeTmpDir } from "../../../test/_helpers.js";

const { cleanups, drain } = makeCleanups();

afterEach(drain);

test("parseRunInput parses string, number, bool, and JSON object values", () => {
  const argv = [
    "--prompt",
    "a cat",
    "--num_images",
    "3",
    "--enable_safety",
    "true",
    "--style",
    '{"variant":"painterly"}',
    "--bare_flag",
  ];

  const out = parseRunInput(argv);
  assert.deepEqual(out, {
    bare_flag: true,
    enable_safety: true,
    num_images: 3,
    prompt: "a cat",
    style: { variant: "painterly" },
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
  assert.deepEqual(out, { logs: true, prompt: "x" });
});

test("parseRunInput passes --logs N through as a model parameter", () => {
  assert.deepEqual(parseRunInput(["--prompt", "x", "--logs", "5"]), {
    logs: 5,
    prompt: "x",
  });
});

test("parseRunInput handles GNU --key=value form", () => {
  const out = parseRunInput([
    "--prompt=hello world",
    "--num_images=4",
    "--enable_safety=true",
    '--style={"variant":"painterly"}',
  ]);

  assert.deepEqual(out, {
    enable_safety: true,
    num_images: 4,
    prompt: "hello world",
    style: { variant: "painterly" },
  });
});

test("parseRunInput stops parsing at the POSIX `--` terminator", () => {
  assert.deepEqual(parseRunInput(["--prompt", "before", "--", "--prompt", "after"]), {
    prompt: "before",
  });
  assert.deepEqual(parseRunInput(["--prompt", "x", "--"]), { prompt: "x" });
});

test("parseDownloadFlag stops parsing at the POSIX `--` terminator", () => {
  assert.deepEqual(parseDownloadFlag(["--prompt", "x", "--", "--download", "evil"]), {
    mode: "off",
  });
});

test("parseRunInput strips --async=true via the reserved-flags guard", () => {
  assert.deepEqual(parseRunInput(["--prompt", "x", "--async=true"]), {
    prompt: "x",
  });
});

test("parseDownloadFlag handles --download=template form", () => {
  assert.deepEqual(parseDownloadFlag(["--download=out/{ext}"]), {
    mode: "on",
    template: "out/{ext}",
  });
  assert.deepEqual(parseDownloadFlag(["--download="]), { mode: "on" });
  assert.deepEqual(parseDownloadFlag(["--download=true"]), { mode: "on" });
  assert.deepEqual(parseDownloadFlag(["--download=false"]), { mode: "off" });
  assert.deepEqual(parseDownloadFlag(["--download=first", "--prompt", "x", "--download=second"]), {
    mode: "on",
    template: "second",
  });
});

test("parseRunInput handles --download with and without a value", () => {
  const withValue = parseRunInput([
    "--prompt",
    "x",
    "--download",
    "out/{name}.{ext}",
    "--seed",
    "42",
  ]);

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

test('parseDownloadFlag honors literal "true"/"false" boolean intent', () => {
  assert.deepEqual(parseDownloadFlag(["--download", "true"]), { mode: "on" });
  assert.deepEqual(parseDownloadFlag(["--download", "false"]), { mode: "off" });
});

test("readExplicitLocalFile infers content type via extname (handles dotted directories)", () => {
  const baseDir = makeTmpDir(cleanups, "vg-dot.dir-");
  const dotted = path.join(baseDir, "my.project");
  mkdirSync(dotted);
  const target = path.join(dotted, "frame.png");
  writeFileSync(target, "x");
  assert.equal(readExplicitLocalFile(target)?.contentType, "image/png");

  const noExt = path.join(dotted, "frame");
  writeFileSync(noExt, "x");
  assert.equal(readExplicitLocalFile(noExt)?.contentType, "application/octet-stream");
});

test("readExplicitLocalFile accepts bare non-media filenames (3D/audio/etc)", () => {
  const dir = makeTmpDir(cleanups, "vg-explicit-");
  const cwd = process.cwd();
  process.chdir(dir);
  cleanups.push(() => process.chdir(cwd));

  for (const name of ["model.glb", "scene.fbx", "data.ply", "LICENSE"]) {
    writeFileSync(path.join(dir, name), "x");
    const stat = readExplicitLocalFile(name);
    assert.ok(stat, `expected to find ${name}`);
    assert.equal(stat.filename, name);
  }

  assert.equal(readExplicitLocalFile("https://example.com/model.glb"), null);
  assert.equal(readExplicitLocalFile("does-not-exist.glb"), null);
});
