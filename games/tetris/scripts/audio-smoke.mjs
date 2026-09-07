import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import test from "node:test";

const current = readFileSync(new URL("../src/fx/sfx.ts", import.meta.url), "utf8");
const settle = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};
class Param {
  value = 1;
  events = [];
  setValueAtTime(value, time) {
    this.value = value;
    this.events.push(["set", value, time]);
  }
  exponentialRampToValueAtTime(value, time) {
    assert.ok(value > 0 && Number.isFinite(value));
    this.events.push(["exp", value, time]);
  }
  cancelScheduledValues(time) {
    this.events.push(["cancel", time]);
  }
}
class AudioNode {
  disconnected = 0;
  connected = [];
  connect(node) {
    this.connected.push(node);
    return node;
  }
  disconnect() {
    this.disconnected++;
  }
}
function setup({
  enabled = false,
  initialState = "running",
  delayed = false,
  storageBlocked = false,
  unsupported = false,
  source = current,
} = {}) {
  const contexts = [],
    preferences = new Map(enabled ? [["tetris:sound", "1"]] : []);
  const intent = { active: false, failStart: false, failMaster: false };
  let randomCount = 0;
  class Context {
    state = initialState;
    currentTime = 10;
    destination = {};
    oscillators = [];
    gains = [];
    operations = [];
    closes = 0;
    constructor() {
      contexts.push(this);
    }
    createGain() {
      if (intent.failMaster) throw new Error("device unavailable");
      const node = new AudioNode();
      node.gain = new Param();
      this.gains.push(node);
      return node;
    }
    createOscillator() {
      const node = new AudioNode();
      node.frequency = new Param();
      node.type = "sine";
      node.endedCallback = null;
      node.addEventListener = (type, callback) => {
        node.endedCallback = callback;
      };
      node.removeEventListener = (type, callback) => {
        if (node.endedCallback === callback) node.endedCallback = null;
      };
      node.starts = [];
      node.stops = [];
      node.start = (at) => {
        if (intent.failStart) throw new Error("failed start");
        node.starts.push(at);
      };
      node.stop = (at) => {
        if (node.starts.length === 0) throw new Error("not started");
        node.stops.push(at);
      };
      node.end = () => node.endedCallback?.();
      this.oscillators.push(node);
      return node;
    }
    transition(kind) {
      if (!delayed) {
        this.state = kind === "resume" ? "running" : "suspended";
        return Promise.resolve();
      }
      return new Promise((resolve, reject) =>
        this.operations.push({
          kind,
          finish: () => {
            this.state = kind === "resume" ? "running" : "suspended";
            resolve();
          },
          reject,
        }),
      );
    }
    resume() {
      return this.transition("resume");
    }
    suspend() {
      return this.transition("suspend");
    }
    close() {
      this.closes++;
      this.state = "closed";
      return Promise.resolve();
    }
  }
  const window = {
    localStorage: {
      getItem: (key) => {
        if (storageBlocked) throw new Error("blocked");
        return preferences.get(key) ?? null;
      },
      setItem: (key, value) => {
        if (storageBlocked) throw new Error("blocked");
        preferences.set(key, value);
      },
    },
  };
  if (!unsupported) window.AudioContext = Context;
  const deps = {
    window,
    AudioContext: Context,
    globalThis: {
      navigator: {
        userActivation: {
          get isActive() {
            return intent.active;
          },
        },
      },
    },
    Math: Object.assign(Object.create(Math), {
      random: () => ((randomCount++ * 29 + 7) % 101) / 101,
    }),
  };
  const exports = [...source.matchAll(/^export (?:function|const) (\w+)/gm)].map(
    (match) => match[1],
  );
  const code = stripTypeScriptTypes(source).replace(/^export /gm, "");
  const mod = new Function(...Object.keys(deps), `${code};return {${exports.join(",")}};`)(
    ...Object.values(deps),
  );
  return { mod, contexts, intent, preferences, randomCount: () => randomCount };
}
const playCatch = (mod) => {
  const cue = mod.sfx.catch;
  cue();
};
const owned = (mod) => mod.soundDiagnostics().ownedSources;
const recipes = (ac) =>
  ac.oscillators.map((node) => ({
    type: node.type,
    frequency: node.frequency.events,
    gain: node.connected[0].gain.events,
    starts: node.starts,
    stops: node.stops,
  }));

