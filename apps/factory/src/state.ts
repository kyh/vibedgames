import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import { asJsonObject, asNumber } from "./json.ts";
import type { JsonValue } from "./json.ts";

/**
 * The agent advances a single game through a fixed phase machine — a durable,
 * checkpointed loop. The first pass (spec → scaffold → assets → build →
 * playtest → ship) takes a one-line idea to a deployed game. After the first
 * ship it enters the forever loop (plan → work → playtest → ship → plan …),
 * evolving the same game like a studio — bugs, features, gameplay/balance,
 * content, polish — until the operator stops it. Every turn is checkpointed to
 * disk, so the agent survives restarts and individual context windows.
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

export interface AgentState {
  slug: string;
  idea: string;
  model: string;
  /** Which coding-agent CLI runs the subagents ("claude" | "codex"). */
  runner: string;
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
   * Workspace HEAD at the last completed QA pass. When HEAD hasn't moved
   * since, the next playtest is told to skip re-running the committed
   * regression suite (already exercised at this exact code) and spend the turn
   * on fresh exploratory testing instead.
   */
  lastPlaytestHead: string | null;
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
}

/** Resolved paths for the per-game shared memory the subagents coordinate through. */
export interface Blackboard {
  root: string;
  dir: string;
  state: string;
  spec: string;
  backlog: string;
  next: string;
  playtest: string;
  journal: string;
  context: string;
  /** Standing operator directive, injected into every subagent task. */
  directive: string;
  /** Agent-authored "good stopping point" note; consumed by the orchestrator. */
  checkpoint: string;
  /** Per-turn observability: one span (JSON line) per subagent turn. */
  trace: string;
  stop: string;
  approve: string;
  lock: string;
}

export const blackboard = (workspace: string): Blackboard => {
  const dir = path.resolve(workspace, ".vgfactory");
  return {
    approve: path.resolve(dir, "APPROVE"),
    backlog: path.resolve(dir, "backlog.json"),
    checkpoint: path.resolve(dir, "checkpoint.md"),
    context: path.resolve(dir, "context.md"),
    dir,
    directive: path.resolve(dir, "directive.md"),
    journal: path.resolve(dir, "journal.md"),
    lock: path.resolve(dir, "agent.lock"),
    next: path.resolve(dir, "next.json"),
    playtest: path.resolve(dir, "playtest.md"),
    root: workspace,
    spec: path.resolve(dir, "spec.md"),
    state: path.resolve(dir, "state.json"),
    stop: path.resolve(dir, "STOP"),
    trace: path.resolve(dir, "trace.jsonl"),
  };
};

/**
 * Does the game directory already hold a project to build upon? True when it
 * contains anything other than the agent's own bookkeeping — so pointing the
 * factory at an existing app adopts it instead of scaffolding fresh.
 */
export const hasExistingProject = (dir: string): boolean => {
  try {
    if (!existsSync(dir)) {
      return false;
    }
    // `.agent`/`.studio` are pre-rename bookkeeping dirs — still ignored so a
    // leftover legacy folder isn't misread as real game code.
    const ignore = new Set([".vgfactory", ".agent", ".studio", ".git", ".DS_Store"]);
    return readdirSync(dir).some((entry) => !ignore.has(entry));
  } catch {
    return false;
  }
};

/**
 * Migrate a pre-rename workspace. The per-game dir was `.studio/`, then
 * `.agent/`; it is now `.vgfactory/` (specific to this tool — `.agent` was
 * generic enough to collide with other agent tooling). If a legacy dir exists
 * and the current `.vgfactory/` does not, move it across so a resume keeps its
 * checkpoint (state.json, backlog, approval sentinels) instead of restarting
 * at the spec phase. Newest legacy name wins. Best-effort and idempotent — a
 * failed migration just means a fresh start. Call it before the blackboard is
 * inspected (fresh/adopt detection, status/stop/approve lookups).
 */
export const migrateLegacyLayout = (workspace: string): void => {
  const current = path.resolve(workspace, ".vgfactory");
  try {
    if (existsSync(current)) {
      return;
    }
    for (const name of [".agent", ".studio"]) {
      const legacy = path.resolve(workspace, name);
      if (existsSync(legacy)) {
        renameSync(legacy, current);
        return;
      }
    }
  } catch {
    /* best-effort — leave the legacy dir in place and start fresh */
  }
};

