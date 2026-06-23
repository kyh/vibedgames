import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * The studio advances a single game through a fixed phase machine. The first
 * pass (spec → scaffold → assets → build → playtest → ship) takes a one-line
 * idea to a deployed game. After the first ship it enters the forever loop
 * (plan → work → playtest → ship → plan …), evolving the same game like a
 * studio — bugs, features, gameplay/balance, content, polish — until the
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
  /** Completed studio iterations shipped (post first ship). */
  iteration: number;
  /**
   * Consecutive failures on the CURRENT phase. Persisted so a stop/restart
   * doesn't reset the retry budget — a phase that keeps failing still reaches
   * the skip-ahead threshold and advances instead of getting stuck forever.
   */
  phaseFailures: number;
  /** True when the studio is building ON an existing project in the game dir. */
  existingProject: boolean;
  /** Absolute path of a --context reference directory, persisted across resumes. */
  contextDir: string | null;
  /** True once the first playable build exists — gates deploy preemption. */
  built: boolean;
  /**
   * Token of the last deploy approval that was acted on. Approval is "pending"
   * only when the APPROVE sentinel's token differs from this — so consumption
   * is authoritative in persisted state and a failed file delete can't let one
   * approval trigger a second deploy.
   */
  lastApproval: string | null;
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
  context: string;
  stop: string;
  approve: string;
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
    context: resolve(dir, "context.md"),
    stop: resolve(dir, "STOP"),
    approve: resolve(dir, "APPROVE"),
    lock: resolve(dir, "studio.lock"),
  };
}

/**
 * Does the game directory already hold a project to build upon? True when it
 * contains anything other than the studio's own bookkeeping — so pointing the
 * studio at an existing app adopts it instead of scaffolding fresh.
 */
export function hasExistingProject(dir: string): boolean {
  try {
    if (!existsSync(dir)) return false;
    const ignore = new Set([".studio", ".git", ".DS_Store"]);
    return readdirSync(dir).some((entry) => !ignore.has(entry));
  } catch {
    return false;
  }
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

/** The current approval token (APPROVE file contents), or null if none. */
export function approvalToken(bb: Blackboard): string | null {
  try {
    const token = readFileSync(bb.approve, "utf8").trim();
    return token || null;
  } catch {
    return null;
  }
}

/**
 * Is there an unacted-on deploy approval? Pending only when the sentinel's
 * token differs from the last one we consumed (tracked in persisted state), so
 * a one-shot approval can't be re-used even if the file fails to delete.
 */
export function approvalPending(bb: Blackboard, lastApproval: string | null): boolean {
  const token = approvalToken(bb);
  return token !== null && token !== lastApproval;
}

/** Grant a one-shot deploy approval (written by `pnpm approve <slug>`). */
export function requestApproval(bb: Blackboard): void {
  mkdirSync(bb.dir, { recursive: true });
  // The nonce makes every approval a distinct token, so the orchestrator can
  // tell a fresh approval from one it already deployed.
  writeFileSync(bb.approve, `approved ${new Date().toISOString()} ${randomUUID()}\n`);
}

/** Best-effort removal of the approval sentinel after it's been acted on. */
export function consumeApproval(bb: Blackboard): void {
  try {
    if (existsSync(bb.approve)) rmSync(bb.approve);
  } catch {
    /* ignore — consumption is authoritative via state.lastApproval */
  }
}

type LockStatus =
  | { state: "free" } // no lock file
  | { state: "alive"; pid: number } // a live owner (possibly another user's process)
  | { state: "stale" } // dead owner, our own prior pid, or junk contents — reclaimable
  | { state: "unknown" }; // exists but couldn't be read (transient IO) — do NOT reclaim

/** Inspect the lock file without mutating it. */
function readLock(bb: Blackboard): LockStatus {
  let raw: string;
  try {
    raw = readFileSync(bb.lock, "utf8");
  } catch (err) {
    // Gone => free to take. Any other read error (e.g. transient EACCES) is
    // ambiguous; treat as held so we never delete a possibly-live lock.
    return (err as NodeJS.ErrnoException).code === "ENOENT"
      ? { state: "free" }
      : { state: "unknown" };
  }
  let pid: number | undefined;
  try {
    pid = (JSON.parse(raw) as { pid?: number }).pid;
  } catch {
    return { state: "stale" }; // corrupt contents — safe to reclaim
  }
  if (typeof pid !== "number" || !Number.isFinite(pid)) return { state: "stale" };
  if (pid === process.pid) return { state: "stale" }; // our own lock from a prior run
  try {
    process.kill(pid, 0); // probe liveness without signalling
    return { state: "alive", pid };
  } catch (err) {
    // EPERM => the process exists but isn't ours (alive); ESRCH => gone (stale).
    return (err as NodeJS.ErrnoException).code === "EPERM"
      ? { state: "alive", pid }
      : { state: "stale" };
  }
}

/** Sentinel pid for "lock is held but we couldn't read whose it is". */
export const LOCK_BUSY_UNKNOWN = -1;

/**
 * Take the per-workspace lock so only one studio runs per game. Claims it via
 * an atomic exclusive create (O_EXCL) so two simultaneous `start`s can't both
 * see an empty slot and proceed. Returns null on success; otherwise the live
 * owner pid (or LOCK_BUSY_UNKNOWN). Only a genuinely stale lock is reclaimed —
 * an unreadable lock file is treated as held, never deleted.
 */
export function acquireLock(bb: Blackboard): number | null {
  mkdirSync(bb.dir, { recursive: true });
  const payload = `${JSON.stringify({ pid: process.pid, at: new Date().toISOString() })}\n`;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      // "wx" => fail if the file already exists; the create is atomic.
      writeFileSync(bb.lock, payload, { flag: "wx" });
      return null;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      const status = readLock(bb);
      if (status.state === "alive") return status.pid;
      if (status.state === "unknown") return LOCK_BUSY_UNKNOWN; // don't reclaim a lock we can't read
      // free (vanished between create and read) or stale — drop and retry once.
      try {
        rmSync(bb.lock);
      } catch {
        /* ignore */
      }
    }
  }
  const final = readLock(bb);
  return final.state === "alive" ? final.pid : LOCK_BUSY_UNKNOWN;
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
