import { z } from "zod";

/** The largest GLB an asset procedure fetches, in bytes. */
export const MAX_ASSET_BYTES = 24 * 1024 * 1024;

/** The most clip files one merge-clips call takes. */
export const MAX_CLIPS = 16;

const modelUrl = z
  .url({ protocol: /^https$/u })
  .describe(
    "A GLB's URL: one generate returned (e.g. generate 3d's `model_glb`), one an asset procedure returned, or a local file put through generate upload",
  );

export const inspectInput = z.object({ model_url: modelUrl });

export const optimizeInput = z.object({
  compress: z
    .enum(["meshopt", "quantize", "none"])
    .default("meshopt")
    .describe(
      "`meshopt` (the default) quantizes and meshopt-compresses geometry and animation, which three.js's GLTFLoader decodes with `setMeshoptDecoder`; `quantize` only quantizes, needing no decoder; `none` keeps full-precision floats",
    ),
  height: z
    .number()
    .positive()
    .max(10_000)
    .optional()
    .describe("Scale uniformly so the model stands this tall in metres, e.g. 1.8 for a person"),
  model_url: modelUrl,
  origin: z
    .enum(["feet", "center"])
    .optional()
    .describe(
      "Move the pivot: `feet` centres the model on x/z with its base at y=0 (characters, props on the ground), `center` puts the bounding box's centre at the origin; omit to keep it",
    ),
  simplify_error: z
    .number()
    .min(0)
    .max(1)
    .default(0.01)
    .describe(
      "How far simplification may move the surface, as a fraction of the model's size; 0.01 (the default) keeps the silhouette, raise it if target_triangles is not reached",
    ),
  size: z
    .number()
    .positive()
    .max(10_000)
    .optional()
    .describe(
      "Scale uniformly so the model's longest side is this long in metres, e.g. 4.5 for a car; not with height",
    ),
  strip_meshes: z
    .boolean()
    .default(false)
    .describe(
      "Drop meshes, materials and textures and keep the skeleton and its animations, for a clip file played on a character loaded separately",
    ),
  target_triangles: z
    .number()
    .int()
    .min(16)
    .max(5_000_000)
    .optional()
    .describe(
      "Simplify to about this many triangles, e.g. 8000 for a prop or 25000 for a hero character; omit to keep the mesh",
    ),
  up_axis: z
    .enum(["y", "z"])
    .default("y")
    .describe("The model's up axis: `z` (some scans and CAD exports) is turned to glTF's y-up"),
  yaw_degrees: z
    .number()
    .min(-360)
    .max(360)
    .optional()
    .describe(
      "Turn the model about its up axis, e.g. -90 for a model that faces +x to face +z (glTF's forward)",
    ),
});

export const mergeClipsInput = z.object({
  clip_urls: z
    .array(modelUrl)
    .min(1)
    .max(MAX_CLIPS)
    .describe(
      "GLBs of the same rig, each holding one or more animations, e.g. animate-3d's per-clip GLBs; up to 16",
    ),
  keep_animations: z
    .boolean()
    .default(true)
    .describe("Keep the animations model_url already has; false keeps only the clips' animations"),
  model_url: modelUrl.describe(
    "The rigged character the clips play on, e.g. animate-3d's rigged GLB or one of its clip GLBs",
  ),
  names: z
    .array(z.string().min(1).max(64))
    .max(MAX_CLIPS)
    .optional()
    .describe(
      "A name for each clip, in clip_urls order, e.g. idle,run,attack; omitted, each clip keeps the name its file gives it",
    ),
});
