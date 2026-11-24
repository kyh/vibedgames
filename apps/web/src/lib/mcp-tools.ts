import type { JsonValue } from "@repo/contract/json";
import type { ORPCContext } from "@repo/service/orpc";
import { requiresScope } from "@repo/contract/base";
import { runInput } from "@repo/contract/generate/generate-schema";
import { appRouter } from "@repo/service";
import type { McpToolMeta } from "@orpc/mcp";
import { mcp } from "@orpc/mcp";
import type { AnyProcedure } from "@orpc/server";
import { call, DecoratedProcedure, ORPCError, os } from "@orpc/server";
import { z } from "zod";

/** A skill as `agent-skills.ts` bundles it: its SKILL.md, frontmatter and other files. */
export interface Skill {
  content: string;
  description: string;
  files: readonly { content: string; path: string }[];
  frontmatter: { readonly [key: string]: string | { readonly [key: string]: string } };
  name: string;
}

/**
 * What a tool call runs with: the API's context plus the bundled skills.
 * `taskMode` is set when the call will be answered as an MCP task, so a
 * generation returns as soon as it is queued.
 */
export type McpContext = ORPCContext & { skills: readonly Skill[]; taskMode?: boolean };

const asTool = <T extends AnyProcedure>(procedure: T, meta: McpToolMeta) =>
  new DecoratedProcedure(procedure["~orpc"]).meta(mcp.tool(meta));

const readOnly = { openWorldHint: false, readOnlyHint: true } as const;
const mutates = { destructiveHint: false, readOnlyHint: false } as const;
const external = { ...mutates, openWorldHint: true } as const;

const tool = os.$context<McpContext>();

const generateTool = tool.meta(requiresScope("generate"));

type ModelInput = Record<string, JsonValue>;

const runModel = (context: McpContext, endpoint: string, body: ModelInput, wait: number) =>
  call(
    appRouter.generate.run,
    { endpoint_id: endpoint, input: body, wait_seconds: context.taskMode ? 0 : wait },
    { context },
  );

const waitSeconds = runInput.shape.wait_seconds;

const generateTools = {
  generate: generateTool
    .meta(
      mcp.tool({
        annotations: external,
        description:
          "Runs a model to generate an image, video, audio clip, 3D model or text, billed against your credits. Pass the endpoint id and the model's input (see generate_schema). Waits up to `wait_seconds` for the result; a job still running by then returns its `request_id` and status, to follow with generate_status. Needs a positive credit balance (403 `insufficient_credits`) and a priced model (400 `unknown_endpoint`).",
        name: "generate",
        title: "Generate media",
      }),
    )
    .input(runInput)
    .handler(({ context, input }) =>
      runModel(context, input.endpoint_id, input.input, input.wait_seconds),
    ),

  generate_docs: asTool(appRouter.generate.docs, {
    annotations: { ...readOnly, openWorldHint: true },
    description:
      "Searches the model documentation: how a model is prompted, what its inputs mean, which to pick for a task.",
    name: "generate_docs",
    title: "Search model docs",
  }),

  generate_models: asTool(appRouter.generate.models, {
    annotations: { ...readOnly, openWorldHint: true },
    description:
      "Searches the models generate can run, by what they do (`query`) or by id, with a cursor for the next page.",
    name: "generate_models",
    title: "Search models",
  }),

  generate_pricing: asTool(appRouter.generate.pricing, {
    annotations: { ...readOnly, openWorldHint: true },
    description: "A model's price per unit, which generate bills against your credits.",
    name: "generate_pricing",
    title: "Model pricing",
  }),

  generate_schema: asTool(appRouter.generate.schema, {
    annotations: { ...readOnly, openWorldHint: true },
    description:
      "A model's input and output schema: what generate's `input` takes. `openapi` gives the full OpenAPI document.",
    name: "generate_schema",
    title: "Model schema",
  }),

  generate_status: asTool(appRouter.generate.status, {
    annotations: { ...external, idempotentHint: true },
    description:
      "Follows a generate job: its status (`status`), its output once COMPLETED (`result`, which settles the bill), or `cancel`.",
    name: "generate_status",
    title: "Generation status",
  }),

  generate_upload: asTool(appRouter.generate.upload, {
    annotations: external,
    description:
      "Opens an upload slot for a model input that takes a file's URL (a reference image, an audio clip to transform). PUT the file's bytes to `uploadUrl` (on this server, valid 15 minutes) with the `headers` given, e.g. `curl -T file.png -H 'Content-Type: image/png' \"$uploadUrl\"`, then pass `fileUrl` to the model.",
    name: "generate_upload",
    title: "Upload a model input",
  }),
};

