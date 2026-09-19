import { existsSync, writeFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

import type { Role, RoleName } from "./agents.ts";
import { claudeBin, codexBin, findRepoRoot } from "./config.ts";
import { runClaude } from "./claude.ts";
import { runCodex } from "./codex.ts";
import { runGate } from "./gate.ts";
import { commitPhase, diffSummary, headCommit, insideForeignRepo } from "./git.ts";
import { notifyOperator } from "./notify.ts";
import { preflight, vgAuthenticated } from "./preflight.ts";
import type { Reporter } from "./reporter.ts";
import type { RunResult, Runner } from "./runner.ts";
import { buildTask, roleForPhase, ROLES } from "./roles.ts";
import {
  acquireLock,
  appendJournal,
  approvalPending,
  approvalToken,
  blackboard,
  clearStop,
  consumeApproval,
  hasExistingProject,
  initWorkspace,
  releaseLock,
  saveState,
  stopRequested,
  takeCheckpoint,
} from "./state.ts";
import type { AgentState, Blackboard, Phase } from "./state.ts";
import { appendSpan } from "./trace.ts";

/** Handles the caller (TUI keys, signal handlers) uses to steer a running loop. */
export interface RunControls {
  /** Finish the current step, then halt. Idempotent. */
  gracefulStop: () => void;
  /** Abort the in-flight subagent and exit the process (code 130). */
  forceQuit: () => void;
  /** Finish the current step, then hold until resume(). */
  pause: () => void;
  resume: () => void;
  /** Skip the current checkpoint countdown and continue immediately. */
  continueNow: () => void;
  /** Stop at the next release point (a ship, or a build ready to ship). */
  stopAtRelease: () => void;
}

export interface AgentOptions {
  slug: string;
  idea: string;
  workspace: string;
  /** Which coding-agent CLI runs the subagents. */
  runner: Runner;
  model: string;
  /**
   * Roles routed to the codex CLI even when the main runner is claude — e.g.
   * engineer turns with fully-specced build tasks are bulk work a cheaper
   * runner handles fine, while director/designer/qa judgment stays on claude.
   */
  codexRoles: RoleName[];
  /** Model for codex-routed roles (ignored when codexRoles is empty). */
  codexModel: string;
  maxTurns: number;
  /** Kill a subagent that emits no output for this long (ms; 0 disables). */
  idleTimeoutMs: number;
  /** Absolute ceiling on a single subagent session (ms; 0 disables). */
  maxSessionMs: number;
  /** 0 = run forever (until stopped). */
  maxCycles: number;
  /** ms to pause between subagent runs. */
  interval: number;
  /** Skip the ship phase (no prod deploys — useful while testing the loop). */
  noShip: boolean;
  /** Deploy automatically without per-release human approval. */
  autoDeploy: boolean;
  /** How long an agent checkpoint waits for the operator before continuing
   * (ms; 0 = consume checkpoints without waiting). */
  checkpointWaitMs: number;
  /** Pass --dangerously-skip-permissions so tools run unattended. */
  skipPermissions: boolean;
  /** Optional operator brief written to .vgfactory/context.md for the subagents. */
  context?: string;
  /** Optional reference directory the subagents are granted read access to. */
  contextDir?: string;
  /** Receives stop handles once the loop owns the workspace lock. */
  registerControls?: (controls: RunControls) => void;
  /** Runs right before a force-quit exits, e.g. to restore the terminal. */
  beforeForceExit?: () => void;
}

const MAX_RETRIES = 5;

/**
 * Pure phase transition: bootstrap once, then loop the agent's cycle forever.
 * Deliberately has NO side effects on shipped/deployUrl/iteration — those only
 * happen on a *successful* ship (see recordShip), never when the ship phase is
 * skipped (--no-ship) or abandoned after repeated failures.
 */
const advance = (state: AgentState): void => {
  const transitions = {
    assets: "build",
    build: "playtest",
    plan: "work",
    playtest: "ship",
    scaffold: "assets",
    ship: "plan",
    spec: "scaffold",
    work: "playtest",
  } satisfies Record<Phase, Phase>;
  state.phase = transitions[state.phase];
};

/**
 * Record a confirmed deploy. Called only after the shipper actually succeeds,
 * so state.json / status never claim a shipped game or live URL that wasn't
 * deployed. The first success flips `shipped`; each later success counts a
 * completed studio iteration (a shipped feature/fix/iteration pass).
 */
const recordShip = (state: AgentState): void => {
  if (state.shipped) {
    state.iteration += 1;
  } else {
    state.shipped = true;
    state.deployUrl = `https://${state.slug}.vibedgames.com`;
  }
};

/** Current wall-clock minutes-past-midnight in `tz` (local when omitted). */
const minutesNowIn = (tz: string | undefined): number | null => {
  try {
    const fmt = new Intl.DateTimeFormat("en-US", {
      hour: "2-digit",
      hour12: false,
      minute: "2-digit",
      timeZone: tz,
    });
    const parts = fmt.formatToParts(new Date());
    const h = Number(parts.find((p) => p.type === "hour")?.value);
    const min = Number(parts.find((p) => p.type === "minute")?.value);
    if (!Number.isFinite(h) || !Number.isFinite(min)) {
      return null;
    }
    // some impls render midnight as "24"
    return (h % 24) * 60 + min;
  } catch {
    // unrecognized timezone string
    return null;
  }
};

/** Failure text that means "the provider is throttling us", not "the task failed". */
const RATE_LIMIT_RE =
  /(?:session|usage|rate)[ -]?limit|rate[ -]?limited|overloaded_error|\b429\b/iu;
/** When the message names no reset time, stand down this long between probes. */
const RATE_LIMIT_FALLBACK_MS = 15 * 60_000;
/** Cushion past the stated reset so the first retry lands on the fresh window. */
const RATE_LIMIT_SLACK_MS = 2 * 60_000;

/**
 * How long to stand down for a rate/usage-limit failure — or null when the
 * failure isn't one. Limit messages often name their reset time ("You've hit
 * your session limit · resets 7:40am (America/Los_Angeles)"); when parseable,
 * sleep straight through to it instead of probing every few minutes.
 */
export const rateLimitDelayMs = (message: string): number | null => {
  if (!RATE_LIMIT_RE.test(message)) {
    return null;
  }
  const m =
    /resets?\s+(?:at\s+)?(?<hour>\d{1,2})(?::(?<minute>\d{2}))?\s*(?<meridiem>am|pm)(?:\s*\((?<tz>[^)]+)\))?/iu.exec(
      message,
    );
  if (!m?.groups) {
    return RATE_LIMIT_FALLBACK_MS;
  }
  const { hour: rawHour, minute, meridiem, tz } = m.groups;
  let hour = Number(rawHour) % 12;
  if (meridiem?.toLowerCase() === "pm") {
    hour += 12;
  }
  const targetMin = hour * 60 + (minute ? Number(minute) : 0);
  const nowMin = minutesNowIn(tz);
  if (nowMin === null) {
    return RATE_LIMIT_FALLBACK_MS;
  }
  // Next occurrence of the target wall-clock time (same day or tomorrow).
  const delta = (targetMin - nowMin + 1440) % 1440;
  return delta * 60_000 + RATE_LIMIT_SLACK_MS;
};

