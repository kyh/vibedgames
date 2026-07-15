import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

import type { Activity } from "./reporter.ts";
import type { RunOptions, RunResult } from "./runner.ts";

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
  if (opts.resumeSessionId) args.push("--resume", opts.resumeSessionId);
  for (const dir of opts.addDirs ?? []) args.push("--add-dir", dir);

  return new Promise((resolvePromise) => {
    let child: ReturnType<typeof spawn> | undefined;
    let rl: ReturnType<typeof createInterface> | undefined;
    let final: RunResult = { ok: false, result: "" };
    let gotResult = false;
    let stderr = "";
    let settled = false;
    // Captured from the init event so even a session killed by a watchdog (no
    // terminal `result`) reports its id — that's what makes --resume possible.
    let sessionId: string | undefined;
    // Tail of the last assistant text — the only clue to WHY a session died
    // when the error result carries no message.
    let lastText = "";
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
          sessionId,
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

    // `claude --dangerously-skip-permissions` refuses to run as root/sudo
    // unless IS_SANDBOX=1 marks the environment as already-isolated. The studio
    // is built for exactly this — unattended runs in containers/CI, often as
    // root — and the operator has already opted into skip-permissions, so set
    // the flag for the child when we're root and asking for it. claude only
    // accepts the literal "1" (a stray IS_SANDBOX=yes in the env still gets
    // rejected), so force that value rather than preserving whatever's there.
    const env: NodeJS.ProcessEnv = { ...process.env };
    const isRoot = typeof process.getuid === "function" && process.getuid() === 0;
    if (opts.skipPermissions && isRoot && env.IS_SANDBOX !== "1") {
      env.IS_SANDBOX = "1";
    }

    try {
      child = spawn(opts.bin, args, {
        cwd: opts.cwd,
        env,
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
          sessionId,
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
      emitActivity(opts.onActivity, evt);
      if (evt.type === "system" && evt.subtype === "init" && evt.session_id) {
        sessionId = evt.session_id;
      }
      if (evt.type === "assistant") {
        for (const block of evt.message?.content ?? []) {
          if (block.type === "text" && block.text?.trim()) lastText = block.text.trim();
        }
      }
      if (evt.type === "result") {
        gotResult = true;
        // The grace timer governs from here; stand down the watchdogs so a late
        // idle/session deadline can't clobber a result we already have.
        if (idleTimer) clearTimeout(idleTimer);
        if (sessionTimer) clearTimeout(sessionTimer);
        final = {
          ok: evt.subtype === "success" && !evt.is_error,
          result: typeof evt.result === "string" ? evt.result : "",
          sessionId: evt.session_id ?? sessionId,
          costUsd: evt.total_cost_usd,
          numTurns: evt.num_turns,
          error: evt.is_error ? describeError(evt, lastText, stderr) : undefined,
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
      settle({ ok: false, result: "", error: `${opts.bin}: ${err.message}` });
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
        sessionId,
        error: stderr.trim() || `claude exited with code ${code} without a result event`,
      });
    });
  });
}

/**
 * Compose the most informative failure message available. The subtype names
 * the failure class (error_max_turns, error_during_execution, …); an empty
 * `result` — the old "agent reported an error" — gets fleshed out with the
 * session's last words and the stderr tail, which is where API errors
 * (context overflow, rate limits) actually surface.
 */
function describeError(
  evt: Extract<StreamEvent, { type: "result" }>,
  lastText: string,
  stderr: string,
): string {
  const parts: string[] = [];
  if (typeof evt.result === "string" && evt.result.trim()) parts.push(evt.result.trim());
  else if (evt.subtype && evt.subtype !== "success") parts.push(`agent error (${evt.subtype})`);
  else parts.push("agent reported an error");
  if (lastText) parts.push(`last agent message: "${clip(lastText, 400)}"`);
  const err = stderr.trim();
  if (err) parts.push(`stderr: ${clip(err, 400)}`);
  return parts.join(" — ");
}

const clip = (s: string, n: number): string => {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > n ? `${flat.slice(0, n)}…` : flat;
};

type StreamEvent =
  | { type: "system"; subtype?: string; model?: string; tools?: string[]; session_id?: string }
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

/** Decode a stream-json event into the Activity view the reporter renders. */
function emitActivity(onActivity: (activity: Activity) => void, evt: StreamEvent): void {
  if (evt.type === "system" && evt.subtype === "init") {
    onActivity({ kind: "init", model: evt.model, tools: evt.tools?.length ?? 0 });
    return;
  }
  if (evt.type === "assistant") {
    for (const block of evt.message?.content ?? []) {
      if (block.type === "text" && block.text?.trim()) {
        onActivity({ kind: "text", text: block.text.trim() });
      } else if (block.type === "tool_use") {
        onActivity({
          kind: "tool",
          name: block.name ?? "tool",
          detail: summarizeTool(block.input) || undefined,
        });
      }
    }
  }
}

function summarizeTool(input?: Record<string, unknown>): string {
  if (!input) return "";
  const cmd = input.command ?? input.file_path ?? input.path ?? input.pattern ?? input.prompt;
  if (typeof cmd !== "string") return "";
  const oneLine = cmd.replace(/\s+/g, " ").trim();
  return oneLine.length > 80 ? `${oneLine.slice(0, 80)}…` : oneLine;
}
