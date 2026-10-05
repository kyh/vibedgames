import { setTimeout as sleep } from "node:timers/promises";
import type { jobInput } from "@repo/contract/generate/generate-schema";
import type { JsonValue } from "@repo/contract/json";
import { ORPCError } from "@orpc/server";
import { z } from "zod";

import type { FalCallContext, FalQuery } from "./fal-call";
import { os, requireSession } from "../orpc";
import { callFal } from "./fal-call";
import { endpointPath, requestPath } from "./queue-paths";

// ---- Helpers ------------------------------------------------------------------

const httpsUrl = z.url({ protocol: /^https$/u });

const uploadSlotResponse = z.looseObject({ file_url: httpsUrl, upload_url: httpsUrl });

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

const authed = os.generate.use(requireSession);

/**
 * Every procedure is one or more `callFal` hops: the server owns each
 * provider path, so the CLI and the MCP tools share one implementation and
 * one credit gate.
 */
export const generateRouter = {
  cancel: authed.cancel.handler(async ({ context, input }) => {
    const body = await callFal(context, {
      method: "PUT",
      path: requestPath(input.endpointId, input.requestId, "/cancel"),
      target: "queue",
    });
    await confirmCancelled(context, input);
    return body;
  }),

  docs: authed.docs.handler(({ context, input }) =>
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
   * procedures here: the caller builds the path, the server attaches the
   * key and the credit gate.
   */
  forward: authed.forward.handler(({ context, input }) => callFal(context, input)),

  models: authed.models.handler(({ context, input }) => {
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

  pricing: authed.pricing.handler(({ context, input }) =>
    callFal(context, {
      method: "GET",
      path: "/v1/models/pricing",
      query: { endpoint_id: input.endpointId },
      target: "platform",
    }),
  ),

  result: authed.result.handler(({ context, input }) =>
    callFal(context, {
      method: "GET",
      path: requestPath(input.endpointId, input.requestId, ""),
      target: "queue",
    }),
  ),

  schema: authed.schema.handler(({ context, input }) => {
    const query: FalQuery = { endpoint_id: input.endpointId, limit: "1" };
    if (input.format === "openapi") {
      query.expand = ["openapi-3.0"];
    }
    return callFal(context, { method: "GET", path: "/v1/models", query, target: "platform" });
  }),

  status: authed.status.handler(({ context, input }) =>
    callFal(context, {
      method: "GET",
      path: requestPath(input.endpointId, input.requestId, "/status"),
      query: input.logs ? { logs: "1" } : undefined,
      target: "queue",
    }),
  ),

  submit: authed.submit.handler(async ({ context, input }) => {
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

  uploadSlot: authed.uploadSlot.handler(async ({ context, input }) => {
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
