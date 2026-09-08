// Actual SelectScene + HubView + meta/parser/control modules. Minimal display
// and DOM plumbing replaces rendering; native layout/default activation is
// intentionally a separate browser gate. No copied choice/purchase callbacks.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire, stripTypeScriptTypes } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as meta from "../src/data/meta.ts";
import { readRunRecap } from "../src/data/run-recap.ts";
import { parseRoomCode, partyLink } from "../src/hub/party-link.ts";
import { HERO_ORDER, HEROES } from "../src/data/heroes.ts";
import { CONTROLS } from "../src/controls.ts";
import { BASE_W, BASE_H, HERO_ORIGIN_Y } from "../src/config.ts";
import { controlGroups, watchControlContext } from "../../../packages/embed/src/controls.ts";
import { sealPointerEvents } from "../../../packages/embed/src/pointer-seal.ts";

const base = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const req = createRequire(resolve(base, "package.json"));
const phaserRoot = resolve(dirname(req.resolve("phaser")), "..");
const Emitter = createRequire(resolve(phaserRoot, "package.json"))("eventemitter3");
const memory = new Map();
globalThis.localStorage = {
  getItem: (key) => memory.get(key) ?? null,
  setItem: (key, value) => memory.set(key, String(value)),
};
let coarse = false;
class Target extends EventTarget {
  handlers = new Map();
  addEventListener(type, listener, options) {
    super.addEventListener(type, listener, options);
    const set = this.handlers.get(type) ?? new Set();
    set.add(listener);
    this.handlers.set(type, set);
  }
  removeEventListener(type, listener, options) {
    super.removeEventListener(type, listener, options);
    this.handlers.get(type)?.delete(listener);
  }
  listeners() {
    return [...this.handlers.values()].reduce((n, set) => n + set.size, 0);
  }
}
class Node extends Target {
  children = [];
  parent = null;
  className = "";
  ownText = "";
  dataset = {};
  attributes = new Map();
  style = { setProperty() {} };
  hidden = false;
  open = false;
  constructor(tag) {
    super();
    this.tagName = tag;
    const values = new Set();
    this.classList = {
      add: (v) => values.add(v),
      remove: (v) => values.delete(v),
      contains: (v) => values.has(v),
      toggle: (v, force) => {
        const on = force ?? !values.has(v);
        if (on) values.add(v);
        else values.delete(v);
        return on;
      },
    };
  }
  set textContent(value) {
    this.ownText = String(value);
    this.children = [];
  }
  get textContent() {
    return this.ownText + this.children.map((n) => n.textContent).join(" ");
  }
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
  remove() {
    if (this.parent) this.parent.children = this.parent.children.filter((n) => n !== this);
    this.parent = null;
  }
  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }
  getAttribute(name) {
    return this.attributes.get(name) ?? null;
  }
  matches(selector) {
    if (selector.includes(","))
      return selector.split(",").some((part) => this.matches(part.trim()));
    return selector.startsWith(".")
      ? this.className.split(" ").includes(selector.slice(1))
      : this.tagName === selector;
  }
  querySelector(selector) {
    for (const child of this.children) {
      if (child.matches(selector)) return child;
      const nested = child.querySelector(selector);
      if (nested) return nested;
    }
    return null;
  }
  closest(selector) {
    return this.matches(selector) ? this : (this.parent?.closest(selector) ?? null);
  }
  contains(node) {
    return node === this || this.children.some((child) => child.contains(node));
  }
  getBoundingClientRect() {
    return { left: 20, top: 80, right: 160, bottom: 240, width: 140, height: 160 };
  }
  showModal() {
    this.open = true;
  }
  close() {
    this.open = false;
  }
  focus() {
    document.activeElement = this;
  }
}
class Button extends Node {
  constructor() {
    super("button");
  }
}
class Input extends Node {
  value = "";
  constructor() {
    super("input");
  }
  select() {}
}
globalThis.Element = Node;
globalThis.HTMLButtonElement = Button;
globalThis.HTMLInputElement = Input;
globalThis.HTMLTextAreaElement = class extends Node {};
globalThis.document = {
  body: new Node("body"),
  fonts: { ready: Promise.resolve() },
  activeElement: null,
  createElement: (tag) =>
    tag === "button" ? new Button() : tag === "input" ? new Input() : new Node(tag),
  createTextNode: (text) => {
    const n = new Node("#text");
    n.textContent = text;
    return n;
  },
};
const win = new Target();
win.innerWidth = 390;
win.innerHeight = 844;
win.matchMedia = (query) => ({ matches: query.includes("pointer") ? coarse : false });
globalThis.window = win;
let currentUrl = new URL("http://localhost:5190/?offline=1");
Object.defineProperty(globalThis, "location", { configurable: true, get: () => currentUrl });
globalThis.history = {
  replaceState: (_data, _unused, url) => {
    currentUrl = new URL(url);
  },
};
const observers = new Set();
class Observer {
  observed = new Set();
  constructor(callback) {
    this.callback = callback;
    observers.add(this);
  }
  observe(node) {
    this.observed.add(node);
  }
  disconnect() {
    this.observed.clear();
    observers.delete(this);
  }
}
globalThis.ResizeObserver = Observer;
let pads = 0;
class Pad {
  edges = new Set();
  constructor() {
    pads++;
  }
  update() {}
  justPressed(key) {
    const edge = this.edges.has(key);
    this.edges.delete(key);
    return edge;
  }
  destroy() {
    pads--;
  }
}
class Display {
  visible = true;
  scaleY = 1;
  setOrigin() {
    return this;
  }
  setTint() {
    return this;
  }
  setAlpha() {
    return this;
  }
  setStrokeStyle() {
    return this;
  }
  play() {
    return this;
  }
  setPosition(x, y) {
    this.x = x;
    this.y = y;
    return this;
  }
  setScale(value) {
    this.scaleY = value;
    return this;
  }
  setVisible(value) {
    this.visible = value;
    return this;
  }
  setSize() {
    return this;
  }
  setColor() {
    return this;
  }
  setDisplaySize() {
    return this;
  }
}
class Scene {
  events = new Emitter();
  input = { keyboard: new Emitter() };
  sys = { settings: { data: {} } };
  registry = new Map();
  starts = [];
  scaleCalls = [];
  scene = { start: (key, data) => this.starts.push({ key, data }) };
  scale = {
    width: BASE_W,
    height: BASE_H,
    setGameSize: (w, h) => {
      this.scaleCalls.push([w, h]);
      this.scale.width = w;
      this.scale.height = h;
    },
  };
  add = {
    image: () => new Display(),
    rectangle: () => new Display(),
    ellipse: () => new Display(),
    text: () => new Display(),
    sprite: () => new Display(),
  };
}
let notifications = 0;
const audio = new Map();
const sfx = Object.fromEntries(
  ["unlock", "select", "pickup", "hurt", "door"].map((key) => [
    key,
    () => audio.set(key, (audio.get(key) ?? 0) + 1),
  ]),
);
function loadClass(name, file, bindings) {
  const source = readFileSync(resolve(base, file), "utf8").replace(/^import[\s\S]*?;\n/gm, "");
  const js = stripTypeScriptTypes(source, { mode: "transform" }).replaceAll(
    "export class ",
    "class ",
  );
  return new Function(...Object.keys(bindings), js + `\nreturn ${name};`)(
    ...Object.values(bindings),
  );
}
const HubView = loadClass("HubView", "src/hub/hub-view.ts", {
  controlGroups,
  sealPointerEvents,
  CONTROLS,
  HERO_ORDER,
  HEROES,
  ...meta,
});
const SelectScene = loadClass("SelectScene", "src/scenes/select-scene.ts", {
  Phaser: { Scene, Scenes: { Events: { SHUTDOWN: "shutdown", DESTROY: "destroy" } } },
  notifyGameStarted: () => notifications++,
  watchControlContext,
  PhysicalGamepad: Pad,
  sfx,
  BASE_W,
  BASE_H,
  HERO_ORIGIN_Y,
  firstFrame: () => undefined,
  HERO_ORDER,
  HEROES,
  readRunRecap,
  parseRoomCode,
  partyLink,
  ...meta,
  HubView,
  isCoarse: () => coarse,
});
let groups = 0;
function check(name, body) {
  body();
  groups++;
  console.log(`PASS ${name}`);
}
function resetMeta(shards = 0) {
  memory.clear();
  meta.saveMeta({ shards, unlocked: ["axion", "reaper"], bestDepth: 0, runs: 0, upgrades: {} });
}
function start(data = {}) {
  const scene = new SelectScene();
  scene.init(data);
  scene.create();
  return scene;
}
function stop(scene, event = "shutdown") {
  scene.events.emit(event);
}
const click = (node) => node.dispatchEvent(new Event("click", { bubbles: true, cancelable: true }));
function key(scene, target, code, key) {
  const event = new Event("keydown", { bubbles: true, cancelable: true });
  Object.defineProperties(event, { code: { value: code }, key: { value: key } });
  target.dispatchEvent(event);
  scene.keyDown(event);
  return event;
}
const banked = {
  kind: "banked",
  hero: "axion",
  biome: 2,
  depth: 3,
  gold: 27,
  score: 1510,
  shardsEarned: 18,
  bestScore: 1900,
};

