#!/usr/bin/env node
/**
 * pilot-playtest — let a model PLAY a browser game, and measure how it went.
 *
 * Each tick the pilot reads window.__GAME_DIAGNOSTICS__, asks Jev (TypeSafe's
 * decision-only model) which movement to hold and which actions to take,
 * dispatches those as real held input, and repeats. Code does perception and
 * keystrokes; the model only decides. The report carries the same play metrics
 * as bot-playtest.mjs — loop alive, input alive, objective reachable, no
 * softlocks, no errors — plus what the pilot chose, how sure it was, and what
 * that cost.
 *
 * Zero dependencies. Shells out to `vg playtest` (agent-browser) and calls the
 * TypeSafe API directly. Needs TYPESAFE_API_KEY (https://console.typesafe.ai).
 * The game must expose the diagnostics contract — see references/bot-playtest.md;
 * the pilot itself is documented in references/pilot-playtest.md.
 *
 *   node pilot-playtest.mjs --url http://localhost:5173
 *   node pilot-playtest.mjs --game my-game --seed 42 --ticks 120
 *   node pilot-playtest.mjs --url http://localhost:5173 --controls ./controls.json
 *   node pilot-playtest.mjs --url http://localhost:5173 --goal "Reach the exit on the right"
 *
 * Flags: --url <url> | --game <slug>, --seed <n>, --ticks <n> (default 60),
 * --tick-ms <ms> (default 300), --controls <wasd|arrows|path>, --goal <text>,
 * --model <id> (default jev-latest), --expect-progress, --headed, --keep-open.
 *
 * Exit 0 = the game plays under the pilot. Exit 1 = it doesn't (the report says
 * why). Exit 2 = the harness itself failed (no API key, browser missing, game
 * never booted, model unreachable).
 */

import { readFileSync } from "node:fs";

import {
  READ_FN,
  TRACK_BEGIN_BODY,
  claimHeld,
  collectErrors,
  disownHeld,
  evaluate,
  fail,
  isPlainObject,
  isString,
  keyFields,
  keyParts,
  launch,
  playtest,
  pointerParts,
  printHelp,
  readGpuInfo,
  setProgramName,
  sleep,
  validatePointer,
} from "./lib/harness.mjs";

setProgramName("pilot-playtest");

const THRESHOLDS = {
  /** Mean `move` confidence below which the state is probably too thin to decide from. */
  confidence: 0.3,
  displacement: 5,
  framesAdvanced: 100,
  /** Displacement (world units) below which a tick counts as "didn't move". */
  motionEpsilon: 0.2,
  stuckRun: 2,
};

/** A yes/no answer at or above this probability is acted on. */
const ACTION_THRESHOLD = 0.5;

/**
 * Bounds on one hold. Below ~80ms a down/up pair can fall between rAF samples
 * and edge-triggered input never sees it; above a few seconds the in-page
 * await outlives agent-browser's eval timeout and the tick dies as a harness
 * failure rather than a slow decision.
 */
const TICK_MS = { max: 5000, min: 80 };

/** Positions kept in the state's `trail`, newest last. */
const TRAIL_LENGTH = 6;

const DECISION_TIMEOUT_MS = 10_000;
const DECISION_RETRIES = 2;

const DEFAULT_GOAL =
  "Play the game well: stay alive, keep moving through the level, raise the score, and avoid whatever the state marks as hazards, enemies or damage.";

const NONE = { description: "Hold no movement input — stay still", keys: [] };

const directions = (up, down, left, right) => ({
  down: { description: "Move down / backward", keys: [down] },
  down_left: { description: "Move diagonally down and left", keys: [down, left] },
  down_right: { description: "Move diagonally down and right", keys: [down, right] },
  left: { description: "Move left", keys: [left] },
  none: NONE,
  right: { description: "Move right", keys: [right] },
  up: { description: "Move up / forward", keys: [up] },
  up_left: { description: "Move diagonally up and left", keys: [up, left] },
  up_right: { description: "Move diagonally up and right", keys: [up, right] },
});