const truncate = (s: string, n = 240): string => {
  const flat = (s ?? "").replaceAll(/\s+/gu, " ").trim();
  return flat.length > n ? `${flat.slice(0, n)}…` : flat;
};

const costNote = (c?: number): string => (c === undefined ? "" : ` ($${c.toFixed(2)})`);

/** The state a brand-new workspace starts from. */
const seedState = (opts: AgentOptions, existingProject: boolean, now: string): AgentState => ({
  built: false,
  contextDir: opts.contextDir ?? null,
  createdAt: now,
  cycle: 0,
  deployUrl: null,
  existingProject,
  idea: opts.idea,
  iteration: 0,
  lastApproval: null,
  lastPlaytestHead: null,
  model: opts.model,
  phase: "spec",
  phaseFailures: 0,
  runner: opts.runner,
  shipped: false,
  slug: opts.slug,
  totalCostUsd: 0,
  updatedAt: now,
});

/**
 * Reconcile a resumed workspace with this run's flags: re-seed the knobs a
 * restart may change, backfill pre-field workspaces, and honor a new
 * --context. Persists the result.
 */
const reconcileState = (
  bb: Blackboard,
  opts: AgentOptions,
  state: AgentState,
  reporter: Reporter,
): void => {
  // The persisted slug is authoritative for an existing workspace (R2 keys and
  // the deploy URL are tied to it). Warn rather than silently honor a different
  // CLI slug aimed at the same blackboard (only possible via --workspace).
  if (state.slug !== opts.slug) {
    reporter.warn(
      `Workspace already belongs to "${state.slug}"; ignoring the "${opts.slug}" slug for this run.`,
    );
  }
  // Re-seed mutable knobs on restart so flags take effect.
  state.idea = opts.idea || state.idea;
  state.model = opts.model;
  state.runner = opts.runner;
  // backfill pre-field workspaces
  state.phaseFailures ??= 0;
  // Keep the adopt flag reflecting whether a project is actually present to
  // build upon: it starts true only when the workspace was created on existing
  // files, and clears if those files later go away — so a wiped workspace stops
  // claiming adoption. A fresh game never flips to "adopt" just because
  // scaffolding created files (false stays false).
  state.existingProject = (state.existingProject ?? false) && hasExistingProject(opts.workspace);
  // shipped implies built — force the invariant so an inconsistent persisted
  // `built:false, shipped:true` can't make the ship guard and preemption spin.
  state.built = (state.built ?? false) || state.shipped;
  state.lastApproval ??= null;
  // backfill pre-field workspaces
  state.lastPlaytestHead ??= null;
  // A new --context this run fully replaces the prior brief AND reference dir
  // (so switching to a file/text brief clears a stale reference folder);
  // otherwise keep what's persisted so a plain resume retains them.
  if (opts.context === undefined) {
    state.contextDir ??= null;
  } else {
    writeFileSync(bb.context, `${opts.context.trim()}\n`);
    state.contextDir = opts.contextDir ?? null;
  }
  saveState(bb, state);
};

