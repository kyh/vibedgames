import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { EventEmitter } from "node:events";
import * as constants from "../src/shared/constants.ts";
import * as route from "../src/shared/challenge-route.ts";

// Actual scene methods; only browser, network and Phaser display owners are replaced.
const source = readFileSync(new URL("../src/scenes/game-scene.ts", import.meta.url), "utf8");
const method = (name) => {
  const code = new RegExp(`^  private (?:get |readonly )?${name}(?:\\(| =)[^]*?^  };?`, "m").exec(
    source,
  )?.[0];
  assert.ok(code, name);
  return code;
};
const storage = new Map([
  [constants.BEST_KEY, "23"],
  [route.CHALLENGE_BEST_KEY, "4"],
]);
const nodes = new Map();
const node = (id) => {
  if (!nodes.has(id))
    nodes.set(id, {
      textContent: "",
      hidden: false,
      disabled: false,
      classList: { remove() {}, toggle() {} },
      style: { setProperty() {} },
    });
  return nodes.get(id);
};
let seedsDrawn = 0;
const Scene = new Function(
  "deps",
  `${stripTypeScriptTypes(
    `
const {${Object.keys({ ...constants, ...route }).join(",")},Phaser,document,randomSeed,storageGet,storageSet,readBest,writeBest,prefersReducedMotion}=deps;
const RESTART_LOCKOUT_MS=280;
class Scene {
${["challengeSeed", "racing", "onChallengeStart", "onRouteRetry", "onRouteNormal", "selectChallenge", "resetRouteFlight", "refreshRouteHud", "recordRouteGate", "restart", "checkScore", "screenX", "collectCoin", "die", "updateResults"].map(method).join("\n")}
}`,
    { mode: "strip" },
  )};return Scene;`,
)({
  ...constants,
  ...route,
  Phaser: {
    TintModes: { FILL: "fill", MULTIPLY: "multiply" },
    Animations: { Events: { ANIMATION_COMPLETE: "complete" } },
  },
  document: { getElementById: node },
  randomSeed: () => {
    seedsDrawn++;
    return 71 + seedsDrawn;
  },
  storageGet: (key) => storage.get(key) ?? null,
  storageSet: (key, value) => storage.set(key, value),
  readBest: () => Number(storage.get(constants.BEST_KEY)),
  writeBest: (score) => storage.set(constants.BEST_KEY, String(score)),
  prefersReducedMotion: () => true,
});
const sprite = () => {
  const value = { x: 86, y: 216 };
  for (const method of [
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
  ])
    value[method] = () => value;
  return value;
};
const fresh = () => {
  const scene = new Scene();
  const calls = { sessions: [], countdown: 0, starts: 0, clear: 0, celebrations: [], sounds: [] };
  Object.assign(scene, {
    externalReleased: false,
    presentationPaused: false,
    started: false,
    countingDown: false,
    flightMode: { kind: "normal" },
    phase: "ready",
    worldX: 0,
    score: 0,
    best: 23,
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
    add: { sprite },
    resultsEl: node("flight-result"),
    routeRetryEl: node("route-retry"),
    routeNormalEl: node("route-normal"),
    resultRetryEl: node("result-retry"),
    routeHud: node("route-hud"),
    flightFx: {
      pass() {},
      pickup() {},
      crash() {},
      celebrate: (text) => calls.celebrations.push(text),
    },
    sound: { stopAll() {} },
    net: { otherPlayer: () => null, patchShared: () => {} },
    replaceSession: (offline) => {
      calls.sessions.push(offline);
      scene.seed = 0;
    },
    ensureSeed: () => {
      scene.seed = scene.challengeSeed() ?? 100;
    },
    cancelPhrase() {},
    clearPipes: () => {
      calls.clear++;
      scene.pipes.clear();
    },
    reviveBird: () => {
      scene.resultsEl.classList.remove("show");
    },
    setPhase: (phase) => {
      scene.phase = phase;
    },
    beginPlay: () => {
      calls.starts++;
      scene.started = true;
      calls.countdown++;
    },
    runCountdown: () => {
      calls.countdown++;
    },
    playPhrase() {},
    playSound: (key) => calls.sounds.push(key),
    refreshScore() {},
    scorePop() {},
    showMilestone() {},
    setBest() {},
    setHint() {},
    layoutResults() {},
    viewW: () => 720,
    scoreY: () => 20,
  });
  return { scene, calls };
};

