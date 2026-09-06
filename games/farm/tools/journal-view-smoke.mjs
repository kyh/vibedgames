// Actual JournalView + InventoryScene + Collections/Inventory modules. The DOM
// and Phaser drawing adapters measure ownership/dispatch, not browser layout.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { sealPointerEvents } from "../../../packages/embed/src/pointer-seal.ts";
import { onSceneExit } from "../src/render/scene-lifetime.ts";
import { Collections } from "../src/systems/collections.ts";
import { store } from "../src/systems/store.ts";
import { HOTBAR, TOTAL } from "../src/systems/inventory.ts";
import { itemIcon, itemName, sellValue, isSellable } from "../src/data/items.ts";
import { SKILL_IDS, SKILL_NAMES, SKILL_ICON, xpToNext } from "../src/systems/skills.ts";
import { SEASONS, seasonName, seasonOfDay } from "../src/data/calendar.ts";
const base = resolve(dirname(fileURLToPath(import.meta.url)), "..");
class Target {
  listeners = new Map();
  addEventListener(type, callback) {
    const set = this.listeners.get(type) ?? new Set();
    set.add(callback);
    this.listeners.set(type, set);
  }
  removeEventListener(type, callback) {
    this.listeners.get(type)?.delete(callback);
  }
  emit(type, props = {}) {
    const event = {
      type,
      target: this,
      key: "",
      repeat: false,
      shiftKey: false,
      cancelable: true,
      defaultPrevented: false,
      stopped: false,
      preventDefault() {
        this.defaultPrevented = true;
      },
      stopPropagation() {
        this.stopped = true;
      },
      ...props,
    };
    for (const callback of this.listeners.get(type) ?? []) callback(event);
    return event;
  }
  count() {
    return [...this.listeners.values()].reduce((n, set) => n + set.size, 0);
  }
}
class Node extends Target {
  children = [];
  parent = null;
  className = "";
  ownText = "";
  dataset = {};
  attributes = new Map();
  hidden = false;
  scrollTop = 0;
  constructor(tag) {
    super();
    this.tagName = tag;
    const styles = new Map();
    this.style = {
      setProperty: (name, value) => styles.set(name, value),
      getPropertyValue: (name) => styles.get(name),
    };
    this.classList = {
      add: (...names) => {
        this.className = [...new Set([...this.className.split(" "), ...names])].join(" ");
      },
      remove: (...names) => {
        this.className = this.className
          .split(" ")
          .filter((name) => !names.includes(name))
          .join(" ");
      },
      contains: (name) => this.className.split(" ").includes(name),
      toggle: (name, on) => {
        if (on ?? !this.classList.contains(name)) this.classList.add(name);
        else this.classList.remove(name);
      },
    };
  }
  append(...nodes) {
    for (const node of nodes) {
      node.parent = this;
      this.children.push(node);
    }
  }
  replaceChildren(...nodes) {
    for (const node of this.children) node.parent = null;
    this.children = [];
    this.append(...nodes);
  }
  set textContent(value) {
    this.ownText = String(value);
    this.replaceChildren();
  }
  get textContent() {
    return this.ownText + this.children.map((node) => node.textContent).join("");
  }
  setAttribute(key, value) {
    this.attributes.set(key, String(value));
  }
  getAttribute(key) {
    return this.attributes.get(key);
  }
  get isConnected() {
    return this === document.body || this.parent?.isConnected === true;
  }
  focus() {
    document.activeElement = this;
  }
  remove() {
    if (this.parent) this.parent.children = this.parent.children.filter((node) => node !== this);
    this.parent = null;
  }
  closest(tag) {
    return this.tagName === tag ? this : (this.parent?.closest(tag) ?? null);
  }
}
class Button extends Node {
  constructor() {
    super("button");
  }
}
const document = new Target();
document.body = new Node("body");
document.activeElement = document.body;
document.createElement = (tag) => (tag === "button" ? new Button() : new Node(tag));
globalThis.HTMLElement = Node;
globalThis.Element = Node;
function load(relative, name, context) {
  const source = readFileSync(resolve(base, relative), "utf8")
    .replace(/^import\s[^]*?;\n/gm, "")
    .replace(/^export /gm, "");
  const code = stripTypeScriptTypes(source, { mode: "transform" });
  return new Function(...Object.keys(context), `${code}; return ${name};`)(
    ...Object.values(context),
  );
}
const JournalView = load("src/render/journal-view.ts", "JournalView", {
  document,
  HTMLElement: Node,
  Element: Node,
  sealPointerEvents,
  SEASONS,
  seasonName,
});
function all(node, predicate) {
  return [node, ...node.children.flatMap((child) => all(child, predicate))].filter(predicate);
}
const byClass = (node, name) => all(node, (child) => child.classList.contains(name));
const named = (node, text) =>
  all(node, (child) => child.tagName === "button" && child.textContent === text)[0];
