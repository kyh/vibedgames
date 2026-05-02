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
// at typical pixel-art sizes. We measure size by walking the parsed
// object directly (see `jsonByteLengthBounded`) so we never materialize
// the serialized JSON or an encoded buffer alongside the parsed input.
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

// Walk the parsed params object and compute the would-be JSON.stringify
// UTF-8 byte length, bailing out early once `limit` is exceeded. We avoid
// allocating both the serialized string and an encoded `Uint8Array`,
// which would each peak around the limit on payloads carrying inline
// base64 images and triple memory pressure on the 128 MB Worker.
function jsonByteLengthBounded(value: unknown, limit: number): number {
  let total = 0;
  let exceeded = false;

  function add(n: number): void {
    total += n;
    if (total > limit) exceeded = true;
  }

  function stringBytes(s: string): number {
    let n = 2; // surrounding quotes
    for (let i = 0; i < s.length && !exceeded; i++) {
      const c = s.charCodeAt(i);
      if (c === 0x22 || c === 0x5c) {
        n += 2; // escaped " or \
      } else if (c === 0x08 || c === 0x09 || c === 0x0a || c === 0x0c || c === 0x0d) {
        n += 2; // \b \t \n \f \r
      } else if (c < 0x20) {
        n += 6; // \u00XX
      } else if (c < 0x80) {
        n += 1;
      } else if (c < 0x800) {
        n += 2;
      } else if (c >= 0xd800 && c <= 0xdbff) {
        // High surrogate. JSON.stringify pairs it with a following low
        // surrogate (4 UTF-8 bytes total) or, if alone, emits \uXXXX
        // (6 bytes). Don't advance `i` for the lone case so the next
        // code unit gets counted on its own.
        const next = i + 1 < s.length ? s.charCodeAt(i + 1) : -1;
        if (next >= 0xdc00 && next <= 0xdfff) {
          n += 4;
          i++;
        } else {
          n += 6;
        }
      } else if (c >= 0xdc00 && c <= 0xdfff) {
        // Lone low surrogate → \uXXXX (6 bytes).
        n += 6;
      } else {
        n += 3;
      }
    }
    return n;
  }

  function walk(v: unknown): void {
    if (exceeded) return;
    if (v === null) return add(4);
    if (v === undefined) return; // omitted from objects
    switch (typeof v) {
      case "boolean":
        return add(v ? 4 : 5);
      case "number":
        return add(Number.isFinite(v) ? String(v).length : 4);
      case "string":
        return add(stringBytes(v));
      case "object": {
        if (Array.isArray(v)) {
          add(2); // []
          for (let i = 0; i < v.length && !exceeded; i++) {
            if (i > 0) add(1); // ,
            const item = v[i];
            if (item === undefined) {
              add(4); // arrays serialize undefined as null
            } else {
              walk(item);
            }
          }
          return;
        }
        add(2); // {}
        let first = true;
        for (const key of Object.keys(v as Record<string, unknown>)) {
          if (exceeded) return;
          const val = (v as Record<string, unknown>)[key];
          if (val === undefined || typeof val === "function") continue;
          if (!first) add(1); // ,
          add(stringBytes(key) + 1); // "key":
          walk(val);
          first = false;
        }
        return;
      }
      default:
        return; // function/symbol/bigint are not serializable here
    }
  }

  walk(value);
  return total;
}

function decodeInputImages(
  raw: z.infer<typeof inputImageSchema>[],
): ImageInputFile[] {
  return raw.map((image, index) => {
    let bytes: Uint8Array;
    try {
      bytes = base64ToBytes(image.base64);
    } catch {
      // atob throws DOMException on syntactically invalid base64; surface
      // it as a 400 rather than a 500 so the CLI can show a clean error.
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: `Input image ${index} is not valid base64.`,
      });
    }
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

      const paramsByteLength = jsonByteLengthBounded(
        input.params,
        MAX_PARAMS_BYTES,
      );
      if (paramsByteLength > MAX_PARAMS_BYTES) {
        throw new TRPCError({
          code: "PAYLOAD_TOO_LARGE",
          message: `params exceeds ${MAX_PARAMS_BYTES} bytes.`,
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
