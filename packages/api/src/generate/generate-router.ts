import type { Db } from "@repo/db/drizzle-client";
import { TRPCError } from "@trpc/server";
import { z } from "zod";

import type { MediaProviderConfig } from "../trpc";
import {
  formatUsd,
  getBalanceMicro,
  holdGeneration,
  releaseGeneration,
  settleGeneration,
} from "../credits/credit-ledger";
import { getEndpointPricing } from "../credits/endpoint-pricing";
import {
  classifyQueueCall,
  isUnbilledTerminalStatus,
  parseBillableUnits,
} from "../credits/queue-calls";
import { createTRPCRouter, protectedProcedure } from "../trpc";
import { MAX_PARAMS_BYTES } from "./limits";
import {
  fetchProviderResponse,
  readJsonBounded,
  readSseJson,
  throwProviderError,
} from "./provider-io";

// ---- fal target routing -----------------------------------------------------
//
// `generate.forward` is the single proc the CLI talks to. Each call names a
// target (queue / platform / storage / docs) which picks the upstream host;
// the rest of the URL is the user-supplied `path` plus optional `query`.
// Per-target overrides come from MediaProviderConfig so deployments can
// route any target through a Cloudflare AI Gateway prefix.

const TARGET_DEFAULTS = {
  queue: "https://queue.fal.run",
  platform: "https://api.fal.ai",
  storage: "https://rest.alpha.fal.ai",
  // fal's docs MCP lives at fal.ai/docs/mcp (docs.fal.ai 308-redirects
  // here, which we refuse to follow with credentials). It speaks MCP
  // streamable-HTTP and answers with text/event-stream, not JSON — see
  // the docs branch in `forward`.
  docs: "https://fal.ai",
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

function badPath(reason: string): never {
  throw new TRPCError({ code: "BAD_REQUEST", message: `path ${reason}.` });
}

function rejectTraversal(path: string): void {
  // Reject literal `..` and any percent-encoded form. The `URL` parser
  // doesn't decode `%2e%2e` itself — so `new URL(...)` would happily
  // produce a URL whose pathname looks fine here but whose downstream
  // server (or a reverse proxy) might decode and resolve as a traversal,
  // letting a request escape the target host's intended namespace
  // while we attach FAL_API_KEY to it. Percent-encoded slashes get the
  // same treatment because they'd fold into segment separators after
  // decoding and could push the request past a pathname-aware allowlist.
  if (path.includes("..")) badPath("may not contain `..`");
  if (!path.includes("%")) return;
  let decoded: string;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    badPath("has invalid percent-encoding");
  }
  if (decoded.includes("..")) badPath("may not contain `..` (including percent-encoded forms)");
  if (/%2f|%5c/i.test(path)) badPath("may not contain percent-encoded path separators");
}

function buildUrl(
  base: string,
  path: string,
  query: Record<string, string | string[]> | undefined,
): URL {
  rejectTraversal(path);
  // `path` is already Zod-constrained to start with `/`, and
  // rejectTraversal blocks every `..` form (literal, percent-decoded,
  // and percent-encoded separators). With those guards `new URL(base
  // + path)` can't escape the target origin.
  const url = new URL(base + path);
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
  // can't smuggle a full URL (which would change the host), and refuse
  // `?`/`#` so the path the credit classifier sees is exactly the path the
  // upstream URL gets — a `#` in the path would otherwise let a queue
  // submit reach fal while classifying (and billing) as nothing.
  path: z
    .string()
    .min(1)
    .max(512)
    .regex(/^\/[^?#]*$/, "path must start with `/` and contain no `?` or `#`"),
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

// X-Fal-Store-IO: keep outputs on fal CDN, not inlined as base64.
// x-app-fal-disable-fallback: surface failures instead of routing to a
// different model silently. Both apply to queue submits but are
// harmless on other targets, so we send them unconditionally.
const FAL_STATIC_HEADERS = {
  Accept: "application/json",
  "X-Fal-Store-IO": "1",
  "x-app-fal-disable-fallback": "true",
} as const;

function serializeBody(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "body must be JSON-serializable.",
    });
  }
}

// ---- credit accounting ------------------------------------------------------

/**
 * Credentialed platform-API transport for pricing lookups. Same
 * fetch/parse path as user-driven platform hops so size bounds and
 * redirect policy apply.
 */
function platformFetchJson(apiKey: string, config: MediaProviderConfig) {
  return async (req: {
    method: "GET" | "POST";
    path: string;
    query?: Record<string, string>;
    body?: unknown;
  }): Promise<unknown> => {
    const url = buildUrl(targetBase("platform", config), req.path, req.query);
    const headers: Record<string, string> = {
      Accept: "application/json",
      Authorization: `Key ${apiKey}`,
    };
    let body: string | undefined;
    if (req.body !== undefined) {
      body = JSON.stringify(req.body);
      headers["Content-Type"] = "application/json";
    }
    const res = await fetchProviderResponse({
      url,
      label: `fal platform ${req.method} ${req.path}`,
      credentialed: true,
      init: { method: req.method, headers, body },
    });
    return readJsonBounded(res, "fal platform response");
  };
}

