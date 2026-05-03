import { TRPCError } from "@trpc/server";

import { MAX_OUTPUT_IMAGE_BYTES } from "../limits";
import { base64For, copyParams, inputsForRoles, rejectInputRoles } from "../provider-inputs";
import {
  fetchProviderJson,
  fetchProviderResponse,
  isRecord,
  readBytesBounded,
  readJsonBounded,
} from "../provider-io";
import type { ImageInputFile, ImageProvider } from "../types";

const DEFAULT_QUEUE_ROOT = "https://queue.fal.run";
// fal status_url / response_url are echoed back from the queue submit
// response and we attach the API key when polling them. Restrict the
// hosts we'll authenticate against so a future server-side bug or
// compromised path can't redirect the key off-platform.
const FAL_TRUSTED_HOSTS = new Set(["queue.fal.run"]);
// fal serves output media from its own CDN domains. Refuse to download
// from anything else, both to avoid exposing the worker as an
// open-fetch SSRF surface and to keep us honest about what "fal output"
// means.
const FAL_CONTENT_HOST_SUFFIXES = [".fal.media", ".fal.run", ".fal.ai"];

function isTrustedFalContentHost(hostname: string): boolean {
  // Match either the bare apex (e.g. `fal.media`) or any subdomain
  // (e.g. `v3.fal.media`). The leading dot in the suffix prevents
  // `notfal.media` from sneaking past.
  return FAL_CONTENT_HOST_SUFFIXES.some((suffix) => {
    const apex = suffix.startsWith(".") ? suffix.slice(1) : suffix;
    return hostname === apex || hostname.endsWith(suffix);
  });
}

function hasCustomBaseUrl(baseUrl: string | undefined | null): boolean {
  return typeof baseUrl === "string" && baseUrl.trim().length > 0;
}

function queueRoot(baseUrl: string | undefined): string {
  const root =
    typeof baseUrl === "string" && baseUrl.trim().length > 0 ? baseUrl : DEFAULT_QUEUE_ROOT;
  return root.endsWith("/") ? root.slice(0, -1) : root;
}

function acceptableQueueUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0) return null;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:") return null;
  return FAL_TRUSTED_HOSTS.has(parsed.hostname) ? value : null;
}

const POLL_INTERVAL_MS = 2_000;
const POLL_TIMEOUT_MS = 90_000;

type QueueSubmitResponse = {
  request_id?: string;
  status_url?: string;
  response_url?: string;
};

type QueueStatusResponse = {
  status?: string;
  error?: unknown;
  detail?: unknown;
  // fal sometimes nests the upstream payload's error fields under
  // `response` when the job ends with FAILED/CANCELLED.
  response?: { error?: unknown; detail?: unknown };
};

function pickErrorReason(value: unknown): string | null {
  if (!isRecord(value)) return null;
  if (typeof value.error === "string" && value.error.length > 0) return value.error;
  if (typeof value.detail === "string" && value.detail.length > 0) return value.detail;
  // fal occasionally returns `error: { message: "..." }`.
  if (isRecord(value.error) && typeof value.error.message === "string") {
    return value.error.message;
  }
  return null;
}

function parseQueueSubmit(value: unknown): QueueSubmitResponse {
  if (!isRecord(value)) return {};
  return {
    request_id: typeof value.request_id === "string" ? value.request_id : undefined,
    status_url: typeof value.status_url === "string" ? value.status_url : undefined,
    response_url: typeof value.response_url === "string" ? value.response_url : undefined,
  };
}

function parseQueueStatus(value: unknown): QueueStatusResponse {
  if (!isRecord(value)) return {};
  const response = isRecord(value.response)
    ? { error: value.response.error, detail: value.response.detail }
    : undefined;
  return {
    status: typeof value.status === "string" ? value.status : undefined,
    error: value.error,
    detail: value.detail,
    response,
  };
}

function falHeaders(apiKey: string): Record<string, string> {
  return {
    Authorization: `Key ${apiKey}`,
    Accept: "application/json",
    "X-Fal-Store-IO": "1",
    "x-app-fal-disable-fallback": "true",
  };
}

function dataUriFor(image: ImageInputFile): string {
  return `data:${image.contentType};base64,${base64For(image)}`;
}

function imageFieldFor(params: Record<string, unknown>): string {
  const explicit = params.input_image_field;
  if (typeof explicit !== "string" || explicit.length === 0) return "image_urls";
  // Refuse field names that would clobber the proxy-controlled keys
  // we set explicitly elsewhere on the request body. Otherwise a
  // user passing `input_image_field: "prompt"` would silently
  // overwrite the prompt with the encoded data URI array.
  if (FAL_RESERVED_FIELDS.has(explicit)) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `fal input_image_field cannot be "${explicit}" — that name collides with a reserved request field.`,
    });
  }
  return explicit;
}

