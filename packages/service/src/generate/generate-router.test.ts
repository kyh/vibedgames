import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import type { D1PreparedStatement, D1Result } from "@cloudflare/workers-types";
import type { JsonValue } from "@repo/contract/json";
import { createDb } from "@repo/db/drizzle-client";
import { call, ORPCError } from "@orpc/server";
import { z } from "zod";

import { createAuth } from "../auth/auth";
import { SIGNUP_GRANT_MICRO } from "../credits/credit-ledger";
import type { ORPCContext } from "../orpc";
import type { FalCallContext, FalRequest } from "./fal-call";
import { callFal } from "./fal-call";
import { generateRouter } from "./generate-router";

/**
 * The credit ledger reads a queue hop off `path` as sent, while fal gets
 * `new URL(base + path)`, percent-decodes it and finds the application
 * whatever its case. Wherever the two disagree a hop dodges its bill:
 * `/owner\model` reaches fal as a submit to `owner/model` but reads as no
 * submit at all, skipping the balance gate and the hold; a `.` segment, a tab,
 * a `%` or a capital has the ledger price an endpoint fal never runs; and
 * `%72equests` fetches a result the ledger never settles. So the input schema
 * refuses every such spelling, and for what it accepts the endpoint priced is
 * the endpoint fal is asked to run. fal reads `requests` as its keyword only
 * right after the application id, so a POST with that segment anywhere else
 * still runs a job: every queue POST is billed as a submit. A submit is then
 * only as good as its price: one the price list doesn't name is refused, and
 * only pricing that cannot answer falls back to the flat hold.
 *
 * The typed procedures build their paths from an endpoint id and a request id,
 * which their input schemas hold to the same spelling, and every procedure's
 * hop goes through `callFal`, which holds it to `generate.forward`'s schema
 * again and applies the same gates.
 *
 * fal is a stubbed `fetch`. The database answers the balance read with the
 * signup grant, finds no generation row (so a settle or a release has nothing
 * to correct), and keeps every write batch so a test can read back the hold.
 * Priced endpoints are cached for the life of the process, so every test names
 * endpoints of its own.
 */

const unavailable = (): never => {
  throw new Error("this test's database only reads and batches writes");
};

const d1Result = <T>(): D1Result<T> => ({
  meta: {
    changed_db: false,
    changes: 0,
    duration: 0,
    last_row_id: 0,
    rows_read: 0,
    rows_written: 0,
    size_after: 0,
  },
  results: [],
  success: true,
});

// The balance read: every caller here holds the signup grant.
function balanceRows<T = unknown[]>(options: { columnNames: true }): Promise<[string[], ...T[]]>;
function balanceRows<T = unknown[]>(options?: { columnNames?: false }): Promise<T[]>;
function balanceRows(): Promise<unknown[]> {
  return Promise.resolve([[SIGNUP_GRANT_MICRO]]);
}

// Any other read, a settle's or a release's generation row: there is none.
function noRows<T = unknown[]>(options: { columnNames: true }): Promise<[string[], ...T[]]>;
function noRows<T = unknown[]>(options?: { columnNames?: false }): Promise<T[]>;
function noRows(): Promise<unknown[]> {
  return Promise.resolve([]);
}

interface Write {
  query: string;
  params: unknown[];
}

/** Every statement the handler batched since the last `stubFal()`. */
const writes: Write[] = [];
const bound = new WeakMap<D1PreparedStatement, Write>();

const prepare = (query: string, params: unknown[] = []): D1PreparedStatement => {
  const statement: D1PreparedStatement = {
    all: <T>() => Promise.resolve(d1Result<T>()),
    bind: (...values) => prepare(query, values),
    first: () => Promise.resolve(null),
    raw: query.includes('from "credit_entry"') ? balanceRows : noRows,
    run: <T>() => Promise.resolve(d1Result<T>()),
  };
  bound.set(statement, { params, query });
  return statement;
};

const db = createDb({
  batch: <T>(statements: D1PreparedStatement[]) => {
    for (const statement of statements) {
      const write = bound.get(statement);
      if (write) {
        writes.push(write);
      }
    }
    return Promise.resolve(statements.map(() => d1Result<T>()));
  },
  dump: unavailable,
  exec: unavailable,
  prepare,
  withSession: unavailable,
});

