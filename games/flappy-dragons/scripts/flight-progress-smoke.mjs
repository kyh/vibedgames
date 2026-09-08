import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { test } from "node:test";
import * as constants from "../src/shared/constants.ts";

// Execute the scene's real acceptance, retry and result paths; replace only its display/transport owners.
const source = readFileSync(new URL("../src/scenes/game-scene.ts", import.meta.url), "utf8");
const method = (name) => {
  const code = new RegExp(`^  (?:private )?(?:get )?${name}\\([^]*?^  }`, "m").exec(source)?.[0];
  assert.ok(code, name);
  return code;
};
const sprite = () => {
  const value = { x: 86, y: 216 };
  for (const name of [
    "setPosition",
    "setTint",
    "setTintMode",
    "clearTint",
    "setVisible",
    "setScale",
    "setDepth",
    "play",
    "stop",
    "once",
    "destroy",
    "setAlpha",
    "setRotation",
  ])
    value[name] = () => value;
  return value;
};
function fresh({ racing = false } = {}) {
  const nodes = new Map();
  const node = (id) => {
    if (!nodes.has(id))
      nodes.set(id, {
        textContent: "",
        hidden: false,
        classList: { remove() {}, toggle() {} },
        style: { setProperty() {} },
      });
    return nodes.get(id);
  };
  const calls = {
    seedDraws: 0,
    patches: [],
    countdown: 0,
    starts: 0,
    celebrations: [],
    phrases: 0,
    sounds: [],
    flaps: 0,
    ticks: 0,
  };
  const writes = [];
  const deps = {
    ...constants,
    Phaser: {
      TintModes: { FILL: "fill", MULTIPLY: "multiply" },
      Animations: { Events: { ANIMATION_COMPLETE: "complete" } },
      Math: { Clamp: (value, min, max) => Math.max(min, Math.min(max, value)) },
    },
    document: { getElementById: node },
    notifyGameStarted: () => calls.starts++,
    setPoseLocked() {},
    randomSeed: () => 70 + ++calls.seedDraws,
    writeBest: (value) => writes.push([constants.BEST_KEY, value]),
    prefersReducedMotion: () => true,
    HINT_RESTART: "RESTART",
    HINT_FLAP: "FLAP",
    MAX_DT_MS: 50,
    RESTART_LOCKOUT_MS: 280,
  };
  const names = [
    "racing",
    "alive",
    "setPhase",
    "refreshGateHud",
    "checkScore",
    "screenX",
    "frontIndex",
    "collectCoin",
    "showMilestone",
    "handleInput",
    "restart",
    "respawn",
    "enterPlaying",
    "reviveBird",
    "die",
    "updateResults",
    "update",
    "advanceWorld",
    "setPresentationPaused",
  ];
  const Scene = new Function(
    ...Object.keys(deps),
    stripTypeScriptTypes(`class Scene { ${names.map(method).join("\n")} }`) + ";return Scene;",
  )(...Object.values(deps));
  const scene = new Scene();
  Object.assign(scene, {
    externalReleased: false,
    presentationPaused: false,
    started: true,
    countingDown: false,
    phase: "playing",
    worldX: 0,
    score: 0,
    gates: 0,
    best: 1000,
    seed: 99,
    birdY: 200,
    vy: 0,
    diedAt: 1000,
    lastScoredIndex: -1,
    collectedCoins: new Set(),
    pipes: new Map(),
    ghosts: new Map(),
    time: { now: 1280, delayedCall: () => ({ remove() {} }) },
    bird: sprite(),
    overImg: sprite(),
    readyImg: sprite(),
    add: { sprite },
    resultsEl: node("flight-result"),
    resultRetryEl: node("result-retry"),
    gatesEl: node("flight-gates"),
    flightFx: {
      pass() {},
      pickup() {},
      crash() {},
      reset() {},
      update() {},
      celebrate: (text) => calls.celebrations.push(text),
    },
    tweens: { killTweensOf() {} },
    sound: { stopAll() {} },
    muted: false,
    net: {
      isHost: true,
      otherPlayer: () => (racing ? { id: "peer" } : null),
      patchShared: (patch) => calls.patches.push(patch),
      tick: () => calls.ticks++,
    },
    pad: { update() {}, justPressed: () => false },
    cancelPhrase() {},
    clearPipes: () => scene.pipes.clear(),
    runCountdown: () => calls.countdown++,
    playPhrase: () => calls.phrases++,
    playSound: (key) => {
      if (!scene.presentationPaused) calls.sounds.push(key);
    },
    flap: () => calls.flaps++,
    refreshScore() {},
    scorePop() {},
    setBest() {},
    setHint() {},
    layoutResults() {},
    viewW: () => 720,
    viewTop: () => 0,
    scoreY: () => 20,
    spawnY: () => 220,
    ensureSeed() {},
    checkCoins() {},
    checkDeath() {},
    applyParallax() {},
    syncPipes() {},
    syncGhosts() {},
    broadcast() {},
    updateBoard() {},
  });
  scene.refreshGateHud();
  const pass = (index) => {
    scene.pipes.set(index, { index });
    scene.worldX = constants.pipeCourseX(index) + constants.PIPE_WIDTH - constants.BIRD_X;
    scene.checkScore();
  };
  return { scene, calls, node, writes, pass };
}

