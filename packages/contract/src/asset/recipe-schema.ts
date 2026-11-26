import { z } from "zod";

import { MAX_WAIT_SECONDS } from "../generate/generate-schema";
import { MAX_CLIPS } from "./asset-schema";

/** The two container images recipes run in, and the instance each gets. */
export const RECIPE_IMAGES = {
  blender: { instance: "standard-3", microUsdPerSecond: 122 },
  tools: { instance: "standard-2", microUsdPerSecond: 72 },
} as const;

export type RecipeImage = keyof typeof RECIPE_IMAGES;

/** The local programs a recipe needs to run on the caller's machine instead. */
export type RecipeTool = "blender" | "ffmpeg" | "gltf-transform" | "img2threejs";

/** The cheapest a hosted recipe job bills, in micro-USD. */
export const RECIPE_FLOOR_MICRO = 10_000;

/** The largest input file a hosted recipe reads, and the largest output it returns, in bytes. */
export const MAX_RECIPE_INPUT_BYTES = 200 * 1024 * 1024;
export const MAX_RECIPE_OUTPUT_BYTES = 64 * 1024 * 1024;

const mediaUrl = (what: string) =>
  z
    .url({ protocol: /^https$/u })
    .describe(
      `${what}: a URL generate or another asset step returned, or a local file put through generate upload`,
    );

const waitSeconds = z
  .number()
  .int()
  .min(0)
  .max(MAX_WAIT_SECONDS)
  .default(20)
  .describe("How long to wait for the job before returning its id to follow with asset status");

const lufs = (fallback: number) =>
  z
    .number()
    .min(-40)
    .max(-5)
    .default(fallback)
    .describe(`Integrated loudness to normalise to, in LUFS; ${fallback} by default`);

const truePeak = z
  .number()
  .min(-9)
  .max(0)
  .default(-1)
  .describe("Ceiling for the true peak in dBTP; -1 by default");

const crf = z
  .number()
  .int()
  .min(0)
  .max(51)
  .default(18)
  .describe("H.264 quality, lower is better and bigger; 18 by default");

export const framesToVideoInput = z.object({
  audio_url: mediaUrl("An audio track to mux under the video, cut to its length").optional(),
  crf,
  fps: z.number().int().min(1).max(120).default(60).describe("Frames per second; 60 by default"),
  frames_url: mediaUrl(
    "A .tar of PNG or JPEG frames, played in file-name order (a local folder is packed for you)",
  ),
  wait_seconds: waitSeconds,
});

export const videoProbeInput = z.object({
  frames: z
    .array(z.number().int().min(0))
    .max(16)
    .default([])
    .describe("Frame indices to export as PNG stills, e.g. 0,120,240; up to 16"),
  scene_threshold: z
    .number()
    .min(0.01)
    .max(1)
    .default(0.3)
    .describe("How different a frame must be to count as a cut, 0 to 1; 0.3 by default"),
  silence_db: z
    .number()
    .min(-90)
    .max(0)
    .default(-50)
    .describe("Audio below this level in dB counts as silence; -50 by default"),
  silence_min_seconds: z
    .number()
    .min(0.05)
    .max(10)
    .default(0.3)
    .describe("Shortest silence reported, in seconds; 0.3 by default"),
  video_url: mediaUrl("The video to probe"),
  wait_seconds: waitSeconds,
});

export const audioMasterInput = z.object({
  audio_url: mediaUrl("The take to master"),
  fade_in_ms: z.number().int().min(0).max(5000).default(0).describe("Fade-in length in ms"),
  fade_out_ms: z
    .number()
    .int()
    .min(0)
    .max(5000)
    .default(10)
    .describe("Fade-out length in ms; 10 by default, which removes an end click"),
  format: z
    .enum(["ogg", "mp3", "m4a", "wav"])
    .default("ogg")
    .describe("Output codec: `ogg` (Opus, the default), `mp3`, `m4a` (AAC) or `wav`"),
  lufs: lufs(-16),
  mono: z.boolean().default(false).describe("Fold to mono, for one-shot SFX"),
  name: z
    .string()
    .regex(/^[\w-]{1,64}$/u)
    .default("audio")
    .describe("Output file name without its extension; `audio` by default"),
  trim_db: z
    .number()
    .min(-90)
    .max(0)
    .default(-60)
    .describe("Trim leading and trailing audio quieter than this, in dB; -60 by default"),
  true_peak: truePeak,
  wait_seconds: waitSeconds,
});

