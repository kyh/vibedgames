import { TRPCError } from "@trpc/server";
import { z } from "zod";

import { presignGet } from "../deploy/r2-presign";
import type { ImageProviderKeys, R2Config } from "../trpc";
import { createTRPCRouter, protectedProcedure } from "../trpc";
import { falImageProvider } from "./providers/fal";
import { openaiImageProvider } from "./providers/openai";
import { retroDiffusionImageProvider } from "./providers/retro-diffusion";
import type {
  ImageInputFile,
  ImageProvider,
  ImageProviderRequest,
} from "./types";

// ---- Limits ------------------------------------------------------------------

const MAX_INPUT_IMAGES = 8;
const MAX_INPUT_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_OUTPUT_IMAGE_BYTES = 25 * 1024 * 1024;
const PRESIGN_TTL_SECONDS = 3600;

// ---- Schemas -----------------------------------------------------------------

const providerEnum = z.enum(["openai", "fal", "retro-diffusion"]);
const taskEnum = z.enum(["generate", "edit"]);

const inputImageSchema = z.object({
  filename: z.string().min(1).max(256),
  contentType: z.string().min(1).max(127),
  base64: z.string().min(1),
});

const runInput = z.object({
  provider: providerEnum,
  task: taskEnum,
  model: z.string().min(1).max(256),
  prompt: z.string().min(1).max(8000),
  params: z.record(z.string(), z.unknown()).default({}),
  inputImages: z.array(inputImageSchema).max(MAX_INPUT_IMAGES).default([]),
});

// ---- Helpers -----------------------------------------------------------------

function requireR2(r2: R2Config | undefined): R2Config {
  if (!r2) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "R2 is not configured on this worker.",
    });
  }
  return r2;
}

function pickApiKey(
  provider: z.infer<typeof providerEnum>,
  keys: ImageProviderKeys | undefined,
): string {
  const value =
    provider === "openai"
      ? keys?.openai
      : provider === "fal"
        ? keys?.fal
        : keys?.retroDiffusion;
  if (!value) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: `Image provider "${provider}" is not configured on the server.`,
    });
  }
  return value;
}

function pickProvider(
  provider: z.infer<typeof providerEnum>,
): ImageProvider {
  if (provider === "openai") return openaiImageProvider;
  if (provider === "fal") return falImageProvider;
  return retroDiffusionImageProvider;
}

function decodeBase64(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

function decodeInputImages(
  raw: z.infer<typeof inputImageSchema>[],
): ImageInputFile[] {
  return raw.map((image, index) => {
    const bytes = decodeBase64(image.base64);
    if (bytes.byteLength === 0) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: `Input image ${index} is empty.`,
      });
    }
    if (bytes.byteLength > MAX_INPUT_IMAGE_BYTES) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: `Input image ${index} exceeds ${MAX_INPUT_IMAGE_BYTES} bytes.`,
      });
    }
    return {
      filename: image.filename,
      contentType: image.contentType,
      bytes,
    };
  });
}

// ---- Router ------------------------------------------------------------------

export const imageRouter = createTRPCRouter({
  /**
   * Run a single image generation or edit through the configured provider,
   * write the outputs to R2 under `image-runs/{userId}/{runId}/`, and return
   * presigned GET URLs the caller can download from.
   *
   * The router is a thin proxy: it does not flatten provider-specific knobs
   * into a unified schema. Callers pass `params` through as the provider's
   * native input (e.g. `quality` for OpenAI, `aspect_ratio` for fal,
   * `frames_duration` for Retro Diffusion).
   */
  run: protectedProcedure
    .input(runInput)
    .mutation(async ({ ctx, input }) => {
      const r2 = requireR2(ctx.r2);
      const apiKey = pickApiKey(input.provider, ctx.imageProviders);
      const provider = pickProvider(input.provider);

      const inputImages = decodeInputImages(input.inputImages);
      if (input.task === "edit" && inputImages.length === 0) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Edit jobs require at least one input image.",
        });
      }

      const providerRequest: ImageProviderRequest = {
        task: input.task,
        model: input.model,
        prompt: input.prompt,
        params: input.params,
        inputImages,
        apiKey,
      };

      const result = await provider.run(providerRequest);
      if (result.outputs.length === 0) {
        // Allow zero outputs for cost-only runs (e.g. retro-diffusion check_cost).
        return {
          runId: crypto.randomUUID(),
          provider: input.provider,
          model: input.model,
          outputs: [] as Array<{
            url: string;
            contentType: string;
            sizeBytes: number;
            filename: string;
          }>,
          metadata: result.metadata,
        };
      }

      const userId = ctx.session.user.id;
      const runId = crypto.randomUUID();

      const outputs = await Promise.all(
        result.outputs.map(async (out, index) => {
          if (out.bytes.byteLength > MAX_OUTPUT_IMAGE_BYTES) {
            throw new TRPCError({
              code: "INTERNAL_SERVER_ERROR",
              message: `Output ${index} exceeds ${MAX_OUTPUT_IMAGE_BYTES} bytes.`,
            });
          }
          const seq = String(index + 1).padStart(2, "0");
          const filename = `output-${seq}${out.extension}`;
          const key = `image-runs/${userId}/${runId}/${filename}`;
          await r2.bucket.put(key, out.bytes as ArrayBufferView, {
            httpMetadata: { contentType: out.contentType },
          });
          const url = await presignGet({
            r2,
            key,
            expiresInSeconds: PRESIGN_TTL_SECONDS,
          });
          return {
            url,
            contentType: out.contentType,
            sizeBytes: out.bytes.byteLength,
            filename,
          };
        }),
      );

      return {
        runId,
        provider: input.provider,
        model: input.model,
        outputs,
        metadata: result.metadata,
      };
    }),
});
