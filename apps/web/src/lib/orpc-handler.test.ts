import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { AppRouter } from "@repo/api";
import type { ORPCContext } from "@repo/api/orpc";
import type { RouterClient } from "@orpc/server";
import { createAuth } from "@repo/api/auth/auth";
import { createDb } from "@repo/db/drizzle-client";
import { MAX_RPC_BODY_BYTES } from "@repo/api/generate/limits";
import { createORPCClient, ORPCError, safe } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import { BatchLinkPlugin } from "@orpc/client/plugins";

import { handleRpcRequest } from "./orpc-handler";

/**
 * This endpoint's cross-site defense is a set of things typecheck cannot see:
 * the session cookie's SameSite=Lax, the handler refusing GET, and the origin
 * check covering what SameSite does not — a same-site *cross-origin* form POST
 * from a user's game subdomain. Driving the real handler pins the last two,
 * along with the batch fan-out, the body cap, and the absence of CORS headers
 * — each of which would otherwise regress silently.
 *
 * The context is assembled by hand rather than through `createORPCContext`
 * (which would hit the database for a session): the transport rejects before
 * any procedure runs, and the one request that gets through stops at
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

const post = (body = JSON.stringify({ json: {} })) => {
  const request = new Request("http://localhost:3000/api/orpc/auth/me", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
  return handleRpcRequest(request, contextFor(request));
};

describe("rpc endpoint", () => {
  test("runs a POST through to the procedure's session check", async () => {
    const response = await post();
    assert.strictEqual(response.status, 401);
    assert.match(await response.text(), /UNAUTHORIZED/);
  });

  test("refuses GET, so a cross-site navigation cannot invoke a procedure", async () => {
    // Unmatched rather than rejected: `allowMethods` leaves GET off the list,
    // so the handler never resolves a procedure and the route 404s.
    const request = new Request("http://localhost:3000/api/orpc/auth/me", { method: "GET" });
    const response = await handleRpcRequest(request, contextFor(request));
    assert.strictEqual(response.status, 404);
  });

  // `{slug}.vibedgames.com` is a different ORIGIN but the same SITE as the app,
  // so SameSite=Lax attaches the session cookie to a form POST from a game page.
  // A game is untrusted uploaded code; without this the endpoint is its API.
  test("refuses a POST whose Origin is another origin, even a same-site one", async () => {
    const request = new Request("https://vibedgames.com/api/orpc/auth/me", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://evil.vibedgames.com" },
      body: JSON.stringify({ json: {} }),
    });
    const response = await handleRpcRequest(request, contextFor(request));
    assert.strictEqual(response.status, 403);
  });

  test("allows a POST whose Origin is the app itself", async () => {
    const request = new Request("https://vibedgames.com/api/orpc/auth/me", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://vibedgames.com" },
      body: JSON.stringify({ json: {} }),
    });
    const response = await handleRpcRequest(request, contextFor(request));
    assert.strictEqual(response.status, 401);
  });

  // The CLI is not a browser: it sends no Origin and authenticates by bearer
  // token, so there is no ambient cookie for another page to forge a call with.
  test("allows a POST with no Origin at all, so the CLI still reaches it", async () => {
    const response = await post();
    assert.strictEqual(response.status, 401);
  });

  test("rejects a body over the cap before parsing it", async () => {
    const body = JSON.stringify({ json: { padding: "x".repeat(MAX_RPC_BODY_BYTES) } });
    const response = await post(body);
    assert.strictEqual(response.status, 413);
    assert.match(await response.text(), /PAYLOAD_TOO_LARGE/);
  });

  test("serves no CORS headers, so a credentialed cross-origin fetch cannot read it", async () => {
    const response = await post();
    assert.strictEqual(response.headers.get("access-control-allow-origin"), null);
  });

  // The browser link batches, so dropping `BatchHandlerPlugin` would break
  // every multi-query page at once and nothing else in the build would notice.
  // Driven through a real batching link rather than a hand-written envelope:
  // the batch wire format is the library's, and pinning it here only breaks on
  // upgrades without ever catching a wiring mistake.
  test("answers a batch in one round trip, one result per item", async () => {
    let roundTrips = 0;
    const client: RouterClient<AppRouter> = createORPCClient(
      new RPCLink({
        origin: "http://localhost:3000",
        url: "/api/orpc",
        plugins: [new BatchLinkPlugin({ groups: [{ condition: () => true, context: {} }] })],
        fetch: (url, init) => {
          roundTrips += 1;
          const request = new Request(url, init);
          return handleRpcRequest(request, contextFor(request));
        },
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
