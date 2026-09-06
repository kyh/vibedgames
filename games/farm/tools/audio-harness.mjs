import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { createHash } from "node:crypto";

export const settle = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};

export function audioHarness(file = new URL("../src/render/audio.ts", import.meta.url)) {
  const timers = new Map(),
    contexts = [],
    writes = [];
  let timerId = 0,
    random = 731;
  class Param {
    value = 0;
    events = [];
    setValueAtTime(v, t) {
      this.value = v;
      this.events.push(["set", v, t]);
    }
    cancelScheduledValues(t) {
      this.events.push(["cancel", t]);
    }
    exponentialRampToValueAtTime(v, t) {
      assert.ok(v > 0);
      this.events.push(["exponential", v, t]);
    }
    linearRampToValueAtTime(v, t) {
      this.events.push(["linear", v, t]);
    }
  }
  class Node {
    disconnected = 0;
    links = [];
    connect(node) {
      this.links.push(node);
      return node;
    }
    disconnect() {
      this.disconnected++;
      this.links = [];
    }
  }
  class Source extends Node {
    frequency = new Param();
    listener = null;
    started = false;
    starts = [];
    stops = [];
    addEventListener(event, fn) {
      assert.equal(event, "ended");
      this.listener = fn;
    }
    start(t) {
      assert.equal(this.started, false);
      this.started = true;
      this.starts.push(t);
    }
    stop(t) {
      assert.ok(this.started);
      this.stops.push(t ?? "now");
    }
    finish() {
      this.listener?.();
    }
  }
  class Context {
    state = "suspended";
    currentTime = 0;
    sampleRate = 8000;
    destination = new Node();
    nodes = [];
    sources = [];
    buffers = [];
    deferred = false;
    operations = [];
    closeCalls = 0;
    resumeCalls = 0;
    suspendCalls = 0;
    constructor() {
      contexts.push(this);
    }
    operation(state) {
      if (!this.deferred) {
        this.state = state;
        return Promise.resolve();
      }
      return new Promise((resolve) =>
        this.operations.push(() => {
          if (this.state !== "closed") this.state = state;
          resolve();
        }),
      );
    }
    resume() {
      this.resumeCalls++;
      return this.operation("running");
    }
    suspend() {
      this.suspendCalls++;
      return this.operation("suspended");
    }
    close() {
      this.closeCalls++;
      this.state = "closed";
      return Promise.resolve();
    }
    createGain() {
      const n = new Node();
      n.gain = new Param();
      this.nodes.push(n);
      return n;
    }
    createBiquadFilter() {
      const n = new Node();
      n.frequency = new Param();
      this.nodes.push(n);
      return n;
    }
    createOscillator() {
      const n = new Source();
      n.kind = "oscillator";
      this.sources.push(n);
      return n;
    }
    createBufferSource() {
      const n = new Source();
      n.kind = "buffer";
      this.sources.push(n);
      return n;
    }
    createBuffer(channels, length, rate) {
      const data = new Float32Array(length);
      const buffer = { channels, length, rate, data, getChannelData: () => data };
      this.buffers.push(buffer);
      return buffer;
    }
  }
  const window = {
    AudioContext: Context,
    localStorage: { getItem: () => null, setItem: (key, value) => writes.push({ key, value }) },
  };
  const math = Object.create(Math);
  math.random = () => {
    random = (Math.imul(random, 1664525) + 1013904223) >>> 0;
    return random / 4294967296;
  };
  const code = stripTypeScriptTypes(readFileSync(file, "utf8"), { mode: "strip" }).replace(
    "export const Sound",
    "const Sound",
  );
  const Sound = new Function(
    "window",
    "setTimeout",
    "clearTimeout",
    "Math",
    `${code}\nreturn Sound;`,
  )(
    window,
    (fn) => {
      timers.set(++timerId, fn);
      return timerId;
    },
    (id) => timers.delete(id),
    math,
  );
  return { Sound, contexts, timers, writes };
}

const nodeTrace = (node) => ({
  type: node.type,
  frequency: node.frequency
    ? { value: node.frequency.value, events: node.frequency.events }
    : undefined,
  gain: node.gain ? { value: node.gain.value, events: node.gain.events } : undefined,
});

/** Actual connected graphs + deterministic noise bytes, captured before cleanup. */
export async function recipeTrace(file) {
  const { Sound, contexts, timers } = audioHarness(file);
  Sound.muted = false;
  await settle();
  const c = contexts[0],
    trace = [];
  let cursor = 0;
  function capture(label) {
    const sources = c.sources.slice(cursor);
    trace.push({
      label,
      sources: sources.map((s) => ({
        kind: s.kind,
        ...nodeTrace(s),
        starts: [...s.starts],
        stops: [...s.stops],
        buffer: s.buffer
          ? createHash("sha256").update(Buffer.from(s.buffer.data.buffer)).digest("hex")
          : undefined,
        route: (() => {
          const path = [];
          let node = s.links[0];
          while (node && node !== c.destination) {
            path.push(nodeTrace(node));
            node = node.links[0];
          }
          return path;
        })(),
      })),
    });
    cursor = c.sources.length;
    for (const source of sources) source.finish();
  }
  for (const cue of [
    "footstep",
    "dig",
    "water",
    "chop",
    "mine",
    "plant",
    "harvest",
    "coins",
    "click",
    "thud",
    "wake",
  ]) {
    Sound[cue]();
    capture(cue);
    c.currentTime += 2;
  }
  for (const mode of ["farm", "mine"]) {
    const release = Sound.startMusic(mode);
    capture(`${mode}:0`);
    for (let i = 1; i < 8; i++) {
      c.currentTime += mode === "farm" ? 0.46 : 0.62;
      const [id, callback] = timers.entries().next().value;
      timers.delete(id);
      callback();
      capture(`${mode}:${i}`);
    }
    release();
  }
  Sound.stopMusic();
  return trace;
}