export const videoToSheetInput = z.object({
  cell_width: z
    .number()
    .int()
    .min(16)
    .max(1024)
    .default(256)
    .describe("Each frame's width in the sheet in px, height kept in proportion; 256 by default"),
  columns: z.number().int().min(1).max(32).default(8).describe("Frames per row; 8 by default"),
  end_seconds: z
    .number()
    .min(0)
    .optional()
    .describe("Where to stop; the end of the video if omitted"),
  fps: z.number().min(1).max(60).default(12).describe("Frames sampled per second; 12 by default"),
  max_frames: z
    .number()
    .int()
    .min(1)
    .max(256)
    .default(64)
    .describe("Most frames in the sheet; 64 by default"),
  start_seconds: z.number().min(0).default(0).describe("Where to start, in seconds"),
  video_url: mediaUrl("The video to sample, e.g. an animation generate video returned"),
  wait_seconds: waitSeconds,
});

export const trailerClip = z.object({
  in_seconds: z.number().min(0).describe("Where the clip starts in its video"),
  out_seconds: z.number().min(0).describe("Where the clip ends in its video"),
  video: z.number().int().min(0).describe("Index into video_urls"),
});

export const trailerRenderInput = z.object({
  clips: z
    .array(trailerClip)
    .min(1)
    .max(64)
    .describe('The edit, in order, as JSON: [{"video":0,"in_seconds":1.5,"out_seconds":3}, …]'),
  crf,
  crossfade_seconds: z
    .number()
    .min(0)
    .max(2)
    .default(0)
    .describe("Crossfade between consecutive clips; 0 (hard cuts) by default"),
  fps: z.number().int().min(12).max(120).default(60).describe("Output frame rate; 60 by default"),
  height: z.number().int().min(144).max(2160).default(1080).describe("Output height in px"),
  keep_clip_audio: z
    .boolean()
    .default(false)
    .describe("Keep each clip's own audio under the music; dropped by default"),
  lufs: lufs(-14),
  lut_url: mediaUrl("A .cube colour LUT to grade every clip with").optional(),
  music_gain_db: z
    .number()
    .min(-30)
    .max(6)
    .default(0)
    .describe("Music level against the clip audio, in dB"),
  music_url: mediaUrl("The music bed, cut to the edit's length").optional(),
  true_peak: truePeak,
  video_urls: z.array(mediaUrl("A source video")).min(1).max(32).describe("The source videos"),
  wait_seconds: waitSeconds,
  width: z.number().int().min(256).max(3840).default(1920).describe("Output width in px"),
});

export const fbxToGlbInput = z.object({
  model_url: mediaUrl("An FBX or OBJ model, e.g. from a motion or 3D generator"),
  wait_seconds: waitSeconds,
});

export const addAnimationsInput = z.object({
  animation_urls: z
    .array(
      mediaUrl(
        "A GLB or FBX holding an animation, on the model's rig or any other humanoid skeleton (Mixamo, SMPL, UE5, Meshy)",
      ),
    )
    .min(1)
    .max(MAX_CLIPS)
    .describe(`The animations to add, up to ${MAX_CLIPS}`),
  in_place: z
    .boolean()
    .default(false)
    .describe(
      "Drop the root's horizontal travel when retargeting, for a clip the game moves itself",
    ),
  keep_animations: z
    .boolean()
    .default(true)
    .describe("Keep the animations model_url already has; false keeps only the added ones"),
  model_url: mediaUrl("The rigged character GLB the animations should play on"),
  names: z
    .array(z.string().min(1).max(64))
    .max(MAX_CLIPS)
    .optional()
    .describe("A name per animation, in order; each file's own animation name if omitted"),
  wait_seconds: waitSeconds,
});

