import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

import { asJsonObject, asString, parseJson } from "./json.ts";
import type { JsonValue } from "./json.ts";
import type { Activity } from "./reporter.ts";
import type { RunOptions, RunResult } from "./runner.ts";
import { bestEffort } from "./best-effort.ts";

const STDERR_TAIL_MAX = 16_000;

const fmtMs = (ms: number) =>
  ms >= 60_000 ? `${Math.round(ms / 60_000)}m` : `${Math.round(ms / 1000)}s`;

const parseCodexItem = (value: JsonValue | undefined) => {
  const item = asJsonObject(value);

  if (!item) {
    return null;
  }

  return {
    changes: Array.isArray(item.changes)
      ? item.changes.map((change) => ({ path: asString(asJsonObject(change)?.path) }))
      : undefined,
    command: asString(item.command),
    message: asString(item.message),
    query: asString(item.query),
    server: asString(item.server),
    text: asString(item.text),
    tool: asString(item.tool),
    type: asString(item.type) ?? "",
  };
};

const parseCodexEvent: (text: string) => CodexEvent | null = (text) => {
  const evt = asJsonObject(parseJson(text));

  if (!evt) {
    return null;
  }

  const type = asString(evt.type) ?? "";

  switch (type) {
    case "thread.started": {
      return { thread_id: asString(evt.thread_id), type: "thread.started" };
    }

    case "turn.started":
    case "turn.completed": {
      return { type };
    }

    case "turn.failed": {
      const error = asJsonObject(evt.error);

      return { error: error && { message: asString(error.message) }, type: "turn.failed" };
    }

    case "error": {
      return { message: asString(evt.message), type: "error" };
    }

    case "item.started":
    case "item.completed": {
      return { item: parseCodexItem(evt.item), type };
    }

    default: {
      return null;
    }
  }
};

const oneLine = (s: string, max = 80) => {
  const flat = s.replaceAll(/\s+/gu, " ").trim();

  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
};

const startedActivity: (item: CodexItem) => Activity | null = (item) => {
  switch (item.type) {
    case "command_execution": {
      return item.command !== undefined && item.command !== ""
        ? { detail: oneLine(item.command), kind: "tool", name: "shell" }
        : null;
    }

    case "mcp_tool_call": {
      return {
        detail: undefined,
        kind: "tool",
        name: [item.server, item.tool].filter(Boolean).join(".") || "mcp",
      };
    }

    case "web_search": {
      return {
        detail: item.query !== undefined && item.query !== "" ? oneLine(item.query) : undefined,
        kind: "tool",
        name: "web_search",
      };
    }

    default: {
      return null;
    }
  }
};

const finishedActivity: (item: CodexItem) => Activity | null = (item) => {
  switch (item.type) {
    case "agent_message": {
      const text = item.text?.trim() ?? "";

      return text === "" ? null : { kind: "text", text };
    }

    case "file_change": {
      const paths = (item.changes ?? [])
        .map((c) => c.path)
        .filter((path): path is string => Boolean(path))
        .join(", ");

      return { detail: paths ? oneLine(paths) : undefined, kind: "tool", name: "edit" };
    }

    case "error": {
      return item.message !== undefined && item.message !== ""
        ? { kind: "text", text: `⚠ ${oneLine(item.message, 160)}` }
        : null;
    }

    default: {
      return null;
    }
  }
};

const itemActivity: (item: CodexItem | null, started: boolean) => Activity | null = (
  item,
  started,
) => {
  if (item === null || item.type === "") {
    return null;
  }

  return started ? startedActivity(item) : finishedActivity(item);
};

/**
 * Invoke a headless Codex session (`codex exec --json`) with the same contract
 * as runClaude: one fresh session per phase, Activity events streamed as they
 * happen, watchdogs so a wedged session can never hang the loop. Codex has no
 * separate system-prompt channel, so the role prompt is prepended to the task;
 * it reports token usage but not dollar cost, so costUsd stays undefined.
 */
