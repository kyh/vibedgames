import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, test } from "node:test";

import { makeCleanups, makeTmpDir } from "./_helpers.js";
import type { Window } from "../src/lib/playtest/browser.js";
import type { RunOptions, RunResult } from "../src/lib/playtest/run.js";
import type { JsonValue } from "../src/lib/types.js";
import { PRESETS, parseControls, readControlsArg } from "../src/lib/playtest/controls.js";
import { HarnessError } from "../src/lib/playtest/errors.js";
import { keyFields, keyInitsFor, keyTable } from "../src/lib/playtest/keys.js";
import {
  THRESHOLDS,
  agentConfig,
  agentSource,
  buildReport,
  resultFromAgent,
  verdict,
} from "../src/lib/playtest/run.js";

/**
 * `vg playtest run`'s CLI-side core: how a control scheme is read, how it
 * becomes the in-page agent's config, how the agent's records become a
 * report, and how a run is judged. The loop itself is covered in
 * agent.test.ts; the browser and the API are behind interfaces.
 */

const { cleanups, drain } = makeCleanups();
afterEach(drain);

const file = (contents: JsonValue | string): string => {
  const target = path.join(makeTmpDir(cleanups, "playtest-run-"), "controls.json");
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

test("keyInitsFor builds full event inits, with modifiers reflected on companions", () => {
  const [shift, w] = keyInitsFor(["ShiftLeft", "KeyW"]);
  assert.deepEqual(shift, {
    altKey: false,
    bubbles: true,
    code: "ShiftLeft",
    ctrlKey: false,
    key: "Shift",
    keyCode: 16,
    shiftKey: true,
    which: 16,
  });
  assert.equal(w?.key, "W", "shift uppercases the companion key");
  assert.equal(w?.keyCode, 87);
  const table = keyTable();
  assert.equal(table.Space?.key, " ");
  assert.equal(table.KeyZ?.keyCode, 90);
  assert.equal(table.Digit0?.key, "0");
  assert.equal(table.F13, undefined);
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
  assert.equal(custom.move.none, undefined, "two real options need no `none`");
  const single = parseControls(
    { move: { right: { description: "run right", keys: ["KeyD"] } } },
    "test",
  );
  assert.deepEqual(
    single.move.none?.keys,
    [],
    "a one-move scheme gets a partner to choose against",
  );
  assert.deepEqual(custom.actions.fire?.keys, ["KeyJ"]);
});

test("names a --controls value that is neither a preset nor a readable file", () => {
  const dir = makeTmpDir(cleanups, "playtest-run-");
  rejects(
    () => readControlsArg(path.join(dir, "absent.json")),
    /couldn't read --controls .*arrows, wasd/u,
  );
  rejects(() => readControlsArg(file("{not json")), /isn't valid JSON/u);
});

test("rejects a scheme the playtester could not act on, naming the source", () => {
  const cases: [JsonValue, RegExp][] = [
    [[], /must be a JSON object/u],
    [{ move: {} }, /`move` must map at least one option/u],
    [{ move: { wait: { description: "wait" } } }, /no `move` option holds any input/u],
    [{ move: { up: { keys: ["KeyW"] } } }, /move\.up needs a non-empty `description`/u],
    [
      { minDisplacement: -1, move: { up: { description: "up", keys: ["KeyW"] } } },
      /`minDisplacement` must be a positive number/u,
    ],
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
    rejects(() => parseControls(raw, "window.__GAME_PLAYTEST__"), message);
    rejects(() => parseControls(raw, "window.__GAME_PLAYTEST__"), /window\.__GAME_PLAYTEST__/u);
  }
});

const options = (overrides: Partial<RunOptions> = {}): RunOptions => ({
  controls: wasd(),
  expectProgress: false,
  model: "jev-latest",
  tickMs: 150,
  ticks: 10,
  ...overrides,
});

test("a move that is only a reflex counts as input, and minDisplacement is carried", () => {
  // `reflex: true` is what the launch step leaves where the page had a function.
  const controls = parseControls(
    { minDisplacement: 0.05, move: { track: { description: "follow the ball", reflex: true } } },
    "window.__GAME_PLAYTEST__",
  );
  assert.equal(controls.move.track?.reflex, true);
  assert.equal(controls.minDisplacement, 0.05);
});

test("agentConfig resolves every key to an event init and carries the session", () => {
  const cfg = agentConfig(options(), { decideUrl: "https://x/api/playtest/decide", token: "pt.t" });
  assert.equal(cfg.token, "pt.t");
  assert.equal(cfg.decideUrl, "https://x/api/playtest/decide");
  assert.deepEqual(
    cfg.move.up_left?.inits.map((init) => [init.code, init.keyCode]),
    [
      ["KeyW", 87],
      ["KeyA", 65],
    ],
  );
  assert.equal(cfg.move.none?.inits.length, 0);
  assert.equal(cfg.actions.action?.inits[0]?.code, "Space");
  assert.equal(cfg.motionEpsilon, THRESHOLDS.displacement * THRESHOLDS.motionEpsilonRatio);
  const worldUnits = agentConfig(
    options({ controls: { ...options().controls, minDisplacement: 0.1 } }),
    { decideUrl: "https://x/api/playtest/decide", token: "pt.x" },
  );
  assert.equal(worldUnits.motionEpsilon, 0.1 * THRESHOLDS.motionEpsilonRatio);
  assert.equal(cfg.ticks, 10);
  // The page source is one expression: the agent applied to its config and the browser env.
  const source = agentSource(cfg);
  assert.match(source, /^\(.*\)\(\{.*\}, \(.*\)\(\)\)$/su);
  // oxlint-disable-next-line no-new-func -- parse-only check of the page source
  assert.doesNotThrow(() => new Function(`return ${source}`));
});

const window = (overrides: Partial<Window> = {}): Window => ({
  complete: false,
  frame: 40,
  frameBefore: 20,
  path: 6,
  peak: 6,
  score: 0,
  scoreBefore: 0,
  x: 6,
  y: 0,
  z: 0,
  ...overrides,
});

/** A record whose window advances 20 frames from where the previous tick's ended. */
const record = (tick: number, overrides: Partial<Record<string, JsonValue>> = {}): JsonValue => ({
  actionProbabilities: { action: 0.1 },
  actions: [],
  askedToMove: true,
  confidence: 0.6,
  decisionMs: 200,
  inputTokens: 100,
  move: "right",
  outputTokens: 5,
  progress: 0.25,
  reflexFrames: 0,
  tick,
  window: window({ frame: 40 + tick * 20, frameBefore: 20 + tick * 20 }),
  ...overrides,
});

const published = (records: JsonValue[], extra: Record<string, JsonValue> = {}): JsonValue => ({
  completedAtTick: null,
  done: true,
  error: null,
  records,
  usage: {},
  wallMs: 2000,
  ...extra,
});

test("resultFromAgent folds records into metrics, a timeline and usage", () => {
  const stuckWindow = window({ frame: 60, frameBefore: 40, path: 0, peak: 0, x: 6 });
  const run = resultFromAgent(
    published([
      record(0),
      record(1, { window: stuckWindow }),
      record(2, { window: stuckWindow }),
      record(3, { window: stuckWindow }),
      record(4, { move: "none", window: { ...stuckWindow, score: 3 } }),
    ]),
  );
  assert.equal(run.timeline.length, 5);
  assert.equal(run.usage.calls, 5);
  assert.equal(run.usage.inputTokens, 500);
  assert.equal(run.usage.maxDecisionMs, 200);
  assert.equal(run.metrics.maxTickDisplacement, 6);
  assert.equal(run.metrics.stuckTicks, 3);
  assert.equal(run.metrics.longestStuckRun, 3);
  assert.equal(run.metrics.tickOfFirstScore, 4);
  assert.equal(run.lastWindow?.score, 3);
  assert.equal(run.wallMs, 2000);
  assert.deepEqual(
    run.timeline.map((entry) => entry.stuck),
    [false, true, true, true, false],
  );
});

test("resultFromAgent surfaces the agent's own failure as a harness failure", () => {
  rejects(
    () => resultFromAgent(published([], { error: "decision failed (HTTP 401): nope" })),
    /HTTP 401/u,
  );
  rejects(() => resultFromAgent(null), /lost the agent/u);
  rejects(() => resultFromAgent(published(["not a record"])), /malformed record/u);
});

const runResult = (overrides: Partial<RunResult> = {}): RunResult => ({
  ...resultFromAgent(
    published(
      Array.from({ length: 10 }, (_, tick) => record(tick)),
      { wallMs: 4000 },
    ),
  ),
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
  assert.equal(built.decisionsPerSecond, 2.5);
  assert.equal(built.decisions.meanConfidence, 0.6);
  assert.deepEqual(built.decisions.progress, { first: 0.25, last: 0.25, max: 0.25, mean: 0.25 });
  const { failures, warnings } = verdict(built, opts);
  assert.deepEqual(failures, []);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0] ?? "", /never progressed the objective \(and the model agreed/u);
  assert.deepEqual(verdict(built, options({ expectProgress: true })).failures, [
    "the run never progressed the objective (and the model agreed: progress 0.25 → 0.25)",
  ]);
  // A goal the score field can't see: the model's own read is the tie-breaker.
  const judged = report(
    opts,
    resultFromAgent(published([record(0, { progress: 0.2 }), record(1, { progress: 0.8 })])),
  );
  assert.deepEqual(judged.decisions.progress, { first: 0.2, last: 0.8, max: 0.8, mean: 0.5 });
  assert.match(verdict(judged, opts).warnings[0] ?? "", /though the model judged .* 0\.2 → 0\.8/u);
  const unscored = report(opts, resultFromAgent(published([record(0, { progress: null })])));
  assert.equal(unscored.decisions.progress, null);
  // A short run at a healthy frame rate clears the gate the bot's absolute
  // 100-frame threshold would have failed.
  const short = report(opts, runResult({ lastWindow: window({ frame: 60 }), wallMs: 1500 }));
  assert.deepEqual(verdict(short, opts).failures, []);
});

test("verdict fails a stalled loop, dead input, a wedged player and page errors", () => {
  const opts = options();
  const base = runResult();
  const stalled: RunResult = {
    ...base,
    // 20 frames over 4 s: under 10 fps, so stalled.
    lastWindow: window({ frame: 40 }),
    metrics: { ...base.metrics, longestStuckRun: THRESHOLDS.wedgedRun, maxTickDisplacement: 0 },
  };
  const built = { ...report(opts, stalled), pageErrors: ["boom"] };
  const { failures } = verdict(built, opts);
  assert.match(failures.join("\n"), /game loop stalled/u);
  assert.match(failures.join("\n"), /did not respond to input/u);
  assert.match(failures.join("\n"), /wedged for 5 consecutive/u);
  assert.match(failures.join("\n"), /1 uncaught page error/u);
});

test("verdict tells a model that never tried to move apart from dead input", () => {
  const opts = options();
  const idle = resultFromAgent({
    completedAtTick: null,
    done: true,
    error: null,
    records: [
      record(0, {
        askedToMove: false,
        move: "none",
        window: window({ frame: 400, frameBefore: 0, path: 0, peak: 0 }),
      }),
    ],
    wallMs: 4000,
  });
  const { failures } = verdict(report(opts, idle), opts);
  assert.match(failures.join("\n"), /never chose a movement/u);
  assert.doesNotMatch(failures.join("\n"), /did not respond to input/u);
});

test("verdict warns when the model was rarely sure, pointing at the diagnostics", () => {
  const opts = options();
  const run = resultFromAgent(
    published([record(0, { confidence: 0.1 }), record(1, { confidence: 0.1 })]),
  );
  const built = report(opts, run);
  assert.equal(built.decisions.meanConfidence, 0.1);
  assert.equal(built.decisionsPerSecond, 1);
  const { warnings } = verdict(built, opts);
  assert.match(warnings.join("\n"), /rarely sure which way to move .* __GAME_DIAGNOSTICS__/u);
});
