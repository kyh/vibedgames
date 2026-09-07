import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import test from "node:test";
import * as THREE from "three";
import { PhysicalGamepad } from "../../../packages/gamepad/src/physical.ts";
import { VirtualGamepad, stickDirection4 } from "../../../packages/gamepad/src/core.ts";
import { Engine } from "../src/game/engine.ts";
import { screenToWorld } from "../src/game/camera-correction.ts";
import { CameraRig } from "../src/render/camera-rig.ts";
import { Well } from "../src/render/well.ts";
import { CubeField } from "../src/render/cube-field.ts";
import { ParticlePool } from "../src/fx/particles.ts";
import { WellFx } from "../src/fx/well-fx.ts";
import { createFixedRandom, FIXED_RUN_NAME, storeFixedBest } from "../src/game/fixed-run.ts";
import * as constants from "../src/shared/constants.ts";

const read = (name) => readFileSync(new URL(`../src/${name}`, import.meta.url), "utf8");
const source = read("scenes/game-scene.ts");
function member(text, name) {
  const lines = text.split("\n"),
    first = lines.findIndex((line) =>
      new RegExp(`^  (?:(?:private|public|readonly|async) )*${name}\\b`).test(line),
    );
  assert.ok(first >= 0, name);
  if (lines[first].endsWith(";")) return lines[first];
  const last = lines.findIndex((line, i) => i > first && /^  };?$/.test(line));
  assert.ok(last > first, name);
  return lines.slice(first, last + 1).join("\n");
}
class Surface extends EventTarget {
  style = {};
  hidden = false;
  dataset = {};
  textContent = "";
  classList = { toggle() {} };
  setAttribute() {}
  remove() {}
  closest() {
    return null;
  }
}
function compile(text, deps, output) {
  const code = stripTypeScriptTypes(
    text.replace(/^import[^;]*;\n/gm, "").replaceAll("export ", ""),
  );
  return new Function(...Object.keys(deps), `${code};return ${output}`)(...Object.values(deps));
}
function key(target, type, key, repeat = false) {
  const event = new Event(type, { cancelable: true });
  Object.assign(event, { key, repeat });
  target.dispatchEvent(event);
}
const methods = [
  "poseActions",
  "keyboardHandlers",
  "touchHandlers",
  "doRotate",
  "doOrbit",
  "doHold",
  "doPower",
  "onHardDrop",
  "onFreeTap",
  "requestPause",
  "startIfIdle",
  "startMode",
  "startGame",
  "refreshRunActions",
  "tryCatch",
  "shiftWallClock",
  "setPresentationPaused",
  "update",
  "updatePad",
  "padSteer",
  "routeSteering",
  "repeat",
  "applyMove",
  "stepScreen",
  "dispose",
  "setHudMode",
];
function fixture() {
  const ui = new Map(),
    window = new Surface();
  window.matchMedia = () => ({ matches: false });
  let now = 1000;
  const events = [],
    sounds = [];
  let game;
  const el = (id) => {
    let element = ui.get(id);
    if (!element) {
      element = new Surface();
      ui.set(id, element);
    }
    return element;
  };
  const deps = {
    ...THREE,
    ...constants,
    performance: { now: () => now },
    el,
    createFixedRandom,
    FIXED_RUN_NAME,
    storeFixedBest,
    notifyGameStarted: () => events.push("start"),
    resetSound() {},
    toggleMute() {},
    screenToWorld,
    stickDirection4,
    pauseGame: () => game.setPresentationPaused(true),
    sfx: new Proxy({}, { get: (_, name) => () => sounds.push(name) }),
  };
  const Subject = compile(
    `class Subject {\n${methods.map((name) => member(source, name)).join("\n")}\n}`,
    deps,
    "Subject",
  );
  game = new Subject();
  const input = { buttons: new Set(), axes: [0, 0] };
  const pad = new PhysicalGamepad({
    poll: () => [
      {
        connected: true,
        axes: input.axes,
        buttons: Array.from({ length: 17 }, (_, i) => ({
          pressed: input.buttons.has(i),
          value: input.buttons.has(i) ? 1 : 0,
        })),
      },
    ],
  });
  const scene = new THREE.Scene(),
    cubes = new CubeField(scene);
  const oldWindow = globalThis.window;
  globalThis.window = window;
  globalThis.document = { getElementById: el };
  const wellFx = new WellFx(scene);
  globalThis.window = oldWindow;
  const Keyboard = compile(read("input/keyboard.ts"), { window }, "Keyboard");
  let virtual;
  const Touch = compile(
    read("input/touch.ts"),
    {
      ...constants,
      window,
      document: { createElement: () => new Surface(), body: { appendChild() {} } },
      Element: Surface,
      stickDirection4,
      attachDomGamepad: (options) => {
        virtual = new VirtualGamepad(options);
        virtual.setViewport(800, 700, { top: 0, right: 0, bottom: 0, left: 0 });
        return {
          pad: virtual,
          update: () => virtual.nextFrame(),
          getStick: () => virtual.getStick(),
          justPressed: (id) => virtual.justPressed(id),
          justReleased: (id) => virtual.justReleased(id),
          isButtonDown: (id) => virtual.isButtonDown(id),
          destroy() {
            events.push("touch-dispose");
          },
        };
      },
    },
    "TouchControls",
  );
  Object.assign(game, {
    scene,
    cubes,
    wellFx,
    particles: new ParticlePool(scene),
    well: new Well(scene),
    rig: new CameraRig(1.5),
    engine: new Engine(),
    mode: { kind: "normal" },
    fixedBest: 0,
    bestScore: 0,
    presentationPaused: false,
    disposed: false,
    pad,
    padSteerBlocked: false,
    padSoftBlocked: false,
    padSoftDrop: false,
    hMove: { dir: 0, das: 0, arr: 0 },
    dMove: { dir: 0, das: 0, arr: 0 },
    frame: 0,
    collapseStartedAt: 900,
    poseHorizAt: -1e9,
    kbHoriz: 0,
    kbDepth: 0,
    poseHoriz: 0,
    collapse: { dispose: () => events.push("collapse-dispose"), step() {} },
    touchControls: { sync() {}, destroy: () => events.push("embed-dispose") },
    teaching: { dispose: () => events.push("teaching-dispose") },
    unwatchControls: () => events.push("watcher-dispose"),
    hideBanner() {
      this.refreshRunActions();
    },
    updateHud() {},
    handleLock: (ev) => events.push(ev),
    finalizeGameOver() {
      this.engine.state.status = "gameOver";
    },
    onCompactStart() {},
    onFixedEnter() {},
    onFixedRetry() {},
    onFixedNormal() {},
    sealRunKey() {},
    sealRunPointer() {},
  });
  game.keyboard = new Keyboard(game.keyboardHandlers());
  game.touch = new Touch(game.touchHandlers());
  game.engine.startGame();
  game.touch.setActive(true);
  return {
    game,
    window,
    input,
    events,
    sounds,
    ui,
    virtual,
    setClock: (value) => {
      now = value;
    },
  };
}
const cells = (g) => {
  const values = [];
  g.engine.board.forEachCube((x, y, z, color, id) => values.push({ x, y, z, color, id }));
  return values;
};
const boardState = (g) => ({
  cells: cells(g),
  active: g.engine.activeCells(),
  score: g.engine.state.score,
  charge: g.engine.charge,
  hold: g.engine.holdIndex,
  corner: g.rig.corner,
  phase: g.engine.state.status,
  soft: g.engine.softDropping,
});

