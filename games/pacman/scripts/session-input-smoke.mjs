import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import test from "node:test";
import * as THREE from "three";
import { PhysicalGamepad } from "../../../packages/gamepad/src/physical.ts";
import { stickDirection4 } from "../../../packages/gamepad/src/core.ts";
import * as constants from "../src/shared/constants.ts";
import { PelletField } from "../src/render/pellet-field.ts";

const source = readFileSync(new URL("../src/scenes/game-scene.ts", import.meta.url), "utf8");
const main = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
const adapter = readFileSync(new URL("../src/net/session.ts", import.meta.url), "utf8");

// Compile the shipping methods, with collaborators injected at their existing
// boundaries. Do not copy their implementation into the test oracle.
function member(text, name) {
  const lines = text.split("\n");
  const first = lines.findIndex((line) =>
    new RegExp(`^  (?:(?:private|public|protected|readonly|async) )*(?:get )?${name}\\b`).test(
      line,
    ),
  );
  assert.ok(first >= 0, `source member ${name}`);
  if (lines[first].endsWith(";")) return lines[first];
  const last = lines.findIndex((line, index) => index > first && /^  };?$/.test(line));
  assert.ok(last > first, `member boundary ${name}`);
  return lines.slice(first, last + 1).join("\n");
}

const methods = [
  "racing",
  "handleNetEvent",
  "parseCellKey",
  "parseEatKey",
  "hostArbitrate",
  "broadcastBoard",
  "markEaten",
  "applyNewRound",
  "hostNewRound",
  "handleStart",
  "resetGame",
  "resetPacman",
  "resetRoundActors",
  "beginReady",
  "setPhase",
  "bindInput",
  "dispose",
  "setPresentationPaused",
  "onKeyDown",
  "onKeyUp",
  "onBlur",
  "onPointerDown",
  "onPointerMove",
  "onPointerUp",
  "onBanner",
  "chomp",
  "pollPad",
  "steer",
  "onMouthChange",
  "onHeadTurnLeft",
  "onHeadTurnRight",
  "takeStep",
  "movePacman",
  "requestRestart",
  "toggleSelfie",
  "onSelfieClick",
  "onRestartClick",
];

class Surface extends EventTarget {
  hidden = false;
  listeners = new Map();
  style = {};
  classList = { toggle() {} };
  addEventListener(type, listener, options) {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
    super.addEventListener(type, listener, options);
  }
  removeEventListener(type, listener, options) {
    this.listeners.get(type)?.delete(listener);
    super.removeEventListener(type, listener, options);
  }
  setAttribute() {}
  closest() {
    return null;
  }
  get listenerCount() {
    return [...this.listeners.values()].reduce((sum, listeners) => sum + listeners.size, 0);
  }
}

