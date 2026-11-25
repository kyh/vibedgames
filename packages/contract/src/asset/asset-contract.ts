import { protectedBase, requiresScope } from "../base";
import { documented } from "../openapi";
import { z } from "zod";

import { inspectInput, MAX_CLIPS, mergeClipsInput, optimizeInput } from "./asset-schema";

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

export const assetContract = {
  inspect: asset(
    "Inspect a 3D model",
    `Reports what a GLB holds: triangles and vertices, its bounding box in metres, materials, each texture's pixel size and bytes, each skeleton's joints, each animation clip's name and length, and the extensions it uses. Use it before placing a generated model and after asset optimize to check the result. ${free} Backs \`vg asset inspect\`.`,
  )
    .input(inspectInput)
    .output(assetStats),

  mergeClips: asset(
    "Merge animation clips into one model",
    `Copies the animations of up to ${MAX_CLIPS} GLBs of the same rig onto one rigged model, matching joints by name, so a game loads one GLB with every clip instead of one mesh per clip; animate-3d returns one GLB per clip. A clip whose joints mostly do not match the model's is refused: retargeting across different skeletons is not done here. ${free} Backs \`vg asset merge-clips\`.`,
  )
    .input(mergeClipsInput)
    .output(processed.extend({ skipped_channels: z.number().int() })),

  optimize: asset(
    "Normalize, simplify and compress a 3D model",
    `Makes a GLB game-ready in one pass: turns a z-up model y-up and yaws it to face +z, scales it to a height or size in metres, moves its pivot to its feet or centre, simplifies it to a triangle budget, removes duplicate and unused data, and quantizes and meshopt-compresses it (\`compress\`). \`strip_meshes\` keeps only the skeleton and animations, for clip files. Textures pass through unchanged. ${free} Backs \`vg asset optimize\`.`,
  )
    .input(optimizeInput)
    .output(processed),
};
