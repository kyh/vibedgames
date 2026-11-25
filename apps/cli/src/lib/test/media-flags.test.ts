import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, test } from "node:test";
import { imageToThreejsInput } from "@repo/contract/asset/recipe-schema";
import { animate3dInput, imageInput, videoInput } from "@repo/contract/generate/media-schema";

import { mediaFlagArgs, readMediaInput } from "../media-flags.js";
import { makeCleanups, makeTmpDir } from "../../../test/_helpers.js";

const { cleanups, drain } = makeCleanups();

afterEach(drain);

const noUpload = () => Promise.reject(new Error("nothing here is a local file"));

test("offers one flag per typed field, not the model's catch-all or the wait", () => {
  const args = mediaFlagArgs(imageInput.shape);

  assert.deepEqual(Object.keys(args).toSorted(), [
    "background",
    "image_size",
    "image_urls",
    "num_images",
    "prompt",
    "quality",
  ]);
  assert.equal(args.prompt?.type, "string");
  assert.match(args.image_urls?.description ?? "", /comma-separate.*local path is uploaded/u);
});

test("coerces each flag to its field's type", async () => {
  const input = await readMediaInput(
    videoInput.shape,
    ["--prompt", "42", "--duration", "5", "--generate_audio", "false", "--options", '{"seed":1}'],
    noUpload,
  );

  assert.deepEqual(input, {
    duration: "5",
    generate_audio: false,
    options: { seed: 1 },
    prompt: "42",
  });

  const clips = await readMediaInput(
    animate3dInput.shape,
    ["--animation_action_ids", "0,4", "--model_url", "https://media.example/a.glb"],
    noUpload,
  );

  assert.deepEqual(clips.animation_action_ids, [0, 4]);
});

test("uploads a local path given to a url field, and only there", async () => {
  const dir = makeTmpDir(cleanups);
  const file = path.join(dir, "ref.png");
  writeFileSync(file, "png");
  const uploaded: string[] = [];

  const input = await readMediaInput(
    imageInput.shape,
    ["--image_urls", file, "--image_urls", "https://media.example/b.png", "--prompt", file],
    (local) => {
      uploaded.push(local.filename);

      return Promise.resolve("https://media.example/ref.png");
    },
  );

  assert.deepEqual(uploaded, ["ref.png"]);
  assert.deepEqual(input.image_urls, [
    "https://media.example/ref.png",
    "https://media.example/b.png",
  ]);
  assert.equal(input.prompt, file);
});

test("uploads each local path in a url map, keeping its key", async () => {
  const dir = makeTmpDir(cleanups);
  const file = path.join(dir, "crate.jpg");
  writeFileSync(file, "jpg");

  const input = await readMediaInput(
    imageToThreejsInput.shape,
    [
      "--script",
      "probe_image.py",
      "--file_urls",
      JSON.stringify({ "ref/crate.jpg": file, "spec.json": "https://media.example/spec.json" }),
    ],
    () => Promise.resolve("https://media.example/crate.jpg"),
  );

  assert.deepEqual(input.file_urls, {
    "ref/crate.jpg": "https://media.example/crate.jpg",
    "spec.json": "https://media.example/spec.json",
  });
});

test("reads --no-<flag> as false for a boolean field", async () => {
  const input = await readMediaInput(
    videoInput.shape,
    ["--prompt", "a run", "--no-generate_audio"],
    noUpload,
  );

  assert.equal(input.generate_audio, false);
});

test("names a url field's missing file rather than passing it on as a bad URL", async () => {
  await assert.rejects(
    readMediaInput(imageInput.shape, ["--image_urls", "./nope.png", "--prompt", "x"], noUpload),
    /--image_urls: no file at \.\/nope\.png/u,
  );
});