test("every solo/race flight earns actual gates, independently of coins, and continues beyond each ten", () => {
  for (const racing of [false, true]) {
    const { scene, calls, pass, node } = fresh({ racing });
    for (let index = 0; index < 25; index++) {
      scene.pipes.set(index, { index });
      scene.worldX = constants.pipeCourseX(index) + constants.PIPE_WIDTH - constants.BIRD_X - 0.01;
      scene.checkScore();
      assert.equal(scene.gates, index, "gate not earned before its trailing edge passes");
      pass(index);
      scene.checkScore();
      assert.equal(scene.gates, index + 1, "repeated frames cannot award twice");
      const before = calls.celebrations.length;
      scene.collectCoin(sprite());
      assert.equal(scene.gates, index + 1);
      assert.equal(calls.celebrations.length, before, "coins never trigger a gate milestone");
    }
    assert.equal(scene.score, 50);
    assert.equal(scene.phase, "playing");
    assert.equal(node("flight-gates").textContent, "25 GATES");
    assert.equal(node("flight-gates").hidden, false);
    assert.deepEqual(calls.celebrations, ["10 GATES · KEEP FLYING!", "20 GATES · KEEP FLYING!"]);
    assert.equal(calls.phrases, 2);
    assert.equal(calls.seedDraws, 0, "no replacement course at milestones");
    assert.deepEqual(calls.patches, []);
  }
});

test("only current-life accepted gates enter results; a real retry resets them and draws one ordinary seed", () => {
  const { scene, calls, pass, node, writes } = fresh();
  pass(0);
  scene.collectedCoins.add(0);
  scene.collectCoin(sprite());
  scene.best = 1;
  scene.die();
  assert.equal(node("result-gates").textContent, "1");
  assert.equal(node("result-coins").textContent, "1");
  assert.equal(node("result-score").textContent, "2");
  assert.equal(node("flight-gates").hidden, true);
  assert.deepEqual(writes, [[constants.BEST_KEY, 2]], "ordinary personal-best storage only");
  pass(1);
  assert.equal(scene.gates, 1, "dead frames cannot add a gate");
  scene.time.now = scene.diedAt + 279;
  scene.handleInput();
  assert.equal(calls.countdown, 0);
  scene.time.now++;
  scene.handleInput();
  assert.equal(calls.countdown, 1);
  assert.equal(calls.seedDraws, 1);
  assert.deepEqual(calls.patches, [{ seed: 71 }]);
  assert.equal(scene.gates, 0);
  assert.equal(scene.score, 0);
  assert.equal(scene.worldX, 0);
  assert.equal(scene.lastScoredIndex, -1);
  assert.equal(scene.collectedCoins.size, 0);
  assert.equal(scene.phase, "ready");
  assert.equal(node("flight-gates").hidden, true);
  scene.handleInput();
  assert.equal(scene.phase, "playing");
  assert.equal(node("flight-gates").textContent, "0 GATES");
  pass(0);
  assert.equal(scene.gates, 1);
});

test("race death keeps original comeback deadline/course; respawn cannot inherit passed gates", () => {
  const { scene, calls, pass } = fresh({ racing: true });
  for (let i = 0; i < 10; i++) pass(i);
  scene.die();
  const course = scene.worldX;
  const seed = scene.seed;
  scene.time.now = scene.diedAt + 10000;
  scene.handleInput();
  assert.equal(calls.seedDraws, 0, "manual retry cannot rewind a race");
  scene.update(scene.diedAt + constants.RESPAWN_MS - 1, 0);
  assert.equal(scene.phase, "gameover");
  scene.update(scene.diedAt + constants.RESPAWN_MS, 0);
  assert.equal(scene.phase, "playing");
  assert.equal(scene.worldX, course);
  assert.equal(scene.seed, seed);
  assert.equal(scene.gates, 0);
  assert.equal(scene.score, 0);
  scene.checkScore();
  assert.equal(scene.gates, 0, "cached pipes behind the respawn do not count");
  pass(10);
  assert.equal(scene.gates, 1);
  assert.equal(calls.celebrations.length, 1);
  assert.deepEqual(calls.patches, []);
});

test("online pause gates local input while real update keeps course/gates live, without stale celebration", () => {
  const { scene, calls, pass } = fresh({ racing: true });
  for (let i = 0; i < 9; i++) pass(i);
  scene.setPresentationPaused(true);
  scene.handleInput();
  assert.equal(calls.flaps, 0);
  scene.pipes.set(9, { index: 9 });
  scene.worldX = constants.pipeCourseX(9) + constants.PIPE_WIDTH - constants.BIRD_X - 1;
  const before = scene.worldX;
  scene.update(1500, 50);
  assert.ok(scene.worldX > before);
  assert.equal(calls.ticks, 1);
  assert.equal(scene.gates, 10);
  assert.deepEqual(calls.celebrations, []);
  assert.equal(calls.phrases, 0);
  scene.setPresentationPaused(false);
  scene.update(1550, 0);
  assert.deepEqual(calls.celebrations, []);
  for (let i = 10; i < 20; i++) pass(i);
  assert.deepEqual(calls.celebrations, ["20 GATES · KEEP FLYING!"]);
  scene.handleInput();
  assert.equal(calls.flaps, 1);
});
