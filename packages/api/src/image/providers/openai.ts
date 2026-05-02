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
  return `image/${format}`;
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

// Fields the proxy controls — never let user-supplied params overwrite or
// reach OpenAI through the spread/form loops. The image-binary fields
// (`image`, `image[]`) are appended explicitly below; if a user passed
// them through `params` the form would end up with stray text entries
// alongside the real binary blobs. `mask` is handled separately further
// down: it stays addressable through `params` (as a base64 string) but
// never as a stray text field.
const RESERVED_FIELDS = new Set([
  "model",
  "prompt",
  "output_format",
  "response_format",
  "image",
  "image[]",
  "mask",
]);

async function generate(
  req: ImageProviderRequest,
): Promise<ImageProviderResult> {
  if (req.inputImages.length > 0) {
    // OpenAI's /images/generations endpoint is text-only — a reference
    // image only has effect via /images/edits. Reject so the user knows
    // their --image was dropped instead of silently ignoring it.
    throw new TRPCError({
      code: "BAD_REQUEST",
      message:
        "OpenAI generate does not accept input images. Use `vg image edit` (or omit --model with --image so vg auto-detects edit) to send a reference image.",
    });
  }
  const format = outputFormatFor(req.model, req.params);
  const payload: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(req.params)) {
    if (value === undefined || value === null) continue;
    if (RESERVED_FIELDS.has(key)) continue;
    payload[key] = value;
  }
  payload.model = req.model;
  payload.prompt = req.prompt;
  if (supportsOutputFormat(req.model)) {
    payload.output_format = format;
  }
  if (needsResponseFormatOverride(req.model)) {
    // Force, not default — decodeOutputs only knows how to read b64_json,
    // so a user-supplied `response_format: "url"` would otherwise crash.
    payload.response_format = "b64_json";
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
    // OpenAI's edit endpoint expects `image` / `image[]` as binary form
    // fields, so the proxy filters those keys out of `params` to keep
    // them from leaking as text. If a user routed images through
    // `--params` instead of `--image`, surface a specific message
    // pointing at the right flag.
    const usedParamsImage =
      typeof req.params.image === "string" ||
      Array.isArray(req.params.image) ||
      Array.isArray((req.params as Record<string, unknown>)["image[]"]);
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: usedParamsImage
        ? "OpenAI image edits require --image (or `inputImages` on the API). The `image` / `image[]` keys in --params are reserved by the proxy and don't reach OpenAI."
        : "OpenAI image edits require at least one input image.",
    });
  }
  const format = outputFormatFor(req.model, req.params);
  const form = new FormData();
  for (const [key, value] of Object.entries(req.params)) {
    if (value === undefined || value === null) continue;
    if (RESERVED_FIELDS.has(key)) continue;
    form.set(key, typeof value === "string" ? value : JSON.stringify(value));
  }
  form.set("model", req.model);
  form.set("prompt", req.prompt);
  // OpenAI's edit endpoint accepts an optional `mask` PNG. We expose it
  // as a base64 string in `params.mask` (matching the retro-diffusion
  // convention for inline images) and decode it here before appending
  // as a binary blob.
  const maskValue = req.params.mask;
  if (typeof maskValue === "string" && maskValue.length > 0) {
    let maskBytes: Uint8Array;
    try {
      maskBytes = base64ToBytes(maskValue);
    } catch {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "OpenAI mask must be a base64-encoded PNG string.",
      });
    }
    form.append(
      "mask",
      new Blob([maskBytes as Uint8Array<ArrayBuffer>], { type: "image/png" }),
      "mask.png",
    );
  }
  if (supportsOutputFormat(req.model)) {
    form.set("output_format", format);
  }
  if (needsResponseFormatOverride(req.model)) {
    // Force, not default — decodeOutputs only knows how to read b64_json,
    // so a user-supplied `response_format: "url"` would otherwise crash.
    form.set("response_format", "b64_json");
  }
  // dall-e-2 expects the singular `image` field and accepts only one
  // image; gpt-image-* takes `image[]` and accepts multiple.
  if (req.model === "dall-e-2") {
    if (req.inputImages.length > 1) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "OpenAI dall-e-2 edits accept exactly one input image.",
      });
    }
    const image = req.inputImages[0]!;
    const blob = new Blob([image.bytes as Uint8Array<ArrayBuffer>], {
      type: image.contentType,
    });
    form.set("image", blob, image.filename);
  } else {
    for (const image of req.inputImages) {
      const blob = new Blob([image.bytes as Uint8Array<ArrayBuffer>], {
        type: image.contentType,
      });
      form.append("image[]", blob, image.filename);
    }
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
