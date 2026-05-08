import { TRPCError } from "@trpc/server";
import { z } from "zod";

import { presignGet, presignPut } from "../deploy/r2-presign";
import type { MediaProviderConfig, R2Config } from "../trpc";
import { createTRPCRouter, protectedProcedure } from "../trpc";
import {
  cancelQueue,
  fetchQueueResult,
  getModelSchema,
  getPricing,
  listModels,
  pollUntilComplete,
  queueUrlsFor,
  searchDocs,
  statusQueue,
  submitQueue,
  type FalConfig,
} from "./fal-client";
import {
  MAX_INPUT_FILE_BYTES,
  MAX_INPUT_FILES,
  MAX_INPUT_TOTAL_BYTES,
  MAX_PARAMS_BYTES,
} from "./limits";
import { isRecord } from "./provider-io";

const PRESIGN_TTL_SECONDS = 86400;
const INPUT_UPLOAD_TTL_SECONDS = 900;

// ---- Schemas ----------------------------------------------------------------

const inputUploadSchema = z.object({
  filename: z.string().min(1).max(256),
  contentType: z.string().min(1).max(127),
  sizeBytes: z.number().int().positive().max(MAX_INPUT_FILE_BYTES),
});

const createInputUploadsInput = z.object({
  files: z.array(inputUploadSchema).min(1).max(MAX_INPUT_FILES),
});

const cleanupInputUploadsInput = z.object({
  keys: z.array(z.string().min(1).max(512)).max(MAX_INPUT_FILES),
});

const endpointIdSchema = z.string().min(1).max(256);
const requestIdSchema = z.string().min(1).max(256);

const runInput = z.object({
  endpoint_id: endpointIdSchema,
  input: z.record(z.string(), z.unknown()).default({}),
  async: z.boolean().default(false),
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

function requireR2(r2: R2Config | undefined): R2Config {
  if (!r2) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "R2 is not configured on this worker.",
    });
  }
  return r2;
}

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

function assertInputKeyOwnedByUser(key: string, userId: string): void {
  const prefix = `media-inputs/${userId}/`;
  if (!key.startsWith(prefix)) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "Input file ref does not belong to this user.",
    });
  }
}

function inputUploadKey(userId: string, uploadId: string, index: number): string {
  return `media-inputs/${userId}/${uploadId}/${String(index + 1).padStart(2, "0")}`;
}

function assertInputTotalBytes(files: Array<{ sizeBytes: number }>): void {
  const total = files.reduce((sum, f) => sum + f.sizeBytes, 0);
  if (total > MAX_INPUT_TOTAL_BYTES) {
    throw new TRPCError({
      code: "PAYLOAD_TOO_LARGE",
      message: `Input files total ${total} bytes exceeds ${MAX_INPUT_TOTAL_BYTES} bytes.`,
    });
  }
}

// ---- Router -----------------------------------------------------------------

export const mediaRouter = createTRPCRouter({
  /**
   * Mint short-lived R2 PUT URLs for media inputs. The CLI uploads to these,
   * then references the resulting presigned GET URLs in the `input` payload
   * of `media.run` (e.g. as `image_url`). fal fetches the URLs server-side.
   */
  createInputUploads: protectedProcedure
    .input(createInputUploadsInput)
    .mutation(async ({ ctx, input }) => {
      assertInputTotalBytes(input.files);
      const r2 = requireR2(ctx.r2);
      const userId = ctx.session.user.id;
      const uploadId = crypto.randomUUID();

      const uploads = await Promise.all(
        input.files.map(async (file, index) => {
          const key = inputUploadKey(userId, uploadId, index);
          const [putUrl, getUrl] = await Promise.all([
            presignPut({
              r2,
              key,
              contentType: file.contentType,
              expiresInSeconds: INPUT_UPLOAD_TTL_SECONDS,
            }),
            presignGet({ r2, key, expiresInSeconds: PRESIGN_TTL_SECONDS }),
          ]);
          return {
            putUrl,
            getUrl,
            headers: { "content-type": file.contentType },
            ref: {
              key,
              filename: file.filename,
              contentType: file.contentType,
              sizeBytes: file.sizeBytes,
            },
          };
        }),
      );

      return { uploads };
    }),

  cleanupInputUploads: protectedProcedure
    .input(cleanupInputUploadsInput)
    .mutation(async ({ ctx, input }) => {
      const r2 = requireR2(ctx.r2);
      const userId = ctx.session.user.id;
      for (const key of input.keys) assertInputKeyOwnedByUser(key, userId);
      await Promise.all(input.keys.map((key) => r2.bucket.delete(key)));
      return { deleted: input.keys.length };
    }),

  /**
   * Submit a job to fal's queue. With `async: false` (the default), poll
   * until completion and return the raw result. With `async: true`, return
   * the request_id immediately so callers can poll via `media.status`.
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

    const submission = await submitQueue(cfg, input.endpoint_id, input.input);
    const requestId = submission.request_id;
    if (!requestId) {
      throw new TRPCError({
        code: "BAD_GATEWAY",
        message: "fal queue submit did not return a request_id.",
      });
    }

    if (input.async) {
      return {
        status: "submitted" as const,
        endpoint_id: input.endpoint_id,
        request_id: requestId,
      };
    }

    const urls = queueUrlsFor(cfg, input.endpoint_id, requestId, submission);
    await pollUntilComplete(cfg, urls.statusUrl);
    const { data, billableUnits } = await fetchQueueResult(cfg, urls.responseUrl);

    return {
      status: "completed" as const,
      endpoint_id: input.endpoint_id,
      request_id: requestId,
      result: data,
      billable_units: billableUnits,
    };
  }),

  /**
   * Inspect, fetch, or cancel a queued job. Mirrors `genmedia status`.
   */
  status: protectedProcedure.input(statusInput).mutation(async ({ ctx, input }) => {
    const cfg = pickFalConfig(ctx.media);
    const urls = queueUrlsFor(cfg, input.endpoint_id, input.request_id);

    if (input.action === "cancel") {
      await cancelQueue(cfg, urls.cancelUrl);
      return {
        action: "cancel" as const,
        endpoint_id: input.endpoint_id,
        request_id: input.request_id,
      };
    }
    if (input.action === "result") {
      const { data, billableUnits } = await fetchQueueResult(cfg, urls.responseUrl);
      return {
        action: "result" as const,
        endpoint_id: input.endpoint_id,
        request_id: input.request_id,
        result: data,
        billable_units: billableUnits,
      };
    }
    const status = await statusQueue(cfg, urls.statusUrl, { logs: input.logs });
    return {
      action: "status" as const,
      endpoint_id: input.endpoint_id,
      request_id: input.request_id,
      ...status,
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
