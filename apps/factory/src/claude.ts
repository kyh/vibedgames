import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

import { asJsonObject, asString, asNumber, isJsonString, parseJson } from "./json.ts";
import type { JsonObject, JsonValue } from "./json.ts";
import type { Activity } from "./reporter.ts";
import type { RunOptions, RunResult } from "./runner.ts";

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

const clip = (s: string, n: number): string => {
  const flat = s.replaceAll(/\s+/gu, " ").trim();
  return flat.length > n ? `${flat.slice(0, n)}…` : flat;
};
/**
 * Compose the most informative failure message available. The subtype names
 * the failure class (error_max_turns, error_during_execution, …); an empty
 * `result` — the old "agent reported an error" — gets fleshed out with the
 * session's last words and the stderr tail, which is where API errors
 * (context overflow, rate limits) actually surface.
 */
const describeError = (
  evt: Extract<StreamEvent, { type: "result" }>,
  lastText: string,
  stderr: string,
): string => {
  const parts: string[] = [];
  if (evt.result?.trim()) {
    parts.push(evt.result.trim());
  } else if (evt.subtype && evt.subtype !== "success") {
    parts.push(`agent error (${evt.subtype})`);
  } else {
    parts.push("agent reported an error");
  }
  if (lastText) {
    parts.push(`last agent message: "${clip(lastText, 400)}"`);
  }
  const err = stderr.trim();
  if (err) {
    parts.push(`stderr: ${clip(err, 400)}`);
  }
  return parts.join(" — ");
};
const parseMessage = (value: JsonValue | undefined): { content: ContentBlock[] } | undefined => {
  const message = asJsonObject(value);
  if (!message) {
    return undefined;
  }
  const content = Array.isArray(message.content) ? message.content : [];
  return {
    content: content.flatMap((block): ContentBlock[] => {
      const b = asJsonObject(block);
      if (!b) {
        return [];
      }
      if (b.type === "text") {
        return [{ text: asString(b.text), type: "text" }];
      }
      if (b.type === "tool_use") {
        return [{ input: asJsonObject(b.input), name: asString(b.name), type: "tool_use" }];
      }
      return [];
    }),
  };
};
/**
 * Decode one stream-json line into a typed event at the process boundary —
 * the CLI's output is untrusted bytes until each used field is validated.
 * Null for non-JSON noise and event types this view doesn't consume.
 */
const parseStreamEvent = (text: string): StreamEvent | null => {
  const evt = asJsonObject(parseJson(text));
  if (!evt) {
    return null;
  }
  switch (evt.type) {
    case "system": {
      return {
        model: asString(evt.model),
        session_id: asString(evt.session_id),
        subtype: asString(evt.subtype),
        tools: Array.isArray(evt.tools) ? evt.tools.filter(isJsonString) : undefined,
        type: "system",
      };
    }
    case "assistant":
    case "user": {
      return { message: parseMessage(evt.message), type: evt.type };
    }
    case "result": {
      return {
        is_error: evt.is_error === true,
        num_turns: asNumber(evt.num_turns),
        result: asString(evt.result),
        session_id: asString(evt.session_id),
        subtype: asString(evt.subtype),
        total_cost_usd: asNumber(evt.total_cost_usd),
        type: "result",
      };
    }
    default: {
      return null;
    }
  }
};
const summarizeTool = (input?: JsonObject): string => {
  if (!input) {
    return "";
  }
  const cmd = input.command ?? input.file_path ?? input.path ?? input.pattern ?? input.prompt;
  if (!isJsonString(cmd)) {
    return "";
  }
  const oneLine = cmd.replaceAll(/\s+/gu, " ").trim();
  return oneLine.length > 80 ? `${oneLine.slice(0, 80)}…` : oneLine;
};
/** Decode a stream-json event into the Activity view the reporter renders. */
const emitActivity = (onActivity: (activity: Activity) => void, evt: StreamEvent): void => {
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
          detail: summarizeTool(block.input) || undefined,
          kind: "tool",
          name: block.name ?? "tool",
        });
      }
    }
  }
};
/**
 * Invoke a headless Claude Code session and stream a compact view of what it
 * does. Uses `--output-format stream-json` so the operator can watch the agent
 * work in real time; the terminal `result` event carries the final summary,
 * cost and session id.
 */
