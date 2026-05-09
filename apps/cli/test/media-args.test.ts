import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import {
  parseDownloadFlag,
  parseRunInput,
  readExplicitLocalFile,
} from "../src/lib/media-args.js";
import { makeCleanups, makeTmpDir } from "./_helpers.js";

const { cleanups, drain } = makeCleanups();
afterEach(drain);

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

test("parseRunInput strips --async=true via the reserved-flags guard", () => {
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
  // Empty inline value and "true" are bare-flag indicators.
  assert.deepEqual(parseDownloadFlag(["--download="]), { mode: "on" });
  assert.deepEqual(parseDownloadFlag(["--download=true"]), { mode: "on" });
  // "false" explicitly opts out (useful for overriding wrapper defaults).
  assert.deepEqual(parseDownloadFlag(["--download=false"]), { mode: "off" });
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

test('parseDownloadFlag honors literal "true"/"false" boolean intent', () => {
  // `--download true` is a bare-flag indicator (otherwise it would
  // create a directory literally named "true").
  assert.deepEqual(parseDownloadFlag(["--download", "true"]), { mode: "on" });
  // `--download false` is an explicit opt-out so wrapper-script
  // defaults can be overridden.
  assert.deepEqual(parseDownloadFlag(["--download", "false"]), { mode: "off" });
});

test("readExplicitLocalFile infers content type via extname (handles dotted directories)", () => {
  // Dotted directory was the gotcha for path.lastIndexOf('.'), which
  // would have treated 'project/file.png' as the extension on a path
  // like '/tmp/my.project/file.png'. extname is basename-aware.
  const baseDir = makeTmpDir(cleanups, "vg-dot.dir-");
  const dotted = join(baseDir, "my.project");
  mkdirSync(dotted);
  const target = join(dotted, "frame.png");
  writeFileSync(target, "x");
  assert.equal(readExplicitLocalFile(target)?.contentType, "image/png");

  // Extensionless file inside the same dotted directory: must not
  // pick up "project/frame" as a phantom extension.
  const noExt = join(dotted, "frame");
  writeFileSync(noExt, "x");
  assert.equal(readExplicitLocalFile(noExt)?.contentType, "application/octet-stream");
});

test("readExplicitLocalFile accepts bare non-media filenames (3D/audio/etc)", () => {
  // `vg media upload model.glb` from cwd must work even though .glb
  // isn't a known media extension — the upload command is an explicit
  // user intent.
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
