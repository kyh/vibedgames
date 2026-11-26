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
import { asTaskResult, registerTasks, TASK_METHODS, TASKS_EXTENSION } from "@/lib/mcp-tasks";
import type { McpContext, Skill } from "@/lib/mcp-tools";
import { TASK_TOOLS, tools } from "@/lib/mcp-tools";
import { isCrossOrigin, reportFaults } from "@/lib/orpc-handler";

const converters = [new ZodToJsonSchemaConverter()];

const API_KEY_HINT =
  "Connect with OAuth, or send an API key as `Authorization: Bearer vg_…`; create one at vibedgames.com/settings.";

const CHALLENGE_SCOPES = ["profile", "offline_access", ...Object.keys(OAUTH_SCOPES)];

const challengeResponse = (
  request: Request,
  error: Parameters<typeof createResourceServerChallenge>[0],
) => {
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

const unauthorized = (request: Request) => {
  const response = challengeResponse(
    request,
    new APIError("UNAUTHORIZED", { message: API_KEY_HINT }),
  );

  const challenge = response.headers.get("www-authenticate");

  if (challenge !== null && challenge !== "" && request.headers.has("authorization")) {
    response.headers.set("www-authenticate", `${challenge}, error="invalid_token"`);
  }

  return response;
};

const rpcRequest = z.looseObject({
  method: z.string(),
  params: z
    .looseObject({
      _meta: z
        .looseObject({
          "io.modelcontextprotocol/clientCapabilities": z.looseObject({
            extensions: z.record(z.string(), z.unknown()).optional(),
          }),
        })
        .optional()
        .catch(undefined),
      name: z.string().optional().catch(undefined),
    })
    .optional()
    .catch(undefined),
});

type RpcRequest = z.infer<typeof rpcRequest>;

const toolScopes = new Map(
  Object.entries(tools).map(([name, tool]) => [name, getRequiredScope(tool)]),
);

const readJson = (body: Uint8Array) => {
  try {
    return z.json().parse(JSON.parse(new TextDecoder().decode(body)));
  } catch {
    return null;
  }
};

const parseMessages = (body: Uint8Array | undefined) => {
  const parsed = body ? readJson(body) : null;

  return (Array.isArray(parsed) ? parsed : [parsed]).flatMap((message) => {
    const request = rpcRequest.safeParse(message);

    return request.success ? [request.data] : [];
  });
};

const scopedName = ({ method, params }: RpcRequest) => {
  if (TASK_METHODS.has(method)) {
    return "generate";
  }

  return method === "tools/call" ? params?.name : undefined;
};

const requiredScopes = (messages: readonly RpcRequest[]) =>
  messages.flatMap((message) => {
    const name = scopedName(message);
    const scope = name === undefined ? undefined : toolScopes.get(name);

    return scope ? [scope] : [];
  });

const isTaskCall = (messages: readonly RpcRequest[]) => {
  const [message, ...rest] = messages;

  const name = message?.method === "tools/call" ? message.params?.name : undefined;

  const extensions =
    message?.params?._meta?.["io.modelcontextprotocol/clientCapabilities"].extensions;

  return (
    rest.length === 0 &&
    name !== undefined &&
    TASK_TOOLS.has(name) &&
    extensions?.[TASKS_EXTENSION] !== undefined
  );
};

const missingScope = (required: readonly string[], granted: readonly string[]) =>
  required.find((scope) => !granted.includes(scope)) ?? null;

const securitySchemes = (name: string) => {
  const scope = toolScopes.get(name);

  return scope ? [{ scopes: [scope], type: "oauth2" }] : [{ type: "noauth" }];
};

const registrar = new McpRegistrar(tools, {
  clientInterceptors: [onError(reportFaults)],
  converters,
  plugins: [new SmartCoercionHandlerPlugin({ converters })],
});

const serverInfo = {
  icons: [
    {
      mimeType: "image/svg+xml",
      sizes: ["any"],
      src: "https://vibedgames.com/favicon/favicon.svg",
    },
    {
      mimeType: "image/png",
      sizes: ["96x96"],
      src: "https://vibedgames.com/favicon/favicon-96x96.png",
    },
    {
      mimeType: "image/png",
      sizes: ["192x192"],
      src: "https://vibedgames.com/favicon/web-app-manifest-192x192.png",
    },
    {
      mimeType: "image/png",
      sizes: ["512x512"],
      src: "https://vibedgames.com/favicon/web-app-manifest-512x512.png",
    },
  ],
  name: "vibedgames",
  title: "vibedgames",
  version: "1.0.0",
  websiteUrl: "https://vibedgames.com",
};

const instructions = [
  "vibedgames hosts browser games at {slug}.vibedgames.com and gives coding agents the abilities of a game studio.",
  "Start with `skills` for how to build, art-direct and ship a game; `generate_image`, `generate_video`, `generate_speech`, `generate_music`, `generate_sound`, `generate_3d`, `generate_animate_3d` and `generate_remove_background` make its assets on default models, `generate` runs any other model; `deploy` puts it live.",
  "If you have a shell, the `vg` CLI does all of this in one step per job: `npx vibedgames deploy ./dist` with `VG_TOKEN` set to the same API key. Each tool here is named for its `vg` command, spaces as `_` (`vg generate run` is `generate`).",
  "To deploy with the tool: call `deploy` with `bundle: true`, PUT the built game as one gzipped tar (`tar -czf game.tgz -C dist .`, index.html at its root) to `bundleUpload` (`curl -T game.tgz -H 'Content-Type: application/gzip' \"$url\"`), then call `deploy` with the `deploymentId` and `publish: true`. With no shell, send text files in `files` and generated assets as `encoding: url`, which the server fetches, rather than downloading them.",
  "Big bytes never ride a tool call: uploads go to URLs on this server (generate_upload for a model input), and fork returns a URL to download source from.",
  'A client with the io.modelcontextprotocol/tasks extension gets a generation back as a task as soon as it is queued, to follow with tasks/get. A task\'s `taskId` is only for tasks/get and tasks/cancel; its `_meta["com.vibedgames/generation"]` names the `endpoint_id` and `request_id` that generate_status and `vg generate status <endpoint_id> <request_id>` take.',
  "The skills are also `skill://` resources (the io.modelcontextprotocol/skills extension: skills/list, skills/get), supporting files included.",
  API_KEY_HINT,
].join(" ");

/** Builds a fresh server per request: the handler is stateless, so nothing outlives a call. */
export const createVibedgamesMcpHandler = (context: McpContext) =>
  createMcpHandler(async () => {
    const server = new McpServer(serverInfo, { instructions });
    const { tools: registered } = await registrar.register(server, { context });

    for (const [name, tool] of Object.entries(registered)) {
      tool.update({ _meta: { ...tool._meta, securitySchemes: securitySchemes(name) } });
    }

    registerSkills(server, context.skills);
    registerTasks(server, context);

    return server;
  });

/**
 * Credentials are bearer-only: the cookie is dropped before the context is
 * built, so a page on a same-site game subdomain cannot ride a signed-in
 * user's session into a tool call. The `Origin` check is MCP's own
 * DNS-rebinding guard and matches `/api/orpc`'s.
 */
export const withoutCookies = (headers: Headers) => {
  const bearerOnly = new Headers(headers);
  bearerOnly.delete("cookie");

  return bearerOnly;
};

const readCapped = async (stream: ReadableStream<unknown>, limit: number) => {
  const chunks: Uint8Array[] = [];
  let size = 0;

  for await (const value of stream) {
    if (!(value instanceof Uint8Array)) {
      return null;
    }

    size += value.byteLength;

    if (size > limit) {
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
) => {
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

  // WARNING: drop the cookie: a game page is same-site, so a session cookie must never sign a tool call.
  const headers = withoutCookies(request.headers);
  const context = await createContext(headers);
  const messages = parseMessages(body);
  const required = requiredScopes(messages);

  if (!context.session && (headers.has("authorization") || required.length > 0)) {
    return unauthorized(request);
  }

  const lacking = context.oauthScopes ? missingScope(required, context.oauthScopes) : null;

  if (lacking !== null && lacking !== "" && context.oauthScopes) {
    const scopes = [...new Set([...context.oauthScopes, lacking])];

    return challengeResponse(
      request,
      createInsufficientScopeError(scopes, `this app was not granted the ${lacking} scope`),
    );
  }

  const secret = context.signing?.secret;
  const userId = context.session?.user.id;
  const taskMode = secret !== undefined && userId !== undefined && isTaskCall(messages);
  const handler = createVibedgamesMcpHandler({ ...context, skills, taskMode });

  const response = await handler.fetch(
    new Request(request.url, { body, headers, method: request.method }),
  );

  return taskMode ? await asTaskResult(response, { secret, userId }) : response;
};