const ACTION_PRESET = {
  action: { description: "press the action key (jump, fire or confirm)", keys: ["Space"] },
};

/** Built-in control schemes. A `--controls` path replaces the whole scheme. */
const PRESETS = {
  arrows: {
    actions: ACTION_PRESET,
    goal: DEFAULT_GOAL,
    move: directions("ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"),
  },
  wasd: {
    actions: ACTION_PRESET,
    goal: DEFAULT_GOAL,
    move: directions("KeyW", "KeyS", "KeyA", "KeyD"),
  },
};

const parseArgs = (argv) => {
  const opts = {
    controls: PRESETS.wasd,
    expectProgress: false,
    game: null,
    goal: null,
    headed: false,
    keepOpen: false,
    model: "jev-latest",
    seed: 12_345,
    tickMs: 300,
    ticks: 60,
    url: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const takeValue = () => {
      const value = argv[i + 1];
      if (value === undefined) {
        fail(`\`${arg}\` needs a value.`);
      }
      i += 1;
      return value;
    };
    // `Number("")` is 0, not NaN, so an empty value would slip past the finite
    // checks below and silently seed with 0 instead of saying anything.
    const num = () => {
      const raw = takeValue();
      return raw.trim() === "" ? Number.NaN : Number(raw);
    };
    if (arg === "--url") {
      opts.url = takeValue();
    } else if (arg === "--game") {
      opts.game = takeValue();
    } else if (arg === "--seed") {
      opts.seed = num();
    } else if (arg === "--ticks") {
      opts.ticks = num();
    } else if (arg === "--tick-ms") {
      opts.tickMs = num();
    } else if (arg === "--controls") {
      opts.controls = readControls(takeValue());
    } else if (arg === "--goal") {
      opts.goal = takeValue();
    } else if (arg === "--model") {
      opts.model = takeValue();
    } else if (arg === "--expect-progress") {
      opts.expectProgress = true;
    } else if (arg === "--headed") {
      opts.headed = true;
    } else if (arg === "--keep-open") {
      opts.keepOpen = true;
    } else if (arg === "--help" || arg === "-h") {
      printHelp(import.meta.filename);
      process.exit(0);
    } else {
      fail(`Unknown argument: ${arg}`);
    }
  }
  return validateOpts(opts);
};

const validateOpts = (opts) => {
  if (!opts.url && !opts.game) {
    fail("Pass --url <url> or --game <slug>.");
  }
  if (opts.url && opts.game) {
    fail("Pass either --url or --game, not both.");
  }
  if (!Number.isFinite(opts.seed)) {
    fail("`--seed` must be a finite number.");
  }
  if (!Number.isInteger(opts.ticks) || opts.ticks <= 0) {
    fail("`--ticks` must be a positive integer.");
  }
  if (!Number.isFinite(opts.tickMs) || opts.tickMs < TICK_MS.min || opts.tickMs > TICK_MS.max) {
    fail(`\`--tick-ms\` must be between ${TICK_MS.min} and ${TICK_MS.max} milliseconds.`);
  }
  if (opts.goal !== null && opts.goal.trim() === "") {
    fail("`--goal` must not be empty.");
  }
  if (opts.model.trim() === "") {
    fail("`--model` must not be empty.");
  }
  validateControls(opts.controls);
  if (opts.goal !== null) {
    opts.controls = { ...opts.controls, goal: opts.goal };
  }
  // Checked last so a bad flag is reported as a bad flag, and checked before
  // anything launches: a missing key would otherwise surface on the first
  // decision, after a browser start and a seeded boot.
  if (!process.env.TYPESAFE_API_KEY) {
    fail(
      "TYPESAFE_API_KEY is not set. The pilot's decisions come from Jev (TypeSafe) — create a key at https://console.typesafe.ai/settings/keys and export it.",
    );
  }
  return opts;
};

/**
 * Resolve `--controls`: a preset name, or a JSON file. A missing path or
 * malformed JSON is a mistake in the command, not a crash.
 */
