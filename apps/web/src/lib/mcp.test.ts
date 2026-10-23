import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { JsonValue } from "@repo/contract/json";
import type { ORPCContext } from "@repo/service/orpc";
import { createAuth } from "@repo/service/auth/auth";
import { createDb } from "@repo/db/drizzle-client";
import { MAX_RPC_BODY_BYTES } from "@repo/service/generate/limits";
import { z } from "zod";

import { handleMcpRequest } from "./mcp";

/**
 * Drives the real `/mcp` handler over Streamable HTTP. The context is built by
 * hand, as in `orpc-handler.test.ts`: nothing here reaches the database, since
 * the anonymous call stops at `requireSession` and `auth.me` answers from the
 * session alone.
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
  (session: Session | null, seen: Headers[] = []) =>
  (headers: Headers): Promise<ORPCContext> => {
    seen.push(headers);
    return Promise.resolve({
      auth,
      billing: undefined,
      db,
      decision: undefined,
      headers,
      media: undefined,
      productionURL: undefined,
      r2: undefined,
      session,
    });
  };

const skills = [
  { content: "---\nname: phaser\n---\nBuild 2D games.", description: "2D games", name: "phaser" },
  { content: "---\nname: deploy\n---\nShip it.", description: "Ship a game", name: "deploy" },
];

let nextId = 1;

interface RpcOptions {
  headers?: Record<string, string>;
  session?: Session | null;
  seen?: Headers[];
}

const rpc = async (
  method: string,
  params: { [key: string]: JsonValue },
  { headers = {}, session = null, seen = [] }: RpcOptions = {},
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
  const response = await handleMcpRequest(request, contextWith(session, seen), skills);
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

  test("lists one tool per vg command that reaches the server", async () => {
    const tools = await listTools();
    const names = tools.map((tool) => tool.name).toSorted();
    assert.deepStrictEqual(names, [
      "credits",
      "credits_buy",
      "credits_redeem",
      "deployments",
      "deployments_delete",
      "deployments_upload",
      "fork",
      "generate",
      "generate_docs",
      "generate_models",
      "generate_pricing",
      "generate_schema",
      "generate_status",
      "generate_upload",
      "me",
      "skills",
    ]);
  });

  test("marks reads read-only and the delete destructive", async () => {
    const tools = await listTools();
    const byName = new Map(tools.map((tool) => [tool.name, tool]));
    for (const name of ["me", "credits", "deployments", "fork", "skills", "generate_models"]) {
      assert.strictEqual(byName.get(name)?.annotations?.readOnlyHint, true, name);
    }
    assert.strictEqual(byName.get("deployments_delete")?.annotations?.destructiveHint, true);
    for (const name of ["generate", "deployments_upload", "credits_redeem"]) {
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
    assert.deepStrictEqual(one.result.structuredContent, skills[1]);
    const unknown = await rpc("tools/call", { arguments: { name: "nope" }, name: "skills" });
    const missing = callResult.parse(unknown.body);
    assert.strictEqual(missing.result.isError, true);
    assert.match(missing.result.content[0]?.text ?? "", /NOT_FOUND/u);
  });

  // The generate family reaches the API through `call()`, so it must still
  // meet the procedure's own session check rather than skip it.
  test("refuses an anonymous generate before anything is submitted", async () => {
    const { body } = await rpc("tools/call", {
      arguments: { endpoint_id: "fal-ai/flux/dev", input: { prompt: "a cat" } },
      name: "generate",
    });
    const { result } = callResult.parse(body);
    assert.strictEqual(result.isError, true);
    assert.match(result.content[0]?.text ?? "", /UNAUTHORIZED/u);
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

  test("refuses an anonymous tool call as a tool error the model can read", async () => {
    const { body } = await rpc("tools/call", { arguments: {}, name: "deployments" });
    const { result } = callResult.parse(body);
    assert.strictEqual(result.isError, true);
    const text = result.content[0]?.text ?? "";
    assert.match(text, /UNAUTHORIZED/u);
    assert.match(text, /Authorization: Bearer vg_/u);
  });

  test("runs a signed-in call through the procedure", async () => {
    const { body } = await rpc("tools/call", { arguments: {}, name: "me" }, { session: signedIn });
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
