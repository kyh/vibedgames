import type { Db } from "@repo/db/drizzle-client";
import type { modelsInput } from "@repo/contract/generate/generate-schema";
import type { JsonValue } from "@repo/contract/json";
import { endpointPath, jobPath, TERMINAL_STATUSES } from "@repo/contract/generate/queue-path";
import { ORPCError } from "@orpc/server";
import { z } from "zod";

import type { EndpointPricing, PlatformAnswer } from "../credits/endpoint-pricing";
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
import { purchasesEnabled } from "../credits/stripe";
import { os, requireSession } from "../orpc";
import { signUploadUrl } from "../storage/signed-urls";
import { forwardInput } from "./forward-input";
import { MAX_PARAMS_BYTES } from "./limits";
import { mediaRouter } from "./media-router";
import {
  fetchProviderResponse,
  readJsonBounded,
  readSseJson,
  throwProviderError,
} from "./provider-io";

const TARGET_DEFAULTS = {
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

const trimSlash = (url: string) => (url.endsWith("/") ? url.slice(0, -1) : url);

const nonBlank = (value: string | undefined) =>
  value !== undefined && value.trim().length > 0 ? value : undefined;

const targetBase = (target: Target, media: MediaProviderConfig) => {
  const override = nonBlank(media[TARGET_OVERRIDE_KEY[target]]);

  return trimSlash(override ?? TARGET_DEFAULTS[target]);
};

const badPath: (reason: string) => never = (reason) => {
  throw new ORPCError("BAD_REQUEST", { message: `path ${reason}.` });
};

const rejectTraversal = (path: string) => {
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

const buildUrl = (base: string, path: string, query?: Record<string, string | string[]>) => {
  rejectTraversal(path);
  const url = new URL(base + path);

  for (const [key, value] of Object.entries(query ?? {})) {
    const values = Array.isArray(value) ? value : [value];

    for (const v of values) {
      url.searchParams.append(key, v);
    }
  }

  return url;
};

type ForwardInput = z.infer<typeof forwardInput>;

const pickFalKey = (media: MediaProviderConfig | undefined) => {
  if (!media?.fal) {
    throw new ORPCError("PRECONDITION_FAILED", {
      message: "Media generation is not configured on the server (its API key is missing).",
    });
  }

  return { apiKey: media.fal, config: media };
};

const FAL_STATIC_HEADERS = {
  Accept: "application/json",
  "X-Fal-Store-IO": "1",
  "x-app-fal-disable-fallback": "true",
} as const;

const serializeBody = (input: ForwardInput) => {
  const { body } = input;

  if (body === undefined) {
    return;
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

const buildHeaders = (apiKey: string, target: Target, serialized: string | undefined) => {
  const headers = new Headers({
    ...FAL_STATIC_HEADERS,
    Authorization: `Key ${apiKey}`,
  });

  if (serialized !== undefined) {
    headers.set("Content-Type", "application/json");
  }

  if (target === "docs") {
    headers.set("Accept", "application/json, text/event-stream");
  }

  return headers;
};

const readBody = async (res: Response, target: Target) => {
  if (res.status === 204 || res.headers.get("content-length") === "0") {
    return null;
  }

  const label = `media ${target} response`;

  if (target === "docs") {
    return await readSseJson(res, label);
  }

  return await readJsonBounded(res, label);
};

const platformFetchJson =
  (apiKey: string, config: MediaProviderConfig) =>
  async (req: {
    method: "GET" | "POST";
    path: string;
    query?: Record<string, string>;
    body?: JsonValue;
  }) => {
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
      label: `media platform ${req.method} ${req.path}`,
      tolerateHttpError: true,
      url,
    });

    if (!res.ok) {
      await res.body?.cancel();

      return { ok: false, status: res.status } satisfies PlatformAnswer;
    }

    return {
      body: await readJsonBounded(res, "media platform response"),
      ok: true,
    } satisfies PlatformAnswer;
  };

export const requirePositiveBalance = async (db: Db, userId: string, canBuy: boolean) => {
  const balanceMicro = await getBalanceMicro(db, userId);

  if (balanceMicro > 0) {
    return;
  }

  const addCredit = canBuy
    ? "`vg credits buy <usd>` prints a checkout link for a person to pay, " +
      "`vg credits redeem <code>` applies a credit code, " +
      "or buy at https://vibedgames.com/settings#credits."
    : "`vg credits redeem <code>` applies a credit code, " +
      "or redeem one at https://vibedgames.com/settings#credits.";

  throw new ORPCError("FORBIDDEN", {
    message:
      `insufficient_credits: your balance is ${formatUsd(balanceMicro)}. ` +
      `Generation is paused until the account has credit: ${addCredit}`,
  });
};

const requirePublishedPrice = (pricing: EndpointPricing, endpointId: string) => {
  if (pricing.kind !== "unknown") {
    return;
  }

  throw new ORPCError("BAD_REQUEST", {
    message:
      `unknown_endpoint: no price is published for "${endpointId}", so it cannot be billed. ` +
      "Check the id with `vg generate models`.",
  });
};

const submitResponse = z.looseObject({ request_id: z.string().min(1) });

const readRequestId = (body: JsonValue) => {
  const parsed = submitResponse.safeParse(body);

  return parsed.success ? parsed.data.request_id : null;
};

const statusResponse = z.looseObject({ status: z.string() });

const readQueueStatus = (body: JsonValue) => {
  const parsed = statusResponse.safeParse(body);

  return parsed.success ? parsed.data.status : null;
};

const authed = os.generate.use(requireSession);

type ForwardCall = z.input<typeof forwardInput>;

const parseForward = (raw: ForwardCall) => {
  const parsed = forwardInput.safeParse(raw);

  if (!parsed.success) {
    throw new ORPCError("BAD_REQUEST", {
      message: parsed.error.issues.map((issue) => issue.message).join("; "),
    });
  }

  return parsed.data;
};

/** One hop to the media provider with the server's key, metered by the credit ledger. */
export const forward = async (context: ORPCContext, raw: ForwardCall) => {
  const user = context.session?.user;

  if (!user) {
    throw new ORPCError("UNAUTHORIZED");
  }

  const input = parseForward(raw);
  const { apiKey, config } = pickFalKey(context.media);
  const userId = user.id;

  const queueCall =
    input.target === "queue"
      ? classifyQueueCall(input.method, input.path)
      : { kind: "other" as const };

  let pricing: EndpointPricing | null = null;

  if (queueCall.kind === "submit") {
    const gated = user.role !== "admin";

    if (gated) {
      await requirePositiveBalance(context.db, userId, purchasesEnabled(context.billing));
    }

    pricing = await getEndpointPricing(queueCall.endpointId, platformFetchJson(apiKey, config));

    if (gated) {
      requirePublishedPrice(pricing, queueCall.endpointId);
    }
  }

  const serialized = serializeBody(input);
  const base = targetBase(input.target, config);
  const url = buildUrl(base, input.path, input.query);
  const headers = buildHeaders(apiKey, input.target, serialized);

  const fetchLabel = `media ${input.target} ${input.method} ${input.path}`;

  const res = await fetchProviderResponse({
    credentialed: true,
    init: { body: serialized, headers, method: input.method },
    label: fetchLabel,
    tolerateHttpError: queueCall.kind === "result",
    url,
  });

  if (!res.ok) {
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

  // WARNING: a ledger failure must never destroy a response the user already paid for.
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
      await settleGeneration(
        context.db,
        queueCall.requestId,
        parseBillableUnits(res.headers.get("x-fal-billable-units")),
      );
    } else if (queueCall.kind === "status" && isUnbilledTerminalStatus(readQueueStatus(body))) {
      await releaseGeneration(context.db, queueCall.requestId);
    }
  } catch (error) {
    console.error(`credit accounting failed for ${fetchLabel}`, error);
  }

  return body;
};

const hop = forward;

const POLL_MS = 2000;

const sleep = (ms: number) =>
  // oxlint-disable-next-line promise/avoid-new -- a Worker has no promise-returning timer to await
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

const queueStatus = async (context: ORPCContext, endpointId: string, requestId: string) => {
  const body = await hop(context, {
    method: "GET",
    path: jobPath(endpointId, requestId, "/status"),
    target: "queue",
  });

  return readQueueStatus(body)?.toUpperCase() ?? "UNKNOWN";
};

const queueResult = (context: ORPCContext, endpointId: string, requestId: string) =>
  hop(context, { method: "GET", path: jobPath(endpointId, requestId, ""), target: "queue" });

const confirmCancelled = async (context: ORPCContext, endpointId: string, requestId: string) => {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await sleep(1000);

    try {
      if (TERMINAL_STATUSES.has(await queueStatus(context, endpointId, requestId))) {
        return;
      }
    } catch {
      return;
    }
  }
};

