import type { ORPCContext } from "@repo/service/orpc";
import { MAX_RPC_BODY_BYTES } from "@repo/service/generate/limits";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { SmartCoercionHandlerPlugin } from "@orpc/json-schema";
import { McpRegistrar } from "@orpc/mcp";
import { onError, ORPCError } from "@orpc/server";
import { ZodToJsonSchemaConverter } from "@orpc/zod";

import { jsonError } from "@/lib/json-error";
import { registerSkills } from "@/lib/mcp-skills";
import type { McpContext, Skill } from "@/lib/mcp-tools";
import { tools } from "@/lib/mcp-tools";
import { isCrossOrigin, reportFaults } from "@/lib/orpc-handler";

/**
 * `/mcp`: the tools in `mcp-tools.ts` over stateless Streamable HTTP,
 * authenticated by the same `vg_…` API key the CLI uses. A tool call runs
 * through the same handler stack as `/api/orpc`, so its middleware,
 * validation and credit gate are the API's. The MCP meta lives in `apps/web`,
 * not `@repo/contract`, which the CLI bundles and `@orpc/mcp` would drag the
 * MCP SDK into.
 */

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
  const handler = createVibedgamesMcpHandler({ ...(await createContext(headers)), skills });
  return handler.fetch(new Request(request.url, { body, headers, method: request.method }));
};