const options = z
  .record(z.string(), z.json())
  .default({})
  .describe(
    "Any other input the model takes, per generate_schema of its endpoint; the fields above win",
  );

const bodyOf = (extra: ModelInput, fields: Record<string, JsonValue | undefined>) => {
  const given = Object.entries(fields).filter(
    (entry): entry is [string, JsonValue] => entry[1] !== undefined,
  );

  return { ...extra, ...Object.fromEntries(given) };
};

const prompt = z.string().min(1).max(5000);
const imageUrl = z.url().describe("An image's URL, e.g. from generate_upload");

/**
 * One tool per kind of asset, each on the default model the model-catalog
 * skill names for it, with that model's main inputs typed. `generate` runs
 * any other.
 */
export const MEDIA_MODELS = {
  animate_3d: ["meshy/rigging/multi-animation"],
  generate_3d: ["meshy/v7.1/text-to-3d", "meshy/v7.1/image-to-3d"],
  generate_image: ["openai/gpt-image-2.5/flare/text-to-image", "openai/gpt-image-2.5/flare/edit"],
  generate_music: ["elevenlabs/music/v2.5"],
  generate_sound: ["fal-ai/elevenlabs/sound-effects/v2"],
  generate_speech: ["elevenlabs/tts/eleven-v4"],
  generate_video: [
    "bytedance/seedance-2.5/us/text-to-video",
    "bytedance/seedance-2.5/us/image-to-video",
  ],
  remove_background: ["bria/guided-remove-background"],
} as const;

/** The tools that queue a generation, which a client with the tasks extension gets back as a task. */
export const TASK_TOOLS: ReadonlySet<string> = new Set(["generate", ...Object.keys(MEDIA_MODELS)]);

const billed =
  "Billed against your credits; waits up to `wait_seconds`, then returns the `request_id` to follow with generate_status.";

