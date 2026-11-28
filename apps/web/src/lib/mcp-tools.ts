import type { JsonValue } from "@repo/contract/json";
import type { ORPCContext } from "@repo/service/orpc";
import { requiresScope } from "@repo/contract/base";
import { runInput } from "@repo/contract/generate/generate-schema";
import {
  animate3dInput,
  imageInput,
  MEDIA_MODELS,
  model3dInput,
  musicInput,
  removeBackgroundInput,
  soundInput,
  speechInput,
  videoInput,
} from "@repo/contract/generate/media-schema";
import { appRouter } from "@repo/service";
import type { McpToolMeta } from "@orpc/mcp";
import { mcp } from "@orpc/mcp";
import type { AnyProcedure } from "@orpc/server";
import { call, DecoratedProcedure, ORPCError, os } from "@orpc/server";
import { z } from "zod";

import { browseGames } from "@/lib/mcp-gallery";
import { browseInput, browseOutput, GALLERY_URI } from "@/lib/mcp-gallery-schema";

export { MEDIA_MODELS } from "@repo/contract/generate/media-schema";

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

const asTool = (procedure: AnyProcedure, meta: McpToolMeta) =>
  new DecoratedProcedure(procedure["~orpc"]).meta(mcp.tool(meta));

const readOnly = { destructiveHint: false, openWorldHint: false, readOnlyHint: true } as const;
const mutates = { destructiveHint: false, readOnlyHint: false } as const;
const external = { ...mutates, openWorldHint: true } as const;

const tool = os.$context<McpContext>();

const generateTool = tool.meta(requiresScope("generate"));

type ModelInput = Record<string, JsonValue>;