function harness(text = source, selected = methods) {
  const events = [],
    sounds = [],
    notices = [],
    patches = [],
    releases = [],
    writes = [];
  const window = new Surface();
  const json = adapter.match(/export const isJsonObject[\s\S]*?export type NetSessionOptions/)?.[0];
  assert.ok(json);
  const guards = stripTypeScriptTypes(
    json.replaceAll("export ", "").replace("type NetSessionOptions", ""),
  );
  const deps = {
    ...constants,
    THREE,
    window,
    Element: Surface,
    PhysicalGamepad,
    stickDirection4,
    SWIPE_MIN_PX: 24,
    EPS: 1e-4,
    REDUCED_MOTION: { matches: false },
    sfx: { play: (...args) => sounds.push(args) },
    notifyGameStarted: () => notices.push("started"),
    watchControlContext: () => () => releases.push("watcher"),
    retrigger() {},
    clearTimeout: (id) => releases.push(["timer", id]),
    localStorage: { setItem: (key, value) => writes.push([key, value]) },
  };
  const helpers = ["hash2", "saveBest"].map((name) => {
    const found = text.match(new RegExp(`^function ${name}\\([^]*?^}`, "m"))?.[0];
    assert.ok(found, `actual ${name}`);
    return found;
  });
  const combo = ["COMBO_SCALE", "COMBO_WINDOW_S"].map((name) => {
    const found = text.match(new RegExp(`^const ${name}[^]*?;`, "m"))?.[0];
    assert.ok(found, `actual ${name}`);
    return found;
  });
  const code = stripTypeScriptTypes(
    `${helpers.join("\n")}\n${combo.join("\n")}\nclass Subject {\n${selected.map((name) => member(text, name)).join("\n")}\n}`,
  );
  const Subject = new Function(...Object.keys(deps), `${guards}\n${code}\nreturn Subject;`)(
    ...Object.values(deps),
  );
  const game = new Subject();
  const input = { buttons: new Set(), axes: [0, 0] };
  const pad = new PhysicalGamepad({
    poll: () => [
      {
        connected: true,
        axes: input.axes,
        buttons: Array.from({ length: 16 }, (_, index) => ({
          pressed: input.buttons.has(index),
          touched: input.buttons.has(index),
          value: input.buttons.has(index) ? 1 : 0,
        })),
      },
    ],
  });
  const net = {
    isHost: false,
    playerId: "guest",
    hostId: "host",
    offline: false,
    peer: { id: "host" },
    otherPlayer() {
      return this.peer;
    },
    sendEvent: (...args) => events.push(args),
    patchShared: (patch) => patches.push(patch),
    destroy: () => releases.push("net"),
  };
  Object.assign(game, {
    disposed: false,
    presentationPaused: false,
    phase: "playing",
    pac: {
      x: constants.PACMAN_SPAWN.col,
      z: constants.PACMAN_SPAWN.row,
      dir: "right",
      isMoving: false,
      target: { x: constants.PACMAN_SPAWN.col, z: constants.PACMAN_SPAWN.row },
    },
    boardRound: 7,
    pendingClaims: new Set(),
    appliedEaten: new Set(),
    hostEaten: new Set(),
    heldKeys: new Set(),
    blockedKeys: new Set(),
    score: 1000,
    ghosts: [],
    stepRequested: false,
    prevMouthOpen: false,
    shiftHeld: false,
    selfieOn: false,
    swipeOrigin: null,
    swiped: false,
    padStickDir: null,
    t: 1,
    lastTurnTickAt: -Infinity,
    squashKick: 0,
    readyMs: 0,
    lives: constants.START_LIVES,
    scaredMs: 0,
    net,
    pad,
    resetBoard: () => notices.push("board"),
    resetSessionPresentation: () => notices.push("presentation"),
    updateHud() {},
    updateChainHud() {},
    renderBanner() {},
    addScore(amount) {
      this.score += amount;
    },
    toggleSound: () => notices.push("sound-toggle"),
    fx: { puff() {}, confettiRain: (count) => notices.push(["confetti", count]) },
  });
  // Tests can opt into these shipping methods instead of the lightweight defaults.
  for (const name of ["resetBoard", "addScore", "updateChainHud"])
    if (selected.includes(name)) delete game[name];
  for (const key of ["selfieBtnEl", "restartBtnEl", "bannerEl", "resultEl", "teachingEl"])
    game[key] = new Surface();
  return { game, events, sounds, notices, patches, releases, window, input, writes };
}

const keyEvent = (code, key = code, repeat = false) => ({ code, key, repeat, preventDefault() {} });
const cellOfType = (type) => {
  for (let row = 0; row < constants.MAP.length; row++) {
    const col = constants.MAP[row].indexOf(type);
    if (col >= 0) return { col, row, key: constants.cellKey(col, row) };
  }
  assert.fail(`map contains ${type}`);
};

function boardHarness() {
  const f = harness(source, [
    ...methods,
    "resetBoard",
    "addScore",
    "collectPellet",
    "pelletsLeft",
    "checkRaceWin",
    "sharedBoard",
    "reconcileBoard",
    "removeCellVisual",
    "updateChainHud",
  ]);
  const { game } = f;
  const scene = new THREE.Scene();
  const heartGeo = new THREE.SphereGeometry(0.1, 4, 4);
  const powerMat = new THREE.MeshBasicMaterial();
  Object.assign(game, {
    scene,
    heartGeo,
    powerMat,
    hearts: new Map(),
    pelletField: new PelletField(scene, constants.GRID_COLS * constants.GRID_ROWS),
    best: 0,
    score: 0,
    comboIdx: 0,
    lastPelletAt: -Infinity,
    chainText: "",
    chainEl: new Surface(),
    fx: { ...game.fx, heartBurst() {}, ring() {} },
    shaker: { add() {} },
  });
  game.resetBoard();
  const cells = [];
  constants.MAP.forEach((row, r) =>
    row.forEach((type, col) => {
      if (type === 2 || type === 3) cells.push({ col, row: r, type });
    }),
  );
  const collect = (cell) => {
    game.pac.x = cell.col;
    game.pac.z = cell.row;
    game.t += 0.1;
    game.collectPellet();
  };
  const close = () => {
    const geometries = new Set([heartGeo]);
    const materials = new Set([powerMat]);
    scene.traverse((object) => {
      if (!(object instanceof THREE.Mesh)) return;
      geometries.add(object.geometry);
      for (const material of Array.isArray(object.material) ? object.material : [object.material])
        materials.add(material);
    });
    for (const geometry of geometries) geometry.dispose();
    for (const material of materials) material.dispose();
    scene.clear();
  };
  return { ...f, cells, collect, close };
}