export const runClaude = (opts: RunOptions): Promise<RunResult> => {
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
  if (opts.skipPermissions) {
    args.push("--dangerously-skip-permissions");
  }
  if (opts.resumeSessionId) {
    args.push("--resume", opts.resumeSessionId);
  }
  for (const dir of opts.addDirs ?? []) {
    args.push("--add-dir", dir);
  }

  // oxlint-disable-next-line promise/avoid-new -- child_process.spawn is event-based
  return new Promise((resolve) => {
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

    // Resolve exactly once and release every handle we hold. Tearing down the
    // pipes/child matters because a killed child's orphaned grandchild can keep
    // the stdout pipe (and thus the event loop) alive after we already have our
    // answer — without this, the loop could never exit cleanly.
    const settle = (res: RunResult): void => {
      if (settled) {
        return;
      }
      settled = true;
      if (graceTimer) {
        clearTimeout(graceTimer);
      }
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

    // Watchdog: if the session produces no output at all for idleTimeoutMs, the
    // process is wedged (or a tool is stuck) — kill it and fail so the phase
    // loop and workspace lock can never block forever. Reset on every event, so
    // it never trips during active work (long-but-busy runs keep emitting).
    const pokeIdle = (): void => {
      if (opts.idleTimeoutMs <= 0 || settled || gotResult) {
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
          error: `no output for ${fmtMs(opts.idleTimeoutMs)} — treating claude as hung`,
          ok: false,
          result: "",
          sessionId,
        });
      }, opts.idleTimeoutMs);
      idleTimer.unref?.();
    };

    // `claude --dangerously-skip-permissions` refuses to run as root/sudo
    // unless IS_SANDBOX=1 marks the environment as already-isolated. The studio
    // is built for exactly this — unattended runs in containers/CI, often as
    // root — and the operator has already opted into skip-permissions, so set
    // the flag for the child when we're root and asking for it. claude only
    // accepts the literal "1" (a stray IS_SANDBOX=yes in the env still gets
    // rejected), so force that value rather than preserving whatever's there.
    const env: NodeJS.ProcessEnv = { ...process.env };
    const isRoot = process.getuid?.() === 0;
    if (opts.skipPermissions && isRoot && env.IS_SANDBOX !== "1") {
      env.IS_SANDBOX = "1";
    }

    try {
      child = spawn(opts.bin, args, {
        cwd: opts.cwd,
        env,
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
          error: `exceeded the ${fmtMs(opts.maxSessionMs)} session limit — killed`,
          ok: false,
          result: "",
          sessionId,
        });
      }, opts.maxSessionMs);
      sessionTimer.unref?.();
    }

    // A terminal `result` event: the grace timer governs from here, so stand
    // down the watchdogs — a late idle/session deadline must not clobber a
    // result we already have.
    const onResult = (evt: ResultEvent): void => {
      gotResult = true;
      if (idleTimer) {
        clearTimeout(idleTimer);
      }
      if (sessionTimer) {
        clearTimeout(sessionTimer);
      }
      final = {
        costUsd: evt.total_cost_usd,
        error: evt.is_error ? describeError(evt, lastText, stderr) : undefined,
        numTurns: evt.num_turns,
        ok: evt.subtype === "success" && !evt.is_error,
        result: evt.result ?? "",
        sessionId: evt.session_id ?? sessionId,
      };
      // Prefer a clean exit (the `close` handler), but don't wait forever.
      if (graceTimer) {
        return;
      }
      graceTimer = setTimeout(() => {
        try {
          child?.kill("SIGKILL");
        } catch {
          /* already gone */
        }
        settle(final);
      }, RESULT_EXIT_GRACE_MS);
      graceTimer.unref?.();
    };

    if (child.stdout) {
      rl = createInterface({ input: child.stdout });
    }
    if (!rl) {
      settle({ error: "claude produced no stdout pipe", ok: false, result: "", sessionId });
      return;
    }
    rl.on("line", (line) => {
      // any output is a sign of life
      pokeIdle();
      const trimmed = line.trim();
      if (!trimmed) {
        return;
      }
      const evt = parseStreamEvent(trimmed);
      if (evt === null) {
        return;
        // ignore non-JSON noise and unknown event types
      }
      emitActivity(opts.onActivity, evt);
      if (evt.type === "system" && evt.subtype === "init" && evt.session_id) {
        sessionId = evt.session_id;
      }
      if (evt.type === "assistant") {
        for (const block of evt.message?.content ?? []) {
          if (block.type === "text" && block.text?.trim()) {
            lastText = block.text.trim();
          }
        }
      }
      if (evt.type === "result") {
        onResult(evt);
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
      // Success is defined solely by a parsed stream-json `result` event — a
      // bare exit 0 with no result means we have no confirmed outcome, so we
      // treat it as a failure rather than silently advancing the phase.
      if (gotResult) {
        settle(final);
        return;
      }
      settle({
        error: stderr.trim() || `claude exited with code ${code} without a result event`,
        ok: false,
        result: "",
        sessionId,
      });
    });
  });
};

interface ResultEvent {
  type: "result";
  subtype?: string;
  is_error?: boolean;
  result?: string;
  session_id?: string;
  total_cost_usd?: number;
  num_turns?: number;
}

type StreamEvent =
  | { type: "system"; subtype?: string; model?: string; tools?: string[]; session_id?: string }
  | { type: "assistant"; message?: { content: ContentBlock[] } }
  | { type: "user"; message?: { content: ContentBlock[] } }
  | ResultEvent;

// tool_result blocks carry nothing this view renders, so decoding drops them.
type ContentBlock =
  | { type: "text"; text?: string }
  | { type: "tool_use"; name?: string; input?: JsonObject };
