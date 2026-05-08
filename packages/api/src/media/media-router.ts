import { TRPCError } from "@trpc/server";
import { z } from "zod";

import type { MediaProviderConfig } from "../trpc";
import { createTRPCRouter, protectedProcedure } from "../trpc";
import { MAX_PARAMS_BYTES } from "./limits";
import { fetchProviderResponse, isRecord, readJsonBounded } from "./provider-io";

// ---- fal target routing -----------------------------------------------------
//
// `media.forward` is the single proc the CLI talks to. Each call names a
// target (queue / platform / storage / docs) which picks the upstream host;
// the rest of the URL is the user-supplied `path` plus optional `query`.
// Per-target overrides come from MediaProviderConfig so deployments can
// route any target through a Cloudflare AI Gateway prefix.

const TARGET_DEFAULTS = {
  queue: "https://queue.fal.run",
  platform: "https://api.fal.ai",
  storage: "https://rest.alpha.fal.ai",
  docs: "https://docs.fal.ai",
} as const;

type Target = keyof typeof TARGET_DEFAULTS;

function trimSlash(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}

function nonBlank(value: string | undefined): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function targetBase(target: Target, media: MediaProviderConfig): string {
  const override =
    target === "queue"
      ? nonBlank(media.falQueueBaseUrl)
      : target === "platform"
        ? nonBlank(media.falPlatformBaseUrl)
        : target === "docs"
          ? nonBlank(media.falDocsBaseUrl)
          : nonBlank(media.falStorageBaseUrl);
  return trimSlash(override ?? TARGET_DEFAULTS[target]);
}

function buildUrl(
  base: string,
  path: string,
  query: Record<string, string | string[]> | undefined,
): URL {
  // Reject path traversal early. URL parsing would normalize `..`
  // segments and could let a request escape the target host's
  // intended namespace.
  if (path.includes("..")) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "path may not contain `..`." });
  }
  const url = new URL(base + path);
  if (!url.toString().startsWith(base)) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "path resolves outside the target base.",
    });
  }
  for (const [key, value] of Object.entries(query ?? {})) {
    const values = Array.isArray(value) ? value : [value];
    for (const v of values) url.searchParams.append(key, v);
  }
  return url;
}

// ---- Schema ----------------------------------------------------------------

const forwardInput = z.object({
  target: z.enum(["queue", "platform", "storage", "docs"]),
  method: z.enum(["GET", "POST", "PUT", "DELETE"]),
  // Must be a server-relative path. Empty bodies and trailing-only paths
  // are fine. We refuse anything that doesn't start with `/` so a caller
  // can't smuggle a full URL (which would change the host).
  path: z.string().min(1).max(512).regex(/^\//, "path must start with `/`"),
  query: z.record(z.string(), z.union([z.string(), z.array(z.string())])).optional(),
  body: z.unknown().optional(),
});

// ---- Helpers ---------------------------------------------------------------

function pickFalKey(media: MediaProviderConfig | undefined): {
  apiKey: string;
  config: MediaProviderConfig;
} {
  if (!media?.fal) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "fal is not configured on the server (FAL_API_KEY missing).",
    });
  }
  return { apiKey: media.fal, config: media };
}

function jsonByteLength(value: unknown): number {
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "body must be JSON-serializable.",
    });
  }
  return new TextEncoder().encode(serialized).byteLength;
}

// ---- Router ----------------------------------------------------------------

export const mediaRouter = createTRPCRouter({
  /**
   * Single proxy hop to fal. The CLI builds the URL it wants, the
   * server attaches the FAL_KEY and the X-Fal-Store-IO directives,
   * forwards, and returns the parsed JSON body. This is deliberately
   * dumb — typed shapes for individual fal endpoints live on the
   * client and in fal's docs, not in this layer. Per-user policy
   * (auth, quotas, allowlists, billing meters) hooks in here.
   */
  forward: protectedProcedure.input(forwardInput).mutation(async ({ ctx, input }) => {
    const { apiKey, config } = pickFalKey(ctx.media);

    if (input.body !== undefined) {
      const bytes = jsonByteLength(input.body);
      if (bytes > MAX_PARAMS_BYTES) {
        throw new TRPCError({
          code: "PAYLOAD_TOO_LARGE",
          message: `body exceeds ${MAX_PARAMS_BYTES} bytes.`,
        });
      }
    }

    const base = targetBase(input.target, config);
    const url = buildUrl(base, input.path, input.query);

    const headers: Record<string, string> = {
      Authorization: `Key ${apiKey}`,
      Accept: "application/json",
      // X-Fal-Store-IO: keep outputs on fal CDN, not inlined as base64.
      // x-app-fal-disable-fallback: surface failures instead of routing
      // to a different model silently. Both apply to queue submits but
      // are harmless on other targets.
      "X-Fal-Store-IO": "1",
      "x-app-fal-disable-fallback": "true",
    };
    if (input.body !== undefined) headers["Content-Type"] = "application/json";

    const res = await fetchProviderResponse({
      url,
      label: `fal ${input.target} ${input.method} ${input.path}`,
      credentialed: true,
      init: {
        method: input.method,
        headers,
        body: input.body !== undefined ? JSON.stringify(input.body) : undefined,
      },
    });

    if (res.status === 204 || res.headers.get("content-length") === "0") return null;
    const data = await readJsonBounded(res, `fal ${input.target} response`);
    return passthrough(data);
  }),
});

function passthrough(data: unknown): unknown {
  // Fal occasionally wraps a primitive at the top level; superjson
  // through tRPC handles primitives fine, but we keep this hook so a
  // future per-target normalizer (e.g. adapting deprecated response
  // shapes) has an obvious place to live.
  return isRecord(data) || Array.isArray(data) ? data : data;
}
