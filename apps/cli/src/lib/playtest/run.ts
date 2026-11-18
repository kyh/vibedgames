import { setTimeout as delay } from "node:timers/promises";

import type { JsonValue } from "../types.js";
import { isJsonObject, isJsonString } from "../types.js";
import type { AgentConfig, AgentRecord } from "./agent.js";
import { browserEnv, inPageAgent } from "./agent.js";
import type { GameBrowser, Sample, Window } from "./browser.js";
import type { Controls } from "./controls.js";
import { HarnessError } from "./errors.js";
import { keyInitsFor, keyTable } from "./keys.js";

export const THRESHOLDS = {
  /** Mean `move` confidence below which the state is probably too thin to decide from. */
  confidence: 0.3,
  displacement: 5,
  /**
   * Frames a run must advance to count as alive — the bot's gate — capped by
   * `minFps` × the run's wall time, because a model run can legitimately be
   * a couple of seconds long where the scripted sweep is twelve.
   */
  framesAdvanced: 100,
  /** Decisions a rested no-input option stays out of the question. */
  idleRestTicks: 8,
  /** Idle decisions in a row (holding nothing, going nowhere) before the no-input option is rested. */
  idleRun: 3,
  minFps: 10,
  /**
   * A window counts as "didn't move" below this fraction of the displacement
   * gate, so both scale together when a game measures in world units.
   */
  motionEpsilonRatio: 0.04,
  /** Stuck ticks in a row after which the agent withdraws the move. */
  stuckRun: 2,
  /**
   * Stuck ticks in a row that fail the run. The decision after a withdrawal
   * was already in flight when it landed, so `stuckRun + 1` is what hitting
   * one wall costs; past that the alternatives went nowhere too.
   */
  wedgedRun: 5,
};

/** The input-alive gate for this scheme, in the game's own `player` units. */
export const displacementGate = (controls: Controls) =>
  controls.minDisplacement ?? THRESHOLDS.displacement;

const motionEpsilon = (controls: Controls) =>
  displacementGate(controls) * THRESHOLDS.motionEpsilonRatio;

/** A yes/no answer at or above this probability is acted on. */
export const ACTION_THRESHOLD = 0.5;
const TRAIL_LENGTH = 6;
const FINAL_HOLD_MS = 250;
const DECISION_RETRIES = 2;
const DECISION_TIMEOUT_MS = 10_000;
const POLL_MS = 250;

export interface RunOptions {
  controls: Controls;
  /** A move to hold for the whole run without calling the model, or null. */
  pinMove: string | null;
  expectProgress: boolean;
  model: string;
  tickMs: number;
  ticks: number;
}

export interface Session {
  decideUrl: string;
  token: string;
}

const round = (value: number) => Number(value.toFixed(2));

/** The agent's config for this scheme: every key pre-resolved to a proper event init. */
export const agentConfig = (opts: RunOptions, session: Session) => {
  const move: AgentConfig["move"] = {};

  for (const [label, option] of Object.entries(opts.controls.move)) {
    move[label] = {
      description: option.description,
      inits: keyInitsFor(option.keys),
      pointer: option.pointer
        ? { down: option.pointer.down === true, x: option.pointer.x, y: option.pointer.y }
        : null,
    };
  }

  const actions: AgentConfig["actions"] = {};

  for (const [label, action] of Object.entries(opts.controls.actions)) {
    actions[label] = { description: action.description, inits: keyInitsFor(action.keys) };
  }

  return {
    actionThreshold: ACTION_THRESHOLD,
    actions,
    decideUrl: session.decideUrl,
    decisionRetries: DECISION_RETRIES,
    decisionTimeoutMs: DECISION_TIMEOUT_MS,
    finalHoldMs: FINAL_HOLD_MS,
    goal: opts.controls.goal,
    idleRestTicks: THRESHOLDS.idleRestTicks,
    idleRun: THRESHOLDS.idleRun,
    keyTable: keyTable(),
    model: opts.model,
    motionEpsilon: motionEpsilon(opts.controls),
    move,
    pinMove: opts.pinMove,
    stuckRun: THRESHOLDS.stuckRun,
    tickMs: opts.tickMs,
    ticks: opts.ticks,
    token: session.token,
    trailLength: TRAIL_LENGTH,
  };
};

/**
 * The agent as page source: its own function text applied to the config and
 * to the real-browser env. Both functions are self-contained by contract, so
 * their `toString()` is all the page needs.
 */
export const agentSource = (config: AgentConfig) =>
  `(${inPageAgent.toString()})(${JSON.stringify(config)}, (${browserEnv.toString()})())`;