export const loadState = (bb: Blackboard): AgentState =>
  // SAFETY: state.json is this tool's own checkpoint, written only by
  // saveState from a typed AgentState — a trusted same-process round-trip,
  // not external input (runAgent re-backfills fields older files predate).
  JSON.parse(readFileSync(bb.state, "utf-8")) as AgentState;

export const saveState = (bb: Blackboard, state: AgentState): void => {
  state.updatedAt = new Date().toISOString();
  writeFileSync(bb.state, `${JSON.stringify(state, null, 2)}\n`);
};

export const initWorkspace = (bb: Blackboard, seed: AgentState): AgentState => {
  mkdirSync(bb.dir, { recursive: true });
  if (existsSync(bb.state)) {
    const existing = loadState(bb);
    // Preserve progress across restarts; refresh the idea/model if re-seeded.
    return existing;
  }
  if (!existsSync(bb.backlog)) {
    writeFileSync(bb.backlog, "[]\n");
  }
  if (!existsSync(bb.journal)) {
    writeFileSync(bb.journal, `# ${seed.slug} — studio journal\n\nSeed idea: ${seed.idea}\n`);
  }
  saveState(bb, seed);
  return seed;
};

/** Past this size the journal gets compacted — every subagent reads it, so it
 * must never grow to context-blowing size over a long-running loop. */
const MAX_JOURNAL_BYTES = 32_000;
const JOURNAL_KEEP_ENTRIES = 40;

