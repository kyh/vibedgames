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
import { repeatWhile } from "./repeat-while.ts";
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

const advance = (state: AgentState) => {
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

const recordShip = (state: AgentState) => {
  if (state.shipped) {
    state.iteration += 1;
  } else {
    state.shipped = true;
    state.deployUrl = `https://${state.slug}.vibedgames.com`;
  }
};

const minutesNowIn = (tz: string | undefined) => {
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

    return (h % 24) * 60 + min;
  } catch {
    return null;
  }
};

const RATE_LIMIT_RE =
  /(?:session|usage|rate)[ -]?limit|rate[ -]?limited|overloaded_error|\b429\b/iu;

const RATE_LIMIT_FALLBACK_MS = 15 * 60_000;
const RATE_LIMIT_SLACK_MS = 2 * 60_000;

/**
 * How long to stand down for a rate/usage-limit failure — or null when the
 * failure isn't one. Limit messages often name their reset time ("You've hit
 * your session limit · resets 7:40am (America/Los_Angeles)"); when parseable,
 * sleep straight through to it instead of probing every few minutes.
 */
export const rateLimitDelayMs = (message: string) => {
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

  const targetMin = hour * 60 + (minute !== undefined && minute !== "" ? Number(minute) : 0);
  const nowMin = minutesNowIn(tz);

  if (nowMin === null) {
    return RATE_LIMIT_FALLBACK_MS;
  }

  const delta = (targetMin - nowMin + 1440) % 1440;

  return delta * 60_000 + RATE_LIMIT_SLACK_MS;
};

const truncate = (s: string, n = 240) => {
  const flat = (s ?? "").replaceAll(/\s+/gu, " ").trim();

  return flat.length > n ? `${flat.slice(0, n)}…` : flat;
};

const costNote = (c?: number) => (c === undefined ? "" : ` ($${c.toFixed(2)})`);