let groups = 0;
const pass = (name) => {
  groups++;
  console.log(`PASS ${name}`);
};
const collection = Collections.empty();
collection.recordHarvest("parsnip", "spring", 1);
let pages = [];
let closes = 0;
const journal = new JournalView("spring", (season) => collection.page(season), {
  page: (page) => pages.push(page),
  close: () => closes++,
});
assert.equal(document.body.classList.contains("farm-inventory-open"), true);
assert.equal(document.activeElement, named(journal.root, "Inventory"));
assert.equal(document.emit("keyup", { key: "i" }).stopped, false);
assert.equal(closes, 0);
const before = JSON.stringify(collection.toJSON());
named(journal.root, "Journal").emit("click");
assert.equal(journal.page, "journal");
assert.deepEqual(pages, ["inventory", "journal"]);
assert.equal(byClass(journal.root, "farm-journal-entry").length, collection.page("spring").total);
assert.equal(
  byClass(journal.root, "farm-journal-entry").filter((row) => row.dataset.found === "true").length,
  1,
);
assert.equal(JSON.stringify(collection.toJSON()), before, "opening reads only");
assert.ok(journal.root.textContent.includes("Finds stay recorded across years."));
const springRows = byClass(journal.root, "farm-journal-entry");
journal.refresh();
assert.equal(
  byClass(journal.root, "farm-journal-entry")[0],
  springRows[0],
  "no repeated DOM rewrite",
);
const winter = named(journal.root, "Winter");
winter.focus();
winter.emit("click");
assert.equal(byClass(journal.root, "farm-journal-entry").length, 5);
assert.ok(journal.root.textContent.includes("Winter fields rest"));
assert.equal(document.activeElement, winter);
assert.equal(
  all(journal.root, (node) => node.tagName === "img").every(
    (node) => node.src === "assets/obj/fish.webp",
  ),
  true,
);
collection.recordCatch("carp", "winter", 1);
journal.refresh();
assert.equal(document.activeElement, winter);
assert.equal(
  byClass(journal.root, "farm-journal-entry").filter((row) => row.dataset.found === "true").length,
  1,
);
pass(
  "real seasonal eligibility/discovery, original icons, quiet read-only refresh and focus identity",
);
for (const key of ["Enter", " "]) {
  const event = document.emit("keydown", { key });
  assert.equal(event.stopped, true);
  assert.equal(event.defaultPrevented, false);
  assert.equal(document.emit("keyup", { key }).stopped, true);
}
assert.equal(document.emit("keydown", { key: "m" }).stopped, false);
assert.equal(
  document.emit("keyup", { key: "ArrowRight" }).stopped,
  false,
  "release old movement hold",
);
named(journal.root, "Inventory").focus();
const wrap = document.emit("keydown", { key: "Tab", shiftKey: true });
assert.equal(wrap.defaultPrevented, true);
assert.equal(document.activeElement, byClass(journal.root, "farm-journal-scroll")[0]);
document.emit("keydown", { key: "i" });
document.emit("keydown", { key: "i", repeat: true });
assert.equal(closes, 0);
assert.equal(document.emit("keyup", { key: "i" }).defaultPrevented, true);
assert.equal(closes, 1);
document.emit("keyup", { key: "i" });
assert.equal(closes, 1);
const touch = journal.root.emit("touchend", { target: winter });
assert.equal(touch.defaultPrevented, false, "native button click retained");
const backdrop = journal.root.emit("touchend");
assert.equal(backdrop.defaultPrevented, true);
assert.equal(backdrop.stopped, true);
assert.equal(closes, 2);
journal.destroy();
journal.destroy();
assert.equal(document.count(), 0);
assert.equal(document.body.children.length, 0);
pass("fresh key-release close, native button defaults, focus trap and sealed backdrop touch");

