import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import test from "node:test";
import * as THREE from "three";

import * as constants from "../src/shared/constants.ts";
import * as circuit from "../src/shared/pearl-circuit.ts";
import { CircuitMarkers } from "../src/render/circuit-markers.ts";
import { PelletField } from "../src/render/pellet-field.ts";

// Execute the production scene methods with real Three pearl/ring fields.
// Transport, DOM, audio and unrelated actor rendering are bounded collaborators.
const source = readFileSync(new URL("../src/scenes/game-scene.ts", import.meta.url), "utf8");
function method(name) {
  const match = new RegExp(
    `^  (?:private )?(?:readonly )?(?:get )?${name}(?:\\(| =)[^]*?^  };?`,
    "m",
  ).exec(source);
  assert.ok(match, name);
  return match[0];
}
const declarations = ["COMBO_SCALE", "COMBO_WINDOW_S", "CAPTURE_ECHO_S"].map((name) => {
  const match = new RegExp(`^const ${name}[^]*?;`, "m").exec(source);
  assert.ok(match, name);
  return match[0];
});
const methods = [
  "racing",
  "onBanner",
  "onCircuitEnter",
  "onCircuitRetry",
  "onCircuitNormal",
  "replaceSession",
  "refreshCircuit",
  "recordCircuitPearl",
  "collectPellet",
  "removeCellVisual",
  "parseCellKey",
  "pelletsLeft",
  "caught",
  "resetBoard",
  "resetGame",
  "resetRoundActors",
  "resetPacman",
  "resetSessionPresentation",
  "beginReady",
  "setPhase",
  "addScore",
  "handleStart",
  "update",
];

function fresh() {
  const events = { sessions: [], sounds: [], writes: [], normalBest: [], confetti: [] };
  const classes = new Set();
  let storageBlocked = false;
  class Net {
    constructor(options = {}) {
      this.options = options;
      this.offline = options.forceOffline === true;
      this.isHost = this.offline;
      this.closed = 0;
      this.rival = null;
      events.sessions.push(this);
    }
    tick() {}
    otherPlayer() {
      return this.rival;
    }
    destroy() {
      this.closed++;
    }
  }
  const deps = {
    ...constants,
    ...circuit,
    THREE,
    NetSession: Net,
    REDUCED_MOTION: { matches: true },
    document: {
      body: { classList: { add: (v) => classes.add(v), remove: (v) => classes.delete(v) } },
    },
    localStorage: {
      setItem(key, value) {
        if (storageBlocked) throw new Error("storage unavailable");
        events.writes.push({ key, value });
      },
    },
    sfx: { play: (name) => events.sounds.push(name) },
    music: { duck() {}, setPowerMode() {}, setMix() {}, update() {} },
    resetAudio() {},
    notifyGameStarted() {},
    retrigger() {},
    watchControlContext: () => () => {},
    saveBest: (value) => events.normalBest.push(value),
    hash2: () => 0, // Only the unchanged decorative pearl/heart bob phase.
  };
  const Subject = new Function(
    "deps",
    `${stripTypeScriptTypes(
      `const {${Object.keys(deps).join(",")}}=deps;
      ${declarations.join("\n")}
      class Subject {${methods.map(method).join("\n")}}`,
      { mode: "strip" },
    )};return Subject;`,
  )(deps);
  const subject = new Subject();
  const scene = new THREE.Scene();
  const capacity = constants.MAP.flat().filter((v) => v === 2).length;
  Object.assign(subject, {
    scene,
    disposed: false,
    presentationPaused: false,
    phase: "title",
    mode: { kind: "normal" },
    net: new Net(),
    pendingClaims: new Set(),
    hostEaten: new Set(),
    appliedEaten: new Set(),
    boardRound: 4,
    boardSig: "old",
    lastBoardRef: {},
    lastBoardAsHost: true,
    netInfoText: "old",
    netAcc: 1,
    t: 0,
    score: 0,
    best: 42,
    circuitBest: null,
    circuitMarkers: new CircuitMarkers(scene),
    circuitHudEl: { hidden: true, textContent: "" },
    boardEl: { replaceChildren() {} },
    netInfoEl: { textContent: "old" },
    remotePacs: { sync() {} },
    pelletField: new PelletField(scene, capacity),
    hearts: new Map(),
    heartGeo: new THREE.SphereGeometry(0.2),
    powerMat: new THREE.MeshBasicMaterial(),
    pac: { x: 1, z: 1, dir: "right", isMoving: false, target: { x: 1, z: 1 } },
    captureEcho: new THREE.Group(),
    ghosts: [],
    fx: {
      puff() {},
      heartBurst() {},
      ring() {},
      update() {},
      confettiRain: (count) => events.confetti.push(count),
    },
    shaker: { add() {} },
    powerHalo: { update() {} },
    prevScared: false,
    updateHud() {},
    updateChainHud() {},
    renderBanner() {},
    broadcastBoard() {},
    hostNewRound() {},
    markEaten() {},
    reconcileBoard() {},
    pollPad() {},
    takeStep() {},
    movePacman: () => false,
    moveGhosts() {},
    checkGhostContact() {},
    updateSessionPresentation() {},
    renderActors() {},
    updateCamera() {},
    updateNet() {},
    softFlash() {},
  });
  subject.resetBoard();
  return {
    subject,
    events,
    classes,
    blockStorage() {
      storageBlocked = true;
    },
    close() {
      subject.circuitMarkers.dispose();
      const geometry = new Set([subject.heartGeo]);
      const material = new Set([subject.powerMat]);
      scene.traverse((node) => {
        if (!(node instanceof THREE.Mesh)) return;
        geometry.add(node.geometry);
        for (const m of Array.isArray(node.material) ? node.material : [node.material])
          material.add(m);
        if (node instanceof THREE.InstancedMesh) node.dispose();
      });
      for (const g of geometry) g.dispose();
      for (const m of material) m.dispose();
      scene.clear();
    },
  };
}