check(
  "receipt consumes scene data, copies primitives, never banks again or fabricates guest rewards",
  () => {
    resetMeta(50);
    const original = meta.loadMeta();
    const data = { recap: { ...banked } };
    const scene = start(data);
    assert.deepEqual(scene.sys.settings.data, {});
    data.recap.gold = 999;
    assert.equal(scene.recap.gold, 27);
    assert.match(scene.view.root.textContent, /GOLD 27/);
    assert.match(scene.view.root.textContent, /\+18 ✦/);
    assert.deepEqual(meta.loadMeta(), original);
    stop(scene);
    scene.init(scene.sys.settings.data);
    scene.create();
    assert.equal(scene.recap, null);
    assert.equal(scene.view.root.querySelector(".lf-hub-receipt"), null);
    stop(scene);
    const guest = start({
      recap: {
        kind: "coop-guest",
        hero: "reaper",
        biome: 4,
        depth: 1,
        gold: 0,
        score: 99,
        shardsEarned: 99,
        bestScore: 99,
      },
    });
    const receipt = guest.view.root.querySelector(".lf-hub-receipt");
    assert.match(receipt.textContent, /CO-OP DESCENT/);
    assert.doesNotMatch(receipt.textContent, /SCORE|BEST|SHARDS/);
    stop(guest);
    for (const recap of [null, {}, { ...banked, bestScore: 1 }, { ...banked, gold: -1 }]) {
      const invalid = start({ recap });
      assert.equal(invalid.recap, null);
      assert.deepEqual(invalid.sys.settings.data, {});
      stop(invalid);
    }
  },
);

