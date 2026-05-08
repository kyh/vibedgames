import { TRPCError } from "@trpc/server";

import { fetchProviderJson, fetchProviderResponse, isRecord, readJsonBounded } from "./provider-io";

export const DEFAULT_QUEUE_ROOT = "https://queue.fal.run";
export const DEFAULT_PLATFORM_ROOT = "https://api.fal.ai/v1";
export const DEFAULT_DOCS_MCP_URL = "https://docs.fal.ai/mcp";

// fal status_url / response_url are echoed back from the queue submit
// response and we attach the API key when polling them. Restrict the
// hosts we'll authenticate against so a future server-side bug or
// compromised path can't redirect the key off-platform.
const FAL_TRUSTED_QUEUE_HOSTS = new Set(["queue.fal.run"]);

export type FalConfig = {
  apiKey: string;
  /** Override for the queue root, e.g. a Cloudflare AI Gateway prefix. */
  queueBaseUrl?: string;
  /** Override for the platform (api.fal.ai/v1) root. */
  platformBaseUrl?: string;
  /** Override for the docs MCP endpoint. */
  docsBaseUrl?: string;
};

export function falHeaders(apiKey: string): Record<string, string> {
  // X-Fal-Store-IO: instructs fal to store outputs in its CDN and
  // return URLs in the result payload, instead of inlining bytes.
  // Critical here because the router returns raw `result.data` to
  // callers — if a model inlined base64 bytes we'd blow past
  // MAX_FAL_PLATFORM_JSON_BYTES on big outputs.
  // x-app-fal-disable-fallback: turn off the silent fallback to a
  // different endpoint when the primary is unavailable; we'd rather
  // surface the failure than serve unexpected output from another model.
  return {
    Authorization: `Key ${apiKey}`,
    Accept: "application/json",
    "X-Fal-Store-IO": "1",
    "x-app-fal-disable-fallback": "true",
  };
}

function trimSlash(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}

export function queueRoot(cfg: FalConfig): string {
  const root =
    typeof cfg.queueBaseUrl === "string" && cfg.queueBaseUrl.trim().length > 0
      ? cfg.queueBaseUrl
      : DEFAULT_QUEUE_ROOT;
  return trimSlash(root);
}

function platformRoot(cfg: FalConfig): string {
  const root =
    typeof cfg.platformBaseUrl === "string" && cfg.platformBaseUrl.trim().length > 0
      ? cfg.platformBaseUrl
      : DEFAULT_PLATFORM_ROOT;
  return trimSlash(root);
}

function docsRoot(cfg: FalConfig): string {
  const root =
    typeof cfg.docsBaseUrl === "string" && cfg.docsBaseUrl.trim().length > 0
      ? cfg.docsBaseUrl
      : DEFAULT_DOCS_MCP_URL;
  return trimSlash(root);
}

function hasCustomQueueRoot(cfg: FalConfig): boolean {
  return typeof cfg.queueBaseUrl === "string" && cfg.queueBaseUrl.trim().length > 0;
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
  return FAL_TRUSTED_QUEUE_HOSTS.has(parsed.hostname) ? value : null;
}

function cleanEndpoint(endpointId: string): string {
  return endpointId.replace(/^\/+|\/+$/g, "");
}

// ---- Queue API --------------------------------------------------------------

export type FalQueueSubmitResponse = {
  request_id?: string;
  status_url?: string;
  response_url?: string;
  cancel_url?: string;
};

type RawQueueStatus = {
  status?: string;
  error?: unknown;
  detail?: unknown;
  response?: { error?: unknown; detail?: unknown };
  logs?: unknown;
  queue_position?: unknown;
};

export type FalQueueStatus = {
  status: string;
  request_id?: string;
  queue_position?: number;
  logs?: unknown;
  error?: unknown;
};

