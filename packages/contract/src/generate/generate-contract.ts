import { z } from "zod";

import { protectedBase } from "../base";
import { jsonValueSchema } from "../json";
import { mcpTool, notMcpTool } from "../mcp";
import { documented } from "../openapi";
import {
  docsInput,
  forwardInput,
  jobInput,
  modelsInput,
  pricingInput,
  schemaInput,
  statusInput,
  submitInput,
  uploadSlotInput,
} from "./generate-schema";

const rawOutput = jsonValueSchema.describe("The upstream response body, or null when it had none.");

export const generateContract = {
  cancel: protectedBase
    .meta(mcpTool({ access: "destructive", title: "Cancel a generation job" }))
    .meta(
      documented({
        description:
          "Cancels a queued generation job and waits briefly for the provider to confirm, so its credit hold is refunded. Returns the upstream cancel response.",
        errors: [412, 502],
        summary: "Cancel a generation job",
      }),
    )
    .input(jobInput)
    .output(rawOutput),

  docs: protectedBase
    .meta(mcpTool({ access: "read", title: "Search model docs" }))
    .meta(
      documented({
        description:
          "Searches the generative-model documentation (prompting guides, parameters, model notes). Returns the raw search result.",
        errors: [412, 502],
        summary: "Search model documentation",
      }),
    )
    .input(docsInput)
    .output(rawOutput),

  /**
   * The raw proxy hop, kept for CLI releases that predate the typed
   * procedures here. New callers use those; this carries no MCP tool.
   */
  forward: protectedBase
    .meta(
      notMcpTool(
        "Raw provider proxy kept for old CLI releases; the typed generate tools cover it.",
      ),
    )
    .meta(
      documented({
        description:
          "Forwards one request to the media-generation API with the server's key: `target` picks the host (queue, platform, storage, docs), `path`/`query`/`body` the rest. Returns the upstream JSON body. Superseded by the typed generate procedures; kept for older `vg` releases. Queue submits are billed on the result fetch, and need a positive credit balance (403 `insufficient_credits` otherwise) unless the caller is an admin, whose submits are billed but never refused.",
        errors: [403, 412, 413, 502],
        summary: "Proxy a media-generation request",
      }),
    )
    .input(forwardInput)
    .output(rawOutput),

  models: protectedBase
    .meta(mcpTool({ access: "read", title: "Search models" }))
    .meta(
      documented({
        description:
          "Searches and lists available generation models (image, video, audio, 3D, ...). Returns `{ models, next_cursor, has_more }` as the provider reports it.",
        errors: [412, 502],
        summary: "Search models",
      }),
    )
    .input(modelsInput)
    .output(rawOutput),

  pricing: protectedBase
    .meta(mcpTool({ access: "read", title: "Model pricing" }))
    .meta(
      documented({
        description: "Returns the per-unit price of one model endpoint.",
        errors: [412, 502],
        summary: "Model pricing",
      }),
    )
    .input(pricingInput)
    .output(rawOutput),

  result: protectedBase
    .meta(mcpTool({ access: "read", title: "Fetch a job result" }))
    .meta(
      documented({
        description:
          "Fetches a completed job's output (hosted media URLs plus model metadata) and settles its credit charge to actual usage.",
        errors: [412, 502],
        summary: "Fetch a job result",
      }),
    )
    .input(jobInput)
    .output(rawOutput),

  schema: protectedBase
    .meta(mcpTool({ access: "read", title: "Model schema" }))
    .meta(
      documented({
        description:
          "Returns one model's metadata; `format: openapi` includes its full input/output OpenAPI schema. Read it before `generate.submit` to learn the accepted input.",
        errors: [412, 502],
        summary: "Model input/output schema",
      }),
    )
    .input(schemaInput)
    .output(rawOutput),

  status: protectedBase
    .meta(mcpTool({ access: "read", title: "Job status" }))
    .meta(
      documented({
        description:
          "Reports a job's queue status (IN_QUEUE, IN_PROGRESS, COMPLETED, FAILED, CANCELLED). A FAILED or CANCELLED status refunds the job's credit hold.",
        errors: [412, 502],
        summary: "Job status",
      }),
    )
    .input(statusInput)
    .output(rawOutput),

  submit: protectedBase
    .meta(mcpTool({ access: "write", title: "Generate media" }))
    .meta(
      documented({
        description:
          "Queues one generation job and returns its request id. Needs a positive credit balance (403 `insufficient_credits` otherwise) unless the caller is an admin, whose submits are billed but never refused. An estimated hold is taken now and settled when the result is fetched.",
        errors: [403, 412, 413, 502],
        summary: "Submit a generation job",
      }),
    )
    .input(submitInput)
    .output(z.object({ requestId: z.string() })),

  uploadSlot: protectedBase
    .meta(mcpTool({ access: "write", title: "Reserve an input upload" }))
    .meta(
      documented({
        description:
          "Reserves a hosted file for a model input. PUT the bytes to `uploadUrl` with the same Content-Type, then pass `fileUrl` in a job's input; it stays valid across jobs.",
        errors: [412, 502],
        summary: "Reserve an input-file upload",
      }),
    )
    .input(uploadSlotInput)
    .output(z.object({ fileUrl: z.string(), uploadUrl: z.string() })),
};
