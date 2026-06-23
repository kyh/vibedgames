import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  lock: string;
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
    lock: resolve(dir, "studio.lock"),
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

/** Remove a stale STOP sentinel. Only safe to call while holding the lock. */
export function clearStop(bb: Blackboard): void {
  try {
    if (existsSync(bb.stop)) rmSync(bb.stop);
  } catch {
    /* ignore */
  }
}

/** The pid currently owning the workspace lock, or null if free/stale. */
function lockOwner(bb: Blackboard): number | null {
  try {
    const { pid } = JSON.parse(readFileSync(bb.lock, "utf8")) as { pid?: number };
    if (typeof pid !== "number" || !Number.isFinite(pid)) return null;
    try {
      process.kill(pid, 0); // probe liveness without signalling
      return pid;
    } catch (err) {
      // EPERM => process exists but isn't ours; ESRCH => gone (stale lock).
      return (err as NodeJS.ErrnoException).code === "EPERM" ? pid : null;
    }
  } catch {
    return null;
  }
}

/**
 * Take the per-workspace lock so only one studio runs per game. Returns the
 * live owner pid if another process already holds it; otherwise claims the lock
 * (taking over a stale one) and returns null.
 */
export function acquireLock(bb: Blackboard): number | null {
  const owner = lockOwner(bb);
  if (owner !== null && owner !== process.pid) return owner;
  mkdirSync(bb.dir, { recursive: true });
  writeFileSync(bb.lock, `${JSON.stringify({ pid: process.pid, at: new Date().toISOString() })}\n`);
  return null;
}

/** Release the lock if (and only if) we own it. */
export function releaseLock(bb: Blackboard): void {
  try {
    const { pid } = JSON.parse(readFileSync(bb.lock, "utf8")) as { pid?: number };
    if (pid === process.pid) rmSync(bb.lock);
  } catch {
    /* ignore */
  }
}