test("normal maze requires every pearl and power heart; actual pickups preserve chain, score and ordinary best", () => {
  const f = boardHarness();
  const { game, cells, collect, sounds, notices, writes } = f;
  game.net.offline = true;
  game.net.isHost = true;
  game.net.peer = null;
  const pearls = cells.filter((cell) => cell.type === 2);
  const hearts = cells.filter((cell) => cell.type === 3);
  try {
    assert.ok(pearls.length > 28 && hearts.length > 0);
    for (const [index, cell] of pearls.entries()) {
      collect(cell);
      const score = game.score;
      const cues = sounds.length;
      game.collectPellet();
      assert.equal(game.score, score, "same arrival cannot score twice");
      assert.equal(sounds.length, cues);
      assert.equal(game.phase, "playing", `no early completion after pearl ${index + 1}`);
    }
    game.updateChainHud();
    assert.equal(game.chainEl.textContent, `♪ ${pearls.length} PEARL CHAIN`);
    assert.deepEqual(
      sounds
        .filter(([cue]) => cue === "pellet")
        .slice(0, 3)
        .map(([, opts]) => opts.rate),
      [1, Math.pow(2, 2 / 12), Math.pow(2, 4 / 12)],
    );
    assert.equal(game.pelletsLeft(), hearts.length, "power hearts also belong to the full maze");
    for (const [index, cell] of hearts.entries()) {
      collect(cell);
      assert.equal(game.scaredMs, constants.SCARED_MS);
      assert.equal(game.phase, index === hearts.length - 1 ? "win" : "playing");
    }
    assert.equal(game.pelletsLeft(), 0);
    const expected = pearls.length * constants.SCORE_PELLET + hearts.length * constants.SCORE_POWER;
    assert.equal(game.score, expected);
    assert.equal(game.best, expected);
    assert.equal(writes.at(-1)[1], String(expected));
    assert.ok(writes.every(([key]) => key === constants.BEST_KEY));
    assert.equal(sounds.filter(([cue]) => cue === "win").length, 1);
    assert.equal(
      notices.filter((value) => Array.isArray(value) && value[0] === "confetti").length,
      1,
    );
    game.collectPellet();
    assert.equal(sounds.filter(([cue]) => cue === "win").length, 1);
    game.requestRestart();
    assert.equal(game.phase, "ready");
    assert.equal(game.readyMs, constants.READY_MS);
    assert.equal(game.score, 0);
    assert.equal(game.lives, constants.START_LIVES);
    assert.equal(game.pelletsLeft(), cells.length);
    assert.equal(game.best, expected);
  } finally {
    f.close();
  }
});

test("authoritative shared full-maze clear awards no rival score and guest waits for the host", () => {
  const f = boardHarness();
  const { game, cells, sounds } = f;
  const eaten = Object.fromEntries(
    cells.slice(0, -1).map((cell) => [constants.cellKey(cell.col, cell.row), 1]),
  );
  try {
    game.net.sharedState = { board: { round: game.boardRound, eaten } };
    game.reconcileBoard();
    assert.equal(game.pelletsLeft(), 1);
    assert.equal(game.phase, "playing");
    assert.equal(game.score, 0);
    const last = cells.at(-1);
    game.net.sharedState = {
      board: {
        round: game.boardRound,
        eaten: { ...eaten, [constants.cellKey(last.col, last.row)]: 1 },
      },
    };
    game.reconcileBoard();
    game.reconcileBoard();
    assert.equal(game.pelletsLeft(), 0);
    assert.equal(game.phase, "win");
    assert.equal(game.score, 0);
    assert.equal(sounds.filter(([cue]) => cue === "win").length, 1);
    game.handleStart();
    assert.equal(game.phase, "win", "guest cannot locally reset the shared maze");
    game.net.isHost = true;
    game.net.playerId = "host";
    game.handleStart();
    assert.equal(game.phase, "playing");
    assert.equal(game.boardRound, 8);
    assert.equal(game.pelletsLeft(), cells.length);
  } finally {
    f.close();
  }
});

