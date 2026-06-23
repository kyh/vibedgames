import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

import consola from "consola";

// Every resolution path funnels through the `settle()` helper below, which is
// guarded by a `settled` flag so it resolves exactly once. oxlint's static
// check can't see that guard and flags each settle() caller, so disable the
// rule for this file.
/* oxlint-disable promise/no-multiple-resolved */

/**
 * After the stream-json `result` event arrives we already have the outcome.
 * Normally the CLI exits right after, but stream-json has a known failure mode
 * where it keeps the process alive — so if `close` doesn't fire within this
 * grace window we kill the child and resolve with the result we have, rather
 * than blocking the loop (and holding the workspace lock) forever.
 */
const RESULT_EXIT_GRACE_MS = 10_000;

/** Keep only the tail of stderr — it's used solely for final error reporting. */
const STDERR_TAIL_MAX = 16_000;

/** Human-friendly duration for watchdog messages ("45m", "3s"). */
const fmtMs = (ms: number): string =>
  ms >= 60_000 ? `${Math.round(ms / 60_000)}m` : `${Math.round(ms / 1000)}s`;

export type RunOptions = {
  /** The task prompt (the "user" turn). */
  prompt: string;
  /** Role definition, appended to Claude Code's system prompt. */
  systemPrompt: string;
  /** Working directory — the game workspace. */
  cwd: string;
  model: string;
  maxTurns: number;
  claudeBin: string;
  /** Extra dirs the agent may read (e.g. the repo root for skills). */
  addDirs?: string[];
  /** Run tools without per-call approval. Required for unattended autonomy. */
  skipPermissions: boolean;
  /** Aborts the underlying process (second Ctrl-C). */
  signal?: AbortSignal;
  /** Label shown in streamed output, e.g. "engineer". */
  label: string;
  /**
   * Kill the session and fail if it produces NO output (no stream-json events,
   * no stderr) for this long — a watchdog for a wedged `claude`/stuck tool.
   * Reset on every event, so it never fires during active work. 0 disables it.
   */
  idleTimeoutMs: number;
  /**
   * Absolute ceiling on a single session, regardless of activity (ms; 0
   * disables). Catches a session that keeps streaming events but never emits a
   * terminal `result` — which the idle watchdog can't, since output keeps
   * resetting it.
   */
  maxSessionMs: number;
};

export type RunResult = {
  ok: boolean;
  result: string;
  sessionId?: string;
  costUsd?: number;
  numTurns?: number;
  error?: string;
};

/**
 * Invoke a headless Claude Code session and stream a compact view of what it
 * does. Uses `--output-format stream-json` so the operator can watch the agent
 * work in real time; the terminal `result` event carries the final summary,
 * cost and session id.
 */
