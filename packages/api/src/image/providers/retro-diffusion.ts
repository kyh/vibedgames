import { TRPCError } from "@trpc/server";

import { base64ToBytes, bytesToBase64 } from "../base64";
import type {
  ImageProvider,
  ImageProviderRequest,
  ImageProviderResult,
} from "../types";

const DEFAULT_BASE_URL = "https://api.retrodiffusion.ai/v1";

function inferencesUrl(baseUrl: string | undefined): string {
  const root = baseUrl ?? DEFAULT_BASE_URL;
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
  if (
    bytes.length >= 6 &&
    bytes[0] === 0x47 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46
  ) {
    return { extension: ".gif", contentType: "image/gif" };
  }
  if (
    bytes.length >= 3 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff
  ) {
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
      typeof req.params.prompt_style === "string"
        ? (req.params.prompt_style as string)
        : req.model;
    if (!promptStyle) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "retro-diffusion requires a prompt_style (passed as `model`).",
      });
    }

    const payload: Record<string, unknown> = { ...req.params };
    payload.prompt_style = promptStyle;
    payload.prompt = req.prompt;

    if (req.inputImages.length > 0) {
      // First image is the canonical input; remaining are appended to any
      // `reference_images` the user passed in params (instead of replacing
      // them) so the two channels can be combined consistently regardless
      // of how many --image flags were supplied.
      payload.input_image = bytesToBase64(req.inputImages[0]!.bytes);
      if (req.inputImages.length > 1) {
        const extras = req.inputImages
          .slice(1)
          .map((img) => bytesToBase64(img.bytes));
        const existing = payload.reference_images;
        if (Array.isArray(existing)) {
          payload.reference_images = [...existing, ...extras];
        } else if (typeof existing === "string" && existing.length > 0) {
          // Some users pass a single base64 reference as a scalar string;
          // normalize to array shape rather than dropping it on the floor.
          payload.reference_images = [existing, ...extras];
        } else {
          payload.reference_images = extras;
        }
      }
    }

    const res = await fetch(inferencesUrl(req.baseUrl), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-RD-Token": req.apiKey,
      },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new TRPCError({
        code: "BAD_GATEWAY",
        message: `Retro Diffusion error ${res.status}: ${text.slice(0, 800)}`,
      });
    }

    const json = (await res.json()) as RDResponse;

    const outputs: ImageProviderResult["outputs"] = [];
    for (const encoded of json.base64_images ?? []) {
      const bytes = base64ToBytes(encoded);
      const media = detectMedia(bytes);
      outputs.push({
        bytes,
        contentType: media.contentType,
        extension: media.extension,
      });
    }
    if (outputs.length === 0 && !payload.check_cost) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
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
