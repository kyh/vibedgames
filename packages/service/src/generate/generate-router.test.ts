import assert from "node:assert/strict";
import { after, describe, test } from "node:test";
import type { D1PreparedStatement, D1Result } from "@cloudflare/workers-types";
import type { JsonValue } from "@repo/contract/json";
import { createDb } from "@repo/db/drizzle-client";
import { call } from "@orpc/server";

import { createAuth } from "../identity/auth";
import { MICRO_PER_USD } from "../credits/credit-ledger";
import type { ORPCContext } from "../orpc";
import { startUpstream } from "../upstream.test-utils";
import type { UpstreamReply } from "../upstream.test-utils";
import { forward, generateRouter } from "./generate-router";

const unavailable = (): never => {
  throw new Error("this test's database only reads the balance and batches writes");
};

const d1Result = <T>() =>
  ({
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
  }) satisfies D1Result<T>;

function raw<T = unknown[]>(options: { columnNames: true }): Promise<[string[], ...T[]]>;
function raw<T = unknown[]>(options?: { columnNames?: false }): Promise<T[]>;
function raw() {
  return Promise.resolve([[20 * MICRO_PER_USD]]);
}

interface Write {
  query: string;
  params: unknown[];
}

const writes: Write[] = [];
const bound = new WeakMap<D1PreparedStatement, Write>();

const prepare = (query: string, params: unknown[] = []) => {
  const statement: D1PreparedStatement = {
    all: <T>() => Promise.resolve(d1Result<T>()),
    bind: (...values) => prepare(query, values),
    first: () => Promise.resolve(null),
    raw,
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

const contextAs: (role: string) => ORPCContext = (role) => ({
  auth,
  billing: undefined,
  db,
  decision: undefined,
  headers: new Headers(),
  media,
  oauthScopes: null,
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
  signing: undefined,
});

type Upstream = () => UpstreamReply;

const json = (status: number, body: JsonValue) => () => ({ json: body, status });

const unreachable: Upstream = () => ({ drop: true });

const priceList = (endpointId: string) =>
  json(200, {
    has_more: false,
    next_cursor: null,
    prices: [{ currency: "USD", endpoint_id: endpointId, unit: "image", unit_price: 0.025 }],
  })();

interface Routes {
  estimate: Upstream;
  price: (endpointId: string) => UpstreamReply;
  other: (url: URL) => UpstreamReply;
}

const queued: Upstream = () => ({ json: { request_id: "request-1" } });
let routes: Routes = { estimate: unreachable, other: queued, price: priceList };

const targetOf = (url: URL) => {
  const [, target = "", ...rest] = url.pathname.split("/");

  return new URL(`/${rest.join("/")}${url.search}`, `https://${target}.upstream`);
};

const upstream = await startUpstream((request) => {
  const url = targetOf(request.url);

  if (url.hostname === "platform.upstream" && url.pathname === "/v1/models/pricing") {
    return routes.price(url.searchParams.get("endpoint_id") ?? "");
  }

  if (url.hostname === "platform.upstream" && url.pathname === "/v1/models/pricing/estimate") {
    return routes.estimate();
  }

  return routes.other(url);
});

after(upstream.close);

const media = {
  fal: "fal-test-key",
  falDocsBaseUrl: `${upstream.origin}/docs`,
  falPlatformBaseUrl: `${upstream.origin}/platform`,
  falQueueBaseUrl: `${upstream.origin}/queue`,
  falStorageBaseUrl: `${upstream.origin}/storage`,
};

const fetchedUrls = () => upstream.requests.map((request) => targetOf(request.url));

const stubFal = ({
  estimate = json(404, { error: { message: "Endpoint(s) not found", type: "not_found" } }),
  price = priceList,
}: {
  estimate?: Upstream;
  price?: (endpointId: string) => UpstreamReply;
} = {}) => {
  writes.length = 0;
  upstream.requests.length = 0;
  routes = { estimate, other: queued, price };
};

const ranOnQueue = () => fetchedUrls().some((url) => url.hostname === "queue.upstream");

const submit = (path: string, role: string) =>
  forward(contextAs(role), { method: "POST", path, target: "queue" });

describe("forward path", () => {
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
      stubFal();
      await assert.rejects(submit(path, "user"), { code: "BAD_REQUEST" }, JSON.stringify(path));
      assert.deepEqual(fetchedUrls(), [], JSON.stringify(path));
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
      stubFal();
      await assert.rejects(
        forward(contextAs("user"), { method, path, target: "queue" }),
        { code: "BAD_REQUEST" },
        path,
      );
      assert.deepEqual(fetchedUrls(), [], path);
    }

    const elsewhere: { path: string; target: "platform" | "storage" | "docs" }[] = [
      { path: "/v1/models/Fal%2Dai", target: "platform" },
      { path: "/v1/models/a,b;c", target: "platform" },
      { path: "/storage/upload/Initiate%20Now", target: "storage" },
      { path: "/docs/MCP", target: "docs" },
    ];

    for (const { path, target } of elsewhere) {
      stubFal();
      await forward(contextAs("user"), { method: "GET", path, target });
      assert.deepEqual(
        fetchedUrls().map((url) => url.pathname),
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
      stubFal();
      await submit(path, "user");

      const priced = fetchedUrls().find(
        (url) => url.hostname === "platform.upstream" && url.pathname === "/v1/models/pricing",
      );

      const ran = fetchedUrls().find((url) => url.hostname === "queue.upstream");
      assert.ok(priced && ran, `${path} was not priced and sent`);
      assert.equal(
        priced.searchParams.get("endpoint_id"),
        ran.pathname.split("/").filter(Boolean).join("/"),
        path,
      );
    }
  });
});

