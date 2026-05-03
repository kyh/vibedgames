import { TRPCError } from "@trpc/server";

import {
  copyParams,
  inputsForRoles,
  rejectImageParams,
  rejectInputRoles,
  singleInputForRole,
} from "../provider-inputs";
import { decodeBase64Output, fetchProviderJson, isRecord } from "../provider-io";
import type { ImageProvider, ImageProviderRequest, ImageProviderResult } from "../types";

const DEFAULT_BASE_URL = "https://api.openai.com/v1";

function resolveBaseUrl(baseUrl: string | undefined): string {
  return baseUrl && baseUrl.trim().length > 0 ? baseUrl : DEFAULT_BASE_URL;
}

function generateUrl(baseUrl: string | undefined): string {
  return `${stripTrailingSlash(resolveBaseUrl(baseUrl))}/images/generations`;
}

function editUrl(baseUrl: string | undefined): string {
  return `${stripTrailingSlash(resolveBaseUrl(baseUrl))}/images/edits`;
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

function parseOpenAIResponse(value: unknown): OpenAIResponse {
  if (!isRecord(value)) return {};
  const data = Array.isArray(value.data)
    ? value.data.map((item) =>
        isRecord(item) && typeof item.b64_json === "string" ? { b64_json: item.b64_json } : {},
      )
    : undefined;
  return {
    data,
    usage: value.usage,
    created: typeof value.created === "number" ? value.created : undefined,
  };
}

function pickStringField(params: Record<string, unknown>, key: string): string | undefined {
  const value = params[key];
  return typeof value === "string" ? value : undefined;
}

// Only the gpt-image-* family accepts the `output_format` request param.
// dall-e-2 and dall-e-3 reject unknown args with a 400 and always return
// PNG when `response_format: "b64_json"` is set.
function supportsOutputFormat(model: string): boolean {
  return model.startsWith("gpt-image");
}

function outputFormatFor(model: string, params: Record<string, unknown>): string {
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

function blobPartFor(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function decodeOutputs(json: OpenAIResponse, format: string): ImageProviderResult["outputs"] {
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
      bytes: decodeBase64Output(item.b64_json, "OpenAI image output"),
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
  return parseOpenAIResponse(
    await fetchProviderJson({
      url,
      label: "OpenAI API",
      credentialed: true,
      init: {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      },
    }),
  );
}

async function callMultipart(url: string, apiKey: string, form: FormData): Promise<OpenAIResponse> {
  return parseOpenAIResponse(
    await fetchProviderJson({
      url,
      label: "OpenAI API",
      credentialed: true,
      init: {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}` },
        body: form,
      },
    }),
  );
}

// gpt-image-* models always return b64 and reject `response_format`. Other
// models (dall-e-2, dall-e-3, ...) default to URLs and need an explicit
// override so decodeOutputs can find the b64 data.
function needsResponseFormatOverride(model: string): boolean {
  return !model.startsWith("gpt-image");
}

// Fields the proxy controls. Image-like fields must come through uploaded
// role refs so bytes stay out of JSON bodies.
const RESERVED_FIELDS = [
  "model",
  "prompt",
  "output_format",
  "response_format",
  "image",
  "image[]",
  "mask",
];

const IMAGE_PARAM_FIELDS = ["image", "image[]", "mask"];

async function generate(req: ImageProviderRequest): Promise<ImageProviderResult> {
  if (req.inputImages.length > 0) {
    // OpenAI's /images/generations endpoint is text-only; a reference
    // image only has effect via /images/edits. Reject so the user knows
    // their --image was dropped instead of silently ignoring it.
    throw new TRPCError({
      code: "BAD_REQUEST",
      message:
        "OpenAI generate does not accept input images. Use `vg image edit` (or omit --model with --image so vg auto-detects edit) to send a reference image.",
    });
  }
  const format = outputFormatFor(req.model, req.params);
  rejectImageParams(req.params, IMAGE_PARAM_FIELDS, "OpenAI");
  const payload = copyParams(req.params, RESERVED_FIELDS);
  payload.model = req.model;
  payload.prompt = req.prompt;
  if (supportsOutputFormat(req.model)) {
    payload.output_format = format;
  }
  if (needsResponseFormatOverride(req.model)) {
    // Force, not default: decodeOutputs only knows how to read b64_json,
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
  rejectImageParams(req.params, IMAGE_PARAM_FIELDS, "OpenAI");
  rejectInputRoles(req.inputImages, ["palette"], "OpenAI");
  const editImages = inputsForRoles(req.inputImages, ["image", "reference"]);
  const mask = singleInputForRole(req.inputImages, "mask", "OpenAI edit");
  if (editImages.length === 0) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "OpenAI image edits require at least one --image or --reference.",
    });
  }
  const format = outputFormatFor(req.model, req.params);
  const form = new FormData();
  for (const [key, value] of Object.entries(copyParams(req.params, RESERVED_FIELDS))) {
    form.set(key, typeof value === "string" ? value : JSON.stringify(value));
  }
  form.set("model", req.model);
  form.set("prompt", req.prompt);
  if (mask) {
    if (mask.contentType !== "image/png") {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "OpenAI edit masks must be PNG files.",
      });
    }
    form.append(
      "mask",
      new Blob([blobPartFor(mask.bytes)], { type: mask.contentType }),
      mask.filename,
    );
  }
  if (supportsOutputFormat(req.model)) {
    form.set("output_format", format);
  }
  if (needsResponseFormatOverride(req.model)) {
    // Force, not default: decodeOutputs only knows how to read b64_json,
    // so a user-supplied `response_format: "url"` would otherwise crash.
    form.set("response_format", "b64_json");
  }
  // dall-e-2 expects the singular `image` field and accepts only one
  // image; gpt-image-* takes `image[]` and accepts multiple.
  if (req.model === "dall-e-2") {
    if (editImages.length > 1) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "OpenAI dall-e-2 edits accept exactly one input image.",
      });
    }
    const image = editImages[0];
    if (!image) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "OpenAI image edits require at least one input image.",
      });
    }
    const blob = new Blob([blobPartFor(image.bytes)], {
      type: image.contentType,
    });
    form.set("image", blob, image.filename);
  } else {
    for (const image of editImages) {
      const blob = new Blob([blobPartFor(image.bytes)], {
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