const runModel = async (
  context: ORPCContext,
  input: { endpoint_id: string; input: Record<string, JsonValue>; wait_seconds: number },
) => {
  const endpointId = input.endpoint_id;

  const submission = await hop(context, {
    body: input.input,
    method: "POST",
    path: `/${endpointPath(endpointId)}`,
    target: "queue",
  });

  const requestId = readRequestId(submission);

  if (!requestId) {
    throw new ORPCError("BAD_GATEWAY", { message: "The model's queue returned no request_id." });
  }

  try {
    const deadline = Date.now() + input.wait_seconds * 1000;
    let status = readQueueStatus(submission)?.toUpperCase() ?? "IN_QUEUE";

    while (!TERMINAL_STATUSES.has(status) && Date.now() + POLL_MS <= deadline) {
      await sleep(POLL_MS);
      status = await queueStatus(context, endpointId, requestId);
    }

    const result =
      status === "COMPLETED" ? await queueResult(context, endpointId, requestId) : null;

    return { endpoint_id: endpointId, request_id: requestId, result, status };
  } catch (error) {
    const reason = error instanceof Error ? error.message : "no reason given";
    throw new ORPCError(error instanceof ORPCError ? error.code : "BAD_GATEWAY", {
      cause: error,
      message: `Submitted as request ${requestId} on ${endpointId}, then the poll failed (${reason}). Follow it with generate status rather than generating again.`,
    });
  }
};

