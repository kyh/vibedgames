import type { Db } from "@repo/db/drizzle-client";
import type { JsonValue } from "@repo/contract/json";
import { forwardInput } from "@repo/contract/generate/generate-schema";
import { ORPCError } from "@orpc/server";
import { z } from "zod";

import type { MediaProviderConfig, ORPCContext } from "../orpc";
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
import { MAX_PARAMS_BYTES } from "./limits";
import {
  fetchProviderResponse,
  readJsonBounded,
  readSseJson,
  throwProviderError,
} from "./provider-io";

// ---- fal target routing -----------------------------------------------------
//
// Each hop names a target (queue / platform / storage / docs) which picks the
// upstream host; the rest of the URL is `path` plus optional `query`.
// Per-target overrides come from MediaProviderConfig so deployments can
// route any target through a Cloudflare AI Gateway prefix.

const TARGET_DEFAULTS = {
  // fal's docs MCP lives at fal.ai/docs/mcp (docs.fal.ai 308-redirects
  // here, which we refuse to follow with credentials). It speaks MCP
  // streamable-HTTP and answers with text/event-stream, not JSON — see
  // the docs branch in `forward`.
  docs: "https://fal.ai",
  platform: "https://api.fal.ai",
  queue: "https://queue.fal.run",
  storage: "https://rest.alpha.fal.ai",
} as const;

type Target = keyof typeof TARGET_DEFAULTS;

const TARGET_OVERRIDE_KEY = {
  docs: "falDocsBaseUrl",
  platform: "falPlatformBaseUrl",
  queue: "falQueueBaseUrl",
  storage: "falStorageBaseUrl",
} as const satisfies Record<Target, keyof MediaProviderConfig>;

const trimSlash = (url: string): string => (url.endsWith("/") ? url.slice(0, -1) : url);

const nonBlank = (value: string | undefined): string | undefined =>
  value !== undefined && value.trim().length > 0 ? value : undefined;

const targetBase = (target: Target, media: MediaProviderConfig): string => {
  const override = nonBlank(media[TARGET_OVERRIDE_KEY[target]]);
  return trimSlash(override ?? TARGET_DEFAULTS[target]);
};

const badPath: (reason: string) => never = (reason) => {
  throw new ORPCError("BAD_REQUEST", { message: `path ${reason}.` });
};

const rejectTraversal = (path: string): void => {
  // Reject literal `..` and any percent-encoded form. The `URL` parser
  // doesn't decode `%2e%2e` itself — so `new URL(...)` would happily
  // produce a URL whose pathname looks fine here but whose downstream
  // server (or a reverse proxy) might decode and resolve as a traversal,
  // letting a request escape the target host's intended namespace
  // while we attach FAL_API_KEY to it. Percent-encoded slashes get the
  // same treatment because they'd fold into segment separators after
  // decoding and could push the request past a pathname-aware allowlist.
  if (path.includes("..")) {
    badPath("may not contain `..`");
  }
  if (!path.includes("%")) {
    return;
  }
  let decoded: string;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    badPath("has invalid percent-encoding");
  }
  if (decoded.includes("..")) {
    badPath("may not contain `..` (including percent-encoded forms)");
  }
  if (/%2f|%5c/iu.test(path)) {
    badPath("may not contain percent-encoded path separators");
  }
};

const buildUrl = (
  base: string,
  path: string,
  query: Record<string, string | string[]> | undefined,
): URL => {
  rejectTraversal(path);
  // `path` is already Zod-constrained to start with `/`, and
  // rejectTraversal blocks every `..` form (literal, percent-decoded,
  // and percent-encoded separators). With those guards `new URL(base
  // + path)` can't escape the target origin.
  const url = new URL(base + path);
  for (const [key, value] of Object.entries(query ?? {})) {
    const values = Array.isArray(value) ? value : [value];
    for (const v of values) {
      url.searchParams.append(key, v);
    }
  }
  return url;
};

// ---- Requests ----------------------------------------------------------------

/** One hop: what `generate.forward` takes, and what each typed procedure builds. */
export type FalRequest = z.infer<typeof forwardInput>;

export type FalQuery = NonNullable<FalRequest["query"]>;

// ---- Helpers ---------------------------------------------------------------