describe("forward submit", () => {
  test("refuses a member's submit to an endpoint no price is published for", async () => {
    const unpriced = {
      "a 400": json(400, {
        error: { message: "Invalid request parameters", type: "validation_error" },
      }),
      "a 404": json(404, { error: { message: "Endpoint(s) not found", type: "not_found" } }),
      "an empty price list": json(200, { has_more: false, next_cursor: null, prices: [] }),
    };

    for (const [answer, price] of Object.entries(unpriced)) {
      stubFal({ price });
      await assert.rejects(
        submit("/fal-ai/flux/dex", "user"),
        {
          code: "BAD_REQUEST",
          message: /^unknown_endpoint: no price is published for "fal-ai\/flux\/dex"/u,
        },
        answer,
      );
      assert.ok(!ranOnQueue(), `ran on ${answer}`);
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
      stubFal();
      await submit(path, "user");

      const priced = fetchedUrls().find(
        (url) => url.hostname === "platform.upstream" && url.pathname === "/v1/models/pricing",
      );

      assert.equal(priced?.searchParams.get("endpoint_id"), path.slice(1), path);
      assert.ok(heldGeneration(), `${path} was not held`);
    }

    stubFal({
      price: json(404, { error: { message: "Endpoint(s) not found", type: "not_found" } }),
    });

    await assert.rejects(submit("/owner/unpriced/sub/requests", "user"), {
      code: "BAD_REQUEST",
      message: /^unknown_endpoint:/u,
    });
    assert.ok(!ranOnQueue());
  });

  test("submits on the default hold when pricing cannot answer", async () => {
    const down = {
      "a 429": json(429, { error: { message: "Rate limit exceeded", type: "rate_limited" } }),
      "a 503": json(503, { error: { message: "Service unavailable", type: "server_error" } }),
      "no answer": unreachable,
    };

    for (const [answer, price] of Object.entries(down)) {
      stubFal({ estimate: unreachable, price });
      await submit("/fal-ai/pricing-down/model", "user");
      assert.ok(ranOnQueue(), `did not run on ${answer}`);
      assert.deepEqual(
        heldGeneration(),
        { holdMicro: 100_000, unit: null, unitPriceMicro: null },
        answer,
      );
    }
  });

  test("lets an admin submit to an endpoint no price is published for, on the default hold", async () => {
    stubFal({
      price: json(404, { error: { message: "Endpoint(s) not found", type: "not_found" } }),
    });

    await submit("/fal-ai/unpriced/for-admin", "admin");
    assert.ok(ranOnQueue());
    assert.deepEqual(heldGeneration(), { holdMicro: 100_000, unit: null, unitPriceMicro: null });
  });

  test("holds a priced endpoint at its estimate, else one unit, and keeps its unit price", async () => {
    stubFal({ estimate: json(200, { total_cost: 0.05 }) });
    await submit("/fal-ai/priced/with-history", "user");
    assert.ok(ranOnQueue());
    assert.deepEqual(heldGeneration(), {
      holdMicro: 50_000,
      unit: "image",
      unitPriceMicro: 25_000,
    });

    stubFal();
    await submit("/fal-ai/priced/first-run", "user");
    assert.ok(ranOnQueue());
    assert.deepEqual(heldGeneration(), {
      holdMicro: 25_000,
      unit: "image",
      unitPriceMicro: 25_000,
    });
  });
});