const seedState: (opts: AgentOptions, existingProject: boolean, now: string) => AgentState = (
  opts,
  existingProject,
  now,
) => ({
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

const reconcileState = (
  bb: Blackboard,
  opts: AgentOptions,
  state: AgentState,
  reporter: Reporter,
) => {
  if (state.slug !== opts.slug) {
    reporter.warn(
      `Workspace already belongs to "${state.slug}"; ignoring the "${opts.slug}" slug for this run.`,
    );
  }

  state.idea = opts.idea || state.idea;
  state.model = opts.model;
  state.runner = opts.runner;
  state.existingProject &&= hasExistingProject(opts.workspace);
  state.built ||= state.shipped;

  if (opts.context !== undefined) {
    writeFileSync(bb.context, `${opts.context.trim()}\n`);
    state.contextDir = opts.contextDir ?? null;
  }

  saveState(bb, state);
};

const announceRun = (
  bb: Blackboard,
  opts: AgentOptions,
  state: AgentState,
  repoRoot: string | null,
  reporter: Reporter,
) => {
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

  if (process.getuid?.() === 0 && process.env.IS_SANDBOX !== "1") {
    reporter.info("Detected root: setting IS_SANDBOX=1 for agents so skip-permissions is allowed.");
  }
};

const qualityGate = async (
  workspace: string,
  phase: Phase,
  role: RoleName,
  res: RunResult,
  reporter: Reporter,
) => {
  const gated =
    res.ok &&
    (phase === "scaffold" || phase === "build" || (phase === "work" && role === "engineer"));

  if (!gated) {
    return null;
  }

  const gate = await runGate(workspace);

  if (gate.ok) {
    if (!gate.skipped) {
      reporter.info(`Quality gate passed (${gate.detail}).`);
    }

    return null;
  }

  reporter.warn("Quality gate FAILED — retrying the phase.");

  return `quality gate failed — the session claimed success but the workspace doesn't verify. ${gate.detail}`;
};

interface TurnOutcome {
  phase: Phase;
  role: Role;
  res: RunResult;
  resuming: string | undefined;
  failure: string | null;
}

/**
 * The agent's durable phase loop. Narrates through `reporter` and returns when
 * stopped (Ctrl-C, STOP sentinel, cycle budget) — true if it ran, false if it
 * couldn't start (lock held). Owns no terminal state: the caller decides what
 * start/stop look like on screen.
 */
export const runAgent = async (opts: AgentOptions, reporter: Reporter) => {
  const repoRoot = findRepoRoot();
  const bb = blackboard(opts.workspace);
  const now = new Date().toISOString();

  const isFresh = !existsSync(bb.state);
  const existingProject = isFresh && hasExistingProject(opts.workspace);

  const seed = seedState(opts, existingProject, now);
  const owner = acquireLock(bb);

  if (owner !== null) {
    const who = owner > 0 ? `pid ${owner}` : "another process";
    reporter.error(
      `An agent is already running for "${opts.slug}" (${who}). Stop it first with \`pnpm stop ${opts.slug}\`, or wait for it to finish.`,
    );

    return false;
  }

  const onExit = () => {
    releaseLock(bb);
  };

  process.on("exit", onExit);

  clearStop(bb);

  const state = initWorkspace(bb, seed);
  reconcileState(bb, opts, state, reporter);

  if (!(await preflight(opts.workspace, opts.runner, reporter))) {
    process.off("exit", onExit);
    releaseLock(bb);

    return false;
  }

  if (insideForeignRepo(opts.workspace)) {
    reporter.warn(
      "Workspace is inside an existing git repository — the factory will NOT create a nested repo or auto-commit phases; history belongs to the enclosing repo (commit/branch it yourself).",
    );
  }

  let stopping = false;
  let paused = false;
  let checkpointSkip = false;
  let stopAtReleaseFlag = false;
  let resumeSessionId: string | undefined;
  let approvalNudgedHead: string | null | undefined;
  const abort = new AbortController();

  const gracefulStop = () => {
    if (stopping) {
      return;
    }

    stopping = true;
    paused = false;
    reporter.warn("Stop requested — finishing the current step.");
  };

  const forceQuit: () => void = () => {
    reporter.warn("Force quitting.");
    abort.abort();
    opts.beforeForceExit?.();
    process.exit(130);
  };

  const onSignal = () => {
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
  reporter.stateChanged?.(state, approvalPending(bb, state.lastApproval));

  const sleepUnlessStopping = async (ms: number) => {
    const step = 250;

    await repeatWhile(async (round) => {
      const waited = round * step;

      if (waited >= ms || stopping || stopRequested(bb)) {
        return false;
      }

      await sleep(Math.min(step, ms - waited));

      return true;
    });
  };

  const maybeCheckpoint = async () => {
    const note = takeCheckpoint(bb);

    if (note === null || note === "" || stopping) {
      return;
    }

    appendJournal(bb, `checkpoint: ${truncate(note)}`);
    notifyOperator(`factory: checkpoint (${state.slug})`, truncate(note, 180));

    if (opts.checkpointWaitMs <= 0) {
      return;
    }

    checkpointSkip = false;
    reporter.checkpointStarted(note, opts.checkpointWaitMs);

    let waited = 0;

    await repeatWhile(async () => {
      if (waited >= opts.checkpointWaitMs || stopping || stopRequested(bb) || checkpointSkip) {
        return false;
      }

      await sleep(250);

      if (!paused) {
        waited += 250;
      }

      return true;
    });

    reporter.checkpointEnded();
  };

  const shipGate = async () => {
    if (state.phase !== "ship") {
      return "run";
    }

    if (opts.noShip) {
      reporter.info("--skip-ship set; skipping the ship phase.");
      advance(state);
      saveState(bb, state);
      reporter.stateChanged?.(state, approvalPending(bb, state.lastApproval));

      return "skip";
    }

    if (!state.built) {
      reporter.warn("Reached ship with no successful build recorded — not deploying yet.");
      appendJournal(bb, "ship: skipped — no successful build recorded.");
      advance(state);
      saveState(bb, state);
      reporter.stateChanged?.(state, approvalPending(bb, state.lastApproval));

      return "skip";
    }

    if (!vgAuthenticated()) {
      reporter.warn(
        "`vg` is not logged in — skipping the deploy. Run `vg login` (or set VG_TOKEN) and the next release will ship.",
      );
      appendJournal(bb, "ship: skipped — vg CLI not authenticated (run `vg login`).");
      advance(state);
      saveState(bb, state);
      reporter.stateChanged?.(state, approvalPending(bb, state.lastApproval));

      return "skip";
    }

    if (!opts.autoDeploy && !approvalPending(bb, state.lastApproval)) {
      reporter.warn(
        `Build ready but NOT deployed — approval required. Run \`pnpm approve ${state.slug}\` (or press A in the dashboard) to publish it.`,
      );
      appendJournal(bb, "ship: build ready, awaiting human approval (not deployed).");
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
      reporter.stateChanged?.(state, approvalPending(bb, state.lastApproval));

      if (stopAtReleaseFlag) {
        reporter.info("Release point reached (build ready) — stopping as requested.");

        return "stop";
      }

      await maybeCheckpoint();

      return "skip";
    }

    return "run";
  };

  const beforeTurn = async () => {
    await repeatWhile(async () => {
      if (!paused || stopping || stopRequested(bb)) {
        return false;
      }

      await sleep(250);

      return true;
    });

    if (stopRequested(bb)) {
      reporter.warn("STOP sentinel found in .vgfactory/ — halting.");

      return "stop";
    }

    if (
      state.phase !== "ship" &&
      state.shipped &&
      !opts.autoDeploy &&
      !opts.noShip &&
      approvalPending(bb, state.lastApproval)
    ) {
      reporter.info("Approval received — shipping the current build before continuing.");
      state.phase = "ship";
      state.phaseFailures = 0;
      saveState(bb, state);
      reporter.stateChanged?.(state, approvalPending(bb, state.lastApproval));
    }

    const approvedShipPending =
      state.phase === "ship" &&
      !opts.autoDeploy &&
      !opts.noShip &&
      approvalPending(bb, state.lastApproval);

    if (opts.maxCycles > 0 && state.cycle >= opts.maxCycles && !approvedShipPending) {
      reporter.info(`Reached --max-cycles=${opts.maxCycles}. Stopping.`);

      return "stop";
    }

    return await shipGate();
  };

  const runTurn: () => Promise<TurnOutcome> = async () => {
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
    const useCodex = opts.runner === "codex" || opts.codexRoles.includes(role.name);
    const exec = useCodex ? runCodex : runClaude;
    const resuming = useCodex ? undefined : resumeSessionId;

    const prompt =
      resuming !== undefined && resuming !== ""
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
      onActivity: (activity) => {
        reporter.activity(activity);
      },
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
    reporter.stateChanged?.(state, approvalPending(bb, state.lastApproval));

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

  const handleFailure = async (outcome: TurnOutcome, failure: string) => {
    const { phase, res, resuming, role } = outcome;
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
    saveState(bb, state);
    appendJournal(bb, `${role.name} (${phase}) FAILED: ${truncate(failure, 600)}`);
    const leftover = diffSummary(opts.workspace);

    if (leftover) {
      appendJournal(
        bb,
        `${role.name} (${phase}) left uncommitted changes: ${truncate(leftover, 500)}`,
      );
    }

    resumeSessionId = resuming !== undefined && resuming !== "" ? undefined : res.sessionId;
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
      resumeSessionId = undefined;
      notifyOperator(
        `factory: phase skipped (${state.slug})`,
        `"${phase}" failed ${MAX_RETRIES}× and was skipped — worth a look: ${truncate(failure, 140)}`,
      );

      if (phase === "ship") {
        state.lastApproval = approvalToken(bb) ?? state.lastApproval;
        consumeApproval(bb);
      }

      state.phaseFailures = 0;
      advance(state);
      saveState(bb, state);
      reporter.stateChanged?.(state, approvalPending(bb, state.lastApproval));
    } else {
      const backoff = Math.min(2 ** state.phaseFailures, 60);
      reporter.info(
        `Retrying "${phase}" in ${backoff}s (attempt ${state.phaseFailures + 1}/${MAX_RETRIES}).`,
      );
      await sleepUnlessStopping(backoff * 1000);
    }
  };

  const finishTurn = async (outcome: TurnOutcome) => {
    const { phase, res, role } = outcome;
    state.phaseFailures = 0;
    resumeSessionId = undefined;
    appendJournal(
      bb,
      `${role.name} (${phase}) done${costNote(res.costUsd)}: ${truncate(res.result)}`,
    );
    reporter.turnEnd({ costUsd: res.costUsd, numTurns: res.numTurns, ok: true });

    if (phase === "scaffold" || phase === "build" || phase === "playtest") {
      state.built = true;
    }

    if (phase === "ship") {
      recordShip(state);
      state.lastApproval = approvalToken(bb) ?? state.lastApproval;
      consumeApproval(bb);
    }

    advance(state);
    saveState(bb, state);
    reporter.stateChanged?.(state, approvalPending(bb, state.lastApproval));

    commitPhase(opts.workspace, `factory: ${role.name} ${phase} (cycle ${state.cycle})`);

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

  await repeatWhile(async () => {
    if (stopping) {
      return false;
    }

    const decision = await beforeTurn();

    if (decision === "stop") {
      return false;
    }

    if (decision === "skip") {
      return true;
    }

    const outcome = await runTurn();
    const { failure } = outcome;

    if (failure !== null && failure !== "") {
      await handleFailure(outcome, failure);

      return true;
    }

    return !(await finishTurn(outcome));
  });

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