check(
  "actual hero button selection and explicit unlock retain separate spend/start boundaries",
  () => {
    resetMeta(80);
    const scene = start();
    const view = scene.view;
    assert.equal(scene.starts.length, 0);
    assert.equal(meta.loadMeta().shards, 80);
    click(view.heroes[2]);
    assert.equal(scene.index, 2);
    assert.equal(scene.starts.length, 0);
    assert.equal(meta.loadMeta().shards, 80);
    click(view.heroes[2]);
    assert.equal(scene.starts.length, 0);
    assert.equal(meta.isUnlocked(scene.meta, "riven"), false);
    scene.confirm();
    assert.equal(meta.loadMeta().shards, 80); // keyboard/pad confirm refuses locked hero.
    click(view.go);
    assert.equal(meta.loadMeta().shards, 60);
    assert.ok(meta.isUnlocked(scene.meta, "riven"));
    assert.equal(scene.starts.length, 0);
    click(view.go);
    assert.deepEqual(scene.starts, [{ key: "game", data: { hero: "riven" } }]);
    assert.equal(meta.loadMeta().shards, 60);
    assert.equal(scene.registry.get("hero"), "riven");
    stop(scene);
    resetMeta(0);
    const poor = start();
    click(poor.view.heroes[4]);
    click(poor.view.go);
    assert.equal(poor.starts.length, 0);
    assert.equal(meta.loadMeta().shards, 0);
    assert.equal(meta.isUnlocked(poor.meta, "salamander"), false);
    stop(poor);
  },
);

