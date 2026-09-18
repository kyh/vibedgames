/**
 * The pilot loop: decide, apply, measure, repeat.
 *
 * There is no in-page hold. The decision call IS the hold — the previous
 * inputs stay down while the model answers, so the game runs continuously
 * and the tick rate is the model's latency (a few decisions a second), the
 * way a player holds a direction while deciding the next one. `tickMs` is a
 * floor for callers who want a slower player, never a fixed period.
 *
 * Attribution: the window `apply(n)` returns covers everything since
 * `apply(n-1)`, i.e. decision n-1's inputs for the whole time they were
 * held. Decision n's window arrives with `apply(n+1)` or `finish()`.
 */

import { setTimeout as delay } from "node:timers/promises";

import type { RouterInputs } from "@repo/api";

import type { JsonValue } from "../types.js";
import type { GameBrowser, Sample, Window } from "./browser.js";
import type { Controls, Decision } from "./controls.js";
import { asksToMove, buildQuestions, inputsFor, readDecision } from "./controls.js";

export const THRESHOLDS = {
  /** Mean `move` confidence below which the state is probably too thin to decide from. */
  confidence: 0.3,
  displacement: 5,
  /**
   * Frames a run must advance to count as alive — the bot's gate — capped by
   * `minFps` × the run's wall time, because a pilot run can legitimately be
   * a couple of seconds long where the scripted sweep is twelve.
   */
  framesAdvanced: 100,
  minFps: 10,
  /** Displacement (world units) below which a window counts as "didn't move". */
  motionEpsilon: 0.2,
  stuckRun: 2,
};

/** Positions kept in the state's `trail`, newest last. */
const TRAIL_LENGTH = 6;

/** How long the last decision is held before its window is read. */
const FINAL_HOLD_MS = 250;

export type DecideInput = RouterInputs["pilot"]["decide"];
export type Decide = (input: DecideInput) => Promise<JsonValue>;

export interface RunOptions {
  controls: Controls;
  expectProgress: boolean;
  model: string;
  tickMs: number;
  ticks: number;
}

const round = (value: number): number => Number(value.toFixed(2));

interface Metrics {
  distance: number;
  longestStuckRun: number;
  maxTickDisplacement: number;
  stuckRun: number;
  stuckTicks: number;
  tickOfFirstScore: number | null;
}

interface Outcome {
  progressed: boolean;
  stuck: boolean;
}

/** Fold one measured window into the running metrics. */
const measure = (
  metrics: Metrics,
  window: Window,
  decision: Decision,
  index: number,
  controls: Controls,
): Outcome => {
  metrics.distance += window.path;
  metrics.maxTickDisplacement = Math.max(metrics.maxTickDisplacement, window.peak);
  const progressed = window.score > window.scoreBefore;
  if (progressed && metrics.tickOfFirstScore === null) {
    metrics.tickOfFirstScore = index;
  }
  // Stuck signature: frames advanced, the pilot asked the player to move, and
  // nothing came of it. Counted as a RUN: one dead tick is a wall, several in
  // a row is a player wedged in geometry — or a pilot that keeps choosing the
  // wall, which the reflex exists to break.
  let stuck = false;
  if (asksToMove(controls, decision.move)) {
    stuck =
      window.frame > window.frameBefore && window.peak < THRESHOLDS.motionEpsilon && !progressed;
    if (stuck) {
      metrics.stuckTicks += 1;
      metrics.stuckRun += 1;
      metrics.longestStuckRun = Math.max(metrics.longestStuckRun, metrics.stuckRun);
    } else {
      metrics.stuckRun = 0;
    }
  }
  return { progressed, stuck };
};

/**
 * The reflex layer: a move that has produced nothing for two ticks running
 * is withdrawn from the next question. Only that one move — the model still
 * picks among the rest — and never so many that fewer than two remain.
 */
const reflexBlock = (
  controls: Controls,
  decision: Decision,
  stuck: boolean,
  stuckRun: number,
): Set<string> => {
  const blocked = new Set<string>();
  const enough = Object.keys(controls.move).length - 1 >= 2;
  if (stuck && stuckRun >= THRESHOLDS.stuckRun && decision.move !== "none" && enough) {
    blocked.add(decision.move);
  }
  return blocked;
};

const timelineEntry = (
  tick: number,
  decision: Decision,
  decisionMs: number,
  window: Window,
  progressed: boolean,
  stuck: boolean,
) => ({
  actionProbabilities: decision.actionProbabilities,
  actions: decision.actions,
  confidence: decision.confidence,
  decisionMs,
  frames: window.frame - window.frameBefore,
  move: decision.move,
  path: window.path,
  peak: window.peak,
  progressed,
  scoreDelta: window.score - window.scoreBefore,
  stuck,
  tick,
});

type TimelineEntry = ReturnType<typeof timelineEntry>;

interface Pending {
  decision: Decision;
  decisionMs: number;
  tick: number;
}