const runModel = async (context: McpContext, endpoint: string, body: ModelInput, wait: number) =>
  await call(
    appRouter.generate.run,
    { endpoint_id: endpoint, input: body, wait_seconds: context.taskMode === true ? 0 : wait },
    { context },
  );

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
    .handler(
      async ({ context, input }) =>
        await runModel(context, input.endpoint_id, input.input, input.wait_seconds),
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

const waitFor = (context: McpContext, wait: number) => (context.taskMode === true ? 0 : wait);

/** The tools that queue a generation, which a client with the tasks extension gets back as a task. */
export const TASK_TOOLS: ReadonlySet<string> = new Set([
  "generate",
  "generate_animate_3d",
  "generate_3d",
  "generate_image",
  "generate_music",
  "generate_sound",
  "generate_speech",
  "generate_video",
  "generate_remove_background",
]);

const billed =
  "Billed against your credits; waits up to `wait_seconds`, then returns the `request_id` to follow with generate_status.";

const mediaTools = {
  generate_animate_3d: generateTool
    .meta(
      mcp.tool({
        annotations: external,
        description: `Rigs a humanoid character GLB, e.g. one generate_3d made, and bakes animation clips onto that one skeleton: a GLB per \`animation_action_ids\` entry from Meshy's animation library, plus walking and running (Meshy rigging: \`${MEDIA_MODELS.animate3d[0]}\`). The 3d reference of the model-catalog skill lists the clip ids games use. ${billed}`,
        name: "generate_animate_3d",
        title: "Rig and animate a 3D character",
      }),
    )
    .input(animate3dInput)
    .handler(
      async ({ context, input }) =>
        await call(
          appRouter.generate.animate3d,
          { ...input, wait_seconds: waitFor(context, input.wait_seconds) },
          { context },
        ),
    ),

  generate_3d: generateTool
    .meta(
      mcp.tool({
        annotations: external,
        description: `Generates a textured 3D model (GLB) from a prompt, or from an image when \`image_url\` is given (Meshy 7.1: \`${MEDIA_MODELS.model3d.join("`, `")}\`); a low \`target_polycount\` suits games. To animate a character, model it with \`pose_mode\` and pass its \`model_glb\` to generate_animate_3d. ${billed}`,
        name: "generate_3d",
        title: "Generate a 3D model",
      }),
    )
    .input(model3dInput)
    .handler(
      async ({ context, input }) =>
        await call(
          appRouter.generate.model3d,
          { ...input, wait_seconds: waitFor(context, input.wait_seconds) },
          { context },
        ),
    ),

  generate_image: generateTool
    .meta(
      mcp.tool({
        annotations: external,
        description: `Generates images from a prompt, or edits and combines reference images when \`image_urls\` is given (GPT Image 2.5: \`${MEDIA_MODELS.image.join("`, `")}\`). \`background: transparent\` makes sprites and props with no background to remove. ${billed}`,
        name: "generate_image",
        title: "Generate an image",
      }),
    )
    .input(imageInput)
    .handler(
      async ({ context, input }) =>
        await call(
          appRouter.generate.image,
          { ...input, wait_seconds: waitFor(context, input.wait_seconds) },
          { context },
        ),
    ),

  generate_music: generateTool
    .meta(
      mcp.tool({
        annotations: external,
        description: `Composes music from a prompt: genre, mood, instruments, structure (ElevenLabs Music v2.5: \`${MEDIA_MODELS.music[0]}\`). ${billed}`,
        name: "generate_music",
        title: "Generate music",
      }),
    )
    .input(musicInput)
    .handler(
      async ({ context, input }) =>
        await call(
          appRouter.generate.music,
          { ...input, wait_seconds: waitFor(context, input.wait_seconds) },
          { context },
        ),
    ),

  generate_sound: generateTool
    .meta(
      mcp.tool({
        annotations: external,
        description: `Generates a sound effect from a description: a jump, a hit, an explosion, ambience (ElevenLabs Sound Effects: \`${MEDIA_MODELS.sound[0]}\`). ${billed}`,
        name: "generate_sound",
        title: "Generate a sound effect",
      }),
    )
    .input(soundInput)
    .handler(
      async ({ context, input }) =>
        await call(
          appRouter.generate.sound,
          { ...input, wait_seconds: waitFor(context, input.wait_seconds) },
          { context },
        ),
    ),

  generate_speech: generateTool
    .meta(
      mcp.tool({
        annotations: external,
        description: `Speaks a line of text: dialogue, narration, an announcer (ElevenLabs v4, which takes audio tags for delivery: \`${MEDIA_MODELS.speech[0]}\`). ${billed}`,
        name: "generate_speech",
        title: "Generate speech",
      }),
    )
    .input(speechInput)
    .handler(
      async ({ context, input }) =>
        await call(
          appRouter.generate.speech,
          { ...input, wait_seconds: waitFor(context, input.wait_seconds) },
          { context },
        ),
    ),

  generate_video: generateTool
    .meta(
      mcp.tool({
        annotations: external,
        description: `Generates a video clip with sound from a prompt, or animates an image when \`image_url\` is given (Seedance 2.5: \`${MEDIA_MODELS.video.join("`, `")}\`). Video takes minutes: expect a \`request_id\` to follow with generate_status. ${billed}`,
        name: "generate_video",
        title: "Generate a video",
      }),
    )
    .input(videoInput)
    .handler(
      async ({ context, input }) =>
        await call(
          appRouter.generate.video,
          { ...input, wait_seconds: waitFor(context, input.wait_seconds) },
          { context },
        ),
    ),

  generate_remove_background: generateTool
    .meta(
      mcp.tool({
        annotations: external,
        description: `Cuts the subject out of an image onto a transparent background, for sprites and props; \`prompt\` names what to keep when the cut is ambiguous (Bria Guided Remove Background: \`${MEDIA_MODELS.removeBackground[0]}\`). ${billed}`,
        name: "generate_remove_background",
        title: "Remove an image's background",
      }),
    )
    .input(removeBackgroundInput)
    .handler(
      async ({ context, input }) =>
        await call(
          appRouter.generate.removeBackground,
          { ...input, wait_seconds: waitFor(context, input.wait_seconds) },
          { context },
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
    annotations: { ...mutates, destructiveHint: true, openWorldHint: false },
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
  games_browse: tool
    .meta(
      mcp.tool({
        _meta: {
          ui: { resourceUri: GALLERY_URI, visibility: ["model", "app"] },
          "ui/resourceUri": GALLERY_URI,
        },
        annotations: readOnly,
        description:
          "Browses the games on vibedgames, as the site's gallery shows them: each with its description, tags (`3d`, `camera` for webcam control, `multiplayer`), cover image and the URL it plays at. `query` matches words in a name, description or tag; `tag` keeps only games with it. Hosts with MCP Apps render it as a gallery to play from.",
        name: "games_browse",
        title: "Browse games",
      }),
    )
    .input(browseInput)
    .output(browseOutput)
    .handler(({ input }) => browseGames(input)),
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
