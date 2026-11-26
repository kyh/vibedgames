import type { JsonValue } from "@repo/contract/json";
import type { McpServer } from "@modelcontextprotocol/server";
import { MissingRequiredClientCapabilityError, ProtocolError } from "@modelcontextprotocol/server";
import { TERMINAL_STATUSES } from "@repo/contract/generate/queue-path";
import { appRouter } from "@repo/service";
import { call } from "@orpc/server";
import { z } from "zod";

import type { McpContext } from "@/lib/mcp-tools";

/**
 * Generations over MCP's Tasks extension (`io.modelcontextprotocol/tasks`,
 * 2026-07-28): a client that declares it gets a `tools/call` on a generate
 * tool back as a task the moment the job is queued, and follows it with
 * `tasks/get` / `tasks/cancel` instead of blocking on `wait_seconds` and
 * polling generate_status. Nothing is stored: the task id is the queue job
 * (endpoint and request id) signed for the caller, and every `tasks/get` asks
 * the queue, through `generate.status` so the ledger holds, settles and
 * refunds exactly as for any other call.
 */
export const TASKS_EXTENSION = "io.modelcontextprotocol/tasks";

/** The methods the extension adds, each needing the `generate` scope like the tools it follows. */
export const TASK_METHODS: ReadonlySet<string> = new Set([
  "tasks/get",
  "tasks/update",
  "tasks/cancel",
]);

const TTL_MS = 24 * 60 * 60 * 1000;
const POLL_INTERVAL_MS = 3000;
const PREFIX = "vgt";

const clientExtensions = z.looseObject({
  extensions: z.looseObject({ [TASKS_EXTENSION]: z.looseObject({}) }),
});

const taskRef = z.object({
  c: z.number().int(),
  e: z.string().min(1),
  r: z.string().min(1),
  u: z.string().min(1),
});

type TaskRef = z.infer<typeof taskRef>;

const base64url = (bytes: Uint8Array) =>
  btoa(String.fromCodePoint(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/[=]+$/u, "");

const fromBase64url = (text: string) => {
  const padded = text
    .replaceAll("-", "+")
    .replaceAll("_", "/")
    .padEnd(Math.ceil(text.length / 4) * 4, "=");

  try {
    return Uint8Array.from(atob(padded), (c) => c.codePointAt(0) ?? 0);
  } catch {
    return null;
  }
};

const hmacKey = async (secret: string) =>
  await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(`mcp-task:${secret}`),
    { hash: "SHA-256", name: "HMAC" },
    false,
    ["sign", "verify"],
  );

const mintTaskId = async (secret: string, ref: TaskRef) => {
  const payload = base64url(new TextEncoder().encode(JSON.stringify(ref)));

  const signature = await crypto.subtle.sign(
    "HMAC",
    await hmacKey(secret),
    new TextEncoder().encode(payload),
  );

  return `${PREFIX}.${payload}.${base64url(new Uint8Array(signature))}`;
};

const readTaskId = async (secret: string, taskId: string, userId: string) => {
  const [prefix, payload, signature, ...rest] = taskId.split(".");

  const signatureBytes =
    signature !== undefined && signature !== "" ? fromBase64url(signature) : null;

  if (
    prefix !== PREFIX ||
    payload === undefined ||
    payload === "" ||
    !signatureBytes ||
    rest.length > 0
  ) {
    return null;
  }

  const valid = await crypto.subtle.verify(
    "HMAC",
    await hmacKey(secret),
    signatureBytes,
    new TextEncoder().encode(payload),
  );

  const bytes = valid ? fromBase64url(payload) : null;

  if (!bytes) {
    return null;
  }

  let decoded: unknown;

  try {
    decoded = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }

  const ref = taskRef.safeParse(decoded);

  return ref.success && ref.data.u === userId && Date.now() - ref.data.c <= TTL_MS
    ? ref.data
    : null;
};

type TaskStatus = "cancelled" | "completed" | "working";

/** The `_meta` key every task carries its generation under, by the ids generate_status and `vg generate status` take. */
export const GENERATION_META = "com.vibedgames/generation";

const PHASES = new Map([
  ["CANCELLED", "Cancelled"],
  ["COMPLETED", "Completed"],
  ["FAILED", "The model failed"],
  ["IN_PROGRESS", "Generating"],
  ["IN_QUEUE", "Queued"],
]);

const taskState = (taskId: string, ref: TaskRef, status: TaskStatus, jobStatus: string) => ({
  _meta: { [GENERATION_META]: { endpoint_id: ref.e, request_id: ref.r } },
  createdAt: new Date(ref.c).toISOString(),
  lastUpdatedAt: new Date().toISOString(),
  pollIntervalMs: POLL_INTERVAL_MS,
  status,
  statusMessage: `${PHASES.get(jobStatus) ?? jobStatus}. endpoint_id: ${ref.e}, request_id: ${ref.r} (what generate_status and \`vg generate status <endpoint_id> <request_id>\` take; taskId is only for tasks/get and tasks/cancel).`,
  taskId,
  ttlMs: TTL_MS,
});

