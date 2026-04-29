import { TRPCError } from "@trpc/server";

import type {
  ImageProvider,
  ImageProviderRequest,
  ImageProviderResult,
} from "../types";

const GENERATE_URL = "https://api.openai.com/v1/images/generations";
const EDIT_URL = "https://api.openai.com/v1/images/edits";

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

function outputFormat(params: Record<string, unknown>): string {
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
      bytes: base64Decode(item.b64_json),
      contentType: ct,
      extension: ext,
    };
  });
}

function base64Decode(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
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

async function generate(
  req: ImageProviderRequest,
): Promise<ImageProviderResult> {
  const format = outputFormat(req.params);
  const payload: Record<string, unknown> = {
    ...req.params,
    model: req.model,
    prompt: req.prompt,
    output_format: format,
  };
  const json = await callJson(GENERATE_URL, req.apiKey, payload);
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
  const format = outputFormat(req.params);
  const form = new FormData();
  form.set("model", req.model);
  form.set("prompt", req.prompt);
  form.set("output_format", format);
  for (const [key, value] of Object.entries(req.params)) {
    if (value === undefined || value === null) continue;
    if (key === "output_format") continue;
    form.set(key, typeof value === "string" ? value : JSON.stringify(value));
  }
  for (const image of req.inputImages) {
    // Copy into a fresh ArrayBuffer to satisfy Blob's BlobPart typing on
    // Workers (Uint8Array is not directly assignable in this lib config).
    const copy = new Uint8Array(image.bytes.byteLength);
    copy.set(image.bytes);
    const blob = new Blob([copy.buffer], { type: image.contentType });
    form.append("image[]", blob, image.filename);
  }
  const json = await callMultipart(EDIT_URL, req.apiKey, form);
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
