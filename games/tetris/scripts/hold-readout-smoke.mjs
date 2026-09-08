import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import test from "node:test";
import { Engine } from "../src/game/engine.ts";
import { createSeededRandom } from "./fixtures/seeded-random.mjs";
import { Piece } from "../src/game/piece.ts";
import { PIECES, POSE_TIMEOUT_MS } from "../src/shared/constants.ts";

function game() {
  const engine = new Engine();
  engine.startGame(createSeededRandom());
  return engine;
}

function collapse(engine) {
  engine.board.lock(
    engine.activeCells().map((cell) => ({ x: cell.x, y: cell.y - 1, z: cell.z })),
    1,
  );
  assert.equal(engine.hardDrop()?.gameOver, true);
  assert.equal(engine.state.status, "collapsing");
}

test("spent reads and rejected repeats leave the real engine and random supplier unchanged", () => {
  const engine = new Engine();
  const random = createSeededRandom();
  let draws = 0;
  engine.startGame(() => {
    draws++;
    return random();
  });
  assert.equal(engine.holdSpent, false);
  assert.equal(engine.hold(), true);
  const state = JSON.stringify(engine);
  const heldDraws = draws;
  for (let frame = 0; frame < 120; frame++) {
    assert.equal(engine.holdSpent, true);
    assert.equal(engine.hold(), false);
    assert.equal(engine.tick(1000, true), null);
  }
  assert.equal(JSON.stringify(engine), state);
  assert.equal(draws, heldDraws);
  const descriptor = Object.getOwnPropertyDescriptor(Engine.prototype, "holdSpent");
  assert.equal(descriptor?.get?.call(engine), true);
  assert.equal(descriptor?.set, undefined);
});

test("real hard drop and gravity lock re-arm the spent hold without changing its preview index", () => {
  for (const lock of [(engine) => engine.hardDrop(), (engine) => engine.tick(30000, false)]) {
    const engine = game();
    assert.equal(engine.hold(), true);
    const held = engine.holdIndex;
    assert.equal(engine.holdSpent, true);
    const event = lock(engine);
    assert.ok(event);
    assert.equal(event.gameOver, false);
    assert.equal(engine.holdIndex, held);
    assert.equal(engine.holdSpent, false);
    assert.equal(engine.hold(), true);
  }
});

test("spawn collisions do not spend an empty hold or a held-piece swap", () => {
  const engine = game();
  for (const stored of [false, true]) {
    if (stored) {
      assert.equal(engine.hold(), true);
      assert.equal(engine.hardDrop()?.gameOver, false);
      engine.board.reset();
    }
    engine.tick(engine.cycleTimeMs, false);
    const incoming = new Piece(engine.holdIndex ?? engine.nextIndex, engine.board);
    const blocker = incoming.cells()[0];
    assert.ok(blocker);
    engine.board.lock([blocker], 1);
    const before = JSON.stringify(engine);
    assert.equal(engine.hold(), false);
    assert.equal(engine.holdSpent, false);
    assert.equal(JSON.stringify(engine), before);
    engine.board.reset();
  }
});

test("top-out stays spent until real rescue; ordinary retry and reset clear it", () => {
  const engine = game();
  assert.equal(engine.hold(), true);
  collapse(engine);
  assert.equal(engine.holdSpent, true);
  const held = engine.holdIndex;
  assert.equal(engine.resumeAfterCatch(), false);
  assert.equal(engine.holdSpent, false);
  assert.equal(engine.holdIndex, held);
  for (const restart of [() => engine.startGame(), () => engine.reset()]) {
    assert.equal(engine.hold(), true);
    assert.equal(engine.holdSpent, true);
    restart();
    assert.equal(engine.holdSpent, false);
    assert.equal(engine.holdIndex, null);
  }
});