test("only the current host rejects a pending round claim, once, at the map's value", () => {
  for (const [type, amount] of [
    [2, constants.SCORE_PELLET],
    [3, constants.SCORE_POWER],
  ]) {
    const { game, events } = harness();
    const cell = cellOfType(type);
    game.markEaten(cell.col, cell.row);
    game.markEaten(cell.col, cell.row);
    assert.deepEqual(events, [["eat", { key: cell.key, round: 7 }]]);
    const payload = { to: "guest", key: cell.key, round: 7, amount: 1000000 };
    const before = game.score;
    for (const [from, patch] of [
      ["rival", {}],
      ["host", { to: "rival" }],
      ["host", { round: 6 }],
      ["host", { round: 8 }],
      ["host", { key: cellOfType(1).key }],
      ["host", { key: "-1,0" }],
      ["host", { key: "1.5,1" }],
      ["host", { key: 4 }],
    ]) {
      game.handleNetEvent("reject", { ...payload, ...patch }, from);
      assert.equal(game.score, before);
      assert.ok(game.pendingClaims.has(cell.key));
    }
    game.handleNetEvent("reject", payload, "host");
    assert.equal(game.score, before - amount);
    assert.equal(game.pendingClaims.size, 0);
    game.handleNetEvent("reject", payload, "host");
    assert.equal(game.score, before - amount);
    const unsolicited = cellOfType(type === 2 ? 3 : 2);
    game.handleNetEvent("reject", { ...payload, key: unsolicited.key }, "host");
    assert.equal(game.score, before - amount);
  }
});

test("host arbitration rejects with its round; stale claims cannot mutate the board", () => {
  const { game, events, patches } = harness();
  game.net.isHost = true;
  game.net.playerId = "host";
  const cell = cellOfType(3);
  game.handleNetEvent("eat", { key: cell.key, round: 6 }, "guest");
  assert.equal(game.hostEaten.size, 0);
  game.handleNetEvent("eat", { key: cell.key, round: 7 }, "guest");
  assert.deepEqual(patches, [{ board: { round: 7, eaten: { [cell.key]: 1 } } }]);
  game.handleNetEvent("eat", { key: cell.key, round: 7 }, "rival");
  assert.deepEqual(events, [
    ["reject", { key: cell.key, amount: constants.SCORE_POWER, to: "rival", round: 7 }],
  ]);
});

test("every board reset retires pending claims; old rejection cannot tax a fresh run", () => {
  for (const reset of [
    (game) => game.applyNewRound(8),
    (game) => game.resetGame(),
    (game) => game.hostNewRound(),
  ]) {
    const { game } = harness();
    const cell = cellOfType(2);
    game.markEaten(cell.col, cell.row);
    reset(game);
    assert.equal(game.pendingClaims.size, 0);
    const score = game.score;
    game.handleNetEvent("reject", { key: cell.key, round: game.boardRound, to: "guest" }, "host");
    assert.equal(game.score, score);
  }
});

test("fresh shared rounds retire power, lives, chain, motion and ghost poses", () => {
  for (const phase of ["title", "ready", "playing", "win", "gameover"]) {
    const { game } = harness();
    Object.assign(game, {
      phase,
      scaredMs: 6000,
      lives: 1,
      comboIdx: 3,
      lastPelletAt: 99,
      squashKick: 0.8,
      stepRequested: true,
    });
    game.pac.isMoving = true;
    game.ghosts = constants.GHOST_SPAWNS.map(() => ({
      x: -99,
      z: -99,
      dir: "left",
      spawnScale: 0.2,
    }));
    game.applyNewRound(8);
    assert.equal(game.scaredMs, 0);
    assert.equal(game.lives, constants.START_LIVES);
    assert.equal(game.comboIdx, 0);
    assert.equal(game.lastPelletAt, -Infinity);
    assert.equal(game.squashKick, 0);
    assert.equal(game.stepRequested, false);
    assert.equal(game.pac.isMoving, false);
    assert.equal(game.graceMs, constants.SPAWN_GRACE_MS);
    assert.equal(game.phase, ["ready", "playing", "win"].includes(phase) ? "playing" : phase);
    assert.deepEqual(
      game.ghosts,
      constants.GHOST_SPAWNS.map((spawn) => ({
        x: spawn.col,
        z: spawn.row,
        dir: spawn.dir,
        spawnScale: 1,
      })),
    );
  }
  const { game } = harness();
  game.net.offline = true;
  game.hostEaten.add("1,1");
  game.appliedEaten.add("1,1");
  game.resetGame();
  assert.equal(game.hostEaten.size + game.appliedEaten.size, 0);
});

