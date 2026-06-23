import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * The studio advances a single game through a fixed phase machine. The first
 * pass (spec → scaffold → assets → build → playtest → ship) takes a one-line
 * idea to a deployed game. After the first ship it enters the forever loop
 * (plan → work → playtest → ship → plan …), polishing the same game until the
 * operator stops it.
 */
export type Phase =
  | "spec"
  | "scaffold"
  | "assets"
  | "build"
  | "playtest"
  | "ship"
  | "plan"
  | "work";

export type StudioState = {
  slug: string;
  idea: string;
  model: string;
  phase: Phase;
  /** Total specialist invocations so far. */
  cycle: number;
  /** Completed polish iterations (post first ship). */
  iteration: number;
  shipped: boolean;
  deployUrl: string | null;
  totalCostUsd: number;
  createdAt: string;
  updatedAt: string;
};

/** Resolved paths for the per-game blackboard the specialists coordinate through. */
export type Blackboard = {
  root: string;
  dir: string;
  state: string;
  spec: string;
  backlog: string;
  next: string;
  playtest: string;
  journal: string;
  stop: string;
};

export function blackboard(workspace: string): Blackboard {
  const dir = resolve(workspace, ".studio");
  return {
    root: workspace,
    dir,
    state: resolve(dir, "state.json"),
    spec: resolve(dir, "spec.md"),
    backlog: resolve(dir, "backlog.json"),
    next: resolve(dir, "next.json"),
    playtest: resolve(dir, "playtest.md"),
    journal: resolve(dir, "journal.md"),
    stop: resolve(dir, "STOP"),
  };
}

export function initWorkspace(bb: Blackboard, seed: StudioState): StudioState {
  mkdirSync(bb.dir, { recursive: true });
  if (existsSync(bb.state)) {
    const existing = loadState(bb);
    // Preserve progress across restarts; refresh the idea/model if re-seeded.
    return existing;
  }
  if (!existsSync(bb.backlog)) writeFileSync(bb.backlog, "[]\n");
  if (!existsSync(bb.journal)) {
    writeFileSync(bb.journal, `# ${seed.slug} — studio journal\n\nSeed idea: ${seed.idea}\n`);
  }
  saveState(bb, seed);
  return seed;
}

export function loadState(bb: Blackboard): StudioState {
  return JSON.parse(readFileSync(bb.state, "utf8")) as StudioState;
}

export function saveState(bb: Blackboard, state: StudioState): void {
  state.updatedAt = new Date().toISOString();
  writeFileSync(bb.state, `${JSON.stringify(state, null, 2)}\n`);
}

export function appendJournal(bb: Blackboard, line: string): void {
  const stamp = new Date().toISOString();
  const body = existsSync(bb.journal) ? readFileSync(bb.journal, "utf8") : "";
  writeFileSync(bb.journal, `${body.replace(/\s*$/, "")}\n\n- [${stamp}] ${line}\n`);
}

export function stopRequested(bb: Blackboard): boolean {
  return existsSync(bb.stop);
}