export const textureCompressInput = z.object({
  format: z
    .enum(["webp", "ktx2", "png", "jpeg"])
    .default("webp")
    .describe(
      "`webp` (the default, small on disk), `ktx2` (Basis, small in GPU memory, needs KTX2Loader), `png` or `jpeg`",
    ),
  max_size: z
    .number()
    .int()
    .min(16)
    .max(8192)
    .default(1024)
    .describe("Resize every texture to fit within this many px; 1024 by default"),
  model_url: mediaUrl("The GLB whose textures to resize and recompress"),
  quality: z.number().int().min(1).max(100).default(85).describe("Lossy quality; 85 by default"),
  wait_seconds: waitSeconds,
});

export const bakeInput = z.object({
  extrusion: z
    .number()
    .min(0)
    .max(1)
    .default(0.02)
    .describe("How far the bake cage reaches past the low-poly surface, in metres"),
  high_url: mediaUrl("The detailed source model GLB"),
  low_url: mediaUrl("The game-ready GLB the maps are baked onto; it needs UVs"),
  maps: z
    .array(z.enum(["normal", "ao"]))
    .min(1)
    .default(["normal"])
    .describe("Maps to bake: `normal` (the default) and `ao`"),
  size: z
    .number()
    .int()
    .min(128)
    .max(4096)
    .default(1024)
    .describe("Map size in px; 1024 by default"),
  wait_seconds: waitSeconds,
});

export const renderInput = z.object({
  engine: z
    .enum(["cycles", "workbench"])
    .default("cycles")
    .describe("`cycles` (lit, the default) or `workbench` (flat, fast, for silhouettes)"),
  frames: z
    .number()
    .int()
    .min(1)
    .max(240)
    .default(1)
    .describe("1 renders a still; more renders a turntable video of that many frames"),
  model_url: mediaUrl("The GLB to render"),
  samples: z.number().int().min(1).max(256).default(32).describe("Cycles samples; 32 by default"),
  size: z.number().int().min(64).max(2048).default(768).describe("Square image size in px"),
  transparent: z.boolean().default(true).describe("Transparent background for stills"),
  view: z
    .enum(["front", "side", "back", "three-quarter", "top"])
    .default("three-quarter")
    .describe("Camera angle for a still, or the turntable's start"),
  wait_seconds: waitSeconds,
});

/** The upstream image-to-threejs scripts a hosted step may run, by file name. */
export const IMG2THREEJS_SCRIPTS = [
  "append_review.py",
  "analyze_texture.py",
  "build_detail_inventory.py",
  "check_part_coverage.py",
  "check_reference_admission.py",
  "diagnose_render.py",
  "extract_pbr_evidence.py",
  "generate_threejs_factory.py",
  "interior_difference.py",
  "make_comparison_sheet.py",
  "new_pre_spec_assessment.py",
  "new_sculpt_spec.py",
  "next.py",
  "orchestrate_passes.py",
  "probe_image.py",
  "swept_arc_gate.py",
  "turntable_gate.py",
  "validate_sculpt_spec.py",
] as const;

const workPath = z
  .string()
  .regex(/^(?!\.{1,2}(?:\/|$))[\w.-]+(?:\/(?!\.{1,2}(?:\/|$))[\w.-]+)*$/u)
  .max(200);

