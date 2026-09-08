import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import * as THREE from "three";
import * as constants from "../src/shared/constants.ts";
import * as spin from "../src/shared/spin.ts";
import * as contactShot from "../src/shared/contact-shot.ts";
import { ParticlePool } from "../src/fx/particles.ts";
import { RingPool } from "../src/fx/shock-rings.ts";
import { PhysicalGamepad } from "../../../packages/gamepad/src/physical.ts";

export function compile(path) {
  return stripTypeScriptTypes(readFileSync(new URL(path, import.meta.url), "utf8"))
    .replace(/^import[\s\S]*?;\s*/gm, "")
    .replace(/^export /gm, "");
}
class TrackedTarget extends EventTarget {
  listeners = new Map();
  addEventListener(name, fn, options) {
    if (!this.listeners.has(name)) this.listeners.set(name, new Set());
    this.listeners.get(name).add(fn);
    super.addEventListener(name, fn, options);
  }
  removeEventListener(name, fn, options) {
    this.listeners.get(name)?.delete(fn);
    super.removeEventListener(name, fn, options);
  }
  get listenerCount() {
    return [...this.listeners.values()].reduce((n, set) => n + set.size, 0);
  }
}
class Element extends TrackedTarget {
  textContent = "";
  hidden = false;
  dataset = {};
  disabled = false;
  style = { setProperty() {}, opacity: "" };
  attributes = new Map();
  classes = new Set();
  classList = {
    add: (...names) => names.forEach((name) => this.classes.add(name)),
    remove: (...names) => names.forEach((name) => this.classes.delete(name)),
    toggle: (name, on = !this.classes.has(name)) =>
      on ? this.classes.add(name) : this.classes.delete(name),
  };
  children = [];
  append(...children) {
    this.children.push(...children);
  }
  replaceChildren(...children) {
    this.children = children;
  }
  setAttribute(name, value) {
    this.attributes.set(name, value);
  }
  getAttribute(name) {
    return this.attributes.get(name) ?? null;
  }
  removeAttribute(name) {
    this.attributes.delete(name);
  }
  getContext() {
    return {
      createRadialGradient: () => ({ addColorStop() {} }),
      createLinearGradient: () => ({ addColorStop() {} }),
      fillRect() {},
    };
  }
}

/** Real GameScene/Three/pools; only DOM, transport and external subscriptions are collaborators. */
export function sceneFixture(sourcePath = "../src/scenes/game-scene.ts", extra = {}) {
  const window = new TrackedTarget(),
    media = new TrackedTarget(),
    elements = new Map(),
    sessions = [],
    sounds = [],
    startup = { calls: 0 },
    clock = { ms: 1000 };
  media.matches = false;
  window.innerWidth = 1280;
  window.innerHeight = 800;
  window.matchMedia = () => media;
  const document = {
    documentElement: new Element(),
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, new Element());
      return elements.get(id);
    },
    createElement: () => new Element(),
  };
  class NetSession {
    live = false;
    offline = false;
    isHost = false;
    other = null;
    sharedState = null;
    hostId = "a";
    playerId = "b";
    destroyed = 0;
    events = [];
    patches = [];
    constructor(options) {
      this.options = options;
      if (options.forceOffline) {
        this.live = true;
        this.offline = true;
        this.isHost = true;
      }
      sessions.push(this);
    }
    tick() {}
    otherPlayer() {
      return this.other;
    }
    destroy() {
      this.destroyed++;
    }
    sendEvent(...event) {
      this.events.push(event);
    }
    patchShared(patch) {
      this.patches.push(patch);
    }
    updateMyState(patch) {
      this.mine = patch;
    }
  }
  const dependencies = {
    THREE,
    ...constants,
    ...spin,
    ...contactShot,
    ParticlePool,
    RingPool,
    PhysicalGamepad,
    NetSession,
    window,
    document,
    performance: { now: () => clock.ms },
    notifyGameStarted() {
      startup.calls++;
    },
    sfx: Object.fromEntries(
      ["serve", "paddleHit", "wall", "score", "win"].map((name) => [
        name,
        (...args) => sounds.push([name, ...args]),
      ]),
    ),
    ...extra,
    isJsonNumber: Number.isFinite,
    isJsonObject: (value) => Object.prototype.toString.call(value) === "[object Object]",
  };
  const Game = new Function(
    ...Object.keys(dependencies),
    `${compile(sourcePath)};return GameScene;`,
  )(...Object.values(dependencies));
  const game = new Game();
  return { game, window, media, elements, sessions, sounds, startup, clock };
}
