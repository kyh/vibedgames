import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, test } from "node:test";

import { makeCleanups, makeTmpDir } from "./_helpers.js";
import type { Window } from "../src/lib/pilot/browser.js";
import type { Decision } from "../src/lib/pilot/controls.js";
import type { RunOptions, RunResult } from "../src/lib/pilot/run.js";
import type { JsonValue } from "../src/lib/types.js";
import {
  ACTION_THRESHOLD,
  PRESETS,
  buildQuestions,
  inputsFor,
  parseControls,
  readControlsArg,
  readDecision,
} from "../src/lib/pilot/controls.js";
import { HarnessError } from "../src/lib/pilot/errors.js";
import { keyFields, keyParts, pointerParts } from "../src/lib/pilot/keys.js";
import { THRESHOLDS, buildReport, verdict } from "../src/lib/pilot/run.js";

/**
 * `vg pilot`'s pure core: how a control scheme is read, how it becomes the
 * model's questions, how answers become held input, and how a run is judged.
 * The browser and the API are behind interfaces and not exercised here.
 */

const { cleanups, drain } = makeCleanups();
afterEach(drain);

const file = (contents: JsonValue | string): string => {
  const target = path.join(makeTmpDir(cleanups, "pilot-"), "controls.json");
  writeFileSync(target, String(contents) === contents ? contents : JSON.stringify(contents));
  return target;
};

const rejects = (fn: () => void, message: RegExp): void => {
  let caught: HarnessError | null = null;
  try {
    fn();
  } catch (error) {
    if (!(error instanceof HarnessError)) {
      throw error;
    }
    caught = error;
  }
  assert.ok(caught, "expected a HarnessError");
  assert.match(caught.message, message);
};

const wasd = () => {
  const controls = PRESETS.get("wasd");
  assert.ok(controls);
  return controls;
};

test("keyFields maps every documented key family and rejects the rest", () => {
  assert.deepEqual(keyFields("KeyD"), [68, "d"]);
  assert.deepEqual(keyFields("Digit3"), [51, "3"]);
  assert.deepEqual(keyFields("ArrowLeft"), [37, "ArrowLeft"]);
  assert.deepEqual(keyFields("Space"), [32, " "]);
  rejects(() => keyFields("F13"), /unsupported key code "F13"/u);
  // An object lookup accepted these through the prototype and built an event
  // with an undefined keyCode — a key that dispatches and does nothing.
  for (const bad of ["toString", "constructor", "__proto__", "hasOwnProperty"]) {
    rejects(() => keyFields(bad), /unsupported key code/u);
  }
});

test("keyParts dispatches at the focused element with code, key and keyCode", () => {
  const [source] = keyParts("keydown", ["ShiftLeft", "KeyW"]);
  assert.ok(source);
  assert.match(source, /document\.activeElement/u);
  assert.match(source, /"code":"KeyW","key":"W","keyCode":87/u, "shift uppercases the companion");
  assert.match(source, /"shiftKey":true/u);
  assert.deepEqual(keyParts("keyup", []), []);
});

test("pointerParts releases only a held button", () => {
  assert.deepEqual(pointerParts({ x: 0.5, y: 0.5 }, "up"), []);
  assert.equal(pointerParts({ down: true, x: 0.5, y: 0.5 }, "up").length, 2);
  assert.equal(pointerParts({ down: true, x: 0.5, y: 0.5 }, "down").length, 3);
  assert.deepEqual(pointerParts(null, "down"), []);
});

test("presets resolve by name and files by path", () => {
  assert.equal(readControlsArg("wasd"), PRESETS.get("wasd"));
  assert.equal(readControlsArg("arrows"), PRESETS.get("arrows"));
  assert.deepEqual(wasd().move.up_left?.keys, ["KeyW", "KeyA"]);

  const custom = readControlsArg(
    file({
      actions: { fire: { description: "fire the cannon", keys: ["KeyJ"] } },
      goal: "Reach the flag.",
      move: {
        aim_right: { description: "aim right and thrust", pointer: { down: true, x: 0.8, y: 0.5 } },
        left: { description: "walk left", keys: ["ArrowLeft"] },
      },
    }),
  );
  assert.equal(custom.goal, "Reach the flag.");
  assert.deepEqual(custom.move.aim_right?.pointer, { down: true, x: 0.8, y: 0.5 });
  assert.deepEqual(custom.move.none?.keys, [], "a `none` option is filled in");
  assert.deepEqual(custom.actions.fire?.keys, ["KeyJ"]);
});

