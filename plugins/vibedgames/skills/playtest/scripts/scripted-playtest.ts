#!/usr/bin/env node

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

setProgramName("scripted-playtest");

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

  if (!Number.isFinite(opts.seed)) {
    fail("`--seed` must be a finite number.");
  }

  if (!Number.isFinite(opts.reactionDelay) || opts.reactionDelay < 0) {
    fail("`--reaction-delay` must be a non-negative number of milliseconds.");
  }

  validateScript(opts.script);

  return opts;
};

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

    for (const code of keys) {
      keyFields(code);
    }
  }
};

const expectsMotion = (step) => {
  if (step.expectMotion === true || step.expectMotion === false) {
    return step.expectMotion;
  }

  return Boolean(step.pointer) || (step.keys ?? []).some((code) => MOVEMENT_CODES.has(code));
};

const beginStep = (step) => {
  const parts = [
    TRACK_BEGIN,
    ...pointerParts(step.pointer, "down"),
    ...keyParts("keydown", step.keys ?? []),
  ];

  claimHeld(step);
  evaluate(`(() => { ${parts.join("\n")}\nreturn true; })()`);
};

const endStep = (step) => {
  const parts = [
    ...keyParts("keyup", step.keys ?? []),
    ...pointerParts(step.pointer, "up"),
    TRACK_END,
  ];

  const summary = evaluate(`(() => { ${parts.join("\n")} })()`);
  disownHeld();

  return summary;
};

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

    if (opts.reactionDelay > 0) {
      sleep(opts.reactionDelay);
    }

    if (!moved) {
      fail(`step ${index} lost its in-page tracker; the page probably navigated mid-run.`);
    }

    distance += moved.path;
    maxStepDisplacement = Math.max(maxStepDisplacement, moved.peak);
    const progressed = moved.score > moved.scoreBefore;

    if (progressed && stepOfFirstScore === null) {
      stepOfFirstScore = index;
    }

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
    gpu,
    longestStuckRun,
    maxStepDisplacement: Number(maxStepDisplacement.toFixed(2)),
    pageErrors,
    reactionDelay: opts.reactionDelay,
    scoreAfter: prev.score,
    scoreBefore: before.score,
    seed: opts.seed,
    seedApplied,
    stepOfFirstScore,
    steps: opts.script.length,
    stuckSteps,
    target: opts.game ? `game:${opts.game}` : opts.url,
  };

  const failures = [];
  const warnings = [];

  if (report.framesAdvanced <= THRESHOLDS.framesAdvanced) {
    failures.push(`game loop stalled (framesAdvanced ${report.framesAdvanced})`);
  }

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

  const motionSteps = opts.script.filter(expectsMotion).length;

  if (motionSteps <= THRESHOLDS.stuckRun) {
    warnings.push(
      `stuck detection never applied: ${motionSteps} step(s) ask the player to move, and failing needs more than ${THRESHOLDS.stuckRun} in a row`,
    );
  }

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
    console.error(`\nscripted-playtest: FAILED — ${failures.join("; ")}`);
    process.exit(1);
  }

  for (const warning of warnings) {
    console.error(`scripted-playtest: warning — ${warning}`);
  }

  console.error("\nscripted-playtest: PASSED");
};

main();