check("all five heroes and keyboard/pad routes select without implicit action", () => {
  resetMeta(0);
  const scene = start();
  for (let i = 1; i < HERO_ORDER.length; i++) {
    click(scene.view.heroes[i]);
    assert.equal(scene.index, i);
    assert.equal(scene.starts.length, 0);
  }
  scene.move(1);
  assert.equal(scene.index, 0);
  scene.move(-1);
  assert.equal(scene.index, 4);
  scene.pad.edges.add("right");
  scene.update(100);
  assert.equal(scene.index, 0);
  scene.pad.edges.add("a");
  scene.update(116);
  assert.equal(scene.starts.length, 1);
  stop(scene);
});

check(
  "forge buttons select before buying; actual prices, caps and insufficient funds persist",
  () => {
    resetMeta(100);
    const scene = start();
    click(scene.view.forge);
    assert.equal(scene.shopOpen, true);
    assert.ok(scene.view.dialog.open);
    const index = 1;
    const up = meta.UPGRADES[index];
    const rows = scene.view.rows;
    click(rows[index]);
    assert.equal(scene.shopIndex, index);
    assert.equal(meta.loadMeta().shards, 100);
    click(rows[index]);
    assert.equal(meta.upgradeLevel(meta.loadMeta(), up.id), 1);
    assert.equal(meta.loadMeta().shards, 100 - up.cost(0));
    const before = scene.meta.shards;
    click(scene.view.heroes[3]);
    click(scene.view.coop);
    assert.equal(scene.index, 0);
    assert.equal(scene.net, "off");
    assert.equal(scene.meta.shards, before);
    scene.meta.upgrades[up.id] = up.max;
    scene.refresh();
    click(rows[index]);
    assert.equal(scene.meta.shards, before);
    assert.equal(scene.meta.upgrades[up.id], up.max);
    scene.meta.upgrades[up.id] = 0;
    scene.meta.shards = 0;
    scene.refresh();
    click(rows[index]);
    assert.equal(scene.meta.upgrades[up.id], 0);
    click(scene.view.dialog.querySelector("button"));
    assert.equal(scene.shopOpen, false);
    assert.equal(scene.view.dialog.open, false);
    assert.equal(document.activeElement, scene.view.forge);
    assert.equal(scene.starts.length, 0);
    stop(scene);
  },
);

check(
  "focused native button keydown leaves activation to click and never confirms through Phaser",
  () => {
    resetMeta(100);
    const scene = start();
    for (const [code, letter] of [
      ["Enter", "Enter"],
      ["Space", " "],
    ]) {
      const forge = scene.view.forge;
      const event = key(scene, forge, code, letter);
      assert.equal(event.defaultPrevented, false);
      assert.equal(scene.shopOpen, false);
      assert.equal(scene.starts.length, 0);
      // The real root handler contains propagation without cancelling the native
      // default. Dispatch its registered listener with the same target event.
      for (const handler of scene.view.root.handlers.get("keydown") ?? []) handler(event);
      assert.equal(event.cancelBubble, true);
      click(forge);
      assert.equal(scene.shopOpen, true);
      click(scene.view.dialog.querySelector("button"));
    }
    const go = scene.view.go;
    key(scene, go, "Enter", "Enter");
    assert.equal(scene.starts.length, 0);
    click(go);
    assert.equal(scene.starts.length, 1);
    assert.equal(notifications > 0, true);
    stop(scene);
  },
);

