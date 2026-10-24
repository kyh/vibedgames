import type { RouterInputs } from "@repo/contract";
import type { JsonValue } from "@repo/contract/json";
import type { ORPCContext } from "@repo/service/orpc";
import { endpointPath, queueAppId } from "@repo/contract/generate/queue-path";
import { appRouter } from "@repo/service";
import { signUploadUrl } from "@repo/service/storage/signed-urls";
import type { McpToolMeta } from "@orpc/mcp";
import { mcp } from "@orpc/mcp";
import type { AnyProcedure } from "@orpc/server";
import { call, DecoratedProcedure, ORPCError, os } from "@orpc/server";
import { z } from "zod";

/**
 * The tools `/mcp` serves, one per `vg` command that reaches the server, named
 * as the agent thinks of them rather than by router path. Most are the API's
 * own procedures; the `generate_*` family is `vg generate`'s subcommands over
 * `generate.forward`, called through `call()` so its session check, input
 * rules and credit ledger run exactly as for the CLI; `skills` reads the
 * bundled skills.
 *
 * Not tools, because they only touch the caller's machine: `init`, `login`,
 * `logout`, `update`, `config`, `completions`, `new` and `factory`; and
 * `playtest run`, which drives a local browser.
 */

/** A skill as `agent-skills.ts` bundles it: its SKILL.md, frontmatter and other files. */
export interface Skill {
  content: string;
  description: string;
  files: readonly { content: string; path: string }[];
  frontmatter: { readonly [key: string]: string | { readonly [key: string]: string } };
  name: string;
}

/** What a tool call runs with: the API's context plus the bundled skills. */
export type McpContext = ORPCContext & { skills: readonly Skill[] };

/**
 * A contract-first procedure takes its meta from the contract, so the
 * implemented one has no `.meta()`; re-decorating its definition keeps the
 * handler and middleware and adds the tool's.
 */
const asTool = <T extends AnyProcedure>(procedure: T, meta: McpToolMeta) =>
  new DecoratedProcedure(procedure["~orpc"]).meta(mcp.tool(meta));

const readOnly = { openWorldHint: false, readOnlyHint: true } as const;
const mutates = { destructiveHint: false, readOnlyHint: false } as const;
const external = { ...mutates, openWorldHint: true } as const;

const tool = os.$context<McpContext>();

type ForwardQuery = NonNullable<RouterInputs["generate"]["forward"]["query"]>;

const forward = (context: McpContext, input: RouterInputs["generate"]["forward"]) =>
  call(appRouter.generate.forward, input, { context });

/** One string field of an upstream body, or null when the body lacks it. */
const stringField = (value: JsonValue, key: string): string | null => {
  const parsed = z.looseObject({ [key]: z.string() }).safeParse(value);
  return parsed.success ? (parsed.data[key] ?? null) : null;
};

const sleep = (ms: number) =>
  // oxlint-disable-next-line promise/avoid-new -- a Worker has no promise-returning timer to await
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

const endpointId = z
  .string()
  .min(1)
  .describe("A model's endpoint id, as generate_models lists it, e.g. `fal-ai/flux/dev`");

const TERMINAL = new Set(["COMPLETED", "FAILED", "CANCELLED"]);
const POLL_MS = 2000;

// The longest a `generate` call holds the request open: a Worker answers
// within it, and a client's tool-call timeout is usually not much longer.
const MAX_WAIT_SECONDS = 25;

const queueStatus = async (context: McpContext, endpoint: string, requestId: string) => {
  const status = await forward(context, {
    method: "GET",
    path: `/${queueAppId(endpoint)}/requests/${requestId}/status`,
    target: "queue",
  });
  return stringField(status, "status")?.toUpperCase() ?? "UNKNOWN";
};

const queueResult = (context: McpContext, endpoint: string, requestId: string) =>
  forward(context, {
    method: "GET",
    path: `/${queueAppId(endpoint)}/requests/${requestId}`,
    target: "queue",
  });

/** What a model's queue takes as its input. */
type ModelInput = Record<string, JsonValue>;

