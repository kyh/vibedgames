import { TRPCError } from "@trpc/server";
import { z } from "zod";

import type { MediaProviderConfig } from "../trpc";
import { createTRPCRouter, protectedProcedure } from "../trpc";
import {
  getFalClient,
  getModelSchema,
  getPricing,
  initiateStorageUpload,
  listModels,
  searchDocs,
  type FalConfig,
} from "./fal-client";
import { MAX_INPUT_FILE_BYTES, MAX_PARAMS_BYTES } from "./limits";
import { isRecord } from "./provider-io";

// ---- Schemas ----------------------------------------------------------------

const uploadInput = z.object({
  filename: z.string().min(1).max(256),
  contentType: z.string().min(1).max(127),
  sizeBytes: z.number().int().positive().max(MAX_INPUT_FILE_BYTES),
});

const endpointIdSchema = z.string().min(1).max(256);
const requestIdSchema = z.string().min(1).max(256);

const runInput = z.object({
  endpoint_id: endpointIdSchema,
  input: z.record(z.string(), z.unknown()).default({}),
});

const statusInput = z.object({
  endpoint_id: endpointIdSchema,
  request_id: requestIdSchema,
  action: z.enum(["status", "result", "cancel"]).default("status"),
  logs: z.boolean().default(false),
});

const modelsInput = z.object({
  q: z.string().max(256).optional(),
  category: z.string().max(64).optional(),
  status: z.enum(["active", "deprecated", "all"]).default("active"),
  limit: z.number().int().min(1).max(100).default(20),
  cursor: z.string().max(512).optional(),
  endpoint_ids: z.array(endpointIdSchema).max(50).default([]),
  expand: z.array(z.string().max(64)).max(8).default([]),
});

const schemaInput = z.object({
  endpoint_id: endpointIdSchema,
  format: z.enum(["compact", "openapi"]).default("compact"),
});

const pricingInput = z.object({
  endpoint_id: endpointIdSchema,
});

const docsInput = z.object({
  query: z.string().min(1).max(512),
});

// ---- Helpers ----------------------------------------------------------------

function pickFalConfig(media: MediaProviderConfig | undefined): FalConfig {
  if (!media?.fal) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "fal is not configured on the server (FAL_API_KEY missing).",
    });
  }
  return {
    apiKey: media.fal,
    queueBaseUrl: nonBlank(media.falQueueBaseUrl),
    platformBaseUrl: nonBlank(media.falPlatformBaseUrl),
    docsBaseUrl: nonBlank(media.falDocsBaseUrl),
  };
}

function nonBlank(value: string | undefined): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function jsonByteLength(value: unknown): number {
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "input must be JSON-serializable.",
    });
  }
  return new TextEncoder().encode(serialized).byteLength;
}

// ---- Router -----------------------------------------------------------------

export const mediaRouter = createTRPCRouter({
  /**
   * Provision a fal-issued upload slot. The client PUTs bytes directly
   * to `uploadUrl` (fal's presigned storage URL) and references
   * `fileUrl` (the resulting fal CDN URL) in subsequent `media.run`
   * calls. The proxy never sees the bytes — its only job here is
   * brokering the fal API key.
   */
  upload: protectedProcedure.input(uploadInput).mutation(async ({ ctx, input }) => {
    const cfg = pickFalConfig(ctx.media);
    const slot = await initiateStorageUpload(cfg, {
      filename: input.filename,
      contentType: input.contentType,
    });
    return slot;
  }),

  /**
   * Submit a job to fal's queue and return the request_id immediately.
   * Sync waits are the *client's* job — see `media.status` with
   * action: "status" / "result". Keeping the Worker out of the poll
   * loop avoids long-lived requests (and Worker timeouts) for
   * video/3D models that can take minutes.
   */
  run: protectedProcedure.input(runInput).mutation(async ({ ctx, input }) => {
    const cfg = pickFalConfig(ctx.media);

    const inputBytes = jsonByteLength(input.input);
    if (inputBytes > MAX_PARAMS_BYTES) {
      throw new TRPCError({
        code: "PAYLOAD_TOO_LARGE",
        message: `input exceeds ${MAX_PARAMS_BYTES} bytes.`,
      });
    }

    const fal = getFalClient(cfg);
    const submission = await fal.queue.submit(input.endpoint_id, { input: input.input });
    return {
      status: "submitted" as const,
      endpoint_id: input.endpoint_id,
      request_id: submission.request_id,
    };
  }),

  /**
   * Inspect, fetch, or cancel a queued job. Mirrors `genmedia status`.
   */
  status: protectedProcedure.input(statusInput).mutation(async ({ ctx, input }) => {
    const cfg = pickFalConfig(ctx.media);
    const fal = getFalClient(cfg);

    if (input.action === "cancel") {
      await fal.queue.cancel(input.endpoint_id, { requestId: input.request_id });
      return {
        action: "cancel" as const,
        endpoint_id: input.endpoint_id,
        request_id: input.request_id,
      };
    }
    if (input.action === "result") {
      const { data } = await fal.queue.result(input.endpoint_id, {
        requestId: input.request_id,
      });
      return {
        action: "result" as const,
        endpoint_id: input.endpoint_id,
        request_id: input.request_id,
        result: data,
      };
    }
    const status = await fal.queue.status(input.endpoint_id, {
      requestId: input.request_id,
      logs: input.logs,
    });
    return {
      action: "status" as const,
      endpoint_id: input.endpoint_id,
      request_id: input.request_id,
      status: status.status,
      queue_position: "queue_position" in status ? status.queue_position : undefined,
      logs: "logs" in status ? status.logs : undefined,
    };
  }),

  /**
   * Search/list fal models. Proxies https://api.fal.ai/v1/models.
   */
  models: protectedProcedure.input(modelsInput).query(async ({ ctx, input }) => {
    const cfg = pickFalConfig(ctx.media);
    const data = await listModels(cfg, {
      q: input.q,
      category: input.category,
      status: input.status === "all" ? undefined : input.status,
      limit: input.limit,
      cursor: input.cursor,
      endpoint_ids: input.endpoint_ids,
      expand: input.expand,
    });
    return passthrough(data);
  }),

  /**
   * Fetch a single model's input/output schema (compact or OpenAPI 3.0).
   */
  schema: protectedProcedure.input(schemaInput).query(async ({ ctx, input }) => {
    const cfg = pickFalConfig(ctx.media);
    const data = await getModelSchema(cfg, input.endpoint_id, input.format);
    return passthrough(data);
  }),

  /**
   * Fetch pricing metadata for a model.
   */
  pricing: protectedProcedure.input(pricingInput).query(async ({ ctx, input }) => {
    const cfg = pickFalConfig(ctx.media);
    const data = await getPricing(cfg, input.endpoint_id);
    return passthrough(data);
  }),

  /**
   * Search fal docs.
   */
  docs: protectedProcedure.input(docsInput).query(async ({ ctx, input }) => {
    const cfg = pickFalConfig(ctx.media);
    const data = await searchDocs(cfg, input.query);
    return passthrough(data);
  }),
});

function passthrough(data: unknown): Record<string, unknown> {
  // Wrap raw fal payloads so tRPC + superjson can transport them as a
  // plain object regardless of the upstream shape (which may be an array,
  // primitive, etc. for some endpoints).
  if (isRecord(data)) return data;
  return { data };
}