const pickFalKey = (media: MediaProviderConfig | undefined) => {
  if (!media?.fal) {
    throw new ORPCError("PRECONDITION_FAILED", {
      message: "fal is not configured on the server (FAL_API_KEY missing).",
    });
  }
  return { apiKey: media.fal, config: media };
};

// X-Fal-Store-IO: keep outputs on fal CDN, not inlined as base64.
// x-app-fal-disable-fallback: surface failures instead of routing to a
// different model silently. Both apply to queue submits but are
// harmless on other targets, so we send them unconditionally.
const FAL_STATIC_HEADERS = {
  Accept: "application/json",
  "X-Fal-Store-IO": "1",
  "x-app-fal-disable-fallback": "true",
} as const;

const serializeBody = (input: FalRequest): string | undefined => {
  const { body } = input;
  if (body === undefined) {
    return undefined;
  }
  let serialized: string;
  try {
    serialized = JSON.stringify(body);
  } catch {
    throw new ORPCError("BAD_REQUEST", {
      message: "body must be JSON-serializable.",
    });
  }
  const bytes = new TextEncoder().encode(serialized).byteLength;
  if (bytes > MAX_PARAMS_BYTES) {
    throw new ORPCError("PAYLOAD_TOO_LARGE", {
      message: `body exceeds ${MAX_PARAMS_BYTES} bytes.`,
    });
  }
  return serialized;
};

const buildHeaders = (apiKey: string, target: Target, serialized: string | undefined): Headers => {
  const headers = new Headers({
    ...FAL_STATIC_HEADERS,
    Authorization: `Key ${apiKey}`,
  });
  if (serialized !== undefined) {
    headers.set("Content-Type", "application/json");
  }
  // The docs MCP server answers with an SSE stream and 406s unless the
  // client advertises it accepts text/event-stream.
  if (target === "docs") {
    headers.set("Accept", "application/json, text/event-stream");
  }
  return headers;
};

const readBody = async (res: Response, target: Target): Promise<JsonValue | null> => {
  if (res.status === 204 || res.headers.get("content-length") === "0") {
    return null;
  }
  const label = `fal ${target} response`;
  if (target === "docs") {
    return await readSseJson(res, label);
  }
  return await readJsonBounded(res, label);
};

// ---- credit accounting ------------------------------------------------------

/**
 * Credentialed platform-API transport for pricing lookups. Same
 * fetch/parse path as user-driven platform hops so size bounds and
 * redirect policy apply.
 */
const platformFetchJson =
  (apiKey: string, config: MediaProviderConfig) =>
  async (req: {
    method: "GET" | "POST";
    path: string;
    query?: Record<string, string>;
    body?: JsonValue;
  }): Promise<JsonValue> => {
    const url = buildUrl(targetBase("platform", config), req.path, req.query);
    const headers = new Headers({
      Accept: "application/json",
      Authorization: `Key ${apiKey}`,
    });
    let body: string | undefined;
    if (req.body !== undefined) {
      body = JSON.stringify(req.body);
      headers.set("Content-Type", "application/json");
    }
    const res = await fetchProviderResponse({
      credentialed: true,
      init: { body, headers, method: req.method },
      label: `fal platform ${req.method} ${req.path}`,
      url,
    });
    return readJsonBounded(res, "fal platform response");
  };

/**
 * Gate a queue submit on remaining credits. Balance must be positive to
 * start a generation; the estimated hold may push it negative, which
 * simply blocks the next submit. The message carries the
 * `insufficient_credits` token so agents can branch on it.
 */
const requirePositiveBalance = async (db: Db, userId: string): Promise<void> => {
  const balanceMicro = await getBalanceMicro(db, userId);
  if (balanceMicro > 0) {
    return;
  }
  throw new ORPCError("FORBIDDEN", {
    message:
      `insufficient_credits: your balance is ${formatUsd(balanceMicro)}. ` +
      "Generation is paused until an admin grants more credits " +
      "(check with `vg credits`).",
  });
};

const submitResponse = z.looseObject({ request_id: z.string().min(1) });

const readRequestId = (body: JsonValue): string | null => {
  const parsed = submitResponse.safeParse(body);
  return parsed.success ? parsed.data.request_id : null;
};

