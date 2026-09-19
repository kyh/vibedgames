import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

import { asJsonObject, asString, parseJson } from "./json.ts";
import type { JsonValue } from "./json.ts";
import type { Activity } from "./reporter.ts";
import type { RunOptions, RunResult } from "./runner.ts";

/** Keep only the tail of stderr — it's used solely for final error reporting. */
const STDERR_TAIL_MAX = 16_000;

/** Human-friendly duration for watchdog messages ("45m", "3s"). */
const fmtMs = (ms: number): string =>
  ms >= 60_000 ? `${Math.round(ms / 60_000)}m` : `${Math.round(ms / 1000)}s`;

const parseCodexItem = (value: JsonValue | undefined): CodexItem | undefined => {
  const item = asJsonObject(value);
  if (!item) {
    return undefined;
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
    type: asString(item.type),
  };
};
/**
 * Decode one `codex exec --json` line into a typed event at the process
 * boundary — the CLI's output is untrusted bytes until each used field is
 * validated. Null for non-JSON noise and event types this view doesn't consume.
 */
const parseCodexEvent = (text: string): CodexEvent | null => {
  const evt = asJsonObject(parseJson(text));
  if (!evt) {
    return null;
  }
  switch (evt.type) {
    case "thread.started": {
      return { thread_id: asString(evt.thread_id), type: "thread.started" };
    }
    case "turn.started":
    case "turn.completed": {
      return { type: evt.type };
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
      return { item: parseCodexItem(evt.item), type: evt.type };
    }
    default: {
      return null;
    }
  }
};
const oneLine = (s: string, max = 80): string => {
  const flat = s.replaceAll(/\s+/gu, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
};
/** Tool-ish items are reported once, when they start. */
const startedActivity = (item: CodexItem): Activity | null => {
  switch (item.type) {
    case "command_execution": {
      return item.command ? { detail: oneLine(item.command), kind: "tool", name: "shell" } : null;
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
        detail: item.query ? oneLine(item.query) : undefined,
        kind: "tool",
        name: "web_search",
      };
    }
    default: {
      return null;
    }
  }
};

/** Messages and edits are reported once, when they complete. */
const finishedActivity = (item: CodexItem): Activity | null => {
  switch (item.type) {
    case "agent_message": {
      return item.text?.trim() ? { kind: "text", text: item.text.trim() } : null;
    }
    case "file_change": {
      const paths = (item.changes ?? [])
        .map((c) => c.path)
        .filter((path): path is string => Boolean(path))
        .join(", ");
      return { detail: paths ? oneLine(paths) : undefined, kind: "tool", name: "edit" };
    }
    case "error": {
      // Codex surfaces non-fatal warnings as error items (skills budget etc.).
      return item.message ? { kind: "text", text: `⚠ ${oneLine(item.message, 160)}` } : null;
    }
    default: {
      return null;
    }
  }
};

/** Map a codex thread item onto the reporter's Activity view. */
const itemActivity = (item: CodexItem | undefined, started: boolean): Activity | null => {
  if (!item?.type) {
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
export const runCodex = (opts: RunOptions): Promise<RunResult> => {
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

  // oxlint-disable-next-line promise/avoid-new -- child_process.spawn is event-based
  return new Promise((resolve) => {
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

    const settle = (res: RunResult): void => {
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
      try {
        rl?.close();
      } catch {
        /* ignore */
      }
      try {
        child?.stdout?.destroy();
        child?.stderr?.destroy();
        child?.unref();
      } catch {
        /* ignore */
      }
      resolve(res);
    };

    // Watchdog: no output at all for idleTimeoutMs means the process is wedged
    // (or a tool is stuck) — kill it and fail so the phase loop and workspace
    // lock can never block forever. Reset on every event.
    const pokeIdle = (): void => {
      if (opts.idleTimeoutMs <= 0 || settled) {
        return;
      }
      if (idleTimer) {
        clearTimeout(idleTimer);
      }
      idleTimer = setTimeout(() => {
        try {
          child?.kill("SIGKILL");
        } catch {
          /* already gone */
        }
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
      return;
    }

    // arm the inactivity watchdog before the first byte arrives
    pokeIdle();

    // Absolute ceiling: fires even while the session is actively streaming.
    if (opts.maxSessionMs > 0) {
      sessionTimer = setTimeout(() => {
        try {
          child?.kill("SIGKILL");
        } catch {
          /* already gone */
        }
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
      return;
    }
    rl.on("line", (line) => {
      // any output is a sign of life
      pokeIdle();
      const trimmed = line.trim();
      if (!trimmed) {
        return;
      }
      const evt = parseCodexEvent(trimmed);
      if (evt === null) {
        return;
        // ignore non-JSON noise and unknown event types
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
        default: {
          break;
        }
      }
    });

    child.stderr?.on("data", (d: Buffer) => {
      // stderr output is also a sign of life
      pokeIdle();
      // bounded tail
      stderr = (stderr + d.toString()).slice(-STDERR_TAIL_MAX);
    });

    child.on("error", (err: Error) => {
      settle({ error: `${opts.bin}: ${err.message}`, ok: false, result: "" });
    });

    child.on("close", (code) => {
      // Success requires a completed turn AND a clean exit — a bare exit 0
      // with no turn.completed means no confirmed outcome, so treat as failure
      // rather than silently advancing the phase.
      if (failure || code !== 0 || !turnCompleted) {
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
  });
};

interface CodexItem {
  type?: string;
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
  | { type: "item.started" | "item.completed"; item?: CodexItem };