const readControls = (value) => {
  if (Object.hasOwn(PRESETS, value)) {
    return PRESETS[value];
  }
  let text;
  try {
    text = readFileSync(value, "utf-8");
  } catch {
    fail(
      `couldn't read --controls ${value} (not a preset — those are ${Object.keys(PRESETS).join(", ")} — and not a readable file).`,
    );
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    fail(`--controls ${value} isn't valid JSON: ${error.message}`);
  }
};

const validateOption = (option, where, allowPointer) => {
  if (!isPlainObject(option)) {
    fail(`${where} must be an object with a \`description\`.`);
  }
  if (!isString(option.description) || option.description.trim() === "") {
    fail(`${where} needs a non-empty \`description\` — that is what the model decides from.`);
  }
  const keys = option.keys ?? [];
  if (!Array.isArray(keys)) {
    fail(`${where}: \`keys\` must be an array.`);
  }
  // Throws (exit 2) naming the offending code.
  for (const code of keys) {
    keyFields(code);
  }
  if (option.pointer !== undefined) {
    if (!allowPointer) {
      fail(
        `${where}: actions are keys only. A pointer belongs in a \`move\` option (aim-and-thrust games put \`down: true\` there).`,
      );
    }
    if (!isPlainObject(option.pointer)) {
      fail(`${where}: \`pointer\` must be an object.`);
    }
    validatePointer(option.pointer, where);
  }
};

/**
 * Check a control scheme before anything launches — an unsupported key code
 * or a shapeless option would otherwise surface mid-run, after a browser start
 * and a seeded reload, dressed up as a harness failure.
 */
const validateControls = (controls) => {
  if (!isPlainObject(controls)) {
    fail("`--controls` must be a JSON object with `move` (and optionally `actions`, `goal`).");
  }
  if (controls.goal !== undefined && (!isString(controls.goal) || controls.goal.trim() === "")) {
    fail("controls: `goal` must be a non-empty string.");
  }
  if (!isPlainObject(controls.move) || Object.keys(controls.move).length === 0) {
    fail("controls: `move` must map at least one option label to { description, keys | pointer }.");
  }
  let movers = 0;
  for (const [label, option] of Object.entries(controls.move)) {
    validateOption(option, `controls.move.${label}`, true);
    if ((option.keys ?? []).length > 0 || option.pointer) {
      movers += 1;
    }
  }
  if (movers === 0) {
    fail("controls: no `move` option holds any input, so the pilot could never move.");
  }
  // A no-input option is what the reflex falls back to when it blocks a move,
  // and what "do nothing" means to the model — supplied when the scheme omits it.
  if (!Object.hasOwn(controls.move, "none")) {
    controls.move = { none: NONE, ...controls.move };
  }
  if (controls.actions === undefined) {
    controls.actions = {};
  }
  if (!isPlainObject(controls.actions)) {
    fail("controls: `actions` must map option labels to { description, keys }.");
  }
  for (const [label, option] of Object.entries(controls.actions)) {
    validateOption(option, `controls.actions.${label}`, false);
    if ((option.keys ?? []).length === 0) {
      fail(`controls.actions.${label} needs a non-empty \`keys\` array.`);
    }
  }
  if (controls.goal === undefined) {
    controls.goal = DEFAULT_GOAL;
  }
};

/** Question key for an action, kept off `move`'s namespace. */
const actionKey = (label) => `act:${label}`;

/**
 * The questions Jev answers each tick, all in one call. `blocked` moves are
 * left out of the criteria rather than discouraged in prose: the model cannot
 * answer outside its schema, so omission is the one reflex that always lands.
 */
