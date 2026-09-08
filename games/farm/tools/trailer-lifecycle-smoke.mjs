import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { EventEmitter } from "node:events";
import { test } from "node:test";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const compile = (source) =>
  stripTypeScriptTypes(source, { mode: "transform" })
    .replace(/^import[\s\S]*?;\s*/gm, "")
    .replace(/^export /gm, "");
const settle = async () => {
  for (let i = 0; i < 16; i++) await Promise.resolve();
};

class Surface extends EventTarget {
  listeners = new Map();
  addEventListener(type, fn) {
    const set = this.listeners.get(type) ?? new Set();
    set.add(fn);
    this.listeners.set(type, set);
    super.addEventListener(type, fn);
  }
  removeEventListener(type, fn) {
    this.listeners.get(type)?.delete(fn);
    super.removeEventListener(type, fn);
  }
}
class Element {
  children = [];
  style = {};
  parent = null;
  appendChild(child) {
    this.children.push(child);
    child.parent = this;
    return child;
  }
  remove() {
    if (this.parent) this.parent.children = this.parent.children.filter((child) => child !== this);
    this.parent = null;
  }
}

function shellFixture({ setup = () => {}, loop = false } = {}) {
  const window = new Surface(),
    document = { head: new Element(), body: new Element(), createElement: () => new Element() };
  window.location = {
    search: loop ? "?trailer=1&loop=1" : "?trailer=1",
    href: "https://example.test/?trailer=1",
  };
  const timers = new Map(),
    frames = new Map(),
    calls = [],
    errors = [];
  let id = 0,
    now = 0;
  window.setTimeout = (fn, ms) => {
    timers.set(++id, { fn, ms });
    return id;
  };
  window.clearTimeout = (key) => timers.delete(key);
  const runTrailer = new Function(
    "window",
    "document",
    "performance",
    "requestAnimationFrame",
    "cancelAnimationFrame",
    "console",
    `${compile(read("../src/trailer/trailer-shell.ts"))}\nreturn runTrailer;`,
  )(
    window,
    document,
    { now: () => now },
    (fn) => {
      frames.set(++id, fn);
      return id;
    },
    (key) => frames.delete(key),
    { error: (...args) => errors.push(args) },
  );
  const release = runTrailer({
    onGesture: () => calls.push("gesture"),
    scenes: [
      {
        id: "farm",
        duration: 100,
        setup: () => {
          calls.push("setup");
          return setup();
        },
        run: () => calls.push("run"),
        teardown: () => calls.push("teardown"),
      },
    ],
  });
  const advance = async () => {
    const entry = timers.entries().next().value;
    assert.ok(entry, "expected an owned timer");
    const [key, timer] = entry;
    timers.delete(key);
    now += timer.ms;
    timer.fn();
    await settle();
  };
  return {
    window,
    document,
    timers,
    frames,
    calls,
    errors,
    release,
    advance,
    frame: async (ms) => {
      now += ms;
      const pending = [...frames.values()];
      frames.clear();
      pending.forEach((fn) => fn(now));
      await settle();
    },
  };
}

test("final owner clears lead-in, native listeners, DOM and only its own globals", async () => {
  const f = shellFixture();
  const queued = [...f.timers.values()].map((timer) => timer.fn),
    staleJump = f.window["__trailerJump"];
  assert.equal(f.window.listeners.get("keydown").size, 2);
  f.release();
  f.release();
  for (const fn of queued) fn();
  staleJump(0);
  await settle();
  assert.deepEqual(f.calls, []);
  assert.equal(f.timers.size, 0);
  assert.equal(f.frames.size, 0);
  assert.equal(f.window.listeners.get("keydown").size, 0);
  assert.equal(f.window.listeners.get("pointerdown").size, 0);
  assert.equal(f.document.body.children.length, 0);
  assert.equal(f.document.head.children.length, 0);
  assert.equal(f.window["__trailer"], undefined);
  assert.equal(f.window["__trailerJump"], undefined);
  const next = shellFixture(),
    state = {},
    jump = () => state;
  next.window["__trailer"] = state;
  next.window["__trailerJump"] = jump;
  next.release();
  assert.equal(next.window["__trailer"], state);
  assert.equal(next.window["__trailerJump"], jump);
});

test("destroy during setup, reveal or animation cancels without touching destroyed scene nodes", async () => {
  for (const phase of ["setup", "reveal", "animation"]) {
    let resolve;
    const pending = new Promise((done) => {
      resolve = done;
    });
    const f = shellFixture({ setup: () => (phase === "setup" ? pending : undefined) });
    await f.advance(); // original 600 ms lead-in
    await f.advance(); // original 40% cut
    if (phase === "animation") await f.advance(); // original 20% cut/reveal
    const stale = [...f.frames.values()];
    f.release();
    resolve();
    stale.forEach((fn) => fn(900));
    await settle();
    assert.deepEqual(f.calls, ["setup"]);
    assert.deepEqual(f.errors, []);
    assert.equal(f.timers.size, 0);
    assert.equal(f.frames.size, 0);
  }
});

