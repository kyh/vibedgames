import type { ORPCContext } from "@repo/service/orpc";
import { MAX_RPC_BODY_BYTES } from "@repo/service/generate/limits";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { SmartCoercionHandlerPlugin } from "@orpc/json-schema";
import { McpRegistrar } from "@orpc/mcp";
import { onError } from "@orpc/server";
import { ZodToJsonSchemaConverter } from "@orpc/zod";
import { getRequiredScope } from "@repo/contract/base";
import { OAUTH_SCOPES } from "@repo/contract/auth/oauth-scopes";
import { createResourceServerChallenge } from "@better-auth/oauth-provider";
import { APIError } from "better-auth/api";
import { createInsufficientScopeError } from "better-auth/oauth2";
import { z } from "zod";

import { jsonError } from "@/lib/json-error";
import { registerSkills } from "@/lib/mcp-skills";
import type { McpContext, Skill } from "@/lib/mcp-tools";
import { tools } from "@/lib/mcp-tools";
import { isCrossOrigin, reportFaults } from "@/lib/orpc-handler";

/**
 * `/mcp`: the tools in `mcp-tools.ts` over stateless Streamable HTTP,
 * authenticated by an OAuth access token issued for this resource (what
 * claude.ai and other connector clients get from the consent flow) or the
 * same `vg_…` API key the CLI uses. Without either, every request answers
 * 401 with the RFC 9728 challenge that points a client at the
 * authorization server, and a token calling a tool outside its scopes gets
 * the 403 `insufficient_scope` challenge. A tool call runs
 * through the same handler stack as `/api/orpc`, so its middleware,
 * validation and credit gate are the API's. The MCP meta lives in `apps/web`,
 * not `@repo/contract`, which the CLI bundles and `@orpc/mcp` would drag the
 * MCP SDK into.
 */

const converters = [new ZodToJsonSchemaConverter()];

const API_KEY_HINT =
  "Connect with OAuth, or send an API key as `Authorization: Bearer vg_…`; create one at vibedgames.com/settings.";

/**
 * What a connector should ask for: every action scope, the person's
 * profile, and a refresh token so it stays connected.
 */
const CHALLENGE_SCOPES = ["profile", "offline_access", ...Object.keys(OAUTH_SCOPES)];

/**
 * A challenge as `@better-auth/oauth-provider` builds it (RFC 6750 and the
 * RFC 9728 `resource_metadata` pointer), with the JSON-RPC error body
 * `@better-auth/mcp` sends alongside.
 */
const challengeResponse = (
  request: Request,
  error: Parameters<typeof createResourceServerChallenge>[0],
): Response => {
  const resource = `${new URL(request.url).origin}/mcp`;
  const challenge = createResourceServerChallenge(error, resource, {
    challengeScopes: CHALLENGE_SCOPES,
  });
  if (!challenge) {
    throw error;
  }
  const headers = new Headers(challenge.headers);
  headers.set("content-type", "application/json");
  return Response.json(
    { error: { code: -32_000, message: challenge.message }, id: null, jsonrpc: "2.0" },
    { headers, status: challenge.statusCode },
  );
};

/** The 401 an OAuth client starts from (MCP authorization, RFC 9728 §5.1). */
const unauthorized = (request: Request) =>
  challengeResponse(request, new APIError("UNAUTHORIZED", { message: API_KEY_HINT }));

const toolCall = z.object({
  method: z.literal("tools/call"),
  params: z.object({ name: z.string() }),
});

/** Each tool's scope, read off the procedure behind it. */
const toolScopes = new Map(
  Object.entries(tools).map(([name, tool]) => [name, getRequiredScope(tool)]),
);

/** The tool a JSON-RPC body calls, or null for any other message. */
const calledTool = (body: Uint8Array | undefined): string | null => {
  if (!body) {
    return null;
  }
  try {
    const call = toolCall.safeParse(JSON.parse(new TextDecoder().decode(body)));
    return call.success ? call.data.params.name : null;
  } catch {
    return null;
  }
};

/**
 * The scope a `tools/call` needs that the access token lacks, or null. The
 * procedure behind the tool refuses it anyway; answering here, before the
 * call, turns that into the HTTP 403 `insufficient_scope` challenge a client
 * steps up from (RFC 6750 §3.1), rather than a tool error it cannot act on.
 */
const missingScope = (body: Uint8Array | undefined, granted: readonly string[]) => {
  const name = calledTool(body);
  const required = name ? toolScopes.get(name) : undefined;
  return required && !granted.includes(required) ? required : null;
};

const registrar = new McpRegistrar(tools, {
  clientInterceptors: [onError(reportFaults)],
  converters,
  plugins: [new SmartCoercionHandlerPlugin({ converters })],
});

const instructions = [
  "vibedgames hosts browser games at {slug}.vibedgames.com and gives coding agents the abilities of a game studio.",
  "Start with `skills` for how to build, art-direct and ship a game; `generate_image`, `generate_video`, `generate_speech`, `generate_music`, `generate_sound`, `generate_3d` and `remove_background` make its assets on default models, `generate` runs any other model; `deploy` puts it live.",
  "If you have a shell, the `vg` CLI does all of this in one step per job: `npx vibedgames deploy ./dist` with `VG_TOKEN` set to the same API key. Each tool here is named for its `vg` command, spaces as `_` (`vg generate run` is `generate`).",
  "To deploy with the tool: call `deploy` with `bundle: true`, PUT the built game as one gzipped tar (`tar -czf game.tgz -C dist .`, index.html at its root) to `bundleUpload` (`curl -T game.tgz -H 'Content-Type: application/gzip' \"$url\"`), then call `deploy` with the `deploymentId` and `publish: true`. With no shell, send text files in `files` and generated assets as `encoding: url`, which the server fetches, rather than downloading them.",
  "Big bytes never ride a tool call: uploads go to URLs on this server (generate_upload for a model input), and fork returns a URL to download source from.",
  "The skills are also `skill://` resources (the io.modelcontextprotocol/skills extension: skills/list, skills/get), supporting files included.",
  API_KEY_HINT,
].join(" ");

/** Builds a fresh server per request: the handler is stateless, so nothing outlives a call. */
export const createVibedgamesMcpHandler = (context: McpContext) =>
  createMcpHandler(async () => {
    const server = new McpServer({ name: "vibedgames", version: "1.0.0" }, { instructions });
    await registrar.register(server, { context });
    registerSkills(server, context.skills);
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
  skills: readonly Skill[],
): Promise<Response> => {
  // Stateless: no server-to-client stream to open with GET and no session to
  // end with DELETE, so POST is the only method (Streamable HTTP lets a
  // server answer the others 405).
  if (request.method !== "POST") {
    return new Response(null, { headers: { allow: "POST" }, status: 405 });
  }
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
  const context = await createContext(headers);
  if (!context.session) {
    return unauthorized(request);
  }
  const lacking = context.oauthScopes ? missingScope(body, context.oauthScopes) : null;
  if (lacking && context.oauthScopes) {
    // The scopes it holds plus the one it lacks, so re-consenting keeps both.
    const scopes = [...new Set([...context.oauthScopes, lacking])];
    return challengeResponse(
      request,
      createInsufficientScopeError(scopes, `this app was not granted the ${lacking} scope`),
    );
  }
  const handler = createVibedgamesMcpHandler({ ...context, skills });
  return handler.fetch(new Request(request.url, { body, headers, method: request.method }));
};
