import type { RouterInputs } from "@repo/contract";
import type { JsonValue } from "@repo/contract/json";
import type { ORPCContext } from "@repo/service/orpc";
import { endpointPath, queueAppId } from "@repo/contract/generate/queue-path";
import { appRouter } from "@repo/service";
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

/** A skill as `/.well-known/agent-skills` serves it. */
export interface Skill {
  content: string;
  description: string;
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
        wait_seconds: z
          .number()
          .int()
          .min(0)
          .max(MAX_WAIT_SECONDS)
          .default(20)
          .describe("How long to wait for the result before returning the request id"),
      }),
    )
    .handler(async ({ context, input }) => {
      const submission = await forward(context, {
        body: input.input,
        method: "POST",
        path: `/${endpointPath(input.endpoint_id)}`,
        target: "queue",
      });
      const requestId = stringField(submission, "request_id");
      if (!requestId) {
        throw new ORPCError("BAD_GATEWAY", {
          message: "The model's queue returned no request_id.",
        });
      }
      const deadline = Date.now() + input.wait_seconds * 1000;
      let status = stringField(submission, "status")?.toUpperCase() ?? "IN_QUEUE";
      while (!TERMINAL.has(status) && Date.now() + POLL_MS <= deadline) {
        await sleep(POLL_MS);
        status = await queueStatus(context, input.endpoint_id, requestId);
      }
      if (status !== "COMPLETED") {
        return { endpoint_id: input.endpoint_id, request_id: requestId, result: null, status };
      }
      const result = await queueResult(context, input.endpoint_id, requestId);
      return { endpoint_id: input.endpoint_id, request_id: requestId, result, status };
    }),

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
    .handler(({ context, input }) => {
      const base = `/${queueAppId(input.endpoint_id)}/requests/${input.request_id}`;
      if (input.action === "result") {
        return queueResult(context, input.endpoint_id, input.request_id);
      }
      return forward(context, {
        method: input.action === "cancel" ? "PUT" : "GET",
        path: input.action === "cancel" ? `${base}/cancel` : `${base}/status`,
        query: input.action === "status" && input.logs ? { logs: "1" } : undefined,
        target: "queue",
      });
    }),

  generate_upload: tool
    .meta(
      mcp.tool({
        annotations: external,
        description:
          "Uploads a file (base64) to generate's storage and returns a stable URL, for a model input that takes one (a reference image, an audio clip to transform).",
        name: "generate_upload",
        title: "Upload a model input",
      }),
    )
    .input(
      z.object({
        content: z.base64().describe("The file, base64-encoded"),
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
      let response: Response;
      try {
        response = await fetch(uploadUrl, {
          body: Uint8Array.from(atob(input.content), (char) => char.codePointAt(0) ?? 0),
          headers: { "Content-Type": input.content_type },
          method: "PUT",
        });
      } catch (error) {
        throw new ORPCError("BAD_GATEWAY", {
          cause: error,
          message: "Storage could not be reached.",
        });
      }
      if (!response.ok) {
        throw new ORPCError("BAD_GATEWAY", { message: `Upload failed: ${response.status}.` });
      }
      return { url: fileUrl };
    }),
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
      return skill;
    }),
};
