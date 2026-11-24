import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { ContractClient } from "@repo/contract";
import type { ORPCContext } from "@repo/service/orpc";
import { CLI_VERSION_HEADER } from "@repo/contract/cli";
import { createAuth } from "@repo/service/identity/auth";
import { createDb } from "@repo/db/drizzle-client";
import { MAX_RPC_BODY_BYTES } from "@repo/service/generate/limits";
import { createORPCClient, ORPCError, safe } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import { z } from "zod";
import { BatchLinkPlugin } from "@orpc/client/plugins";

import { apiNotFound } from "./json-error";
import { handleRestRequest, handleRpcRequest } from "./orpc-handler";

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

const auth = createAuth({
  baseURL: "http://localhost:3000",
  db,
  secret: "test-secret",
});

const contextFor: (request: Request) => ORPCContext = (request) => ({
  auth,
  billing: undefined,
  db,
  decision: undefined,
  headers: request.headers,
  media: undefined,
  oauthScopes: null,
  productionURL: undefined,
  r2: undefined,
  session: null,
  signing: undefined,
});

const assertJsonError = async (response: Response, status: number, code: string) => {
  assert.strictEqual(response.status, status);
  assert.match(response.headers.get("content-type") ?? "", /^application\/json/u);
  const body = z.object({ code: z.string() }).parse(await response.json());
  assert.strictEqual(body.code, code);
};

const post = (body = JSON.stringify({ json: {} }), headers: Record<string, string> = {}) => {
  const request = new Request("http://localhost:3000/api/orpc/auth/me", {
    body,
    headers: { "content-type": "application/json", ...headers },
    method: "POST",
  });

  return handleRpcRequest(request, contextFor(request));
};

const rpcError = z.object({ json: z.looseObject({ code: z.string() }) });

const BETA_31_ERROR_KEYS = new Set(["code", "data", "defined", "inferable", "message"]);

describe("rpc endpoint", () => {
  test("runs a POST through to the procedure's session check", async () => {
    const response = await post();
    assert.strictEqual(response.status, 401);
    assert.match(await response.text(), /UNAUTHORIZED/u);
  });

  test("refuses GET, so a cross-site navigation cannot invoke a procedure", async () => {
    const request = new Request("http://localhost:3000/api/orpc/auth/me", { method: "GET" });
    const response = await handleRpcRequest(request, contextFor(request));
    await assertJsonError(response, 404, "NOT_FOUND");
  });

  test("refuses a POST whose Origin is another origin, even a same-site one", async () => {
    const request = new Request("https://vibedgames.com/api/orpc/auth/me", {
      body: JSON.stringify({ json: {} }),
      headers: { "content-type": "application/json", origin: "https://evil.vibedgames.com" },
      method: "POST",
    });

    const response = await handleRpcRequest(request, contextFor(request));
    await assertJsonError(response, 403, "FORBIDDEN");
  });

  test("allows a POST whose Origin is the app itself", async () => {
    const request = new Request("https://vibedgames.com/api/orpc/auth/me", {
      body: JSON.stringify({ json: {} }),
      headers: { "content-type": "application/json", origin: "https://vibedgames.com" },
      method: "POST",
    });

    const response = await handleRpcRequest(request, contextFor(request));
    assert.strictEqual(response.status, 401);
  });

  test("allows a POST with no Origin at all, so the CLI still reaches it", async () => {
    const response = await post();
    assert.strictEqual(response.status, 401);
  });

  test("keeps `inferable` in the errors of a vg that sends no version header", async () => {
    const response = await post(undefined, { "user-agent": "node" });
    assert.strictEqual(response.status, 401);
    const { json } = rpcError.parse(await response.json());
    assert.strictEqual(json.code, "UNAUTHORIZED");
    assert.strictEqual(json.inferable, false);
    assert.ok(Object.keys(json).every((key) => BETA_31_ERROR_KEYS.has(key)));
  });

  test("answers a vg that sends its version in the current error shape", async () => {
    const response = await post(undefined, {
      [CLI_VERSION_HEADER]: "0.7.0",
      "user-agent": "node",
    });

    const { json } = rpcError.parse(await response.json());
    assert.strictEqual(json.code, "UNAUTHORIZED");
    assert.ok(!("inferable" in json));
  });

  test("rejects a body over the cap before parsing it", async () => {
    const body = JSON.stringify({ json: { padding: "x".repeat(MAX_RPC_BODY_BYTES) } });
    const response = await post(body);
    assert.strictEqual(response.status, 413);
    assert.match(await response.text(), /PAYLOAD_TOO_LARGE/u);
  });

  test("serves no CORS headers, so a credentialed cross-origin fetch cannot read it", async () => {
    const response = await post();
    assert.strictEqual(response.headers.get("access-control-allow-origin"), null);
  });

  test("answers a batch in one round trip, one result per item", async () => {
    let roundTrips = 0;

    const client: ContractClient = createORPCClient(
      new RPCLink({
        fetch: (url, init) => {
          roundTrips += 1;
          const request = new Request(url, init);

          return handleRpcRequest(request, contextFor(request));
        },
        origin: "http://localhost:3000",
        plugins: [new BatchLinkPlugin({ groups: [{ condition: () => true, context: {} }] })],
        url: "/api/orpc",
      }),
    );

    const results = await Promise.all([safe(client.auth.me()), safe(client.auth.me())]);

    assert.strictEqual(roundTrips, 1);
    assert.deepStrictEqual(
      results.map(([error]) => (error instanceof ORPCError ? error.code : error)),
      ["UNAUTHORIZED", "UNAUTHORIZED"],
    );
  });
});

const rest = (path: string, init: RequestInit = {}) => {
  const request = new Request(`https://vibedgames.com/api/v1${path}`, init);

  return handleRestRequest(request, contextFor(request));
};

const jsonPost = (headers: Record<string, string> = {}) => ({
  body: "{}",
  headers: { "content-type": "application/json", ...headers },
  method: "POST",
});

describe("rest endpoint", () => {
  test("answers an unauthenticated call with a JSON 401", async () => {
    await assertJsonError(await rest("/auth/me", jsonPost()), 401, "UNAUTHORIZED");
  });

  test("refuses a same-site cross-origin POST", async () => {
    const init = jsonPost({ origin: "https://evil.vibedgames.com" });
    await assertJsonError(await rest("/auth/me", init), 403, "FORBIDDEN");
  });

  test("matches no procedure on GET", async () => {
    await assertJsonError(await rest("/auth/me"), 404, "NOT_FOUND");
  });

  test("answers an unknown operation with a JSON 404", async () => {
    await assertJsonError(await rest("/nope", jsonPost()), 404, "NOT_FOUND");
  });

  test("rejects a body over the cap", async () => {
    const init = jsonPost();
    init.body = JSON.stringify({ padding: "x".repeat(MAX_RPC_BODY_BYTES) });
    const response = await rest("/auth/me", init);
    assert.strictEqual(response.status, 413);
  });
});

describe("unknown api path", () => {
  test("answers JSON, not the HTML not-found page", async () => {
    await assertJsonError(apiNotFound(), 404, "NOT_FOUND");
  });
});