const statusResponse = z.looseObject({ status: z.string() });

const readQueueStatus = (body: JsonValue): string | null => {
  const parsed = statusResponse.safeParse(body);
  return parsed.success ? parsed.data.status : null;
};

// ---- Call -------------------------------------------------------------------

/** What a fal hop needs from the request context: who is paying, and where. */
export interface FalCallContext {
  db: ORPCContext["db"];
  media: ORPCContext["media"];
  session: { user: { id: string; role?: string | null } };
}

/**
 * One credentialed hop to fal, with the credit gate and ledger bookkeeping.
 * Every generate procedure funnels through here, so billing is keyed on the
 * hop itself and can't be skipped by picking a different procedure.
 */
export const callFal = async (context: FalCallContext, input: FalRequest): Promise<JsonValue> => {
  // The credit classifier and pricing read `path` as given, while fal gets
  // `new URL(base + path)`. `generate.forward`'s input schema already holds
  // its path to what the URL parser leaves alone; the typed procedures build
  // theirs on the server, so every hop is held to the same rule here, where
  // they all pass, before anything is priced or fetched.
  if (!forwardInput.shape.path.safeParse(input.path).success) {
    badPath("must hold only characters the URL parser leaves alone, and no `.` or `..` segment");
  }

  const { apiKey, config } = pickFalKey(context.media);
  const userId = context.session.user.id;

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
    if (context.session.user.role !== "admin") {
      await requirePositiveBalance(context.db, userId);
    }
    pricing = await getEndpointPricing(queueCall.endpointId, platformFetchJson(apiKey, config));
  }

  const serialized = serializeBody(input);
  const base = targetBase(input.target, config);
  const url = buildUrl(base, input.path, input.query);
  const headers = buildHeaders(apiKey, input.target, serialized);

  const fetchLabel = `fal ${input.target} ${input.method} ${input.path}`;
  const res = await fetchProviderResponse({
    credentialed: true,
    init: { body: serialized, headers, method: input.method },
    label: fetchLabel,
    // Result fetches of failed jobs come back non-2xx but may still carry
    // the billable-units header — we need the response, not a throw.
    tolerateHttpError: queueCall.kind === "result",
    url,
  });

  if (!res.ok) {
    // Failed-job result fetch. Settle only on an explicit usage signal;
    // with no header the hold stays for the status-poll release path
    // (fal doesn't bill failures, so guessing a charge here would be
    // wrong more often than not).
    const units = parseBillableUnits(res.headers.get("x-fal-billable-units"));
    if (queueCall.kind === "result" && units !== null) {
      try {
        await settleGeneration(context.db, queueCall.requestId, units);
      } catch (error) {
        console.error(`credit settle failed for ${queueCall.requestId}`, error);
      }
    }
    await throwProviderError(res, fetchLabel);
  }

  const body = await readBody(res, input.target);

  // Ledger updates ride the same hops the client already makes; the fal
  // call has succeeded by this point, so a charge always has a real
  // generation behind it. A ledger hiccup must never destroy the response
  // the user's money already bought — the ops are idempotent and converge
  // on this request's next hop, so log and move on.
  try {
    if (queueCall.kind === "submit" && pricing !== null) {
      const requestId = readRequestId(body);
      if (requestId !== null) {
        await holdGeneration(context.db, {
          endpointId: queueCall.endpointId,
          holdMicro: pricing.holdMicro,
          requestId,
          unit: pricing.unit,
          unitPriceMicro: pricing.unitPriceMicro,
          userId,
        });
      }
    } else if (queueCall.kind === "result") {
      // fal reports actual usage on the result fetch; a missing header
      // settles at the hold so the books still close.
      await settleGeneration(
        context.db,
        queueCall.requestId,
        parseBillableUnits(res.headers.get("x-fal-billable-units")),
      );
    } else if (queueCall.kind === "status" && isUnbilledTerminalStatus(readQueueStatus(body))) {
      // fal doesn't bill failed/cancelled jobs — refund the hold.
      await releaseGeneration(context.db, queueCall.requestId);
    }
  } catch (error) {
    console.error(`credit accounting failed for ${fetchLabel}`, error);
  }

  return body;
};
