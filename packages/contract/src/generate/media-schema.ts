import { z } from "zod";

import { runInput } from "./generate-schema";

/**
 * The default model the model-catalog skill names for each kind of asset,
 * which that asset's procedure runs: text first, then from an image.
 */
export const MEDIA_MODELS = {
  animate3d: ["meshy/rigging/multi-animation"],
  image: ["openai/gpt-image-2.5/flare/text-to-image", "openai/gpt-image-2.5/flare/edit"],
  model3d: ["meshy/v7.1/text-to-3d", "meshy/v7.1/image-to-3d"],
  music: ["elevenlabs/music/v2.5"],
  removeBackground: ["bria/guided-remove-background"],
  sound: ["fal-ai/elevenlabs/sound-effects/v2"],
  speech: ["elevenlabs/tts/eleven-v4"],
  video: ["bytedance/seedance-2.5/us/text-to-video", "bytedance/seedance-2.5/us/image-to-video"],
} as const;

const options = z
  .record(z.string(), z.json())
  .default({})
  .describe(
    "Any other input the model takes, per generate schema of its endpoint; the fields above win",
  );

const prompt = z.string().min(1).max(5000);

const imageUrl = z.url().describe("An image's URL, e.g. from generate upload");

const waitSeconds = runInput.shape.wait_seconds;

export const animate3dInput = z.object({
  animation_action_ids: z
    .array(z.number().int().min(0).max(696))
    .min(1)
    .max(10)
    .describe("Up to 10 clips from Meshy's animation library, one GLB each, e.g. 0 for Idle"),
  height_meters: z
    .number()
    .positive()
    .max(100)
    .optional()
    .describe("The character's height, 1.7 by default"),
  model_url: z.url().describe("The character's GLB, e.g. generate 3d's model_glb"),
  options,
  wait_seconds: waitSeconds,
});

export const imageInput = z.object({
  background: z
    .enum(["auto", "transparent", "opaque"])
    .optional()
    .describe(
      "`transparent` leaves no background, for sprites and props; `opaque` always fills one; `auto` lets the model choose. Omit for the model's default",
    ),
  image_size: z
    .enum([
      "auto",
      "square_hd",
      "square",
      "portrait_4_3",
      "portrait_16_9",
      "landscape_4_3",
      "landscape_16_9",
    ])
    .optional()
    .describe("A preset; pass `{width, height}` through options for an exact size"),
  image_urls: z.array(imageUrl).min(1).max(16).optional().describe("Images to edit or combine"),
  num_images: z
    .number()
    .int()
    .min(1)
    .max(4)
    .optional()
    .describe("How many images to make from the one prompt, 1 to 4; omit for the model's default"),
  options,
  prompt: prompt.describe(
    "What to draw, or with image_urls how to edit or combine them, up to 5,000 characters, e.g. `pixel-art knight sprite, side view`",
  ),
  quality: z
    .enum(["auto", "low", "medium", "high", "xhigh", "max"])
    .optional()
    .describe(
      "Rendering quality from `low` (quick drafts) to `max`; higher takes longer and may cost more (see generate pricing). `auto` lets the model choose; omit for the model's default",
    ),
  wait_seconds: waitSeconds,
});

export const model3dInput = z.object({
  image_url: imageUrl.optional(),
  options,
  pose_mode: z
    .enum(["a-pose", "t-pose"])
    .optional()
    .describe("Model a character in this pose, which rigs cleanly in animate-3d"),
  prompt: prompt.max(600).optional().describe("What to model; needed without image_url"),
  target_polycount: z
    .number()
    .int()
    .min(100)
    .max(300_000)
    .optional()
    .describe(
      "The mesh's polygon budget, 100 to 300,000; the model's default is 30,000. Games suit 5,000 to 15,000 for a prop, 15,000 to 40,000 for a hero character",
    ),
  topology: z
    .enum(["quad", "triangle"])
    .optional()
    .describe(
      "The mesh's faces: `triangle` (the model's default) keeps detail, `quad` gives smoother surfaces",
    ),
  wait_seconds: waitSeconds,
});

export const musicInput = z.object({
  force_instrumental: z
    .boolean()
    .optional()
    .describe("true makes a track with no vocals; omit to let the prompt decide"),
  music_length_ms: z
    .number()
    .int()
    .min(3000)
    .max(600_000)
    .optional()
    .describe(
      "The track's length in milliseconds, 3,000 to 600,000 (3 seconds to 10 minutes), e.g. 60000 for a minute; omit for the model's default",
    ),
  options,
  prompt: prompt.describe(
    "The music to compose, up to 5,000 characters: genre, mood, instruments, tempo, structure, e.g. `upbeat chiptune boss battle loop, 140 bpm`",
  ),
  wait_seconds: waitSeconds,
});

export const removeBackgroundInput = z.object({
  image_url: imageUrl,
  options,
  prompt: z.string().min(1).max(500).optional().describe("What to keep, e.g. the knight"),
  wait_seconds: waitSeconds,
});

export const soundInput = z.object({
  duration_seconds: z
    .number()
    .min(0.5)
    .max(22)
    .optional()
    .describe(
      "The sound's length in seconds, 0.5 to 22; omit to let the model fit the length to the sound",
    ),
  loop: z.boolean().optional().describe("Make it loop seamlessly"),
  options,
  text: prompt.describe("The sound to make"),
  wait_seconds: waitSeconds,
});

export const speechInput = z.object({
  options,
  text: prompt.describe("What to say"),
  voice: z.string().min(1).optional().describe("A voice name, e.g. Rachel, Aria, Roger"),
  wait_seconds: waitSeconds,
});

export const videoInput = z.object({
  aspect_ratio: z
    .enum(["auto", "21:9", "16:9", "4:3", "1:1", "3:4", "9:16"])
    .optional()
    .describe(
      "The frame's width to height, e.g. `16:9` landscape, `9:16` portrait, `1:1` square; `auto` lets the model choose, e.g. from image_url. Omit for the model's default",
    ),
  duration: z
    .enum([
      "auto",
      "4",
      "5",
      "6",
      "7",
      "8",
      "9",
      "10",
      "11",
      "12",
      "13",
      "14",
      "15",
      "16",
      "17",
      "18",
      "19",
      "20",
      "21",
      "22",
      "23",
      "24",
      "25",
      "26",
      "27",
      "28",
      "29",
      "30",
    ])
    .optional()
    .describe("Seconds, 4 to 30"),
  end_image_url: imageUrl.optional().describe("The last frame, with image_url"),
  generate_audio: z
    .boolean()
    .optional()
    .describe(
      "false makes a silent clip; omit for the model's default, which generates sound with the video",
    ),
  image_url: imageUrl.optional().describe("The first frame"),
  options,
  prompt: prompt.optional().describe("What happens; needed without image_url"),
  resolution: z
    .enum(["480p", "720p", "1080p"])
    .optional()
    .describe(
      "The clip's resolution; higher takes longer and may cost more (see generate pricing). Omit for the model's default",
    ),
  wait_seconds: waitSeconds,
});
