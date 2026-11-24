import { protectedBase, requiresScope } from "../base";
import { jsonValueSchema } from "../json";
import { documented } from "../openapi";
import { z } from "zod";

import {
  docsInput,
  modelsInput,
  pricingInput,
  runInput,
  schemaInput,
  statusInput,
  uploadInput,
} from "./generate-schema";
import {
  animate3dInput,
  imageInput,
  model3dInput,
  musicInput,
  removeBackgroundInput,
  soundInput,
  speechInput,
  videoInput,
  MEDIA_MODELS,
} from "./media-schema";

const runOutput = z.object({
  endpoint_id: z.string(),
  request_id: z.string(),
  result: jsonValueSchema.describe("The model's output once COMPLETED, else null."),
  status: z.string().describe("`IN_QUEUE`, `IN_PROGRESS`, `COMPLETED`, `FAILED` or `CANCELLED`"),
});

const billed =
  "Billed against your credits; waits up to `wait_seconds`, then returns the `request_id` to follow with generate status.";

const asset = (summary: string, description: string) =>
  protectedBase
    .meta(requiresScope("generate"))
    .meta(documented({ description, errors: [400, 403, 412, 413, 502], summary }));

const upstreamJson = jsonValueSchema.describe(
  "The upstream response body, or null when it had none.",
);

export const generateContract = {
  animate3d: asset(
    "Rig and animate a 3D character",
    `Rigs a humanoid character GLB, e.g. one generate 3d made, and bakes animation clips onto that one skeleton: a GLB per \`animation_action_ids\` entry from Meshy's animation library, plus walking and running (Meshy rigging: \`${MEDIA_MODELS.animate3d[0]}\`). The 3d reference of the model-catalog skill lists the clip ids games use. ${billed} Backs \`vg generate animate-3d\`.`,
  )
    .input(animate3dInput)
    .output(runOutput),

  image: asset(
    "Generate an image",
    `Generates images from a prompt, or edits and combines reference images when \`image_urls\` is given (GPT Image 2.5: \`${MEDIA_MODELS.image.join("`, `")}\`). \`background: transparent\` makes sprites and props with no background to remove. ${billed} Backs \`vg generate image\`.`,
  )
    .input(imageInput)
    .output(runOutput),

  model3d: asset(
    "Generate a 3D model",
    `Generates a textured 3D model (GLB) from a prompt, or from an image when \`image_url\` is given (Meshy 7.1: \`${MEDIA_MODELS.model3d.join("`, `")}\`); a low \`target_polycount\` suits games. To animate a character, model it with \`pose_mode\` and pass its \`model_glb\` to animate-3d. ${billed} Backs \`vg generate 3d\`.`,
  )
    .input(model3dInput)
    .output(runOutput),

  music: asset(
    "Generate music",
    `Composes music from a prompt: genre, mood, instruments, structure (ElevenLabs Music v2.5: \`${MEDIA_MODELS.music[0]}\`). ${billed} Backs \`vg generate music\`.`,
  )
    .input(musicInput)
    .output(runOutput),

  removeBackground: asset(
    "Remove an image's background",
    `Cuts the subject out of an image onto a transparent background, for sprites and props; \`prompt\` names what to keep when the cut is ambiguous (Bria Guided Remove Background: \`${MEDIA_MODELS.removeBackground[0]}\`). ${billed} Backs \`vg generate remove-background\`.`,
  )
    .input(removeBackgroundInput)
    .output(runOutput),

  sound: asset(
    "Generate a sound effect",
    `Generates a sound effect from a description: a jump, a hit, an explosion, ambience (ElevenLabs Sound Effects: \`${MEDIA_MODELS.sound[0]}\`). ${billed} Backs \`vg generate sound\`.`,
  )
    .input(soundInput)
    .output(runOutput),

  speech: asset(
    "Generate speech",
    `Speaks a line of text: dialogue, narration, an announcer (ElevenLabs v4, which takes audio tags for delivery: \`${MEDIA_MODELS.speech[0]}\`). ${billed} Backs \`vg generate speech\`.`,
  )
    .input(speechInput)
    .output(runOutput),

  video: asset(
    "Generate a video",
    `Generates a video clip with sound from a prompt, or animates an image when \`image_url\` is given (Seedance 2.5: \`${MEDIA_MODELS.video.join("`, `")}\`). Video takes minutes: expect a \`request_id\` to follow with generate status. ${billed} Backs \`vg generate video\`.`,
  )
    .input(videoInput)
    .output(runOutput),

  docs: protectedBase
    .meta(requiresScope("generate"))
    .meta(
      documented({
        description:
          "Searches the model documentation: how a model is prompted, what its inputs mean, which to pick for a task. Backs `vg generate docs`.",
        errors: [412, 502],
        summary: "Search model docs",
      }),
    )
    .input(docsInput)
    .output(upstreamJson),

  models: protectedBase
    .meta(requiresScope("generate"))
    .meta(
      documented({
        description:
          "Searches the models generate can run, by what they do (`query`), by category or by id, with a cursor for the next page. Backs `vg generate models`.",
        errors: [412, 502],
        summary: "Search models",
      }),
    )
    .input(modelsInput)
    .output(upstreamJson),

  pricing: protectedBase
    .meta(requiresScope("generate"))
    .meta(
      documented({
        description:
          "A model's price per unit, which generate bills against your credits. Backs `vg generate pricing`.",
        errors: [412, 502],
        summary: "Model pricing",
      }),
    )
    .input(pricingInput)
    .output(upstreamJson),

  run: protectedBase
    .meta(requiresScope("generate"))
    .meta(
      documented({
        description:
          "Runs a model to generate an image, video, audio clip, 3D model or text, billed against your credits. Waits up to `wait_seconds` for the output; a job still running by then returns its `request_id` and status, to follow with generate.status. Needs a positive credit balance (403 `insufficient_credits`) and a priced model (400 `unknown_endpoint`) unless the caller is an admin. Backs `vg generate run`.",
        errors: [403, 412, 413, 502],
        summary: "Run a model",
      }),
    )
    .input(runInput)
    .output(runOutput),

  schema: protectedBase
    .meta(requiresScope("generate"))
    .meta(
      documented({
        description:
          "A model's input and output schema: what generate.run's `input` takes. `openapi` gives the full OpenAPI document. Backs `vg generate schema`.",
        errors: [412, 502],
        summary: "Model schema",
      }),
    )
    .input(schemaInput)
    .output(upstreamJson),

  status: protectedBase
    .meta(requiresScope("generate"))
    .meta(
      documented({
        description:
          "Follows a generate job: its status (`status`), its output once COMPLETED (`result`, which settles the bill), or `cancel`, which waits briefly for the queue to settle the job so its hold is refunded. Backs `vg generate status`.",
        errors: [412, 502],
        summary: "Follow a generation",
      }),
    )
    .input(statusInput)
    .output(upstreamJson),

  upload: protectedBase
    .meta(requiresScope("generate"))
    .meta(
      documented({
        description:
          "Opens an upload slot for a model input (a reference image, an audio clip to transform). PUT the bytes to `uploadUrl`, a 15-minute signed URL on this server, with the `headers` given; the server streams them on to generate's storage. Then pass `fileUrl` to the model. Backs `vg generate upload`.",
        errors: [412, 502],
        summary: "Upload a model input",
      }),
    )
    .input(uploadInput)
    .output(
      z.object({
        fileUrl: z.string(),
        headers: z.object({ "content-type": z.string() }),
        uploadUrl: z.string(),
      }),
    ),
};
