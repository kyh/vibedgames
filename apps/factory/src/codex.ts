import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

import type { Activity } from "./reporter.ts";
import type { RunOptions, RunResult } from "./runner.ts";

// Every resolution path funnels through the `settle()` helper below, which is
// guarded by a `settled` flag so it resolves exactly once. oxlint's static
// check can't see that guard and flags each settle() caller, so disable the
// rule for this file.
/* oxlint-disable promise/no-multiple-resolved */

/** Keep only the tail of stderr — it's used solely for final error reporting. */
const STDERR_TAIL_MAX = 16_000;

/** Human-friendly duration for watchdog messages ("45m", "3s"). */
const fmtMs = (ms: number): string =>
  ms >= 60_000 ? `${Math.round(ms / 60_000)}m` : `${Math.round(ms / 1000)}s`;

/**
 * Invoke a headless Codex session (`codex exec --json`) with the same contract
 * as runClaude: one fresh session per phase, Activity events streamed as they
 * happen, watchdogs so a wedged session can never hang the loop. Codex has no
 * separate system-prompt channel, so the role prompt is prepended to the task;
 * it reports token usage but not dollar cost, so costUsd stays undefined.
 */
export function runCodex(opts: RunOptions): Promise<RunResult> {
  const args = ["exec", "--json", "--skip-git-repo-check", "--model", opts.model];
  if (opts.skipPermissions) args.push("--dangerously-bypass-approvals-and-sandbox");
  else args.push("--sandbox", "workspace-write");
  for (const dir of opts.addDirs ?? []) args.push("--add-dir", dir);
  args.push(`${opts.systemPrompt}\n\n---\n\nYOUR TASK:\n\n${opts.prompt}`);

  return new Promise((resolvePromise) => {
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

    // Watchdog: no output at all for idleTimeoutMs means the process is wedged
    // (or a tool is stuck) — kill it and fail so the phase loop and workspace
    // lock can never block forever. Reset on every event.
    const pokeIdle = (): void => {
      if (opts.idleTimeoutMs <= 0 || settled) return;
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        try {
          child?.kill("SIGKILL");
        } catch {
          /* already gone */
        }
        settle({
          ok: false,
          result: "",
          error: `no output for ${fmtMs(opts.idleTimeoutMs)} — treating codex as hung`,
        });
      }, opts.idleTimeoutMs);
      idleTimer.unref?.();
    };

    const settle = (res: RunResult): void => {
      if (settled) return;
      settled = true;
      if (idleTimer) clearTimeout(idleTimer);
      if (sessionTimer) clearTimeout(sessionTimer);
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
      resolvePromise(res);
    };

    try {
      child = spawn(opts.bin, args, {
        cwd: opts.cwd,
        env: { ...process.env },
        stdio: ["ignore", "pipe", "pipe"],
        signal: opts.signal,
      });
    } catch (err) {
      settle({
        ok: false,
        result: "",
        error: `failed to spawn ${opts.bin}: ${err instanceof Error ? err.message : String(err)}`,
      });
      return;
    }

    pokeIdle(); // arm the inactivity watchdog before the first byte arrives

    // Absolute ceiling: fires even while the session is actively streaming.
    if (opts.maxSessionMs > 0) {
      sessionTimer = setTimeout(() => {
        try {
          child?.kill("SIGKILL");
        } catch {
          /* already gone */
        }
        settle({
          ok: false,
          result: "",
          error: `exceeded the ${fmtMs(opts.maxSessionMs)} session limit — killed`,
        });
      }, opts.maxSessionMs);
      sessionTimer.unref?.();
    }

    rl = createInterface({ input: child.stdout! });
    rl.on("line", (line) => {
      pokeIdle(); // any output is a sign of life
      const trimmed = line.trim();
      if (!trimmed) return;
      let evt: CodexEvent;
      try {
        evt = JSON.parse(trimmed) as CodexEvent;
      } catch {
        return; // ignore non-JSON noise
      }
      switch (evt.type) {
        case "thread.started":
          sessionId = evt.thread_id;
          opts.onActivity({ kind: "init", model: opts.model });
          return;
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
        case "turn.completed":
          turnCompleted = true;
          return;
        case "turn.failed":
          failure = evt.error?.message ?? "codex turn failed";
          return;
        case "error":
          failure = evt.message ?? failure;
          return;
        default:
          return;
      }
    });

    child.stderr!.on("data", (d: Buffer) => {
      pokeIdle(); // stderr output is also a sign of life
      stderr = (stderr + d.toString()).slice(-STDERR_TAIL_MAX); // bounded tail
    });

    child.on("error", (err: Error) => {
      settle({ ok: false, result: "", error: `${opts.bin}: ${err.message}` });
    });

    child.on("close", (code) => {
      // Success requires a completed turn AND a clean exit — a bare exit 0
      // with no turn.completed means no confirmed outcome, so treat as failure
      // rather than silently advancing the phase.
      if (failure || code !== 0 || !turnCompleted) {
        settle({
          ok: false,
          result: lastMessage,
          sessionId,
          error: failure ?? stderr.trim() ?? `codex exited with code ${code}`,
        });
        return;
      }
      settle({ ok: true, result: lastMessage, sessionId });
    });
  });
}

type CodexItem = {
  type?: string;
  text?: string;
  message?: string;
  command?: string;
  status?: string;
  tool?: string;
  server?: string;
  query?: string;
  changes?: { path?: string }[];
};

type CodexEvent =
  | { type: "thread.started"; thread_id?: string }
  | { type: "turn.started" }
  | { type: "turn.completed"; usage?: Record<string, number> }
  | { type: "turn.failed"; error?: { message?: string } }
  | { type: "error"; message?: string }
  | { type: "item.started" | "item.completed"; item?: CodexItem };

const oneLine = (s: string, max = 80): string => {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
};

/** Map a codex thread item onto the reporter's Activity view. Tool-ish items
 * are reported once when they start; messages once when they complete. */
function itemActivity(item: CodexItem | undefined, started: boolean): Activity | null {
  if (!item?.type) return null;
  switch (item.type) {
    case "agent_message":
      return !started && item.text?.trim() ? { kind: "text", text: item.text.trim() } : null;
    case "command_execution":
      return started && item.command
        ? { kind: "tool", name: "shell", detail: oneLine(item.command) }
        : null;
    case "file_change": {
      if (started) return null;
      const paths = (item.changes ?? [])
        .map((c) => c.path)
        .filter((p): p is string => Boolean(p))
        .join(", ");
      return { kind: "tool", name: "edit", detail: paths ? oneLine(paths) : undefined };
    }
    case "mcp_tool_call":
      return started
        ? {
            kind: "tool",
            name: [item.server, item.tool].filter(Boolean).join(".") || "mcp",
            detail: undefined,
          }
        : null;
    case "web_search":
      return started
        ? { kind: "tool", name: "web_search", detail: item.query ? oneLine(item.query) : undefined }
        : null;
    case "error":
      // Codex surfaces non-fatal warnings as error items (skills budget etc.).
      return !started && item.message
        ? { kind: "text", text: `⚠ ${oneLine(item.message, 160)}` }
        : null;
    default:
      return null;
  }
}
