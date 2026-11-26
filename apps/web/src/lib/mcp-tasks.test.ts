import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { after, beforeEach, describe, test } from "node:test";
import { startD1 } from "@repo/service/d1.test-utils";
import type { JsonValue } from "@repo/contract/json";
import type { ORPCContext } from "@repo/service/orpc";
import { createAuth } from "@repo/service/identity/auth";
import { z } from "zod";

import { handleMcpRequest } from "./mcp";
import { GENERATION_META, TASKS_EXTENSION } from "./mcp-tasks";

const { close, db } = await startD1();

after(close);

const auth = createAuth({ baseURL: "http://localhost:3000", db, secret: "test-secret" });

let jobStatus = "IN_QUEUE";

const replyTo = (path: string) => {
  if (path.endsWith("/status")) {
    return { status: jobStatus };
  }

  if (path.endsWith("/cancel")) {
    jobStatus = "CANCELLED";

    return { status: "CANCELLATION_REQUESTED" };
  }

  return path.includes("/requests/")
    ? { images: [{ url: "https://media.example/a.png" }] }
    : { request_id: "request-1", status: "IN_QUEUE" };
};

const seen: string[] = [];

const upstream = createServer((req, res) => {
  const path = new URL(req.url ?? "/", "http://upstream.invalid").pathname;
  seen.push(`${req.method} ${path}`);

  const reply = replyTo(path);

  req.resume();
  req.on("end", () => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(reply));
  });
});

upstream.listen(0, "127.0.0.1");

await once(upstream, "listening");

const address = upstream.address();
const origin = `http://127.0.0.1:${address instanceof Object ? address.port : 0}`;

after(() => {
  upstream.closeAllConnections();
  upstream.close();
});

const now = new Date(0);

type Session = NonNullable<ORPCContext["session"]>;

const sessionFor = (userId: string) =>
  ({
    session: {
      createdAt: now,
      expiresAt: now,
      id: `session-${userId}`,
      ipAddress: null,
      token: "apikey:key-1",
      updatedAt: now,
      userAgent: null,
      userId,
    },
    user: {
      banned: false,
      createdAt: now,
      email: "dev@vibedgames.local",
      emailVerified: true,
      id: userId,
      name: "Dev",
      role: "admin",
      updatedAt: now,
    },
  }) satisfies Session;

const contextFor = (userId: string | null) => async (headers: Headers) =>
  await Promise.resolve<ORPCContext>({
    auth,
    billing: undefined,
    db,
    decision: undefined,
    mediaJobs: undefined,
    headers,
    media: {
      fal: "fal-test-key",
      falDocsBaseUrl: `${origin}/docs`,
      falPlatformBaseUrl: `${origin}/platform`,
      falQueueBaseUrl: `${origin}/queue`,
      falStorageBaseUrl: `${origin}/storage`,
    },
    oauthScopes: null,
    productionURL: undefined,
    r2: undefined,
    session: userId === null ? null : sessionFor(userId),
    signing: { baseUrl: "https://vibedgames.com", secret: "test-secret" },
  });

const withTasks = { extensions: { [TASKS_EXTENSION]: {} } };

let nextId = 1;

const routingName = z.union([
  z.object({ name: z.string() }).transform(({ name }) => name),
  z.object({ taskId: z.string() }).transform(({ taskId }) => taskId),
]);

const rpc = async (
  method: string,
  params: { [key: string]: JsonValue },
  {
    capabilities = withTasks,
    userId = "user_1",
  }: { capabilities?: JsonValue; userId?: string | null } = {},
) => {
  const meta = {
    "io.modelcontextprotocol/clientCapabilities": capabilities,
    "io.modelcontextprotocol/clientInfo": { name: "test", version: "1.0.0" },
    "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  };

  const headers = new Headers({
    accept: "application/json, text/event-stream",
    "content-type": "application/json",
    "mcp-method": method,
    "mcp-protocol-version": "2026-07-28",
  });

  const routed = routingName.safeParse(params);

  if (routed.success) {
    headers.set("mcp-name", routed.data);
  }

  const request = new Request("https://vibedgames.com/mcp", {
    body: JSON.stringify({
      id: (nextId += 1),
      jsonrpc: "2.0",
      method,
      params: { ...params, _meta: meta },
    }),
    headers,
    method: "POST",
  });

  const response = await handleMcpRequest(request, contextFor(userId), []);
  const text = await response.text();

  if (response.status === 401) {
    return { status: 401 };
  }

  const json = text.startsWith("{")
    ? text
    : text
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice("data:".length))
        .join("");

  return z.looseObject({}).parse(JSON.parse(json));
};

const generation = z.looseObject({
  [GENERATION_META]: z.object({ endpoint_id: z.string(), request_id: z.string() }),
});

const task = z.object({
  result: z.looseObject({
    _meta: generation,
    resultType: z.literal("task"),
    statusMessage: z.string(),
    status: z.literal("working"),
    taskId: z.string(),
  }),
});

