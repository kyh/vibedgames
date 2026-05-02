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
// Cap serialized `params` to defend the Worker against pathological
// payloads. Providers that accept inline base64 (retro-diffusion's
// `input_image` / `reference_images` / `input_palette`) sit inside this
// budget; 32 MB easily fits a small input image plus several references
// at typical pixel-art sizes while staying well under the 128 MB Worker
// memory ceiling once both the parsed object and its serialized form
// coexist in memory.
const MAX_PARAMS_BYTES = 32 * 1024 * 1024;
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

const PROVIDER_BASE_URL_FIELDS = {
  openai: "openaiBaseUrl",
  fal: "falBaseUrl",
  "retro-diffusion": "retroDiffusionBaseUrl",
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

function pickBaseUrl(
  provider: z.infer<typeof providerEnum>,
  keys: ImageProviderKeys | undefined,
): string | undefined {
  return keys?.[PROVIDER_BASE_URL_FIELDS[provider]];
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

// ---- Catalog ----------------------------------------------------------------

/**
 * Curated catalog of well-known models per provider. The `vg models`
 * command surfaces this so users don't have to memorize fal endpoint ids
 * or retro-diffusion prompt_styles.
 */
const MODEL_CATALOG: Record<
  z.infer<typeof providerEnum>,
  { id: string; alias?: string; supports: ("generate" | "edit")[] }[]
> = {
  openai: [
    { id: "gpt-image-1.5", alias: "gpt-image-1.5", supports: ["generate", "edit"] },
    { id: "gpt-image-1", alias: "gpt-image-1", supports: ["generate", "edit"] },
    { id: "dall-e-3", alias: "dall-e-3", supports: ["generate"] },
    { id: "dall-e-2", alias: "dall-e-2", supports: ["generate", "edit"] },
  ],
  fal: [
    { id: "fal-ai/nano-banana-2", alias: "nano-banana-2", supports: ["generate"] },
    {
      id: "fal-ai/nano-banana-2/edit",
      alias: "nano-banana-2-edit",
      supports: ["edit"],
    },
    {
      id: "fal-ai/nano-banana-pro",
      alias: "nano-banana-pro",
      supports: ["generate"],
    },
    {
      id: "fal-ai/nano-banana-pro/edit",
      alias: "nano-banana-pro-edit",
      supports: ["edit"],
    },
    {
      id: "xai/grok-imagine-image",
      alias: "grok-imagine-image",
      supports: ["generate"],
    },
    {
      id: "xai/grok-imagine-image/edit",
      alias: "grok-imagine-image-edit",
      supports: ["edit"],
    },
  ],
  "retro-diffusion": [
    { id: "rd_pro__platformer", alias: "rd-pro-platformer", supports: ["generate"] },
    { id: "rd_pro__edit", alias: "rd-pro-edit", supports: ["edit"] },
    {
      id: "rd_pro__spritesheet",
      alias: "rd-pro-spritesheet",
      supports: ["generate"],
    },
  ],
};

// ---- Router ------------------------------------------------------------------

export const imageRouter = createTRPCRouter({
  /**
   * List the providers configured on this server and their well-known
   * models. Surfaces a stable `configured` flag per provider so the CLI
   * can mark unavailable rows.
   */
  list: protectedProcedure.query(({ ctx }) => {
    const keys = ctx.imageProviders;
    return IMAGE_PROVIDERS.map((provider) => ({
      provider,
      configured:
        provider === "openai"
          ? Boolean(keys?.openai)
          : provider === "fal"
            ? Boolean(keys?.fal)
            : Boolean(keys?.retroDiffusion),
      models: MODEL_CATALOG[provider],
    }));
  }),

  // Thin proxy: `params` is forwarded as each provider's native input
  // (e.g. `quality` for OpenAI, `aspect_ratio` for fal, `frames_duration`
  // for Retro Diffusion); we do not flatten knobs into a unified schema.
  run: protectedProcedure
    .input(runInput)
    .mutation(async ({ ctx, input }) => {
      const r2 = requireR2(ctx.r2);
      const apiKey = pickApiKey(input.provider, ctx.imageProviders);
      const provider = pickProvider(input.provider);

      const paramsByteLength = new TextEncoder().encode(
        JSON.stringify(input.params),
      ).length;
      if (paramsByteLength > MAX_PARAMS_BYTES) {
        throw new TRPCError({
          code: "PAYLOAD_TOO_LARGE",
          message: `params exceeds ${MAX_PARAMS_BYTES} bytes (got ${paramsByteLength}).`,
        });
      }

      const inputImages = decodeInputImages(input.inputImages);

      const providerRequest: ImageProviderRequest = {
        task: input.task,
        model: input.model,
        prompt: input.prompt,
        params: input.params,
        inputImages,
        apiKey,
        baseUrl: pickBaseUrl(input.provider, ctx.imageProviders),
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
          // presignGet is local CPU only (AWS Sig V4 over the known key)
          // and does not contact R2, so we run it in parallel with the put.
          // Both await before the URL is returned, and R2 read-after-write
          // is strongly consistent, so there is no race.
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
