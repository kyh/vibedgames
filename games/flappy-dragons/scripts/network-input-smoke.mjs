import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { test } from "node:test";
import { PhysicalGamepad } from "@vibedgames/gamepad";

const source = stripTypeScriptTypes(
  readFileSync(new URL("../src/scenes/game-scene.ts", import.meta.url), "utf8"),
);
// These bounded methods have balanced block/object braces and no brace-bearing
// strings. Extract their actual implementations, not parallel test algorithms.
function method(name, bindings = {}) {
  const start = source.indexOf(`  ${name}(`);
  assert.notEqual(start, -1, `actual method ${name} exists`);
  const open = source.indexOf("{", start);
  let depth = 1,
    end = open + 1;
  while (depth > 0 && end < source.length) {
    if (source[end] === "{") depth++;
    if (source[end] === "}") depth--;
    end++;
  }
  assert.equal(depth, 0);
  const signature = source.slice(start, open).trim();
  return new Function(
    ...Object.keys(bindings),
    `return function ${signature}${source.slice(open, end).replaceAll("import.meta.env.DEV", "true")}`,
  )(...Object.values(bindings));
}
function state() {
  const pad = {
    connected: true,
    mapping: "standard",
    axes: [0, 0, 0, 0],
    buttons: Array.from({ length: 17 }, () => ({ pressed: false, value: 0 })),
  };
  const game = {
    presentationPaused: false,
    pad: new PhysicalGamepad({ poll: () => [pad] }),
    started: true,
    countingDown: false,
    phase: "playing",
    muted: false,
    countdownTimer: { paused: false },
    sound: {
      mute: false,
      stopAll() {
        game.stops++;
      },
    },
    accepted: [],
    starts: 0,
    stops: 0,
    phrases: 0,
    beginPlay() {
      game.starts++;
    },
    flap(...args) {
      game.accepted.push(args);
    },
    cancelPhrase() {
      game.phrases++;
    },
  };
  return { pad, game };
}
const pause = method("setPresentationPaused"),
  input = method("handleInput");
test("paused input rejects keyboard, pad and both pose phases before start/flap", () => {
  const { game } = state();
  pause.call(game, true);
  for (const [strength, refire] of [
    [1, false],
    [0, false],
    [0.5, true],
  ])
    input.call(game, strength, refire);
  game.started = false;
  input.call(game);
  assert.equal(game.starts, 0);
  assert.deepEqual(game.accepted, []);
  assert.equal(game.countdownTimer.paused, true);
  assert.equal(game.sound.mute, true);
  assert.equal(game.stops, 1);
});
test("resume consumes an already-held gamepad edge but a fresh release/press still flaps", () => {
  const { game, pad } = state();
  game.pad.update();
  pause.call(game, true);
  pad.buttons[0] = { pressed: true, value: 1 };
  pause.call(game, false);
  game.pad.update();
  assert.equal(game.pad.justPressed("a"), false);
  pad.buttons[0] = { pressed: false, value: 0 };
  game.pad.update();
  pad.buttons[0] = { pressed: true, value: 1 };
  game.pad.update();
  assert.equal(game.pad.justPressed("a"), true);
  input.call(game, 0.5, true);
  assert.deepEqual(game.accepted, [[0.5, true]]);
  assert.equal(game.countdownTimer.paused, false);
});
test("live paused polling drains transitions without accepting a flap or freezing network work", () => {
  const { game, pad } = state();
  game.pad.update();
  pause.call(game, true);
  for (let i = 0; i < 4; i++) {
    pad.buttons[0] = { pressed: i % 2 === 0, value: i % 2 === 0 ? 1 : 0 };
    game.pad.update();
    if (game.pad.justPressed("a")) input.call(game);
  }
  assert.deepEqual(game.accepted, []);
  pause.call(game, false);
  input.call(game, 1, false);
  assert.deepEqual(game.accepted, [[1, false]]);
});

test("a changed admitted seed rebuilds cached obstacle geometry before the next collision", () => {
  const adopt = method("adoptSeed"),
    calls = [],
    game = {
      seed: 31,
      clearPipes() {
        calls.push(["clear", this.seed]);
      },
      syncPipes() {
        calls.push(["build", this.seed]);
      },
    };
  adopt.call(game, 42);
  adopt.call(game, 42);
  assert.deepEqual(calls, [
    ["clear", 42],
    ["build", 42],
  ]);
});
test("challenge seed is isolated from shared input; normal course admits only valid seeds", () => {
  const ensure = method("ensureSeed", {
    numField: (o, key) => o[key] ?? null,
    randomSeed: () => 97,
  });
  const adopted = [],
    patched = [],
    game = {
      seed: 0,
      challengeSeed: () => null,
      adoptSeed(seed) {
        this.seed = seed;
        adopted.push(seed);
      },
      net: {
        isHost: false,
        sharedState: null,
        patchShared(patch) {
          patched.push(patch);
        },
      },
    };
  for (const seed of [0, -1, 1.2, Number.NaN, Number.POSITIVE_INFINITY, 0x80000001]) {
    game.net.sharedState = { seed };
    ensure.call(game);
  }
  assert.deepEqual(adopted, []);
  game.net.sharedState = { seed: 41 };
  ensure.call(game);
  assert.deepEqual(adopted, [41]);
  game.challengeSeed = () => 8123;
  ensure.call(game);
  assert.deepEqual(adopted, [41, 8123]);
  assert.deepEqual(patched, []);
  game.challengeSeed = () => null;
  game.seed = 0;
  game.net.sharedState = null;
  game.net.isHost = true;
  ensure.call(game);
  assert.deepEqual(patched, [{ seed: 97 }]);
});
test("explicit route navigation retires the prior session and resets only transport ownership", () => {
  const created = [],
    window = {},
    old = {
      destroys: 0,
      destroy() {
        this.destroys++;
      },
    };
  class NetSession {
    destroys = 0;
    constructor(options) {
      this.options = options;
      created.push(this);
    }
    destroy() {
      this.destroys++;
    }
  }
  const replace = method("replaceSession", {
    NetSession,
    MP_ROOM: "original-room",
    MP_MAX_PLAYERS: 8,
    OFFLINE_FALLBACK_MS: 3000,
    window,
  });
  const game = {
    net: old,
    seed: 37,
    stateAcc: 1,
    worldAcc: 1,
    boardAcc: 1,
    hostSeq: 12,
    lastSeq: 22,
    boardSig: "old",
    lastNetInfo: "old",
    worldX: 321,
    score: 9,
  };
  replace.call(game, true);
  assert.equal(old.destroys, 1);
  assert.equal(created[0].options.forceOffline, true);
  assert.equal(game.net, created[0]);
  assert.equal(game.seed, 0);
  assert.equal(game.lastSeq, -1);
  assert.equal(game.worldX, 321);
  assert.equal(game.score, 9);
  replace.call(game, false);
  assert.equal(created[0].destroys, 1);
  assert.equal(created[1].options.forceOffline, false);
});