test("paused actual pose, keyboard and touch verbs cannot change run or rescue/start", () => {
  const { game: g, window } = fixture();
  g.engine.board.lock([{ x: 0, y: 0, z: 0 }], 1);
  g.engine.charge = 1;
  g.setPresentationPaused(true);
  const before = boardState(g);
  for (const action of Object.values(g.poseActions)) action(1);
  for (const handlers of [g.keyboardHandlers(), g.touchHandlers()])
    for (const [name, action] of Object.entries(handlers)) {
      if (!["muteToggle", "recenter", "step"].includes(name)) action(1, true);
    }
  key(window, "keydown", "Shift");
  key(window, "keydown", " ");
  g.update(0.5);
  assert.deepEqual(boardState(g), before);
  assert.equal(g.frame, 0);
  g.engine.state.status = "collapsing";
  g.poseActions.catchCollapse();
  assert.equal(g.engine.state.status, "collapsing");
  g.engine.state.status = "gameOver";
  g.startMode({ kind: "fixed" });
  assert.equal(g.engine.state.status, "gameOver");
  assert.equal(g.mode.kind, "normal");
  g.dispose();
});

test("held keyboard repeats cannot rearm movement/soft drop across pause; fresh keys work", () => {
  const { game: g, window } = fixture();
  key(window, "keydown", "Shift");
  key(window, "keydown", "ArrowLeft");
  assert.equal(g.engine.softDropping, true);
  g.setPresentationPaused(true);
  g.setPresentationPaused(false);
  key(window, "keydown", "Shift", true);
  key(window, "keydown", "ArrowLeft", true);
  assert.equal(g.engine.softDropping, false);
  assert.equal(g.kbHoriz, 0);
  key(window, "keyup", "Shift");
  key(window, "keydown", "Shift");
  assert.equal(g.engine.softDropping, true);
  key(window, "keyup", "Shift");
  key(window, "keyup", "ArrowLeft");
  key(window, "keydown", "ArrowLeft");
  assert.equal(g.kbHoriz, -1);
  g.dispose();
});

test("actual virtual DROP release and queued touch edges drain on resume", () => {
  const { game: g, virtual } = fixture();
  const drop = virtual.getButtonLayout().find((b) => b.id === "drop");
  assert.ok(drop);
  virtual.pointerDown(1, drop.x, drop.y);
  g.touch.update(1);
  assert.equal(g.engine.softDropping, true);
  const before = boardState(g);
  g.setPresentationPaused(true);
  virtual.pointerUp(1);
  g.setPresentationPaused(false);
  g.touch.update(1);
  assert.deepEqual(boardState(g), { ...before, soft: false });
  virtual.pointerDown(2, drop.x, drop.y);
  g.touch.update(1);
  virtual.pointerUp(2);
  g.touch.update(1);
  assert.ok(g.engine.state.score > before.score);
  g.dispose();
});