test("names a --controls value that is neither a preset nor a readable file", () => {
  const dir = makeTmpDir(cleanups, "pilot-");
  rejects(
    () => readControlsArg(path.join(dir, "absent.json")),
    /couldn't read --controls .*arrows, wasd/u,
  );
  rejects(() => readControlsArg(file("{not json")), /isn't valid JSON/u);
});

test("rejects a scheme the pilot could not act on, naming the source", () => {
  const cases: [JsonValue, RegExp][] = [
    [[], /must be a JSON object/u],
    [{ move: {} }, /`move` must map at least one option/u],
    [{ move: { wait: { description: "wait" } } }, /no `move` option holds any input/u],
    [{ move: { up: { keys: ["KeyW"] } } }, /move\.up needs a non-empty `description`/u],
    [{ move: { up: { description: "up", keys: ["F13"] } } }, /unsupported key code "F13"/u],
    [
      {
        actions: { jump: { description: "jump" } },
        move: { up: { description: "up", keys: ["KeyW"] } },
      },
      /actions\.jump needs a non-empty `keys` array/u,
    ],
    [
      {
        actions: { fire: { description: "fire", pointer: { down: true, x: 0.5, y: 0.5 } } },
        move: { up: { description: "up", keys: ["KeyW"] } },
      },
      /actions are keys only/u,
    ],
    [
      { move: { aim: { description: "aim", pointer: { x: 640, y: 0.5 } } } },
      /must be a viewport fraction between 0 and 1/u,
    ],
    [
      { goal: "", move: { up: { description: "up", keys: ["KeyW"] } } },
      /`goal` must be a non-empty string/u,
    ],
  ];
  for (const [raw, message] of cases) {
    rejects(() => parseControls(raw, "window.__GAME_PILOT__"), message);
    rejects(() => parseControls(raw, "window.__GAME_PILOT__"), /window\.__GAME_PILOT__/u);
  }
});

test("buildQuestions asks one choice for movement and one yes/no per action, omitting blocked moves", () => {
  const controls = wasd();
  const questions = buildQuestions(controls, new Set(["up"]));
  const { move } = questions;
  assert.ok(move && move.type === "choice");
  assert.equal(move.criteria.up, undefined, "a blocked move is not offered");
  assert.equal(move.criteria.none, controls.move.none?.description);
  assert.equal(move.criteria.down_left, controls.move.down_left?.description);
  const action = questions["act:action"];
  assert.ok(action && action.type === "noul");
  assert.match(action.instructions, /press the action key/u);
  assert.equal(Object.keys(questions).length, 2);
});

test("readDecision accepts only an offered move and thresholds each action", () => {
  const controls = wasd();
  const questions = buildQuestions(controls, new Set());
  const decision = readDecision(
    {
      answers: {
        "act:action": { noul: ACTION_THRESHOLD, type: "noul" },
        move: { choice: "right", confidence: 0.61234, probabilities: {}, type: "choice" },
      },
      usage: { input_tokens: 210, output_tokens: 31 },
    },
    controls,
    questions,
  );
  assert.equal(decision.move, "right");
  assert.deepEqual(decision.actions, ["action"], "a probability at the threshold counts");
  assert.equal(decision.confidence, 0.612);
  assert.equal(decision.inputTokens, 210);

  rejects(
    () =>
      readDecision({ answers: { move: { choice: "warp", type: "choice" } } }, controls, questions),
    /outside the offered options/u,
  );
  rejects(
    () =>
      readDecision(
        { answers: { "act:action": { type: "noul" }, move: { choice: "up", type: "choice" } } },
        controls,
        questions,
      ),
    /without a probability/u,
  );
  rejects(() => readDecision({ model: "x" }, controls, questions), /no answers/u);
});

test("inputsFor holds the move's keys plus each chosen action's keys, once each", () => {
  const decision: Decision = {
    actionProbabilities: {},
    actions: ["action"],
    confidence: null,
    inputTokens: 0,
    move: "up_right",
    outputTokens: 0,
  };
  const held = inputsFor(wasd(), decision);
  assert.deepEqual(held.keys, ["KeyW", "KeyD", "Space"]);
  assert.equal(held.pointer, null);
});

const options = (overrides: Partial<RunOptions> = {}): RunOptions => ({
  controls: wasd(),
  expectProgress: false,
  model: "jev-latest",
  tickMs: 0,
  ticks: 10,
  ...overrides,
});

const lastWindow: Window = {
  complete: false,
  frame: 500,
  frameBefore: 480,
  path: 3,
  peak: 3,
  score: 0,
  scoreBefore: 0,
  x: 0,
  y: 0,
  z: 0,
};

const runResult = (overrides: Partial<RunResult> = {}): RunResult => ({
  completedAtTick: null,
  lastWindow,
  metrics: {
    distance: 120,
    longestStuckRun: 1,
    maxTickDisplacement: 12,
    stuckRun: 0,
    stuckTicks: 1,
    tickOfFirstScore: null,
  },
  timeline: [],
  usage: {
    calls: 10,
    inputTokens: 2000,
    maxDecisionMs: 300,
    outputTokens: 100,
    totalDecisionMs: 2000,
  },
  wallMs: 4000,
  ...overrides,
});

const report = (opts: RunOptions, run: RunResult) =>
  buildReport(opts, {
    before: { complete: false, frame: 20, score: 0 },
    consoleErrors: [],
    gpu: { renderer: null, softwareRendered: null, vendor: null },
    pageErrors: [],
    run,
    seed: 1,
    seedApplied: "hook",
    target: "http://x",
  });

test("verdict passes a live, responsive run and only warns about progress by default", () => {
  const opts = options();
  const built = report(opts, runResult());
  // 480 frames over 4 s clears the gate; so does a short run at a healthy
  // frame rate, which the bot's absolute 100-frame gate would have failed.
  const short = report(opts, runResult({ lastWindow: { ...lastWindow, frame: 60 }, wallMs: 1500 }));
  assert.deepEqual(verdict(short, opts).failures, []);
  assert.equal(built.decisionsPerSecond, 0, "an empty timeline made no decisions");
  const { failures, warnings } = verdict(built, opts);
  assert.deepEqual(failures, []);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0] ?? "", /never progressed the objective/u);
  assert.deepEqual(verdict(built, options({ expectProgress: true })).failures, [
    "the run never progressed the objective",
  ]);
});