const budgetMs = (opts: RunOptions) =>
  opts.ticks * (Math.max(opts.tickMs, 150) + DECISION_TIMEOUT_MS + 3500) + FINAL_HOLD_MS + 15_000;

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

const measure = (
  metrics: Metrics,
  window: Window,
  askedToMove: boolean,
  index: number,
  epsilon: number,
) => {
  metrics.distance += window.path;
  metrics.maxTickDisplacement = Math.max(metrics.maxTickDisplacement, window.peak);
  const progressed = window.score > window.scoreBefore;

  if (progressed && metrics.tickOfFirstScore === null) {
    metrics.tickOfFirstScore = index;
  }

  let stuck = false;

  if (askedToMove) {
    stuck = window.frame > window.frameBefore && window.peak < epsilon && !progressed;

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

const timelineEntry = (record: AgentRecord, progressed: boolean, stuck: boolean) => ({
  actionProbabilities: record.actionProbabilities,
  actions: record.actions,
  confidence: record.confidence,
  decisionMs: record.decisionMs,
  frames: record.window.frame - record.window.frameBefore,
  move: record.move,
  path: record.window.path,
  peak: record.window.peak,
  progress: record.progress,
  progressed,
  reflexFrames: record.reflexFrames,
  scoreDelta: record.window.score - record.window.scoreBefore,
  stuck,
  tick: record.tick,
});

type TimelineEntry = ReturnType<typeof timelineEntry>;

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

const num = (value: JsonValue | undefined) => (Number.isFinite(value) ? Number(value) : 0);

const readWindow = (value: JsonValue | undefined) => {
  if (!isJsonObject(value)) {
    return null;
  }

  return {
    complete: value.complete === true,
    frame: num(value.frame),
    frameBefore: num(value.frameBefore),
    path: num(value.path),
    peak: num(value.peak),
    score: num(value.score),
    scoreBefore: num(value.scoreBefore),
    x: num(value.x),
    y: num(value.y),
    z: num(value.z),
  };
};

const readRecord = (value: JsonValue) => {
  const window = isJsonObject(value) ? readWindow(value.window) : null;

  if (!isJsonObject(value) || !window || !isJsonString(value.move)) {
    throw new HarnessError(
      `the agent published a malformed record: ${JSON.stringify(value).slice(0, 200)}`,
    );
  }

  const probabilities: Record<string, number> = {};

  if (isJsonObject(value.actionProbabilities)) {
    for (const [label, probability] of Object.entries(value.actionProbabilities)) {
      probabilities[label] = num(probability);
    }
  }

  return {
    actionProbabilities: probabilities,
    actions: Array.isArray(value.actions) ? value.actions.filter(isJsonString) : [],
    askedToMove: value.askedToMove === true,
    confidence: Number.isFinite(value.confidence) ? Number(value.confidence) : null,
    decisionMs: num(value.decisionMs),
    inputTokens: num(value.inputTokens),
    move: value.move,
    outputTokens: num(value.outputTokens),
    progress: Number.isFinite(value.progress) ? Number(value.progress) : null,
    reflexFrames: num(value.reflexFrames),
    tick: num(value.tick),
    window,
  };
};

/** The agent's records, folded into metrics and a timeline. */
export const resultFromAgent = (
  published: JsonValue,
  epsilon = THRESHOLDS.displacement * THRESHOLDS.motionEpsilonRatio,
) => {
  if (!isJsonObject(published)) {
    throw new HarnessError("the page lost the agent before its result could be read.");
  }

  if (isJsonString(published.error)) {
    throw new HarnessError(published.error);
  }

  const records = Array.isArray(published.records) ? published.records.map(readRecord) : [];

  const metrics: Metrics = {
    distance: 0,
    longestStuckRun: 0,
    maxTickDisplacement: 0,
    stuckRun: 0,
    stuckTicks: 0,
    tickOfFirstScore: null,
  };

  const timeline: TimelineEntry[] = [];
  const usage = { calls: 0, inputTokens: 0, maxDecisionMs: 0, outputTokens: 0, totalDecisionMs: 0 };
  let lastWindow: Window | null = null;

  for (const record of records) {
    const { progressed, stuck } = measure(
      metrics,
      record.window,
      record.askedToMove,
      record.tick,
      epsilon,
    );

    timeline.push(timelineEntry(record, progressed, stuck));
    usage.calls += 1;
    usage.inputTokens += record.inputTokens;
    usage.outputTokens += record.outputTokens;
    usage.totalDecisionMs += record.decisionMs;
    usage.maxDecisionMs = Math.max(usage.maxDecisionMs, record.decisionMs);
    lastWindow = record.window;
  }

  return {
    completedAtTick: Number.isFinite(published.completedAtTick)
      ? Number(published.completedAtTick)
      : null,
    lastWindow,
    metrics,
    timeline,
    usage,
    wallMs: num(published.wallMs),
  };
};

/** Inject the agent, wait for it to finish, and read its result. */
export const runInPage = async (browser: GameBrowser, opts: RunOptions, session: Session) => {
  browser.inject(agentSource(agentConfig(opts, session)));
  const deadline = Date.now() + budgetMs(opts);

  for (;;) {
    const status = browser.agentStatus();

    if (!status) {
      throw new HarnessError("the page lost the agent; it probably navigated mid-run.");
    }

    if (status.done) {
      break;
    }

    if (Date.now() > deadline) {
      browser.stopAgent();
      throw new HarnessError(
        `the run did not finish within ${Math.round(budgetMs(opts) / 1000)} s.`,
      );
    }

    await delay(POLL_MS);
  }

  return resultFromAgent(browser.agentResult(), motionEpsilon(opts.controls));
};

const summarizeProgress = (timeline: TimelineEntry[]) => {
  const scored = timeline.map((entry) => entry.progress).filter((p) => p !== null);
  const [first] = scored;
  const last = scored.at(-1);

  if (first === undefined || last === undefined) {
    return null;
  }

  let sum = 0;
  let max = 0;

  for (const value of scored) {
    sum += value;
    max = Math.max(max, value);
  }

  return {
    first: round(first),
    last: round(last),
    max: round(max),
    mean: round(sum / scored.length),
  };
};

const summarizeDecisions = (timeline: TimelineEntry[]) => {
  const moves: Record<string, number> = {};
  const actions: Record<string, number> = {};
  let confidenceSum = 0;
  let confidenceCount = 0;
  let reflexFrames = 0;

  for (const entry of timeline) {
    moves[entry.move] = (moves[entry.move] ?? 0) + 1;

    for (const label of entry.actions) {
      actions[label] = (actions[label] ?? 0) + 1;
    }

    if (entry.confidence !== null) {
      confidenceSum += entry.confidence;
      confidenceCount += 1;
    }

    reflexFrames += entry.reflexFrames;
  }

  return {
    actions,
    meanConfidence: confidenceCount > 0 ? round(confidenceSum / confidenceCount) : null,
    moves,
    progress: summarizeProgress(timeline),
    reflexFrames,
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
    gpu: input.gpu,
    longestStuckRun: run.metrics.longestStuckRun,
    maxTickDisplacement: round(run.metrics.maxTickDisplacement),
    minDisplacement: displacementGate(opts.controls),
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

export interface Verdict {
  failures: string[];
  warnings: string[];
}

/** Failures fail the run; warnings are findings a reader should weigh. */
export const verdict = (report: Report, opts: RunOptions) => {
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

  const gate = displacementGate(opts.controls);

  const holdsInput = (label: string) => {
    const option = opts.controls.move[label];

    return (
      option !== undefined && (option.keys.length > 0 || option.pointer !== null || option.reflex)
    );
  };

  const triedToMove = report.timeline.some((entry) => holdsInput(entry.move));

  if (!triedToMove && report.timeline.length > 0) {
    failures.push(
      "the model never chose a movement — every decision held nothing. The diagnostics gave it no reason to go anywhere: expose where the goal, threats and pickups are (dx/dy from the player) in __GAME_DIAGNOSTICS__, and say which way progress is in the goal",
    );
  } else if (report.maxTickDisplacement <= gate) {
    failures.push(
      `player did not respond to input (maxTickDisplacement ${report.maxTickDisplacement}, needs > ${gate}) — if this game steers with the mouse, give it pointer moves in __GAME_PLAYTEST__ or --controls; if \`player\` is in world units rather than pixels, set \`minDisplacement\` in __GAME_PLAYTEST__ or pass --min-displacement`,
    );
  }

  if (report.longestStuckRun >= THRESHOLDS.wedgedRun) {
    failures.push(
      `player wedged for ${report.longestStuckRun} consecutive movement ticks (longestStuckRun) — the model kept choosing moves that went nowhere`,
    );
  }

  if (report.scoreAfter <= report.scoreBefore) {
    const { progress } = report.decisions;
    let judged = "";

    if (progress !== null) {
      const trend = `progress ${progress.first} → ${progress.last}`;
      judged =
        progress.last > progress.first
          ? ` (though the model judged the player closer to the goal by the end: ${trend})`
          : ` (and the model agreed: ${trend})`;
    }

    const message = `the run never progressed the objective${judged}`;

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
      `the run ended at tick ${report.completedAtTick} of ${opts.ticks} (complete became true) — a win, or a fail state the playtester couldn't avoid; read the timeline to tell which`,
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