interface Latest {
  window: Window | null;
}

export interface Verdict {
  failures: string[];
  warnings: string[];
}

/** Per-run histograms of what the pilot chose, and how sure it was about moving. */
const summarizeDecisions = (timeline: TimelineEntry[]) => {
  const moves: Record<string, number> = {};
  const actions: Record<string, number> = {};
  let confidenceSum = 0;
  let confidenceCount = 0;
  for (const entry of timeline) {
    moves[entry.move] = (moves[entry.move] ?? 0) + 1;
    for (const label of entry.actions) {
      actions[label] = (actions[label] ?? 0) + 1;
    }
    if (entry.confidence !== null) {
      confidenceSum += entry.confidence;
      confidenceCount += 1;
    }
  }
  return {
    actions,
    meanConfidence: confidenceCount > 0 ? round(confidenceSum / confidenceCount) : null,
    moves,
  };
};

export interface RunResult {
  completedAtTick: number | null;
  lastWindow: Window | null;
  metrics: Metrics;
  timeline: TimelineEntry[];
  usage: {
    calls: number;
    inputTokens: number;
    maxDecisionMs: number;
    outputTokens: number;
    totalDecisionMs: number;
  };
  wallMs: number;
}

/** Decide, apply, measure — `ticks` times, or until the game reports `complete`. */
export const runTicks = async (
  browser: GameBrowser,
  opts: RunOptions,
  decide: Decide,
): Promise<RunResult> => {
  const { controls } = opts;
  const started = Date.now();
  const metrics: Metrics = {
    distance: 0,
    longestStuckRun: 0,
    maxTickDisplacement: 0,
    stuckRun: 0,
    stuckTicks: 0,
    tickOfFirstScore: null,
  };
  const usage = { calls: 0, inputTokens: 0, maxDecisionMs: 0, outputTokens: 0, totalDecisionMs: 0 };
  const timeline: TimelineEntry[] = [];
  const trail: { x: number; y: number; z: number }[] = [];
  let game = browser.start();
  let pending: Pending | null = null;
  // Assigned inside `settle`, so held in an object: control flow can't see a
  // closure's writes and would narrow a plain `let` to null at every read.
  const latest: Latest = { window: null };
  let completedAtTick: number | null = null;
  let blocked = new Set<string>();
  let appliedAt = Date.now();

  const settle = (window: Window): void => {
    if (!pending) {
      return;
    }
    const { progressed, stuck } = measure(
      metrics,
      window,
      pending.decision,
      pending.tick,
      controls,
    );
    timeline.push(
      timelineEntry(pending.tick, pending.decision, pending.decisionMs, window, progressed, stuck),
    );
    blocked = reflexBlock(controls, pending.decision, stuck, metrics.stuckRun);
    trail.push({ x: round(window.x), y: round(window.y), z: round(window.z) });
    if (trail.length > TRAIL_LENGTH) {
      trail.shift();
    }
    latest.window = window;
  };

  for (let tick = 0; tick < opts.ticks; tick += 1) {
    const state = {
      game,
      goal: controls.goal,
      recent: {
        blockedMoves: [...blocked],
        held: pending ? { actions: pending.decision.actions, move: pending.decision.move } : null,
        movedLastTick: latest.window ? latest.window.peak : null,
        scoreDeltaLastTick: latest.window ? latest.window.score - latest.window.scoreBefore : null,
        stuckTicksInARow: metrics.stuckRun,
        trail,
      },
      tick: { index: tick, of: opts.ticks },
    };
    const questions = buildQuestions(controls, blocked);
    const t0 = Date.now();
    const decision = readDecision(
      await decide({ model: opts.model, questions, state }),
      controls,
      questions,
    );
    const decisionMs = Date.now() - t0;
    usage.calls += 1;
    usage.inputTokens += decision.inputTokens;
    usage.outputTokens += decision.outputTokens;
    usage.totalDecisionMs += decisionMs;
    usage.maxDecisionMs = Math.max(usage.maxDecisionMs, decisionMs);

    // A floor on how long the previous inputs stay down, for a slower player.
    const remaining = opts.tickMs - (Date.now() - appliedAt);
    if (remaining > 0) {
      await delay(remaining);
    }

    const result = browser.apply(inputsFor(controls, decision));
    appliedAt = Date.now();
    settle(result.window);
    pending = { decision, decisionMs, tick };
    ({ game } = result);
    if (result.window.complete) {
      // The game ended under the previous decision's inputs; this one never
      // got a window and is not counted.
      completedAtTick = Math.max(0, tick - 1);
      pending = null;
      break;
    }
  }

  // The last decision needs a hold of its own before its window can be read.
  if (pending) {
    await delay(Math.max(opts.tickMs, FINAL_HOLD_MS));
  }
  const tail = browser.finish();
  if (tail && pending) {
    settle(tail);
    if (tail.complete && completedAtTick === null) {
      completedAtTick = pending.tick;
    }
  }

  return {
    completedAtTick,
    lastWindow: latest.window,
    metrics,
    timeline,
    usage,
    wallMs: Date.now() - started,
  };
};