test("live race start arms the wrapper; repeated terminal phase does not replay effects", () => {
  const { game, notices, sounds } = harness();
  game.phase = "title";
  game.handleStart();
  assert.equal(game.phase, "playing");
  assert.deepEqual(notices, ["started"]);
  assert.equal(game.graceMs, constants.SPAWN_GRACE_MS);
  game.setPhase("win");
  game.setPhase("win");
  game.handleStart(); // guest must keep waiting for the host
  assert.equal(game.phase, "win");
  assert.equal(sounds.filter(([cue]) => cue === "win").length, 1);
  assert.equal(
    notices.filter((value) => Array.isArray(value) && value[0] === "confetti").length,
    1,
  );
});

test("paused keyboard, face, chomp, restart, pointer and real pad cannot act", () => {
  for (const phase of ["title", "ready", "playing", "win", "gameover"]) {
    const { game, input, notices, sounds } = harness();
    game.phase = phase;
    game.stepRequested = true;
    game.setPresentationPaused(true);
    const before = structuredClone(game.pac);
    for (const code of ["ArrowLeft", "ArrowRight", "ArrowDown", "Space", "KeyR", "KeyM"])
      game.onKeyDown(keyEvent(code));
    game.onKeyDown(keyEvent("ShiftLeft", "Shift"));
    game.onHeadTurnLeft();
    game.onHeadTurnRight();
    game.onMouthChange(true);
    game.chomp();
    game.requestRestart();
    game.toggleSelfie();
    game.onPointerDown({ clientX: 0, clientY: 0 });
    game.onPointerMove({ clientX: 50, clientY: 0 });
    game.onPointerUp();
    input.buttons = new Set([0, 9, 13, 14, 15]);
    input.axes = [0, -1];
    game.pollPad();
    assert.equal(game.phase, phase);
    assert.deepEqual(game.pac, before);
    assert.equal(game.stepRequested, false);
    assert.equal(game.shiftHeld, false);
    assert.equal(game.selfieOn, false);
    assert.deepEqual(notices, []);
    assert.deepEqual(sounds, []);
  }
});

test("pause consumes held pad/keyboard edges; fresh input still works, Tab never starts", () => {
  const { game, input } = harness();
  game.onKeyDown(keyEvent("ArrowLeft"));
  const direction = game.pac.dir;
  game.setPresentationPaused(true);
  input.buttons = new Set([0, 9]);
  input.axes = [1, 0];
  game.setPresentationPaused(false);
  game.pollPad();
  game.onKeyDown(keyEvent("ArrowLeft", "ArrowLeft", true));
  assert.equal(game.pac.dir, direction);
  assert.equal(game.stepRequested, false);
  input.buttons.clear();
  input.axes = [0, 0];
  game.pollPad();
  game.onKeyUp(keyEvent("ArrowLeft"));
  game.onKeyDown(keyEvent("ArrowLeft"));
  assert.equal(game.pac.dir, constants.TURN_LEFT[direction]);
  input.buttons.add(0);
  game.pollPad();
  assert.equal(game.stepRequested, true);
  game.phase = "title";
  for (const key of ["Tab", "Control", "Alt", "Meta", "Escape"]) game.onKeyDown(keyEvent(key, key));
  assert.equal(game.phase, "title");
});

test("raw held mouth is consumed during pause and needs a new close-open edge", () => {
  const { game } = harness();
  game.setPresentationPaused(true);
  game.onMouthChange(true);
  game.setPresentationPaused(false);
  game.onMouthChange(true);
  assert.equal(game.stepRequested, false);
  game.onMouthChange(false);
  game.onMouthChange(true);
  assert.equal(game.stepRequested, true);
});