const queued = z.object({
  endpoint_id: z.string().min(1),
  request_id: z.string().min(1),
  status: z.string(),
});

const toolResponse = z.looseObject({
  id: z.union([z.string(), z.number()]),
  jsonrpc: z.literal("2.0"),
  result: z.looseObject({
    _meta: z.looseObject({}).optional(),
    isError: z.boolean().optional(),
    structuredContent: queued,
  }),
});

const messageOf = (text: string, contentType: string | null) => {
  const json =
    contentType?.includes("text/event-stream") === true
      ? text
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice("data:".length))
          .join("")
      : text;

  try {
    return toolResponse.safeParse(JSON.parse(json));
  } catch {
    return null;
  }
};

/**
 * Turns a generate tool's answer for a still-running job into a
 * `CreateTaskResult`. A job that already finished, an error, or anything
 * else is passed through as the tool's own result.
 */
export const asTaskResult = async (
  response: Response,
  { secret, userId }: { secret: string; userId: string },
) => {
  const text = await response.text();
  const passThrough = new Response(text, response);
  const parsed = messageOf(text, response.headers.get("content-type"));

  if (parsed?.success !== true || parsed.data.result.isError === true) {
    return passThrough;
  }

  const { _meta: meta, structuredContent: job } = parsed.data.result;

  if (TERMINAL_STATUSES.has(job.status)) {
    return passThrough;
  }

  const ref = { c: Date.now(), e: job.endpoint_id, r: job.request_id, u: userId };
  const taskId = await mintTaskId(secret, ref);
  const { _meta: generation, ...task } = taskState(taskId, ref, "working", job.status);

  return Response.json({
    id: parsed.data.id,
    jsonrpc: "2.0",
    result: { _meta: { ...meta, ...generation }, resultType: "task", ...task },
  });
};

const toolResult = (ref: TaskRef, status: string, result: JsonValue) => {
  const structured = { endpoint_id: ref.e, request_id: ref.r, result, status };

  return {
    content: [{ text: JSON.stringify(structured), type: "text" }],
    structuredContent: structured,
  };
};

const follow = async (context: McpContext, ref: TaskRef, action: "status" | "result" | "cancel") =>
  await call(
    appRouter.generate.status,
    { action, endpoint_id: ref.e, logs: false, request_id: ref.r },
    { context },
  );

const statusOf = z.looseObject({ status: z.string() });

const queueStatus = async (context: McpContext, ref: TaskRef) => {
  const parsed = statusOf.safeParse(await follow(context, ref, "status"));

  return parsed.success ? parsed.data.status.toUpperCase() : "UNKNOWN";
};

const taskParams = z.looseObject({ taskId: z.string() });

/** Declares the extension and serves `tasks/get`, `tasks/update` and `tasks/cancel`. */
export const registerTasks = (server: McpServer, context: McpContext) => {
  server.server.registerCapabilities({ extensions: { [TASKS_EXTENSION]: {} } });

  const resolve = async (params: z.infer<typeof taskParams>) => {
    if (!clientExtensions.safeParse(server.server.getClientCapabilities()).success) {
      throw new MissingRequiredClientCapabilityError({
        requiredCapabilities: { extensions: { [TASKS_EXTENSION]: {} } },
      });
    }

    const ref =
      context.signing && context.session
        ? await readTaskId(context.signing.secret, params.taskId, context.session.user.id)
        : null;

    if (!ref) {
      throw new ProtocolError(-32_602, "Failed to retrieve task: Task not found");
    }

    return ref;
  };

  server.server.setRequestHandler("tasks/get", { params: taskParams }, async (params) => {
    const ref = await resolve(params);
    const status = await queueStatus(context, ref);

    if (status === "CANCELLED") {
      return taskState(params.taskId, ref, "cancelled", status);
    }

    if (status === "FAILED") {
      return {
        ...taskState(params.taskId, ref, "completed", status),
        result: toolResult(ref, status, null),
      };
    }

    if (status !== "COMPLETED") {
      return taskState(params.taskId, ref, "working", status);
    }

    const result = await follow(context, ref, "result");

    return {
      ...taskState(params.taskId, ref, "completed", status),
      result: toolResult(ref, status, result),
    };
  });

  server.server.setRequestHandler("tasks/update", { params: taskParams }, async (params) => {
    await resolve(params);

    return {};
  });

  server.server.setRequestHandler("tasks/cancel", { params: taskParams }, async (params) => {
    const ref = await resolve(params);

    await follow(context, ref, "cancel").catch(() => null);

    return {};
  });
};