/** The generation row a hold inserted, read back by column; null if none was. */
const heldGeneration = () => {
  const insert = writes.find(({ query }) => query.startsWith('insert into "generation"'));
  const groups = /\((?<columns>[^)]*)\) values \((?<values>.*)\) on conflict/u.exec(
    insert?.query ?? "",
  )?.groups;
  if (!insert || !groups?.columns || !groups.values) {
    return null;
  }
  const params = [...insert.params];
  const values = groups.values.split(", ");
  const row = new Map(
    groups.columns
      .split(", ")
      .map((column, i) => [column.slice(1, -1), values[i] === "?" ? params.shift() : null]),
  );
  return {
    holdMicro: row.get("hold_micro"),
    unit: row.get("unit"),
    unitPriceMicro: row.get("unit_price_micro"),
  };
};

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

/** What `callFal` takes from a procedure's context, for calling it directly. */
const hopContext = (role: string): FalCallContext => {
  const { media, session } = contextAs(role);
  assert.ok(session);
  return { db, media, session };
};

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

type Upstream = () => Promise<Response>;

const json =
  (status: number, body: JsonValue): Upstream =>
  () =>
    Promise.resolve(Response.json(body, { status }));

const unreachable: Upstream = () => Promise.reject(new TypeError("fetch failed"));

const priceList = (endpointId: string) =>
  json(200, {
    has_more: false,
    next_cursor: null,
    prices: [{ currency: "USD", endpoint_id: endpointId, unit: "image", unit_price: 0.025 }],
  })();

/** Price-list answers that name no price for the endpoint asked about. */
const UNPRICED = {
  "a 400": json(400, {
    error: { message: "Invalid request parameters", type: "validation_error" },
  }),
  "a 404": json(404, { error: { message: "Endpoint(s) not found", type: "not_found" } }),
  "an empty price list": json(200, { has_more: false, next_cursor: null, prices: [] }),
};

/**
 * fal as `fetch`, recording every URL the handler asks for, with the ledger's
 * writes cleared. By default the price list names whatever endpoint it is
 * asked about at $0.025 an image and the estimate has no history; a queue call
 * answers as a submit does.
 */
const stubFal = ({
  estimate = json(404, { error: { message: "Endpoint(s) not found", type: "not_found" } }),
  price = priceList,
}: {
  estimate?: Upstream;
  price?: (endpointId: string) => Promise<Response>;
} = {}): URL[] => {
  writes.length = 0;
  const fetched: URL[] = [];
  globalThis.fetch = (input) => {
    const url = new URL(String(input));
    fetched.push(url);
    if (url.pathname === "/v1/models/pricing") {
      return price(url.searchParams.get("endpoint_id") ?? "");
    }
    if (url.pathname === "/v1/models/pricing/estimate") {
      return estimate();
    }
    return Promise.resolve(Response.json({ request_id: "request-1" }));
  };
  return fetched;
};

