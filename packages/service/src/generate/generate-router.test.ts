import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import { createDb } from "@repo/db/drizzle-client";
import { call } from "@orpc/server";

import { createAuth } from "../auth/auth";
import type { ORPCContext } from "../orpc";
import { callFal } from "./fal-call";
import { generateRouter } from "./generate-router";

/**
 * The credit ledger reads a queue hop off `path` as sent, while fal gets
 * `new URL(base + path)`. Wherever the URL parser rewrites a path the two
 * disagree: `/owner\model` reaches fal as a submit to `owner/model` but reads
 * as no submit at all, skipping the balance gate and the hold, and a `.`
 * segment, a tab or a trailing space has the ledger price an endpoint fal
 * never runs. So the input schema refuses every such spelling, and for what it
 * accepts the endpoint priced is the endpoint fal is asked to run. The typed
 * procedures build their paths from an endpoint id, which is held to the same
 * rule, and `callFal` holds every hop to it. fal is a stubbed `fetch`; the
 * database is unreachable, so a hold's write fails and is logged, as the
 * handler does for any ledger hiccup.
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

const now = new Date();

const contextAs = (role: string): ORPCContext => ({
  auth,
  db,
  decision: undefined,
  headers: new Headers(),
  media: { fal: "fal-test-key" },
  productionURL: undefined,
  r2: undefined,
  session: {
    session: {
      createdAt: now,
      expiresAt: now,
      id: "session-1",
      ipAddress: null,
      token: "session-token",
      updatedAt: now,
      userAgent: null,
      userId: "user-1",
    },
    user: {
      banned: false,
      createdAt: now,
      email: "user@vibedgames.com",
      emailVerified: true,
      id: "user-1",
      name: "User",
      role,
      updatedAt: now,
    },
  },
});

const realFetch = globalThis.fetch;
const realConsoleError = console.error;
afterEach(() => {
  globalThis.fetch = realFetch;
  console.error = realConsoleError;
});

/** Every URL the handler fetches, answered as a queue submit is. */
const stubUpstream = (): URL[] => {
  const fetched: URL[] = [];
  globalThis.fetch = (input) => {
    fetched.push(new URL(String(input)));
    return Promise.resolve(Response.json({ request_id: "request-1" }));
  };
  return fetched;
};

const submit = (path: string, role: string) =>
  call(
    generateRouter.forward,
    { method: "POST", path, target: "queue" },
    { context: contextAs(role) },
  );

describe("generate.forward path", () => {
  test("refuses a path the URL parser would rewrite, before anything is fetched", async () => {
    const rewritten = [
      "/owner\\model",
      "/fal-ai\\flux/dev",
      "/fal-ai/flux/./dev",
      "/fal-ai/flux/%2E/dev",
      "/fal-ai/flux/../dev",
      "/fal-ai/fl\tux/dev",
      "/fal-ai/flux\r/dev",
      "/fal-ai/flux/dev\n",
      "/fal-ai/flux/dev ",
      "/fal-ai/flux dev",
      "/fal-ai/flüx/dev",
    ];
    for (const path of rewritten) {
      const fetched = stubUpstream();
      await assert.rejects(submit(path, "user"), { code: "BAD_REQUEST" }, JSON.stringify(path));
      assert.deepEqual(fetched, [], JSON.stringify(path));
    }
  });

  test("prices the endpoint fal is asked to run", async () => {
    // Admins skip the balance gate, which needs the database, but are priced
    // and held like anyone else.
    console.error = () => {
      /* the hold's write fails against the unreachable database */
    };
    const accepted = [
      "/fal-ai/flux/dev",
      "/fal-ai/flux-pro/v1.1-ultra",
      "/fal-ai/kling-video/v2.1/master/text-to-video",
      "/fal-ai/flux/dev/",
    ];
    for (const path of accepted) {
      const fetched = stubUpstream();
      await submit(path, "admin");
      const priced = fetched.find((url) => url.pathname === "/v1/models/pricing");
      const ran = fetched.find((url) => url.origin === "https://queue.fal.run");
      assert.ok(priced && ran, `${path} was not priced and sent`);
      assert.equal(
        priced.searchParams.get("endpoint_id"),
        ran.pathname.split("/").filter(Boolean).join("/"),
        path,
      );
    }
  });
});