test("title/results hide gameplay controls and discard old pointers before a fresh free tap", () => {
  const { game: g, virtual } = fixture();
  const drop = virtual.getButtonLayout().find((button) => button.id === "drop");
  assert.ok(drop);
  virtual.pointerDown(1, drop.x, drop.y);
  g.touch.update(1);
  g.engine.state.status = "gameOver";
  g.refreshRunActions();
  assert.equal(g.touch.root.hidden, true);
  virtual.pointerUp(1);
  g.touch.update(1);
  assert.equal(g.engine.state.status, "gameOver");
  g.touch.onPointerDown({
    pointerType: "touch",
    target: new Surface(),
    clientX: drop.x,
    clientY: drop.y,
  });
  assert.equal(g.engine.state.status, "playing");
  assert.equal(g.touch.root.hidden, false);
  assert.equal(g.engine.state.score, 0);
  g.dispose();
});

test("actual physical START plus action stops same-frame sim; held stick/trigger need release", () => {
  const { game: g, input } = fixture();
  input.buttons.add(9);
  input.buttons.add(1);
  const before = boardState(g);
  g.update(1);
  assert.equal(g.presentationPaused, true);
  assert.deepEqual(boardState(g), before);
  input.buttons.delete(9);
  input.buttons.add(6);
  input.axes = [1, 0];
  g.setPresentationPaused(false);
  g.updatePad(2000);
  assert.equal(g.engine.softDropping, false);
  assert.deepEqual(g.padSteer(), { horiz: 0, depth: 0 });
  assert.deepEqual(g.engine.activeCells(), before.active);
  input.buttons.clear();
  input.axes = [0, 0];
  g.updatePad(2100);
  g.padSteer();
  input.buttons.add(6);
  input.axes = [1, 0];
  g.updatePad(2200);
  assert.equal(g.engine.softDropping, true);
  assert.equal(g.padSteer().horiz, 1);
  g.dispose();
});

test("retry walls retain all four original camera corners and orbit/catch deadlines shift once", () => {
  const { game: g, setClock } = fixture();
  for (let corner = 0; corner < 4; corner++) {
    g.rig.corner = corner;
    g.engine.state.status = "gameOver";
    g.startGame();
    const expected = new Well(new THREE.Scene());
    expected.setCorner(corner);
    for (const name of ["xLo", "xHi", "zLo", "zHi"])
      assert.equal(g.well[name].visible, expected[name].visible);
    assert.equal(g.rig.corner, corner);
  }
  setClock(2000);
  g.doOrbit(1);
  const before = g.collapseStartedAt;
  g.shiftWallClock(5000);
  assert.equal(g.collapseStartedAt, before + 5000);
  assert.equal(g.rig.isInMotion(7020), true);
  assert.equal(g.rig.isInMotion(2000 + 5000 + constants.ORBIT_PAUSE_MS), false);
  g.dispose();
});

test("fixed retry repeats actual bags and normal exit restores original mode", () => {
  const { game: g } = fixture();
  g.engine.state.status = "gameOver";
  g.startMode({ kind: "fixed" });
  const first = { active: g.engine.active.index, next: g.engine.nextIndex };
  g.engine.hold();
  g.engine.state.status = "gameOver";
  g.startIfIdle();
  assert.deepEqual({ active: g.engine.active.index, next: g.engine.nextIndex }, first);
  assert.equal(g.mode.kind, "fixed");
  g.engine.state.status = "gameOver";
  g.startMode({ kind: "normal" });
  assert.equal(g.mode.kind, "normal");
  g.dispose();
});

test("final scene disposes shared Three resources and owners once; retained actions inert", () => {
  const { game: g, events } = fixture();
  g.engine.board.lock([{ x: 1, y: 0, z: 1 }], 1);
  g.cubes.syncLocked(g.engine.board);
  const counts = new Map();
  g.scene.traverse((o) => {
    for (const resource of [o.geometry, ...(Array.isArray(o.material) ? o.material : [o.material])])
      if (resource && !counts.has(resource)) {
        counts.set(resource, 0);
        resource.addEventListener("dispose", () => counts.set(resource, counts.get(resource) + 1));
      }
  });
  g.dispose();
  g.dispose();
  for (const count of counts.values()) assert.equal(count, 1);
  assert.equal(g.scene.children.length, 0);
  for (const name of ["embed-dispose", "touch-dispose", "watcher-dispose", "teaching-dispose"])
    assert.equal(events.filter((v) => v === name).length, 1);
  const before = boardState(g);
  for (const action of Object.values(g.poseActions)) action(1);
  g.update(1);
  assert.deepEqual(boardState(g), before);
});
