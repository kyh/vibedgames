import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, test } from "node:test";
import type { JsonValue } from "@repo/contract/json";
import { getRequiredScope } from "@repo/contract/base";
import type { ORPCContext } from "@repo/service/orpc";
import { createAuth } from "@repo/service/auth/auth";
import { createDb } from "@repo/db/drizzle-client";
import { MAX_RPC_BODY_BYTES } from "@repo/service/generate/limits";
import { z } from "zod";

import { handleMcpRequest } from "./mcp";
import type { Skill } from "./mcp-tools";
import { MEDIA_MODELS, tools as mcpTools } from "./mcp-tools";

/**
 * Drives the real `/mcp` handler over Streamable HTTP. The context is built by
 * hand, as in `orpc-handler.test.ts`: nothing here reaches the database, since
 * an anonymous tool call that needs an account stops at the 401 challenge,
 * and `auth.me` answers from the session alone.
 */

const unavailable = (): never => {
  throw new Error("the database is not reachable in this test");
};

const db = createDb({
  batch: unavailable,
  dump: unavailable,
  exec: unavailable,
  prepare: unavailable,
  withSession: unavailable,
});

const auth = createAuth({ baseURL: "http://localhost:3000", db, secret: "test-secret" });

type Session = NonNullable<ORPCContext["session"]>;

const now = new Date(0);

// An API key's session, as `resolveApiKeySession` synthesizes it.
const signedIn: Session = {
  session: {
    createdAt: now,
    expiresAt: now,
    id: "session-1",
    ipAddress: null,
    token: "apikey:key-1",
    updatedAt: now,
    userAgent: null,
    userId: "user_1",
  },
  user: {
    banned: false,
    createdAt: now,
    email: "dev@vibedgames.local",
    emailVerified: true,
    id: "user_1",
    name: "Dev",
    role: "user",
    updatedAt: now,
  },
};

const contextWith =
  (session: Session | null, seen: Headers[] = [], oauthScopes: readonly string[] | null = null) =>
  (headers: Headers): Promise<ORPCContext> => {
    seen.push(headers);
    return Promise.resolve({
      auth,
      billing: undefined,
      db,
      decision: undefined,
      headers,
      media: undefined,
      oauthScopes,
      productionURL: undefined,
      r2: undefined,
      session,
      signing: undefined,
    });
  };

const skills: Skill[] = [
  {
    content: "---\nname: phaser\n---\nBuild 2D games.",
    description: "2D games",
    files: [{ content: "# Scenes", path: "references/scenes.md" }],
    frontmatter: { description: "2D games", metadata: { version: "1" }, name: "phaser" },
    name: "phaser",
  },
  {
    content: "---\nname: deploy\n---\nShip it.",
    description: "Ship a game",
    files: [],
    frontmatter: { description: "Ship a game", name: "deploy" },
    name: "deploy",
  },
];

// A connected app's session, as `resolveOAuthSession` synthesizes it.
const oauthSession: Session = {
  ...signedIn,
  session: { ...signedIn.session, token: "oauth:token-1" },
};

let nextId = 1;

interface RpcOptions {
  headers?: Record<string, string>;
  oauthScopes?: readonly string[] | null;
  session?: Session | null;
  seen?: Headers[];
}

const rpc = async (
  method: string,
  params: { [key: string]: JsonValue },
  { headers = {}, oauthScopes = null, session = signedIn, seen = [] }: RpcOptions = {},
) => {
  const request = new Request("https://vibedgames.com/mcp", {
    body: JSON.stringify({ id: (nextId += 1), jsonrpc: "2.0", method, params }),
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      "mcp-protocol-version": "2025-06-18",
      ...headers,
    },
    method: "POST",
  });
  const response = await handleMcpRequest(request, contextWith(session, seen, oauthScopes), skills);
  const text = await response.text();
  const json = text.startsWith("{")
    ? text
    : text
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice("data:".length))
        .join("");
  return { body: json ? z.looseObject({}).parse(JSON.parse(json)) : {}, response };
};

