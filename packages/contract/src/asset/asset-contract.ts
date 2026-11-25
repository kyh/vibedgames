import { protectedBase, requiresScope } from "../base";
import { documented } from "../openapi";
import { z } from "zod";

import { inspectInput, optimizeInput } from "./asset-schema";
import { RECIPES, statusInput } from "./recipe-schema";
import type { RecipeName } from "./recipe-schema";

const vec3 = z.tuple([z.number(), z.number(), z.number()]);

/** What a GLB holds, as asset inspect reports it and the other asset procedures return. */
export const assetStats = z.object({
  animations: z
    .array(
      z.object({
        channels: z.number().int(),
        duration_seconds: z.number(),
        name: z.string(),
      }),
    )
    .describe("Each animation clip, by the name a loader finds it under"),
  bounds: z
    .object({ max: vec3, min: vec3, size: vec3 })
    .describe("The default scene's bounding box in metres, y up"),
  bytes: z.number().int().describe("The GLB's size in bytes"),
  extensions: z.array(z.string()).describe("The glTF extensions the file uses"),
  materials: z.number().int(),
  meshes: z.number().int(),
  skins: z
    .array(z.object({ joints: z.number().int(), name: z.string() }))
    .describe("Each skeleton and its joint count"),
  textures: z
    .array(
      z.object({
        bytes: z.number().int(),
        height: z.number().int().nullable(),
        mime: z.string(),
        name: z.string(),
        width: z.number().int().nullable(),
      }),
    )
    .describe("Each texture image, its pixel size and bytes"),
  triangles: z.number().int(),
  vertices: z.number().int(),
});

const processed = z.object({
  model_url: z.string().describe("The processed GLB's URL, to download or pass to the next step"),
  stats: assetStats,
});

const asset = (summary: string, description: string) =>
  protectedBase
    .meta(requiresScope("generate"))
    .meta(documented({ description, errors: [400, 412, 413, 502], summary }));

const free = "Runs on vibedgames' servers and is not billed.";

/** A hosted recipe job, as submitting it and asset status report it. */
export const recipeJob = z.object({
  cost_usd: z.number().nullable().describe("What the job billed, once it ended"),
  error: z.string().nullable().describe("Why the job failed"),
  job_id: z
    .string()
    .nullable()
    .describe("Follow the job with asset status; null when it finished within the call"),
  outputs: z
    .array(
      z.object({
        bytes: z.number().int(),
        content_type: z.string(),
        name: z.string(),
        url: z.string().describe("The file's URL, to download or pass to the next step"),
      }),
    )
    .describe("The files the recipe wrote, once done"),
  recipe: z.string(),
  result: z.json().nullable().describe("What the recipe measured or reports, once done"),
  seconds: z.number().nullable().describe("How long it ran"),
  status: z.enum(["queued", "running", "done", "failed"]),
});

const billed =
  "Runs in a vibedgames container and bills its compute time to credits (from $0.01). `vg asset` runs it on the caller's machine instead when the tool it needs is installed.";

const recipe = <N extends RecipeName>(name: N) => {
  const { description, title } = RECIPES[name];

  return asset(title, `${description} ${billed} Backs \`vg asset ${name}\`.`)
    .input(RECIPES[name].input)
    .output(recipeJob);
};

export const assetContract = {
  addAnimations: asset(
    RECIPES["add-animations"].title,
    `${RECIPES["add-animations"].description} Same-rig GLBs are merged in the call, free; any other clip runs in a vibedgames container billed by the second (from $0.01), or on the caller's machine when Blender is installed. Backs \`vg asset add-animations\`.`,
  )
    .input(RECIPES["add-animations"].input)
    .output(recipeJob),
  audioMaster: recipe("audio-master"),
  bake: recipe("bake"),
  fbxToGlb: recipe("fbx-to-glb"),
  framesToVideo: recipe("frames-to-video"),
  imageToThreejs: recipe("image-to-threejs"),
  inspect: asset(
    "Inspect a 3D model",
    `Reports what a GLB holds: triangles and vertices, its bounding box in metres, materials, each texture's pixel size and bytes, each skeleton's joints, each animation clip's name and length, and the extensions it uses. Use it before placing a generated model and after asset optimize to check the result. ${free} Backs \`vg asset inspect\`.`,
  )
    .input(inspectInput)
    .output(assetStats),

  optimize: asset(
    "Normalize, simplify and compress a 3D model",
    `Makes a GLB game-ready in one pass: turns a z-up model y-up and yaws it to face +z, scales it to a height or size in metres, moves its pivot to its feet or centre, simplifies it to a triangle budget, removes duplicate and unused data, and quantizes and meshopt-compresses it (\`compress\`). \`strip_meshes\` keeps only the skeleton and animations, for clip files. Textures pass through unchanged. ${free} Backs \`vg asset optimize\`.`,
  )
    .input(optimizeInput)
    .output(processed),

  render: recipe("render"),

  status: asset(
    "Follow an asset recipe job",
    "Reports a recipe job's state, and once it is done its output files and result. Waits up to wait_seconds for it to end. Backs `vg asset status`.",
  )
    .input(statusInput)
    .output(recipeJob),

  textureCompress: recipe("texture-compress"),
  trailerRender: recipe("trailer-render"),
  videoProbe: recipe("video-probe"),
  videoToSheet: recipe("video-to-sheet"),
};