/**
 * Submits one job to a model's queue and waits up to `waitSeconds` for it,
 * returning its output once COMPLETED, else its request id and status to
 * follow with generate_status.
 */
const runModel = async (
  context: McpContext,
  endpoint: string,
  body: ModelInput,
  waitSeconds: number,
) => {
  const submission = await forward(context, {
    body,
    method: "POST",
    path: `/${endpointPath(endpoint)}`,
    target: "queue",
  });
  const requestId = stringField(submission, "request_id");
  if (!requestId) {
    throw new ORPCError("BAD_GATEWAY", { message: "The model's queue returned no request_id." });
  }
  // The job is submitted and its credit held: a poll that fails from here
  // must still hand back the request id, or a retry submits a second job.
  try {
    const deadline = Date.now() + waitSeconds * 1000;
    let status = stringField(submission, "status")?.toUpperCase() ?? "IN_QUEUE";
    while (!TERMINAL.has(status) && Date.now() + POLL_MS <= deadline) {
      await sleep(POLL_MS);
      status = await queueStatus(context, endpoint, requestId);
    }
    if (status !== "COMPLETED") {
      return { endpoint_id: endpoint, request_id: requestId, result: null, status };
    }
    const result = await queueResult(context, endpoint, requestId);
    return { endpoint_id: endpoint, request_id: requestId, result, status };
  } catch (error) {
    const reason = error instanceof Error ? error.message : "no reason given";
    throw new ORPCError(error instanceof ORPCError ? error.code : "BAD_GATEWAY", {
      cause: error,
      message: `Submitted as request ${requestId} on ${endpoint}, then the poll failed (${reason}). Follow it with generate_status rather than generating again.`,
    });
  }
};

/**
 * A cancel is confirmed asynchronously, and the hold is refunded when a status
 * poll sees CANCELLED, so poll a few times as `vg generate status --cancel`
 * does. Best-effort: a miss leaves the refund to the next status call.
 */
const confirmCancelled = async (context: McpContext, endpoint: string, requestId: string) => {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await sleep(1000);
    try {
      if (TERMINAL.has(await queueStatus(context, endpoint, requestId))) {
        return;
      }
    } catch {
      return;
    }
  }
};

const waitSeconds = z
  .number()
  .int()
  .min(0)
  .max(MAX_WAIT_SECONDS)
  .default(20)
  .describe("How long to wait for the result before returning the request id");

