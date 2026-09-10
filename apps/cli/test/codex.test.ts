import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, test } from "node:test";

import {
  buildCodexPrompt,
  CodexError,
  parseCodexInput,
  placeCodexOutputs,
  renderLocalTarget,
  chooseProvider,
  findCodexBinary,
  isOpenAiImageEndpoint,
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
  assert.equal(resolveProvider(), "vibedgames");

  const prev = process.env.VG_GENERATE_PROVIDER;
  process.env.VG_GENERATE_PROVIDER = "codex";
  cleanups.push(() => {
    if (prev === undefined) {
      delete process.env.VG_GENERATE_PROVIDER;
    } else {
      process.env.VG_GENERATE_PROVIDER = prev;
    }
  });
  // Explicit flag wins over env; env is the fallback.
  assert.equal(resolveProvider(), "codex");
  assert.equal(resolveProvider("vibedgames"), "vibedgames");

  assert.throws(() => resolveProvider("coddex"), /Unknown --provider/u);
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

test("chooseProvider: OpenAI image endpoints auto-route to an installed codex", () => {
  const prev = process.env.VG_GENERATE_PROVIDER;
  delete process.env.VG_GENERATE_PROVIDER;
  cleanups.push(() => {
    if (prev !== undefined) {
      process.env.VG_GENERATE_PROVIDER = prev;
    }
  });
  const base = { async: false, codexInstalled: true, input: { prompt: "a fox" } };

  assert.deepEqual(
    chooseProvider(undefined, {
      ...base,
      endpointId: "openai/gpt-image-2.5/sunburst/text-to-image",
    }),
    { auto: true, provider: "codex" },
  );
  assert.deepEqual(chooseProvider(undefined, { ...base, endpointId: "codex" }), {
    auto: true,
    provider: "codex",
  });
  // Only the OpenAI image family: codex cannot run Flux, video or audio.
  assert.deepEqual(chooseProvider(undefined, { ...base, endpointId: "fal-ai/flux/dev" }), {
    auto: false,
    provider: "vibedgames",
  });
  assert.deepEqual(
    chooseProvider(undefined, { ...base, endpointId: "openai/sora-2/text-to-video" }),
    {
      auto: false,
      provider: "vibedgames",
    },
  );
  // Codex is synchronous and attaches local files only.
  const openai = { ...base, endpointId: "openai/gpt-image-2.5/sunburst/edit" };
  assert.equal(chooseProvider(undefined, { ...openai, async: true }).provider, "vibedgames");
  assert.equal(
    chooseProvider(undefined, {
      ...openai,
      input: { image_url: "https://example.com/ref.png", prompt: "edit" },
    }).provider,
    "vibedgames",
  );
  assert.equal(
    chooseProvider(undefined, { ...openai, input: { image_url: "./ref.png", prompt: "edit" } })
      .provider,
    "codex",
  );
  // No codex on this machine: nothing changes.
  assert.deepEqual(chooseProvider(undefined, { ...openai, codexInstalled: false }), {
    auto: false,
    provider: "vibedgames",
  });
  // A named provider always wins, in either direction.
  assert.deepEqual(chooseProvider("vibedgames", openai), { auto: false, provider: "vibedgames" });
  assert.deepEqual(chooseProvider("codex", { ...base, endpointId: "fal-ai/flux/dev" }), {
    auto: false,
    provider: "codex",
  });
  process.env.VG_GENERATE_PROVIDER = "fal";
  assert.deepEqual(chooseProvider(undefined, openai), { auto: false, provider: "vibedgames" });
});

test("isOpenAiImageEndpoint matches the gpt-image family only", () => {
  assert.equal(isOpenAiImageEndpoint("openai/gpt-image-2.5/sunburst/text-to-image"), true);
  assert.equal(isOpenAiImageEndpoint("openai/gpt-image-2/edit"), true);
  assert.equal(isOpenAiImageEndpoint("OpenAI/GPT-Image-1"), true);
  assert.equal(isOpenAiImageEndpoint("codex"), true);
  assert.equal(isOpenAiImageEndpoint("openai/sora-2"), false);
  assert.equal(isOpenAiImageEndpoint("fal-ai/gpt-image-lookalike"), false);
});

test("findCodexBinary: VG_CODEX_BIN, then PATH, else null", () => {
  const dir = makeTmpDir(cleanups);
  const bin = path.join(dir, "codex");
  writeFileSync(bin, "#!/bin/sh\n");
  assert.equal(
    findCodexBinary({ PATH: `${path.join(dir, "missing")}${path.delimiter}${dir}` }),
    bin,
  );
  assert.equal(findCodexBinary({ PATH: path.join(dir, "missing") }), null);
  assert.equal(findCodexBinary({ PATH: dir, VG_CODEX_BIN: bin }), bin);
  assert.equal(findCodexBinary({ PATH: dir, VG_CODEX_BIN: path.join(dir, "nope") }), null);
  assert.equal(findCodexBinary({}), null);
});