const buildQuestions = (controls, tickMs, blocked) => {
  const criteria = {};
  for (const [label, option] of Object.entries(controls.move)) {
    if (!blocked.has(label)) {
      criteria[label] = option.description;
    }
  }
  const questions = {
    move: {
      criteria,
      instructions: `Which movement input should the player hold for the next ${tickMs} ms to pursue \`goal\`? Decide from \`game\` (the live state) and \`recent\` (what the last inputs achieved). Options that recently produced no movement have been removed.`,
      type: "choice",
    },
  };
  for (const [label, action] of Object.entries(controls.actions)) {
    questions[actionKey(label)] = {
      criteria: { false: "Not now", true: "Yes, do it during the next tick" },
      instructions: `Given \`game\` and \`goal\`, should the player ${action.description} right now?`,
      type: "noul",
    };
  }
  return questions;
};

const baseUrl = () =>
  (process.env.TYPESAFE_BASE_URL ?? "https://api.typesafe.ai").replace(/\/$/u, "");

/**
 * One decision round-trip. Retries a rate limit, an overload or a dropped
 * connection a couple of times with backoff; anything else is a harness
 * failure naming the status, because a pilot with no decisions plays nothing.
 */
const decide = async (opts, state, questions) => {
  const url = `${baseUrl()}/v1/systemone`;
  const request = JSON.stringify({ model: opts.model, questions, state });
  for (let attempt = 0; attempt <= DECISION_RETRIES; attempt += 1) {
    let res;
    try {
      res = await fetch(url, {
        body: request,
        headers: {
          Authorization: `Bearer ${process.env.TYPESAFE_API_KEY}`,
          "Content-Type": "application/json",
        },
        method: "POST",
        signal: AbortSignal.timeout(DECISION_TIMEOUT_MS),
      });
    } catch (error) {
      if (attempt === DECISION_RETRIES) {
        fail(`couldn't reach the decision model at ${url}: ${error.message}`);
      }
      sleep(500 * 2 ** attempt);
      continue;
    }
    if (res.ok) {
      return res.json();
    }
    const retryable = res.status === 429 || res.status >= 500;
    const body = await res.text();
    const text = body.slice(0, 300);
    if (retryable && attempt < DECISION_RETRIES) {
      sleep(500 * 2 ** attempt);
      continue;
    }
    const hint = res.status === 401 ? " — check TYPESAFE_API_KEY" : "";
    fail(`decision model returned HTTP ${res.status}${hint}: ${text}`);
  }
  return null;
};

/** Read the answers into a decision, refusing any shape outside the schema asked for. */
const readDecision = (response, controls, questions) => {
  const answers = response?.answers;
  if (!isPlainObject(answers)) {
    fail(`decision model returned no answers: ${JSON.stringify(response).slice(0, 300)}`);
  }
  const { move } = answers;
  if (
    !isPlainObject(move) ||
    !isString(move.choice) ||
    !Object.hasOwn(questions.move.criteria, move.choice)
  ) {
    fail(`decision model answered \`move\` outside the offered options: ${JSON.stringify(move)}`);
  }
  const actions = [];
  const probabilities = {};
  for (const label of Object.keys(controls.actions)) {
    const answer = answers[actionKey(label)];
    if (!isPlainObject(answer) || !Number.isFinite(answer.noul)) {
      fail(`decision model answered \`${label}\` without a probability: ${JSON.stringify(answer)}`);
    }
    probabilities[label] = Number(answer.noul.toFixed(3));
    if (answer.noul >= ACTION_THRESHOLD) {
      actions.push(label);
    }
  }
  const usage = isPlainObject(response.usage) ? response.usage : {};
  return {
    actionProbabilities: probabilities,
    actions,
    confidence: Number.isFinite(move.confidence) ? Number(move.confidence.toFixed(3)) : null,
    inputTokens: Number.isFinite(usage.input_tokens) ? usage.input_tokens : 0,
    move: move.choice,
    outputTokens: Number.isFinite(usage.output_tokens) ? usage.output_tokens : 0,
  };
};

/** The inputs a decision holds: the move's keys plus each chosen action's keys. */
const inputsFor = (controls, decision) => {
  const moveOption = controls.move[decision.move];
  const keys = new Set(moveOption.keys);
  for (const label of decision.actions) {
    for (const code of controls.actions[label].keys) {
      keys.add(code);
    }
  }
  return { keys: [...keys], pointer: moveOption.pointer ?? null };
};