const mediaTools = {
  animate_3d: generateTool
    .meta(
      mcp.tool({
        annotations: external,
        description: `Rigs a humanoid character GLB, e.g. one generate_3d made, and bakes animation clips onto that one skeleton: a GLB per \`animation_action_ids\` entry from Meshy's animation library, plus walking and running (Meshy rigging: \`${MEDIA_MODELS.animate_3d[0]}\`). The 3d reference of the model-catalog skill lists the clip ids games use. ${billed}`,
        name: "animate_3d",
        title: "Rig and animate a 3D character",
      }),
    )
    .input(
      z.object({
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
        model_url: z.url().describe("The character's GLB, e.g. generate_3d's model_glb"),
        options,
        wait_seconds: waitSeconds,
      }),
    )
    .handler(({ context, input }) =>
      runModel(
        context,
        MEDIA_MODELS.animate_3d[0],
        bodyOf(input.options, {
          animation_action_ids: input.animation_action_ids,
          height_meters: input.height_meters,
          model_url: input.model_url,
        }),
        input.wait_seconds,
      ),
    ),

  generate_3d: generateTool
    .meta(
      mcp.tool({
        annotations: external,
        description: `Generates a textured 3D model (GLB) from a prompt, or from an image when \`image_url\` is given (Meshy 7.1: \`${MEDIA_MODELS.generate_3d.join("`, `")}\`); a low \`target_polycount\` suits games. To animate a character, model it with \`pose_mode\` and pass its \`model_glb\` to animate_3d. ${billed}`,
        name: "generate_3d",
        title: "Generate a 3D model",
      }),
    )
    .input(
      z.object({
        image_url: imageUrl.optional(),
        options,
        pose_mode: z
          .enum(["a-pose", "t-pose"])
          .optional()
          .describe("Model a character in this pose, which rigs cleanly in animate_3d"),
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
      }),
    )
    .handler(({ context, input }) => {
      const [fromText, fromImage] = MEDIA_MODELS.generate_3d;

      if (input.image_url === undefined && input.prompt === undefined) {
        throw new ORPCError("BAD_REQUEST", { message: "Give a prompt or an image_url." });
      }

      const fields = {
        image_url: input.image_url,
        pose_mode: input.pose_mode,
        prompt: input.image_url === undefined ? input.prompt : undefined,
        target_polycount: input.target_polycount,
        topology: input.topology,
      };

      return runModel(
        context,
        input.image_url === undefined ? fromText : fromImage,
        bodyOf(input.options, fields),
        input.wait_seconds,
      );
    }),

  generate_image: generateTool
    .meta(
      mcp.tool({
        annotations: external,
        description: `Generates images from a prompt, or edits and combines reference images when \`image_urls\` is given (GPT Image 2.5: \`${MEDIA_MODELS.generate_image.join("`, `")}\`). \`background: transparent\` makes sprites and props with no background to remove. ${billed}`,
        name: "generate_image",
        title: "Generate an image",
      }),
    )
    .input(
      z.object({
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
        image_urls: z
          .array(imageUrl)
          .min(1)
          .max(16)
          .optional()
          .describe("Images to edit or combine"),
        num_images: z
          .number()
          .int()
          .min(1)
          .max(4)
          .optional()
          .describe(
            "How many images to make from the one prompt, 1 to 4; omit for the model's default",
          ),
        options,
        prompt: prompt.describe(
          "What to draw, or with image_urls how to edit or combine them, up to 5,000 characters, e.g. `pixel-art knight sprite, side view`",
        ),
        quality: z
          .enum(["auto", "low", "medium", "high", "xhigh", "max"])
          .optional()
          .describe(
            "Rendering quality from `low` (quick drafts) to `max`; higher takes longer and may cost more (see generate_pricing). `auto` lets the model choose; omit for the model's default",
          ),
        wait_seconds: waitSeconds,
      }),
    )
    .handler(({ context, input }) => {
      const [fromText, edit] = MEDIA_MODELS.generate_image;

      const fields = {
        background: input.background,
        image_size: input.image_size,
        image_urls: input.image_urls,
        num_images: input.num_images,
        prompt: input.prompt,
        quality: input.quality,
      };

      return runModel(
        context,
        input.image_urls === undefined ? fromText : edit,
        bodyOf(input.options, fields),
        input.wait_seconds,
      );
    }),

  generate_music: generateTool
    .meta(
      mcp.tool({
        annotations: external,
        description: `Composes music from a prompt: genre, mood, instruments, structure (ElevenLabs Music v2.5: \`${MEDIA_MODELS.generate_music[0]}\`). ${billed}`,
        name: "generate_music",
        title: "Generate music",
      }),
    )
    .input(
      z.object({
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
      }),
    )
    .handler(({ context, input }) =>
      runModel(
        context,
        MEDIA_MODELS.generate_music[0],
        bodyOf(input.options, {
          force_instrumental: input.force_instrumental,
          music_length_ms: input.music_length_ms,
          prompt: input.prompt,
        }),
        input.wait_seconds,
      ),
    ),

  generate_sound: generateTool
    .meta(
      mcp.tool({
        annotations: external,
        description: `Generates a sound effect from a description: a jump, a hit, an explosion, ambience (ElevenLabs Sound Effects: \`${MEDIA_MODELS.generate_sound[0]}\`). ${billed}`,
        name: "generate_sound",
        title: "Generate a sound effect",
      }),
    )
    .input(
      z.object({
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
      }),
    )
    .handler(({ context, input }) =>
      runModel(
        context,
        MEDIA_MODELS.generate_sound[0],
        bodyOf(input.options, {
          duration_seconds: input.duration_seconds,
          loop: input.loop,
          text: input.text,
        }),
        input.wait_seconds,
      ),
    ),

  generate_speech: generateTool
    .meta(
      mcp.tool({
        annotations: external,
        description: `Speaks a line of text: dialogue, narration, an announcer (ElevenLabs v4, which takes audio tags for delivery: \`${MEDIA_MODELS.generate_speech[0]}\`). ${billed}`,
        name: "generate_speech",
        title: "Generate speech",
      }),
    )
    .input(
      z.object({
        options,
        text: prompt.describe("What to say"),
        voice: z.string().min(1).optional().describe("A voice name, e.g. Rachel, Aria, Roger"),
        wait_seconds: waitSeconds,
      }),
    )
    .handler(({ context, input }) =>
      runModel(
        context,
        MEDIA_MODELS.generate_speech[0],
        bodyOf(input.options, { text: input.text, voice: input.voice }),
        input.wait_seconds,
      ),
    ),

  generate_video: generateTool
    .meta(
      mcp.tool({
        annotations: external,
        description: `Generates a video clip with sound from a prompt, or animates an image when \`image_url\` is given (Seedance 2.5: \`${MEDIA_MODELS.generate_video.join("`, `")}\`). Video takes minutes: expect a \`request_id\` to follow with generate_status. ${billed}`,
        name: "generate_video",
        title: "Generate a video",
      }),
    )
    .input(
      z.object({
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
            "The clip's resolution; higher takes longer and may cost more (see generate_pricing). Omit for the model's default",
          ),
        wait_seconds: waitSeconds,
      }),
    )
    .handler(({ context, input }) => {
      const [fromText, fromImage] = MEDIA_MODELS.generate_video;

      if (input.end_image_url !== undefined && input.image_url === undefined) {
        throw new ORPCError("BAD_REQUEST", { message: "end_image_url needs an image_url." });
      }

      if (input.image_url === undefined && input.prompt === undefined) {
        throw new ORPCError("BAD_REQUEST", { message: "Give a prompt or an image_url." });
      }

      const fields = {
        aspect_ratio: input.aspect_ratio,
        duration: input.duration,
        end_image_url: input.end_image_url,
        generate_audio: input.generate_audio,
        image_url: input.image_url,
        prompt: input.prompt,
        resolution: input.resolution,
      };

      return runModel(
        context,
        input.image_url === undefined ? fromText : fromImage,
        bodyOf(input.options, fields),
        input.wait_seconds,
      );
    }),

  remove_background: generateTool
    .meta(
      mcp.tool({
        annotations: external,
        description: `Cuts the subject out of an image onto a transparent background, for sprites and props; \`prompt\` names what to keep when the cut is ambiguous (Bria Guided Remove Background: \`${MEDIA_MODELS.remove_background[0]}\`). ${billed}`,
        name: "remove_background",
        title: "Remove an image's background",
      }),
    )
    .input(
      z.object({
        image_url: imageUrl,
        options,
        prompt: z.string().min(1).max(500).optional().describe("What to keep, e.g. the knight"),
        wait_seconds: waitSeconds,
      }),
    )
    .handler(({ context, input }) =>
      runModel(
        context,
        MEDIA_MODELS.remove_background[0],
        bodyOf(input.options, { image_url: input.image_url, prompt: input.prompt }),
        input.wait_seconds,
      ),
    ),
};

