import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { test } from "node:test";
import * as THREE from "three";
import * as constants from "../src/shared/constants.ts";
import { SPIN_LIFE } from "../src/shared/spin.ts";
import { advanceLesson, advancePractice, practiceObjective } from "../src/shared/practice.ts";

// Execute the actual scene methods, replacing only browser/network/FX owners.
const source = readFileSync(new URL("../src/scenes/game-scene.ts", import.meta.url), "utf8");
const method = (name) => {
  const text = new RegExp(`^  (?:private )?(?:get )?${name}(?:\\(| =)[^]*?^  };?`, "m").exec(
    source,
  )?.[0];
  assert.ok(text, name);
  return text;
};
const functions = ["clamp", "reflectOffPaddle"].map((name) => {
  const text = new RegExp(`^function ${name}\\([^]*?^}`, "m").exec(source)?.[0];
  assert.ok(text, name);
  return text;
});
const dependencies = {
  THREE,
  ...constants,
  SPIN_LIFE,
  advanceLesson,
  advancePractice,
  practiceObjective,
  curveInstruction: () => "Flick sideways at contact.",
  connectingPromptPhrases: () => [],
  rematchNotePhrases: () => [],
  servePromptPhrases: () => [],
  notifyGameStarted: () => {},
  clearSound: () => {},
  sfx: { serve: () => {} },
  performance: { now: () => 1000 },
  document: { documentElement: { classList: { toggle: () => {} } } },
  setText: (element, text) => {
    if (element.textContent !== text) element.textContent = text;
  },
  isJsonObject: (value) => Object.prototype.toString.call(value) === "[object Object]",
  isJsonNumber: Number.isFinite,
};
const FixtureScene = new Function(
  ...Object.keys(dependencies),
  `${stripTypeScriptTypes(
    `${functions.join("\n")}\nclass FixtureScene {
${[
  "isGuest",
  "admitRole",
  "mySlotA",
  "flip",
  "hasOpponent",
  "hasLiveOpponent",
  "confirm",
  "serve",
  "onPracticeChoice",
  "onPracticeRestart",
  "onPracticeExit",
  "resetPracticeRound",
  "resetStrokes",
  "observeLocalContact",
  "onPaddleHit",
  "handleEvent",
  "syncHud",
  "syncTeaching",
]
  .map(method)
  .join("\n")}
}`,
    { mode: "strip" },
  )}; return FixtureScene;`,
)(...Object.values(dependencies));

const element = () => ({
  hidden: false,
  textContent: "",
  style: {},
  classList: { remove: () => {} },
});
const fresh = () => {
  const scene = new FixtureScene();
  const calls = { offline: 0, online: 0, particles: 0, rings: 0, fx: [], events: [] };
  let strength = 0;
  let opponent = null;
  Object.assign(scene, {
    role: "solo",
    disposed: false,
    paused: false,
    playMode: { kind: "match" },
    curveLesson: "return",
    lessonUntil: 0,
    phase: "serving",
    serveAt: null,
    scoreYou: 0,
    scoreAi: 0,
    longestRally: 0,
    elapsed: 10,
    playerX: 0,
    aiX: 0,
    ballPos: new THREE.Vector2(0, -constants.PADDLE_Y),
    ballVel: new THREE.Vector2(0, -constants.RALLY_SPEED_BASE),
    camKick: new THREE.Vector3(),
    rallySpeed: constants.RALLY_SPEED_BASE,
    rallyHits: 0,
    spinShots: 0,
    random: () => 0.5,
    stroke: { read: () => strength, reset: () => {} },
    remoteStrokeIntent: 0,
    remoteStrokeUntil: 0,
    particles: { clear: () => calls.particles++ },
    rings: { clear: () => calls.rings++ },
    net: {
      live: true,
      offline: true,
      hostId: "host",
      otherPlayer: () => opponent,
      sendEvent: (...args) => calls.events.push(args),
    },
    watchBannerControls: () => {},
    netInfoText: () => "AI",
    showBanner: (...args) => {
      scene.lastBanner = args;
    },
    paddleHitFx: (...args) => calls.fx.push(args),
    emitBeat: (...args) => calls.events.push(args),
    playSolo: () => {
      calls.offline++;
      scene.role = "solo";
      scene.net.offline = true;
      opponent = null;
    },
    replaceSession: (offline) => {
      assert.equal(offline, false);
      calls.online++;
      scene.role = "pending";
      scene.net.live = false;
      scene.net.offline = false;
    },
  });
  for (const name of [
    "bannerEl",
    "scoreYouEl",
    "scoreAiEl",
    "oppLabelEl",
    "matchPointEl",
    "netInfoEl",
    "pointEl",
    "shotEl",
    "comboEl",
    "teachingEl",
    "teachingTitleEl",
    "teachingHintEl",
    "practiceChoiceEl",
    "practiceToolsEl",
  ])
    scene[name] = element();
  return {
    scene,
    calls,
    strength: (next) => {
      strength = next;
    },
    opponent: (next) => {
      opponent = next;
    },
  };
};

