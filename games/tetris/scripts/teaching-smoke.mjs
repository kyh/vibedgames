import assert from "node:assert/strict";
import test from "node:test";
import { Board } from "../src/game/board.ts";
import { Piece } from "../src/game/piece.ts";
import { teachingExamples } from "../src/game/teaching-examples.ts";
import { RuleTeaching } from "../src/game/rule-teaching.ts";

function cells(board) {
  const found = [];
  board.forEachCube((x, y, z, color, id) => found.push({ x, y, z, color, id }));
  return found;
}

test("rule examples use the actual isolated Board clear operation and intersection drops only once", () => {
  const calls = [];
  const original = Board.prototype.clearLayer;
  Board.prototype.clearLayer = function (y) {
    const result = original.call(this, y);
    calls.push(result);
    return result;
  };
  let examples;
  try {
    examples = teachingExamples();
  } finally {
    Board.prototype.clearLayer = original;
  }
  assert.equal(calls.length, 2);
  assert.equal(examples[0].clear, calls[0]);
  assert.equal(examples[2].clear, calls[1]);
  assert.equal(calls[0].cubes, 8);
  assert.equal(calls[0].lines, 1);
  assert.equal(calls[1].cubes, 15);
  assert.equal(calls[1].lines, 2);
  assert.equal(new Set(calls[1].clearedCells.map((c) => `${c.x},${c.y},${c.z}`)).size, 15);
  const board = new Board();
  board.lock(examples[2].cells, 3);
  board.lock([{ x: 3, y: 3, z: 3 }], 2);
  board.clearLayer(2);
  assert.deepEqual(
    cells(board).map(({ x, y, z, color }) => ({ x, y, z, color })),
    [{ x: 3, y: 2, z: 3, color: 2 }],
  );
});

test("landing example matches the real piece drop without mutating the pictured stack", () => {
  const example = teachingExamples()[1];
  const board = new Board();
  board.lock(example.cells, 6);
  const before = cells(board);
  const piece = new Piece(2, board);
  assert.deepEqual(example.landing, piece.landingCells(board));
  assert.equal(board.collides(example.landing), false);
  assert.equal(board.collides(example.landing.map((cell) => ({ ...cell, y: cell.y - 1 }))), true);
  while (piece.fall(board)) {
    /* Actual fall stops at the published footprint. */
  }
  assert.deepEqual(piece.cells(), example.landing);
  assert.deepEqual(cells(board), before);
});

// Minimal native-DOM boundary for the actual owner. It records ownership/writes;
// browser keyboard activation and visual layout are separate acceptance gates.
class ElementFixture extends EventTarget {
  children = [];
  attributes = new Map();
  listeners = new Map();
  textContent = "";
  className = "";
  disabled = false;
  writes = 0;
  replacements = 0;
  constructor(tag, doc) {
    super();
    this.tag = tag;
    this.ownerDocument = doc;
  }
  append(...children) {
    this.children.push(...children);
  }
  replaceChildren(...children) {
    this.replacements++;
    this.children = children;
  }
  setAttribute(name, value) {
    this.writes++;
    this.attributes.set(name, value);
  }
  addEventListener(name, callback, options) {
    super.addEventListener(name, callback, options);
    const set = this.listeners.get(name) ?? new Set();
    set.add(callback);
    this.listeners.set(name, set);
  }
  removeEventListener(name, callback, options) {
    super.removeEventListener(name, callback, options);
    this.listeners.get(name)?.delete(callback);
  }
}
class KeyboardFixture extends Event {
  constructor(type, key, code) {
    super(type, { cancelable: true });
    this.key = key;
    this.code = code;
  }
}
function documentFixture() {
  const nodes = [];
  const doc = {
    createElement(tag) {
      const node = new ElementFixture(tag, doc);
      nodes.push(node);
      return node;
    },
    createElementNS(_namespace, tag) {
      return doc.createElement(tag);
    },
  };
  return { doc, nodes };
}
function liveListeners(nodes) {
  return nodes.reduce(
    (sum, node) => sum + [...node.listeners.values()].reduce((n, set) => n + set.size, 0),
    0,
  );
}

test("one teaching owner browses three cards with stable DOM and fences only native activation keys", () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "KeyboardEvent");
  Object.defineProperty(globalThis, "KeyboardEvent", {
    configurable: true,
    value: KeyboardFixture,
  });
  const f = documentFixture(),
    root = f.doc.createElement("div"),
    owner = new RuleTeaching(root);
  try {
    const buttons = f.nodes.filter((node) => node.tag === "button"),
      [previous, next] = buttons;
    const rectangles = f.nodes.filter((node) => node.tag === "rect");
    assert.equal(rectangles.length, 64);
    assert.equal(
      rectangles.filter((node) => node.attributes.get("class").includes("rule-cell-clear")).length,
      8,
    );
    const nodes = [...f.nodes],
      writes = rectangles.map((node) => node.writes);
    owner.refresh();
    owner.refresh();
    assert.deepEqual(f.nodes, nodes);
    assert.deepEqual(
      rectangles.map((node) => node.writes),
      writes,
    );
    assert.equal(root.replacements, 1);
    next.dispatchEvent(new Event("click"));
    assert.equal(
      rectangles.filter((node) => node.attributes.get("class").includes("rule-cell-landing"))
        .length,
      4,
    );
    next.dispatchEvent(new Event("click"));
    assert.equal(
      rectangles.filter((node) => node.attributes.get("class").includes("rule-cell-clear")).length,
      15,
    );
    assert.equal(next.disabled, true);
    next.dispatchEvent(new Event("click"));
    assert.equal(f.nodes.find((node) => node.tag === "span").textContent, "3 / 3");
    previous.dispatchEvent(new Event("click"));
    assert.equal(next.disabled, false);
    for (const type of ["keydown", "keyup"])
      for (const [key, code, fenced] of [
        ["Enter", "Enter", true],
        [" ", "Space", true],
        ["m", "KeyM", false],
        ["Escape", "Escape", false],
      ]) {
        const event = new KeyboardFixture(type, key, code);
        root.dispatchEvent(event);
        assert.equal(event.cancelBubble, fenced);
        assert.equal(event.defaultPrevented, false);
      }
    const pointer = new Event("pointerdown", { cancelable: true });
    root.dispatchEvent(pointer);
    assert.equal(pointer.cancelBubble, true);
    assert.equal(pointer.defaultPrevented, false);
    assert.equal(liveListeners(f.nodes), 9);
  } finally {
    owner.dispose();
    if (descriptor) Object.defineProperty(globalThis, "KeyboardEvent", descriptor);
    else delete globalThis.KeyboardEvent;
  }
  assert.equal(liveListeners(f.nodes), 0);
});

test("repeated teaching creation/disposal owns no timers, retained handlers or duplicate DOM", () => {
  const f = documentFixture(),
    root = f.doc.createElement("div");
  for (let cycle = 0; cycle < 3; cycle++) {
    const owner = new RuleTeaching(root);
    const next = f.nodes.findLast((node) => node.attributes.get("aria-label") === "Next rule");
    const retained = [...next.listeners.get("click")][0];
    assert.equal(liveListeners(f.nodes), 9);
    owner.dispose();
    owner.dispose();
    assert.equal(liveListeners(f.nodes), 0);
    assert.equal(root.children.length, 0);
    const before = f.nodes.map((node) => node.writes);
    retained();
    owner.refresh();
    assert.deepEqual(
      f.nodes.map((node) => node.writes),
      before,
    );
  }
  const absent = new RuleTeaching(null);
  absent.refresh();
  absent.dispose();
  absent.dispose();
});