/** The run banner, plus the standing warnings for an unattended run. */
const announceRun = (
  bb: Blackboard,
  opts: AgentOptions,
  state: AgentState,
  repoRoot: string | null,
  reporter: Reporter,
): void => {
  reporter.start({
    autoDeploy: opts.autoDeploy,
    contextDir: state.contextDir,
    existingProject: state.existingProject,
    guarded: !opts.skipPermissions,
    hasContext: existsSync(bb.context),
    idea: state.idea,
    maxCycles: opts.maxCycles,
    model: state.model,
    noShip: opts.noShip,
    repoRoot,
    runner: opts.runner,
    slug: state.slug,
    workspace: opts.workspace,
  });
  if (!opts.skipPermissions) {
    return;
  }
  let deployNote = "Deploys are gated on approval — nothing goes live without you.";
  if (opts.noShip) {
    deployNote = "Deploys are disabled.";
  } else if (opts.autoDeploy) {
    deployNote = "Deploys to production run AUTOMATICALLY.";
  }
  reporter.warn(
    `Running with --dangerously-skip-permissions: agents run shell/file tools and \`vg generate\` (which costs money) WITHOUT asking. ${deployNote}`,
  );
  // claude rejects --dangerously-skip-permissions under root unless the
  // environment is marked as a sandbox; we set IS_SANDBOX=1 for the children
  // so unattended container/CI runs (which are typically root) actually work.
  if (process.getuid?.() === 0 && process.env.IS_SANDBOX !== "1") {
    reporter.info("Detected root: setting IS_SANDBOX=1 for agents so skip-permissions is allowed.");
  }
};

/**
 * The harness-enforced quality gate: after engineering phases, run the
 * workspace's own typecheck + build and refuse to advance on red — a
 * forever-loop can't run on the agent's claim that things work. Returns the
 * failure text, or undefined when the phase isn't gated or the gate is green.
 */
const qualityGate = async (
  workspace: string,
  phase: Phase,
  role: RoleName,
  res: RunResult,
  reporter: Reporter,
): Promise<string | undefined> => {
  const gated =
    res.ok &&
    (phase === "scaffold" || phase === "build" || (phase === "work" && role === "engineer"));
  if (!gated) {
    return undefined;
  }
  const gate = await runGate(workspace);
  if (gate.ok) {
    if (!gate.skipped) {
      reporter.info(`Quality gate passed (${gate.detail}).`);
    }
    return undefined;
  }
  reporter.warn("Quality gate FAILED — retrying the phase.");
  return `quality gate failed — the session claimed success but the workspace doesn't verify. ${gate.detail}`;
};