const traceMethods = [
  "onBanner",
  "onKeyDown",
  "onKeyUp",
  "chomp",
  "steer",
  "onMouthChange",
  "onHeadTurnLeft",
  "onHeadTurnRight",
  "takeStep",
  "movePacman",
  "requestRestart",
  "handleStart",
  "racing",
];
function controlTrace(text) {
  const trace = [];
  const { game, sounds } = harness(text, traceMethods);
  for (const phase of ["ready", "playing"]) {
    for (let row = 0; row < constants.GRID_ROWS; row++) {
      for (let col = 0; col < constants.GRID_COLS; col++) {
        if (!constants.isOpen(col, row)) continue;
        for (const dir of constants.DIRS) {
          sounds.length = 0;
          Object.assign(game, {
            stepRequested: false,
            prevMouthOpen: false,
            shiftHeld: false,
            lastTurnTickAt: -Infinity,
            squashKick: 0,
          });
          game.phase = phase;
          game.pac = { x: col, z: row, dir, isMoving: false, target: { x: col, z: row } };
          const observe = () =>
            trace.push([
              phase,
              structuredClone(game.pac),
              game.stepRequested,
              game.prevMouthOpen,
              game.shiftHeld,
              structuredClone(sounds),
            ]);
          game.onHeadTurnLeft();
          game.onHeadTurnRight();
          game.onKeyDown(keyEvent("ArrowLeft"));
          game.onKeyDown(keyEvent("ArrowDown"));
          game.onKeyDown(keyEvent("ArrowRight"));
          game.onKeyDown(keyEvent("ArrowUp"));
          game.onMouthChange(false);
          game.onMouthChange(true);
          observe();
          game.takeStep();
          for (const dt of [0, 1 / 120, 1 / 30, 0.04, 0.3]) {
            game.movePacman(dt);
            observe();
          }
          game.stepRequested = false;
          game.onMouthChange(true);
          observe(); // held mouth does not request twice
          game.onMouthChange(false);
          game.onMouthChange(true);
          observe();
          game.onKeyDown(keyEvent("Space", " "));
          game.onKeyDown(keyEvent("ShiftLeft", "Shift"));
          observe();
          game.onKeyUp(keyEvent("ShiftLeft", "Shift"));
          observe();
        }
      }
    }
  }
  return trace;
}

test("normal accepted face, relative steering and movement keep the pre-completion trace", () => {
  const trace = controlTrace(source);
  if (process.env.PACMAN_SESSION_BASELINE) {
    const baseline = readFileSync(process.env.PACMAN_SESSION_BASELINE, "utf8");
    assert.deepEqual(trace, controlTrace(baseline));
  }
  const digest = createHash("sha256").update(JSON.stringify(trace)).digest("hex");
  // Recorded only after full equality against the immutable pre-completion
  // source; permanent CI needs no temporary baseline checkout.
  assert.equal(digest, "16848e5330d1839705d029789a63bab04cc61ab3457d19de7f19f311a749c67c");
});