test("muted allocation stays zero; blocked storage retains live intent and paused native unlock stays silent", async () => {
  const h = setup({ storageBlocked: true });
  playCatch(h.mod);
  h.mod.setSoundPaused(true);
  h.mod.setMuted(false);
  h.mod.sfx.gameOver();
  assert.equal(h.contexts.length, 0);
  assert.equal(h.mod.isMuted(), false);
  h.intent.active = true;
  h.mod.setMuted(false);
  await settle();
  assert.equal(h.contexts.length, 1);
  assert.equal(h.contexts[0].state, "suspended");
  assert.equal(owned(h.mod), 0);
  assert.equal(h.mod.soundDiagnostics().masterGain, 0);
  h.intent.active = false;
  h.mod.setSoundPaused(false);
  await settle();
  h.mod.sfx.move();
  assert.equal(owned(h.mod), 1);
  assert.equal(h.contexts[0].state, "running");
  h.mod.setMuted(true);
  assert.equal(owned(h.mod), 0);
  h.mod.disposeSound();
  const unavailable = setup({ enabled: true, unsupported: true });
  playCatch(unavailable.mod);
  assert.equal(unavailable.contexts.length, 0);
});

test("whole catch/loss/power phrases fit the original 24/16 caps and reserve", () => {
  const { mod, contexts } = setup({ enabled: true });
  for (let i = 0; i < 100; i++) mod.sfx.move();
  assert.equal(owned(mod), 16);
  assert.equal(contexts[0].oscillators.length, 16);
  playCatch(mod);
  mod.sfx.gameOver();
  assert.equal(owned(mod), 24);
  const essential = contexts[0].oscillators.slice(16);
  playCatch(mod);
  assert.equal(owned(mod), 24);
  assert.equal(mod.soundDiagnostics().routineSources, 12);
  assert.ok(essential.every((node) => node.disconnected === 0));
  for (let i = 0; i < 12; i++) mod.sfx.gameOver();
  assert.equal(owned(mod), 24);
  assert.equal(mod.soundDiagnostics().phrases, 6);
  const previous = contexts[0].oscillators.length;
  mod.sfx.power();
  assert.equal(owned(mod), 23);
  assert.equal(contexts[0].oscillators.length, previous + 3);
  assert.ok(contexts[0].oscillators.slice(-3).every((node) => node.disconnected === 0));
  assert.equal(mod.soundDiagnostics().peakSources, 24);
  mod.disposeSound();
  assert.equal(owned(mod), 0);
});

test("mute, pause and run reset cancel future notes; natural and stale ended release once", async () => {
  for (const cancel of [
    (mod) => mod.setMuted(true),
    (mod) => mod.setSoundPaused(true),
    (mod) => mod.resetSound(),
  ]) {
    const { mod, contexts } = setup({ enabled: true });
    playCatch(mod);
    assert.equal(mod.soundDiagnostics().scheduledSources, 3);
    const ac = contexts[0],
      callbacks = ac.oscillators.map((node) => node.endedCallback);
    ac.oscillators[0].end();
    callbacks[0]();
    assert.equal(owned(mod), 3);
    cancel(mod);
    await settle();
    callbacks.forEach((callback) => callback());
    assert.equal(owned(mod), 0);
    assert.equal(mod.soundDiagnostics().phrases, 0);
    assert.equal(mod.soundDiagnostics().endedSources, 1);
    assert.equal(mod.soundDiagnostics().stoppedSources, 3);
    for (const node of ac.oscillators) {
      assert.equal(node.disconnected, 1);
      assert.equal(node.connected[0].disconnected, 1);
    }
    assert.equal(Object.isFrozen(mod.soundDiagnostics()), true);
    mod.disposeSound();
  }
});