const toolSchema = z.looseObject({
  annotations: z.looseObject({}).optional(),
  description: z.string().optional(),
  name: z.string(),
  title: z.string().optional(),
});

const listTools = async () => {
  const { body } = await rpc("tools/list", {});
  return z.object({ result: z.object({ tools: z.array(toolSchema) }) }).parse(body).result.tools;
};

const callResult = z.object({
  result: z.looseObject({
    content: z.array(z.looseObject({ text: z.string().optional() })),
    isError: z.boolean().optional(),
    structuredContent: z.unknown().optional(),
  }),
});

describe("mcp endpoint", () => {
  test("initializes as vibedgames with instructions", async () => {
    const { body, response } = await rpc("initialize", {
      capabilities: {},
      clientInfo: { name: "test", version: "1.0.0" },
      protocolVersion: "2025-06-18",
    });
    assert.strictEqual(response.status, 200);
    const { result } = z
      .object({
        result: z.looseObject({
          instructions: z.string(),
          serverInfo: z.looseObject({ name: z.string() }),
        }),
      })
      .parse(body);
    assert.strictEqual(result.serverInfo.name, "vibedgames");
    assert.match(result.instructions, /Authorization: Bearer vg_/u);
  });

  test("names each tool for its vg command, spaces as underscores", async () => {
    const tools = await listTools();
    const names = tools.map((tool) => tool.name).toSorted();
    assert.deepStrictEqual(
      names,
      [
        // `vg <command>`, spaces as `_`; `generate` is `vg generate run`
        "credits",
        "credits_buy",
        "credits_redeem",
        "deploy",
        "deployments",
        "deployments_delete",
        "fork",
        "generate_docs",
        "generate_models",
        "generate_pricing",
        "generate",
        "generate_schema",
        "generate_status",
        "generate_upload",
        "skills",
        "whoami",
        // no command of their own
        "generate_3d",
        "generate_image",
        "generate_music",
        "generate_sound",
        "generate_speech",
        "generate_video",
        "remove_background",
      ].toSorted(),
    );
  });

  test("marks reads read-only and the delete destructive", async () => {
    const tools = await listTools();
    const byName = new Map(tools.map((tool) => [tool.name, tool]));
    for (const name of ["whoami", "credits", "deployments", "fork", "skills", "generate_models"]) {
      assert.strictEqual(byName.get(name)?.annotations?.readOnlyHint, true, name);
    }
    assert.strictEqual(byName.get("deployments_delete")?.annotations?.destructiveHint, true);
    for (const name of ["generate", "generate_image", "deploy", "credits_redeem"]) {
      assert.strictEqual(byName.get(name)?.annotations?.readOnlyHint, false, name);
    }
  });

  test("lists the skills, and serves one by name", async () => {
    const all = await rpc("tools/call", { arguments: {}, name: "skills" });
    const listed = callResult.parse(all.body);
    assert.deepStrictEqual(listed.result.structuredContent, {
      skills: [
        { description: "2D games", name: "phaser" },
        { description: "Ship a game", name: "deploy" },
      ],
    });
    const named = await rpc("tools/call", { arguments: { name: "deploy" }, name: "skills" });
    const one = callResult.parse(named.body);
    assert.deepStrictEqual(one.result.structuredContent, {
      content: "---\nname: deploy\n---\nShip it.",
      description: "Ship a game",
      name: "deploy",
    });
    const unknown = await rpc("tools/call", { arguments: { name: "nope" }, name: "skills" });
    const missing = callResult.parse(unknown.body);
    assert.strictEqual(missing.result.isError, true);
    assert.match(missing.result.content[0]?.text ?? "", /NOT_FOUND/u);
  });

  test("declares the skills extension", async () => {
    const { body } = await rpc("initialize", {
      capabilities: {},
      clientInfo: { name: "test", version: "1.0.0" },
      protocolVersion: "2025-06-18",
    });
    const { result } = z
      .object({ result: z.object({ capabilities: z.looseObject({}) }).loose() })
      .parse(body);
    assert.deepStrictEqual(result.capabilities.extensions, {
      "io.modelcontextprotocol/skills": {},
    });
    assert.ok(result.capabilities.resources);
  });

  test("lists every skill with each of its files' digest and size", async () => {
    const { body } = await rpc("skills/list", {});
    const { result } = z
      .object({ result: z.object({ skills: z.array(z.looseObject({})) }).loose() })
      .parse(body);
    const [phaser] = result.skills;
    assert.strictEqual(phaser?.uri, "skill://phaser/SKILL.md");
    assert.deepStrictEqual(phaser?.frontmatter, skills[0]?.frontmatter);
    const files = z
      .array(z.object({ digest: z.string(), size: z.number(), uri: z.string() }))
      .parse(phaser?.resources);
    assert.deepStrictEqual(
      files.map((file) => file.uri),
      ["skill://phaser/SKILL.md", "skill://phaser/references/scenes.md"],
    );
    assert.strictEqual(files[1]?.size, "# Scenes".length);
    assert.match(files[1]?.digest ?? "", /^sha256:[0-9a-f]{64}$/u);
  });

  test("gets one skill by its SKILL.md URI, and refuses another", async () => {
    const { body } = await rpc("skills/get", { uri: "skill://deploy/SKILL.md" });
    const { result } = z
      .object({ result: z.object({ skill: z.looseObject({}) }).loose() })
      .parse(body);
    assert.strictEqual(result.skill.uri, "skill://deploy/SKILL.md");
    const missing = await rpc("skills/get", { uri: "skill://nope/SKILL.md" });
    const { error } = z
      .object({ error: z.object({ code: z.number() }).loose() })
      .parse(missing.body);
    assert.strictEqual(error.code, -32_602);
  });

  test("serves each skill file as a resource", async () => {
    const listed = await rpc("resources/list", {});
    const { result } = z
      .object({ result: z.object({ resources: z.array(z.looseObject({ uri: z.string() })) }) })
      .parse(listed.body);
    assert.deepStrictEqual(
      result.resources.map((resource) => resource.uri),
      ["skill://phaser/SKILL.md", "skill://phaser/references/scenes.md", "skill://deploy/SKILL.md"],
    );
    const read = await rpc("resources/read", { uri: "skill://phaser/references/scenes.md" });
    const { contents } = z
      .object({ result: z.object({ contents: z.array(z.looseObject({})) }) })
      .parse(read.body).result;
    assert.deepStrictEqual(contents, [
      { mimeType: "text/markdown", text: "# Scenes", uri: "skill://phaser/references/scenes.md" },
    ]);
  });

  test("asks generate_3d for a prompt or an image", async () => {
    const { body } = await rpc("tools/call", { arguments: {}, name: "generate_3d" });
    const { result } = callResult.parse(body);
    assert.strictEqual(result.isError, true);
    assert.match(result.content[0]?.text ?? "", /prompt or an image_url/u);
  });

  // The media tools run exactly the defaults the model-catalog skill names,
  // so an agent reading the skill and one calling the tool get the same model.
  test("runs the defaults the model-catalog skill names", async () => {
    const skill = await readFile(
      new URL("../../../../plugins/vibedgames/skills/model-catalog/SKILL.md", import.meta.url),
      "utf-8",
    );
    const table = skill.split("## Defaults")[1]?.split("\n## ")[0] ?? "";
    const named = [...table.matchAll(/^\|[^|]+\|\s*`(?<id>[^`]+)`\s*\|$/gmu)].map(
      (match) => match.groups?.id,
    );
    assert.deepStrictEqual(named.toSorted(), Object.values(MEDIA_MODELS).flat().toSorted());
  });

  // CLAUDE.md: end-user-facing surfaces keep the provider's brand out of
  // prose. Endpoint ids pass through verbatim (`fal-ai/flux/dev`), so a
  // match followed by `-` is an id, not the brand.
  test("never names the media provider in what an agent reads", async () => {
    const { body } = await rpc("initialize", {
      capabilities: {},
      clientInfo: { name: "test", version: "1.0.0" },
      protocolVersion: "2025-06-18",
    });
    const text = JSON.stringify([body, await listTools()]);
    assert.doesNotMatch(text, /\bfal\b(?!-)/iu);
  });

  // Auth is optional until a tool needs it: an anonymous client can connect,
  // see the tools and read the skills.
  test("lets an anonymous client initialize, list tools and read skills", async () => {
    const init = await rpc(
      "initialize",
      {
        capabilities: {},
        clientInfo: { name: "test", version: "1.0.0" },
        protocolVersion: "2025-06-18",
      },
      { session: null },
    );
    assert.strictEqual(init.response.status, 200);
    const list = await rpc("tools/list", {}, { session: null });
    assert.strictEqual(list.response.status, 200);
    const call = await rpc("tools/call", { arguments: {}, name: "skills" }, { session: null });
    assert.strictEqual(call.response.status, 200);
    const { result } = callResult.parse(call.body);
    assert.notStrictEqual(result.isError, true);
    assert.match(JSON.stringify(result), /phaser/u);
  });

  // OpenAI's Apps SDK reads each tool's auth policy from `securitySchemes`.
  test("declares which tools need OAuth and which run anonymously", async () => {
    const tools = z
      .array(
        z.looseObject({ _meta: z.looseObject({ securitySchemes: z.unknown() }), name: z.string() }),
      )
      .parse(await listTools());
    const schemes = new Map(tools.map((tool) => [tool.name, tool._meta.securitySchemes]));
    assert.deepStrictEqual(schemes.get("skills"), [{ type: "noauth" }]);
    assert.deepStrictEqual(schemes.get("deployments"), [
      { scopes: ["games:read"], type: "oauth2" },
    ]);
  });

  // MCP authorization: a client with no credential learns from the 401 where
  // to get one (RFC 9728), which is how a connector starts the OAuth flow.
  test("answers an anonymous call to a tool that needs an account with the protected-resource challenge", async () => {
    const { body, response } = await rpc(
      "tools/call",
      { arguments: {}, name: "deployments" },
      { session: null },
    );
    assert.strictEqual(response.status, 401);
    const challenge = response.headers.get("www-authenticate") ?? "";
    assert.match(
      challenge,
      /^Bearer resource_metadata="https:\/\/vibedgames\.com\/\.well-known\/oauth-protected-resource\/mcp"/u,
    );
    // The scopes a connector should ask for, so its first consent covers the tools.
    assert.match(challenge, /scope="[^"]*\bgames:write\b[^"]*"/u);
    assert.match(JSON.stringify(body), /OAuth/u);
  });

  // An expired or refused token should be refreshed, not re-consented.
  test("marks a refused credential as an invalid token", async () => {
    const { response } = await rpc(
      "tools/call",
      { arguments: {}, name: "deployments" },
      { headers: { authorization: "Bearer not-a-token" }, session: null },
    );
    assert.strictEqual(response.status, 401);
    const challenge = response.headers.get("www-authenticate") ?? "";
    assert.match(challenge, /resource_metadata="[^"]+"/u);
    assert.match(challenge, /error="invalid_token"/u);
  });

  test("challenges a batch that calls a tool needing an account", async () => {
    const request = new Request("https://vibedgames.com/mcp", {
      body: JSON.stringify([
        { id: 1, jsonrpc: "2.0", method: "tools/list", params: {} },
        { id: 2, jsonrpc: "2.0", method: "tools/call", params: { arguments: {}, name: "deploy" } },
      ]),
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        "mcp-protocol-version": "2025-06-18",
      },
      method: "POST",
    });
    const response = await handleMcpRequest(request, contextWith(null), skills);
    assert.strictEqual(response.status, 401);
  });

  test("sends no error to a request without a credential", async () => {
    const { response } = await rpc(
      "tools/call",
      { arguments: {}, name: "deployments" },
      { session: null },
    );
    assert.doesNotMatch(response.headers.get("www-authenticate") ?? "", /error=/u);
  });

  // RFC 6750 §3.1 step-up: a token without the tool's scope hears which one to
  // ask for, at HTTP level, before anything runs.
  test("answers a tool outside the token's scopes with an insufficient_scope challenge", async () => {
    const { response } = await rpc(
      "tools/call",
      { arguments: {}, name: "deployments_delete" },
      { oauthScopes: ["profile", "games:read"], session: oauthSession },
    );
    assert.strictEqual(response.status, 403);
    const challenge = response.headers.get("www-authenticate") ?? "";
    assert.match(challenge, /error="insufficient_scope"/u);
    assert.match(challenge, /scope="profile games:read games:write"/u);
  });

  // `skills` reads only the bundled skills; every other tool reaches the API
  // and so needs a scope for the step-up check above to cover it.
  test("names a scope for every tool that reaches the API", () => {
    const unscoped = Object.entries(mcpTools)
      .filter(([, tool]) => getRequiredScope(tool) === undefined)
      .map(([name]) => name);
    assert.deepStrictEqual(unscoped, ["skills"]);
  });

  test("runs a tool inside the token's scopes", async () => {
    const { body, response } = await rpc(
      "tools/call",
      { arguments: {}, name: "whoami" },
      { oauthScopes: ["profile"], session: oauthSession },
    );
    assert.strictEqual(response.status, 200);
    assert.notStrictEqual(callResult.parse(body).result.isError, true);
  });

  test("runs a signed-in call through the procedure", async () => {
    const { body } = await rpc("tools/call", { arguments: {}, name: "whoami" });
    const { result } = callResult.parse(body);
    assert.notStrictEqual(result.isError, true);
    assert.deepStrictEqual(result.structuredContent, {
      email: "dev@vibedgames.local",
      id: "user_1",
      name: "Dev",
      role: "user",
    });
  });

  // A game page is same-site with the app, so SameSite=Lax would attach the
  // session cookie to its POST; only a bearer credential may sign a tool call.
  test("builds the context without the cookie", async () => {
    const seen: Headers[] = [];
    await rpc(
      "tools/list",
      {},
      {
        headers: { authorization: "Bearer vg_test", cookie: "better-auth.session_token=abc" },
        seen,
      },
    );
    assert.strictEqual(seen[0]?.get("cookie"), null);
    assert.strictEqual(seen[0]?.get("authorization"), "Bearer vg_test");
  });

  test("answers every method but POST with 405", async () => {
    for (const method of ["GET", "DELETE"]) {
      const response = await handleMcpRequest(
        new Request("https://vibedgames.com/mcp", { method }),
        contextWith(signedIn),
        skills,
      );
      assert.strictEqual(response.status, 405, method);
      assert.strictEqual(response.headers.get("allow"), "POST");
    }
  });

  test("refuses a request from another origin, even a same-site one", async () => {
    const { response } = await rpc(
      "tools/list",
      {},
      {
        headers: { origin: "https://evil.vibedgames.com" },
      },
    );
    assert.strictEqual(response.status, 403);
  });

  // A chunked body carries no Content-Length, so only counting the stream catches it.
  test("refuses an oversized body that declares no length, without reading all of it", async () => {
    let pulled = 0;
    const chunk = new Uint8Array(1024 * 1024);
    const body = new ReadableStream<Uint8Array>({
      pull: (controller) => {
        pulled += 1;
        controller.enqueue(chunk);
      },
    });
    const request = new Request("https://vibedgames.com/mcp", {
      body,
      // @ts-expect-error -- undici needs `duplex` for a stream body; the DOM types lack it
      duplex: "half",
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    const response = await handleMcpRequest(request, contextWith(null), skills);
    assert.strictEqual(response.status, 413);
    assert.ok(pulled <= MAX_RPC_BODY_BYTES / chunk.byteLength + 2, `pulled ${pulled} MiB`);
  });

  test("refuses a body over the RPC cap before parsing it", async () => {
    const request = new Request("https://vibedgames.com/mcp", {
      body: "x".repeat(MAX_RPC_BODY_BYTES + 1),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    const response = await handleMcpRequest(request, contextWith(null), skills);
    assert.strictEqual(response.status, 413);
  });
});