const FAL_RESERVED_FIELDS = new Set(["prompt", "model", "input_image_field"]);

function contentTypeForExtension(ext: string): string {
  if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
  if (ext === "png") return "image/png";
  if (ext === "webp") return "image/webp";
  if (ext === "gif") return "image/gif";
  if (ext === "bmp") return "image/bmp";
  if (ext === "tif" || ext === "tiff") return "image/tiff";
  if (ext === "avif") return "image/avif";
  return "application/octet-stream";
}

function extensionFromUrl(url: string): string {
  let path: string;
  try {
    path = new URL(url).pathname;
  } catch {
    // Defensive: walked from arbitrary JSON, not validated as a URL.
    return "";
  }
  const dot = path.lastIndexOf(".");
  if (dot === -1) return "";
  return path.slice(dot + 1).toLowerCase();
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
    if (isRecord(value)) {
      const url = value.url;
      if (typeof url === "string" && url.startsWith("http") && !seen.has(url)) {
        let parsed: URL | null = null;
        try {
          parsed = new URL(url);
        } catch {
          parsed = null;
        }
        const isTrustedHost =
          parsed !== null &&
          parsed.protocol === "https:" &&
          isTrustedFalContentHost(parsed.hostname);
        const contentType =
          typeof value.content_type === "string" ? value.content_type.toLowerCase() : null;
        const isImage =
          contentType !== null ? contentType.startsWith("image/") : looksLikeImageUrl(url);
        if (isTrustedHost && isImage) {
          seen.add(url);
          found.push(url);
        }
      }
      for (const child of Object.values(value)) visit(child);
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
  // Belt-and-suspenders: collectMediaUrls already drops non-fal hosts,
  // but recheck here so a future caller can't smuggle an arbitrary URL
  // into the worker's outbound fetch path.
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new TRPCError({
      code: "BAD_GATEWAY",
      message: "fal returned an invalid output URL.",
    });
  }
  if (parsed.protocol !== "https:" || !isTrustedFalContentHost(parsed.hostname)) {
    throw new TRPCError({
      code: "BAD_GATEWAY",
      message: `fal returned an output URL on an untrusted host: ${parsed.hostname}`,
    });
  }
  const res = await fetchProviderResponse({
    url,
    label: "fal output URL",
    credentialed: false,
  });
  const buf = await readBytesBounded(res, MAX_OUTPUT_IMAGE_BYTES, "fal output image");
  const [mimeType] = (res.headers.get("content-type") ?? "").split(";");
  const headerMime = (mimeType ?? "").trim().toLowerCase();
  // Prefer the response content-type when it's image/*; the URL extension is
  // a fallback for endpoints that omit the header. Keep both in sync so a
  // GIF served from a URL without an extension doesn't end up labelled .png.
  const contentType = headerMime.startsWith("image/")
    ? headerMime
    : contentTypeForExtension(extensionFromUrl(url));
  const subtype = contentType.startsWith("image/") ? contentType.slice("image/".length) : "";
  // Subtypes like `svg+xml` or `vnd.microsoft.icon` would produce
  // malformed extensions if used verbatim; fall through to the URL
  // extension (which is itself filtered by IMAGE_EXTENSIONS) when the
  // subtype isn't a known plain image extension.
  const subtypeExt = subtype === "jpeg" ? "jpg" : subtype;
  const urlExt = extensionFromUrl(url);
  const ext =
    (subtypeExt && IMAGE_EXTENSIONS.has(subtypeExt) ? subtypeExt : null) ??
    (urlExt && IMAGE_EXTENSIONS.has(urlExt) ? urlExt : null) ??
    "bin";
  return { bytes: buf, contentType, extension: `.${ext}` };
}

