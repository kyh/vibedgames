import { TRPCError } from "@trpc/server";

import { bytesToBase64 } from "../base64";
import type { ImageInputFile, ImageProvider, ImageProviderResult } from "../types";

const QUEUE_ROOT = "https://queue.fal.run";

const POLL_INTERVAL_MS = 2_000;
const POLL_TIMEOUT_MS = 90_000;

type QueueSubmitResponse = {
  request_id?: string;
  status_url?: string;
  response_url?: string;
};

type QueueStatusResponse = {
  status?: string;
};

function falHeaders(apiKey: string): Record<string, string> {
  return {
    Authorization: `Key ${apiKey}`,
    Accept: "application/json",
    "X-Fal-Store-IO": "1",
    "x-app-fal-disable-fallback": "true",
  };
}

function dataUriFor(image: ImageInputFile): string {
  return `data:${image.contentType};base64,${bytesToBase64(image.bytes)}`;
}

function imageFieldFor(params: Record<string, unknown>): string {
  const explicit = params.input_image_field;
  if (typeof explicit === "string" && explicit.length > 0) return explicit;
  return "image_urls";
}

function contentTypeForExtension(ext: string): string {
  if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
  if (ext === "png") return "image/png";
  if (ext === "webp") return "image/webp";
  if (ext === "gif") return "image/gif";
  return "application/octet-stream";
}

function extensionFromUrl(url: string): string {
  const path = new URL(url).pathname;
  const dot = path.lastIndexOf(".");
  if (dot === -1) return "png";
  return path.slice(dot + 1).toLowerCase() || "png";
}

const IMAGE_EXTENSIONS = new Set([
  "png",
  "jpg",
  "jpeg",
  "webp",
  "gif",
  "bmp",
  "tif",
  "tiff",
  "avif",
]);

function looksLikeImageUrl(url: string): boolean {
  const ext = extensionFromUrl(url);
  return IMAGE_EXTENSIONS.has(ext);
}

function collectMediaUrls(payload: unknown): string[] {
  // Fal image endpoints embed outputs in objects shaped like
  // `{ url, content_type, file_name, ... }`. Match only entries whose
  // `content_type` is image-y, falling back to the URL extension when the
  // server does not set one. This avoids picking up unrelated URLs (audio,
  // video, internal metadata) that may sit elsewhere in the response tree.
  // Dedupe so a URL nested at multiple levels does not yield duplicate
  // outputs.
  const seen = new Set<string>();
  const found: string[] = [];
  const visit = (value: unknown) => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (value && typeof value === "object") {
      const obj = value as Record<string, unknown>;
      const url = obj.url;
      if (typeof url === "string" && url.startsWith("http") && !seen.has(url)) {
        const contentType = typeof obj.content_type === "string" ? obj.content_type : null;
        const isImage =
          contentType !== null ? contentType.startsWith("image/") : looksLikeImageUrl(url);
        if (isImage) {
          seen.add(url);
          found.push(url);
        }
      }
      for (const child of Object.values(obj)) visit(child);
    }
  };
  visit(payload);
  return found;
}

async function downloadImage(url: string): Promise<{
  bytes: Uint8Array;
  contentType: string;
  extension: string;
}> {
  const res = await fetch(url);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new TRPCError({
      code: "BAD_GATEWAY",
      message: `fal output download failed (${res.status}): ${text.slice(0, 400)}`,
    });
  }
  const buf = new Uint8Array(await res.arrayBuffer());
  const headerType = res.headers.get("content-type") ?? "";
  const ext = extensionFromUrl(url);
  const contentType = headerType.startsWith("image/") ? headerType : contentTypeForExtension(ext);
  return { bytes: buf, contentType, extension: `.${ext}` };
}

