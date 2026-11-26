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

const RPC_PREFIX = "/api/orpc";

/** The REST view of the same router, described by `/openapi.json`. */
export const REST_PREFIX = "/api/v1";

const ERROR_STATUS = new Map<string, number>(Object.entries(COMMON_ERROR_STATUS_MAP));

const FAULTS_BELOW_500 = new Set(["PRECONDITION_FAILED"]);

export const reportFaults = (error: Error | undefined) => {
  if (error instanceof ORPCError) {
    const code = String(error.code);
    const status = ERROR_STATUS.get(code) ?? 500;

    if (status < 500 && !FAULTS_BELOW_500.has(code)) {
      return;
    }
  }

  console.error(">>> oRPC Error", error);
};

const bodyLimit = () => new RequestLimitHandlerPlugin({ maxBodySize: MAX_RPC_BODY_BYTES });

const rpcHandler = new RPCHandler(appRouter, {
  clientInterceptors: [onError(reportFaults)],
  plugins: [new BatchHandlerPlugin(), bodyLimit()],
});

const restHandler = new OpenAPIHandler(appRouter, {
  clientInterceptors: [onError(reportFaults)],
  plugins: [
    bodyLimit(),
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
export const isCrossOrigin = (request: Request) => {
  const origin = request.headers.get("origin");

  return origin !== null && origin !== new URL(request.url).origin;
};

const isPreHeaderCli = (request: Request) =>
  request.headers.get("user-agent") === "node" && !request.headers.has(CLI_VERSION_HEADER);

const rpcErrorBody = z.looseObject({ json: z.looseObject({ code: z.string() }) });

const withInferable = async (response: Response) => {
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

export const handleRpcRequest = async (request: Request, context: ORPCContext) => {
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
export const handleRestRequest = async (request: Request, context: ORPCContext) => {
  if (isCrossOrigin(request)) {
    return jsonError(403, "FORBIDDEN", "Cross-origin request blocked.");
  }

  const { response } = await restHandler.handle(request, { context, prefix: REST_PREFIX });

  return (
    response ??
    jsonError(404, "NOT_FOUND", "No operation at this path and method. See /openapi.json.")
  );
};
