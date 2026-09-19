#!/usr/bin/env node
/**
 * bot-playtest — drive a scripted input sweep through a browser game and
 * measure whether it actually PLAYS: loop alive, input alive, objective
 * reachable, no softlocks, no errors.
 *
 * Zero dependencies. Shells out to `vg playtest` (agent-browser). The daemon
 * keeps the browser alive between calls, but each call still pays a CLI start,
 * so the loop keeps invocations to roughly one per step.
 *
 * The game must expose the diagnostics contract — see references/bot-playtest.md.
 *
 *   node bot-playtest.mjs --url http://localhost:5173
 *   node bot-playtest.mjs --game my-game --seed 42
 *   node bot-playtest.mjs --url http://localhost:5173 --script ./sweep.json
 *   node bot-playtest.mjs --url http://localhost:5173 --reaction-delay 300
 *
 * Exit 0 = the game plays. Exit 1 = it doesn't (report says why). Exit 2 = the
 * harness itself failed (browser missing, game never booted).
 *
 * For a playtester that decides its own inputs from the game state, see
 * model-playtest.
 */

import { readFileSync } from "node:fs";

import {
  MOVEMENT_CODES,
  TRACK_BEGIN,
  TRACK_END,
  claimHeld,
  collectErrors,
  disownHeld,
  evaluate,
  fail,
  isPlainObject,
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

setProgramName("bot-playtest");

// A generic sweep: hold each direction long enough to cross a room, so a
// stuck-on-geometry game shows up as a run of stuck steps rather than as noise.
const DEFAULT_SCRIPT = [
  { keys: ["KeyW"], ms: 1000 },
  { keys: ["KeyA"], ms: 1900 },
  { keys: ["KeyD"], ms: 3400 },
  { keys: ["KeyS"], ms: 1700 },
  { keys: ["KeyA"], ms: 3400 },
  { keys: ["Space"], ms: 600 },
];

const THRESHOLDS = {
  displacement: 5,
  framesAdvanced: 100,
  /** Displacement (world units) below which a step counts as "didn't move". */
  motionEpsilon: 0.2,
  stuckRun: 2,
};

const parseArgs = (argv) => {
  const opts = {
    expectProgress: false,
    game: null,
    headed: false,
    keepOpen: false,
    reactionDelay: 0,
    script: DEFAULT_SCRIPT,
    seed: 12_345,
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
    } else if (arg === "--reaction-delay") {
      opts.reactionDelay = num();
    } else if (arg === "--script") {
      opts.script = readScript(takeValue());
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
  if (!opts.url && !opts.game) {
    fail("Pass --url <url> or --game <slug>.");
  }
  if (opts.url && opts.game) {
    fail("Pass either --url or --game, not both.");
  }
  // Validated here rather than at the URL so both seeding paths are covered:
  // `?seed=NaN` is ignored by the game and `seed(NaN)` poisons the RNG, and
  // either way the report would claim a seed that never took.
  if (!Number.isFinite(opts.seed)) {
    fail("`--seed` must be a finite number.");
  }
  if (!Number.isFinite(opts.reactionDelay) || opts.reactionDelay < 0) {
    fail("`--reaction-delay` must be a non-negative number of milliseconds.");
  }
  validateScript(opts.script);
  return opts;
};

/**
 * Load a `--script` file. A missing path or malformed JSON is a mistake in the
 * command, not a crash: raw `ENOENT`/`SyntaxError` stack traces read as a bug
 * in the harness and bury the one line that says which file is wrong.
 */
const readScript = (path) => {
  let text;
  try {
    text = readFileSync(path, "utf-8");
  } catch {
    fail(`couldn't read --script ${path}.`);
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    fail(`--script ${path} isn't valid JSON: ${error.message}`);
  }
};

/**
 * Check the input script before anything launches. An unsupported key code or
 * a malformed step would otherwise surface mid-run, after a browser start and
 * a seeded reload, reported as a harness failure with no hint that the script
 * itself was the problem.
 */
const validateScript = (script) => {
  if (!Array.isArray(script) || script.length === 0) {
    fail("`--script` must be a non-empty JSON array of { keys, ms } steps.");
  }
  for (const [index, step] of script.entries()) {
    if (!isPlainObject(step)) {
      fail(`step ${index} must be an object.`);
    }
    const keys = step.keys ?? [];
    if (!Array.isArray(keys)) {
      fail(`step ${index}: \`keys\` must be an array.`);
    }
    if (keys.length === 0 && !step.pointer) {
      fail(`step ${index} needs a non-empty \`keys\` array or a \`pointer\`.`);
    }
    if (!Number.isFinite(step.ms) || step.ms <= 0) {
      fail(`step ${index} needs a positive \`ms\` duration.`);
    }
    if (
      step.expectMotion !== undefined &&
      step.expectMotion !== true &&
      step.expectMotion !== false
    ) {
      fail(`step ${index}: \`expectMotion\` must be a boolean.`);
    }
    if (step.pointer) {
      validatePointer(step.pointer, `step ${index}`);
    }
    // Throws (exit 2) naming the offending code.
    for (const code of keys) {
      keyFields(code);
    }
  }
};

/**
 * Whether a step is claiming the player should move, and so can count toward a
 * stuck run. A pointer step counts because the games that use one steer with
 * it (aim-and-thrust); a bare attack or menu key does not. Override per step
 * with `expectMotion` when a game moves on some other key.
 */
const expectsMotion = (step) => {
  if (step.expectMotion === true || step.expectMotion === false) {
    return step.expectMotion;
  }
  return Boolean(step.pointer) || (step.keys ?? []).some((code) => MOVEMENT_CODES.has(code));
};

/** Press the step's inputs and start measuring, in one round trip. */
const beginStep = (step) => {
  // Tracking first: a game that moves the player synchronously on keydown
  // would otherwise fold that movement into the baseline and report peak 0.
  const parts = [
    TRACK_BEGIN,
    ...pointerParts(step.pointer, "down"),
    ...keyParts("keydown", step.keys ?? []),
  ];
  // Claim the step BEFORE dispatching: an eval that fails part-way through can
  // still have pressed something, and an input this process never releases
  // stays held in the daemon's page for the next run.
  claimHeld(step);
  evaluate(`(() => { ${parts.join("\n")}\nreturn true; })()`);
};

/** Release the step's inputs and return what moved while they were held. */
const endStep = (step) => {
  const parts = [
    ...keyParts("keyup", step.keys ?? []),
    ...pointerParts(step.pointer, "up"),
    TRACK_END,
  ];
  // Only disown the step once the release has actually landed. Clearing first
  // would leave `releaseHeldInputs` with nothing to do on the failure path —
  // the one path where it matters.
  const summary = evaluate(`(() => { ${parts.join("\n")} })()`);
  disownHeld();
  return summary;
};

/** Drive the script step by step, measuring motion and score against the baseline. */
const runScript = (opts, before) => {
  let prev = before;
  let distance = 0;
  let maxStepDisplacement = 0;
  let stuckSteps = 0;
  let stuckRun = 0;
  let longestStuckRun = 0;
  let stepOfFirstScore = null;

  for (const [index, step] of opts.script.entries()) {
    beginStep(step);
    sleep(step.ms);
    const moved = endStep(step);
    // A slower "reaction time" models a less skilled player; comparing runs at
    // 0ms and 300ms shows whether difficulty pressure is real or decorative.
    if (opts.reactionDelay > 0) {
      sleep(opts.reactionDelay);
    }
    // Silently skipping would leave `prev` at the baseline, reporting
    // framesAdvanced 0 — a broken harness dressed up as a stalled game.
    if (!moved) {
      fail(`step ${index} lost its in-page tracker; the page probably navigated mid-run.`);
    }

    distance += moved.path;
    maxStepDisplacement = Math.max(maxStepDisplacement, moved.peak);
    const progressed = moved.score > moved.scoreBefore;
    if (progressed && stepOfFirstScore === null) {
      stepOfFirstScore = index;
    }

    // Stuck signature: frames advanced, the player tried to move, and nothing
    // came of it. Counted as a RUN rather than a total, because one step that
    // moves nothing is a key the game doesn't bind, while several in a row is
    // a player wedged in geometry — only the second is worth failing over.
    if (expectsMotion(step)) {
      const stuck =
        moved.frame > moved.frameBefore && moved.peak < THRESHOLDS.motionEpsilon && !progressed;
      if (stuck) {
        stuckSteps += 1;
        stuckRun += 1;
        longestStuckRun = Math.max(longestStuckRun, stuckRun);
      } else {
        stuckRun = 0;
      }
    }
    prev = moved;
  }

  return { distance, longestStuckRun, maxStepDisplacement, prev, stepOfFirstScore, stuckSteps };
};

const main = () => {
  const opts = parseArgs(process.argv.slice(2));

  const { before, seedApplied } = launch({
    headed: opts.headed,
    seed: opts.seed,
    target: opts.game ? ["--game", opts.game] : [opts.url],
  });

  const { distance, longestStuckRun, maxStepDisplacement, prev, stepOfFirstScore, stuckSteps } =
    runScript(opts, before);

  const { consoleErrors, pageErrors } = collectErrors();
  const gpu = readGpuInfo();

  const report = {
    complete: prev.complete,
    consoleErrors,
    distanceTravelled: Number(distance.toFixed(2)),
    framesAdvanced: prev.frame - before.frame,
    // Which GPU rasterized the run. Under software rendering the functional
    // checks above still hold; any frame-rate read from the run does not.
    gpu,
    longestStuckRun,
    maxStepDisplacement: Number(maxStepDisplacement.toFixed(2)),
    pageErrors,
    reactionDelay: opts.reactionDelay,
    scoreAfter: prev.score,
    scoreBefore: before.score,
    seed: opts.seed,
    // How the seed actually landed, so a reader can tell a real seeded run
    // from one where the hook quietly did nothing.
    seedApplied,
    stepOfFirstScore,
    steps: opts.script.length,
    stuckSteps,
    // Report what was asked for, not a second guess at the URL — `vg playtest`
    // owns slug→URL resolution and follows VG_API_URL when doing it.
    target: opts.game ? `game:${opts.game}` : opts.url,
  };

  const failures = [];
  const warnings = [];
  if (report.framesAdvanced <= THRESHOLDS.framesAdvanced) {
    failures.push(`game loop stalled (framesAdvanced ${report.framesAdvanced})`);
  }
  // Gated on the largest displacement any ONE step achieved, not on the summed
  // path: path accumulates every sampled wobble, so a game with an idle bob and
  // completely dead input can drift past a total-distance threshold and look
  // responsive. Peak-from-step-start stays bounded by how far the player
  // actually got.
  if (report.maxStepDisplacement <= THRESHOLDS.displacement) {
    failures.push(
      `player did not respond to input (maxStepDisplacement ${report.maxStepDisplacement}) — if this game steers with the mouse, give the script \`pointer\` steps`,
    );
  }
  if (report.longestStuckRun > THRESHOLDS.stuckRun) {
    failures.push(
      `player wedged for ${report.longestStuckRun} consecutive movement steps (longestStuckRun)`,
    );
  }
  // Failing needs more consecutive stuck steps than the script even contains,
  // so silence here proves nothing. Say so rather than let a green run imply a
  // check that could never have run.
  const motionSteps = opts.script.filter(expectsMotion).length;
  if (motionSteps <= THRESHOLDS.stuckRun) {
    warnings.push(
      `stuck detection never applied: ${motionSteps} step(s) ask the player to move, and failing needs more than ${THRESHOLDS.stuckRun} in a row`,
    );
  }
  // An assertion only when the caller says the script performs the game's
  // scoring verb. Inferring that from "was --script passed?" got it wrong in
  // both directions — a tweaked copy of the default sweep would fail a healthy
  // game, which is the verdict-you-learn-to-ignore this exists to avoid.
  if (report.scoreAfter <= report.scoreBefore) {
    const message = "the run never progressed the objective";
    if (opts.expectProgress) {
      failures.push(message);
    } else {
      warnings.push(
        `${message} — pass \`--expect-progress\` once your script performs this game's scoring verb, to make that an assertion`,
      );
    }
  }
  if (report.consoleErrors.length > 0) {
    failures.push(`${report.consoleErrors.length} console error(s)`);
  }
  if (report.pageErrors.length > 0) {
    failures.push(`${report.pageErrors.length} uncaught page error(s)`);
  }

  console.log(JSON.stringify({ ...report, failures, warnings }, null, 2));

  if (!opts.keepOpen) {
    playtest(["close"]);
  }

  if (failures.length > 0) {
    console.error(`\nbot-playtest: FAILED — ${failures.join("; ")}`);
    process.exit(1);
  }
  for (const warning of warnings) {
    console.error(`bot-playtest: warning — ${warning}`);
  }
  console.error("\nbot-playtest: PASSED");
};

main();