const modelsQuery = (input: z.infer<typeof modelsInput>) => {
  const query: NonNullable<ForwardCall["query"]> = { limit: String(input.limit) };

  if (input.query) {
    query.q = input.query;
  }

  if (input.category) {
    query.category = input.category;
  }

  if (input.cursor) {
    query.cursor = input.cursor;
  }

  if (input.status && input.status !== "all") {
    query.status = input.status;
  }

  if (input.endpoint_id?.length) {
    query.endpoint_id = input.endpoint_id;
  }

  if (input.expand?.length) {
    query.expand = input.expand;
  }

  return query;
};

const storageSlot = z.object({
  file_url: z.url({ protocol: /^https$/u }),
  upload_url: z.url({ protocol: /^https$/u }),
});

const openStorageSlot = async (context: ORPCContext, contentType: string, fileName: string) => {
  const { apiKey, config } = pickFalKey(context.media);
  const serialized = JSON.stringify({ content_type: contentType, file_name: fileName });
  const label = "media storage upload slot";

  const res = await fetchProviderResponse({
    credentialed: true,
    init: {
      body: serialized,
      headers: buildHeaders(apiKey, "storage", serialized),
      method: "POST",
    },
    label,
    url: buildUrl(targetBase("storage", config), "/storage/upload/initiate"),
  });

  const slot = storageSlot.safeParse(await readJsonBounded(res, label));

  if (!slot.success) {
    throw new ORPCError("BAD_GATEWAY", { message: "Storage returned no upload slot." });
  }

  return slot.data;
};

/**
 * Puts bytes the server made (a processed asset) in generate's storage and
 * returns their stable URL, the same kind of URL a generation returns.
 */
export const storeFile = async (
  context: ORPCContext,
  file: { bytes: Uint8Array<ArrayBuffer>; contentType: string; fileName: string },
) => {
  const slot = await openStorageSlot(context, file.contentType, file.fileName);
  const label = "media storage upload";

  await fetchProviderResponse({
    credentialed: false,
    init: { body: file.bytes, headers: { "content-type": file.contentType }, method: "PUT" },
    label,
    url: slot.upload_url,
  });

  return slot.file_url;
};

export const generateRouter = {
  ...mediaRouter((context, endpoint, body, wait) =>
    runModel(context, { endpoint_id: endpoint, input: body, wait_seconds: wait }),
  ),

  docs: authed.docs.handler(({ context, input }) =>
    hop(context, {
      body: {
        id: 1,
        jsonrpc: "2.0",
        method: "tools/call",
        params: { arguments: { query: input.query }, name: "search_fal" },
      },
      method: "POST",
      path: "/docs/mcp",
      target: "docs",
    }),
  ),

  models: authed.models.handler(({ context, input }) =>
    hop(context, {
      method: "GET",
      path: "/v1/models",
      query: modelsQuery(input),
      target: "platform",
    }),
  ),

  pricing: authed.pricing.handler(({ context, input }) =>
    hop(context, {
      method: "GET",
      path: "/v1/models/pricing",
      query: { endpoint_id: input.endpoint_id },
      target: "platform",
    }),
  ),

  run: authed.run.handler(({ context, input }) => runModel(context, input)),

  schema: authed.schema.handler(({ context, input }) => {
    const query: NonNullable<ForwardCall["query"]> = { endpoint_id: input.endpoint_id, limit: "1" };

    if (input.format === "openapi") {
      query.expand = ["openapi-3.0"];
    }

    return hop(context, { method: "GET", path: "/v1/models", query, target: "platform" });
  }),

  status: authed.status.handler(async ({ context, input }) => {
    if (input.action === "result") {
      return queueResult(context, input.endpoint_id, input.request_id);
    }

    if (input.action === "cancel") {
      try {
        return await hop(context, {
          method: "PUT",
          path: jobPath(input.endpoint_id, input.request_id, "/cancel"),
          target: "queue",
        });
      } finally {
        await confirmCancelled(context, input.endpoint_id, input.request_id);
      }
    }

    return hop(context, {
      method: "GET",
      path: jobPath(input.endpoint_id, input.request_id, "/status"),
      query: input.logs ? { logs: "1" } : undefined,
      target: "queue",
    });
  }),

  /**
   * Opens a storage slot for a model input and hands back a signed
   * `/api/upload` URL that forwards to it, so the caller only ever PUTs to
   * this host. Uploads aren't billed.
   */
  upload: authed.upload.handler(async ({ context, input }) => {
    if (!context.signing) {
      throw new ORPCError("PRECONDITION_FAILED", {
        message: "Uploads are not configured on the server.",
      });
    }

    const slot = await openStorageSlot(context, input.contentType, input.fileName);

    return {
      fileUrl: slot.file_url,
      headers: { "content-type": input.contentType },
      uploadUrl: await signUploadUrl({
        contentType: input.contentType,
        signing: context.signing,
        target: { url: slot.upload_url },
      }),
    };
  }),
};