class Drawable extends EventEmitter {
  x = 0;
  y = 0;
  setPosition(x, y) {
    this.x = x;
    this.y = y;
    return this;
  }
  setText(text) {
    this.text = text;
    return this;
  }
}
const draw = () => {
  const node = new Drawable();
  return new Proxy(node, {
    get(target, key, receiver) {
      if (key in target) return target[key];
      return () => receiver;
    },
  });
};
class GameScene {
  day = 1;
  uiOpen = true;
  closeCount = 0;
  closeUi() {
    this.uiOpen = false;
    this.closeCount++;
  }
}
const Phaser = {
  Scene: EventEmitter,
  Math: { Clamp: (n, min, max) => Math.max(min, Math.min(max, n)) },
};
let clicks = 0;
const InventoryScene = load("src/scenes/inventory-scene.ts", "InventoryScene", {
  Phaser,
  store,
  HOTBAR,
  TOTAL,
  itemIcon,
  itemName,
  sellValue,
  isSellable,
  SKILL_IDS,
  SKILL_NAMES,
  SKILL_ICON,
  xpToNext,
  Sound: { click: () => clicks++ },
  GameScene,
  seasonOfDay,
  JournalView,
  onSceneExit,
});
function inventory(width, height) {
  store.initNew();
  const scene = new InventoryScene();
  const game = new GameScene();
  scene.add = { rectangle: draw, graphics: draw, text: draw, image: draw };
  scene.scale = new EventEmitter();
  scene.scale.width = width;
  scene.scale.height = height;
  scene.input = new EventEmitter();
  scene.input.keyboard = new EventEmitter();
  scene.events = new EventEmitter();
  scene.time = { now: 0 };
  scene.cameras = { main: { visible: true } };
  scene.scene = { get: () => game, stop: () => scene.events.emit("shutdown") };
  return { scene, game };
}
for (const [width, height] of [
  [1280, 720],
  [390, 844],
  [844, 390],
]) {
  const { scene } = inventory(width, height);
  scene.create();
  const { px, py, panelW, panelH } = scene.panel;
  const skill = scene.skillPanel;
  assert.ok(px >= 0 && px + panelW <= width);
  assert.ok(py >= 64 && py + panelH <= height);
  assert.ok(skill.x >= 0 && skill.x + skill.w <= width && skill.y + skill.h <= height);
  assert.equal(scene.cells.length, TOTAL);
  assert.equal(scene.sz, 44);
  const navTop = Number.parseFloat(scene.journal.root.style.getPropertyValue("--bag-top"));
  assert.ok(navTop >= 0 && navTop + 56 <= py);
  const initial = store.inv.slotAt(0);
  const first = scene.cells[0];
  const last = scene.cells[TOTAL - 1];
  scene.onClick(first);
  assert.equal(scene.picked, 0);
  named(scene.journal.root, "Journal").emit("click");
  assert.equal(scene.cameras.main.visible, false);
  assert.equal(scene.input.enabled, false);
  scene.onClick(last);
  assert.equal(store.inv.slotAt(0), initial);
  assert.equal(scene.picked, 0);
  named(scene.journal.root, "Inventory").emit("click");
  assert.equal(scene.cameras.main.visible, true);
  assert.equal(scene.input.enabled, true);
  scene.onClick(last);
  assert.equal(store.inv.slotAt(TOTAL - 1), initial);
  assert.equal(scene.picked, -1);
  scene.events.emit("shutdown");
  scene.events.emit("destroy");
  assert.equal(scene.scale.listenerCount("resize"), 0);
  assert.equal(scene.input.listenerCount("pointerdown"), 0);
  assert.equal(document.count(), 0);
  assert.equal(document.body.classList.contains("farm-inventory-open"), false);
}
assert.equal(clicks, 6);
pass("actual inventory bounds at3 target sizes; original2-tap swap across journal; exit cleanup");

const { scene, game } = inventory(390, 844);
for (let i = 0; i < 3; i++) {
  scene.create();
  assert.equal(document.body.children.length, 1);
  assert.equal(scene.scale.listenerCount("resize"), 1);
  if (i === 2) scene.events.emit("destroy");
  else scene.events.emit("shutdown");
  scene.events.emit("destroy");
  assert.equal(document.body.children.length, 0);
  assert.equal(document.count(), 0);
  assert.equal(scene.scale.listenerCount("resize"), 0);
  assert.equal(scene.input.keyboard.listenerCount("keydown-I"), 0);
}
scene.create();
scene.close();
scene.close();
assert.equal(game.closeCount, 1);
assert.equal(document.count(), 0);
assert.equal(document.body.classList.contains("farm-inventory-open"), false);
pass("three actual scene reuse cycles, final destroy, and close once with no retained handlers");
console.log(`${groups} Farm journal/inventory groups passed.`);