/** Keep the header + the newest entries; older history lives in git. */
const compactJournal = (body: string): string => {
  const parts = body.split(/\n- \[/u);
  const header = parts[0] ?? "";
  const entries = parts.slice(1);
  if (entries.length <= JOURNAL_KEEP_ENTRIES) {
    return body;
  }
  const kept = entries.slice(-JOURNAL_KEEP_ENTRIES).map((e) => `- [${e.trimEnd()}`);
  return `${header.trimEnd()}\n\n> (older entries compacted — full history in the workspace git log)\n\n${kept.join("\n\n")}\n`;
};

export const appendJournal = (bb: Blackboard, line: string): void => {
  const stamp = new Date().toISOString();
  const body = existsSync(bb.journal) ? readFileSync(bb.journal, "utf-8") : "";
  const next = `${body.replace(/\s*$/u, "")}\n\n- [${stamp}] ${line}\n`;
  writeFileSync(bb.journal, next.length > MAX_JOURNAL_BYTES ? compactJournal(next) : next);
};

/** The standing operator directive, or null when none is set. */
export const readDirective = (bb: Blackboard): string | null => {
  try {
    const text = readFileSync(bb.directive, "utf-8").trim();
    return text || null;
  } catch {
    return null;
  }
};

/** Set (or with empty text, clear) the standing operator directive. */
export const setDirective = (bb: Blackboard, text: string): void => {
  mkdirSync(bb.dir, { recursive: true });
  const trimmed = text.trim();
  if (!trimmed) {
    try {
      rmSync(bb.directive);
    } catch {
      /* already gone */
    }
    return;
  }
  writeFileSync(bb.directive, `${trimmed}\n`);
};

/** Read AND consume an agent-authored checkpoint note, if one is waiting. */
export const takeCheckpoint = (bb: Blackboard): string | null => {
  let text: string;
  try {
    text = readFileSync(bb.checkpoint, "utf-8").trim();
  } catch {
    return null;
  }
  try {
    rmSync(bb.checkpoint);
  } catch {
    /* best-effort */
  }
  return text || null;
};

export const stopRequested = (bb: Blackboard): boolean => existsSync(bb.stop);

/** Remove a stale STOP sentinel. Only safe to call while holding the lock. */
export const clearStop = (bb: Blackboard): void => {
  try {
    if (existsSync(bb.stop)) {
      rmSync(bb.stop);
    }
  } catch {
    /* ignore */
  }
};

/** The current approval token (APPROVE file contents), or null if none. */
export const approvalToken = (bb: Blackboard): string | null => {
  try {
    const token = readFileSync(bb.approve, "utf-8").trim();
    return token || null;
  } catch {
    return null;
  }
};

/**
 * Is there an unacted-on deploy approval? Pending only when the sentinel's
 * token differs from the last one we consumed (tracked in persisted state), so
 * a one-shot approval can't be re-used even if the file fails to delete.
 */
export const approvalPending = (bb: Blackboard, lastApproval: string | null): boolean => {
  const token = approvalToken(bb);
  return token !== null && token !== lastApproval;
};

/** Grant a one-shot deploy approval (written by `pnpm approve <slug>`). */
export const requestApproval = (bb: Blackboard): void => {
  mkdirSync(bb.dir, { recursive: true });
  // The nonce makes every approval a distinct token, so the orchestrator can
  // tell a fresh approval from one it already deployed.
  writeFileSync(bb.approve, `approved ${new Date().toISOString()} ${randomUUID()}\n`);
};

/** Best-effort removal of the approval sentinel after it's been acted on. */
export const consumeApproval = (bb: Blackboard): void => {
  try {
    if (existsSync(bb.approve)) {
      rmSync(bb.approve);
    }
  } catch {
    /* ignore — consumption is authoritative via state.lastApproval */
  }
};

type LockStatus =
  // no lock file
  | { state: "free" }
  // a live owner (possibly another user's process)
  | { state: "alive"; pid: number }
  // dead owner, our own prior pid, or junk contents — reclaimable
  | { state: "stale" }
  // exists but couldn't be read (transient IO) — do NOT reclaim
  | { state: "unknown" };

/** The `code` of a thrown filesystem/process error, or undefined. */
const errnoCode = (cause: unknown): string | undefined => {
  if (!(cause instanceof Error) || !("code" in cause)) {
    return undefined;
  }
  const { code } = cause;
  // Strict equality with the coerced copy never coerces, so it holds exactly
  // for primitive strings — a typeof-free narrowing.
  return String(code) === code ? code : undefined;
};

/** The owning pid recorded in a lock payload, or undefined for junk contents. */
const lockOwnerPid = (raw: string): number | undefined => {
  const parsed: JsonValue = JSON.parse(raw);
  const pid = asNumber(asJsonObject(parsed)?.pid);
  return pid !== undefined && Number.isFinite(pid) ? pid : undefined;
};

/** Inspect the lock file without mutating it. */
const readLock = (bb: Blackboard): LockStatus => {
  let raw: string;
  try {
    raw = readFileSync(bb.lock, "utf-8");
  } catch (error) {
    // Gone => free to take. Any other read error (e.g. transient EACCES) is
    // ambiguous; treat as held so we never delete a possibly-live lock.
    return errnoCode(error) === "ENOENT" ? { state: "free" } : { state: "unknown" };
  }
  let pid: number | undefined;
  try {
    pid = lockOwnerPid(raw);
  } catch {
    // corrupt contents — safe to reclaim
    return { state: "stale" };
  }
  if (pid === undefined) {
    return { state: "stale" };
  }
  if (pid === process.pid) {
    return { state: "stale" };
    // our own lock from a prior run
  }
  try {
    // probe liveness without signalling
    process.kill(pid, 0);
    return { pid, state: "alive" };
  } catch (error) {
    // EPERM => the process exists but isn't ours (alive); ESRCH => gone (stale).
    return errnoCode(error) === "EPERM" ? { pid, state: "alive" } : { state: "stale" };
  }
};

/** Sentinel pid for "lock is held but we couldn't read whose it is". */
export const LOCK_BUSY_UNKNOWN = -1;

/**
 * Take the per-workspace lock so only one studio runs per game. Claims it via
 * an atomic exclusive create (O_EXCL) so two simultaneous `start`s can't both
 * see an empty slot and proceed. Returns null on success; otherwise the live
 * owner pid (or LOCK_BUSY_UNKNOWN). Only a genuinely stale lock is reclaimed —
 * an unreadable lock file is treated as held, never deleted.
 */
export const acquireLock = (bb: Blackboard): number | null => {
  mkdirSync(bb.dir, { recursive: true });
  const payload = `${JSON.stringify({ at: new Date().toISOString(), pid: process.pid })}\n`;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      // "wx" => fail if the file already exists; the create is atomic.
      writeFileSync(bb.lock, payload, { flag: "wx" });
      return null;
    } catch (error) {
      if (errnoCode(error) !== "EEXIST") {
        throw error;
      }
      const status = readLock(bb);
      if (status.state === "alive") {
        return status.pid;
      }
      if (status.state === "unknown") {
        return LOCK_BUSY_UNKNOWN;
        // don't reclaim a lock we can't read
      }
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
};

/** Release the lock if (and only if) we own it. */
export const releaseLock = (bb: Blackboard): void => {
  try {
    if (lockOwnerPid(readFileSync(bb.lock, "utf-8")) === process.pid) {
      rmSync(bb.lock);
    }
  } catch {
    /* ignore */
  }
};