function parseQueueSubmit(value: unknown): FalQueueSubmitResponse {
  if (!isRecord(value)) return {};
  return {
    request_id: typeof value.request_id === "string" ? value.request_id : undefined,
    status_url: typeof value.status_url === "string" ? value.status_url : undefined,
    response_url: typeof value.response_url === "string" ? value.response_url : undefined,
    cancel_url: typeof value.cancel_url === "string" ? value.cancel_url : undefined,
  };
}

function parseQueueStatus(value: unknown): RawQueueStatus {
  if (!isRecord(value)) return {};
  const response = isRecord(value.response)
    ? { error: value.response.error, detail: value.response.detail }
    : undefined;
  return {
    status: typeof value.status === "string" ? value.status : undefined,
    error: value.error,
    detail: value.detail,
    response,
    logs: value.logs,
    queue_position: value.queue_position,
  };
}

function pickErrorReason(value: unknown): string | null {
  if (!isRecord(value)) return null;
  if (typeof value.error === "string" && value.error.length > 0) return value.error;
  if (typeof value.detail === "string" && value.detail.length > 0) return value.detail;
  if (isRecord(value.error) && typeof value.error.message === "string") {
    return value.error.message;
  }
  return null;
}

export type QueueUrls = {
  statusUrl: string;
  responseUrl: string;
  cancelUrl: string;
};

export function queueUrlsFor(
  cfg: FalConfig,
  endpointId: string,
  requestId: string,
  fromSubmit?: FalQueueSubmitResponse,
): QueueUrls {
  const root = queueRoot(cfg);
  const ep = cleanEndpoint(endpointId);
  // When a custom queue root is configured (e.g. a Cloudflare AI
  // Gateway URL prefix), construct the status/response URLs ourselves
  // so polls and result fetches keep flowing through the gateway. The
  // absolute URLs that fal returns always point at queue.fal.run and
  // would silently bypass the proxy.
  const useCustom = hasCustomQueueRoot(cfg);
  const constructed = {
    statusUrl: `${root}/${ep}/requests/${requestId}/status`,
    responseUrl: `${root}/${ep}/requests/${requestId}`,
    cancelUrl: `${root}/${ep}/requests/${requestId}/cancel`,
  };
  if (useCustom) return constructed;
  return {
    statusUrl: acceptableQueueUrl(fromSubmit?.status_url) ?? constructed.statusUrl,
    responseUrl: acceptableQueueUrl(fromSubmit?.response_url) ?? constructed.responseUrl,
    cancelUrl: acceptableQueueUrl(fromSubmit?.cancel_url) ?? constructed.cancelUrl,
  };
}

export async function submitQueue(
  cfg: FalConfig,
  endpointId: string,
  input: Record<string, unknown>,
): Promise<FalQueueSubmitResponse> {
  return parseQueueSubmit(
    await fetchProviderJson({
      url: `${queueRoot(cfg)}/${cleanEndpoint(endpointId)}`,
      label: "fal queue submit",
      credentialed: true,
      init: {
        method: "POST",
        headers: { ...falHeaders(cfg.apiKey), "Content-Type": "application/json" },
        body: JSON.stringify(input),
      },
    }),
  );
}

export async function statusQueue(
  cfg: FalConfig,
  statusUrl: string,
  options?: { logs?: boolean },
): Promise<FalQueueStatus> {
  const url = new URL(statusUrl);
  url.searchParams.set("logs", options?.logs ? "1" : "0");
  const raw = parseQueueStatus(
    await fetchProviderJson({
      url,
      label: "fal queue status",
      credentialed: true,
      init: { headers: falHeaders(cfg.apiKey) },
    }),
  );
  const status = (raw.status ?? "").toUpperCase();
  return {
    status: status || "UNKNOWN",
    queue_position: typeof raw.queue_position === "number" ? raw.queue_position : undefined,
    logs: raw.logs,
    error: pickErrorReason(raw) ?? pickErrorReason(raw.response) ?? undefined,
  };
}