/**
 * Gate a queue submit on remaining credits. Balance must be positive to
 * start a generation; the estimated hold may push it negative, which
 * simply blocks the next submit. The message carries the
 * `insufficient_credits` token so agents can branch on it.
 */
async function requirePositiveBalance(db: Db, userId: string): Promise<void> {
  const balanceMicro = await getBalanceMicro(db, userId);
  if (balanceMicro > 0) return;
  throw new TRPCError({
    code: "FORBIDDEN",
    message:
      `insufficient_credits: your balance is ${formatUsd(balanceMicro)}. ` +
      "Generation is paused until an admin grants more credits " +
      "(check with `vg credits`).",
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readRequestId(body: unknown): string | null {
  if (!isRecord(body)) return null;
  return typeof body.request_id === "string" && body.request_id.length > 0 ? body.request_id : null;
}

function readQueueStatus(body: unknown): unknown {
  return isRecord(body) ? body.status : null;
}

// ---- Router ----------------------------------------------------------------

export const generateRouter = createTRPCRouter({
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
    const userId = ctx.session.user.id;

    // Credit gate + hold estimate happen before any fal spend. Everything
    // else about the hop is unchanged when the call isn't a queue submit.
    // Admins are metered but never gated: their usage is still recorded
    // (holds/settles) so spend stays visible, but a negative balance can't
    // block them.
    const queueCall =
      input.target === "queue"
        ? classifyQueueCall(input.method, input.path)
        : { kind: "other" as const };
    let pricing: Awaited<ReturnType<typeof getEndpointPricing>> | null = null;
    if (queueCall.kind === "submit") {
      if (ctx.session.user.role !== "admin") {
        await requirePositiveBalance(ctx.db, userId);
      }
      pricing = await getEndpointPricing(queueCall.endpointId, platformFetchJson(apiKey, config));
    }

    let serialized: string | undefined;
    if (input.body !== undefined) {
      serialized = serializeBody(input.body);
      const bytes = new TextEncoder().encode(serialized).byteLength;
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
      ...FAL_STATIC_HEADERS,
      Authorization: `Key ${apiKey}`,
    };
    if (serialized !== undefined) headers["Content-Type"] = "application/json";
    // The docs MCP server answers with an SSE stream and 406s unless the
    // client advertises it accepts text/event-stream.
    if (input.target === "docs") headers.Accept = "application/json, text/event-stream";

    const fetchLabel = `fal ${input.target} ${input.method} ${input.path}`;
    const res = await fetchProviderResponse({
      url,
      label: fetchLabel,
      credentialed: true,
      init: { method: input.method, headers, body: serialized },
      // Result fetches of failed jobs come back non-2xx but may still carry
      // the billable-units header — we need the response, not a throw.
      tolerateHttpError: queueCall.kind === "result",
    });

    if (!res.ok) {
      // Failed-job result fetch. Settle only on an explicit usage signal;
      // with no header the hold stays for the status-poll release path
      // (fal doesn't bill failures, so guessing a charge here would be
      // wrong more often than not).
      const units = parseBillableUnits(res.headers.get("x-fal-billable-units"));
      if (queueCall.kind === "result" && units !== null) {
        try {
          await settleGeneration(ctx.db, queueCall.requestId, units);
        } catch (err) {
          console.error(`credit settle failed for ${queueCall.requestId}`, err);
        }
      }
      await throwProviderError(res, fetchLabel);
    }

    const empty = res.status === 204 || res.headers.get("content-length") === "0";
    const label = `fal ${input.target} response`;
    const body = empty
      ? null
      : input.target === "docs"
        ? await readSseJson(res, label)
        : await readJsonBounded(res, label);

    // Ledger updates ride the same hops the client already makes; the fal
    // call has succeeded by this point, so a charge always has a real
    // generation behind it. A ledger hiccup must never destroy the response
    // the user's money already bought — the ops are idempotent and converge
    // on this request's next hop, so log and move on.
    try {
      if (queueCall.kind === "submit" && pricing !== null) {
        const requestId = readRequestId(body);
        if (requestId !== null) {
          await holdGeneration(ctx.db, {
            userId,
            requestId,
            endpointId: queueCall.endpointId,
            unit: pricing.unit,
            unitPriceMicro: pricing.unitPriceMicro,
            holdMicro: pricing.holdMicro,
          });
        }
      } else if (queueCall.kind === "result") {
        // fal reports actual usage on the result fetch; a missing header
        // settles at the hold so the books still close.
        await settleGeneration(
          ctx.db,
          queueCall.requestId,
          parseBillableUnits(res.headers.get("x-fal-billable-units")),
        );
      } else if (queueCall.kind === "status" && isUnbilledTerminalStatus(readQueueStatus(body))) {
        // fal doesn't bill failed/cancelled jobs — refund the hold.
        await releaseGeneration(ctx.db, queueCall.requestId);
      }
    } catch (err) {
      console.error(`credit accounting failed for ${fetchLabel}`, err);
    }

    return body;
  }),
});
