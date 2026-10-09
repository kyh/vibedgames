import type { ORPCContext } from "@repo/service/orpc";
import { CLI_VERSION_HEADER } from "@repo/contract/cli";
import { appRouter } from "@repo/service";
import { MAX_RPC_BODY_BYTES } from "@repo/service/generate/limits";
import { SmartCoercionHandlerPlugin } from "@orpc/json-schema";
import { OpenAPIHandler } from "@orpc/openapi/fetch";
import { COMMON_ERROR_STATUS_MAP, onError, ORPCError } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import { BatchHandlerPlugin, RequestLimitHandlerPlugin } from "@orpc/server/plugins";
import { ZodToJsonSchemaConverter } from "@orpc/zod";
import { z } from "zod";

import { jsonError } from "@/lib/json-error";

// No CORS headers, and none belong here: every client reaches these routes
// same-origin (the web app is served from it) or from a non-browser runtime
// that doesn't enforce CORS (the CLI). Credentialed CORS headers would hand a
// cross-origin page authenticated access. GET, the one method a cookie-bearing
// navigation can reach, matches no procedure on either transport: the RPC
// handler's default `allowMethods` leaves it off, and every procedure is POST
// in the OpenAPI routing.

const RPC_PREFIX = "/api/orpc";

/** The REST view of the same router, described by `/openapi.json`. */
export const REST_PREFIX = "/api/v1";

// An unknown code has no entry and falls back to 500, so a code this app adds
// later logs by default rather than disappearing.
const ERROR_STATUS = new Map<string, number>(Object.entries(COMMON_ERROR_STATUS_MAP));

// `pickFalKey` answers 412 because that is the honest code for the caller, but
// a missing FAL_API_KEY is the deploy's fault, not the request's.
const FAULTS_BELOW_500 = new Set(["PRECONDITION_FAILED"]);

// `undefined` because oRPC types an interceptor's error over a generic error
// map, whose optional keys add it to the union.
const reportFaults = (error: Error | undefined) => {
  if (error instanceof ORPCError) {
    // Observability is billable on this Worker. A procedure answering
    // deliberately — an expired session, a zod rejection, `auth.cliPoll`
    // telling a polling CLI "not confirmed yet" — would bury the real
    // errors, so only a fault gets a line.
    const status = ERROR_STATUS.get(error.code) ?? 500;
    if (status < 500 && !FAULTS_BELOW_500.has(error.code)) {
      return;
    }
  }
  console.error(">>> oRPC Error", error);
};

// The Worker memory ceiling is 128 MB and JSON.parse holds the raw bytes, the
// decoded string, and the parsed object in memory at once, so reject
// pathologically large bodies up front rather than relying on the per-field
// caps inside the procedures.
const bodyLimit = () => new RequestLimitHandlerPlugin({ maxBodySize: MAX_RPC_BODY_BYTES });

const rpcHandler = new RPCHandler(appRouter, {
  clientInterceptors: [onError(reportFaults)],
  plugins: [
    // Paired with the link's `BatchLinkPlugin`. It re-dispatches each item
    // through this same `handle()` call, so a batch costs one context build
    // and one session read for the whole page, not one per query.
    new BatchHandlerPlugin(),
    bodyLimit(),
  ],
});

const restHandler = new OpenAPIHandler(appRouter, {
  clientInterceptors: [onError(reportFaults)],
  plugins: [
    bodyLimit(),
    // Plain JSON has no Date: the spec promises ISO strings for date inputs,
    // and this turns them back into what the zod schemas validate.
    new SmartCoercionHandlerPlugin({ converters: [new ZodToJsonSchemaConverter()] }),
  ],
});

/**
 * SameSite=Lax on the session cookie is not the whole story here, because
 * `SameSite` keys on *site*, not origin: `{slug}.vibedgames.com` — where users
 * run arbitrary uploaded code — is same-site with `vibedgames.com`, so a plain
 * `<form method=POST>` on a game page rides the session cookie into a mutation
 * with no preflight to stop it. Browsers set `Origin` on every POST and page
 * script cannot forge it, so an `Origin` that isn't ours is the signal.
 *
 * Absent `Origin` passes: that is the CLI and other non-browser callers, which
 * authenticate by bearer token rather than by an ambiently-attached cookie and
 * so have nothing to forge.
 *
 * Checked here rather than in a handler plugin so it runs once on the real
 * request, before `BatchHandlerPlugin` fans a batch out into sub-requests
 * whose headers the client authored.
 */
const isCrossOrigin = (request: Request): boolean => {
  const origin = request.headers.get("origin");
  return origin !== null && origin !== new URL(request.url).origin;
};

/**
 * A `vg` from before oRPC 2.0.0-beta.34, which dropped `inferable` from the
 * error body. Its client checks the body's keys exactly, so without the field
 * every refusal reaches it as MALFORMED_ORPC_RESPONSE and its code is lost. It
 * fetches as Node and sends no {@link CLI_VERSION_HEADER}; browsers never say
 * `node`. Remove once those installs have updated.
 */
const isPreHeaderCli = (request: Request): boolean =>
  request.headers.get("user-agent") === "node" && !request.headers.has(CLI_VERSION_HEADER);

const rpcErrorBody = z.looseObject({ json: z.looseObject({ code: z.string() }) });

const withInferable = async (response: Response): Promise<Response> => {
  if (response.ok) {
    return response;
  }
  const body = rpcErrorBody.safeParse(
    await response
      .clone()
      .json()
      .catch(() => null),
  );
  if (!body.success || "inferable" in body.data.json) {
    return response;
  }
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  return Response.json(
    { ...body.data, json: { ...body.data.json, inferable: false } },
    { headers, status: response.status },
  );
};

export const handleRpcRequest = async (
  request: Request,
  context: ORPCContext,
): Promise<Response> => {
  if (isCrossOrigin(request)) {
    return jsonError(403, "FORBIDDEN", "Cross-origin request blocked.");
  }

  const { response } = await rpcHandler.handle(request, { context, prefix: RPC_PREFIX });
  if (!response) {
    return jsonError(404, "NOT_FOUND", "No procedure at this path. Procedures are POST-only.");
  }
  return isPreHeaderCli(request) ? await withInferable(response) : response;
};

/** Same guards as {@link handleRpcRequest}; only the wire format differs. */
export const handleRestRequest = async (
  request: Request,
  context: ORPCContext,
): Promise<Response> => {
  if (isCrossOrigin(request)) {
    return jsonError(403, "FORBIDDEN", "Cross-origin request blocked.");
  }

  const { response } = await restHandler.handle(request, { context, prefix: REST_PREFIX });
  return (
    response ??
    jsonError(404, "NOT_FOUND", "No operation at this path and method. See /openapi.json.")
  );
};