export async function fetchQueueResult(
  cfg: FalConfig,
  responseUrl: string,
): Promise<{ data: unknown; billableUnits: string | null }> {
  const res = await fetchProviderResponse({
    url: responseUrl,
    label: "fal result fetch",
    credentialed: true,
    init: { headers: falHeaders(cfg.apiKey) },
  });
  const data = await readJsonBounded(res, "fal result response");
  return { data, billableUnits: res.headers.get("x-fal-billable-units") };
}

export async function cancelQueue(cfg: FalConfig, cancelUrl: string): Promise<void> {
  await fetchProviderResponse({
    url: cancelUrl,
    label: "fal queue cancel",
    credentialed: true,
    init: { method: "PUT", headers: falHeaders(cfg.apiKey) },
  });
}

const POLL_INTERVAL_MS = 2_000;
// Sync `vg media run` waits inline for fal to finish. 90s was fine for
// image-only, but the new media router proxies video/audio/3D models
// that routinely take several minutes. Cap at 5 minutes to stay
// comfortably under the Worker request-duration ceiling; anything
// longer should use `--async` + `vg media status`.
const POLL_TIMEOUT_MS = 5 * 60 * 1000;

export async function pollUntilComplete(cfg: FalConfig, statusUrl: string): Promise<void> {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  while (true) {
    const status = await statusQueue(cfg, statusUrl);
    if (status.status === "COMPLETED") return;
    if (status.status === "FAILED" || status.status === "CANCELLED") {
      const reason = typeof status.error === "string" ? status.error : null;
      throw new TRPCError({
        code: "BAD_GATEWAY",
        message: reason
          ? `fal job ended with status ${status.status}: ${reason}`
          : `fal job ended with status ${status.status}.`,
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

// ---- Platform / Models / Schema / Pricing / Docs ----------------------------

export type ModelsQuery = {
  q?: string;
  category?: string;
  status?: string;
  limit?: number;
  cursor?: string;
  endpoint_ids?: string[];
  expand?: string[];
};

function buildPlatformUrl(cfg: FalConfig, path: string, query?: ModelsQuery): URL {
  const url = new URL(`${platformRoot(cfg)}${path}`);
  if (!query) return url;
  if (query.q) url.searchParams.set("q", query.q);
  if (query.category) url.searchParams.set("category", query.category);
  if (query.status) url.searchParams.set("status", query.status);
  if (typeof query.limit === "number") url.searchParams.set("limit", String(query.limit));
  if (query.cursor) url.searchParams.set("cursor", query.cursor);
  for (const id of query.endpoint_ids ?? []) {
    url.searchParams.append("endpoint_id", id);
  }
  for (const value of query.expand ?? []) {
    url.searchParams.append("expand", value);
  }
  return url;
}

export async function listModels(cfg: FalConfig, query: ModelsQuery): Promise<unknown> {
  return fetchProviderJson({
    url: buildPlatformUrl(cfg, "/models", query),
    label: "fal platform models",
    credentialed: true,
    init: { headers: falHeaders(cfg.apiKey) },
  });
}

export async function getModelSchema(
  cfg: FalConfig,
  endpointId: string,
  format: "compact" | "openapi",
): Promise<unknown> {
  const expand = format === "openapi" ? ["openapi-3.0"] : [];
  return listModels(cfg, { endpoint_ids: [endpointId], limit: 1, expand });
}

export async function getPricing(cfg: FalConfig, endpointId: string): Promise<unknown> {
  const url = new URL(`${platformRoot(cfg)}/models/pricing`);
  url.searchParams.set("endpoint_id", endpointId);
  return fetchProviderJson({
    url,
    label: "fal platform pricing",
    credentialed: true,
    init: { headers: falHeaders(cfg.apiKey) },
  });
}

export async function searchDocs(cfg: FalConfig, query: string): Promise<unknown> {
  // The genmedia CLI POSTs MCP-style requests at docs.fal.ai/mcp.
  // We forward the same shape; the response is opaque-ish JSON we
  // pass back to the caller.
  return fetchProviderJson({
    url: docsRoot(cfg),
    label: "fal docs search",
    credentialed: false,
    init: {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "search", arguments: { query } },
      }),
    },
  });
}