function pickup(subject, col, row) {
  subject.pac.x = col;
  subject.pac.z = row;
  subject.collectPellet();
}

test("actual mode actions retire sessions only on entry/exit; retries reset the same offline circuit", () => {
  const f = fresh();
  try {
    const g = f.subject;
    const old = g.net;
    g.score = 999;
    g.pendingClaims.add("3,1");
    g.onCircuitEnter();
    assert.equal(old.closed, 1);
    assert.equal(g.net.options.forceOffline, true);
    assert.equal(g.score, 0);
    assert.equal(g.pendingClaims.size, 0);
    assert.equal(g.phase, "ready");
    assert.equal(g.readyMs, constants.READY_MS);
    assert.equal(g.circuitMarkers.count, circuit.CIRCUIT_GOAL);
    assert.ok(f.classes.has("circuit-mode"));
    const offline = g.net;
    for (let retry = 0; retry < 3; retry++) {
      g.phase = "playing";
      pickup(g, 9, 1);
      g.setPhase("gameover");
      g.onCircuitRetry();
      assert.equal(g.net, offline);
      assert.equal(g.score, 0);
      assert.equal(circuit.circuitCollected(g.mode.run), 0);
      assert.equal(g.circuitMarkers.count, circuit.CIRCUIT_GOAL);
    }
    g.setPhase("gameover");
    g.onCircuitNormal();
    assert.equal(offline.closed, 1);
    assert.equal(g.net.options.forceOffline, false);
    assert.deepEqual(g.mode, { kind: "normal" });
    assert.equal(g.score, 0);
    assert.equal(g.best, 42);
    assert.equal(g.circuitMarkers.count, 0);
    assert.equal(f.classes.has("circuit-mode"), false);
    assert.equal(f.events.sessions.length, 3);
  } finally {
    f.close();
  }
});

test("actual successful local pearl pickup advances; power, revisits and remote removal cannot", () => {
  const f = fresh();
  try {
    const g = f.subject;
    g.onCircuitEnter();
    g.phase = "playing";
    pickup(g, 9, 1);
    assert.equal(circuit.circuitCollected(g.mode.run), 1);
    assert.equal(g.circuitMarkers.count, circuit.CIRCUIT_GOAL - 1);
    assert.equal(g.score, constants.SCORE_PELLET);
    pickup(g, 9, 1);
    pickup(g, 1, 2);
    pickup(g, 2, 1);
    assert.equal(circuit.circuitCollected(g.mode.run), 1);
    assert.equal(g.score, constants.SCORE_PELLET * 2 + constants.SCORE_POWER);
    assert.equal(g.scaredMs, constants.SCARED_MS);
    g.removeCellVisual("10,1");
    pickup(g, 10, 1);
    assert.equal(circuit.circuitCollected(g.mode.run), 1);
    assert.deepEqual(f.events.normalBest, []);
    assert.deepEqual(f.events.writes, []);
  } finally {
    f.close();
  }
});