const ranOnQueue = (fetched: URL[]): boolean =>
  fetched.some((url) => url.origin === "https://queue.fal.run");

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
      const fetched = stubFal();
      await assert.rejects(submit(path, "user"), { code: "BAD_REQUEST" }, JSON.stringify(path));
      assert.deepEqual(fetched, [], JSON.stringify(path));
    }
  });

  test("refuses a queue path fal would decode, case-fold or read past, and only a queue path", async () => {
    const folded: { method: "GET" | "POST"; path: string }[] = [
      { method: "POST", path: "/fal-ai/fl%75x/dev" },
      { method: "POST", path: "/FAL-AI/FLUX/DEV" },
      { method: "POST", path: "/fal-ai/Flux/dev" },
      { method: "GET", path: "/fal-ai/flux/%72equests/request-1" },
      { method: "GET", path: "/fal-ai/flux/requests/request-1/%73tatus" },
      { method: "GET", path: "/fal-ai/flux/REQUESTS/request-1" },
      { method: "GET", path: "/fal-ai/flux/requests/REQUEST-1/status" },
      { method: "GET", path: "/fal-ai/flux/requests/request-1;x" },
      { method: "GET", path: "/fal-ai/flux/requests/request-1;x/status" },
      { method: "POST", path: "/fal-ai/flux/dev,fal-ai/flux/schnell" },
      { method: "POST", path: "/fal-ai/flux:dev" },
      { method: "POST", path: "/fal-ai/flux@1/dev" },
      { method: "POST", path: "/fal-ai/flux/dev+" },
    ];
    for (const { method, path } of folded) {
      const fetched = stubFal();
      await assert.rejects(
        call(
          generateRouter.forward,
          { method, path, target: "queue" },
          { context: contextAs("user") },
        ),
        { code: "BAD_REQUEST" },
        path,
      );
      assert.deepEqual(fetched, [], path);
    }

    const elsewhere: { path: string; target: "platform" | "storage" | "docs" }[] = [
      { path: "/v1/models/Fal%2Dai", target: "platform" },
      { path: "/v1/models/a,b;c", target: "platform" },
      { path: "/storage/upload/Initiate%20Now", target: "storage" },
      { path: "/docs/MCP", target: "docs" },
    ];
    for (const { path, target } of elsewhere) {
      const fetched = stubFal();
      await call(
        generateRouter.forward,
        { method: "GET", path, target },
        { context: contextAs("user") },
      );
      assert.deepEqual(
        fetched.map((url) => url.pathname),
        [path],
        target,
      );
    }
  });

  test("prices the endpoint fal is asked to run", async () => {
    const accepted = [
      "/fal-ai/flux/dev",
      "/fal-ai/flux-pro/v1.1-ultra",
      "/fal-ai/kling-video/v2.1/master/text-to-video",
      "/fal-ai/flux/schnell/",
    ];
    for (const path of accepted) {
      const fetched = stubFal();
      await submit(path, "user");
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

describe("generate.forward submit", () => {
  test("refuses a member's submit to an endpoint no price is published for", async () => {
    for (const [answer, price] of Object.entries(UNPRICED)) {
      const fetched = stubFal({ price });
      await assert.rejects(
        submit("/fal-ai/flux/dex", "user"),
        {
          code: "BAD_REQUEST",
          message: /^unknown_endpoint: no price is published for "fal-ai\/flux\/dex"/u,
        },
        answer,
      );
      assert.ok(!ranOnQueue(fetched), `ran on ${answer}`);
      assert.deepEqual(writes, [], answer);
    }
  });

  test("bills every queue POST as a submit, whatever `requests` segment it holds", async () => {
    const posts = [
      "/owner/model/sub/requests",
      "/fal-ai/flux/requests",
      "/fal-ai/flux/requests/request-1/status",
    ];
    for (const path of posts) {
      const fetched = stubFal();
      await submit(path, "user");
      const priced = fetched.find((url) => url.pathname === "/v1/models/pricing");
      assert.equal(priced?.searchParams.get("endpoint_id"), path.slice(1), path);
      assert.ok(heldGeneration(), `${path} was not held`);
    }

    const fetched = stubFal({
      price: json(404, { error: { message: "Endpoint(s) not found", type: "not_found" } }),
    });
    await assert.rejects(submit("/owner/unpriced/sub/requests", "user"), {
      code: "BAD_REQUEST",
      message: /^unknown_endpoint:/u,
    });
    assert.ok(!ranOnQueue(fetched));
  });

  test("submits on the default hold when pricing cannot answer", async () => {
    const down = {
      "a 429": json(429, { error: { message: "Rate limit exceeded", type: "rate_limited" } }),
      "a 503": json(503, { error: { message: "Service unavailable", type: "server_error" } }),
      "no answer": unreachable,
    };
    for (const [answer, price] of Object.entries(down)) {
      const fetched = stubFal({ estimate: unreachable, price });
      await submit("/fal-ai/pricing-down/model", "user");
      assert.ok(ranOnQueue(fetched), `did not run on ${answer}`);
      assert.deepEqual(
        heldGeneration(),
        { holdMicro: 100_000, unit: null, unitPriceMicro: null },
        answer,
      );
    }
  });

  test("lets an admin submit to an endpoint no price is published for, on the default hold", async () => {
    const fetched = stubFal({
      price: json(404, { error: { message: "Endpoint(s) not found", type: "not_found" } }),
    });
    await submit("/fal-ai/unpriced/for-admin", "admin");
    assert.ok(ranOnQueue(fetched));
    assert.deepEqual(heldGeneration(), { holdMicro: 100_000, unit: null, unitPriceMicro: null });
  });

  test("holds a priced endpoint at its estimate, else one unit, and keeps its unit price", async () => {
    let fetched = stubFal({ estimate: json(200, { total_cost: 0.05 }) });
    await submit("/fal-ai/priced/with-history", "user");
    assert.ok(ranOnQueue(fetched));
    assert.deepEqual(heldGeneration(), {
      holdMicro: 50_000,
      unit: "image",
      unitPriceMicro: 25_000,
    });

    fetched = stubFal();
    await submit("/fal-ai/priced/first-run", "user");
    assert.ok(ranOnQueue(fetched));
    assert.deepEqual(heldGeneration(), {
      holdMicro: 25_000,
      unit: "image",
      unitPriceMicro: 25_000,
    });
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

const validationIssues = z.object({ issues: z.array(z.object({ message: z.string() })) });

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
        const fetched = stubFal();
        await assert.rejects(run(), { code: "BAD_REQUEST" }, JSON.stringify(endpointId));
        assert.deepEqual(fetched, [], JSON.stringify(endpointId));
      }
    }
  });

  test("refuse an endpoint id or request id with a capital at input validation, before anything is fetched", async () => {
    // fal's catalog spells every id in lowercase and answers lowercase UUIDs,
    // and finds an application whatever its case: a capital would have a
    // typed call priced or settled as a hop other than the one fal runs.
    const endpointId = "fal-ai/Flux/dev";
    const requestId = "4E2C9A1B-7D3F-4A8E-B5C6-0F1E2D3C4B5A";
    const lower = { endpointId: "fal-ai/flux/dev", requestId: "request-1" };
    const context = { context: contextAs("user") };
    const refused = {
      "cancel's endpointId": () => call(generateRouter.cancel, { ...lower, endpointId }, context),
      "cancel's requestId": () => call(generateRouter.cancel, { ...lower, requestId }, context),
      "models' endpointIds": () =>
        call(generateRouter.models, { endpointIds: [endpointId] }, context),
      "pricing's endpointId": () => call(generateRouter.pricing, { endpointId }, context),
      "result's endpointId": () => call(generateRouter.result, { ...lower, endpointId }, context),
      "result's requestId": () => call(generateRouter.result, { ...lower, requestId }, context),
      "schema's endpointId": () => call(generateRouter.schema, { endpointId }, context),
      "status's endpointId": () => call(generateRouter.status, { ...lower, endpointId }, context),
      "status's requestId": () => call(generateRouter.status, { ...lower, requestId }, context),
      "submit's endpointId": () => call(generateRouter.submit, { endpointId, input: {} }, context),
    };
    for (const [field, run] of Object.entries(refused)) {
      const fetched = stubFal();
      await assert.rejects(
        run(),
        (error) => {
          assert.ok(error instanceof ORPCError, field);
          assert.equal(error.code, "BAD_REQUEST", field);
          assert.equal(error.message, "Input validation failed", field);
          const { issues } = validationIssues.parse(error.data);
          assert.ok(
            issues.some((issue) => issue.message.includes("lowercase letters, digits")),
            `${field}: ${JSON.stringify(issues)}`,
          );
          return true;
        },
        field,
      );
      assert.deepEqual(fetched, [], field);
    }
  });

  test("submit prices the endpoint fal is asked to run", async () => {
    const accepted = [
      "fal-ai/flux/krea",
      "fal-ai/flux-pro/kontext",
      "fal-ai/kling-video/v2.5-turbo/pro/image-to-video",
      "/fal-ai/recraft/v3/text-to-image/",
      "workflows/owner/my-flow",
    ];
    for (const endpointId of accepted) {
      const fetched = stubFal();
      const { requestId } = await call(
        generateRouter.submit,
        { endpointId, input: { prompt: "a cat" } },
        { context: contextAs("user") },
      );
      assert.equal(requestId, "request-1");
      const priced = fetched.find((url) => url.pathname === "/v1/models/pricing");
      const ran = fetched.find((url) => url.origin === "https://queue.fal.run");
      assert.ok(priced && ran, `${endpointId} was not priced and sent`);
      const canonical = endpointId.replaceAll(/^\/+|\/+$/gu, "");
      assert.equal(priced.searchParams.get("endpoint_id"), canonical, endpointId);
      assert.equal(ran.pathname, `/${canonical}`, endpointId);
      assert.ok(heldGeneration(), `${endpointId} was not held`);
    }
  });

  test("submit refuses a member's endpoint no price is published for, before the queue or the ledger", async () => {
    for (const [answer, price] of Object.entries(UNPRICED)) {
      const fetched = stubFal({ price });
      await assert.rejects(
        call(
          generateRouter.submit,
          { endpointId: "fal-ai/flux-typo/dev", input: { prompt: "a cat" } },
          { context: contextAs("user") },
        ),
        {
          code: "BAD_REQUEST",
          message: /^unknown_endpoint: no price is published for "fal-ai\/flux-typo\/dev"/u,
        },
        answer,
      );
      assert.ok(!ranOnQueue(fetched), `ran on ${answer}`);
      assert.deepEqual(writes, [], answer);
    }
  });

  test("submit lets an admin's endpoint no price is published for through, on the default hold", async () => {
    const fetched = stubFal({
      price: json(404, { error: { message: "Endpoint(s) not found", type: "not_found" } }),
    });
    const { requestId } = await call(
      generateRouter.submit,
      { endpointId: "fal-ai/unpriced/typed-for-admin", input: { prompt: "a cat" } },
      { context: contextAs("admin") },
    );
    assert.equal(requestId, "request-1");
    assert.ok(ranOnQueue(fetched));
    assert.deepEqual(heldGeneration(), { holdMicro: 100_000, unit: null, unitPriceMicro: null });
  });

  test("status and result reach the job under its endpoint's app", async () => {
    const endpointId = "fal-ai/flux/dev";
    let fetched = stubFal();
    await call(generateRouter.status, { ...job, endpointId }, { context: contextAs("user") });
    assert.deepEqual(
      fetched.map((url) => url.href),
      ["https://queue.fal.run/fal-ai/flux/requests/request-1/status"],
    );
    fetched = stubFal();
    await call(generateRouter.result, { ...job, endpointId }, { context: contextAs("user") });
    assert.deepEqual(
      fetched.map((url) => url.href),
      ["https://queue.fal.run/fal-ai/flux/requests/request-1"],
    );
  });

  test("callFal refuses a hop forward's schema refuses, whichever procedure built it", async () => {
    // A path the URL parser would rewrite, and a queue path in each shape a
    // typed procedure builds (submit, status, result, cancel) spelled other
    // than fal routes it: refused before any price is asked or any job runs,
    // even when the procedure that built it skipped its own input rules.
    const hops: FalRequest[] = [
      { method: "POST", path: "/fal-ai/flux/./dev", target: "queue" },
      { method: "POST", path: "/owner\\model", target: "queue" },
      { method: "POST", path: "/fal-ai/flux dev", target: "queue" },
      { method: "POST", path: "/fal-ai/Flux/dev", target: "queue" },
      { method: "POST", path: "/fal-ai/fl%75x/dev", target: "queue" },
      { method: "GET", path: "/fal-ai/flux/requests/REQUEST-1/status", target: "queue" },
      { method: "GET", path: "/fal-ai/flux/%72equests/request-1", target: "queue" },
      { method: "GET", path: "/Fal-ai/flux/requests/request-1", target: "queue" },
      { method: "PUT", path: "/fal-ai/flux/requests/Request-1/cancel", target: "queue" },
    ];
    for (const role of ["user", "admin"]) {
      for (const hop of hops) {
        const label = `${role} ${hop.method} ${JSON.stringify(hop.path)}`;
        const fetched = stubFal();
        await assert.rejects(
          callFal(hopContext(role), hop),
          { code: "BAD_REQUEST", message: /^refused a provider request: /u },
          label,
        );
        assert.deepEqual(fetched, [], label);
        assert.deepEqual(writes, [], label);
      }
    }
  });
});