const samePointer = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/**
 * In-page expression: fold the latest sample into the tracker, summarise the
 * window since the last flush, and start a new window from here — WITHOUT
 * stopping the sampler, so movement during the next decision's latency (the
 * previous inputs are still held) is counted rather than lost. Needs READ_FN.
 */
const FLUSH = `(() => {
  const t = window.__BOT_TRACK__;
  if (!t) return null;
  const c = __botRead();
  t.path += __botDist(c, t.last);
  const out = { path: +t.path.toFixed(3), peak: +Math.max(t.peak, __botDist(c, t.start)).toFixed(3), frameBefore: t.start.frame, frame: c.frame, scoreBefore: t.start.score, score: Math.max(t.score, c.score), x: c.x, y: c.y, z: c.z, complete: c.complete };
  t.start = c; t.last = c; t.path = 0; t.peak = 0; t.score = c.score;
  return out;
})()`;

/** A JSON-safe copy of the game's diagnostics, or null if they can't be serialized. */
const SNAPSHOT = `(() => { try { return JSON.parse(JSON.stringify(window.__GAME_DIAGNOSTICS__ ?? null)); } catch { return null; } })()`;

/**
 * One tick, in one round trip: switch the held inputs from `prev` to `next`,
 * hold for `tickMs`, then report what moved since the last flush and what the
 * game looks like now. The window a tick reports therefore runs from the
 * previous flush to the end of this hold — it includes the decision latency,
 * during which the previous inputs were still down.
 */
const tickSource = (prev, next, tickMs, first) => {
  const release = prev.keys.filter((code) => !next.keys.includes(code));
  const press = next.keys.filter((code) => !prev.keys.includes(code));
  const pointerChanged = !samePointer(prev.pointer, next.pointer);
  const parts = [
    READ_FN,
    // Tracking first: a game that moves the player synchronously on keydown
    // would otherwise fold that movement into the baseline and report peak 0.
    ...(first ? [TRACK_BEGIN_BODY] : []),
    ...(pointerChanged ? pointerParts(prev.pointer, "up") : []),
    ...keyParts("keyup", release),
    ...(pointerChanged ? pointerParts(next.pointer, "down") : []),
    ...keyParts("keydown", press),
    `await new Promise((resolve) => setTimeout(resolve, ${tickMs}));`,
    `return { window: ${FLUSH}, game: ${SNAPSHOT} };`,
  ];
  return `(async () => { ${parts.join("\n")} })()`;
};

/** Release everything, stop the sampler, and return the final window. */
const finishSource = (held) => {
  const parts = [
    READ_FN,
    ...keyParts("keyup", held.keys),
    ...pointerParts(held.pointer, "up"),
    `const out = ${FLUSH};`,
    "clearInterval(window.__BOT_TICK__);",
    "return out;",
  ];
  return `(() => { ${parts.join("\n")} })()`;
};

const round = (value) => Number(value.toFixed(2));