async function submit(
  endpointId: string,
  apiKey: string,
  body: Record<string, unknown>,
  baseUrl: string | undefined,
): Promise<QueueSubmitResponse> {
  return parseQueueSubmit(
    await fetchProviderJson({
      url: `${queueRoot(baseUrl)}/${endpointId.replace(/^\/+|\/+$/g, "")}`,
      label: "fal queue submit",
      credentialed: true,
      init: {
        method: "POST",
        headers: { ...falHeaders(apiKey), "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
    }),
  );
}

async function pollUntilComplete(statusUrl: string, apiKey: string): Promise<void> {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  const pollUrl = new URL(statusUrl);
  pollUrl.searchParams.set("logs", "0");
  while (true) {
    const body = parseQueueStatus(
      await fetchProviderJson({
        url: pollUrl,
        label: "fal queue status",
        credentialed: true,
        init: { headers: falHeaders(apiKey) },
      }),
    );
    const status = (body.status ?? "").toUpperCase();
    if (status === "COMPLETED") return;
    if (status === "FAILED" || status === "CANCELLED") {
      // fetchResult is never called on this path, so the upstream
      // reason would otherwise be permanently lost. Pull error/detail
      // off the status body (or its nested `response` payload) before
      // throwing so the caller has something actionable to read.
      const reason = pickErrorReason(body) ?? pickErrorReason(body.response);
      throw new TRPCError({
        code: "BAD_GATEWAY",
        message: reason
          ? `fal job ended with status ${status}: ${reason}`
          : `fal job ended with status ${status}.`,
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
  const res = await fetchProviderResponse({
    url: responseUrl,
    label: "fal result fetch",
    credentialed: true,
    init: { headers: falHeaders(apiKey) },
  });
  const payload = await readJsonBounded(res, "fal result response");
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

    // imageFieldFor (above) reads `input_image_field` and rejects
    // collisions with reserved keys, so we always strip it here. We
    // also strip `prompt` and `model` so a user-supplied value can't
    // sneak past — fal endpoints inspect those keys themselves.
    const arguments_ = copyParams(req.params, [...FAL_RESERVED_FIELDS]);
    arguments_.prompt = req.prompt;

    rejectInputRoles(req.inputImages, ["mask", "palette"], "fal");
    const inputImages = inputsForRoles(req.inputImages, ["image", "reference"]);
    if (inputImages.length > 0) {
      const field = imageFieldFor(req.params);
      const encoded = inputImages.map((img) => dataUriFor(img));
      const existing = arguments_[field];
      // Prepend uploaded files before any URLs already in params so fal
      // endpoints that treat the first entry as the primary input see the
      // local upload, matching the runner's documented file-then-url order.
      // Strings (single URL) are kept as a trailing entry instead of being
      // dropped silently.
      arguments_[field] = Array.isArray(existing)
        ? [...encoded, ...existing]
        : typeof existing === "string" && existing.length > 0
          ? [...encoded, existing]
          : encoded;
    }

    const submission = await submit(endpointId, req.apiKey, arguments_, req.baseUrl);
    const requestId = submission.request_id;
    const root = queueRoot(req.baseUrl);
    const cleanedEndpoint = endpointId.replace(/^\/+|\/+$/g, "");
    // When a custom queue root is configured (e.g. a Cloudflare AI
    // Gateway URL prefix), construct the status/response URLs ourselves
    // so polls and result fetches keep flowing through the gateway. The
    // absolute status_url/response_url that fal returns always point at
    // queue.fal.run and would silently bypass the proxy.
    const useCustomRoot = hasCustomBaseUrl(req.baseUrl);
    const constructedStatus = requestId
      ? `${root}/${cleanedEndpoint}/requests/${requestId}/status`
      : null;
    const constructedResponse = requestId
      ? `${root}/${cleanedEndpoint}/requests/${requestId}`
      : null;
    const statusUrl = useCustomRoot
      ? constructedStatus
      : (acceptableQueueUrl(submission.status_url) ?? constructedStatus);
    const responseUrl = useCustomRoot
      ? constructedResponse
      : (acceptableQueueUrl(submission.response_url) ?? constructedResponse);

    if (!statusUrl || !responseUrl) {
      throw new TRPCError({
        code: "BAD_GATEWAY",
        message: "fal queue response missing status/response URLs.",
      });
    }

    await pollUntilComplete(statusUrl, req.apiKey);
    const { payload, billableUnits } = await fetchResult(responseUrl, req.apiKey);

    const payloadObj = isRecord(payload) ? payload : null;

    const urls = collectMediaUrls(payload);
    if (urls.length === 0) {
      // fal sometimes returns a COMPLETED job whose payload carries an
      // `error`/`detail` instead of media (e.g. content moderation
      // rejections). Surface that in the error so the user has a real
      // reason to look at, not just "no URLs".
      const reason =
        (typeof payloadObj?.error === "string" && payloadObj.error) ||
        (typeof payloadObj?.detail === "string" && payloadObj.detail) ||
        null;
      throw new TRPCError({
        code: "BAD_GATEWAY",
        message: reason
          ? `fal returned no image URLs: ${reason}`
          : "fal result did not include any image URLs.",
      });
    }

    const outputs = await Promise.all(urls.map(downloadImage));

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