{
  const { scene, calls } = fresh();
  scene.onChallengeStart();
  assert.deepEqual(calls.sessions, [true]);
  assert.equal(scene.seed, route.CHALLENGE_SEED);
  assert.equal(scene.best, 4);
  assert.equal(calls.starts, 1);
  const beforeDraws = seedsDrawn;
  for (let retry = 0; retry < 3; retry++) {
    scene.phase = "gameover";
    scene.score = 8;
    scene.flightMode = { kind: "challenge", progress: { gates: 6, lastIndex: 5 } };
    scene.onRouteRetry();
    assert.equal(scene.seed, route.CHALLENGE_SEED);
    assert.equal(scene.score, 0);
    assert.deepEqual(scene.flightMode.progress, route.freshRouteProgress());
  }
  assert.equal(seedsDrawn, beforeDraws, "route retries do not consume a random course seed");
  scene.phase = "gameover";
  scene.onRouteNormal();
  assert.deepEqual(calls.sessions, [true, false]);
  assert.equal(scene.flightMode.kind, "normal");
  assert.equal(scene.best, 23);
  assert.equal(scene.score, 0);
  assert.equal(scene.worldX, 0);
  assert.equal(scene.routeHud.hidden, true);
  scene.phase = "gameover";
  scene.restart();
  assert.equal(seedsDrawn, beforeDraws + 1, "ordinary retry still rolls one random course seed");
  console.log(
    "✓ Actual challenge entry, three retries and normal exit preserve seed/best/session boundaries",
  );
}
{
  const { scene, calls } = fresh();
  scene.flightMode = { kind: "challenge", progress: route.freshRouteProgress() };
  scene.phase = "playing";
  for (let index = 0; index < 10; index++) scene.pipes.set(index, { index });
  for (let index = 0; index < 10; index++) {
    scene.worldX = constants.pipeCourseX(index) + constants.PIPE_WIDTH - constants.BIRD_X;
    scene.checkScore();
    scene.checkScore();
    assert.equal(scene.flightMode.progress.gates, index + 1);
  }
  assert.equal(scene.score, 10);
  assert.equal(scene.phase, "playing");
  assert.deepEqual(calls.celebrations, ["ROUTE CLEARED!"]);
  scene.collectCoin(sprite());
  assert.equal(scene.score, 11);
  assert.equal(scene.flightMode.progress.gates, 10, "real coin award never counts as a gate");
  scene.best = 4;
  scene.die();
  assert.equal(storage.get(route.CHALLENGE_BEST_KEY), "11");
  assert.equal(storage.get(constants.BEST_KEY), "23");
  assert.equal(node("result-best-label").textContent, "ROUTE BEST");
  scene.flightMode = { kind: "normal" };
  scene.score = 24;
  scene.best = 23;
  scene.die();
  assert.equal(storage.get(constants.BEST_KEY), "24");
  assert.equal(storage.get(route.CHALLENGE_BEST_KEY), "11");
  console.log(
    "✓ Actual gate crossings complete once; actual coin/normal score and route persistence remain separate",
  );
}
{
  for (const blocked of ["paused", "released", "race", "279ms"]) {
    const { scene, calls } = fresh();
    scene.started = true;
    scene.phase = "gameover";
    scene.flightMode = { kind: "challenge", progress: route.freshRouteProgress() };
    if (blocked === "paused") scene.presentationPaused = true;
    if (blocked === "released") scene.externalReleased = true;
    if (blocked === "race") scene.net.otherPlayer = () => ({ id: "peer" });
    if (blocked === "279ms") scene.time.now = 1279;
    scene.onRouteRetry();
    assert.equal(calls.countdown, 0, blocked);
    if (blocked !== "race") {
      scene.onRouteNormal();
      assert.equal(calls.sessions.length, 0, blocked);
    }
  }
  console.log(
    "✓ Route actions respect existing retry deadline, live race, local pause and final disposal",
  );
}

// Actual landmark owner: complete sprites stay bounded; no calls after destruction.
{
  const landmarkSource = readFileSync(
    new URL("../src/scenes/forest-landmarks.ts", import.meta.url),
    "utf8",
  );
  const Forest = new Function(
    "Phaser",
    `${stripTypeScriptTypes(landmarkSource.replace(/^import .*;\n/m, "").replace("export class", "class"), { mode: "strip" })};return ForestLandmarks;`,
  )({ Scenes: { Events: { SHUTDOWN: "shutdown", DESTROY: "destroy" } } });
  for (let round = 0; round < 3; round++) {
    const events = new EventEmitter();
    const images = [];
    const scene = {
      events,
      add: {
        image: (_x, _y, key) => {
          assert.equal(key, "landmark-tree");
          const image = {
            destroyed: false,
            x: 0,
            y: 0,
            width: 1082,
            height: 1454,
            visible: false,
            depth: 0,
          };
          for (const method of [
            "setOrigin",
            "setDepth",
            "setAlpha",
            "setPosition",
            "setScale",
            "setVisible",
          ])
            image[method] = (...values) => {
              assert.equal(image.destroyed, false, "no calls into destroyed display nodes");
              if (method === "setPosition") [image.x, image.y] = values;
              if (method === "setDepth") image.depth = values[0];
              if (method === "setScale") image.scale = values[0];
              if (method === "setVisible") image.visible = values[0];
              return image;
            };
          images.push(image);
          return image;
        },
      },
    };
    const forest = new Forest(scene);
    assert.equal(images.length, 7);
    for (let worldX = 0; worldX < 100000; worldX += 150) {
      const before = images.map((image) => ({
        x: image.x,
        right: image.x + (image.width * image.scale) / 2,
      }));
      forest.update(worldX, { width: 480, top: -200, floor: 720 });
      if (worldX > 0)
        for (let i = 0; i < images.length; i++) {
          if (images[i].x - before[i].x > 1000)
            assert.ok(
              before[i].right <= 150 * 0.45 + 0.001,
              "recycle only after the complete silhouette leaves view",
            );
        }
      assert.equal(images.length, 7);
      assert.ok(images.every((image) => Number.isFinite(image.x) && image.depth < 0));
    }
    forest.update(0, { width: 480, top: 0, floor: 720 });
    const first = images.map((image) => [image.x, image.y, image.visible]);
    forest.update(14000, { width: 1280, top: 0, floor: 720 });
    forest.update(0, { width: 480, top: 0, floor: 720 });
    assert.deepEqual(
      images.map((image) => [image.x, image.y, image.visible]),
      first,
    );
    for (const image of images) image.destroyed = true;
    events.emit(round === 1 ? "destroy" : "shutdown");
    forest.update(0, { width: 480, top: 0, floor: 720 });
    assert.equal(events.listenerCount("shutdown") + events.listenerCount("destroy"), 0);
  }
  console.log(
    "✓ Seven landmark images stay bounded across long courses, resizes and three owner lifetimes",
  );
}