export interface ReportInputs {
  before: Sample;
  consoleErrors: string[];
  gpu: { renderer: string | null; softwareRendered: boolean | null; vendor: string | null };
  pageErrors: JsonValue[];
  run: RunResult;
  seed: number;
  seedApplied: string;
  target: string;
}

export const buildReport = (opts: RunOptions, input: ReportInputs) => {
  const { before, run } = input;
  const last = run.lastWindow;
  const seconds = run.wallMs / 1000;
  return {
    complete: last ? last.complete : before.complete,
    completedAtTick: run.completedAtTick,
    consoleErrors: input.consoleErrors,
    decisions: summarizeDecisions(run.timeline),
    decisionsPerSecond: seconds > 0 ? round(run.timeline.length / seconds) : null,
    distanceTravelled: round(run.metrics.distance),
    framesAdvanced: (last ? last.frame : before.frame) - before.frame,
    goal: opts.controls.goal,
    // Which GPU rasterized the run. Under software rendering the functional
    // checks still hold; any frame-rate read from the run does not.
    gpu: input.gpu,
    longestStuckRun: run.metrics.longestStuckRun,
    maxTickDisplacement: round(run.metrics.maxTickDisplacement),
    model: {
      calls: run.usage.calls,
      id: opts.model,
      inputTokens: run.usage.inputTokens,
      maxDecisionMs: run.usage.maxDecisionMs,
      meanDecisionMs:
        run.usage.calls > 0 ? Math.round(run.usage.totalDecisionMs / run.usage.calls) : null,
      outputTokens: run.usage.outputTokens,
    },
    pageErrors: input.pageErrors,
    scoreAfter: last ? last.score : before.score,
    scoreBefore: before.score,
    seed: input.seed,
    // How the seed actually landed, so a reader can tell a real seeded run
    // from one where the hook quietly did nothing.
    seedApplied: input.seedApplied,
    stuckTicks: run.metrics.stuckTicks,
    target: input.target,
    tickMs: opts.tickMs,
    tickOfFirstScore: run.metrics.tickOfFirstScore,
    ticks: opts.ticks,
    ticksRun: run.timeline.length,
    timeline: run.timeline,
    wallMs: run.wallMs,
  };
};

export type Report = ReturnType<typeof buildReport>;

/** Failures fail the run; warnings are findings a reader should weigh. */
export const verdict = (report: Report, opts: RunOptions): Verdict => {
  const failures: string[] = [];
  const warnings: string[] = [];
  const framesRequired = Math.min(
    THRESHOLDS.framesAdvanced,
    Math.round((report.wallMs / 1000) * THRESHOLDS.minFps),
  );
  if (report.framesAdvanced <= framesRequired) {
    failures.push(
      `game loop stalled (framesAdvanced ${report.framesAdvanced} over ${report.wallMs} ms)`,
    );
  }
  // Gated on the largest displacement any ONE tick achieved, not on the
  // summed path: path accumulates every sampled wobble, and an idle bob
  // would drift past a total-distance threshold.
  if (report.maxTickDisplacement <= THRESHOLDS.displacement) {
    failures.push(
      `player did not respond to input (maxTickDisplacement ${report.maxTickDisplacement}) — if this game steers with the mouse, give it pointer moves in __GAME_PILOT__ or --controls`,
    );
  }
  if (report.longestStuckRun > THRESHOLDS.stuckRun) {
    failures.push(
      `player wedged for ${report.longestStuckRun} consecutive movement ticks (longestStuckRun) — the pilot kept choosing moves that went nowhere`,
    );
  }
  if (report.scoreAfter <= report.scoreBefore) {
    const message = "the run never progressed the objective";
    if (opts.expectProgress) {
      failures.push(message);
    } else {
      warnings.push(
        `${message} — pass --expect-progress once the controls express this game's scoring verb, to make that an assertion`,
      );
    }
  }
  if (report.completedAtTick !== null) {
    warnings.push(
      `the run ended at tick ${report.completedAtTick} of ${opts.ticks} (complete became true) — a win, or a fail state the pilot couldn't avoid; read the timeline to tell which`,
    );
  }
  const { meanConfidence } = report.decisions;
  if (meanConfidence !== null && meanConfidence < THRESHOLDS.confidence) {
    warnings.push(
      `the model was rarely sure which way to move (mean confidence ${meanConfidence}) — the diagnostics probably don't expose what a player sees; add hazards, goals and nearby entities with positions to __GAME_DIAGNOSTICS__`,
    );
  }
  if (report.consoleErrors.length > 0) {
    failures.push(`${report.consoleErrors.length} console error(s)`);
  }
  if (report.pageErrors.length > 0) {
    failures.push(`${report.pageErrors.length} uncaught page error(s)`);
  }
  return { failures, warnings };
};
