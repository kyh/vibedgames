import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, test } from "node:test";

import {
  buildCodexPrompt,
  codexExecArgs,
  CodexError,
  parseCodexInput,
  placeCodexOutputs,
  renderLocalTarget,
  chooseProvider,
  parseProvider,
} from "../src/lib/codex.js";
import { saveSetting } from "../src/lib/settings.js";
import { makeCleanups, makeTmpDir, stubEnv } from "./_helpers.js";

const { cleanups, drain } = makeCleanups();
afterEach(drain);

test("parseProvider: the two names, any case, and nothing else", () => {
  assert.equal(parseProvider("codex"), "codex");
  assert.equal(parseProvider(" Codex "), "codex");
  assert.equal(parseProvider("vibedgames"), "vibedgames");
  assert.throws(() => parseProvider("fal"), /Unknown provider "fal" \(--provider\)/u);
  assert.throws(() => parseProvider("x", "VG_GENERATE_PROVIDER"), /\(VG_GENERATE_PROVIDER\)/u);
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
    aspect_ratio: "16:9",
    image_url: "c.png",
    image_urls: ["a.png", "b.png"],
    num_images: 99,
    prompt: "  a fox  ",
    seed: 42,
  });
  assert.equal(parsed.prompt, "a fox");
  // clamped to MAX_IMAGES
  assert.equal(parsed.count, 8);
  assert.equal(parsed.sizeHint, "aspect ratio 16:9");
  assert.deepEqual(parsed.referenceCandidates, ["c.png", "a.png", "b.png"]);
});

test("parseCodexInput defaults count to 1 and falls back to text key", () => {
  const parsed = parseCodexInput({ height: 512, text: "hello", width: 512 });
  assert.equal(parsed.prompt, "hello");
  assert.equal(parsed.count, 1);
  assert.equal(parsed.sizeHint, "512x512px");
  assert.deepEqual(parsed.referenceCandidates, []);
});

test("buildCodexPrompt pins filenames and switches to edit wording with references", () => {
  const base = parseCodexInput({ num_images: 2, prompt: "a cat" });
  const gen = buildCodexPrompt(base, ["output-0.png", "output-1.png"], false);
  assert.match(gen, /Generate 2 images/u);
  assert.match(gen, /output-0\.png, output-1\.png/u);
  assert.match(gen, /\$imagegen/u);

  const edit = buildCodexPrompt(base, ["output-0.png"], true);
  assert.match(edit, /Edit the attached reference image/u);
});

test("renderLocalTarget: default naming, placeholders, directory, and literal file", () => {
  const cwd = process.cwd();
  assert.equal(
    renderLocalTarget(undefined, 0, "png", "abcd", 1),
    path.join(cwd, "codex-image-abcd-0.png"),
  );
  assert.equal(
    renderLocalTarget("out/{request_id}_{index}.{ext}", 2, "png", "abcd", 3),
    path.join(cwd, "out/abcd_2.png"),
  );
  // Bare directory.
  assert.equal(
    renderLocalTarget("shots", 1, "png", "abcd", 2),
    path.join(cwd, "shots/codex-image-1.png"),
  );
  // Literal file: index 0 keeps the name, later indices disambiguate.
  assert.equal(renderLocalTarget("hero.png", 0, "png", "abcd", 2), path.join(cwd, "hero.png"));
  assert.equal(renderLocalTarget("hero.png", 1, "png", "abcd", 2), path.join(cwd, "hero_1.png"));
});

test("placeCodexOutputs copies raw files to rendered targets", () => {
  const src = makeTmpDir(cleanups, "vg-codex-src-");
  const dst = makeTmpDir(cleanups, "vg-codex-dst-");
  const a = path.join(src, "output-0.png");
  const b = path.join(src, "output-1.png");
  writeFileSync(a, "AAA");
  writeFileSync(b, "BBB");

  const template = path.join(dst, "{request_id}-{index}.{ext}");
  const { downloaded, failed } = placeCodexOutputs([a, b], template, "zz99");
  assert.equal(failed.length, 0);
  assert.deepEqual(downloaded, [path.join(dst, "zz99-0.png"), path.join(dst, "zz99-1.png")]);
  const [first, second] = downloaded;
  assert.ok(first && second);
  assert.equal(readFileSync(first, "utf-8"), "AAA");
  assert.equal(readFileSync(second, "utf-8"), "BBB");
});

test("placeCodexOutputs disambiguates colliding targets instead of overwriting", () => {
  const src = makeTmpDir(cleanups, "vg-codex-collide-src-");
  const dst = makeTmpDir(cleanups, "vg-codex-collide-dst-");
  const a = path.join(src, "output-0.png");
  const b = path.join(src, "output-1.png");
  writeFileSync(a, "AAA");
  writeFileSync(b, "BBB");

  // Template lacks {index}, so both outputs render to the same path.
  const template = path.join(dst, "{request_id}.{ext}");
  const { downloaded, failed } = placeCodexOutputs([a, b], template, "zz99");
  assert.equal(failed.length, 0);
  // Second file gets a `_1` suffix rather than clobbering the first.
  assert.deepEqual(downloaded, [path.join(dst, "zz99.png"), path.join(dst, "zz99_1.png")]);
  const [first, second] = downloaded;
  assert.ok(first && second);
  assert.equal(readFileSync(first, "utf-8"), "AAA");
  assert.equal(readFileSync(second, "utf-8"), "BBB");
});