test("ordinary choreography completes and final loop wait cannot restage after release", async () => {
  const f = shellFixture({ loop: true });
  await f.advance();
  await f.advance();
  await f.advance();
  await f.frame(100);
  assert.deepEqual(f.calls, ["setup", "run", "teardown"]);
  await f.advance(); // original 420 ms final cut
  assert.equal(f.window["__trailer"].done, true);
  assert.equal([...f.timers.values()][0].ms, 900);
  const stale = [...f.timers.values()][0].fn;
  f.release();
  stale();
  await settle();
  assert.deepEqual(f.calls, ["setup", "run", "teardown"]);
  assert.equal(f.timers.size, 0);
});

const director = read("../src/trailer/trailer-director.ts");
const entry = director.match(/^export function startTrailer\([^]*?^}/m)?.[0];
assert.ok(entry);
const sceneNames = [...entry.matchAll(/\b(scene\w+)\(game\)/g)].map((match) => match[1]);
const phaser = {
  Core: { Events: { DESTROY: "destroy" } },
  Scenes: { Events: { CREATE: "create", DESTROY: "destroy", SHUTDOWN: "shutdown" } },
};

test("actual director rejects a late destroyed-game import and binds live final shell ownership", () => {
  const calls = [],
    game = { events: new EventEmitter(), scene: {} },
    Sound = { muted: false, resume() {} };
  const start = new Function(
    "Phaser",
    "Sound",
    "enableTrailerStaging",
    "disableSaves",
    "runTrailer",
    "getGame",
    ...sceneNames,
    `${compile(entry)}\nreturn startTrailer;`,
  )(
    phaser,
    Sound,
    () => calls.push("staging"),
    () => calls.push("saves"),
    () => {
      calls.push("shell");
      return () => calls.push("release");
    },
    () => ({}),
    ...sceneNames.map((id) => () => ({ id, setup() {} })),
  );
  start(game);
  assert.deepEqual(calls, []);
  game.scene.game = game;
  start(game);
  assert.deepEqual(calls, ["staging", "saves", "shell"]);
  assert.equal(Sound.muted, true);
  game.scene.game = null;
  game.events.emit("destroy");
  game.events.emit("destroy");
  assert.equal(calls.filter((value) => value === "release").length, 1);
});

test("actual scene-ready promise releases both listeners on create or final destroy", async () => {
  const code = director.match(/^function sceneReady[^]*?^}/m)?.[0];
  assert.ok(code);
  const ready = new Function("Phaser", `${compile(code)}\nreturn sceneReady;`)(phaser);
  for (const event of ["create", "destroy"]) {
    const scene = { events: new EventEmitter() },
      promise = ready(scene);
    const assertion =
      event === "destroy" ? assert.rejects(promise, /destroyed before create/) : promise;
    scene.events.emit(event);
    assert.equal(scene.events.listenerCount("create"), 0);
    assert.equal(scene.events.listenerCount("destroy"), 0);
    await assertion;
  }
});

test("actual Boot lazy branches are inert after shutdown/destroy; live imports and normal title remain intact", async () => {
  const boot = read("../src/scenes/boot-scene.ts");
  const tail = boot.slice(
    boot.indexOf("    const params = new URLSearchParams"),
    boot.indexOf("\n  private makeIcon"),
  );
  const body = tail.slice(0, tail.lastIndexOf("\n  }"));
  for (const mode of ["trailer", "gallery", "normal"])
    for (const event of [null, "shutdown", "destroy"]) {
      const events = new EventEmitter(),
        calls = [];
      let resolve;
      const pending = new Promise((done) => {
        resolve = done;
      });
      const scene = {
        events,
        game: {},
        scene: { get: () => null, add: () => calls.push("add"), start: (key) => calls.push(key) },
      };
      const run = new Function(
        "window",
        "Phaser",
        "loadTrailer",
        "loadGallery",
        (compile(`function bootTail() {${body}}`) + "\nreturn bootTail;")
          .replace('import("../trailer/trailer-director")', "loadTrailer()")
          .replace('import("./gallery-scene")', "loadGallery()"),
      )(
        { location: { search: mode === "normal" ? "" : `?${mode}=1` } },
        phaser,
        () => pending,
        () => pending,
      );
      run.call(scene);
      if (event) {
        events.emit(event);
        Object.defineProperty(scene, "scene", {
          get() {
            throw new Error("destroyed ScenePlugin read");
          },
        });
      }
      resolve({
        startTrailer: () => calls.push("trailer"),
        GalleryScene: class {
          key = "Gallery";
        },
      });
      await settle();
      assert.deepEqual(
        calls,
        mode === "normal"
          ? ["Title"]
          : event
            ? []
            : mode === "trailer"
              ? ["trailer"]
              : ["add", "Gallery"],
      );
      if (event) {
        assert.equal(events.listenerCount("shutdown"), 0);
        assert.equal(events.listenerCount("destroy"), 0);
      }
    }
});