/** What the pre-turn checks decided: run the phase, start the next pass, or halt. */
type CycleDecision = "run" | "skip" | "stop";

/** A finished subagent turn, plus the failure text when it (or its gate) failed. */
interface TurnOutcome {
  phase: Phase;
  role: Role;
  res: RunResult;
  /** The session this attempt resumed, when it was a retry. */
  resuming: string | undefined;
  failure: string | undefined;
}

/**
 * The agent's durable phase loop. Narrates through `reporter` and returns when
 * stopped (Ctrl-C, STOP sentinel, cycle budget) — true if it ran, false if it
 * couldn't start (lock held). Owns no terminal state: the caller decides what
 * start/stop look like on screen.
 */
export const runAgent = async (opts: AgentOptions, reporter: Reporter): Promise<boolean> => {
  const repoRoot = findRepoRoot();
  const bb = blackboard(opts.workspace);
  const now = new Date().toISOString();

  // Detect an existing project to build upon (only meaningful on a fresh start;
  // on resume the flag is already persisted).
  const isFresh = !existsSync(bb.state);
  const existingProject = isFresh && hasExistingProject(opts.workspace);

  const seed = seedState(opts, existingProject, now);
  // One agent per workspace: refuse to start a second process on the same
  // game, which would let two loops fight over the same files (and let an
  // impatient `start` wipe a still-running process's pending STOP).
  const owner = acquireLock(bb);
  if (owner !== null) {
    const who = owner > 0 ? `pid ${owner}` : "another process";
    reporter.error(
      `An agent is already running for "${opts.slug}" (${who}). Stop it first with \`pnpm stop ${opts.slug}\`, or wait for it to finish.`,
    );
    return false;
  }
  const onExit = () => releaseLock(bb);
  process.on("exit", onExit);

  // We now hold the lock, so any STOP sentinel is necessarily stale (left by a
  // previous run that has since exited) — safe to clear before we loop.
  clearStop(bb);

  const state = initWorkspace(bb, seed);
  reconcileState(bb, opts, state, reporter);

  // External tools (claude, and outside the repo: workspace skills + vg via
  // `vg init`) must be in place before any subagent runs.
  if (!(await preflight(opts.workspace, opts.runner, reporter))) {
    process.off("exit", onExit);
    releaseLock(bb);
    return false;
  }

  // The workspace sits inside somebody else's git repo (e.g. a game dir in a
  // monorepo): the phase ratchet stands down rather than creating a nested
  // repo that shadows the enclosing one — say so up front, once.
  if (insideForeignRepo(opts.workspace)) {
    reporter.warn(
      "Workspace is inside an existing git repository — the factory will NOT create a nested repo or auto-commit phases; history belongs to the enclosing repo (commit/branch it yourself).",
    );
  }

  let stopping = false;
  let paused = false;
  let checkpointSkip = false;
  let stopAtReleaseFlag = false;
  // Failed turn's session id, armed for ONE resume attempt so the next try
  // continues where it died instead of re-deriving the work from scratch. A
  // failed resume falls back to a fresh session (a poisoned session — e.g.
  // context overflow — would just die again).
  let resumeSessionId: string | undefined;
  // HEAD we last nudged the operator about (approval-needed notification):
  // notify once per new build, not every pass through the ship phase.
  let approvalNudgedHead: string | null | undefined;
  const abort = new AbortController();

  const gracefulStop = (): void => {
    if (stopping) {
      return;
    }
    stopping = true;
    // a held loop must still be able to exit
    paused = false;
    reporter.warn("Stop requested — finishing the current step.");
  };
  const forceQuit = (): void => {
    reporter.warn("Force quitting.");
    abort.abort();
    opts.beforeForceExit?.();
    process.exit(130);
  };
  // External signals keep the old escalation: first graceful, second force.
  const onSignal = (): void => {
    if (stopping) {
      forceQuit();
    } else {
      gracefulStop();
    }
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  opts.registerControls?.({
    continueNow: () => {
      checkpointSkip = true;
    },
    forceQuit,
    gracefulStop,
    pause: () => {
      if (paused || stopping) {
        return;
      }
      paused = true;
      reporter.warn("Paused — the current step finishes, then the loop holds.");
    },
    resume: () => {
      if (!paused) {
        return;
      }
      paused = false;
      reporter.info("Resumed.");
    },
    stopAtRelease: () => {
      if (stopAtReleaseFlag) {
        return;
      }
      stopAtReleaseFlag = true;
      reporter.info("Will stop at the next release point (a ship, or a ship-ready build).");
    },
  });

  announceRun(bb, opts, state, repoRoot, reporter);
  reporter.stateChanged(state, approvalPending(bb, state.lastApproval));

  // A sleep that wakes early if a stop is requested (Ctrl-C or STOP sentinel),
  // so backoff/interval waits never delay shutdown.
  const sleepUnlessStopping = async (ms: number): Promise<void> => {
    const step = 250;
    for (let waited = 0; waited < ms; waited += step) {
      if (stopping || stopRequested(bb)) {
        return;
      }
      await sleep(Math.min(step, ms - waited));
    }
  };

  // When the director flags a good stopping point, surface it and hold for
  // the operator; no response within the window means the loop keeps going.
  const maybeCheckpoint = async (): Promise<void> => {
    const note = takeCheckpoint(bb);
    if (!note || stopping) {
      return;
    }
    appendJournal(bb, `checkpoint: ${truncate(note)}`);
    notifyOperator(`factory: checkpoint (${state.slug})`, truncate(note, 180));
    if (opts.checkpointWaitMs <= 0) {
      return;
    }
    checkpointSkip = false;
    reporter.checkpointStarted(note, opts.checkpointWaitMs);
    for (let waited = 0; waited < opts.checkpointWaitMs;) {
      if (stopping || stopRequested(bb) || checkpointSkip) {
        break;
      }
      await sleep(250);
      if (!paused) {
        waited += 250;
        // a pause holds the countdown open
      }
    }
    reporter.checkpointEnded();
  };

  // The ship phase's gates, in order: --skip-ship, no recorded build, an
  // unauthenticated vg CLI, and the standing-approval requirement. Each one
  // advances past the ship rather than burning a shipper turn on it.
  const shipGate = async (): Promise<CycleDecision> => {
    if (state.phase !== "ship") {
      return "run";
    }

    // Optionally skip shipping (no prod deploy) while testing.
    if (opts.noShip) {
      reporter.info("--skip-ship set; skipping the ship phase.");
      advance(state);
      saveState(bb, state);
      reporter.stateChanged(state, approvalPending(bb, state.lastApproval));
      return "skip";
    }

    // Never deploy without a recorded successful build — e.g. if the build
    // phase was skipped after repeated failures. Wait until a build lands.
    if (!state.built) {
      reporter.warn("Reached ship with no successful build recorded — not deploying yet.");
      appendJournal(bb, "ship: skipped — no successful build recorded.");
      advance(state);
      saveState(bb, state);
      reporter.stateChanged(state, approvalPending(bb, state.lastApproval));
      return "skip";
    }

    // Deploys need an authenticated vg CLI — an unauthenticated (or absent) vg
    // would just burn a shipper turn on a failing `vg deploy`. Skip the ship
    // and keep iterating; the operator can `vg login` (or set VG_TOKEN) any
    // time and the next release point deploys. A standing approval survives.
    if (!vgAuthenticated()) {
      reporter.warn(
        "`vg` is not logged in — skipping the deploy. Run `vg login` (or set VG_TOKEN) and the next release will ship.",
      );
      appendJournal(bb, "ship: skipped — vg CLI not authenticated (run `vg login`).");
      advance(state);
      saveState(bb, state);
      reporter.stateChanged(state, approvalPending(bb, state.lastApproval));
      return "skip";
    }

    // Deploys require explicit human approval unless --auto-deploy is set. When
    // there's no standing approval we don't even run the shipper: the build is
    // ready, we just don't publish it — the loop keeps improving the game
    // locally until a human approves.
    if (!opts.autoDeploy && !approvalPending(bb, state.lastApproval)) {
      reporter.warn(
        `Build ready but NOT deployed — approval required. Run \`pnpm approve ${state.slug}\` (or press A in the dashboard) to publish it.`,
      );
      appendJournal(bb, "ship: build ready, awaiting human approval (not deployed).");
      // The loop runs unattended for hours — a journal line doesn't reach
      // anyone. Nudge the operator once per new build (HEAD), not every pass.
      const buildHead = headCommit(opts.workspace);
      if (buildHead !== approvalNudgedHead) {
        approvalNudgedHead = buildHead;
        notifyOperator(
          "factory: approval needed",
          `${state.slug}: build ready to deploy — run \`pnpm approve ${state.slug}\``,
        );
      }
      advance(state);
      saveState(bb, state);
      reporter.stateChanged(state, approvalPending(bb, state.lastApproval));
      if (stopAtReleaseFlag) {
        reporter.info("Release point reached (build ready) — stopping as requested.");
        return "stop";
      }
      await maybeCheckpoint();
      return "skip";
    }

    return "run";
  };

  // Everything decided before a subagent is spawned: the pause hold, the stop
  // sentinel, approval preemption, the cycle budget, then the ship gates.
  const beforeTurn = async (): Promise<CycleDecision> => {
    // Hold here while paused — between steps, so the checkpointed state on
    // disk is always consistent while the operator pokes around. Flags flip
    // in the controls/signal handlers, which oxlint's static check can't see.
    // oxlint-disable-next-line no-unmodified-loop-condition
    while (paused && !stopping && !stopRequested(bb)) {
      await sleep(250);
    }

    if (stopRequested(bb)) {
      reporter.warn("STOP sentinel found in .vgfactory/ — halting.");
      return "stop";
    }

    // In the forever loop (after the first release), an operator approval ships
    // the CURRENT build promptly instead of iterating further, so what goes live
    // is the build they approved rather than a newer, unreviewed one. We do NOT
    // preempt during the initial bootstrap (before the first ship): an early
    // approval simply waits and is honored at the natural ship phase, once
    // assets/build/playtest have run — so it can't deploy an incomplete game.
    // Checked before the cycle-budget stop so an explicit approval is honored
    // even when --max-cycles is already spent.
    if (
      state.phase !== "ship" &&
      state.shipped &&
      !opts.autoDeploy &&
      !opts.noShip &&
      approvalPending(bb, state.lastApproval)
    ) {
      reporter.info("Approval received — shipping the current build before continuing.");
      state.phase = "ship";
      // entering a new phase: fresh retry budget
      state.phaseFailures = 0;
      saveState(bb, state);
      reporter.stateChanged(state, approvalPending(bb, state.lastApproval));
    }

    // An operator-approved deploy is a deliberate command — let that single ship
    // run even if the autonomous cycle budget is used up.
    const approvedShipPending =
      state.phase === "ship" &&
      !opts.autoDeploy &&
      !opts.noShip &&
      approvalPending(bb, state.lastApproval);
    if (opts.maxCycles > 0 && state.cycle >= opts.maxCycles && !approvedShipPending) {
      reporter.info(`Reached --max-cycles=${opts.maxCycles}. Stopping.`);
      return "stop";
    }

    return shipGate();
  };

  // One subagent turn: route it to a runner, run it, bank the cost, trace the
  // span, and gate the result.
  const runTurn = async (): Promise<TurnOutcome> => {
    const { phase } = state;
    const role = ROLES[roleForPhase(phase, bb)];
    const task = buildTask(phase, state, bb);

    reporter.turnStart({
      cycle: state.cycle + 1,
      emoji: role.emoji,
      iteration: state.shipped ? state.iteration + 1 : null,
      phase,
      role: role.name,
    });

    const turnStartedAt = Date.now();
    // Per-role runner routing: bulk-work roles can run on codex while
    // judgment-heavy roles stay on the main runner.
    const useCodex = opts.runner === "codex" || opts.codexRoles.includes(role.name);
    const exec = useCodex ? runCodex : runClaude;
    // Resume is claude-only; a codex-routed retry starts fresh.
    const resuming = useCodex ? undefined : resumeSessionId;
    const prompt = resuming
      ? `Your previous session on this assignment was interrupted before it reported success. First check what you already completed (git status/diff, the files and journal entries you touched), then finish ONLY the remaining work — do not redo what's done.\n\nThe assignment again, for reference:\n\n${task}`
      : task;
    const res = await exec({
      addDirs: [repoRoot, state.contextDir].filter((d): d is string => Boolean(d)),
      bin: useCodex ? codexBin() : claudeBin(),
      cwd: opts.workspace,
      idleTimeoutMs: opts.idleTimeoutMs,
      maxSessionMs: opts.maxSessionMs,
      maxTurns: opts.maxTurns,
      model: useCodex && opts.runner !== "codex" ? opts.codexModel : state.model,
      onActivity: (activity) => reporter.activity(activity),
      prompt,
      resumeSessionId: resuming,
      signal: abort.signal,
      skipPermissions: opts.skipPermissions,
      systemPrompt: role.system,
    });

    state.cycle += 1;
    if (res.costUsd !== undefined) {
      state.totalCostUsd += res.costUsd;
    }
    saveState(bb, state);
    reporter.stateChanged(state, approvalPending(bb, state.lastApproval));

    // One span per turn — the agent's durable observability trail.
    appendSpan(bb, {
      costUsd: res.costUsd,
      cycle: state.cycle,
      detail: truncate(res.ok ? res.result : (res.error ?? "unknown error"), 200),
      durationMs: Date.now() - turnStartedAt,
      iteration: state.iteration,
      model: state.model,
      numTurns: res.numTurns,
      ok: res.ok,
      phase,
      role: role.name,
      ts: new Date().toISOString(),
      turn: state.cycle,
    });

    const gateError = await qualityGate(opts.workspace, phase, role.name, res, reporter);
    return {
      failure: res.ok ? gateError : (res.error ?? "unknown error"),
      phase,
      res,
      resuming,
      role,
    };
  };

  // A failed turn: stand down for a provider limit, else burn a retry — and
  // skip the phase entirely once the retry budget is spent.
  const handleFailure = async (outcome: TurnOutcome, failure: string): Promise<void> => {
    const { phase, res, resuming, role } = outcome;
    // A provider rate/usage limit is an infrastructure stall, not a task
    // failure: retrying just spawns instant corpses and burns the retry
    // budget. Stand down until the limit resets, then try again untaxed.
    const stallMs = rateLimitDelayMs(failure);
    if (stallMs !== null && !stopping) {
      const stallNote = `provider rate limit — pausing ${Math.round(stallMs / 60_000)}m before retrying (${truncate(failure, 200)})`;
      appendJournal(bb, `${role.name} (${phase}) hit a ${stallNote}`);
      reporter.warn(`Rate-limited — pausing ${Math.round(stallMs / 60_000)}m.`);
      reporter.turnEnd({
        costUsd: res.costUsd,
        error: truncate(failure, 400),
        numTurns: res.numTurns,
        ok: false,
      });
      notifyOperator(
        `factory: rate-limited (${state.slug})`,
        `Pausing ~${Math.round(stallMs / 60_000)}m until the limit resets, then resuming.`,
      );
      await sleepUnlessStopping(stallMs);
      return;
    }

    state.phaseFailures += 1;
    // persist so a restart can't reset the retry budget
    saveState(bb, state);
    appendJournal(bb, `${role.name} (${phase}) FAILED: ${truncate(failure, 600)}`);
    // Failed turns often finished (or half-finished) the actual work before
    // dying — record what's on disk so the retry and the operator don't have
    // to assume the failure undid it.
    const leftover = diffSummary(opts.workspace);
    if (leftover) {
      appendJournal(
        bb,
        `${role.name} (${phase}) left uncommitted changes: ${truncate(leftover, 500)}`,
      );
    }
    // Arm ONE resume of the dead session; if this attempt was already a
    // resume, fall back to a fresh session next time.
    resumeSessionId = resuming ? undefined : res.sessionId;
    reporter.turnEnd({
      costUsd: res.costUsd,
      error: truncate(failure, 400),
      numTurns: res.numTurns,
      ok: false,
    });
    if (state.phaseFailures >= MAX_RETRIES) {
      reporter.warn(
        `${MAX_RETRIES} consecutive failures on "${phase}" — skipping ahead to avoid a stuck loop.`,
      );
      // the next phase is different work
      resumeSessionId = undefined;
      notifyOperator(
        `factory: phase skipped (${state.slug})`,
        `"${phase}" failed ${MAX_RETRIES}× and was skipped — worth a look: ${truncate(failure, 140)}`,
      );
      // A spent attempt consumes the deploy approval too, so a broken ship
      // can't re-trigger itself forever; the operator can re-approve.
      if (phase === "ship") {
        state.lastApproval = approvalToken(bb) ?? state.lastApproval;
        consumeApproval(bb);
      }
      state.phaseFailures = 0;
      advance(state);
      saveState(bb, state);
      reporter.stateChanged(state, approvalPending(bb, state.lastApproval));
    } else {
      const backoff = Math.min(2 ** state.phaseFailures, 60);
      reporter.info(
        `Retrying "${phase}" in ${backoff}s (attempt ${state.phaseFailures + 1}/${MAX_RETRIES}).`,
      );
      await sleepUnlessStopping(backoff * 1000);
    }
  };

  // A successful turn: bank it, advance the phase, ratchet a commit — true
  // when the loop should stop right here.
  const finishTurn = async (outcome: TurnOutcome): Promise<boolean> => {
    const { phase, res, role } = outcome;
    state.phaseFailures = 0;
    // this phase's work is done; nothing to resume
    resumeSessionId = undefined;
    appendJournal(
      bb,
      `${role.name} (${phase}) done${costNote(res.costUsd)}: ${truncate(res.result)}`,
    );
    reporter.turnEnd({ costUsd: res.costUsd, numTurns: res.numTurns, ok: true });

    // A deployable build exists once a phase that builds the game succeeds:
    // scaffold (confirms the template/adopted project builds), build, or
    // playtest (QA builds to run it). Including playtest — which recurs in the
    // forever loop — means a game made buildable by later work can still ship;
    // built never gets permanently stuck false after a skipped bootstrap build.
    if (phase === "scaffold" || phase === "build" || phase === "playtest") {
      state.built = true;
    }

    // Only a real, successful ship marks the game deployed; the one-shot
    // approval is recorded as consumed in state (authoritative even if the
    // sentinel file fails to delete), so the next release needs fresh approval.
    if (phase === "ship") {
      recordShip(state);
      state.lastApproval = approvalToken(bb) ?? state.lastApproval;
      consumeApproval(bb);
    }
    advance(state);
    saveState(bb, state);
    reporter.stateChanged(state, approvalPending(bb, state.lastApproval));

    // The git ratchet: every successful phase is a commit, so a phase that
    // makes things worse is a revert, not a hope the next agent notices.
    commitPhase(opts.workspace, `factory: ${role.name} ${phase} (cycle ${state.cycle})`);

    // Record the exact commit this QA pass exercised (after the ratchet commit,
    // so any turn leftovers it swept up are included). While HEAD stays here,
    // the next playtest is steered away from re-running the full suite.
    if (phase === "playtest") {
      state.lastPlaytestHead = headCommit(opts.workspace);
      saveState(bb, state);
    }

    if (phase === "ship" && stopAtReleaseFlag) {
      reporter.info("Release point reached (shipped) — stopping as requested.");
      return true;
    }
    await maybeCheckpoint();

    if (opts.interval > 0 && !stopping) {
      await sleepUnlessStopping(opts.interval);
    }
    return false;
  };

  // `stopping` is flipped by the signal/controls handlers above (and we also
  // honor the STOP sentinel inside the loop) — oxlint can't see the async
  // mutation, so silence its unmodified-condition heuristic.
  // oxlint-disable-next-line no-unmodified-loop-condition
  while (!stopping) {
    const decision = await beforeTurn();
    if (decision === "stop") {
      break;
    }
    if (decision === "skip") {
      continue;
    }

    const outcome = await runTurn();
    const { failure } = outcome;
    if (failure) {
      await handleFailure(outcome, failure);
      continue;
    }
    if (await finishTurn(outcome)) {
      break;
    }
  }

  // Don't leak handlers if runAgent is called more than once in a process.
  process.off("SIGINT", onSignal);
  process.off("SIGTERM", onSignal);
  process.off("exit", onExit);

  saveState(bb, state);
  releaseLock(bb);
  reporter.runEnded({
    cycles: state.cycle,
    deployUrl: state.deployUrl,
    iterations: state.iteration,
    slug: state.slug,
    totalCostUsd: state.totalCostUsd,
  });
  return true;
};
