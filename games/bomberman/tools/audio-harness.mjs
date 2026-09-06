import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import vm from "node:vm";

function compile(source) {
  return stripTypeScriptTypes(
    source.replace(/^import[^;]+;$/gm, "").replace(/^export type \{[^;]+;$/gm, ""),
    { mode: "transform" },
  )
    .replace(/^export (class|function|const) /gm, "$1 ")
    .replace(/^export \{\};?$/gm, "");
}
const scoreSource = compile(
  readFileSync(new URL("../src/fx/round-score.ts", import.meta.url), "utf8"),
);
const audioSource = compile(readFileSync(new URL("../src/fx/sfx.ts", import.meta.url), "utf8"));

class Param {
  value = 0;
  events = [];
  cancellations = [];
  setValueAtTime(value, at) {
    if (!Number.isFinite(value) || !Number.isFinite(at)) throw Error("invalid parameter");
    this.value = value;
    this.events.push(["set", value, at]);
  }
  exponentialRampToValueAtTime(value, at) {
    if (!(value > 0)) throw Error("nonpositive exponential endpoint");
    this.events.push(["exp", value, at]);
  }
  linearRampToValueAtTime(value, at) {
    this.events.push(["linear", value, at]);
  }
  cancelScheduledValues(at) {
    this.cancellations.push(at);
    this.events = this.events.filter((event) => event[2] < at);
  }
}
class Node {
  links = [];
  disconnected = 0;
  constructor(kind) {
    this.kind = kind;
  }
  connect(node) {
    this.links.push(node);
    return node;
  }
  disconnect() {
    this.disconnected++;
  }
}

/** Execute the complete real modules. Mock graph ownership and sample-clock
 * scheduling only; no assertion about browser audio output or mix perception. */
export function environment({ stored = "1", activation = true, delayed = false, baseline } = {}) {
  let seed = 123456789;
  let randomCalls = 0;
  let wall = 0;
  const contexts = [];
  const math = Object.create(Math);
  math.random = () => {
    randomCalls++;
    seed = (1664525 * seed + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  class Context {
    state = delayed ? "suspended" : "running";
    currentTime = 0;
    sampleRate = 8000;
    destination = new Node("destination");
    nodes = [];
    sources = [];
    operations = [];
    closed = 0;
    peak = 0;
    constructor() {
      contexts.push(this);
    }
    node(kind) {
      const node = new Node(kind);
      this.nodes.push(node);
      return node;
    }
    createGain() {
      const node = this.node("gain");
      node.gain = new Param();
      return node;
    }
    createBiquadFilter() {
      const node = this.node("filter");
      node.frequency = new Param();
      return node;
    }
    createStereoPanner() {
      const node = this.node("panner");
      node.pan = new Param();
      return node;
    }
    source(kind) {
      const node = this.node(kind);
      node.listeners = new Set();
      node.addEventListener = (_name, fn) => node.listeners.add(fn);
      node.removeEventListener = (_name, fn) => node.listeners.delete(fn);
      node.starts = [];
      node.stops = [];
      node.endAt = Infinity;
      node.finished = false;
      node.finish = () => {
        if (node.finished) return;
        node.finished = true;
        for (const fn of node.listeners) fn();
      };
      node.start = (at = this.currentTime) => {
        node.starts.push(at);
        this.peak = Math.max(
          this.peak,
          this.sources.filter((s) => s.starts.length && !s.finished).length,
        );
      };
      node.stop = (at = this.currentTime) => {
        node.stops.push(at);
        node.endAt = at;
        if (at <= this.currentTime) node.finish();
      };
      this.sources.push(node);
      return node;
    }
    createOscillator() {
      const node = this.source("oscillator");
      node.frequency = new Param();
      return node;
    }
    createBufferSource() {
      return this.source("buffer");
    }
    createBuffer(_channels, length, sampleRate) {
      const data = new Float32Array(length);
      return { length, sampleRate, getChannelData: () => data };
    }
    resume() {
      if (!delayed) {
        this.state = "running";
        return Promise.resolve();
      }
      return new Promise((resolve, reject) =>
        this.operations.push({
          finish: () => {
            if (this.state !== "closed") this.state = "running";
            resolve();
          },
          reject,
        }),
      );
    }
    close() {
      this.closed++;
      this.state = "closed";
      return Promise.resolve();
    }
    advance(ms) {
      if (this.state === "running") this.currentTime += ms / 1000;
      for (const source of this.sources) if (source.endAt <= this.currentTime) source.finish();
    }
  }
  const userActivation = { isActive: activation };
  const writes = [];
  const context = vm.createContext({
    Math: math,
    AudioContext: Context,
    window: { AudioContext: Context, navigator: { userActivation } },
    performance: { now: () => wall },
    localStorage: { getItem: () => stored, setItem: (...args) => writes.push(args) },
    setInterval: () => {
      throw Error("score must not own an interval");
    },
    setTimeout: () => {
      throw Error("score must not schedule wall-clock cues");
    },
  });
  const names =
    "sfx,unlockAudio,setMuted,isMuted,pauseAudio,resetRoundAudio,disposeAudio,audioDiagnostics";
  const source = baseline
    ? compile(readFileSync(baseline, "utf8"))
    : `${scoreSource}\n${audioSource}`;
  vm.runInContext(
    `${source}\nglobalThis.audio={${names}${baseline ? "" : ",updateRoundScore"}}`,
    context,
  );
  return {
    audio: context.audio,
    contexts,
    writes,
    userActivation,
    randomCalls: () => randomCalls,
    advance(ms) {
      wall += ms;
      for (const ac of contexts) ac.advance(ms);
    },
    wall(ms) {
      wall = ms;
    },
  };
}

/** Strip only the new persistent mix buses. Source envelopes/filter/pan,
 * jitter, noise bytes and start/stop timing remain part of the receipt. */
export function coreReceipt(context) {
  const records = context.sources.map((source) => {
    const chain = [];
    let node = source.links[0];
    while (node && node.kind !== "destination") {
      if (node.kind !== "gain" || node.gain.events.some((event) => event[0] === "exp")) {
        chain.push({
          kind: node.kind,
          type: node.type,
          gain: node.gain?.events,
          frequency: node.frequency?.events,
          filterValue: node.frequency?.value,
          pan: node.pan?.value,
        });
      }
      node = node.links[0];
    }
    const data = source.buffer?.getChannelData(0);
    return {
      kind: source.kind,
      type: source.type,
      frequency: source.frequency?.events,
      starts: source.starts,
      stops: source.stops,
      chain,
      noise: data ? createHash("sha256").update(Buffer.from(data.buffer)).digest("hex") : null,
    };
  });
  return createHash("sha256").update(JSON.stringify(records)).digest("hex");
}

export async function settle() {
  await Promise.resolve();
  await Promise.resolve();
}