describe("forward errors", () => {
  const BRAND = /\bfal\b(?!-)/iu;

  test("names no provider when an upstream call fails", async () => {
    stubFal();
    routes = { ...routes, other: json(500, { detail: "boom" }) };
    await assert.rejects(
      forward(contextAs("user"), {
        method: "GET",
        path: "/fal-ai/flux/requests/request-1/status",
        target: "queue",
      }),
      (error: Error) => {
        assert.match(error.message, /failed \(500\)/u);
        assert.doesNotMatch(error.message, BRAND);

        return true;
      },
    );
  });

  test("names no provider when media is not configured", async () => {
    await assert.rejects(
      forward(
        { ...contextAs("user"), media: undefined },
        { method: "GET", path: "/v1/models", target: "platform" },
      ),
      (error: Error) => {
        assert.doesNotMatch(error.message, BRAND);

        return true;
      },
    );
  });
});

describe("generate.upload", () => {
  const signing = { baseUrl: "https://vibedgames.com", secret: "test-secret" };

  test("opens a storage slot and hands back our signed URL for it", async () => {
    stubFal();
    routes = {
      ...routes,
      other: json(200, {
        file_url: "https://media.example/file.png",
        upload_url: "https://storage.example/slot?token=1",
      }),
    };

    const slot = await call(
      generateRouter.upload,
      { contentType: "image/png", fileName: "ref.png" },
      { context: { ...contextAs("user"), signing } },
    );

    assert.strictEqual(slot.fileUrl, "https://media.example/file.png");
    assert.deepStrictEqual(slot.headers, { "content-type": "image/png" });
    const upload = new URL(slot.uploadUrl);
    assert.strictEqual(upload.origin + upload.pathname, "https://vibedgames.com/api/upload");
    assert.strictEqual(upload.searchParams.get("to"), "https://storage.example/slot?token=1");
    const [asked] = upstream.requests;
    assert.strictEqual(asked && targetOf(asked.url).pathname, "/storage/upload/initiate");
    assert.deepStrictEqual(JSON.parse(asked?.body ?? "null"), {
      content_type: "image/png",
      file_name: "ref.png",
    });
  });

  test("refuses a slot that is not HTTPS", async () => {
    stubFal();
    routes = {
      ...routes,
      other: json(200, {
        file_url: "http://media.example/file.png",
        upload_url: "https://storage.example/slot",
      }),
    };
    await assert.rejects(
      call(
        generateRouter.upload,
        { contentType: "image/png", fileName: "ref.png" },
        { context: { ...contextAs("user"), signing } },
      ),
      { code: "BAD_GATEWAY" },
    );
  });
});

const queueHops = () =>
  fetchedUrls()
    .filter((url) => url.hostname === "queue.upstream")
    .map((url) => `${url.pathname}${url.search}`);

const onQueue = (replies: Record<string, JsonValue>) => (url: URL) => {
  const body = replies[`${url.pathname}${url.search}`];

  return body === undefined ? { json: { error: "unexpected hop" }, status: 404 } : { json: body };
};

describe("generate.run", () => {
  test("submits the full endpoint and fetches the output from its app once completed", async () => {
    stubFal();
    routes = {
      ...routes,
      other: onQueue({
        "/fal-ai/flux/dev": { request_id: "request-1", status: "COMPLETED" },
        "/fal-ai/flux/requests/request-1": { images: [{ url: "https://media.example/a.png" }] },
      }),
    };

    const run = await call(
      generateRouter.run,
      { endpoint_id: "fal-ai/flux/dev", input: { prompt: "a cat" }, wait_seconds: 0 },
      { context: contextAs("user") },
    );

    assert.deepStrictEqual(run, {
      endpoint_id: "fal-ai/flux/dev",
      request_id: "request-1",
      result: { images: [{ url: "https://media.example/a.png" }] },
      status: "COMPLETED",
    });
    assert.deepStrictEqual(queueHops(), ["/fal-ai/flux/dev", "/fal-ai/flux/requests/request-1"]);
    assert.ok(heldGeneration(), "the submit was not held against the ledger");
  });

  test("returns the request id without polling when it may not wait", async () => {
    stubFal();
    routes = {
      ...routes,
      other: onQueue({ "/fal-ai/flux/dev": { request_id: "request-1", status: "IN_QUEUE" } }),
    };

    const run = await call(
      generateRouter.run,
      { endpoint_id: "fal-ai/flux/dev", input: {}, wait_seconds: 0 },
      { context: contextAs("user") },
    );

    assert.deepStrictEqual(run, {
      endpoint_id: "fal-ai/flux/dev",
      request_id: "request-1",
      result: null,
      status: "IN_QUEUE",
    });
    assert.deepStrictEqual(queueHops(), ["/fal-ai/flux/dev"]);
  });

  test("holds an endpoint id to the queue path rules", async () => {
    stubFal();
    await assert.rejects(
      call(
        generateRouter.run,
        { endpoint_id: "FAL-AI/FLUX/DEV", input: {}, wait_seconds: 0 },
        { context: contextAs("user") },
      ),
      { code: "BAD_REQUEST" },
    );
    assert.equal(ranOnQueue(), false);
  });
});

