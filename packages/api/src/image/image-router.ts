import { TRPCError } from "@trpc/server";
import { z } from "zod";

import { presignGet, presignPut } from "../deploy/r2-presign";
import type { ImageProviderKeys, R2Config } from "../trpc";
import { createTRPCRouter, protectedProcedure } from "../trpc";
import {
  MAX_INPUT_IMAGE_BYTES,
  MAX_INPUT_IMAGE_TOTAL_BYTES,
  MAX_INPUT_IMAGES,
  MAX_OUTPUT_IMAGE_BYTES,
  MAX_PARAMS_BYTES,
} from "./limits";
import { falImageProvider } from "./providers/fal";
import { openaiImageProvider } from "./providers/openai";
import { retroDiffusionImageProvider } from "./providers/retro-diffusion";
import { IMAGE_PROVIDERS } from "./types";
import type { ImageInputFile, ImageProvider, ImageProviderRequest } from "./types";

// ---- Limits ------------------------------------------------------------------

const PRESIGN_TTL_SECONDS = 3600;
const INPUT_UPLOAD_TTL_SECONDS = 900;

// ---- Schemas -----------------------------------------------------------------

const providerEnum = z.enum(IMAGE_PROVIDERS);
const taskEnum = z.enum(["generate", "edit"]);
const inputRoleEnum = z.enum(["image", "reference", "mask", "palette"]);

const inputImageSchema = z.object({
  role: inputRoleEnum,
  filename: z.string().min(1).max(256),
  contentType: z.string().min(1).max(127),
  sizeBytes: z.number().int().positive().max(MAX_INPUT_IMAGE_BYTES),
});

const inputImageRefSchema = inputImageSchema.extend({
  key: z.string().min(1).max(512),
});

const runInput = z.object({
  provider: providerEnum,
  task: taskEnum,
  model: z.string().min(1).max(256),
  prompt: z.string().min(1).max(8000),
  params: z.record(z.string(), z.unknown()).default({}),
  inputImages: z.array(inputImageRefSchema).max(MAX_INPUT_IMAGES).default([]),
});

const createInputUploadsInput = z.object({
  images: z.array(inputImageSchema).min(1).max(MAX_INPUT_IMAGES),
});

const cleanupInputUploadsInput = z.object({
  keys: z.array(z.string().min(1).max(512)).max(MAX_INPUT_IMAGES),
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
  // Treat blank/whitespace-only env values (e.g. an unset
  // `OPENAI_BASE_URL=""` in wrangler config) as missing so providers
  // don't have to defend against the empty-string case independently.
  const value = keys?.[PROVIDER_BASE_URL_FIELDS[provider]];
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function pickProvider(provider: z.infer<typeof providerEnum>): ImageProvider {
  if (provider === "openai") return openaiImageProvider;
  if (provider === "fal") return falImageProvider;
  return retroDiffusionImageProvider;
}

function jsonByteLength(value: unknown): number {
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "params must be JSON-serializable.",
    });
  }
  return new TextEncoder().encode(serialized).byteLength;
}

function assertInputKeyOwnedByUser(key: string, userId: string): void {
  const prefix = `image-inputs/${userId}/`;
  if (!key.startsWith(prefix)) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "Input image ref does not belong to this user.",
    });
  }
}

function inputUploadKey(userId: string, uploadId: string, index: number): string {
  return `image-inputs/${userId}/${uploadId}/${String(index + 1).padStart(2, "0")}`;
}

function assertInputTotalBytes(images: Array<{ sizeBytes: number }>): void {
  const totalBytes = images.reduce((sum, image) => sum + image.sizeBytes, 0);
  if (totalBytes > MAX_INPUT_IMAGE_TOTAL_BYTES) {
    throw new TRPCError({
      code: "PAYLOAD_TOO_LARGE",
      message: `Input images total ${totalBytes} bytes exceeds ${MAX_INPUT_IMAGE_TOTAL_BYTES} bytes.`,
    });
  }
}