/** Fold one measured window into the running metrics. */
const measure = (metrics, window, decision, index, controls) => {
  metrics.distance += window.path;
  metrics.maxTickDisplacement = Math.max(metrics.maxTickDisplacement, window.peak);
  const progressed = window.score > window.scoreBefore;
  if (progressed && metrics.tickOfFirstScore === null) {
    metrics.tickOfFirstScore = index;
  }
  // Stuck signature: frames advanced, the pilot asked the player to move, and
  // nothing came of it. Counted as a RUN: one dead tick is a wall, several in a
  // row is a player wedged in geometry — or a pilot that keeps choosing the
  // wall, which the reflex in `main` exists to break.
  const option = controls.move[decision.move];
  const askedToMove = (option.keys ?? []).length > 0 || Boolean(option.pointer);
  let stuck = false;
  if (askedToMove) {
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

/** The state Jev decides from: the live diagnostics plus what the last inputs achieved. */
const buildState = (run, controls, opts, tick) => ({
  game: run.game,
  goal: controls.goal,
  recent: {
    blockedMoves: [...run.blocked],
    held: run.last ? { actions: run.last.actions, move: run.last.move } : null,
    movedLastTick: run.lastWindow ? run.lastWindow.peak : null,
    scoreDeltaLastTick: run.lastWindow ? run.lastWindow.score - run.lastWindow.scoreBefore : null,
    stuckTicksInARow: run.metrics.stuckRun,
    trail: run.trail,
  },
  tick: { index: tick, of: opts.ticks, tickMs: opts.tickMs },
});

const recordUsage = (usage, decision, decisionMs) => {
  usage.calls += 1;
  usage.inputTokens += decision.inputTokens;
  usage.outputTokens += decision.outputTokens;
  usage.totalDecisionMs += decisionMs;
  usage.maxDecisionMs = Math.max(usage.maxDecisionMs, decisionMs);
};

/**
 * The reflex layer: a move that has produced nothing for two ticks running is
 * withdrawn from the next question. Only that one move — the model still picks
 * among the rest — and never so many that fewer than two remain.
 */
const reflexBlock = (controls, decision, stuck, stuckRun) => {
  const blocked = new Set();
  const enough = Object.keys(controls.move).length - 1 >= 2;
  if (stuck && stuckRun >= THRESHOLDS.stuckRun && decision.move !== "none" && enough) {
    blocked.add(decision.move);
  }
  return blocked;
};

/** Decide, hold, measure — `opts.ticks` times, or until the game reports `complete`. */
const runTicks = async (opts, before) => {
  const { controls } = opts;
  const run = {
    blocked: new Set(),
    completedAtTick: null,
    game: evaluate(SNAPSHOT),
    held: { keys: [], pointer: null },
    last: null,
    lastResult: before,
    lastWindow: null,
    metrics: {
      distance: 0,
      longestStuckRun: 0,
      maxTickDisplacement: 0,
      stuckRun: 0,
      stuckTicks: 0,
      tickOfFirstScore: null,
    },
    timeline: [],
    trail: [],
    usage: { calls: 0, inputTokens: 0, maxDecisionMs: 0, outputTokens: 0, totalDecisionMs: 0 },
  };

  for (let tick = 0; tick < opts.ticks; tick += 1) {
    const questions = buildQuestions(controls, opts.tickMs, run.blocked);
    const t0 = Date.now();
    const response = await decide(opts, buildState(run, controls, opts, tick), questions);
    const decision = readDecision(response, controls, questions);
    const decisionMs = Date.now() - t0;
    recordUsage(run.usage, decision, decisionMs);

    const next = inputsFor(controls, decision);
    // Claim BEFORE dispatching: an eval that fails part-way through can still
    // have pressed something, and an input this process never releases stays
    // held in the daemon's page for the next run.
    claimHeld(next);
    const result = evaluate(tickSource(run.held, next, opts.tickMs, tick === 0));
    run.held = next;
    // Silently skipping would leave the metrics at the baseline, reporting
    // framesAdvanced 0 — a broken harness dressed up as a stalled game.
    if (!isPlainObject(result) || !isPlainObject(result.window)) {
      fail(`tick ${tick} lost its in-page tracker; the page probably navigated mid-run.`);
    }
    const { window } = result;
    const { progressed, stuck } = measure(run.metrics, window, decision, tick, controls);
    run.timeline.push({
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

    run.blocked = reflexBlock(controls, decision, stuck, run.metrics.stuckRun);
    run.trail.push({ x: round(window.x), y: round(window.y), z: round(window.z) });
    if (run.trail.length > TRAIL_LENGTH) {
      run.trail.shift();
    }
    run.game = result.game;
    run.last = decision;
    run.lastWindow = window;
    run.lastResult = window;
    if (window.complete) {
      run.completedAtTick = tick;
      break;
    }
  }

  // Release everything and fold in whatever moved after the last hold ended.
  const tail = evaluate(finishSource(run.held));
  disownHeld();
  if (isPlainObject(tail) && run.last) {
    run.metrics.distance += tail.path;
    run.metrics.maxTickDisplacement = Math.max(run.metrics.maxTickDisplacement, tail.peak);
    run.lastResult = tail;
  }
  return run;
};

/** Per-run histograms of what the pilot chose, and how sure it was about moving. */
const summarizeDecisions = (timeline) => {
  const moves = {};
  const actions = {};
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

/** Failures fail the run; warnings are findings a reader should weigh. */
const verdict = (report, opts) => {
  const failures = [];
  const warnings = [];
  if (report.framesAdvanced <= THRESHOLDS.framesAdvanced) {
    failures.push(`game loop stalled (framesAdvanced ${report.framesAdvanced})`);
  }
  // Gated on the largest displacement any ONE tick achieved, not on the summed
  // path, for the same reason as the bot: path accumulates every sampled
  // wobble, and an idle bob would drift past a total-distance threshold.
  if (report.maxTickDisplacement <= THRESHOLDS.displacement) {
    failures.push(
      `player did not respond to input (maxTickDisplacement ${report.maxTickDisplacement}) — if this game steers with the mouse, give \`--controls\` pointer moves`,
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
        `${message} — pass \`--expect-progress\` once the controls express this game's scoring verb, to make that an assertion`,
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

const main = async () => {
  const opts = parseArgs(process.argv.slice(2));
  const started = Date.now();

  const { before, seedApplied } = launch({
    headed: opts.headed,
    seed: opts.seed,
    target: opts.game ? ["--game", opts.game] : [opts.url],
  });

  const run = await runTicks(opts, before);
  const { consoleErrors, pageErrors } = collectErrors();
  const gpu = readGpuInfo();
  const { lastResult, metrics, usage } = run;

  const report = {
    complete: lastResult.complete,
    completedAtTick: run.completedAtTick,
    consoleErrors,
    decisions: summarizeDecisions(run.timeline),
    distanceTravelled: round(metrics.distance),
    framesAdvanced: lastResult.frame - before.frame,
    goal: opts.controls.goal,
    // Which GPU rasterized the run. Under software rendering the functional
    // checks above still hold; any frame-rate read from the run does not.
    gpu,
    longestStuckRun: metrics.longestStuckRun,
    maxTickDisplacement: round(metrics.maxTickDisplacement),
    model: {
      calls: usage.calls,
      id: opts.model,
      inputTokens: usage.inputTokens,
      maxDecisionMs: usage.maxDecisionMs,
      meanDecisionMs: usage.calls > 0 ? Math.round(usage.totalDecisionMs / usage.calls) : null,
      outputTokens: usage.outputTokens,
    },
    pageErrors,
    scoreAfter: lastResult.score,
    scoreBefore: before.score,
    seed: opts.seed,
    // How the seed actually landed, so a reader can tell a real seeded run
    // from one where the hook quietly did nothing.
    seedApplied,
    stuckTicks: metrics.stuckTicks,
    // Report what was asked for, not a second guess at the URL — `vg playtest`
    // owns slug→URL resolution and follows VG_API_URL when doing it.
    target: opts.game ? `game:${opts.game}` : opts.url,
    tickMs: opts.tickMs,
    tickOfFirstScore: metrics.tickOfFirstScore,
    ticks: opts.ticks,
    ticksRun: run.timeline.length,
    timeline: run.timeline,
    wallMs: Date.now() - started,
  };

  const { failures, warnings } = verdict(report, opts);
  console.log(JSON.stringify({ ...report, failures, warnings }, null, 2));

  if (!opts.keepOpen) {
    playtest(["close"]);
  }

  if (failures.length > 0) {
    console.error(`\npilot-playtest: FAILED — ${failures.join("; ")}`);
    process.exit(1);
  }
  for (const warning of warnings) {
    console.error(`pilot-playtest: warning — ${warning}`);
  }
  console.error("\npilot-playtest: PASSED");
};

await main();
