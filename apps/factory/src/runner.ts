import type { Activity } from "./reporter.ts";

/**
 * Which coding-agent CLI executes a subagent turn. Both runners share one
 * contract: spawn a fresh headless session per phase (clean context is a
 * design feature of the factory's loop), stream a compact Activity view of
 * what it does, and resolve with a RunResult when the session ends.
 */
export type Runner = "claude" | "codex";

export const RUNNERS: readonly Runner[] = ["claude", "codex"];

export const isRunner = (v: string): v is Runner => (RUNNERS as readonly string[]).includes(v);

export type RunOptions = {
  /** The task prompt (the "user" turn). */
  prompt: string;
  /** Role definition. Claude appends it to the system prompt; codex has no
   * separate channel, so it's prepended to the prompt. */
  systemPrompt: string;
  /** Working directory — the game workspace. */
  cwd: string;
  model: string;
  /** Per-session agentic turn ceiling (claude only; codex has no such flag). */
  maxTurns: number;
  /** Path to the runner binary (claude or codex). */
  bin: string;
  /** Extra dirs the agent may access (e.g. the repo root for skills). */
  addDirs?: string[];
  /** Run tools without per-call approval. Required for unattended autonomy. */
  skipPermissions: boolean;
  /**
   * Resume a prior session instead of starting fresh (claude only; codex
   * ignores it). Used to continue a failed turn's session so work it already
   * did isn't re-derived from scratch.
   */
  resumeSessionId?: string;
  /** Aborts the underlying process (second Ctrl-C). */
  signal?: AbortSignal;
  /** Receives a compact view of what the session does, as it happens. */
  onActivity: (activity: Activity) => void;
  /**
   * Kill the session and fail if it produces NO output for this long — a
   * watchdog for a wedged process or stuck tool. Reset on every event, so it
   * never fires during active work. 0 disables it.
   */
  idleTimeoutMs: number;
  /**
   * Absolute ceiling on a single session, regardless of activity (ms; 0
   * disables). Catches a session that keeps streaming events but never
   * finishes — which the idle watchdog can't, since output keeps resetting it.
   */
  maxSessionMs: number;
};

export type RunResult = {
  ok: boolean;
  result: string;
  sessionId?: string;
  /** Reported by claude; codex doesn't expose spend, so it stays undefined. */
  costUsd?: number;
  numTurns?: number;
  error?: string;
};