export const imageToThreejsInput = z.object({
  args: z
    .array(
      z
        .string()
        .max(1024)
        .refine((arg) => !arg.includes("\0")),
    )
    .max(64)
    .default([])
    .describe(
      'The script\'s arguments as JSON, paths relative to the run folder, e.g. ["spec.json","--strict-quality"]',
    ),
  file_urls: z
    .record(workPath, mediaUrl("A file to place in the run folder"))
    .default({})
    .describe(
      'Files to place in the run folder first, as JSON {"<path>": "<url>"}, e.g. {"ref/chest.jpg": "…", "spec.json": "…"}',
    ),
  script: z
    .enum(IMG2THREEJS_SCRIPTS)
    .describe("The image-to-threejs pipeline script to run, e.g. validate_sculpt_spec.py"),
  wait_seconds: waitSeconds,
});

export const statusInput = z.object({
  job_id: z.string().min(1).max(512).describe("The job id an asset recipe returned"),
  wait_seconds: waitSeconds,
});

interface RecipeDefinition {
  title: string;
  description: string;
  image: RecipeImage;
  capSeconds: number;
  tools: readonly RecipeTool[];
  input: z.ZodObject;
}

/** Every hosted recipe: the image it runs in, its hard time cap, the local tools that replace it. */
export const RECIPES = {
  "add-animations": {
    description:
      "Adds animations to a rigged character GLB. Clips of the same rig (e.g. one animate-3d run) are copied joint by joint; clips on another humanoid skeleton (Mixamo, SMPL, UE5, Meshy names, or a motion generator's FBX) are retargeted in Blender and baked. Returns the character with every animation in one file. Takes the clips `generate animate-3d` returns, or a motion generator's FBX; follow with `asset optimize`.",
    title: "Add animations to a character",
    capSeconds: 300,
    image: "blender",
    input: addAnimationsInput,
    tools: ["blender"],
  },
  "audio-master": {
    description:
      "Trims silence, fades the ends, normalises to a loudness target in two passes (integrated LUFS and true peak) and encodes Opus, MP3, AAC or WAV. Returns the input and output loudness. Run it on every take `generate sound`, `generate music` or `generate speech` returns before it ships, so one family plays at one level.",
    title: "Master an audio take",
    capSeconds: 30,
    image: "tools",
    input: audioMasterInput,
    tools: ["ffmpeg"],
  },
  bake: {
    description:
      "Bakes a normal map (and optionally ambient occlusion) from a high-poly GLB onto a low-poly GLB with UVs, in Blender, and returns the low-poly GLB with the maps applied. Keeps a detailed `generate 3d` mesh's surface on a simplified copy (`asset optimize --target_triangles`); follow with `asset texture-compress`.",
    title: "Bake maps from a detailed model onto a game-ready one",
    capSeconds: 300,
    image: "blender",
    input: bakeInput,
    tools: ["blender"],
  },
  "fbx-to-glb": {
    description:
      "Imports an FBX or OBJ in Blender, armature and animations included, and exports a GLB, for `asset inspect` and `asset optimize`. To put an FBX's animation on a character, give it to `asset add-animations` instead.",
    title: "Convert FBX or OBJ to GLB",
    capSeconds: 60,
    image: "blender",
    input: fbxToGlbInput,
    tools: ["blender"],
  },
  "frames-to-video": {
    description:
      "Encodes a tar of PNG or JPEG frames, in file-name order, as an H.264 MP4 at a fixed frame rate, with an optional audio track. For frame-stepped game captures (the trailer skill's capture hooks); its MP4 feeds `asset trailer-render`.",
    title: "Encode a frame sequence as video",
    capSeconds: 120,
    image: "tools",
    input: framesToVideoInput,
    tools: ["ffmpeg"],
  },
  "image-to-threejs": {
    description:
      "Runs one script of the image-to-threejs pipeline (pinned upstream version) on the files given, with the arguments given, and returns every file it wrote plus its output. The browser render step stays with the caller. The image-to-threejs skill gives the order of steps, starting from a `generate image` reference.",
    title: "Run an image-to-threejs pipeline step",
    capSeconds: 300,
    image: "blender",
    input: imageToThreejsInput,
    tools: ["img2threejs"],
  },
  render: {
    description:
      "Renders a GLB in Blender from a preset camera, as a PNG still or a turntable MP4, framed by its bounds: look at a generated or optimized model before placing it, or make a store or thumbnail shot.",
    title: "Render a 3D model",
    capSeconds: 300,
    image: "blender",
    input: renderInput,
    tools: ["blender"],
  },

  "texture-compress": {
    description:
      "Resizes every texture of a GLB to fit a size and recompresses it as WebP, KTX2 (Basis), PNG or JPEG. Use it when `asset inspect` shows textures carry the bytes, or a model is over `asset optimize`'s size limit; then `asset optimize`.",
    title: "Resize and recompress a model's textures",
    capSeconds: 120,
    image: "tools",
    input: textureCompressInput,
    tools: ["gltf-transform"],
  },
  "trailer-render": {
    description:
      "Cuts clips from source videos into one edit with optional crossfades and a colour LUT, scales to one size and frame rate, lays a music bed under it, normalises loudness, and encodes H.264. Clips come from game captures (`asset frames-to-video`) or `generate video`, the bed from `generate music`; `asset video-probe` finds the in and out points.",
    title: "Cut and mix a trailer",
    capSeconds: 300,
    image: "tools",
    input: trailerRenderInput,
    tools: ["ffmpeg"],
  },
  "video-probe": {
    description:
      "Reports a video's (or an audio file's) duration, frame rate, frame count and size, its scene cuts, silences, duplicated frames and loudness, and exports chosen frames by index as PNG. Check a `generate video` result or a capture with it before cutting a sheet or a trailer from it.",
    title: "Probe a video frame-accurately",
    capSeconds: 60,
    image: "tools",
    input: videoProbeInput,
    tools: ["ffmpeg"],
  },
  "video-to-sheet": {
    description:
      "Samples a video at a frame rate between two times and tiles the frames into one PNG sheet, with the cell size and count. Takes an animation or effect `generate video` made (on black for additive effects, or on a flat background to remove); load the sheet with the cell size it reports.",
    title: "Turn a video into a sprite sheet",
    capSeconds: 30,
    image: "tools",
    input: videoToSheetInput,
    tools: ["ffmpeg"],
  },
} as const satisfies Record<string, RecipeDefinition>;