const generateTools = {
  generate: tool
    .meta(
      mcp.tool({
        annotations: external,
        description:
          "Runs a model to generate an image, video, audio clip, 3D model or text, billed against your credits. Pass the endpoint id and the model's input (see generate_schema). Waits up to `wait_seconds` for the result; a job still running by then returns its `request_id` and status, to follow with generate_status. Needs a positive credit balance (403 `insufficient_credits`) and a priced model (400 `unknown_endpoint`).",
        name: "generate",
        title: "Generate media",
      }),
    )
    .input(
      z.object({
        endpoint_id: endpointId,
        input: z.record(z.string(), z.json()).describe("The model's input, per generate_schema"),
        wait_seconds: waitSeconds,
      }),
    )
    .handler(({ context, input }) =>
      runModel(context, input.endpoint_id, input.input, input.wait_seconds),
    ),

  generate_docs: tool
    .meta(
      mcp.tool({
        annotations: { ...readOnly, openWorldHint: true },
        description:
          "Searches the model documentation: how a model is prompted, what its inputs mean, which to pick for a task.",
        name: "generate_docs",
        title: "Search model docs",
      }),
    )
    .input(z.object({ query: z.string().min(1).max(500) }))
    .handler(({ context, input }) =>
      forward(context, {
        body: {
          id: 1,
          jsonrpc: "2.0",
          method: "tools/call",
          params: { arguments: { query: input.query }, name: "search_fal" },
        },
        method: "POST",
        path: "/docs/mcp",
        target: "docs",
      }),
    ),

  generate_models: tool
    .meta(
      mcp.tool({
        annotations: { ...readOnly, openWorldHint: true },
        description:
          "Searches the models generate can run, by what they do (`query`) or by id, with a cursor for the next page.",
        name: "generate_models",
        title: "Search models",
      }),
    )
    .input(
      z.object({
        category: z.string().optional().describe("e.g. text-to-image, image-to-video"),
        cursor: z.string().optional(),
        endpoint_id: z.array(z.string()).optional().describe("Look these ids up instead"),
        limit: z.number().int().min(1).max(100).default(20),
        query: z.string().optional().describe("Free text, e.g. `pixel art sprite`"),
      }),
    )
    .handler(({ context, input }) => {
      const query: ForwardQuery = { limit: String(input.limit) };
      if (input.query) {
        query.q = input.query;
      }
      if (input.category) {
        query.category = input.category;
      }
      if (input.cursor) {
        query.cursor = input.cursor;
      }
      if (input.endpoint_id?.length) {
        query.endpoint_id = input.endpoint_id;
      }
      return forward(context, { method: "GET", path: "/v1/models", query, target: "platform" });
    }),

  generate_pricing: tool
    .meta(
      mcp.tool({
        annotations: { ...readOnly, openWorldHint: true },
        description: "A model's price per unit, which generate bills against your credits.",
        name: "generate_pricing",
        title: "Model pricing",
      }),
    )
    .input(z.object({ endpoint_id: endpointId }))
    .handler(({ context, input }) =>
      forward(context, {
        method: "GET",
        path: "/v1/models/pricing",
        query: { endpoint_id: input.endpoint_id },
        target: "platform",
      }),
    ),

  generate_schema: tool
    .meta(
      mcp.tool({
        annotations: { ...readOnly, openWorldHint: true },
        description:
          "A model's input and output schema: what generate's `input` takes. `openapi` gives the full OpenAPI document.",
        name: "generate_schema",
        title: "Model schema",
      }),
    )
    .input(
      z.object({
        endpoint_id: endpointId,
        format: z.enum(["compact", "openapi"]).default("compact"),
      }),
    )
    .handler(({ context, input }) => {
      const query: ForwardQuery = { endpoint_id: input.endpoint_id, limit: "1" };
      if (input.format === "openapi") {
        query.expand = ["openapi-3.0"];
      }
      return forward(context, { method: "GET", path: "/v1/models", query, target: "platform" });
    }),

  generate_status: tool
    .meta(
      mcp.tool({
        annotations: { ...external, idempotentHint: true },
        description:
          "Follows a generate job: its status (`status`), its output once COMPLETED (`result`, which settles the bill), or `cancel`.",
        name: "generate_status",
        title: "Generation status",
      }),
    )
    .input(
      z.object({
        action: z.enum(["status", "result", "cancel"]).default("status"),
        endpoint_id: endpointId,
        logs: z.boolean().default(false).describe("Include the job's logs with its status"),
        request_id: z.string().min(1),
      }),
    )
    .handler(async ({ context, input }) => {
      const base = `/${queueAppId(input.endpoint_id)}/requests/${input.request_id}`;
      if (input.action === "result") {
        return queueResult(context, input.endpoint_id, input.request_id);
      }
      if (input.action === "cancel") {
        const answer = await forward(context, {
          method: "PUT",
          path: `${base}/cancel`,
          target: "queue",
        });
        await confirmCancelled(context, input.endpoint_id, input.request_id);
        return answer;
      }
      return forward(context, {
        method: "GET",
        path: `${base}/status`,
        query: input.logs ? { logs: "1" } : undefined,
        target: "queue",
      });
    }),

  generate_upload: tool
    .meta(
      mcp.tool({
        annotations: external,
        description:
          "Opens an upload slot in generate's storage for a model input that takes a file's URL (a reference image, an audio clip to transform). PUT the file's bytes to `upload_url` (on this server, valid 15 minutes) with the `headers` given, e.g. `curl -T file.png -H 'Content-Type: image/png' \"$upload_url\"`, then pass `file_url` to the model.",
        name: "generate_upload",
        title: "Upload a model input",
      }),
    )
    .input(
      z.object({
        content_type: z.string().min(1).max(127).describe("e.g. image/png"),
        file_name: z.string().min(1).max(255),
      }),
    )
    .handler(async ({ context, input }) => {
      const slot = await forward(context, {
        body: { content_type: input.content_type, file_name: input.file_name },
        method: "POST",
        path: "/storage/upload/initiate",
        target: "storage",
      });
      const uploadUrl = stringField(slot, "upload_url");
      const fileUrl = stringField(slot, "file_url");
      if (!uploadUrl?.startsWith("https://") || !fileUrl?.startsWith("https://")) {
        throw new ORPCError("BAD_GATEWAY", { message: "Storage returned no upload slot." });
      }
      if (!context.signing) {
        throw new ORPCError("INTERNAL_SERVER_ERROR", { message: "Uploads are not configured." });
      }
      // The agent PUTs to us and we forward to the slot, so its shell only
      // ever needs to reach this host.
      const upload = await signUploadUrl({
        contentType: input.content_type,
        signing: context.signing,
        target: { url: uploadUrl },
      });
      return {
        file_url: fileUrl,
        headers: { "Content-Type": input.content_type },
        method: "PUT",
        upload_url: upload,
      };
    }),
};

