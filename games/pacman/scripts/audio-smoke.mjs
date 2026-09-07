import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { stripTypeScriptTypes } from "node:module";
import test from "node:test";

const current = readFileSync(new URL("../src/audio/sfx.ts", import.meta.url), "utf8");
const settle = async () => {
  for (let i = 0; i < 6; i++) await Promise.resolve();
};
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
class Param {
  value = 1;
  events = [];
  cancelScheduledValues(at) {
    this.events.push(["cancel", at]);
  }
  setValueAtTime(value, at) {
    this.value = value;
    this.events.push(["set", value, at]);
  }
  linearRampToValueAtTime(value, at) {
    this.events.push(["linear", value, at]);
  }
}
class Node extends EventTarget {
  connections = [];
  disconnected = 0;
  connect(node) {
    this.connections.push(node);
    return node;
  }
  disconnect() {
    this.disconnected++;
  }
}
function harness(options = {}, source = current) {
  const contexts = [],
    media = [];
  let now = 1000,
    randomCalls = 0,
    rng = 1751;
  const math = Object.create(Math);
  math.random = () => {
    randomCalls++;
    rng = (Math.imul(rng, 1664525) + 1013904223) >>> 0;
    return rng / 0x100000000;
  };
  const config = {
    contextState: "running",
    delayedContext: false,
    blockedStorage: false,
    sound: true,
    play: "ok",
    ...options,
  };
  class Context {
    state = config.contextState;
    currentTime = 2;
    destination = {};
    gains = [];
    sources = [];
    buffers = [];
    operations = [];
    closes = 0;
    constructor() {
      contexts.push(this);
    }
    createGain() {
      const node = new Node();
      node.gain = new Param();
      this.gains.push(node);
      return node;
    }
    createBuffer(channels, frames, rate) {
      assert.equal(channels, 1);
      assert.equal(rate, 44100);
      const buffer = {
        data: new Float32Array(frames),
        getChannelData() {
          return this.data;
        },
      };
      this.buffers.push(buffer);
      return buffer;
    }
    createBufferSource() {
      const node = new Node();
      node.playbackRate = new Param();
      node.starts = 0;
      node.stops = 0;
      node.start = () => node.starts++;
      node.stop = () => node.stops++;
      node.end = () => node.dispatchEvent(new Event("ended"));
      this.sources.push(node);
      return node;
    }
    transition(kind) {
      const finish = () => {
        if (this.state !== "closed") this.state = kind === "resume" ? "running" : "suspended";
      };
      if (!config.delayedContext) {
        finish();
        return Promise.resolve();
      }
      const pending = deferred();
      this.operations.push({
        kind,
        finish: () => {
          finish();
          pending.resolve();
        },
        reject: pending.reject,
      });
      return pending.promise;
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
  class Audio extends EventTarget {
    paused = true;
    ended = false;
    playbackRate = 1;
    volume = 1;
    plays = 0;
    pauses = 0;
    loads = 0;
    operations = [];
    constructor(url) {
      super();
      this.src = url;
      media.push(this);
    }
    play() {
      this.plays++;
      if (config.play === "denied") return Promise.reject(new Error("NotAllowedError"));
      if (config.play === "pending") {
        const pending = deferred();
        this.operations.push(pending);
        return pending.promise;
      }
      this.paused = false;
      return Promise.resolve();
    }
    pause() {
      this.paused = true;
      this.pauses++;
    }
    removeAttribute(name) {
      assert.equal(name, "src");
      this.src = "";
    }
    load() {
      this.loads++;
    }
  }
  const preferences = new Map(config.sound ? [["pacman:sound", "1"]] : []);
  const storage = {
    getItem: (key) => {
      if (config.blockedStorage) throw new Error("blocked");
      return preferences.get(key) ?? null;
    },
    setItem: (key, value) => {
      if (config.blockedStorage) throw new Error("blocked");
      preferences.set(key, value);
    },
  };
  const deps = {
    window: { localStorage: storage, AudioContext: Context },
    AudioContext: Context,
    Audio,
    Math: math,
    performance: { now: () => now },
  };
  const code = source.replaceAll("export ", "");
  const mod = new Function(
    "deps",
    `${stripTypeScriptTypes(`const {${Object.keys(deps).join(",")}}=deps;\n${code}`, { mode: "strip" })};return {sfx,music,unlockAudio,isSoundOn,${source === current ? "setAudioPaused,resetAudio,disposeAudio,audioDiagnostics," : ""}};`,
  )(deps);
  return {
    mod,
    contexts,
    media,
    config,
    preferences,
    randomCalls: () => randomCalls,
    now: (value) => {
      now = value;
    },
  };
}
const voices = (h) => h.mod.sfx.diagnostics().ownedSources;
const names = [
  "chomp",
  "pellet",
  "power",
  "ghost_eaten",
  "caught",
  "ready",
  "win",
  "gameover",
  "bump",
  "turn",
  "warn",
];
function recipes(h) {
  h.mod.sfx.unlock();
  for (const name of names) h.mod.sfx.play(name, { gain: 0.7, rate: 1.1 });
  const ctx = h.contexts[0];
  return {
    bufferHashes: ctx.buffers.map((b) =>
      createHash("sha256").update(new Uint8Array(b.data.buffer)).digest("hex"),
    ),
    plays: ctx.sources.map((s) => ({
      rate: s.playbackRate.value,
      gain: s.connections[0].gain.value,
      caughtBypass: s.connections[0].connections[0] === ctx.gains[0],
    })),
    randomCalls: h.randomCalls(),
    duck: ctx.gains[1].gain.events,
  };
}

test("muted allocation is zero; blocked storage retains live toggle and paused native unlock", async () => {
  const h = harness({ blockedStorage: true });
  h.mod.unlockAudio();
  h.mod.sfx.play("caught");
  assert.equal(h.contexts.length, 0);
  assert.equal(h.media.length, 0);
  assert.equal(h.mod.isSoundOn(), false);
  h.mod.setAudioPaused(true);
  const on = h.mod.music.toggle();
  h.mod.sfx.setEnabled(on);
  h.mod.unlockAudio();
  await settle();
  assert.equal(on, true);
  assert.equal(h.mod.isSoundOn(), true);
  assert.equal(h.contexts.length, 1);
  assert.equal(voices(h), 0);
  assert.equal(h.media[0].volume, 0);
  assert.equal(h.media[0].paused, true);
  h.mod.sfx.play("win");
  assert.equal(h.contexts[0].sources.length, 0);
  h.mod.setAudioPaused(false);
  await settle();
  h.mod.sfx.play("pellet");
  assert.equal(voices(h), 1);
  assert.equal(h.media[0].paused, false);
  h.mod.disposeAudio();
});
test("routine and full-buffer essential admission stay within24/16 and preserve new outcomes", () => {
  const h = harness();
  h.mod.sfx.unlock();
  for (let i = 0; i < 100; i++) h.mod.sfx.play("pellet");
  assert.equal(voices(h), 16);
  assert.equal(h.contexts[0].sources.length, 16);
  for (let i = 0; i < 8; i++) h.mod.sfx.play("warn");
  assert.equal(voices(h), 24);
  h.mod.sfx.play("caught");
  assert.equal(voices(h), 24);
  assert.equal(h.contexts[0].sources[0].stops, 1);
  for (let i = 0; i < 100; i++) h.mod.sfx.play("win");
  assert.equal(voices(h), 24);
  assert.equal(h.mod.sfx.diagnostics().routineSources, 0);
  assert.equal(h.contexts[0].sources.at(-1).disconnected, 0);
  h.mod.resetAudio();
  assert.equal(voices(h), 0);
  for (const source of h.contexts[0].sources) {
    assert.equal(source.disconnected, 1);
    assert.equal(source.connections[0].disconnected, 1);
  }
});
test("mute/pause/reset/final disposal cancel graph ownership once; late ended is harmless", async () => {
  const h = harness();
  h.mod.unlockAudio();
  await settle();
  h.mod.sfx.play("win");
  const first = h.contexts[0].sources[0];
  first.end();
  first.end();
  assert.equal(voices(h), 0);
  assert.equal(first.disconnected, 1);
  h.mod.sfx.play("caught");
  h.mod.setAudioPaused(true);
  assert.equal(voices(h), 0);
  await settle();
  h.mod.sfx.setEnabled(false);
  h.mod.music.toggle();
  h.mod.sfx.play("win");
  assert.equal(voices(h), 0);
  h.mod.resetAudio();
  h.mod.disposeAudio();
  h.mod.disposeAudio();
  for (const source of h.contexts[0].sources) source.end();
  h.mod.unlockAudio();
  h.mod.setAudioPaused(false);
  h.mod.sfx.play("pellet");
  assert.equal(h.contexts[0].closes, 1);
  assert.equal(h.contexts.length, 1);
  assert.equal(h.media.length, 1);
  assert.equal(h.media[0].src, "");
  assert.equal(h.media[0].loads, 1);
  assert.equal(voices(h), 0);
});
test("context promises obey latest pause intent and cannot resurrect disposed graphs", async () => {
  const h = harness({ contextState: "suspended", delayedContext: true });
  h.mod.unlockAudio();
  const ctx = h.contexts[0];
  h.mod.sfx.play("win");
  assert.equal(voices(h), 0);
  h.mod.setAudioPaused(true);
  ctx.operations.shift().finish();
  await settle();
  assert.equal(ctx.operations[0].kind, "suspend");
  assert.equal(ctx.gains[0].gain.value, 0);
  h.mod.setAudioPaused(false);
  ctx.operations.shift().finish();
  await settle();
  assert.equal(ctx.operations[0].kind, "resume");
  h.mod.disposeAudio();
  ctx.operations.shift().finish();
  await settle();
  assert.equal(ctx.state, "closed");
  assert.equal(ctx.closes, 1);
  assert.equal(ctx.operations.length, 0);
});
test("autoplay denial retries same media, real media error latches, late play cannot resume disposal", async () => {
  const h = harness({ play: "denied" });
  h.mod.unlockAudio();
  await settle();
  assert.equal(h.mod.music.diagnostics().failed, false);
  assert.equal(h.mod.music.diagnostics().playBlocked, true);
  h.config.play = "ok";
  h.mod.unlockAudio();
  await settle();
  assert.equal(h.media.length, 1);
  assert.equal(h.media[0].plays, 2);
  h.media[0].dispatchEvent(new Event("error"));
  h.mod.unlockAudio();
  assert.equal(h.media.length, 1);
  assert.equal(h.mod.music.diagnostics().failed, true);
  const late = harness({ play: "pending" });
  late.mod.unlockAudio();
  late.mod.disposeAudio();
  late.media[0].paused = false;
  late.media[0].operations[0].resolve();
  await settle();
  assert.equal(late.media[0].paused, true);
});
test("lullaby threat hysteresis, phase release, power rate and duck clock preserve quiet pause", async () => {
  const h = harness();
  h.mod.unlockAudio();
  await settle();
  const music = h.mod.music;
  music.setMix({ phase: "playing", nearestDanger: 2 });
  for (let i = 0; i < 4; i++) music.update(0.1);
  assert.equal(music.diagnostics().chasing, false);
  music.update(0.05);
  assert.equal(music.diagnostics().chasing, true);
  music.setMix({ phase: "playing", nearestDanger: 3.5 });
  music.update(0.1);
  assert.equal(music.diagnostics().chasing, true);
  music.setMix({ phase: "playing", nearestDanger: 5 });
  for (let i = 0; i < 8; i++) music.update(0.1);
  assert.equal(music.diagnostics().chasing, true);
  music.update(0.1);
  assert.equal(music.diagnostics().chasing, false);
  music.setPowerMode(true);
  assert.equal(h.media[0].playbackRate, 1.06);
  music.duck();
  music.update(0.1);
  const remaining = music.diagnostics().duckRemaining;
  h.mod.setAudioPaused(true);
  h.now(100000);
  music.update(100);
  assert.equal(music.diagnostics().duckRemaining, remaining);
  assert.equal(h.media[0].volume, 0);
  h.mod.setAudioPaused(false);
  await settle();
  music.update(0.1);
  assert.ok(music.diagnostics().duckRemaining < remaining);
  h.mod.resetAudio();
  music.setMix({ phase: "win", nearestDanger: 0 });
  for (let i = 0; i < 30; i++) music.update(0.1);
  assert.equal(music.diagnostics().targetVolume, 0.12);
  assert.equal(h.media[0].playbackRate, 1);
  assert.ok(h.media[0].volume <= 0.121);
});
test("pending media playback follows latest pause and mute without duplicate element", async () => {
  const h = harness({ play: "pending" });
  h.mod.unlockAudio();
  h.mod.setAudioPaused(true);
  h.media[0].paused = false;
  h.media[0].operations.shift().resolve();
  await settle();
  assert.equal(h.media[0].paused, true);
  assert.equal(h.media[0].volume, 0);
  h.mod.setAudioPaused(false);
  h.mod.music.toggle();
  h.mod.sfx.setEnabled(false);
  h.media[0].paused = false;
  h.media[0].operations.shift().resolve();
  await settle();
  assert.equal(h.media[0].paused, true);
  assert.equal(h.media[0].volume, 0);
  assert.equal(h.media.length, 1);
  assert.equal(voices(h), 0);
  h.mod.disposeAudio();
});
test("all11 authored buffers, pitch jitter, play gains and caught duck routing match baseline", () => {
  const output = recipes(harness());
  if (process.env.PACMAN_AUDIO_BASELINE) {
    const before = recipes(harness({}, readFileSync(process.env.PACMAN_AUDIO_BASELINE, "utf8")));
    assert.deepEqual(output, before);
    console.log(
      JSON.stringify({
        buffers: output.bufferHashes.length,
        recipeHash: createHash("sha256").update(JSON.stringify(output)).digest("hex"),
      }),
    );
  }
  assert.equal(
    createHash("sha256").update(JSON.stringify(output)).digest("hex"),
    "adb41ebf4c051d270a957ef485d0f1ea2a356324087d08ded5a3f301305a83fe",
  );
});
