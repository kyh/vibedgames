import { z } from "zod";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { RecipeName } from "@repo/contract/asset/recipe-schema";
import { fileFields, RECIPES } from "@repo/contract/asset/recipe-schema";

import type { RecipeContext, RecipeFiles, RecipeOutcome, JsonValue } from "./recipe";
import type { Tools } from "./tools";
import { runBlender } from "./blender/run";
import { exec } from "./exec";
import { audioMaster } from "./ffmpeg/audio-master";
import { framesToVideo } from "./ffmpeg/frames-to-video";
import { textureCompress } from "./ffmpeg/texture-compress";
import { trailerRender } from "./ffmpeg/trailer-render";
import { videoProbe } from "./ffmpeg/video-probe";
import { videoToSheet } from "./ffmpeg/video-to-sheet";
import { imageToThreejs } from "./img2threejs";
import { collectOutputs, ensureDir, RecipeError, snapshotFiles } from "./recipe";
import { findTools } from "./tools";

export { exec, RecipeCommandError } from "./exec";

export type { JsonValue, RecipeFiles, RecipeOutcome, RecipeOutput } from "./recipe";

export { contentTypeOf, RecipeError } from "./recipe";

export type { Tools } from "./tools";

export { findTools, hasTools, which } from "./tools";

type Handler = (ctx: RecipeContext<never>) => Promise<RecipeOutcome>;

const HANDLERS: Record<RecipeName, Handler> = {
  "audio-master": audioMaster,
  bake: (ctx) => runBlender(ctx, "bake"),
  "fbx-to-glb": (ctx) => runBlender(ctx, "fbx-to-glb"),
  "frames-to-video": framesToVideo,
  "image-to-threejs": imageToThreejs,
  render: (ctx) => runBlender(ctx, "render"),
  retarget: (ctx) => runBlender(ctx, "retarget"),
  "texture-compress": textureCompress,
  "trailer-render": trailerRender,
  "video-probe": videoProbe,
  "video-to-sheet": videoToSheet,
};

/** The schema a recipe's non-file parameters are checked against, wherever it runs. */
export const paramsSchema = (name: RecipeName) => {
  const skip = new Set([...fileFields(name), "wait_seconds"]);
  const fields: Record<string, z.ZodType> = RECIPES[name].input.shape;

  return z.object(Object.fromEntries(Object.entries(fields).filter(([key]) => !skip.has(key))));
};

export interface RunRecipeOptions {
  /** The recipe's input without its file fields; defaults are applied here. */
  params: Readonly<Record<string, JsonValue>>;
  /** Each file field as a local path (a list for `_urls`, a map for `file_urls`). */
  files: RecipeFiles;
  /** Where outputs land; a temporary folder by default. */
  out?: string;
  tools?: Tools;
  signal?: AbortSignal;
}

/** Runs a recipe on this machine with the given tools, and lists the files it wrote. */
export const runRecipe = async (name: RecipeName, options: RunRecipeOptions) => {
  const parsed = paramsSchema(name).safeParse(options.params);

  if (!parsed.success) {
    throw new RecipeError(
      parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
    );
  }

  const work = mkdtempSync(path.join(tmpdir(), `vg-${name}-`));
  const out = ensureDir(options.out ?? path.join(work, "out"));
  const scratch = ensureDir(path.join(work, "work"));
  const { signal } = options;
  const before = snapshotFiles(out);

  try {
    const outcome = await HANDLERS[name]({
      files: options.files,
      name,
      out,
      params: parsed.data as never,
      run: (program, args, runOptions) => exec(program, args, { signal, ...runOptions }),
      signal,
      tools: options.tools ?? findTools(),
      work: scratch,
    });

    return { outputs: collectOutputs(out, before), result: outcome.result };
  } finally {
    rmSync(scratch, { force: true, recursive: true });
  }
};