test("placeCodexOutputs is a no-op copy when target equals source", () => {
  const dir = makeTmpDir(cleanups, "vg-codex-same-");
  mkdirSync(dir, { recursive: true });
  const cwd = process.cwd();
  process.chdir(dir);
  cleanups.push(() => process.chdir(cwd));
  const src = path.join(dir, "codex-image-abcd-0.png");
  writeFileSync(src, "X");
  // Default template resolves to exactly this path, so no copy happens
  // and no self-copy error is thrown.
  const { downloaded, failed } = placeCodexOutputs([src], undefined, "abcd");
  assert.equal(failed.length, 0);
  assert.deepEqual(downloaded, [src]);
});

const run = (endpointId: string, input = {}, isAsync = false) => ({
  async: isAsync,
  endpointId,
  input: { prompt: "a fox", ...input },
});

const OPENAI_IMAGE = "openai/gpt-image-2.5/sunburst/text-to-image";

test("chooseProvider: with no preference, only the codex endpoint runs on codex", () => {
  stubEnv(cleanups, { VG_GENERATE_PROVIDER: undefined, XDG_CONFIG_HOME: makeTmpDir(cleanups) });

  assert.deepEqual(chooseProvider(undefined, run(OPENAI_IMAGE)), { provider: "vibedgames" });
  assert.deepEqual(chooseProvider(undefined, run("fal-ai/flux/dev")), { provider: "vibedgames" });
  assert.deepEqual(chooseProvider(undefined, run("codex")), { provider: "codex" });
  // --provider decides outright, for any endpoint, in either direction.
  assert.equal(chooseProvider("codex", run("fal-ai/flux/dev")).provider, "codex");
  assert.equal(chooseProvider("vibedgames", run("codex")).provider, "vibedgames");
  assert.throws(() => chooseProvider("coddex", run("codex")), /Unknown provider/u);
});

test("chooseProvider: a saved codex preference serves only the OpenAI image runs codex can", () => {
  stubEnv(cleanups, { VG_GENERATE_PROVIDER: undefined, XDG_CONFIG_HOME: makeTmpDir(cleanups) });
  saveSetting("generate.provider", "codex");

  assert.deepEqual(chooseProvider(undefined, run(OPENAI_IMAGE)), { provider: "codex" });
  assert.equal(
    chooseProvider(undefined, run("openai/gpt-image-2/edit", { image_url: "./ref.png" })).provider,
    "codex",
  );
  // Codex can't run Flux, video or audio: those stay on vibedgames, silently.
  assert.deepEqual(chooseProvider(undefined, run("fal-ai/flux/dev")), { provider: "vibedgames" });
  assert.deepEqual(chooseProvider(undefined, run("fal-ai/kling-video/v2/text-to-video")), {
    provider: "vibedgames",
  });
  // An OpenAI image run codex can't honour stays on vibedgames, and says why.
  const asyncRun = chooseProvider(undefined, run(OPENAI_IMAGE, {}, true));
  assert.equal(asyncRun.provider, "vibedgames");
  assert.match(asyncRun.note ?? "", /generate\.provider is codex, but codex can't run --async/u);
  const urlRef = chooseProvider(
    undefined,
    run(OPENAI_IMAGE, { image_url: "https://x.test/a.png" }),
  );
  assert.equal(urlRef.provider, "vibedgames");
  assert.match(urlRef.note ?? "", /local reference files/u);
  // --provider still decides one run.
  assert.equal(chooseProvider("vibedgames", run(OPENAI_IMAGE)).provider, "vibedgames");
});

test("chooseProvider: VG_GENERATE_PROVIDER wins over the saved preference", () => {
  stubEnv(cleanups, { VG_GENERATE_PROVIDER: "vibedgames", XDG_CONFIG_HOME: makeTmpDir(cleanups) });
  saveSetting("generate.provider", "codex");
  assert.equal(chooseProvider(undefined, run(OPENAI_IMAGE)).provider, "vibedgames");

  stubEnv(cleanups, { VG_GENERATE_PROVIDER: "codex" });
  const note = chooseProvider(undefined, run(OPENAI_IMAGE, {}, true)).note ?? "";
  assert.match(note, /^VG_GENERATE_PROVIDER is codex/u);

  stubEnv(cleanups, { VG_GENERATE_PROVIDER: "coddex" });
  assert.throws(() => chooseProvider(undefined, run(OPENAI_IMAGE)), /\(VG_GENERATE_PROVIDER\)/u);
});

test("codexExecArgs: the prompt survives a variadic -i by sitting behind --", () => {
  const args = codexExecArgs("/tmp/w", ["/a.png", "/b.png"], "make it stormy");
  assert.deepEqual(args.slice(-6), ["-i", "/a.png", "-i", "/b.png", "--", "make it stormy"]);
  assert.deepEqual(codexExecArgs("/tmp/w", [], "a fox").slice(-2), ["--", "a fox"]);
});

test("buildCodexPrompt: a size is a target Codex must not stop to resize for", () => {
  const prompt = buildCodexPrompt(
    parseCodexInput({ height: 864, prompt: "a cover", width: 1536 }),
    ["output-0.png"],
    false,
  );
  assert.match(prompt, /aim for .*1536/u);
  assert.match(prompt, /never resize, crop or ask/u);
});