export function runClaude(opts: RunOptions): Promise<RunResult> {
  const args = [
    "-p",
    opts.prompt,
    "--output-format",
    "stream-json",
    "--verbose",
    "--model",
    opts.model,
    "--append-system-prompt",
    opts.systemPrompt,
    "--max-turns",
    String(opts.maxTurns),
  ];
  if (opts.skipPermissions) args.push("--dangerously-skip-permissions");
  for (const dir of opts.addDirs ?? []) args.push("--add-dir", dir);

  return new Promise((resolvePromise) => {
    let child: ReturnType<typeof spawn> | undefined;
    let rl: ReturnType<typeof createInterface> | undefined;
    let final: RunResult = { ok: false, result: "" };
    let gotResult = false;
    let stderr = "";
    let settled = false;
    let graceTimer: ReturnType<typeof setTimeout> | undefined;
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    let sessionTimer: ReturnType<typeof setTimeout> | undefined;

    // Watchdog: if the session produces no output at all for idleTimeoutMs, the
    // process is wedged (or a tool is stuck) — kill it and fail so the phase
    // loop and workspace lock can never block forever. Reset on every event, so
    // it never trips during active work (long-but-busy runs keep emitting).
    const pokeIdle = (): void => {
      if (opts.idleTimeoutMs <= 0 || settled || gotResult) return;
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
          error: `no output for ${fmtMs(opts.idleTimeoutMs)} — treating claude as hung`,
        });
      }, opts.idleTimeoutMs);
      idleTimer.unref?.();
    };

    // Resolve exactly once and release every handle we hold. Tearing down the
    // pipes/child matters because a killed child's orphaned grandchild can keep
    // the stdout pipe (and thus the event loop) alive after we already have our
    // answer — without this, the loop could never exit cleanly.
    const settle = (res: RunResult): void => {
      if (settled) return;
      settled = true;
      if (graceTimer) clearTimeout(graceTimer);
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
      child = spawn(opts.claudeBin, args, {
        cwd: opts.cwd,
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
        signal: opts.signal,
      });
    } catch (err) {
      settle({
        ok: false,
        result: "",
        error: `failed to spawn ${opts.claudeBin}: ${err instanceof Error ? err.message : String(err)}`,
      });
      return;
    }

    pokeIdle(); // arm the inactivity watchdog before the first byte arrives

    // Absolute ceiling: fires even while the session is actively streaming, so a
    // run that never emits a terminal `result` can't hang the loop forever.
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
      let evt: StreamEvent;
      try {
        evt = JSON.parse(trimmed) as StreamEvent;
      } catch {
        return; // ignore non-JSON noise
      }
      printEvent(opts.label, evt);
      if (evt.type === "result") {
        gotResult = true;
        // The grace timer governs from here; stand down the watchdogs so a late
        // idle/session deadline can't clobber a result we already have.
        if (idleTimer) clearTimeout(idleTimer);
        if (sessionTimer) clearTimeout(sessionTimer);
        final = {
          ok: evt.subtype === "success" && !evt.is_error,
          result: typeof evt.result === "string" ? evt.result : "",
          sessionId: evt.session_id,
          costUsd: evt.total_cost_usd,
          numTurns: evt.num_turns,
          error: evt.is_error ? (evt.result ?? "agent reported an error") : undefined,
        };
        // Prefer a clean exit (the `close` handler), but don't wait forever.
        if (!graceTimer) {
          graceTimer = setTimeout(() => {
            try {
              child?.kill("SIGKILL");
            } catch {
              /* already gone */
            }
            settle(final);
          }, RESULT_EXIT_GRACE_MS);
          graceTimer.unref?.();
        }
      }
    });

    child.stderr!.on("data", (d: Buffer) => {
      pokeIdle(); // stderr output is also a sign of life
      stderr = (stderr + d.toString()).slice(-STDERR_TAIL_MAX); // bounded tail
    });

    child.on("error", (err: Error) => {
      settle({ ok: false, result: "", error: `${opts.claudeBin}: ${err.message}` });
    });

    child.on("close", (code) => {
      // Success is defined solely by a parsed stream-json `result` event — a
      // bare exit 0 with no result means we have no confirmed outcome, so we
      // treat it as a failure rather than silently advancing the phase.
      if (gotResult) {
        settle(final);
        return;
      }
      settle({
        ok: false,
        result: "",
        error: stderr.trim() || `claude exited with code ${code} without a result event`,
      });
    });
  });
}

type StreamEvent =
  | { type: "system"; subtype?: string; model?: string; tools?: string[] }
  | { type: "assistant"; message?: { content?: ContentBlock[] } }
  | { type: "user"; message?: { content?: ContentBlock[] } }
  | {
      type: "result";
      subtype?: string;
      is_error?: boolean;
      result?: string;
      session_id?: string;
      total_cost_usd?: number;
      num_turns?: number;
    };

type ContentBlock =
  | { type: "text"; text?: string }
  | { type: "tool_use"; name?: string; input?: Record<string, unknown> }
  | { type: "tool_result"; [k: string]: unknown };

function printEvent(label: string, evt: StreamEvent): void {
  const tag = `  ${label} ·`;
  if (evt.type === "system" && evt.subtype === "init") {
    consola.log(
      `${tag} session started (${evt.model ?? "model"}, ${evt.tools?.length ?? 0} tools)`,
    );
    return;
  }
  if (evt.type === "assistant") {
    for (const block of evt.message?.content ?? []) {
      if (block.type === "text" && block.text?.trim()) {
        for (const ln of block.text.trim().split("\n")) consola.log(`${tag} ${ln}`);
      } else if (block.type === "tool_use") {
        consola.log(`${tag} ⚙ ${block.name ?? "tool"}${summarizeTool(block.input)}`);
      }
    }
  }
}

function summarizeTool(input?: Record<string, unknown>): string {
  if (!input) return "";
  const cmd = input.command ?? input.file_path ?? input.path ?? input.pattern ?? input.prompt;
  if (typeof cmd !== "string") return "";
  const oneLine = cmd.replace(/\s+/g, " ").trim();
  return oneLine ? `  (${oneLine.slice(0, 80)}${oneLine.length > 80 ? "…" : ""})` : "";
}
