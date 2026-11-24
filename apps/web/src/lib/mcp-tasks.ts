import type { JsonValue } from "@repo/contract/json";
import type { McpServer } from "@modelcontextprotocol/server";
import { MissingRequiredClientCapabilityError, ProtocolError } from "@modelcontextprotocol/server";
import { z } from "zod";

import type { McpContext } from "@/lib/mcp-tools";
import { queueCancel, queueResult, queueStatus, TERMINAL } from "@/lib/mcp-tools";

/**
 * Generations over MCP's Tasks extension (`io.modelcontextprotocol/tasks`,
 * 2026-07-28): a client that declares it gets a `tools/call` on a generate
 * tool back as a task the moment the job is queued, and follows it with
 * `tasks/get` / `tasks/cancel` instead of blocking on `wait_seconds` and
 * polling generate_status. Nothing is stored: the task id is the queue job
 * (endpoint and request id) signed for the caller, and every `tasks/get` asks
 * the queue, through `generate.forward` so the ledger holds, settles and
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

const hmacKey = (secret: string) =>
  crypto.subtle.importKey(
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
  const signatureBytes = signature ? fromBase64url(signature) : null;

  if (prefix !== PREFIX || !payload || !signatureBytes || rest.length > 0) {
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

const taskState = (taskId: string, ref: TaskRef, status: TaskStatus, statusMessage?: string) => {
  const state = {
    createdAt: new Date(ref.c).toISOString(),
    lastUpdatedAt: new Date().toISOString(),
    pollIntervalMs: POLL_INTERVAL_MS,
    status,
    taskId,
    ttlMs: TTL_MS,
  };

  return statusMessage === undefined ? state : { ...state, statusMessage };
};

const STATUS_MESSAGES = new Map([
  ["IN_PROGRESS", "Generating"],
  ["IN_QUEUE", "Queued"],
]);

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
  const json = contentType?.includes("text/event-stream")
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

  if (!parsed?.success || parsed.data.result.isError) {
    return passThrough;
  }

  const { _meta: meta, structuredContent: job } = parsed.data.result;

  if (TERMINAL.has(job.status)) {
    return passThrough;
  }

  const ref = { c: Date.now(), e: job.endpoint_id, r: job.request_id, u: userId };
  const taskId = await mintTaskId(secret, ref);
  const task = taskState(taskId, ref, "working", STATUS_MESSAGES.get(job.status));

  return Response.json({
    id: parsed.data.id,
    jsonrpc: "2.0",
    result: { _meta: meta, resultType: "task", ...task },
  });
};

const toolResult = (ref: TaskRef, status: string, result: JsonValue) => {
  const structured = { endpoint_id: ref.e, request_id: ref.r, result, status };

  return {
    content: [{ text: JSON.stringify(structured), type: "text" }],
    structuredContent: structured,
  };
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
    const status = await queueStatus(context, ref.e, ref.r);

    if (status === "CANCELLED") {
      return taskState(params.taskId, ref, "cancelled");
    }

    if (status === "FAILED") {
      return {
        ...taskState(params.taskId, ref, "completed", "The model failed"),
        result: toolResult(ref, status, null),
      };
    }

    if (status !== "COMPLETED") {
      return taskState(params.taskId, ref, "working", STATUS_MESSAGES.get(status));
    }

    const result = await queueResult(context, ref.e, ref.r);

    return {
      ...taskState(params.taskId, ref, "completed"),
      result: toolResult(ref, status, result),
    };
  });

  server.server.setRequestHandler("tasks/update", { params: taskParams }, async (params) => {
    await resolve(params);

    return {};
  });

  server.server.setRequestHandler("tasks/cancel", { params: taskParams }, async (params) => {
    const ref = await resolve(params);

    await queueCancel(context, ref.e, ref.r).catch(() => null);

    return {};
  });
};
