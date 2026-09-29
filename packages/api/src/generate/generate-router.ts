import { setTimeout as sleep } from "node:timers/promises";
import { ORPCError } from "@orpc/server";
import { z } from "zod";

import type { JsonValue } from "../json";
import type { FalCallContext, FalQuery } from "./fal-call";
import { jsonValueSchema } from "../json";
import { documented } from "../openapi";
import { protectedProcedure } from "../orpc";
import { callFal, falRequestSchema } from "./fal-call";
import { endpointPath, requestPath } from "./queue-paths";

// ---- Schemas ------------------------------------------------------------------

// fal ids are `{owner}/{model}[/{subpath}...]`, passed through verbatim. The
// character set keeps an id to path segments; `callFal` still rejects `..`.
const endpointIdSchema = z
  .string()
  .min(3)
  .max(256)
  .regex(/^\/*[\w.-]+(?:\/[\w.-]+)+\/*$/u, "endpointId must look like owner/model[/subpath]")
  .describe("Model endpoint id, e.g. fal-ai/flux/dev.");

const requestIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[\w-]+$/u, "requestId must be a queue request id")
  .describe("The request_id returned by generate.submit.");

const jobInput = z.object({ endpointId: endpointIdSchema, requestId: requestIdSchema });

const rawOutput = jsonValueSchema.describe("The upstream response body, or null when it had none.");

const httpsUrl = z.url({ protocol: /^https$/u });

const uploadSlotResponse = z.looseObject({ file_url: httpsUrl, upload_url: httpsUrl });

// ---- Helpers ------------------------------------------------------------------

const readStatus = (body: JsonValue): string => {
  const parsed = z.looseObject({ status: z.string() }).safeParse(body);
  return parsed.success ? parsed.data.status.toUpperCase() : "";
};

// fal confirms cancellation asynchronously and the credit hold is released
// only when a status poll sees the terminal state, so poll a few times here
// rather than leaving the refund to whenever the caller next asks.
// Best-effort: a miss just defers the refund to the next status call.
const confirmCancelled = async (
  context: FalCallContext,
  input: z.infer<typeof jobInput>,
): Promise<void> => {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await sleep(1000);
    try {
      const poll = await callFal(context, {
        method: "GET",
        path: requestPath(input.endpointId, input.requestId, "/status"),
        target: "queue",
      });
      if (["CANCELLED", "FAILED", "COMPLETED"].includes(readStatus(poll))) {
        return;
      }
    } catch {
      return;
    }
  }
};

// ---- Router -------------------------------------------------------------------

export const generateRouter = {
  cancel: protectedProcedure
    .meta(
      documented({
        description:
          "Cancels a queued generation job and waits briefly for the provider to confirm, so its credit hold is refunded. Returns the upstream cancel response.",
        errors: [412, 502],
        summary: "Cancel a generation job",
      }),
    )
    .input(jobInput)
    .output(rawOutput)
    .handler(async ({ context, input }) => {
      const body = await callFal(context, {
        method: "PUT",
        path: requestPath(input.endpointId, input.requestId, "/cancel"),
        target: "queue",
      });
      await confirmCancelled(context, input);
      return body;
    }),

  docs: protectedProcedure
    .meta(
      documented({
        description:
          "Searches the generative-model documentation (prompting guides, parameters, model notes). Returns the raw search result.",
        errors: [412, 502],
        summary: "Search model documentation",
      }),
    )
    .input(z.object({ query: z.string().min(1).max(500).describe("What to look up.") }))
    .output(rawOutput)
    .handler(({ context, input }) =>
      callFal(context, {
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

  /**
   * The raw proxy hop, kept for CLI releases that predate the typed
   * procedures above. New callers use those; this carries no MCP tool.
   */
  forward: protectedProcedure
    .meta(
      documented({
        description:
          "Forwards one request to the media-generation API with the server's key. Superseded by the typed generate procedures; kept for older `vg` releases. Queue submits need a positive credit balance (403 `insufficient_credits` otherwise) and are billed on the result fetch.",
        errors: [403, 412, 413, 429, 502],
        summary: "Proxy a media-generation request",
      }),
    )
    .input(falRequestSchema)
    .output(rawOutput)
    .handler(({ context, input }) => callFal(context, input)),

  models: protectedProcedure
    .meta(
      documented({
        description:
          "Searches and lists available generation models (image, video, audio, 3D, ...). Returns `{ models, next_cursor, has_more }` as the provider reports it.",
        errors: [412, 502],
        summary: "Search models",
      }),
    )
    .input(
      z.object({
        category: z.string().max(64).optional().describe("Filter by category, e.g. text-to-image."),
        cursor: z.string().max(512).optional().describe("Pagination cursor from a prior response."),
        endpointIds: z
          .array(endpointIdSchema)
          .max(50)
          .optional()
          .describe("Look up specific endpoint ids."),
        expand: z
          .array(z.enum(["openapi-3.0", "enterprise_status"]))
          .optional()
          .describe("Extra fields to include."),
        limit: z.number().int().min(1).max(100).default(20),
        query: z.string().max(200).optional().describe("Free-text search."),
        status: z.enum(["active", "deprecated", "all"]).default("active"),
      }),
    )
    .output(rawOutput)
    .handler(({ context, input }) => {
      const query: FalQuery = { limit: String(input.limit) };
      if (input.query) {
        query.q = input.query;
      }
      if (input.category) {
        query.category = input.category;
      }
      if (input.status !== "all") {
        query.status = input.status;
      }
      if (input.cursor) {
        query.cursor = input.cursor;
      }
      if (input.endpointIds?.length) {
        query.endpoint_id = input.endpointIds;
      }
      if (input.expand?.length) {
        query.expand = input.expand;
      }
      return callFal(context, { method: "GET", path: "/v1/models", query, target: "platform" });
    }),

  pricing: protectedProcedure
    .meta(
      documented({
        description: "Returns the per-unit price of one model endpoint.",
        errors: [412, 502],
        summary: "Model pricing",
      }),
    )
    .input(z.object({ endpointId: endpointIdSchema }))
    .output(rawOutput)
    .handler(({ context, input }) =>
      callFal(context, {
        method: "GET",
        path: "/v1/models/pricing",
        query: { endpoint_id: input.endpointId },
        target: "platform",
      }),
    ),

  result: protectedProcedure
    .meta(
      documented({
        description:
          "Fetches a completed job's output (hosted media URLs plus model metadata) and settles its credit charge to actual usage.",
        errors: [412, 502],
        summary: "Fetch a job result",
      }),
    )
    .input(jobInput)
    .output(rawOutput)
    .handler(({ context, input }) =>
      callFal(context, {
        method: "GET",
        path: requestPath(input.endpointId, input.requestId, ""),
        target: "queue",
      }),
    ),

  schema: protectedProcedure
    .meta(
      documented({
        description:
          "Returns one model's metadata; `format: openapi` includes its full input/output OpenAPI schema. Read it before `generate.submit` to learn the accepted input.",
        errors: [412, 502],
        summary: "Model input/output schema",
      }),
    )
    .input(
      z.object({
        endpointId: endpointIdSchema,
        format: z.enum(["compact", "openapi"]).default("compact"),
      }),
    )
    .output(rawOutput)
    .handler(({ context, input }) => {
      const query: FalQuery = { endpoint_id: input.endpointId, limit: "1" };
      if (input.format === "openapi") {
        query.expand = ["openapi-3.0"];
      }
      return callFal(context, { method: "GET", path: "/v1/models", query, target: "platform" });
    }),

  status: protectedProcedure
    .meta(
      documented({
        description:
          "Reports a job's queue status (IN_QUEUE, IN_PROGRESS, COMPLETED, FAILED, CANCELLED). A FAILED or CANCELLED status refunds the job's credit hold.",
        errors: [412, 502],
        summary: "Job status",
      }),
    )
    .input(jobInput.extend({ logs: z.boolean().default(false).describe("Include model logs.") }))
    .output(rawOutput)
    .handler(({ context, input }) =>
      callFal(context, {
        method: "GET",
        path: requestPath(input.endpointId, input.requestId, "/status"),
        query: input.logs ? { logs: "1" } : undefined,
        target: "queue",
      }),
    ),

  submit: protectedProcedure
    .meta(
      documented({
        description:
          "Queues one generation job and returns its request id. Needs a positive credit balance (403 `insufficient_credits` otherwise); an estimated hold is taken now and settled when the result is fetched.",
        errors: [403, 412, 413, 429, 502],
        summary: "Submit a generation job",
      }),
    )
    .input(
      z.object({
        endpointId: endpointIdSchema,
        input: z
          .record(z.string(), jsonValueSchema)
          .describe("The model's input, as described by generate.schema."),
      }),
    )
    .output(z.object({ requestId: z.string() }))
    .handler(async ({ context, input }) => {
      const body = await callFal(context, {
        body: input.input,
        method: "POST",
        path: `/${endpointPath(input.endpointId)}`,
        target: "queue",
      });
      const parsed = z.looseObject({ request_id: z.string().min(1) }).safeParse(body);
      if (!parsed.success) {
        throw new ORPCError("BAD_GATEWAY", {
          message: "queue submit did not return a request_id.",
        });
      }
      return { requestId: parsed.data.request_id };
    }),

  uploadSlot: protectedProcedure
    .meta(
      documented({
        description:
          "Reserves a hosted file for a model input. PUT the bytes to `uploadUrl` with the same Content-Type, then pass `fileUrl` in a job's input; it stays valid across jobs.",
        errors: [412, 502],
        summary: "Reserve an input-file upload",
      }),
    )
    .input(
      z.object({
        contentType: z.string().min(1).max(127),
        fileName: z.string().min(1).max(255),
      }),
    )
    .output(z.object({ fileUrl: z.string(), uploadUrl: z.string() }))
    .handler(async ({ context, input }) => {
      const body = await callFal(context, {
        body: { content_type: input.contentType, file_name: input.fileName },
        method: "POST",
        path: "/storage/upload/initiate",
        target: "storage",
      });
      // Refuse a non-HTTPS slot even from the provider: the caller sends user
      // bytes to it, and the file URL is reused as input to later jobs.
      const parsed = uploadSlotResponse.safeParse(body);
      if (!parsed.success) {
        throw new ORPCError("BAD_GATEWAY", {
          message: "upload initiate response is missing an HTTPS upload_url or file_url.",
        });
      }
      return { fileUrl: parsed.data.file_url, uploadUrl: parsed.data.upload_url };
    }),
};