const source = readFileSync(new URL("../src/scenes/game-scene.ts", import.meta.url), "utf8");
function member(name) {
  const lines = source.split("\n");
  const first = lines.findIndex((line) => new RegExp(`^  private ${name}\\b`).test(line));
  assert.ok(first >= 0, name);
  if (lines[first].endsWith(";")) return lines[first];
  const last = lines.findIndex((line, i) => i > first && /^  }$/.test(line));
  assert.ok(last > first, name);
  return lines.slice(first, last + 1).join("\n");
}

class Surface {
  textContent = "";
  hidden = true;
  dataset = {};
}
class Canvas extends Surface {}

function hud(engine) {
  const elements = new Map();
  const draws = [];
  const el = (id) => {
    let element = elements.get(id);
    if (!element) {
      element = id.endsWith("-canvas") ? new Canvas() : new Surface();
      elements.set(id, element);
    }
    return element;
  };
  const members = [
    "hudScore",
    "hudLines",
    "hudOwner",
    "hudNextIdx",
    "hudHoldIdx",
    "hudHoldSpent",
    "hudCharge",
    "updateHud",
  ];
  const body = stripTypeScriptTypes(`class ActualHud {\n${members.map(member).join("\n")}\n}`);
  const ActualHud = new Function(
    "el",
    "HTMLCanvasElement",
    "PIECES",
    "POSE_TIMEOUT_MS",
    "drawPiecePreview",
    `${body};return ActualHud`,
  )(el, Canvas, PIECES, POSE_TIMEOUT_MS, (canvas) => draws.push(canvas));
  const view = new ActualHud();
  Object.assign(view, {
    engine,
    coarse: false,
    lastPoseAt: 0,
    lastPadAt: 0,
    updateCatchMeter() {},
  });
  return {
    update: () => view.updateHud(10000),
    spent(expected) {
      assert.equal(el("hold-preview").dataset.spent, String(expected));
      assert.equal(el("hold-status").hidden, !expected);
      assert.equal(el("hold-hint").hidden, !expected);
    },
    heldDraws: () => draws.filter((canvas) => canvas === el("hold-canvas")).length,
    el,
  };
}

test("actual HUD changes spent cue independently of held-index changes, including rescue and retry", () => {
  const engine = game();
  const view = hud(engine);
  view.update();
  view.spent(false);
  assert.equal(engine.hold(), true);
  view.update();
  view.spent(true);
  const draws = view.heldDraws();
  assert.equal(engine.hold(), false);
  view.update();
  view.spent(true);
  assert.equal(view.heldDraws(), draws);
  assert.equal(engine.hardDrop()?.gameOver, false);
  view.update();
  view.spent(false);
  assert.equal(view.heldDraws(), draws);

  engine.board.reset();
  assert.equal(engine.hold(), true);
  view.update();
  view.spent(true);
  collapse(engine);
  view.update();
  view.spent(true);
  const beforeCatch = view.heldDraws();
  assert.equal(engine.resumeAfterCatch(), false);
  view.update();
  view.spent(false);
  assert.equal(view.heldDraws(), beforeCatch);
  for (let retry = 0; retry < 2; retry++) {
    assert.equal(engine.hold(), true);
    view.update();
    view.spent(true);
    engine.startGame();
    view.update();
    view.spent(false);
  }
});

test("actual HUD keeps a colliding hold neutral and does not rewrite unchanged cue nodes", () => {
  const engine = game();
  const view = hud(engine);
  view.update();
  engine.board.lock(new Piece(engine.nextIndex, engine.board).cells(), 1);
  assert.equal(engine.hold(), false);
  view.update();
  view.spent(false);

  let writes = 0;
  for (const id of ["hold-status", "hold-hint"]) {
    Object.defineProperty(view.el(id), "hidden", { set: () => writes++ });
  }
  view.el("hold-preview").dataset = new Proxy({}, { set: () => (writes++, true) });
  for (let frame = 0; frame < 120; frame++) view.update();
  assert.equal(writes, 0);
});