test("scene disposal releases each unique Three owner and external listener once", () => {
  const { game, window, releases } = harness();
  game.scene = new THREE.Scene();
  const geometry = new THREE.BoxGeometry(),
    initial = new THREE.SphereGeometry(),
    heart = new THREE.BufferGeometry();
  const texture = new THREE.Texture();
  const material = new THREE.MeshBasicMaterial({ map: texture });
  const pointsMaterial = new THREE.PointsMaterial({ map: texture });
  const counters = new Map();
  for (const resource of [geometry, initial, heart, texture, material, pointsMaterial]) {
    counters.set(resource, 0);
    resource.addEventListener("dispose", () => counters.set(resource, counters.get(resource) + 1));
  }
  game.scene.add(
    new THREE.Mesh(geometry, [material, material]),
    new THREE.Mesh(geometry, material),
    new THREE.Points(geometry, pointsMaterial),
  );
  const instanced = new THREE.InstancedMesh(geometry, material, 2);
  let instanceDisposes = 0;
  instanced.addEventListener("dispose", () => instanceDisposes++);
  game.scene.add(instanced);
  const light = new THREE.DirectionalLight();
  let shadowDisposes = 0;
  light.shadow.dispose = () => shadowDisposes++;
  game.scene.add(light);
  Object.assign(game, {
    initialMouthGeometry: initial,
    heartGeo: heart,
    mouthGeoCache: new Map([
      [0, geometry],
      [1, geometry],
    ]),
    powerMat: material,
    touchControls: { destroy: () => releases.push("touch") },
    remotePacs: { dispose: () => releases.push("remote") },
    unwatchControls: () => releases.push("watcher"),
    noticeTimer: 42,
  });
  game.pendingClaims.add("1,1");
  game.heldKeys.add("Space");
  game.blockedKeys.add("Space");
  game.bindInput();
  const buttons = [game.selfieBtnEl, game.restartBtnEl];
  assert.equal(window.listenerCount, 6);
  assert.equal(
    buttons.reduce((count, button) => count + button.listenerCount, 0),
    2,
  );
  game.dispose();
  game.dispose();
  assert.equal(window.listenerCount, 0);
  assert.equal(
    buttons.reduce((count, button) => count + button.listenerCount, 0),
    0,
  );
  assert.deepEqual([...counters.values()], [1, 1, 1, 1, 1, 1]);
  assert.equal(instanceDisposes, 1);
  assert.equal(shadowDisposes, 1);
  assert.deepEqual(releases, ["watcher", "touch", ["timer", 42], "net", "remote"]);
  assert.equal(game.scene.children.length, 0);
  assert.equal(
    game.mouthGeoCache.size + game.pendingClaims.size + game.heldKeys.size + game.blockedKeys.size,
    0,
  );
  for (const key of ["bannerEl", "resultEl", "teachingEl"]) assert.equal(game[key].hidden, true);
  const direction = game.pac.dir;
  game.onKeyDown(keyEvent("ArrowLeft"));
  game.onHeadTurnLeft();
  game.chomp();
  game.handleStart();
  assert.equal(game.pac.dir, direction);
  assert.equal(game.stepRequested, false);
});

test("the actual final app owner stops its loop before releasing camera, scene and renderer", () => {
  const text = main.match(/^function dispose\(\): void \{[\s\S]*?^}/m)?.[0];
  assert.ok(text);
  const calls = [],
    window = new Surface(),
    webcamToggle = new Surface(),
    webcamPanel = new Surface();
  const unlockAudio = () => calls.push("unexpected unlock"),
    resize = () => calls.push("unexpected resize"),
    onCameraClick = () => calls.push("unexpected camera action"),
    sealCameraKey = () => calls.push("unexpected camera key");
  window.addEventListener("pointerdown", unlockAudio);
  window.addEventListener("keydown", unlockAudio);
  window.addEventListener("resize", resize);
  webcamToggle.addEventListener("click", onCameraClick);
  webcamToggle.addEventListener("keydown", sealCameraKey);
  webcamToggle.addEventListener("keyup", sealCameraKey);
  const deps = {
    window,
    webcamToggle,
    webcamPanel,
    unlockAudio,
    resize,
    onCameraClick,
    sealCameraKey,
    renderer: {
      setAnimationLoop: (loop) => calls.push(["loop", loop]),
      dispose: () => calls.push("renderer"),
      domElement: { remove: () => calls.push("canvas") },
    },
    releasePause: () => calls.push("pause-release"),
    devHooks: {},
    diagnostics: {},
    pauseOverlay: { hide: () => calls.push("overlay") },
    face: { dispose: () => calls.push("camera") },
    game: { dispose: () => calls.push("scene") },
    disposeAudio: () => calls.push("audio"),
    timer: { dispose: () => calls.push("timer") },
  };
  const dispose = new Function(
    ...Object.keys(deps),
    `let disposed=false;${stripTypeScriptTypes(text)};return dispose;`,
  )(...Object.values(deps));
  dispose();
  dispose();
  assert.deepEqual(calls, [
    ["loop", null],
    "pause-release",
    "overlay",
    "camera",
    "scene",
    "audio",
    "timer",
    "renderer",
    "canvas",
  ]);
  assert.equal(window.listenerCount + webcamToggle.listenerCount, 0);
  assert.equal(webcamPanel.hidden, true);
});