const startTask = async () => {
  const body = await rpc("tools/call", {
    arguments: { endpoint_id: "fal-ai/flux/dev", input: { prompt: "a cat" } },
    name: "generate",
  });

  return task.parse(body).result.taskId;
};

const taskState = z.object({
  result: z.looseObject({
    _meta: generation,
    result: z.looseObject({ structuredContent: z.unknown() }).optional(),
    resultType: z.literal("complete"),
    status: z.string(),
  }),
});

const taskError = z.object({ error: z.looseObject({ code: z.number() }) });

beforeEach(() => {
  jobStatus = "IN_QUEUE";
  seen.length = 0;
});

describe("mcp tasks", () => {
  test("declares the tasks extension", async () => {
    const body = await rpc("server/discover", {});

    const discovered = z
      .object({
        result: z.looseObject({ capabilities: z.looseObject({ extensions: z.looseObject({}) }) }),
      })
      .parse(body);

    assert.ok(TASKS_EXTENSION in discovered.result.capabilities.extensions);
  });

  test("answers a queued generation with a task, without waiting on it", async () => {
    await startTask();

    assert.deepStrictEqual(
      seen.filter((line) => line.includes("/requests/")),
      [],
    );
  });

  test("names the generation's endpoint_id and request_id beside the taskId", async () => {
    const body = await rpc("tools/call", {
      arguments: { endpoint_id: "fal-ai/flux/dev", input: { prompt: "a cat" } },
      name: "generate",
    });

    const { result } = task.parse(body);

    assert.deepStrictEqual(result._meta[GENERATION_META], {
      endpoint_id: "fal-ai/flux/dev",
      request_id: "request-1",
    });
    assert.match(result.statusMessage, /endpoint_id: fal-ai\/flux\/dev, request_id: request-1/u);
    assert.ok("io.modelcontextprotocol/serverInfo" in result._meta);

    const polled = taskState.parse(await rpc("tasks/get", { taskId: result.taskId })).result;

    assert.strictEqual(polled._meta[GENERATION_META].request_id, "request-1");
  });

  test("answers a client without the extension with the tool's own result", async () => {
    const body = await rpc(
      "tools/call",
      {
        arguments: { endpoint_id: "fal-ai/flux/dev", input: { prompt: "a cat" }, wait_seconds: 0 },
        name: "generate",
      },
      { capabilities: { extensions: {} } },
    );

    const { result } = z
      .object({
        result: z.looseObject({ structuredContent: z.looseObject({ request_id: z.string() }) }),
      })
      .parse(body);

    assert.strictEqual(result.structuredContent.request_id, "request-1");
    assert.notStrictEqual(result.resultType, "task");
  });

  test("reports a running job as working, then its output once it completes", async () => {
    const taskId = await startTask();

    jobStatus = "IN_PROGRESS";
    const running = taskState.parse(await rpc("tasks/get", { taskId })).result;
    assert.strictEqual(running.status, "working");

    jobStatus = "COMPLETED";
    const done = taskState.parse(await rpc("tasks/get", { taskId })).result;
    assert.strictEqual(done.status, "completed");
    assert.deepStrictEqual(done.result?.structuredContent, {
      endpoint_id: "fal-ai/flux/dev",
      request_id: "request-1",
      result: { images: [{ url: "https://media.example/a.png" }] },
      status: "COMPLETED",
    });
  });

  test("cancels a task on the queue", async () => {
    const taskId = await startTask();
    const body = await rpc("tasks/cancel", { taskId });

    assert.strictEqual(
      z.object({ result: z.looseObject({}) }).parse(body).result.resultType,
      "complete",
    );
    assert.ok(seen.includes("PUT /queue/fal-ai/flux/requests/request-1/cancel"));
    assert.ok(seen.includes("GET /queue/fal-ai/flux/requests/request-1/status"));
  });

  test("refuses another account's task, and a forged one", async () => {
    const taskId = await startTask();
    const [prefix, payload] = taskId.split(".");

    const bodies = await Promise.all(
      (
        [
          [taskId, "user_2"],
          [`${prefix}.${payload}.AAAA`, "user_1"],
        ] as const
      ).map(async ([id, userId]) => await rpc("tasks/get", { taskId: id }, { userId })),
    );

    for (const body of bodies) {
      assert.strictEqual(taskError.parse(body).error.code, -32_602);
    }
  });

  test("challenges tasks/get without a credential, like the tool it follows", async () => {
    const taskId = await startTask();

    assert.deepStrictEqual(await rpc("tasks/get", { taskId }, { userId: null }), { status: 401 });
  });

  test("refuses tasks/get from a client without the extension", async () => {
    const taskId = await startTask();
    const body = await rpc("tasks/get", { taskId }, { capabilities: { extensions: {} } });

    assert.strictEqual(taskError.parse(body).error.code, -32_021);
  });
});