export type RecipeName = keyof typeof RECIPES;

/** The asset procedure behind each recipe, the camelCase of its name. */
export const RECIPE_PROCEDURES = {
  "add-animations": "addAnimations",
  "audio-master": "audioMaster",
  bake: "bake",
  "fbx-to-glb": "fbxToGlb",
  "frames-to-video": "framesToVideo",
  "image-to-threejs": "imageToThreejs",
  render: "render",
  "texture-compress": "textureCompress",
  "trailer-render": "trailerRender",
  "video-probe": "videoProbe",
  "video-to-sheet": "videoToSheet",
} as const satisfies Record<RecipeName, string>;

export type RecipeInput<N extends RecipeName> = z.output<(typeof RECIPES)[N]["input"]>;

export const isRecipeName = (name: string): name is RecipeName => Object.hasOwn(RECIPES, name);

export const RECIPE_NAMES = Object.keys(RECIPES).filter(isRecipeName);

/** The input fields of a recipe that carry files, by the `_url`/`_urls` naming every recipe follows. */
export const fileFields = (name: RecipeName) =>
  Object.keys(RECIPES[name].input.shape).filter(
    (key) => key.endsWith("_url") || key.endsWith("_urls"),
  );

/** What a hosted job holds before it runs, at its time cap, clamped to $0.01–$1. */
export const recipeHoldMicro = (name: RecipeName) => {
  const recipe = RECIPES[name];
  const cost = recipe.capSeconds * RECIPE_IMAGES[recipe.image].microUsdPerSecond;

  return Math.min(1_000_000, Math.max(RECIPE_FLOOR_MICRO, cost));
};
