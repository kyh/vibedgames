import { appendFileSync } from "node:fs";

import type { Blackboard } from "./state.ts";

/**
 * One span per subagent turn — the agent's observability trail. Each turn
 * appends a single JSON line to .agent/trace.jsonl capturing who ran, in what
 * phase, at what cost, and how it ended. Append-only and machine-readable so a
 * run can be replayed, audited, or monitored after the fact.
 */
export type Span = {
  /** ISO timestamp the turn finished. */
  ts: string;
  /** Monotonic turn index (the agent's cycle count). */
  turn: number;
  role: string;
  phase: string;
  cycle: number;
  iteration: number;
  model: string;
  ok: boolean;
  durationMs: number;
  costUsd?: number;
  numTurns?: number;
  /** One-line outcome (result summary on success, error on failure). */
  detail?: string;
};

/** Append a single turn's span to the trace. Best-effort — never throws. */
export function appendSpan(bb: Blackboard, span: Span): void {
  try {
    appendFileSync(bb.trace, `${JSON.stringify(span)}\n`);
  } catch {
    /* observability is best-effort; a failed write must not stall the loop */
  }
}