check(
  "real pointer seal preserves child-button touch click and contains background dismissal",
  () => {
    resetMeta();
    const scene = start();
    const root = scene.view.root;
    const child = scene.view.heroes[1].children[0];
    for (const [target, prevented] of [
      [child, false],
      [root, true],
    ]) {
      const event = new Event("touchend", { cancelable: true, bubbles: true });
      target.dispatchEvent(event);
      if (target !== root)
        for (const handler of root.handlers.get("touchend") ?? []) handler(event);
      assert.equal(event.defaultPrevented, prevented);
      assert.equal(event.cancelBubble, true);
    }
    click(scene.view.heroes[1]);
    assert.equal(scene.index, 1);
    assert.equal(scene.starts.length, 0);
    stop(scene);
  },
);

check("dialog opening and arrow/pad navigation restore the intended keyboard owner", () => {
  resetMeta(100);
  const scene = start();
  click(scene.view.forge);
  assert.equal(document.activeElement, scene.view.dialog);
  key(scene, document.activeElement, "Enter", "Enter");
  assert.equal(meta.upgradeLevel(meta.loadMeta(), "vitality"), 1);
  assert.equal(meta.loadMeta().shards, 70);
  assert.equal(scene.shopOpen, true);
  assert.equal(scene.starts.length, 0);
  scene.view.rows[2].focus();
  key(scene, document.activeElement, "ArrowDown", "ArrowDown");
  assert.equal(scene.shopIndex, 1);
  assert.equal(document.activeElement, scene.view.dialog);
  key(scene, document.activeElement, "Enter", "Enter");
  assert.equal(meta.upgradeLevel(meta.loadMeta(), "edge"), 1);
  click(scene.view.dialog.querySelector("button"));
  assert.equal(document.activeElement, scene.view.forge);
  key(scene, document.activeElement, "ArrowRight", "ArrowRight");
  assert.equal(scene.index, 1);
  assert.equal(document.activeElement, scene.view.root);
  assert.equal(scene.shopOpen, false);
  scene.view.coop.focus();
  scene.pad.edges.add("left");
  scene.update(100);
  assert.equal(scene.index, 0);
  assert.equal(document.activeElement, scene.view.root);
  key(scene, document.activeElement, "Enter", "Enter");
  assert.equal(scene.starts.length, 1);
  assert.equal(scene.shopOpen, false);
  stop(scene);
});

check(
  "online choices preserve code and clean invites without starting or restarting other rooms",
  () => {
    resetMeta();
    currentUrl = new URL("http://localhost:5190/?party=TEST&mode=vs");
    const scene = start({ recap: banked });
    assert.equal(scene.net, "vs");
    assert.equal(scene.code, "TEST");
    click(scene.view.coop);
    assert.equal(scene.code, "TEST");
    assert.equal(scene.net, "coop");
    assert.equal(currentUrl.searchParams.get("mode"), null);
    assert.equal(scene.starts.length, 0);
    click(scene.view.go);
    assert.equal(scene.registry.get("party"), "TEST");
    assert.equal(scene.registry.get("restartExpedition"), false);
    stop(scene);
    currentUrl = new URL("http://localhost:5190/?offline=1");
    const ordinary = start();
    click(ordinary.view.coop);
    const code = ordinary.code;
    assert.match(code, /^[A-Z2-9]{4}$/);
    assert.equal(currentUrl.searchParams.has("offline"), false);
    click(ordinary.view.versus);
    assert.equal(ordinary.code, code);
    assert.equal(currentUrl.searchParams.get("mode"), "vs");
    click(ordinary.view.versus);
    assert.equal(ordinary.net, "vs");
    assert.equal(ordinary.code, code);
    click(ordinary.view.solo);
    assert.equal(ordinary.net, "off");
    assert.equal(currentUrl.searchParams.has("party"), false);
    assert.equal(ordinary.starts.length, 0);
    stop(ordinary);
  },
);