test("actual accepted contacts teach only the local paddle, keeping shot physics and beats", () => {
  const fixture = fresh();
  const { scene, calls } = fixture;
  scene.playMode = { kind: "practice", progress: "return" };
  scene.onPaddleHit("player");
  assert.equal(scene.playMode.progress, "left");
  assert.equal(scene.curveLesson, "curve");
  assert.equal(scene.ballVel.x, 0);
  assert.equal(scene.ballVel.y, constants.RALLY_SPEED_BASE + constants.RALLY_SPEED_STEP);
  fixture.opponent({ id: "guest" });
  scene.remoteStrokeIntent = -0.8;
  scene.remoteStrokeUntil = 2;
  scene.onPaddleHit("ai");
  assert.equal(scene.playMode.progress, "left", "opponent cannot complete the local objective");
  fixture.strength(-0.8);
  scene.onPaddleHit("player");
  assert.equal(scene.playMode.progress, "right");
  fixture.strength(0.8);
  scene.onPaddleHit("player");
  assert.equal(scene.playMode.progress, "complete");
  assert.equal(scene.curveLesson, "complete");
  assert.equal(scene.spinShots, 3, "existing host-wide telemetry stays independent");
  assert.equal(scene.rallyHits, 4);
  assert.equal(calls.fx.length, 4);
  assert.equal(calls.events.length, 4);
  assert.equal(calls.events[3][0], "phit");
  assert.equal(calls.events[3][1].spin, 0.8);
});

test("guest teaching accepts only host-authenticated local contact beats", () => {
  const { scene, calls } = fresh();
  scene.role = "guest";
  scene.net.offline = false;
  scene.handleEvent("phit", { a: false, spin: 1 }, "intruder");
  assert.equal(scene.curveLesson, "return");
  scene.handleEvent("phit", { a: true, spin: -1 }, "host");
  assert.equal(scene.curveLesson, "return");
  scene.handleEvent("phit", { a: false, spin: 0 }, "host");
  assert.equal(scene.curveLesson, "curve");
  scene.handleEvent("phit", { a: false, spin: -0.5 }, "host");
  assert.equal(scene.curveLesson, "complete");
  assert.equal(scene.spinShots, 0);
  assert.equal(calls.fx.length, 3);
});

test("native practice handlers own explicit fresh sessions and clear the old round", () => {
  const { scene, calls } = fresh();
  scene.scoreYou = 6;
  scene.scoreAi = 4;
  scene.phase = "won";
  scene.onPracticeChoice();
  assert.equal(calls.offline, 1);
  assert.equal(scene.playMode.progress, "return");
  assert.equal(scene.phase, "rally");
  assert.equal(scene.scoreYou, 0);
  assert.equal(scene.scoreAi, 0);
  assert.equal(scene.ballVel.y, -constants.RALLY_SPEED_BASE);
  scene.playMode = { kind: "practice", progress: "complete" };
  scene.curveLesson = "complete";
  scene.scoreYou = 7;
  scene.scoreAi = 2;
  scene.phase = "won";
  scene.confirm();
  assert.equal(scene.playMode.progress, "complete", "normal rematch keeps practice achievements");
  assert.equal(scene.scoreYou, 0);
  scene.onPracticeRestart();
  assert.equal(scene.playMode.progress, "return");
  assert.equal(scene.curveLesson, "complete", "session teaching stays learned");
  scene.scoreYou = 3;
  scene.onPracticeExit();
  assert.deepEqual(scene.playMode, { kind: "match" });
  assert.equal(calls.online, 1);
  assert.equal(scene.scoreYou, 0);
  assert.equal(scene.scoreAi, 0);
  assert.equal(scene.phase, "serving");
  assert.equal(scene.serveAt, null, "fresh matchmaking cannot inherit an automatic serve deadline");
  assert.equal(scene.freeze, 0);
  assert.equal(calls.particles, 3);
  assert.equal(calls.rings, 3);
  assert.equal(scene.practiceToolsEl.hidden, true);
});

test("practice cannot interrupt a live opponent, paused game or disposed owner", () => {
  for (const blocked of ["human", "paused", "disposed"]) {
    const fixture = fresh();
    const { scene, calls } = fixture;
    if (blocked === "human") {
      scene.net.offline = false;
      fixture.opponent({ id: "guest" });
    } else scene[blocked] = true;
    scene.onPracticeChoice();
    assert.equal(calls.offline, 0, blocked);
    assert.deepEqual(scene.playMode, { kind: "match" });
    if (blocked !== "human") {
      scene.playMode = { kind: "practice", progress: "right" };
      scene.onPracticeRestart();
      scene.onPracticeExit();
      assert.deepEqual(scene.playMode, { kind: "practice", progress: "right" });
      assert.equal(calls.online, 0);
    }
  }
});

test("HUD offers practice only outside a live human match and keeps completed teaching quiet", () => {
  const fixture = fresh();
  const { scene } = fixture;
  scene.syncHud();
  assert.equal(scene.practiceChoiceEl.hidden, false);
  fixture.opponent({ id: "guest" });
  scene.net.offline = false;
  scene.syncHud();
  assert.equal(scene.practiceChoiceEl.hidden, true);
  scene.phase = "rally";
  scene.curveLesson = "complete";
  scene.lessonUntil = 0;
  scene.syncHud();
  assert.equal(scene.teachingEl.hidden, true);
  scene.playMode = { kind: "practice", progress: "right" };
  scene.syncHud();
  assert.equal(scene.practiceToolsEl.hidden, false);
  assert.equal(scene.teachingEl.hidden, false);
  assert.equal(scene.teachingTitleEl.textContent, "3 / 3 · Curve right at contact");
});
