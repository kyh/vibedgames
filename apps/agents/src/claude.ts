import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

import consola from "consola";

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
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(opts.claudeBin, args, {
        cwd: opts.cwd,
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
        signal: opts.signal,
      });
    } catch (err) {
      resolvePromise({
        ok: false,
        result: "",
        error: `failed to spawn ${opts.claudeBin}: ${err instanceof Error ? err.message : String(err)}`,
      });
      return;
    }

    let final: RunResult = { ok: false, result: "" };
    let gotResult = false;
    let stderr = "";

    const rl = createInterface({ input: child.stdout! });
    rl.on("line", (line) => {
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
        final = {
          ok: evt.subtype === "success" && !evt.is_error,
          result: typeof evt.result === "string" ? evt.result : "",
          sessionId: evt.session_id,
          costUsd: evt.total_cost_usd,
          numTurns: evt.num_turns,
          error: evt.is_error ? (evt.result ?? "agent reported an error") : undefined,
        };
      }
    });

    child.stderr!.on("data", (d: Buffer) => {
      stderr += d.toString();
    });

    child.on("error", (err: Error) => {
      resolvePromise({ ok: false, result: "", error: `${opts.claudeBin}: ${err.message}` });
    });

    child.on("close", (code) => {
      // Success is defined solely by a parsed stream-json `result` event — a
      // bare exit 0 with no result means we have no confirmed outcome, so we
      // treat it as a failure rather than silently advancing the phase.
      if (gotResult) {
        resolvePromise(final);
        return;
      }
      resolvePromise({
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