export const tools = {
  credits: asTool(appRouter.credits.me, {
    annotations: readOnly,
    name: "credits",
    title: "Credit balance",
  }),
  credits_buy: asTool(appRouter.credits.checkout, {
    annotations: external,
    name: "credits_buy",
    title: "Buy credits",
  }),
  credits_redeem: asTool(appRouter.credits.redeem, {
    annotations: { ...mutates, idempotentHint: true, openWorldHint: false },
    name: "credits_redeem",
    title: "Redeem a credit code",
  }),
  deploy: asTool(appRouter.deploy.upload, {
    annotations: { ...mutates, openWorldHint: false },
    name: "deploy",
    title: "Deploy a game",
  }),
  deployments: asTool(appRouter.deploy.list, {
    annotations: readOnly,
    name: "deployments",
    title: "Your games",
  }),
  deployments_delete: asTool(appRouter.deploy.delete, {
    annotations: {
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
      readOnlyHint: false,
    },
    name: "deployments_delete",
    title: "Delete a game",
  }),
  fork: asTool(appRouter.deploy.getSource, {
    annotations: readOnly,
    name: "fork",
    title: "Fork a game's source",
  }),
  ...generateTools,
  ...mediaTools,
  skills: tool
    .meta(
      mcp.tool({
        annotations: readOnly,
        description:
          "The vibedgames game-studio skills: without `name`, every skill and what it is for; with one, its full SKILL.md — how to build, art-direct, add multiplayer to, balance and ship a browser game.",
        name: "skills",
        title: "Game-studio skills",
      }),
    )
    .input(z.object({ name: z.string().optional().describe("A skill's name from the list") }))
    .handler(({ context, input }) => {
      if (input.name === undefined) {
        return {
          skills: context.skills.map(({ description, name }) => ({ description, name })),
        };
      }

      const skill = context.skills.find(({ name }) => name === input.name);

      if (!skill) {
        throw new ORPCError("NOT_FOUND", {
          message: `No skill "${input.name}". Call skills without a name to list them.`,
        });
      }

      return { content: skill.content, description: skill.description, name: skill.name };
    }),
  whoami: asTool(appRouter.auth.me, { annotations: readOnly, name: "whoami", title: "Who am I" }),
};
