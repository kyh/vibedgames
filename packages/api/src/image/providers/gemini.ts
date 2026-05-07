import { TRPCError } from "@trpc/server";

import {
  base64For,
  copyParams,
  inputsForRoles,
  rejectImageParams,
  rejectInputRoles,
} from "../provider-inputs";
import { decodeBase64Output, fetchProviderJson, isRecord } from "../provider-io";
import type { ImageProvider, ImageProviderRequest, ImageProviderResult } from "../types";

const DEFAULT_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";

// Reserved keys we manage explicitly. Anything user-supplied here would
// either fight the request shape (`contents`, `tools`, `systemInstruction`)
// or smuggle bytes into the body alongside our role-based uploads.
const RESERVED_FIELDS = [
  "contents",
  "tools",
  "system_instruction",
  "systemInstruction",
  "generationConfig",
  "generation_config",
  "model",
  "prompt",
  "imageConfig",
  "image_config",
  "thinkingConfig",
  "thinking_config",
];

const IMAGE_PARAM_FIELDS = ["inline_data", "inlineData"];

function resolveBaseUrl(baseUrl: string | undefined): string {
  const root =
    typeof baseUrl === "string" && baseUrl.trim().length > 0 ? baseUrl : DEFAULT_BASE_URL;
  return root.endsWith("/") ? root.slice(0, -1) : root;
}

function generateContentUrl(baseUrl: string | undefined, model: string): string {
  return `${resolveBaseUrl(baseUrl)}/models/${encodeURIComponent(model)}:generateContent`;
}

type GeminiInlineData = { mimeType?: string; mime_type?: string; data?: string };

type GeminiPart = {
  text?: string;
  inlineData?: GeminiInlineData;
  inline_data?: GeminiInlineData;
};

type GeminiCandidate = {
  content?: { parts?: GeminiPart[] };
  finishReason?: string;
};

type GeminiResponse = {
  candidates?: GeminiCandidate[];
  promptFeedback?: unknown;
  usageMetadata?: unknown;
  modelVersion?: string;
};

function parseGeminiResponse(value: unknown): GeminiResponse {
  if (!isRecord(value)) return {};
  return {
    candidates: Array.isArray(value.candidates)
      ? (value.candidates.filter(isRecord) as GeminiCandidate[])
      : undefined,
    promptFeedback: value.promptFeedback,
    usageMetadata: value.usageMetadata,
    modelVersion:
      typeof value.modelVersion === "string" ? value.modelVersion : undefined,
  };
}

function inlineFor(part: GeminiPart): GeminiInlineData | undefined {
  return part.inlineData ?? part.inline_data;
}

function extensionFor(mime: string): { extension: string; contentType: string } {
  const trimmed = mime.toLowerCase();
  if (trimmed === "image/jpeg" || trimmed === "image/jpg") {
    return { extension: ".jpg", contentType: "image/jpeg" };
  }
  if (trimmed === "image/png") return { extension: ".png", contentType: "image/png" };
  if (trimmed === "image/webp") return { extension: ".webp", contentType: "image/webp" };
  if (trimmed === "image/gif") return { extension: ".gif", contentType: "image/gif" };
  // Conservative fallback — Gemini documents png/jpeg/webp output.
  return { extension: ".png", contentType: "image/png" };
}

function decodeOutputs(json: GeminiResponse): ImageProviderResult["outputs"] {
  const candidates = json.candidates ?? [];
  if (candidates.length === 0) {
    throw new TRPCError({
      code: "BAD_GATEWAY",
      message: "Gemini response did not include any candidates.",
    });
  }
  const outputs: ImageProviderResult["outputs"] = [];
  for (const candidate of candidates) {
    const parts = candidate.content?.parts ?? [];
    for (const part of parts) {
      const inline = inlineFor(part);
      if (!inline || typeof inline.data !== "string") continue;
      const mime = inline.mimeType ?? inline.mime_type ?? "image/png";
      const { extension, contentType } = extensionFor(mime);
      outputs.push({
        bytes: decodeBase64Output(inline.data, "Gemini image output"),
        contentType,
        extension,
      });
    }
  }
  if (outputs.length === 0) {
    throw new TRPCError({
      code: "BAD_GATEWAY",
      message: "Gemini response did not include any inline image data.",
    });
  }
  return outputs;
}

function buildGenerationConfig(params: Record<string, unknown>): Record<string, unknown> {
  // The CLI surfaces a flat params object; lift the documented Gemini sub-objects
  // (`imageConfig`, `thinkingConfig`) out of params so callers can pass either
  // the nested object or individual leaf keys.
  const config: Record<string, unknown> = {
    responseModalities: ["TEXT", "IMAGE"],
  };
  const imageConfig = pickRecord(params, ["imageConfig", "image_config"]);
  if (imageConfig) config.imageConfig = imageConfig;
  const thinkingConfig = pickRecord(params, ["thinkingConfig", "thinking_config"]);
  if (thinkingConfig) config.thinkingConfig = thinkingConfig;
  // Allow callers to still pass a `generationConfig` object that gets merged.
  const explicit = pickRecord(params, ["generationConfig", "generation_config"]);
  if (explicit) Object.assign(config, explicit);
  return config;
}

function pickRecord(
  params: Record<string, unknown>,
  keys: string[],
): Record<string, unknown> | null {
  for (const key of keys) {
    const value = params[key];
    if (isRecord(value)) return value;
  }
  return null;
}

export const geminiImageProvider: ImageProvider = {
  async run(req: ImageProviderRequest): Promise<ImageProviderResult> {
    if (!req.model) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "Gemini requires a model id (e.g. gemini-3.1-flash-image-preview).",
      });
    }

    rejectImageParams(req.params, IMAGE_PARAM_FIELDS, "Gemini");
    rejectInputRoles(req.inputImages, ["mask", "palette"], "Gemini");

    const refImages = inputsForRoles(req.inputImages, ["image", "reference"]);
    const parts: GeminiPart[] = [{ text: req.prompt }];
    for (const image of refImages) {
      parts.push({
        inline_data: {
          mime_type: image.contentType,
          data: base64For(image),
        },
      });
    }

    const generationConfig = buildGenerationConfig(req.params);
    const extras = copyParams(req.params, RESERVED_FIELDS);
    const payload: Record<string, unknown> = {
      contents: [{ role: "user", parts }],
      generationConfig,
      ...extras,
    };

    const systemInstruction = pickRecord(req.params, ["systemInstruction", "system_instruction"]);
    if (systemInstruction) {
      payload.systemInstruction = systemInstruction;
    }
    const tools = req.params.tools;
    if (Array.isArray(tools)) {
      payload.tools = tools;
    }

    const json = parseGeminiResponse(
      await fetchProviderJson({
        url: generateContentUrl(req.baseUrl, req.model),
        label: "Gemini API",
        credentialed: true,
        init: {
          method: "POST",
          headers: {
            "x-goog-api-key": req.apiKey,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(payload),
        },
      }),
    );

    return {
      outputs: decodeOutputs(json),
      metadata: {
        provider: "gemini",
        model: req.model,
        modelVersion: json.modelVersion ?? null,
        usage: json.usageMetadata ?? null,
        promptFeedback: json.promptFeedback ?? null,
      },
    };
  },
};
