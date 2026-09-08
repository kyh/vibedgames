import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import vm from "node:vm";

class Param {
  value = 1;
  events = [];
  setValueAtTime(value, at) {
    assert.ok(Number.isFinite(value) && Number.isFinite(at));
    this.value = value;
    this.events.push(["set", value, at]);
  }
  exponentialRampToValueAtTime(value, at) {
    assert.ok(value > 0 && Number.isFinite(value) && Number.isFinite(at));
    this.events.push(["exp", value, at]);
  }
  cancelScheduledValues(at) {
    this.events.push(["cancel", at]);
  }
}
class Node {
  links = [];
  disconnected = 0;
  connect(node) {
    this.links.push(node);
    return node;
  }
  disconnect() {
    this.disconnected++;
  }
}

/** Actual complete module; isolated RNG, graph, sample clock and scheduler.
 * Graph ownership is measurable here. Speaker output is not. */
export function environment({
  source = new URL("../src/audio/sfx.ts", import.meta.url),
  initial = "running",
  delayed = false,
  activation = true,
  unsupported = false,
} = {}) {
  const contexts = [];
  const timers = new Map();
  let timerId = 0;
  let randomState = 123456789;
  let randomDraws = 0;
  const math = Object.create(Math);
  math.random = () => {
    randomDraws++;
    randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0;
    return randomState / 4294967296;
  };
  class Context {
    state = initial;
    currentTime = 10;
    sampleRate = 8000;
    destination = {};
    nodes = [];
    sources = [];
    gains = [];
    buffers = [];
    operations = [];
    closed = 0;
    constructor() {
      contexts.push(this);
    }
    createGain() {
      const node = new Node();
      node.gain = new Param();
      this.nodes.push(node);
      this.gains.push(node);
      return node;
    }
    createBuffer(channels, length, rate) {
      assert.equal(channels, 1);
      const data = new Float32Array(length);
      const buffer = { length, sampleRate: rate, getChannelData: () => data };
      this.buffers.push(buffer);
      return buffer;
    }
    source(kind) {
      const node = new Node();
      node.kind = kind;
      node.listeners = new Set();
      node.addEventListener = (_type, fn) => node.listeners.add(fn);
      node.removeEventListener = (_type, fn) => node.listeners.delete(fn);
      node.starts = [];
      node.stops = [];
      node.endsAt = Infinity;
      node.finished = false;
      node.start = (at = this.currentTime) => {
        assert.ok(Number.isFinite(at) && at >= 0);
        node.starts.push(at);
      };
      node.stop = (at = this.currentTime) => {
        node.stops.push(at);
        node.endsAt = at;
      };
      node.finish = () => {
        if (node.finished) return;
        node.finished = true;
        for (const fn of node.listeners) fn();
      };
      this.nodes.push(node);
      this.sources.push(node);
      return node;
    }
    createOscillator() {
      const node = this.source("tone");
      node.frequency = new Param();
      return node;
    }
    createBufferSource() {
      return this.source("noise");
    }
    createBiquadFilter() {
      const node = new Node();
      node.frequency = new Param();
      this.nodes.push(node);
      return node;
    }
    transition(kind) {
      const apply = () => {
        if (this.state !== "closed") this.state = kind === "resume" ? "running" : "suspended";
      };
      if (!delayed) {
        apply();
        return Promise.resolve();
      }
      return new Promise((resolve, reject) =>
        this.operations.push({
          kind,
          reject,
          finish: () => {
            apply();
            resolve();
          },
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
      this.closed++;
      this.state = "closed";
      return Promise.resolve();
    }
    advance(seconds) {
      if (this.state !== "running") return;
      this.currentTime += seconds;
      for (const node of this.sources) if (node.endsAt <= this.currentTime) node.finish();
    }
  }
  const window = { navigator: { userActivation: { isActive: activation } } };
  if (!unsupported) window.AudioContext = Context;
  const code = stripTypeScriptTypes(readFileSync(source, "utf8"), { mode: "transform" })
    .replace(/^export (const|class) /gm, "$1 ")
    .replace(/^export \{\};?$/gm, "");
  const sfx = vm.runInNewContext(`${code};sfx`, {
    window,
    Math: math,
    Float32Array,
    setInterval(fn, ms) {
      assert.equal(ms, 200);
      timers.set(++timerId, fn);
      assert.equal(timers.size, 1, "one app-owned music scheduler");
      return timerId;
    },
    clearInterval: (id) => timers.delete(id),
  });
  return {
    sfx,
    contexts,
    timers,
    window,
    tick() {
      for (const fn of timers.values()) fn();
    },
    get randomDraws() {
      return randomDraws;
    },
  };
}

export const settle = async () => {
  for (let i = 0; i < 4; i++) await Promise.resolve();
};
export const digest = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export function records(ctx) {
  return ctx.sources.map((source) => {
    const filter = source.kind === "noise" ? source.links[0] : null;
    const gain = filter ? filter.links[0] : source.links[0];
    return {
      kind: source.kind,
      type: source.type ?? null,
      frequency: source.frequency?.events ?? null,
      buffer: source.buffer
        ? {
            length: source.buffer.length,
            sha256: createHash("sha256")
              .update(new Uint8Array(source.buffer.getChannelData(0).buffer))
              .digest("hex"),
          }
        : null,
      filter: filter ? { type: filter.type, frequency: filter.frequency.events } : null,
      gain: gain.gain.events,
      route: gain.links[0] === ctx.gains[1] ? "music" : "sfx",
      starts: source.starts,
      stops: source.stops,
    };
  });
}