// Spellings of an endpoint id the URL parser would carry to fal differently,
// or that would leave the provider's namespace.
const REWRITTEN_IDS = [
  "fal-ai/flux/./dev",
  "fal-ai/flux/../dev",
  "./fal-ai/flux",
  "fal-ai/flux/.",
  "fal-ai\\flux/dev",
  "fal-ai/fl\tux/dev",
  "fal-ai/flux/dev\n",
  "fal-ai/flux/dev ",
  "fal-ai/flux dev",
  "fal-ai/flüx/dev",
  "fal-ai/flux%2Fdev",
  "fal-ai/flux/%2e/dev",
  "fal-ai//flux",
  "https://example.com/x",
];

const job = { requestId: "request-1" };

describe("typed generate procedures", () => {
  test("refuse an endpoint id the URL parser would rewrite, before anything is fetched", async () => {
    for (const endpointId of REWRITTEN_IDS) {
      const context = { context: contextAs("admin") };
      const calls = [
        () => call(generateRouter.submit, { endpointId, input: {} }, context),
        () => call(generateRouter.status, { ...job, endpointId }, context),
        () => call(generateRouter.result, { ...job, endpointId }, context),
        () => call(generateRouter.cancel, { ...job, endpointId }, context),
        () => call(generateRouter.pricing, { endpointId }, context),
        () => call(generateRouter.schema, { endpointId }, context),
        () => call(generateRouter.models, { endpointIds: [endpointId] }, context),
      ];
      for (const run of calls) {
        const fetched = stubUpstream();
        await assert.rejects(run(), { code: "BAD_REQUEST" }, JSON.stringify(endpointId));
        assert.deepEqual(fetched, [], JSON.stringify(endpointId));
      }
    }
  });

  test("submit prices the endpoint fal is asked to run", async () => {
    console.error = () => {
      /* the hold's write fails against the unreachable database */
    };
    const accepted = [
      "fal-ai/flux/dev",
      "fal-ai/flux-pro/v1.1-ultra",
      "fal-ai/kling-video/v2.1/master/text-to-video",
      "/fal-ai/flux/dev/",
      "workflows/owner/my-flow",
    ];
    for (const endpointId of accepted) {
      const fetched = stubUpstream();
      const { requestId } = await call(
        generateRouter.submit,
        { endpointId, input: { prompt: "a cat" } },
        { context: contextAs("admin") },
      );
      assert.equal(requestId, "request-1");
      const priced = fetched.find((url) => url.pathname === "/v1/models/pricing");
      const ran = fetched.find((url) => url.origin === "https://queue.fal.run");
      assert.ok(priced && ran, `${endpointId} was not priced and sent`);
      const canonical = endpointId.replaceAll(/^\/+|\/+$/gu, "");
      assert.equal(priced.searchParams.get("endpoint_id"), canonical, endpointId);
      assert.equal(ran.pathname, `/${canonical}`, endpointId);
    }
  });

  test("status and result reach the job under its endpoint's app", async () => {
    const endpointId = "fal-ai/flux/dev";
    let fetched = stubUpstream();
    await call(generateRouter.status, { ...job, endpointId }, { context: contextAs("user") });
    assert.deepEqual(
      fetched.map((url) => url.href),
      ["https://queue.fal.run/fal-ai/flux/requests/request-1/status"],
    );
    console.error = () => {
      /* the settle's write fails against the unreachable database */
    };
    fetched = stubUpstream();
    await call(generateRouter.result, { ...job, endpointId }, { context: contextAs("user") });
    assert.deepEqual(
      fetched.map((url) => url.href),
      ["https://queue.fal.run/fal-ai/flux/requests/request-1"],
    );
  });

  test("callFal holds every hop to the forward path rule", async () => {
    const { db: hopDb, media, session } = contextAs("admin");
    assert.ok(session);
    for (const path of ["/fal-ai/flux/./dev", "/owner\\model", "/fal-ai/flux dev"]) {
      const fetched = stubUpstream();
      await assert.rejects(
        callFal({ db: hopDb, media, session }, { method: "POST", path, target: "queue" }),
        { code: "BAD_REQUEST" },
        JSON.stringify(path),
      );
      assert.deepEqual(fetched, [], JSON.stringify(path));
    }
  });
});