test("late resume/suspend success or rejection cannot revive a final audio owner", async () => {
  for (const finish of ["finish", "reject"]) {
    for (const phase of ["resume", "suspend"]) {
      const { mod, contexts } = setup({
        enabled: true,
        initialState: phase === "resume" ? "suspended" : "running",
        delayed: true,
      });
      playCatch(mod);
      const ac = contexts[0];
      if (phase === "suspend") mod.setSoundPaused(true);
      assert.equal(ac.operations.length, 1);
      const pending = ac.operations.shift();
      mod.disposeSound();
      const snapshot = mod.soundDiagnostics();
      assert.equal(snapshot.disposed, true);
      assert.equal(snapshot.ownedSources, 0);
      assert.equal(snapshot.scheduledSources, 0);
      pending[finish](new Error("late operation"));
      await settle();
      mod.setMuted(false);
      mod.toggleMute();
      mod.setSoundPaused(false);
      mod.resetSound();
      mod.sfx.power();
      mod.disposeSound();
      assert.deepEqual(mod.soundDiagnostics(), snapshot);
      assert.equal(contexts.length, 1);
      assert.equal(ac.closes, 1);
      assert.equal(ac.operations.length, 0);
      assert.equal(ac.gains[0].disconnected, 1);
      assert.ok(
        ac.oscillators.every(
          (node) => node.disconnected === 1 && node.connected[0].disconnected === 1,
        ),
      );
    }
  }
});

test("current pause intent wins a pending unlock; rejection waits for a new gesture", async () => {
  const { mod, contexts } = setup({ enabled: true, initialState: "suspended", delayed: true });
  playCatch(mod);
  const ac = contexts[0];
  assert.equal(ac.operations.length, 1);
  mod.setSoundPaused(true);
  ac.operations.shift().finish();
  await settle();
  assert.equal(ac.operations[0].kind, "suspend");
  assert.equal(owned(mod), 0);
  ac.operations.shift().finish();
  await settle();
  mod.setSoundPaused(false);
  ac.operations.shift().reject(new Error("gesture needed"));
  await settle();
  assert.equal(ac.operations.length, 0);
  assert.equal(owned(mod), 0);
  mod.setMuted(false);
  ac.operations.shift().finish();
  await settle();
  playCatch(mod);
  assert.equal(owned(mod), 4);
  mod.disposeSound();
});

test("partial context and failed source starts still release their owned graphs", () => {
  const h = setup();
  h.intent.failMaster = true;
  h.mod.setMuted(false);
  assert.equal(h.contexts[0].closes, 1);
  assert.equal(owned(h.mod), 0);
  h.intent.failMaster = false;
  h.intent.failStart = true;
  h.mod.sfx.move();
  const ac = h.contexts[1];
  assert.equal(owned(h.mod), 0);
  assert.equal(ac.oscillators[0].disconnected, 1);
  assert.equal(ac.oscillators[0].connected[0].disconnected, 1);
  h.mod.disposeSound();
  assert.equal(ac.closes, 1);
});

function recipeTrace(source) {
  const result = [];
  for (const [name, args] of [
    ["move", []],
    ["rotate", []],
    ["orbit", []],
    ["lock", []],
    ["hardDrop", []],
    ["clear", [1]],
    ["clear", [5]],
    ["clear", [12]],
    ["clear", [4, true]],
    ["power", []],
    ["catch", []],
    ["gameOver", []],
  ]) {
    const h = setup({ enabled: true, source });
    h.mod.sfx[name](...args);
    result.push({ name, args, notes: recipes(h.contexts[0]), randomCount: h.randomCount() });
  }
  return result;
}
test("all original note recipes, jitter draws, gains and sample-clock offsets stay exact", () => {
  const actual = recipeTrace(current);
  if (process.env.TETRIS_AUDIO_BASELINE)
    assert.deepEqual(actual, recipeTrace(readFileSync(process.env.TETRIS_AUDIO_BASELINE, "utf8")));
  const digest = createHash("sha256").update(JSON.stringify(actual)).digest("hex");
  // Pinned after full equality against the immutable pre-completion source.
  assert.equal(digest, "f2667438bdbc815f5246663c8bf1416f2a2d6dbb4743525e89fa51fb379ed457");
});