async function submit(
  endpointId: string,
  apiKey: string,
  body: Record<string, unknown>,
): Promise<QueueSubmitResponse> {
  const res = await fetch(`${QUEUE_ROOT}/${endpointId.replace(/^\/+|\/+$/g, "")}`, {
    method: "POST",
    headers: { ...falHeaders(apiKey), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new TRPCError({
      code: "BAD_GATEWAY",
      message: `fal queue submit failed (${res.status}): ${text.slice(0, 800)}`,
    });
  }
  return (await res.json()) as QueueSubmitResponse;
}

async function pollUntilComplete(statusUrl: string, apiKey: string): Promise<void> {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  while (true) {
    const res = await fetch(`${statusUrl}?logs=0`, {
      headers: falHeaders(apiKey),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new TRPCError({
        code: "BAD_GATEWAY",
        message: `fal queue status failed (${res.status}): ${text.slice(0, 400)}`,
      });
    }
    const body = (await res.json()) as QueueStatusResponse;
    const status = (body.status ?? "").toUpperCase();
    if (status === "COMPLETED") return;
    if (status === "FAILED" || status === "CANCELLED") {
      throw new TRPCError({
        code: "BAD_GATEWAY",
        message: `fal job ended with status ${status}.`,
      });
    }
    if (Date.now() > deadline) {
      throw new TRPCError({
        code: "GATEWAY_TIMEOUT",
        message: `fal job did not complete within ${POLL_TIMEOUT_MS}ms.`,
      });
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
}

async function fetchResult(
  responseUrl: string,
  apiKey: string,
): Promise<{ payload: unknown; billableUnits: string | null }> {
  const res = await fetch(responseUrl, { headers: falHeaders(apiKey) });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new TRPCError({
      code: "BAD_GATEWAY",
      message: `fal result fetch failed (${res.status}): ${text.slice(0, 800)}`,
    });
  }
  const payload = await res.json();
  return {
    payload,
    billableUnits: res.headers.get("x-fal-billable-units"),
  };
}

export const falImageProvider: ImageProvider = {
  async run(req) {
    // For fal, `model` is the endpoint id (e.g. "fal-ai/nano-banana/edit").
    const endpointId = req.model;
    if (!endpointId) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "fal requires `model` to be the fal endpoint id.",
      });
    }

    const arguments_: Record<string, unknown> = { ...req.params };
    delete arguments_.input_image_field;
    arguments_.prompt = req.prompt;

    if (req.inputImages.length > 0) {
      const field = imageFieldFor(req.params);
      const encoded = req.inputImages.map((img) => dataUriFor(img));
      const existing = arguments_[field];
      arguments_[field] = Array.isArray(existing) ? [...encoded, ...existing] : encoded;
    }

    const submission = await submit(endpointId, req.apiKey, arguments_);
    const requestId = submission.request_id;
    const statusUrl =
      submission.status_url ??
      (requestId
        ? `${QUEUE_ROOT}/${endpointId.replace(/^\/+|\/+$/g, "")}/requests/${requestId}/status`
        : null);
    const responseUrl =
      submission.response_url ??
      (requestId
        ? `${QUEUE_ROOT}/${endpointId.replace(/^\/+|\/+$/g, "")}/requests/${requestId}`
        : null);

    if (!statusUrl || !responseUrl) {
      throw new TRPCError({
        code: "BAD_GATEWAY",
        message: "fal queue response missing status/response URLs.",
      });
    }

    await pollUntilComplete(statusUrl, req.apiKey);
    const { payload, billableUnits } = await fetchResult(responseUrl, req.apiKey);

    const urls = collectMediaUrls(payload);
    if (urls.length === 0) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: "fal result did not include any image URLs.",
      });
    }

    const outputs = await Promise.all(urls.map(downloadImage));

    const payloadObj =
      payload && typeof payload === "object" ? (payload as Record<string, unknown>) : null;

    return {
      outputs,
      metadata: {
        provider: "fal",
        endpoint_id: endpointId,
        request_id: requestId ?? null,
        billable_units: billableUnits,
        seed: payloadObj?.seed ?? null,
        timings: payloadObj?.timings ?? null,
        error: payloadObj?.error ?? payloadObj?.detail ?? null,
      },
    };
  },
};