test("actual main clears the paused embed gate and exact globals without touching replacement owners", () => {
  for (const replacement of [false, true]) {
    const calls = [];
    class Element extends Surface {
      classList = { contains: () => false, add() {}, remove() {}, toggle() {} };
      appendChild() {}
      remove() {}
      addEventListener(type, fn, options) {
        super.addEventListener(
          type,
          fn,
          options === true || options === false ? { capture: options } : options,
        );
      }
      removeEventListener(type, fn, options) {
        super.removeEventListener(
          type,
          fn,
          options === true || options === false ? { capture: options } : options,
        );
      }
    }
    const window = new Element();
    Object.assign(window, {
      parent: window,
      innerWidth: 1280,
      innerHeight: 720,
      devicePixelRatio: 1,
    });
    const elements = new Map();
    const document = {
      body: new Element(),
      getElementById(id) {
        if (!elements.has(id)) elements.set(id, new Element());
        return elements.get(id);
      },
    };
    const js = (text) =>
      stripTypeScriptTypes(text, { mode: "transform" })
        .replace(/^import[^;]*;\s*/gm, "")
        .replace(/^export /gm, "");
    const embed = new Function(
      "window",
      "HTMLElement",
      "GAME_PAUSED_MESSAGE",
      "GAME_STARTED_MESSAGE",
      "isPauseGameMessage",
      js(readFileSync(new URL("../../../packages/embed/src/game.ts", import.meta.url), "utf8")) +
        ";return {setPauseHandlers,notifyGameStarted,pauseGame,resumeGame,isPausable};",
    )(window, Element, "paused", "started", () => false);
    let loop, retainedLoop, pause;
    class Renderer {
      domElement = new Element();
      shadowMap = {};
      setPixelRatio() {}
      setSize() {
        calls.push("size");
      }
      setAnimationLoop(next) {
        loop = next;
        if (next) retainedLoop = next;
      }
      render() {
        calls.push("render");
      }
      dispose() {
        calls.push("renderer");
      }
    }
    class Timer {
      update() {}
      getDelta() {
        return 0.016;
      }
      dispose() {}
    }
    class Game {
      dispose() {
        calls.push("game");
      }
      setPresentationPaused() {
        calls.push("pause");
      }
      update() {
        calls.push("update");
      }
      diagnostics() {
        return { score: 0 };
      }
      resize() {
        calls.push("resize");
      }
      onMouthChange() {
        calls.push("mouth");
      }
      onHeadTurnLeft() {
        calls.push("left");
      }
      onHeadTurnRight() {
        calls.push("right");
      }
    }
    class Camera {
      start() {}
      dispose() {
        calls.push("camera");
      }
      setActionsPaused() {}
    }
    const deps = {
      window,
      document,
      THREE: { WebGLRenderer: Renderer, Timer },
      HTMLElement: Element,
      HTMLButtonElement: Element,
      HTMLVideoElement: Element,
      HTMLCanvasElement: Element,
      setPauseHandlers(next) {
        pause = next;
        return embed.setPauseHandlers(next);
      },
      disposeAudio() {},
      setAudioPaused() {},
      unlockAudio() {},
      FaceCamera: Camera,
      IS_TOUCH: false,
      pauseOverlay: { show() {}, hide() {} },
      GameScene: Game,
      MAX_DT: 0.05,
      TONE_EXPOSURE: 1,
    };
    new Function(
      ...Object.keys(deps),
      js(main)
        .replaceAll("import.meta.env.DEV", "true")
        .replace("import.meta.hot?.dispose(dispose);", ""),
    )(...Object.values(deps));
    const dispose = window.__pacmanDispose,
      hooks = window.__pacman;
    retainedLoop(1);
    embed.notifyGameStarted();
    embed.pauseGame();
    assert.equal(window.listeners.get("keyup").size, 1);
    let resumed = 0,
      release;
    const next = {};
    const names = ["__pacman", "__pacmanDispose", "__GAME_DIAGNOSTICS__"];
    if (replacement) {
      release = embed.setPauseHandlers({ onResume: () => resumed++ });
      for (const name of names) window[name] = next;
    }
    dispose();
    dispose();
    assert.equal(loop, null);
    assert.equal(window.listeners.get("keyup").size, replacement ? 1 : 0);
    for (const name of names) assert.equal(window[name], replacement ? next : undefined, name);
    assert.equal(calls.filter((c) => c === "camera").length, 1);
    assert.equal(calls.filter((c) => c === "game").length, 1);
    const after = [...calls];
    retainedLoop(2);
    pause.onPause();
    pause.onResume();
    hooks.mouth(true);
    hooks.chomp();
    hooks.turnLeft();
    hooks.turnRight();
    window.dispatchEvent(new Event("resize"));
    assert.deepEqual(calls, after);
    embed.resumeGame();
    assert.equal(resumed, replacement ? 1 : 0);
    assert.equal(embed.isPausable(), replacement);
    release?.();
  }
});
