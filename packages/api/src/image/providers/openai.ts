import { TRPCError } from "@trpc/server";

import { base64ToBytes } from "../base64";
import type {
  ImageProvider,
  ImageProviderRequest,
  ImageProviderResult,
} from "../types";

const DEFAULT_BASE_URL = "https://api.openai.com/v1";

function generateUrl(baseUrl: string | undefined): string {
  return `${stripTrailingSlash(baseUrl ?? DEFAULT_BASE_URL)}/images/generations`;
}

function editUrl(baseUrl: string | undefined): string {
  return `${stripTrailingSlash(baseUrl ?? DEFAULT_BASE_URL)}/images/edits`;
}

function stripTrailingSlash(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

const VALID_FORMATS = new Set(["png", "webp", "jpeg"]);

type OpenAIResponse = {
  data?: Array<{ b64_json?: string }>;
  usage?: unknown;
  created?: number;
};

function pickStringField(
  params: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = params[key];
  return typeof value === "string" ? value : undefined;
}

// Only the gpt-image-* family accepts the `output_format` request param.
// dall-e-2 and dall-e-3 reject unknown args with a 400 and always return
// PNG when `response_format: "b64_json"` is set.
function supportsOutputFormat(model: string): boolean {
  return model.startsWith("gpt-image");
}

function outputFormatFor(
  model: string,
  params: Record<string, unknown>,
): string {
  if (!supportsOutputFormat(model)) return "png";
  const requested = pickStringField(params, "output_format");
  if (requested && VALID_FORMATS.has(requested)) return requested;
  return "png";
}

function extensionFor(format: string): string {
  if (format === "jpeg") return ".jpg";
  return `.${format}`;
}

function contentTypeFor(format: string): string {
  return `image/${format === "jpg" ? "jpeg" : format}`;
}

function decodeOutputs(
  json: OpenAIResponse,
  format: string,
): ImageProviderResult["outputs"] {
  const data = json.data;
  if (!Array.isArray(data) || data.length === 0) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "OpenAI response did not include image data.",
    });
  }
  const ext = extensionFor(format);
  const ct = contentTypeFor(format);
  return data.map((item) => {
    if (!item || typeof item.b64_json !== "string") {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: "OpenAI response did not include b64_json data.",
      });
    }
    return {
      bytes: base64ToBytes(item.b64_json),
      contentType: ct,
      extension: ext,
    };
  });
}

async function callJson(
  url: string,
  apiKey: string,
  body: Record<string, unknown>,
): Promise<OpenAIResponse> {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new TRPCError({
      code: "BAD_GATEWAY",
      message: `OpenAI API error ${res.status}: ${text.slice(0, 800)}`,
    });
  }
  return (await res.json()) as OpenAIResponse;
}

async function callMultipart(
  url: string,
  apiKey: string,
  form: FormData,
): Promise<OpenAIResponse> {
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new TRPCError({
      code: "BAD_GATEWAY",
      message: `OpenAI API error ${res.status}: ${text.slice(0, 800)}`,
    });
  }
  return (await res.json()) as OpenAIResponse;
}

// gpt-image-* models always return b64 and reject `response_format`. Other
// models (dall-e-2, dall-e-3, ...) default to URLs and need an explicit
// override so decodeOutputs can find the b64 data.
function needsResponseFormatOverride(model: string): boolean {
  return !model.startsWith("gpt-image");
}

async function generate(
  req: ImageProviderRequest,
): Promise<ImageProviderResult> {
  const format = outputFormatFor(req.model, req.params);
  const payload: Record<string, unknown> = {
    ...req.params,
    model: req.model,
    prompt: req.prompt,
  };
  if (supportsOutputFormat(req.model)) {
    payload.output_format = format;
  } else {
    delete payload.output_format;
  }
  if (needsResponseFormatOverride(req.model)) {
    // Force, not default — decodeOutputs only knows how to read b64_json,
    // so a user-supplied `response_format: "url"` would otherwise crash.
    payload.response_format = "b64_json";
  } else {
    // gpt-image-* always returns b64 and rejects `response_format`.
    delete payload.response_format;
  }
  const json = await callJson(generateUrl(req.baseUrl), req.apiKey, payload);
  return {
    outputs: decodeOutputs(json, format),
    metadata: {
      provider: "openai",
      model: req.model,
      created: json.created,
      usage: json.usage,
    },
  };
}

async function edit(req: ImageProviderRequest): Promise<ImageProviderResult> {
  if (req.inputImages.length === 0) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "OpenAI image edits require at least one input image.",
    });
  }
  const format = outputFormatFor(req.model, req.params);
  const form = new FormData();
  // Set params first so explicit `model`/`prompt`/`output_format` below
  // always take precedence over anything passed in `params`.
  for (const [key, value] of Object.entries(req.params)) {
    if (value === undefined || value === null) continue;
    // Skip fields we set explicitly below so user-supplied values can't
    // overwrite or fight the explicit values.
    if (
      key === "model" ||
      key === "prompt" ||
      key === "output_format" ||
      key === "response_format"
    ) {
      continue;
    }
    form.set(key, typeof value === "string" ? value : JSON.stringify(value));
  }
  form.set("model", req.model);
  form.set("prompt", req.prompt);
  if (supportsOutputFormat(req.model)) {
    form.set("output_format", format);
  }
  if (needsResponseFormatOverride(req.model)) {
    // Force, not default — decodeOutputs only knows how to read b64_json,
    // so a user-supplied `response_format: "url"` would otherwise crash.
    form.set("response_format", "b64_json");
  }
  for (const image of req.inputImages) {
    const blob = new Blob([image.bytes as Uint8Array<ArrayBuffer>], {
      type: image.contentType,
    });
    form.append("image[]", blob, image.filename);
  }
  const json = await callMultipart(editUrl(req.baseUrl), req.apiKey, form);
  return {
    outputs: decodeOutputs(json, format),
    metadata: {
      provider: "openai",
      model: req.model,
      created: json.created,
      usage: json.usage,
    },
  };
}

export const openaiImageProvider: ImageProvider = {
  async run(req) {
    return req.task === "edit" ? edit(req) : generate(req);
  },
};
