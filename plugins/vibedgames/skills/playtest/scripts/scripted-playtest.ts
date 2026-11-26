#!/usr/bin/env node

import { readFileSync } from "node:fs";

import type { JsonObject, JsonValue } from "./_lib/asset-tools.mjs";
import {
  isFiniteJsonNumber,
  isJsonObject,
  isJsonString,
  parseJsonText,
} from "./_lib/asset-tools.mjs";
import type { Pointer, Sample } from "./lib/harness.ts";
import {
  MOVEMENT_CODES,
  TRACK_BEGIN,
  TRACK_END,
  claimHeld,
  collectErrors,
  disownHeld,
  evaluate,
  fail,
  isJsonBoolean,
  keyFields,
  keyParts,
  launch,
  playtest,
  pointerParts,
  printHelp,
  readGpuInfo,
  readSummary,
  setProgramName,
  sleep,
  validatePointer,
} from "./lib/harness.ts";

setProgramName("scripted-playtest");

interface Step {
  keys: string[];
  ms: number;
  pointer?: Pointer;
  expectMotion?: boolean;
}

const DEFAULT_SCRIPT: JsonValue = [
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

interface Options {
  expectProgress: boolean;
  game: string | null;
  headed: boolean;
  keepOpen: boolean;
  reactionDelay: number;
  script: JsonValue;
  seed: number;
  url: string | null;
}

const parseArgs = (argv: string[]) => {
  const opts: Options = {
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

  if (opts.url === null && opts.game === null) {
    fail("Pass --url <url> or --game <slug>.");
  }

  if (opts.url !== null && opts.game !== null) {
    fail("Pass either --url or --game, not both.");
  }

  if (!Number.isFinite(opts.seed)) {
    fail("`--seed` must be a finite number.");
  }

  if (!Number.isFinite(opts.reactionDelay) || opts.reactionDelay < 0) {
    fail("`--reaction-delay` must be a non-negative number of milliseconds.");
  }

  return { ...opts, script: validateScript(opts.script) };
};

const readText = (path: string) => {
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return fail(`couldn't read --script ${path}.`);
  }
};

const readScript = (path: string) => {
  const text = readText(path);

  try {
    return parseJsonText(text);
  } catch (error) {
    return fail(
      `--script ${path} isn't valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
};

const validateStep = (step: JsonObject, index: number) => {
  const keys = step.keys ?? [];
  const { pointer, ms, expectMotion } = step;

  if (!Array.isArray(keys)) {
    return fail(`step ${index}: \`keys\` must be an array.`);
  }

  const hasPointer = pointer !== undefined && Boolean(pointer);

  if (keys.length === 0 && !hasPointer) {
    fail(`step ${index} needs a non-empty \`keys\` array or a \`pointer\`.`);
  }

  if (!isFiniteJsonNumber(ms) || ms <= 0) {
    return fail(`step ${index} needs a positive \`ms\` duration.`);
  }

  if (expectMotion !== undefined && !isJsonBoolean(expectMotion)) {
    return fail(`step ${index}: \`expectMotion\` must be a boolean.`);
  }

  const checked: Step = {
    keys: keys.map((code) =>
      isJsonString(code)
        ? code
        : fail(`step ${index}: \`keys\` must be KeyboardEvent code strings.`),
    ),
    ms,
  };

  if (hasPointer) {
    checked.pointer = validatePointer(pointer, `step ${index}`);
  }

  for (const code of checked.keys) {
    keyFields(code);
  }

  if (expectMotion !== undefined) {
    checked.expectMotion = expectMotion;
  }

  return checked;
};

const validateScript = (script: JsonValue) => {
  if (!Array.isArray(script) || script.length === 0) {
    return fail("`--script` must be a non-empty JSON array of { keys, ms } steps.");
  }

  return script.map((step, index) =>
    isJsonObject(step) ? validateStep(step, index) : fail(`step ${index} must be an object.`),
  );
};

const expectsMotion = (step: Step) => {
  if (step.expectMotion === true || step.expectMotion === false) {
    return step.expectMotion;
  }

  return step.pointer !== undefined || step.keys.some((code) => MOVEMENT_CODES.has(code));
};

const beginStep = (step: Step) => {
  const parts = [
    TRACK_BEGIN,
    ...pointerParts(step.pointer, "down"),
    ...keyParts("keydown", step.keys),
  ];

  claimHeld(step);
  evaluate(`(() => { ${parts.join("\n")}\nreturn true; })()`);
};

const endStep = (step: Step, index: number) => {
  const parts = [...keyParts("keyup", step.keys), ...pointerParts(step.pointer, "up"), TRACK_END];

  const summary = evaluate(`(() => { ${parts.join("\n")} })()`);
  disownHeld();

  return readSummary(summary, `step ${index}'s tracker`);
};

const runScript = (opts: { reactionDelay: number; script: Step[] }, before: Sample) => {
  let prev: Sample = before;
  let distance = 0;
  let maxStepDisplacement = 0;
  let stuckSteps = 0;
  let stuckRun = 0;
  let longestStuckRun = 0;
  let stepOfFirstScore: number | null = null;

  for (const [index, step] of opts.script.entries()) {
    beginStep(step);
    sleep(step.ms);
    const moved = endStep(step, index);

    if (opts.reactionDelay > 0) {
      sleep(opts.reactionDelay);
    }

    if (moved === null) {
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
    target: opts.game === null ? [opts.url ?? ""] : ["--game", opts.game],
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
    target: opts.game === null ? opts.url : `game:${opts.game}`,
  };

  const failures: string[] = [];
  const warnings: string[] = [];

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
