import { TRPCError } from "@trpc/server";
import { z } from "zod";

import { presignGet } from "../deploy/r2-presign";
import type { ImageProviderKeys, R2Config } from "../trpc";
import { createTRPCRouter, protectedProcedure } from "../trpc";
import { base64ToBytes } from "./base64";
import { falImageProvider } from "./providers/fal";
import { openaiImageProvider } from "./providers/openai";
import { retroDiffusionImageProvider } from "./providers/retro-diffusion";
import { IMAGE_PROVIDERS } from "./types";
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

const providerEnum = z.enum(IMAGE_PROVIDERS);
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

const PROVIDER_KEY_FIELDS = {
  openai: "openai",
  fal: "fal",
  "retro-diffusion": "retroDiffusion",
} as const satisfies Record<z.infer<typeof providerEnum>, keyof ImageProviderKeys>;

function pickApiKey(
  provider: z.infer<typeof providerEnum>,
  keys: ImageProviderKeys | undefined,
): string {
  const value = keys?.[PROVIDER_KEY_FIELDS[provider]];
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

function decodeInputImages(
  raw: z.infer<typeof inputImageSchema>[],
): ImageInputFile[] {
  return raw.map((image, index) => {
    const bytes = base64ToBytes(image.base64);
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

function validateParamsImageSize(
  params: Record<string, unknown>,
  maxBytes: number,
): void {
  const checkBase64Size = (value: unknown, path: string) => {
    if (typeof value === "string" && value.length > 0) {
      const isBase64 =
        /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
          value.replace(/\s/g, ""),
        );
      if (isBase64 && value.length > 100) {
        try {
          const bytes = base64ToBytes(value);
          if (bytes.byteLength > maxBytes) {
            throw new TRPCError({
              code: "BAD_REQUEST",
              message: `Image data in params.${path} exceeds ${maxBytes} bytes.`,
            });
          }
        } catch (err) {
          if (err instanceof TRPCError) throw err;
        }
      }
    } else if (Array.isArray(value)) {
      value.forEach((item, idx) => checkBase64Size(item, `${path}[${idx}]`));
    }
  };

  for (const [key, value] of Object.entries(params)) {
    checkBase64Size(value, key);
  }
}

// ---- Router ------------------------------------------------------------------

export const imageRouter = createTRPCRouter({
  // Thin proxy: `params` is forwarded as each provider's native input
  // (e.g. `quality` for OpenAI, `aspect_ratio` for fal, `frames_duration`
  // for Retro Diffusion); we do not flatten knobs into a unified schema.
  run: protectedProcedure
    .input(runInput)
    .mutation(async ({ ctx, input }) => {
      const r2 = requireR2(ctx.r2);
      const apiKey = pickApiKey(input.provider, ctx.imageProviders);
      const provider = pickProvider(input.provider);

      const inputImages = decodeInputImages(input.inputImages);
      validateParamsImageSize(input.params, MAX_INPUT_IMAGE_BYTES);

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
          // presign is independent of the put completing — sign the URL in
          // parallel so the round-trip is one R2 latency instead of two.
          const [, url] = await Promise.all([
            r2.bucket.put(key, out.bytes as ArrayBufferView, {
              httpMetadata: { contentType: out.contentType },
            }),
            presignGet({ r2, key, expiresInSeconds: PRESIGN_TTL_SECONDS }),
          ]);
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