export const runCodex: (opts: RunOptions) => Promise<RunResult> = async (opts) => {
  const args = ["exec", "--json", "--skip-git-repo-check", "--model", opts.model];

  if (opts.skipPermissions) {
    args.push("--dangerously-bypass-approvals-and-sandbox");
  } else {
    args.push("--sandbox", "workspace-write");
  }

  for (const dir of opts.addDirs ?? []) {
    args.push("--add-dir", dir);
  }

  args.push(`${opts.systemPrompt}\n\n---\n\nYOUR TASK:\n\n${opts.prompt}`);

  const { promise, resolve } = Promise.withResolvers<RunResult>();

  let child: ReturnType<typeof spawn> | undefined;
  let rl: ReturnType<typeof createInterface> | undefined;
  let sessionId: string | undefined;
  let lastMessage = "";
  let turnCompleted = false;
  let failure: string | undefined;
  let stderr = "";
  let settled = false;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let sessionTimer: ReturnType<typeof setTimeout> | undefined;

  const settle = (res: RunResult) => {
    if (settled) {
      return;
    }

    settled = true;

    if (idleTimer) {
      clearTimeout(idleTimer);
    }

    if (sessionTimer) {
      clearTimeout(sessionTimer);
    }

    bestEffort(() => {
      rl?.close();
    });
    bestEffort(() => {
      child?.stdout?.destroy();
      child?.stderr?.destroy();
      child?.unref();
    });
    resolve(res);
  };

  const pokeIdle = () => {
    if (opts.idleTimeoutMs <= 0 || settled) {
      return;
    }

    if (idleTimer) {
      clearTimeout(idleTimer);
    }

    idleTimer = setTimeout(() => {
      bestEffort(() => {
        child?.kill("SIGKILL");
      });
      settle({
        error: `no output for ${fmtMs(opts.idleTimeoutMs)} — treating codex as hung`,
        ok: false,
        result: "",
      });
    }, opts.idleTimeoutMs);
    idleTimer.unref?.();
  };

  try {
    child = spawn(opts.bin, args, {
      cwd: opts.cwd,
      env: { ...process.env },
      signal: opts.signal,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    settle({
      error: `failed to spawn ${opts.bin}: ${error instanceof Error ? error.message : String(error)}`,
      ok: false,
      result: "",
    });

    return await promise;
  }

  pokeIdle();

  if (opts.maxSessionMs > 0) {
    sessionTimer = setTimeout(() => {
      bestEffort(() => {
        child?.kill("SIGKILL");
      });
      settle({
        error: `exceeded the ${fmtMs(opts.maxSessionMs)} session limit — killed`,
        ok: false,
        result: "",
      });
    }, opts.maxSessionMs);
    sessionTimer.unref?.();
  }

  if (child.stdout) {
    rl = createInterface({ input: child.stdout });
  }

  if (!rl) {
    settle({ error: "codex produced no stdout pipe", ok: false, result: "", sessionId });

    return await promise;
  }

  rl.on("line", (line) => {
    pokeIdle();
    const trimmed = line.trim();

    if (!trimmed) {
      return;
    }

    const evt = parseCodexEvent(trimmed);

    if (evt === null) {
      return;
    }

    switch (evt.type) {
      case "thread.started": {
        sessionId = evt.thread_id;
        opts.onActivity({ kind: "init", model: opts.model });

        return;
      }

      case "item.started":
      case "item.completed": {
        const activity = itemActivity(evt.item, evt.type === "item.started");

        if (activity) {
          opts.onActivity(activity);

          if (evt.type === "item.completed" && evt.item?.type === "agent_message") {
            lastMessage = evt.item.text ?? lastMessage;
          }
        }

        return;
      }

      case "turn.completed": {
        turnCompleted = true;

        return;
      }

      case "turn.failed": {
        failure = evt.error?.message ?? "codex turn failed";
        break;
      }

      case "error": {
        failure = evt.message ?? failure;
        break;
      }

      case "turn.started": {
        break;
      }

      default: {
        const exhaustive: never = evt;
        throw new Error(`unhandled codex event ${JSON.stringify(exhaustive)}`);
      }
    }
  });

  child.stderr?.on("data", (d: Buffer) => {
    pokeIdle();
    stderr = (stderr + d.toString()).slice(-STDERR_TAIL_MAX);
  });

  child.on("error", (err: Error) => {
    settle({ error: `${opts.bin}: ${err.message}`, ok: false, result: "" });
  });

  child.on("close", (code) => {
    if ((failure !== undefined && failure !== "") || code !== 0 || !turnCompleted) {
      settle({
        error: failure ?? stderr.trim() ?? `codex exited with code ${code}`,
        ok: false,
        result: lastMessage,
        sessionId,
      });

      return;
    }

    settle({ ok: true, result: lastMessage, sessionId });
  });

  return await promise;
};

interface CodexItem {
  type: string;
  text?: string;
  message?: string;
  command?: string;
  tool?: string;
  server?: string;
  query?: string;
  changes?: { path?: string }[];
}

type CodexEvent =
  | { type: "thread.started"; thread_id?: string }
  | { type: "turn.started" }
  | { type: "turn.completed" }
  | { type: "turn.failed"; error?: { message?: string } }
  | { type: "error"; message?: string }
  | { type: "item.started" | "item.completed"; item: CodexItem | null };
