import type { ORPCContext } from "@repo/service/orpc";
import { appRouter } from "@repo/service";
import { MAX_RPC_BODY_BYTES } from "@repo/service/generate/limits";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { SmartCoercionHandlerPlugin } from "@orpc/json-schema";
import type { McpToolMeta } from "@orpc/mcp";
import type { AnyProcedure } from "@orpc/server";
import { McpRegistrar, mcp } from "@orpc/mcp";
import { DecoratedProcedure, onError, ORPCError } from "@orpc/server";
import { ZodToJsonSchemaConverter } from "@orpc/zod";

import { jsonError } from "@/lib/json-error";
import { isCrossOrigin, reportFaults } from "@/lib/orpc-handler";

/**
 * `/mcp`: the API's procedures an agent can drive without a shell, as MCP
 * tools, authenticated by the same `vg_…` API key the CLI uses.
 *
 * Each tool is the implemented procedure itself, so it runs the same
 * middleware, validation and credit gate as `/api/orpc`; a tool's name is its
 * router path (`deploy_list`), its title and description the OpenAPI meta's
 * unless `mcp.tool` says otherwise. The MCP meta lives here, not in
 * `@repo/contract`, which the CLI bundles and `@orpc/mcp` would drag the MCP
 * SDK into.
 *
 * Left out on purpose: `deploy.create`/`finalize`, whose presigned PUTs need a
 * local build and an HTTP client (`vg deploy` does both); `playtest.*`, which
 * the in-page playtester calls with its own token; and every session-only or
 * admin procedure, which an API key cannot reach anyway.
 */

/**
 * A contract-first procedure takes its meta from the contract, so the
 * implemented one has no `.meta()`; re-decorating its definition keeps the
 * handler and middleware and adds the tool's.
 */
const asTool = <T extends AnyProcedure>(procedure: T, meta: McpToolMeta) =>
  new DecoratedProcedure(procedure["~orpc"]).meta(mcp.tool(meta));

const readOnly = { openWorldHint: false, readOnlyHint: true } as const;

const mutates = { destructiveHint: false, readOnlyHint: false } as const;

const tools = {
  auth: {
    me: asTool(appRouter.auth.me, { annotations: readOnly }),
  },
  credits: {
    checkout: asTool(appRouter.credits.checkout, {
      annotations: { ...mutates, openWorldHint: true },
    }),
    me: asTool(appRouter.credits.me, { annotations: readOnly }),
    redeem: asTool(appRouter.credits.redeem, {
      annotations: { ...mutates, idempotentHint: true, openWorldHint: false },
    }),
  },
  deploy: {
    delete: asTool(appRouter.deploy.delete, {
      annotations: {
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
        readOnlyHint: false,
      },
    }),
    getSource: asTool(appRouter.deploy.getSource, { annotations: readOnly }),
    list: asTool(appRouter.deploy.list, { annotations: readOnly }),
  },
  generate: {
    forward: asTool(appRouter.generate.forward, {
      annotations: { ...mutates, openWorldHint: true },
      // The OpenAPI description names the provider; agent-facing text does not.
      description: [
        "Generates images, video, audio, 3D and text with hosted models, billed against your credits.",
        "Find a model: GET /v1/models with target `platform` (query `q` to search, `endpoint_id` to look one up, `expand: openapi-3.0` for its input schema); GET /v1/models/pricing?endpoint_id=… for its price.",
        "Run it: POST /<endpoint-id> with target `queue` and the model's input as `body`; the answer carries a `request_id`.",
        "Follow it with target `queue` on the endpoint's app id (its first two segments, three for `workflows/` and `comfy/` ids): GET /<app-id>/requests/<request_id>/status until COMPLETED, then GET /<app-id>/requests/<request_id> for the result, or PUT …/cancel.",
        "Submits need a positive credit balance (403 `insufficient_credits`) and a model with a published price (400 `unknown_endpoint`). Returns the upstream JSON body.",
      ].join(" "),
    }),
  },
};

const converters = [new ZodToJsonSchemaConverter()];

const API_KEY_HINT =
  "Send an API key as `Authorization: Bearer vg_…`; create one at vibedgames.com/settings.";

const registrar = new McpRegistrar(tools, {
  clientInterceptors: [
    onError(reportFaults),
    // A bare "Unauthorized" leaves an agent nothing to act on.
    async ({ next }) => {
      try {
        return await next();
      } catch (error) {
        if (error instanceof ORPCError && error.code === "UNAUTHORIZED") {
          throw new ORPCError("UNAUTHORIZED", { cause: error, message: API_KEY_HINT });
        }
        throw error;
      }
    },
  ],
  converters,
  plugins: [new SmartCoercionHandlerPlugin({ converters })],
});

const instructions = [
  "vibedgames hosts browser games at {slug}.vibedgames.com and gives coding agents the abilities of a game studio.",
  "These tools read your account, credits and games, delete a game, fork a game's source, and generate media assets.",
  "Deploying a build needs the CLI: `npx vibedgames deploy` uploads the files and makes them live.",
  API_KEY_HINT,
].join(" ");

/** Builds a fresh server per request: the handler is stateless, so nothing outlives a call. */
export const createVibedgamesMcpHandler = (context: ORPCContext) =>
  createMcpHandler(async () => {
    const server = new McpServer({ name: "vibedgames", version: "1.0.0" }, { instructions });
    await registrar.register(server, { context });
    return server;
  });

/**
 * Credentials are bearer-only: the cookie is dropped before the context is
 * built, so a page on a same-site game subdomain cannot ride a signed-in
 * user's session into a tool call. The `Origin` check is MCP's own
 * DNS-rebinding guard and matches `/api/orpc`'s.
 */
export const withoutCookies = (headers: Headers): Headers => {
  const bearerOnly = new Headers(headers);
  bearerOnly.delete("cookie");
  return bearerOnly;
};

/**
 * The body, read no further than `limit` bytes; `null` once it would pass it.
 * `Content-Length` is the client's claim, and a chunked body has none, so the
 * stream itself is counted and cancelled at the cap.
 */
const readCapped = async (
  stream: ReadableStream<Uint8Array>,
  limit: number,
): Promise<Uint8Array<ArrayBuffer> | null> => {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
};

const tooLarge = () => jsonError(413, "PAYLOAD_TOO_LARGE", "Request body is too large.");

export const handleMcpRequest = async (
  request: Request,
  createContext: (headers: Headers) => Promise<ORPCContext>,
): Promise<Response> => {
  if (isCrossOrigin(request)) {
    return jsonError(403, "FORBIDDEN", "Cross-origin request blocked.");
  }
  if (Number(request.headers.get("content-length") ?? 0) > MAX_RPC_BODY_BYTES) {
    return tooLarge();
  }
  const body = request.body ? await readCapped(request.body, MAX_RPC_BODY_BYTES) : undefined;
  if (body === null) {
    return tooLarge();
  }
  const headers = withoutCookies(request.headers);
  const handler = createVibedgamesMcpHandler(await createContext(headers));
  return handler.fetch(new Request(request.url, { body, headers, method: request.method }));
};