test("twenty-eight actual pickups resolve once and persist only completed circuit receipts", () => {
  const f = fresh();
  try {
    const g = f.subject;
    g.onCircuitEnter();
    g.phase = "playing";
    for (const cell of circuit.CIRCUIT_CELLS) {
      g.update(0.1);
      pickup(g, cell.col, cell.row);
    }
    assert.equal(g.phase, "win");
    assert.deepEqual(g.mode.run, {
      kind: "complete",
      receipt: { elapsedMs: 2800, catches: 0 },
    });
    assert.ok(g.pelletsLeft() > 0, "only the explicit circuit ends before the full maze");
    assert.equal(g.score, constants.SCORE_PELLET * circuit.CIRCUIT_GOAL);
    assert.equal(g.best, 42);
    assert.equal(g.circuitMarkers.count, 0);
    assert.equal(f.events.sounds.filter((name) => name === "win").length, 1);
    assert.deepEqual(f.events.writes, [
      { key: circuit.CIRCUIT_BEST_KEY, value: '{"elapsedMs":2800,"catches":0}' },
    ]);
    pickup(g, 9, 2);
    g.recordCircuitPearl(9, 2);
    g.update(10);
    assert.equal(f.events.writes.length, 1);
    assert.equal(f.events.sounds.filter((name) => name === "win").length, 1);
    assert.deepEqual(f.events.normalBest, []);
    g.onCircuitRetry();
    g.phase = "playing";
    f.blockStorage();
    for (const cell of circuit.CIRCUIT_CELLS) pickup(g, cell.col, cell.row);
    assert.equal(g.phase, "win", "unavailable persistence cannot prevent completion");
  } finally {
    f.close();
  }
});

test("actual READY, pause, catches and result branches own circuit time without altering original lives", () => {
  const f = fresh();
  try {
    const g = f.subject;
    g.onCircuitEnter();
    g.update(0.899);
    assert.equal(g.phase, "ready");
    assert.equal(g.mode.run.elapsedMs, 0);
    g.update(0.001);
    assert.equal(g.phase, "playing");
    assert.equal(g.mode.run.elapsedMs, 0);
    g.update(0.1);
    pickup(g, 9, 1);
    g.presentationPaused = true;
    const before = g.mode;
    g.update(10);
    g.onCircuitEnter();
    g.onCircuitNormal();
    assert.equal(g.mode, before);
    assert.equal(g.mode.run.elapsedMs, 100);
    g.presentationPaused = false;
    g.caught();
    assert.equal(g.lives, constants.START_LIVES - 1);
    assert.equal(g.graceMs, constants.SPAWN_GRACE_MS);
    assert.equal(g.readyMs, constants.READY_MS);
    assert.equal(g.mode.run.catches, 1);
    assert.equal(circuit.circuitCollected(g.mode.run), 1);
    g.update(0.9);
    assert.equal(g.mode.run.elapsedMs, 100);
    g.update(0.1);
    assert.equal(g.mode.run.elapsedMs, 200);
    g.caught();
    g.caught();
    assert.equal(g.lives, 0);
    assert.equal(g.phase, "gameover");
    assert.equal(g.mode.run.catches, constants.START_LIVES);
    g.update(10);
    assert.equal(g.mode.run.elapsedMs, 200);
    assert.equal(f.events.writes.length, 0, "unfinished attempt is not a best");
    g.onCircuitRetry();
    assert.deepEqual(g.mode.run, circuit.startCircuit());
  } finally {
    f.close();
  }
});

test("ordinary target pickups retain full-maze completion and ordinary best-score writes", () => {
  const f = fresh();
  try {
    const g = f.subject;
    g.resetGame();
    g.phase = "playing";
    g.onCircuitEnter();
    assert.equal(g.mode.kind, "normal", "playing input cannot silently change mode");
    for (const cell of circuit.CIRCUIT_CELLS) pickup(g, cell.col, cell.row);
    assert.equal(g.phase, "playing");
    assert.equal(g.circuitMarkers.count, 0);
    assert.equal(g.score, constants.SCORE_PELLET * circuit.CIRCUIT_GOAL);
    assert.equal(g.best, g.score);
    assert.equal(f.events.normalBest.at(-1), g.score);
    assert.deepEqual(f.events.writes, []);
    g.setPhase("gameover");
    g.net.rival = { id: "peer" };
    g.onCircuitEnter();
    assert.equal(g.mode.kind, "normal", "live race result does not offer circuit replacement");
    g.net.rival = null;
    g.disposed = true;
    g.onCircuitEnter();
    assert.equal(g.mode.kind, "normal");
  } finally {
    f.close();
  }
});