describe("generate.status", () => {
  test("reaches a job's status, with logs, and its output on the endpoint's app", async () => {
    stubFal();
    routes = {
      ...routes,
      other: onQueue({
        "/fal-ai/flux/requests/request-1": { images: [] },
        "/fal-ai/flux/requests/request-1/status?logs=1": { logs: [], status: "IN_PROGRESS" },
      }),
    };

    const context = { context: contextAs("user") };
    const job = { endpoint_id: "fal-ai/flux/dev", request_id: "request-1" };

    assert.deepStrictEqual(
      await call(generateRouter.status, { ...job, action: "status", logs: true }, context),
      { logs: [], status: "IN_PROGRESS" },
    );
    assert.deepStrictEqual(
      await call(generateRouter.status, { ...job, action: "result", logs: false }, context),
      { images: [] },
    );
  });
});

describe("generate.status cancel", () => {
  test("still polls the job, which refunds its hold, when the cancel itself is refused", async () => {
    stubFal();
    routes = {
      ...routes,
      other: onQueue({ "/fal-ai/flux/requests/request-1/status": { status: "FAILED" } }),
    };

    await assert.rejects(
      call(
        generateRouter.status,
        { action: "cancel", endpoint_id: "fal-ai/flux/dev", request_id: "request-1" },
        { context: contextAs("user") },
      ),
    );
    assert.deepStrictEqual(queueHops(), [
      "/fal-ai/flux/requests/request-1/cancel",
      "/fal-ai/flux/requests/request-1/status",
    ]);
  });
});

describe("generate catalog", () => {
  test("spells a model search as the platform's query", async () => {
    stubFal();
    routes = { ...routes, other: json(200, { models: [] }) };

    await call(
      generateRouter.models,
      {
        category: "text-to-image",
        endpoint_id: ["fal-ai/flux/dev"],
        expand: ["openapi-3.0"],
        limit: 5,
        query: "pixel art",
        status: "all",
      },
      { context: contextAs("user") },
    );

    const [asked] = fetchedUrls();
    assert.strictEqual(asked?.pathname, "/v1/models");
    assert.deepStrictEqual(
      [...(asked?.searchParams ?? [])],
      [
        ["limit", "5"],
        ["q", "pixel art"],
        ["category", "text-to-image"],
        ["endpoint_id", "fal-ai/flux/dev"],
        ["expand", "openapi-3.0"],
      ],
    );
  });

  test("asks for one model's OpenAPI document as its schema", async () => {
    stubFal();
    routes = { ...routes, other: json(200, { models: [] }) };

    await call(
      generateRouter.schema,
      { endpoint_id: "fal-ai/flux/dev", format: "openapi" },
      { context: contextAs("user") },
    );

    const [asked] = fetchedUrls();
    assert.strictEqual(
      `${asked?.pathname}${asked?.search}`,
      "/v1/models?endpoint_id=fal-ai%2Fflux%2Fdev&limit=1&expand=openapi-3.0",
    );
  });
});

describe("generate assets", () => {
  test("edits on the image model's edit endpoint, with the typed fields over the options", async () => {
    stubFal();
    routes = { ...routes, other: json(200, { request_id: "request-1", status: "IN_QUEUE" }) };

    await call(
      generateRouter.image,
      {
        image_urls: ["https://media.example/a.png"],
        options: { prompt: "ignored", seed: 7 },
        prompt: "make it night",
        wait_seconds: 0,
      },
      { context: contextAs("user") },
    );

    const submitted = upstream.requests.find(
      (request) => targetOf(request.url).hostname === "queue.upstream",
    );

    assert.equal(submitted && targetOf(submitted.url).pathname, "/openai/gpt-image-2.5/flare/edit");
    assert.deepStrictEqual(JSON.parse(submitted?.body ?? "null"), {
      image_urls: ["https://media.example/a.png"],
      prompt: "make it night",
      seed: 7,
    });
  });

  test("refuses a video's last frame without its first, before anything is fetched", async () => {
    stubFal();
    await assert.rejects(
      call(
        generateRouter.video,
        { end_image_url: "https://media.example/z.png", prompt: "a run", wait_seconds: 0 },
        { context: contextAs("user") },
      ),
      { code: "BAD_REQUEST" },
    );
    assert.deepEqual(fetchedUrls(), []);
  });
});
