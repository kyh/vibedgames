import { createFalClient, type FalClient } from "@fal-ai/client";
import { TRPCError } from "@trpc/server";

import { fetchProviderJson, isRecord } from "./provider-io";

const DEFAULT_PLATFORM_ROOT = "https://api.fal.ai/v1";
const DEFAULT_DOCS_MCP_URL = "https://docs.fal.ai/mcp";
const DEFAULT_STORAGE_INITIATE_URL = "https://rest.alpha.fal.ai/storage/upload/initiate";

export type FalConfig = {
  apiKey: string;
  /** Override for the queue root, e.g. a Cloudflare AI Gateway prefix.
   *  Routed through the SDK's `proxyUrl` so the AI Gateway becomes the
   *  effective host for every fal.queue.* call. */
  queueBaseUrl?: string;
  /** Override for the platform (api.fal.ai/v1) root. Used by direct
   *  fetches; the SDK doesn't expose these endpoints. */
  platformBaseUrl?: string;
  /** Override for the docs MCP endpoint. */
  docsBaseUrl?: string;
  /** Override for the storage initiate URL. */
  storageInitiateUrl?: string;
};

function falHeaders(apiKey: string): Record<string, string> {
  return {
    Authorization: `Key ${apiKey}`,
    Accept: "application/json",
  };
}

function trimSlash(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
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

// ---- Per-request fal client ------------------------------------------------

/**
 * Build a fresh @fal-ai/client per request. The queueBaseUrl maps to the
 * SDK's `proxyUrl` config so all queue traffic flows through a Cloudflare
 * AI Gateway prefix when one is configured.
 *
 * Two response-shape directives are pinned via requestMiddleware:
 *   X-Fal-Store-IO: 1            — keep outputs on fal CDN, not inlined
 *   x-app-fal-disable-fallback   — surface failures instead of silently
 *                                  routing to a different model
 */
export function getFalClient(cfg: FalConfig): FalClient {
  const proxyUrl =
    typeof cfg.queueBaseUrl === "string" && cfg.queueBaseUrl.trim().length > 0
      ? { url: cfg.queueBaseUrl, when: "always" as const }
      : undefined;
  return createFalClient({
    credentials: cfg.apiKey,
    proxyUrl,
    requestMiddleware: async (req) => ({
      ...req,
      headers: {
        ...req.headers,
        "X-Fal-Store-IO": "1",
        "x-app-fal-disable-fallback": "true",
      },
    }),
  });
}

// ---- Platform / Models / Schema / Pricing / Docs ---------------------------
// SDK doesn't cover these; keep direct fetches.

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

// ---- Storage upload init ---------------------------------------------------
// SDK exposes only the all-in-one upload(blob); we want just the initiate
// step so the client can PUT bytes directly without proxying through the
// worker. Hence the bespoke fetch + trusted-host pinning below.

const FAL_TRUSTED_STORAGE_HOSTS = [
  ".fal.media",
  ".fal.run",
  ".fal.ai",
  ".storage.googleapis.com",
];

function isTrustedStorageHost(hostname: string): boolean {
  return FAL_TRUSTED_STORAGE_HOSTS.some((suffix) => {
    const apex = suffix.startsWith(".") ? suffix.slice(1) : suffix;
    return hostname === apex || hostname.endsWith(suffix);
  });
}

function assertTrustedStorageUrl(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TRPCError({
      code: "BAD_GATEWAY",
      message: `fal storage initiate did not return ${label}.`,
    });
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new TRPCError({
      code: "BAD_GATEWAY",
      message: `fal storage initiate ${label} is not a valid URL.`,
    });
  }
  if (parsed.protocol !== "https:" || !isTrustedStorageHost(parsed.hostname)) {
    throw new TRPCError({
      code: "BAD_GATEWAY",
      message: `fal storage initiate ${label} returned an untrusted host: ${parsed.hostname}`,
    });
  }
  return value;
}

export type FalUploadSlot = {
  uploadUrl: string;
  fileUrl: string;
  contentType: string;
};

export async function initiateStorageUpload(
  cfg: FalConfig,
  meta: { filename: string; contentType: string },
): Promise<FalUploadSlot> {
  const url =
    typeof cfg.storageInitiateUrl === "string" && cfg.storageInitiateUrl.trim().length > 0
      ? cfg.storageInitiateUrl
      : DEFAULT_STORAGE_INITIATE_URL;
  const data = await fetchProviderJson({
    url,
    label: "fal storage initiate",
    credentialed: true,
    init: {
      method: "POST",
      headers: { ...falHeaders(cfg.apiKey), "Content-Type": "application/json" },
      body: JSON.stringify({
        content_type: meta.contentType,
        file_name: meta.filename,
      }),
    },
  });
  if (!isRecord(data)) {
    throw new TRPCError({
      code: "BAD_GATEWAY",
      message: "fal storage initiate response was not an object.",
    });
  }
  return {
    uploadUrl: assertTrustedStorageUrl(data.upload_url, "upload_url"),
    fileUrl: assertTrustedStorageUrl(data.file_url, "file_url"),
    contentType: meta.contentType,
  };
}
