import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import {
  buildCodexPrompt,
  CodexError,
  parseCodexInput,
  placeCodexOutputs,
  renderLocalTarget,
  resolveProvider,
} from "../src/lib/codex.js";
import { makeCleanups, makeTmpDir } from "./_helpers.js";

const { cleanups, drain } = makeCleanups();
afterEach(drain);

test("resolveProvider: flag, env fallback, aliases, and unknown", () => {
  assert.equal(resolveProvider("codex"), "codex");
  assert.equal(resolveProvider("Codex"), "codex");
  assert.equal(resolveProvider("vibedgames"), "vibedgames");
  assert.equal(resolveProvider("fal"), "vibedgames");
  assert.equal(resolveProvider(undefined), "vibedgames");

  const prev = process.env.VG_GENERATE_PROVIDER;
  process.env.VG_GENERATE_PROVIDER = "codex";
  cleanups.push(() => {
    if (prev === undefined) delete process.env.VG_GENERATE_PROVIDER;
    else process.env.VG_GENERATE_PROVIDER = prev;
  });
  // Explicit flag wins over env; env is the fallback.
  assert.equal(resolveProvider(undefined), "codex");
  assert.equal(resolveProvider("vibedgames"), "vibedgames");

  assert.throws(() => resolveProvider("coddex"), /Unknown --provider/);
});

test("CodexError carries notInstalled and output for clean surfacing", () => {
  const missing = new CodexError("not found", { notInstalled: true });
  assert.equal(missing.name, "CodexError");
  assert.equal(missing.notInstalled, true);
  assert.equal(missing.output, "");
  assert.ok(missing instanceof Error);

  const failed = new CodexError("exec failed", { output: "codex said no" });
  assert.equal(failed.notInstalled, false);
  assert.equal(failed.output, "codex said no");
});

test("parseCodexInput extracts prompt, count (clamped), size hint, and references", () => {
  const parsed = parseCodexInput({
    prompt: "  a fox  ",
    num_images: 99,
    aspect_ratio: "16:9",
    image_urls: ["a.png", "b.png"],
    image_url: "c.png",
    seed: 42,
  });
  assert.equal(parsed.prompt, "a fox");
  assert.equal(parsed.count, 8); // clamped to MAX_IMAGES
  assert.equal(parsed.sizeHint, "aspect ratio 16:9");
  assert.deepEqual(parsed.referenceCandidates, ["c.png", "a.png", "b.png"]);
});

test("parseCodexInput defaults count to 1 and falls back to text key", () => {
  const parsed = parseCodexInput({ text: "hello", width: 512, height: 512 });
  assert.equal(parsed.prompt, "hello");
  assert.equal(parsed.count, 1);
  assert.equal(parsed.sizeHint, "512x512px");
  assert.deepEqual(parsed.referenceCandidates, []);
});

test("buildCodexPrompt pins filenames and switches to edit wording with references", () => {
  const base = parseCodexInput({ prompt: "a cat", num_images: 2 });
  const gen = buildCodexPrompt(base, ["output-0.png", "output-1.png"], false);
  assert.match(gen, /Generate 2 images/);
  assert.match(gen, /output-0\.png, output-1\.png/);
  assert.match(gen, /\$imagegen/);

  const edit = buildCodexPrompt(base, ["output-0.png"], true);
  assert.match(edit, /Edit the attached reference image/);
});

test("renderLocalTarget: default naming, placeholders, directory, and literal file", () => {
  const cwd = process.cwd();
  assert.equal(
    renderLocalTarget(undefined, 0, "png", "abcd", 1),
    join(cwd, "codex-image-abcd-0.png"),
  );
  assert.equal(
    renderLocalTarget("out/{request_id}_{index}.{ext}", 2, "png", "abcd", 3),
    join(cwd, "out/abcd_2.png"),
  );
  // Bare directory.
  assert.equal(
    renderLocalTarget("shots", 1, "png", "abcd", 2),
    join(cwd, "shots/codex-image-1.png"),
  );
  // Literal file: index 0 keeps the name, later indices disambiguate.
  assert.equal(renderLocalTarget("hero.png", 0, "png", "abcd", 2), join(cwd, "hero.png"));
  assert.equal(renderLocalTarget("hero.png", 1, "png", "abcd", 2), join(cwd, "hero_1.png"));
});

test("placeCodexOutputs copies raw files to rendered targets", () => {
  const src = makeTmpDir(cleanups, "vg-codex-src-");
  const dst = makeTmpDir(cleanups, "vg-codex-dst-");
  const a = join(src, "output-0.png");
  const b = join(src, "output-1.png");
  writeFileSync(a, "AAA");
  writeFileSync(b, "BBB");

  const template = join(dst, "{request_id}-{index}.{ext}");
  const { downloaded, failed } = placeCodexOutputs([a, b], template, "zz99");
  assert.equal(failed.length, 0);
  assert.deepEqual(downloaded, [join(dst, "zz99-0.png"), join(dst, "zz99-1.png")]);
  assert.equal(readFileSync(downloaded[0]!, "utf8"), "AAA");
  assert.equal(readFileSync(downloaded[1]!, "utf8"), "BBB");
});

test("placeCodexOutputs disambiguates colliding targets instead of overwriting", () => {
  const src = makeTmpDir(cleanups, "vg-codex-collide-src-");
  const dst = makeTmpDir(cleanups, "vg-codex-collide-dst-");
  const a = join(src, "output-0.png");
  const b = join(src, "output-1.png");
  writeFileSync(a, "AAA");
  writeFileSync(b, "BBB");

  // Template lacks {index}, so both outputs render to the same path.
  const template = join(dst, "{request_id}.{ext}");
  const { downloaded, failed } = placeCodexOutputs([a, b], template, "zz99");
  assert.equal(failed.length, 0);
  // Second file gets a `_1` suffix rather than clobbering the first.
  assert.deepEqual(downloaded, [join(dst, "zz99.png"), join(dst, "zz99_1.png")]);
  assert.equal(readFileSync(downloaded[0]!, "utf8"), "AAA");
  assert.equal(readFileSync(downloaded[1]!, "utf8"), "BBB");
});

test("placeCodexOutputs is a no-op copy when target equals source", () => {
  const dir = makeTmpDir(cleanups, "vg-codex-same-");
  mkdirSync(dir, { recursive: true });
  const cwd = process.cwd();
  process.chdir(dir);
  cleanups.push(() => process.chdir(cwd));
  const src = join(dir, "codex-image-abcd-0.png");
  writeFileSync(src, "X");
  // Default template resolves to exactly this path, so no copy happens
  // and no self-copy error is thrown.
  const { downloaded, failed } = placeCodexOutputs([src], undefined, "abcd");
  assert.equal(failed.length, 0);
  assert.deepEqual(downloaded, [src]);
});
