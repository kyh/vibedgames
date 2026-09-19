import assert from "node:assert/strict";
import { test } from "node:test";

import type { Diagnostics, PlaytestTarget } from "../src/index.js";
import {
  definePlaytest,
  isPlaytestRequested,
  keyTapper,
  pointerAim,
  pointerTracker,
  publishDiagnostics,
  publishPlaytest,
  publishTestHooks,
} from "../src/index.js";

interface PongDiagnostics extends Diagnostics {
  ball: { x: number };
}

test("publishDiagnostics installs a live getter, not a copy", () => {
  const target: PlaytestTarget = {};
  const state: PongDiagnostics = { ball: { x: 0 }, complete: false, frame: 0, score: 0 };
  publishDiagnostics(() => state, target);
  assert.equal(target.__GAME_DIAGNOSTICS__?.frame, 0);
  state.frame = 7;
  assert.equal(target.__GAME_DIAGNOSTICS__?.frame, 7);
  // Re-publishing (HMR, a scene change) replaces rather than throws.
  publishDiagnostics(() => ({ ...state, frame: 99 }), target);
  assert.equal(target.__GAME_DIAGNOSTICS__?.frame, 99);
  // The CLI reads the getter through JSON, the way agent-browser's eval returns it.
  // oxlint-disable-next-line unicorn/prefer-structured-clone -- the JSON round trip is the thing under test
  assert.equal(JSON.parse(JSON.stringify(target)).__GAME_DIAGNOSTICS__.frame, 99);
});

test("publishTestHooks sets the global and hands the hooks back typed", () => {
  const target: PlaytestTarget = {};
  const hooks = publishTestHooks(
    {
      forceWave: (n: number) => n,
      seed: () => {},
      setState: (name) => ({ state: name }),
    },
    target,
  );
  assert.equal(hooks.forceWave(3), 3);
  assert.deepEqual(target.__GAME_TEST_HOOKS__?.setState("active-play"), { state: "active-play" });
});

test("publishPlaytest accepts a manifest with a typed reflex and publishes it", () => {
  const target: PlaytestTarget = {};
  const manifest = definePlaytest<PongDiagnostics>({
    actions: { serve: { description: "serve the ball", keys: ["Space"] } },
    goal: "Return every ball.",
    move: {
      centre: { description: "Park the paddle in the centre", pointer: { x: 0.5, y: 0.5 } },
      track_ball: {
        description: "Follow the ball",
        reflex: (game) => (game ? { pointer: { x: game.ball.x, y: 0.5 } } : null),
      },
    },
  });
  assert.equal(publishPlaytest(manifest, target), manifest);
  assert.equal(target.__GAME_PLAYTEST__?.goal, "Return every ball.");
  // A function survives on the live object and is dropped from the JSON the CLI reads at launch.
  // oxlint-disable-next-line unicorn/prefer-structured-clone -- structuredClone throws on the reflex; JSON dropping it is the point
  const wire = JSON.parse(JSON.stringify(target.__GAME_PLAYTEST__));
  assert.deepEqual(Object.keys(wire.move.track_ball), ["description"]);
});

test("publishPlaytest rejects what `vg playtest run` would reject, naming the option", () => {
  const target: PlaytestTarget = {};
  const rejects = (manifest: Parameters<typeof publishPlaytest>[0], pattern: RegExp): void => {
    assert.throws(() => publishPlaytest(manifest, target), pattern);
    assert.equal(target.__GAME_PLAYTEST__, undefined, "nothing is published on a bad manifest");
  };
  rejects({ goal: " ", move: { right: { description: "Run right", keys: ["KeyD"] } } }, /goal/u);
  rejects({ goal: "Go", move: {} }, /at least one option/u);
  rejects(
    { goal: "Go", move: { right: { description: "", keys: ["KeyD"] } } },
    /move\.right .*description/u,
  );
  rejects(
    { goal: "Go", move: { aim: { description: "Aim", pointer: { x: 320, y: 240 } } } },
    /move\.aim.*viewport fractions/u,
  );
  rejects({ goal: "Go", move: { none: { description: "Stay still", keys: [] } } }, /never move/u);
  rejects(
    {
      actions: { fire: { description: "fire", keys: [] } },
      goal: "Go",
      move: { right: { description: "Run right", keys: ["KeyD"] } },
    },
    /actions\.fire .*keys/u,
  );
  rejects(
    {
      goal: "Go",
      minDisplacement: 0,
      move: { right: { description: "Run right", keys: ["KeyD"] } },
    },
    /minDisplacement/u,
  );
});

test("isPlaytestRequested reads ?test=1 and nothing else", () => {
  assert.equal(isPlaytestRequested("?test=1"), true);
  assert.equal(isPlaytestRequested("?seed=5&test=1"), true);
  assert.equal(isPlaytestRequested("?test=0"), false);
  assert.equal(isPlaytestRequested(""), false);
  // Under Node there is no location, so the default is "not requested".
  assert.equal(isPlaytestRequested(), false);
});

test("pointerTracker walks towards the error, capped per frame and clamped to the court", () => {
  const track = pointerTracker({ gain: 0.5, max: 0.9, maxStep: 0.1, min: 0.1 });
  assert.deepEqual(track(0.05), { pointer: { down: false, x: 0.525, y: 0.5 } });
  // A large error is capped to one maxStep per frame.
  assert.equal(track(10).pointer?.x, 0.625);
  for (let i = 0; i < 10; i += 1) {
    track(10);
  }
  assert.equal(track(10).pointer?.x, 0.9, "clamped at max");
  for (let i = 0; i < 20; i += 1) {
    track(-10);
  }
  assert.equal(track(-10).pointer?.x, 0.1, "clamped at min");
  // A NaN error holds position rather than poisoning it.
  assert.equal(track(Number.NaN).pointer?.x, 0.1);
  const pressed = pointerTracker({ down: true, start: 0.2, y: 0.8 });
  assert.deepEqual(pressed(0), { pointer: { down: true, x: 0.2, y: 0.8 } });
});

test("keyTapper alternates press and release so every cycle is a fresh keydown", () => {
  const tap = keyTapper({ downFrames: 2, upFrames: 1 });
  const frames = [1, 2, 3, 4, 5, 6].map(() => tap(["Space"]).join(","));
  assert.deepEqual(frames, ["Space", "Space", "", "Space", "Space", ""]);
  assert.deepEqual(tap([]), []);
  assert.deepEqual(tap(["Space"]), ["Space"], "a new request starts on a press");
});

test("pointerAim parks the cursor in the target's direction, at the radius", () => {
  assert.deepEqual(pointerAim(300, 0).pointer, { down: false, x: 0.85, y: 0.5 });
  assert.deepEqual(pointerAim(0, -10, { down: true, radius: 0.2 }).pointer, {
    down: true,
    x: 0.5,
    y: 0.3,
  });
  assert.deepEqual(pointerAim(0, 0).pointer, { down: false, x: 0.5, y: 0.5 });
  assert.deepEqual(pointerAim(Number.NaN, 1).pointer, { down: false, x: 0.5, y: 0.5 });
});