test("verdict fails a stalled loop, dead input, a wedged player and page errors", () => {
  const opts = options();
  const stalled = runResult({
    // 20 frames over 4 s: under 10 fps, so stalled even though the bot's
    // absolute gate would be capped down for a shorter run.
    lastWindow: { ...lastWindow, frame: 40 },
    metrics: {
      ...runResult().metrics,
      longestStuckRun: THRESHOLDS.stuckRun + 1,
      maxTickDisplacement: 0,
    },
  });
  const built = { ...report(opts, stalled), pageErrors: ["boom"] };
  const { failures } = verdict(built, opts);
  assert.match(failures.join("\n"), /game loop stalled/u);
  assert.match(failures.join("\n"), /did not respond to input/u);
  assert.match(failures.join("\n"), /wedged for 3 consecutive/u);
  assert.match(failures.join("\n"), /1 uncaught page error/u);
});

test("verdict warns when the model was rarely sure, pointing at the diagnostics", () => {
  const opts = options();
  const entry = {
    actionProbabilities: {},
    actions: [],
    confidence: 0.1,
    decisionMs: 200,
    frames: 20,
    move: "up",
    path: 4,
    peak: 4,
    progressed: false,
    scoreDelta: 0,
    stuck: false,
    tick: 0,
  };
  const built = report(opts, runResult({ timeline: [entry, { ...entry, tick: 1 }] }));
  assert.equal(built.decisions.meanConfidence, 0.1);
  assert.equal(built.decisionsPerSecond, 0.5);
  const { warnings } = verdict(built, opts);
  assert.match(warnings.join("\n"), /rarely sure which way to move .* __GAME_DIAGNOSTICS__/u);
});
