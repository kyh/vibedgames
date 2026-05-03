import { TRPCError } from "@trpc/server";

import {
  base64For,
  copyParams,
  inputsForRole,
  rejectImageParams,
  rejectInputRoles,
  singleInputForRole,
} from "../provider-inputs";
import { decodeBase64Output, fetchProviderJson, isRecord } from "../provider-io";
import type { ImageProvider, ImageProviderRequest, ImageProviderResult } from "../types";

const DEFAULT_BASE_URL = "https://api.retrodiffusion.ai/v1";
// Image data must come through uploaded inputs, not params — surface a
// 400 if a user tries to bypass that.
const RESERVED_IMAGE_FIELDS = ["input_image", "reference_images", "input_palette"];
// Fields the proxy controls. We strip these from `copyParams` so a
// user-supplied value can't slip into the body alongside (or ahead of)
// the explicit assignment below.
const RESERVED_FIELDS = [
  ...RESERVED_IMAGE_FIELDS,
  "prompt",
  "prompt_style",
  "model",
];

function inferencesUrl(baseUrl: string | undefined): string {
  // `??` doesn't catch empty-string env vars; treat blank as unset.
  const root = baseUrl && baseUrl.trim().length > 0 ? baseUrl : DEFAULT_BASE_URL;
  return `${root.endsWith("/") ? root.slice(0, -1) : root}/inferences`;
}

type RDResponse = {
  base64_images?: string[];
  output_urls?: string[];
  balance_cost?: number;
  remaining_balance?: number;
  model?: string;
  created_at?: number;
};

function parseRDResponse(value: unknown): RDResponse {
  if (!isRecord(value)) return {};
  return {
    base64_images: Array.isArray(value.base64_images)
      ? value.base64_images.filter((item) => typeof item === "string")
      : undefined,
    output_urls: Array.isArray(value.output_urls)
      ? value.output_urls.filter((item) => typeof item === "string")
      : undefined,
    balance_cost: typeof value.balance_cost === "number" ? value.balance_cost : undefined,
    remaining_balance:
      typeof value.remaining_balance === "number" ? value.remaining_balance : undefined,
    model: typeof value.model === "string" ? value.model : undefined,
    created_at: typeof value.created_at === "number" ? value.created_at : undefined,
  };
}

function detectMedia(bytes: Uint8Array): { extension: string; contentType: string } {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    return { extension: ".png", contentType: "image/png" };
  }
  if (bytes.length >= 6 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) {
    return { extension: ".gif", contentType: "image/gif" };
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { extension: ".jpg", contentType: "image/jpeg" };
  }
  return { extension: ".bin", contentType: "application/octet-stream" };
}

export const retroDiffusionImageProvider: ImageProvider = {
  async run(req: ImageProviderRequest): Promise<ImageProviderResult> {
    // Retro Diffusion uses `prompt_style` instead of `model`. Accept either:
    //   - `model` carries the prompt_style verbatim, or
    //   - `params.prompt_style` is set explicitly.
    const promptStyle =
      typeof req.params.prompt_style === "string" ? req.params.prompt_style : req.model;
    if (!promptStyle) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "retro-diffusion requires a prompt_style (passed as `model`).",
      });
    }

    rejectImageParams(req.params, RESERVED_IMAGE_FIELDS, "Retro Diffusion");
    rejectInputRoles(req.inputImages, ["mask"], "Retro Diffusion");
    const payload = copyParams(req.params, RESERVED_FIELDS);
    payload.prompt_style = promptStyle;
    payload.prompt = req.prompt;

    const primaryImage = singleInputForRole(req.inputImages, "image", "Retro Diffusion");
    const referenceImages = inputsForRole(req.inputImages, "reference");
    const palette = singleInputForRole(req.inputImages, "palette", "Retro Diffusion");
    if (primaryImage) {
      payload.input_image = base64For(primaryImage);
    }
    if (referenceImages.length > 0) {
      payload.reference_images = referenceImages.map((image) => base64For(image));
    }
    if (palette) {
      payload.input_palette = base64For(palette);
    }

    const json = parseRDResponse(
      await fetchProviderJson({
        url: inferencesUrl(req.baseUrl),
        label: "Retro Diffusion",
        credentialed: true,
        init: {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-RD-Token": req.apiKey,
          },
          body: JSON.stringify(payload),
        },
      }),
    );

    const outputs: ImageProviderResult["outputs"] = [];
    for (const encoded of json.base64_images ?? []) {
      let bytes: Uint8Array;
      try {
        bytes = decodeBase64Output(encoded, "Retro Diffusion image output");
      } catch (err) {
        if (err instanceof TRPCError) throw err;
        // Malformed base64 from the upstream is a gateway-side problem,
        // not an internal server error.
        throw new TRPCError({
          code: "BAD_GATEWAY",
          message: "Retro Diffusion returned malformed base64 image data.",
        });
      }
      const media = detectMedia(bytes);
      outputs.push({
        bytes,
        contentType: media.contentType,
        extension: media.extension,
      });
    }
    if (outputs.length === 0 && !payload.check_cost) {
      throw new TRPCError({
        code: "BAD_GATEWAY",
        message: "Retro Diffusion response did not include base64_images.",
      });
    }

    return {
      outputs,
      metadata: {
        provider: "retro-diffusion",
        prompt_style: promptStyle,
        balance_cost: json.balance_cost ?? null,
        remaining_balance: json.remaining_balance ?? null,
        model: json.model ?? null,
        created_at: json.created_at ?? null,
        output_urls: json.output_urls ?? [],
      },
    };
  },
};