const options = z
  .record(z.string(), z.json())
  .default({})
  .describe(
    "Any other input the model takes, per generate_schema of its endpoint; the fields above win",
  );

/** The model's body: `options`, then every field given. */
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

const billed =
  "Billed against your credits; waits up to `wait_seconds`, then returns the `request_id` to follow with generate_status.";

const mediaTools = {
  generate_3d: tool
    .meta(
      mcp.tool({
        annotations: external,
        description: `Generates a textured 3D model (GLB) from a prompt, or from an image when \`image_url\` is given (Meshy 7.1: \`${MEDIA_MODELS.generate_3d.join("`, `")}\`); \`model_type: lowpoly\` suits games. ${billed}`,
        name: "generate_3d",
        title: "Generate a 3D model",
      }),
    )
    .input(
      z.object({
        image_url: imageUrl.optional(),
        model_type: z.enum(["standard", "lowpoly", "smart-topology"]).optional(),
        options,
        prompt: prompt.max(600).optional().describe("What to model; needed without image_url"),
        target_polycount: z.number().int().min(100).max(300_000).optional(),
        topology: z.enum(["quad", "triangle"]).optional(),
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
        model_type: input.model_type,
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

  generate_image: tool
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
        background: z.enum(["auto", "transparent", "opaque"]).optional(),
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
        num_images: z.number().int().min(1).max(4).optional(),
        options,
        prompt,
        quality: z.enum(["auto", "low", "medium", "high", "xhigh", "max"]).optional(),
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

  generate_music: tool
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
        force_instrumental: z.boolean().optional(),
        music_length_ms: z.number().int().min(3000).max(600_000).optional(),
        options,
        prompt,
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

  generate_sound: tool
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
        duration_seconds: z.number().min(0.5).max(22).optional(),
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

  generate_speech: tool
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

  generate_video: tool
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
        aspect_ratio: z.enum(["auto", "21:9", "16:9", "4:3", "1:1", "3:4", "9:16"]).optional(),
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
        generate_audio: z.boolean().optional(),
        image_url: imageUrl.optional().describe("The first frame"),
        options,
        prompt: prompt.optional().describe("What happens; needed without image_url"),
        resolution: z.enum(["480p", "720p", "1080p"]).optional(),
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

  remove_background: tool
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
  deployments_upload: asTool(appRouter.deploy.upload, {
    annotations: { ...mutates, openWorldHint: false },
    name: "deployments_upload",
    title: "Deploy a game",
  }),
  fork: asTool(appRouter.deploy.getSource, {
    annotations: readOnly,
    name: "fork",
    title: "Fork a game's source",
  }),
  ...generateTools,
  ...mediaTools,
  me: asTool(appRouter.auth.me, { annotations: readOnly, name: "me", title: "Who am I" }),
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
};
