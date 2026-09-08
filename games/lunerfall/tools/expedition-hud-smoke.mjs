// Actual HUD listeners and shared pointer seal; only DOM/display plumbing is
// replaced. Native details activation, event bubbling and layout remain browser gates.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { sealPointerEvents } from "../../../packages/embed/src/pointer-seal.ts";

class Element extends EventTarget {
  children = [];
  parent = null;
  handlers = new Map();
  style = { setProperty() {} };
  hidden = false;
  open = false;
  textContent = "";
  addEventListener(type, listener, options) {
    super.addEventListener(type, listener, options);
    const listeners = this.handlers.get(type) ?? new Set();
    listeners.add(listener);
    this.handlers.set(type, listeners);
  }
  removeEventListener(type, listener, options) {
    super.removeEventListener(type, listener, options);
    this.handlers.get(type)?.delete(listener);
  }
  setAttribute() {}
  append(...nodes) {
    for (const node of nodes) {
      node.parent = this;
      this.children.push(node);
    }
  }
  replaceChildren(...nodes) {
    this.children = [];
    this.append(...nodes);
  }
  contains(node) {
    return node === this || this.children.some((child) => child.contains(node));
  }
  focus() {
    document.activeElement = this;
  }
  blur() {
    if (document.activeElement === this) document.activeElement = document.body;
  }
  remove() {
    if (this.parent) this.parent.children = this.parent.children.filter((node) => node !== this);
    this.parent = null;
  }
}
globalThis.HTMLElement = Element;
globalThis.document = {
  head: new Element(),
  body: new Element(),
  activeElement: null,
  createElement: () => new Element(),
};

class Text {
  style = { fontSize: "9px", color: "#d8dee6" };
  text = "";
  visible = true;
  height = 11;
  destroyed = false;
  setOrigin() {
    return this;
  }
  setScrollFactor() {
    return this;
  }
  setDepth() {
    return this;
  }
  setWordWrapWidth() {
    return this;
  }
  setText(text) {
    this.text = text;
    return this;
  }
  setColor(color) {
    this.style.color = color;
    return this;
  }
  setFontSize(size) {
    this.style.fontSize = `${size}px`;
    return this;
  }
  setPosition(x, y) {
    this.x = x;
    this.y = y;
    return this;
  }
  setVisible(visible) {
    this.visible = visible;
    return this;
  }
  destroy() {
    this.destroyed = true;
  }
}

const sourcePath =
  process.env.LUNER_HUD_SOURCE ?? new URL("../src/expedition-hud.ts", import.meta.url);
const source = stripTypeScriptTypes(readFileSync(sourcePath, "utf8"), { mode: "transform" })
  .replace(/^import\b[^;]*;\s*/gm, "")
  .replace(/^export /gm, "");
const ExpeditionHud = new Function(
  "sealPointerEvents",
  "BASE_W",
  "gameInset",
  "isCoarse",
  "touchHudBand",
  `${source}\nreturn ExpeditionHud;`,
)(
  sealPointerEvents,
  480,
  () => ({ left: 0, right: 0, top: 0, bottom: 0 }),
  () => false,
  () => 0,
);
const displays = [];
const scene = {
  add: {
    text: () => {
      const text = new Text();
      displays.push(text);
      return text;
    },
  },
  input: new EventEmitter(),
  scale: new EventEmitter(),
  events: new EventEmitter(),
  game: { canvas: { getBoundingClientRect: () => ({ left: 0, top: 0, width: 667 }) } },
};
const hearts = new Text();
const info = new Text();
const hud = new ExpeditionHud(scene, hearts, info);
const build = document.body.children.find((node) => node.className === "lf-build");
assert.ok(build);
const [summary, list] = build.children;
assert.ok(summary);
assert.ok(list);
const state = {
  hearts: 4,
  maxHearts: 4,
  biomeName: "MOONWOOD",
  biome: 1,
  depth: 4,
  bossAt: 7,
  gold: 100,
  score: 0,
  special: { kind: "ready" },
  bossName: null,
  safeRoom: true,
  relics: [],
  offer: null,
  visible: true,
};
hud.update(state);
function key(type, value) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "key", { value });
  build.dispatchEvent(event);
  return event;
}

summary.focus();
for (const value of ["a", "d", "j", "k", "Shift", "Escape"])
  assert.equal(key("keydown", value).cancelBubble, false, `collapsed summary releases ${value}`);
for (const value of ["Enter", " "]) {
  const event = key("keydown", value);
  assert.equal(event.cancelBubble, true, `native summary activation contains ${value}`);
  assert.equal(event.defaultPrevented, false, "native details activation remains enabled");
}
console.log("PASS collapsed inspector releases gameplay keys while keeping native activation");

build.open = true;
list.focus();
for (const value of ["a", "d", "j", "k", " ", "ArrowDown", "Tab"]) {
  const event = key("keydown", value);
  assert.equal(event.cancelBubble, true, `open inspector contains ${value}`);
  assert.equal(event.defaultPrevented, false, "native scrolling and focus remain enabled");
}
assert.equal(key("keydown", "Escape").cancelBubble, false, "Escape reaches pause");
for (const value of ["a", "d", "j", "k", " "])
  assert.equal(key("keyup", value).cancelBubble, false, "held game inputs always release");
scene.input.emit("pointerdown");
assert.equal(build.open, false, "world pointer closes inspection");
assert.equal(document.activeElement, document.body, "world pointer releases inspector focus");
summary.focus();
scene.input.emit("pointerdown");
assert.equal(
  document.activeElement,
  document.body,
  "world pointer also releases collapsed summary",
);
console.log("PASS open inspector contains actions; world pointer closes and releases focus");

build.open = true;
scene.events.emit("pause");
assert.equal(build.hidden, true);
assert.equal(build.open, false);
scene.events.emit("resume");
assert.equal(build.hidden, false);
assert.equal(build.open, false);
build.open = true;
hud.update({ ...state, safeRoom: false });
assert.equal(build.hidden, true);
assert.equal(build.open, false);
hud.update({ ...state, relics: null });
assert.equal(build.hidden, true, "unknown build metadata is not displayed as an empty build");
console.log("PASS pause and room changes close inspection without changing run data");

scene.events.emit("shutdown");
hud.destroy();
assert.equal(scene.input.listenerCount("pointerdown"), 0);
assert.deepEqual(scene.scale.eventNames(), []);
assert.deepEqual(scene.events.eventNames(), []);
assert.equal(
  [...build.handlers.values()].reduce((total, handlers) => total + handlers.size, 0),
  0,
);
assert.equal(document.body.children.includes(build), false);
assert.equal(document.head.children.length, 0);
assert.equal(
  displays.every((display) => display.destroyed),
  true,
);
assert.equal(hearts.destroyed, false);
assert.equal(info.destroyed, false);
console.log("PASS final scene shutdown removes owned input/display/DOM resources only");
