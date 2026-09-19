import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import type { JsonValue } from "../json";
import { handlePlaytestDecide } from "./decide-handler";
import { mintPlaytestToken } from "./session-token";

/**
 * The one endpoint an untrusted game page may call. What must hold: any
 * origin may reach it (CORS), only a bearer playtest token opens it (never
 * a cookie), the body is bounded and schema-checked, and a good request is
 * forwarded with the SERVER's provider key.
 */

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const SECRET = "handler-secret";
const decision = { tokenSecret: SECRET, typesafe: "sk-provider" };

const answer: JsonValue = { answers: { move: { choice: "left", type: "choice" } }, usage: {} };

const body = {
  questions: {
    move: { criteria: { left: "Left", right: "Right" }, instructions: "?", type: "choice" },
  },
  state: { player: { x: 1 } },
};

const post = (init: {
  token?: string;
  body?: string;
  cookie?: string;
  origin?: string;
}): Request => {
  const headers = new Headers({ "content-type": "application/json" });
  if (init.token !== undefined) {
    headers.set("authorization", `Bearer ${init.token}`);
  }
  if (init.cookie) {
    headers.set("cookie", init.cookie);
  }
  if (init.origin) {
    headers.set("origin", init.origin);
  }
  return new Request("https://vibedgames.com/api/playtest/decide", {
    body: init.body ?? JSON.stringify(body),
    headers,
    method: "POST",
  });
};

interface ErrorBody {
  error?: { code?: string };
}

const status = async (response: Response): Promise<[number, string]> => {
  const json: ErrorBody = await response.json();
  return [response.status, json.error?.code ?? "ok"];
};

test("answers a preflight from any origin without credentials", async () => {
  const res = await handlePlaytestDecide(
    new Request("https://vibedgames.com/api/playtest/decide", {
      headers: { origin: "http://localhost:5173" },
      method: "OPTIONS",
    }),
    decision,
  );
  assert.equal(res.status, 204);
  assert.equal(res.headers.get("access-control-allow-origin"), "*");
  assert.match(res.headers.get("access-control-allow-headers") ?? "", /authorization/u);
  assert.equal(res.headers.get("access-control-allow-credentials"), null);
});

test("forwards a token-bearing request with the server's key and CORS headers", async () => {
  let forwarded: { url: string; auth: string | null } | null = null;
  globalThis.fetch = (input, init) => {
    forwarded = { auth: new Headers(init?.headers).get("authorization"), url: String(input) };
    return Promise.resolve(Response.json(answer));
  };
  const { token } = await mintPlaytestToken(SECRET, "user-1");
  const res = await handlePlaytestDecide(
    post({ origin: "https://my-game.vibedgames.com", token }),
    decision,
  );
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("access-control-allow-origin"), "*");
  assert.deepEqual(await res.json(), answer);
  assert.deepEqual(forwarded, {
    auth: "Bearer sk-provider",
    url: "https://api.typesafe.ai/v1/systemone",
  });
});

test("a session cookie opens nothing; only a valid token does", async () => {
  let fetched = false;
  globalThis.fetch = () => {
    fetched = true;
    return Promise.resolve(Response.json(answer));
  };
  assert.deepEqual(
    await status(await handlePlaytestDecide(post({ cookie: "session=abc" }), decision)),
    [401, "UNAUTHORIZED"],
  );
  assert.deepEqual(
    await status(await handlePlaytestDecide(post({ token: "pt.bad.token" }), decision)),
    [401, "UNAUTHORIZED"],
  );
  const expired = await mintPlaytestToken(SECRET, "user-1", Date.now() - 60 * 60_000);
  assert.deepEqual(
    await status(await handlePlaytestDecide(post({ token: expired.token }), decision)),
    [401, "UNAUTHORIZED"],
  );
  assert.equal(fetched, false, "nothing reached the provider");
});

test("rejects a malformed or oversized body before forwarding", async () => {
  let fetched = false;
  globalThis.fetch = () => {
    fetched = true;
    return Promise.resolve(Response.json(answer));
  };
  const { token } = await mintPlaytestToken(SECRET, "user-1");
  assert.deepEqual(
    await status(await handlePlaytestDecide(post({ body: "{nope", token }), decision)),
    [400, "BAD_REQUEST"],
  );
  assert.deepEqual(
    await status(
      await handlePlaytestDecide(post({ body: JSON.stringify({ state: {} }), token }), decision),
    ),
    [400, "BAD_REQUEST"],
  );
  const huge = JSON.stringify({ ...body, state: "x".repeat(300 * 1024) });
  assert.deepEqual(
    await status(await handlePlaytestDecide(post({ body: huge, token }), decision)),
    [413, "PAYLOAD_TOO_LARGE"],
  );
  assert.equal(fetched, false);
});

test("maps provider and configuration failures to JSON errors with the right status", async () => {
  const { token } = await mintPlaytestToken(SECRET, "user-1");
  globalThis.fetch = () => Promise.resolve(new Response("slow down", { status: 429 }));
  assert.deepEqual(await status(await handlePlaytestDecide(post({ token }), decision)), [
    429,
    "TOO_MANY_REQUESTS",
  ]);
  assert.deepEqual(
    await status(await handlePlaytestDecide(post({ token }), { tokenSecret: SECRET })),
    [412, "PRECONDITION_FAILED"],
  );
  assert.deepEqual(await status(await handlePlaytestDecide(post({ token }), {})), [
    412,
    "PRECONDITION_FAILED",
  ]);
  const get = await handlePlaytestDecide(
    new Request("https://vibedgames.com/api/playtest/decide", { method: "GET" }),
    decision,
  );
  assert.equal(get.status, 405);
});