check("room entry normalizes codes; invalid input and text shortcuts cannot start a run", () => {
  resetMeta();
  currentUrl = new URL("http://localhost:5190/?party=abcd&mode=vs&offline=1#preview");
  const scene = start();
  assert.equal(scene.code, "ABCD");
  assert.equal(currentUrl.href, "http://localhost:5190/?party=ABCD&mode=vs");
  const input = scene.view.root.querySelector("input");
  input.focus();
  for (const [code, letter] of [
    ["KeyC", "c"],
    ["KeyM", "m"],
    ["KeyJ", "j"],
    ["Enter", "Enter"],
  ])
    key(scene, input, code, letter);
  assert.equal(scene.net, "vs");
  assert.equal(scene.shopOpen, false);
  assert.equal(scene.starts.length, 0);
  scene.joinRoom("bad?");
  assert.equal(scene.code, "ABCD");
  scene.joinRoom(" ajcm ");
  assert.equal(scene.code, "AJCM");
  assert.equal(currentUrl.searchParams.get("party"), "AJCM");
  assert.equal(scene.starts.length, 0);
  scene.confirm();
  assert.equal(scene.registry.get("party"), "AJCM");
  assert.equal(scene.registry.get("mode"), "vs");
  stop(scene);
});

check("only the same co-op room can restart a retained recap", () => {
  resetMeta();
  currentUrl = new URL("http://localhost:5190/?party=ABCD");
  const same = start({ recap: banked });
  same.confirm();
  assert.equal(same.registry.get("restartExpedition"), true);
  stop(same);
  const different = start({ recap: banked });
  different.joinRoom("EFGH");
  different.confirm();
  assert.equal(different.registry.get("restartExpedition"), false);
  stop(different);
});

check(
  "refresh retains owned nodes; shutdown restores viewport once; final destroy never touches it",
  () => {
    resetMeta();
    const windowBaseline = win.listeners();
    for (let i = 0; i < 3; i++) {
      const scene = start({ recap: banked });
      const view = scene.view;
      const heroes = [...view.heroes];
      const receipt = view.root.querySelector(".lf-hub-receipt");
      const controls = [...view.controls.children];
      assert.equal(document.body.children.length, 1);
      assert.equal(observers.size, 1);
      assert.equal(pads, 1);
      for (let n = 0; n < 30; n++) {
        scene.refresh();
        assert.equal(scene.view, view);
        assert.equal(view.heroes[0], heroes[0]);
        assert.equal(view.root.querySelector(".lf-hub-receipt"), receipt);
        assert.equal(view.controls.children[0], controls[0]);
      }
      click(view.forge);
      click(view.dialog.querySelector("button"));
      assert.equal(view.root.querySelector(".lf-hub-receipt"), receipt);
      const before = scene.scaleCalls.length;
      stop(scene);
      assert.equal(scene.scaleCalls.length, before + 1);
      assert.deepEqual(scene.scaleCalls.at(-1), [BASE_W, BASE_H]);
      stop(scene, "destroy");
      assert.equal(scene.scaleCalls.length, before + 1);
      assert.equal(view.root.parent, null);
      assert.equal(observers.size, 0);
      assert.equal(pads, 0);
      assert.equal(win.listeners(), windowBaseline);
      assert.equal(scene.input.keyboard.listenerCount("keydown"), 0);
      assert.equal(
        scene.events.listenerCount("shutdown") + scene.events.listenerCount("destroy"),
        0,
      );
      assert.equal(document.body.classList.contains("lf-in-hub"), false);
      assert.equal(view.root.handlers.get("touchend")?.size, 0);
      assert.equal(scene.view, null);
      assert.equal(scene.recap, null);
    }
    const final = start();
    const before = final.scaleCalls.length;
    final.scale.setGameSize = () => {
      throw Error("viewport used after final destruction");
    };
    stop(final, "destroy");
    stop(final);
    assert.equal(final.scaleCalls.length, before);
    assert.equal(pads, 0);
    assert.equal(observers.size, 0);
    assert.equal(win.listeners(), windowBaseline);
  },
);
console.log(`${groups} hub integration groups passed`);