async function loadInputImages({
  r2,
  userId,
  refs,
}: {
  r2: R2Config;
  userId: string;
  refs: z.infer<typeof inputImageRefSchema>[];
}): Promise<ImageInputFile[]> {
  assertInputTotalBytes(refs);
  const images: ImageInputFile[] = [];
  for (let index = 0; index < refs.length; index++) {
    const image = refs[index];
    if (!image) continue;
    assertInputKeyOwnedByUser(image.key, userId);
    const object = await r2.bucket.get(image.key);
    if (!object) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: `Input image ${index} was not uploaded or has expired.`,
      });
    }
    if (object.size !== image.sizeBytes) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: `Input image ${index} size does not match its upload ref.`,
      });
    }
    if (object.size > MAX_INPUT_IMAGE_BYTES) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: `Input image ${index} exceeds ${MAX_INPUT_IMAGE_BYTES} bytes.`,
      });
    }
    const bytes = new Uint8Array(await object.arrayBuffer());
    if (bytes.byteLength === 0) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: `Input image ${index} is empty.`,
      });
    }
    images.push({
      role: image.role,
      filename: image.filename,
      contentType: object.httpMetadata?.contentType ?? image.contentType,
      bytes,
    });
  }
  return images;
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
   * Mint short-lived R2 PUT URLs for image inputs. `image.run` receives the
   * returned refs, keeping multi-MB image bytes out of the tRPC JSON body.
   */
  createInputUploads: protectedProcedure
    .input(createInputUploadsInput)
    .mutation(async ({ ctx, input }) => {
      assertInputTotalBytes(input.images);
      const r2 = requireR2(ctx.r2);
      const userId = ctx.session.user.id;
      const uploadId = crypto.randomUUID();

      const uploads = await Promise.all(
        input.images.map(async (image, index) => {
          const key = inputUploadKey(userId, uploadId, index);
          return {
            url: await presignPut({
              r2,
              key,
              contentType: image.contentType,
              expiresInSeconds: INPUT_UPLOAD_TTL_SECONDS,
            }),
            headers: { "content-type": image.contentType },
            ref: {
              key,
              role: image.role,
              filename: image.filename,
              contentType: image.contentType,
              sizeBytes: image.sizeBytes,
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
      for (const key of input.keys) {
        assertInputKeyOwnedByUser(key, userId);
      }
      await Promise.all(input.keys.map((key) => r2.bucket.delete(key)));
      return { deleted: input.keys.length };
    }),

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
  run: protectedProcedure.input(runInput).mutation(async ({ ctx, input }) => {
    const r2 = requireR2(ctx.r2);
    const apiKey = pickApiKey(input.provider, ctx.imageProviders);
    const provider = pickProvider(input.provider);

    const paramsByteLength = jsonByteLength(input.params);
    if (paramsByteLength > MAX_PARAMS_BYTES) {
      throw new TRPCError({
        code: "PAYLOAD_TOO_LARGE",
        message: `params exceeds ${MAX_PARAMS_BYTES} bytes.`,
      });
    }

    const userId = ctx.session.user.id;
    const inputImages = await loadInputImages({
      r2,
      userId,
      refs: input.inputImages,
    });

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
        outputs: [],
        metadata: result.metadata,
      };
    }

    const runId = crypto.randomUUID();
    for (const [index, out] of result.outputs.entries()) {
      if (out.bytes.byteLength > MAX_OUTPUT_IMAGE_BYTES) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: `Output ${index} exceeds ${MAX_OUTPUT_IMAGE_BYTES} bytes.`,
        });
      }
    }

    const outputs = await Promise.all(
      result.outputs.map(async (out, index) => {
        const seq = String(index + 1).padStart(2, "0");
        const filename = `output-${seq}${out.extension}`;
        const key = `image-runs/${userId}/${runId}/${filename}`;
        // presignGet is local CPU only (AWS Sig V4 over the known key)
        // and does not contact R2, so we run it in parallel with the put.
        // Both await before the URL is returned, and R2 read-after-write
        // is strongly consistent, so there is no race.
        const [, url] = await Promise.all([
          r2.bucket.put(key, out.bytes, {
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
