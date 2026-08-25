import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { ORPCContext } from "@repo/api/orpc";
import { createAuth } from "@repo/api/auth/auth";
import { createDb } from "@repo/db/drizzle-client";
import { MAX_RPC_BODY_BYTES } from "@repo/api/generate/limits";

import { handleRpcRequest } from "./orpc-handler";

/**
 * The CSRF plugin is this endpoint's only cross-site defense and it lives in
 * transport config that typecheck cannot see. Driving the real handler pins
 * the wiring: removing the plugin, adding CORS headers, or dropping the body
 * cap turns CI red instead of silently shipping an unguarded endpoint.
 *
 * The context is assembled by hand rather than through `createORPCContext`
 * (which would hit the database for a session): the transport plugins reject
 * before any procedure runs, and the one request that gets through stops at
 * `protectedProcedure`'s session check.
 */

const unavailable = (): never => {
  throw new Error("the database is not reachable in this test");
};

const db = createDb({
  prepare: unavailable,
  batch: unavailable,
  exec: unavailable,
  withSession: unavailable,
  dump: unavailable,
});

const auth = createAuth({
  db,
  baseURL: "http://localhost:3000",
  secret: "test-secret",
});

const contextFor = (request: Request): ORPCContext => ({
  session: null,
  db,
  auth,
  headers: request.headers,
  productionURL: undefined,
  r2: undefined,
  media: undefined,
});

const post = (headers: Record<string, string>, body = JSON.stringify({ json: {} })) => {
  const request = new Request("http://localhost:3000/api/orpc/auth/me", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body,
  });
  return handleRpcRequest(request, contextFor(request));
};

describe("rpc endpoint", () => {
  test("rejects a POST without the CSRF header", async () => {
    const response = await post({});
    assert.strictEqual(response.status, 403);
    assert.match(await response.text(), /CSRF_TOKEN_MISMATCH/);
  });

  test("admits a POST carrying the header the link plugin sends", async () => {
    // 401, not 403: the request cleared the CSRF plugin and reached the
    // protected procedure without a session.
    const response = await post({ "x-csrf-token": "orpc" });
    assert.strictEqual(response.status, 401);
    assert.match(await response.text(), /UNAUTHORIZED/);
  });

  test("rejects GET on procedures", async () => {
    const request = new Request("http://localhost:3000/api/orpc/auth/me", {
      method: "GET",
      headers: { "x-csrf-token": "orpc" },
    });
    const response = await handleRpcRequest(request, contextFor(request));
    assert.strictEqual(response.status, 405);
  });

  test("rejects a body over the cap before parsing it", async () => {
    const body = JSON.stringify({ json: { padding: "x".repeat(MAX_RPC_BODY_BYTES) } });
    const response = await post({ "x-csrf-token": "orpc" }, body);
    assert.strictEqual(response.status, 413);
    assert.match(await response.text(), /PAYLOAD_TOO_LARGE/);
  });

  test("serves no CORS headers, so cross-origin fetches cannot preflight in", async () => {
    const response = await post({});
    assert.strictEqual(response.headers.get("access-control-allow-origin"), null);
  });

  // The browser link batches, so dropping `BatchHandlerPlugin` would 404 the
  // `__batch__` path and break every multi-query page at once — nothing else in
  // the build would notice. Buffered mode only so the body is plain JSON; the
  // handler picks the mode off the header either way.
  test("fans a batch out to its items, checking CSRF once for the batch", async () => {
    const item = { url: "http://localhost:3000/api/orpc/auth/me", body: { json: {} } };
    const request = new Request("http://localhost:3000/api/orpc/__batch__", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-csrf-token": "orpc",
        "x-orpc-batch": "buffered",
      },
      body: JSON.stringify([item, item]),
    });

    const response = await handleRpcRequest(request, contextFor(request));
    // 207, and both items answered 401 rather than 403: the CSRF check passed
    // on the envelope and each item ran on to the protected procedure.
    assert.strictEqual(response.status, 207);
    assert.strictEqual((await response.text()).match(/UNAUTHORIZED/g)?.length, 2);
  });
});
