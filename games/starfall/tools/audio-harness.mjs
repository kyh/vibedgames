import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import vm from "node:vm";

const current = new URL("../src/audio/sfx.ts", import.meta.url);
const score = new URL("../src/audio/battle-score.ts", import.meta.url);
const compile = (source) =>
  stripTypeScriptTypes(source.replace(/^import[^;]+;$/gm, ""), { mode: "transform" })
    .replace(/^export (class|function|const) /gm, "$1 ")
    .replace(/^export \{\};?$/gm, "");

class Param {
  value = 0;
  events = [];
  setValueAtTime(value, at) {
    if (!Number.isFinite(value)) throw new Error("Nonfinite parameter");
    this.value = value;
    this.events.push(["set", value, at]);
    return this;
  }
  setTargetAtTime(value, at, constant) {
    this.value = value;
    this.events.push(["target", value, at, constant]);
    return this;
  }
  linearRampToValueAtTime(value, at) {
    this.events.push(["linear", value, at]);
    return this;
  }
  cancelScheduledValues(at) {
    this.events.push(["cancel", at]);
    return this;
  }
}
class Node {
  constructor(kind) {
    this.kind = kind;
  }
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

/** Complete actual audio/score modules, isolated RNG and sample/wall clocks.
 * Native graph/event behavior is explicit; this cannot establish audibility. */
export function environment({
  source = current,
  initial = "running",
  delayed = false,
  stored = "1",
  activation = true,
  closeReject = false,
} = {}) {
  let randomState = 123456789;
  let randomDraws = 0;
  const math = Object.create(Math);
  math.random = () => {
    randomDraws++;
    randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0;
    return randomState / 4294967296;
  };
  let wall = 10000;
  let timerId = 0;
  const timers = new Map();
  const contexts = [];
  const storageWrites = [];
  class Context {
    state = initial;
    currentTime = 10;
    sampleRate = 44100;
    destination = new Node("destination");
    nodes = [];
    sources = [];
    gains = [];
    operations = [];
    closed = 0;
    constructor() {
      contexts.push(this);
    }
    createGain() {
      const node = new Node("gain");
      node.gain = new Param();
      node.gain.value = 1;
      this.nodes.push(node);
      this.gains.push(node);
      return node;
    }
    createBuffer(channels, length, sampleRate) {
      if (channels !== 1) throw new Error("Expected original mono buffers");
      const data = new Float32Array(length);
      return { length, sampleRate, getChannelData: () => data };
    }
    createBufferSource() {
      const node = new Node("source");
      node.playbackRate = new Param();
      node.playbackRate.value = 1;
      node.listeners = new Set();
      node.starts = [];
      node.stops = [];
      node.finished = false;
      node.nativeEnd = Infinity;
      node.requestedEnd = Infinity;
      node.addEventListener = (_type, fn) => node.listeners.add(fn);
      node.removeEventListener = (_type, fn) => node.listeners.delete(fn);
      node.start = (at = this.currentTime) => {
        if (!Number.isFinite(at) || at < 0 || node.playbackRate.value <= 0)
          throw new Error("Invalid sample-clock start/rate");
        node.starts.push(at);
        node.nativeEnd = at + node.buffer.length / node.buffer.sampleRate / node.playbackRate.value;
      };
      node.stop = (at = this.currentTime) => {
        node.stops.push(at);
        node.requestedEnd = at;
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
      this.closed++;
      this.state = "closed";
      return closeReject ? Promise.reject(new Error("Close failed")) : Promise.resolve();
    }
    advance(seconds) {
      if (this.state === "running") this.currentTime += seconds;
      for (const node of this.sources)
        if (Math.min(node.nativeEnd, node.requestedEnd) <= this.currentTime) node.finish();
    }
  }
  const window = {
    navigator: { userActivation: { isActive: activation } },
    localStorage: {
      getItem: () => stored,
      setItem: (key, value) => storageWrites.push([key, value]),
    },
    AudioContext: Context,
    setInterval(fn, ms) {
      timers.set(++timerId, { fn, ms, next: wall + ms });
      return timerId;
    },
    clearInterval: (id) => timers.delete(id),
  };
  const context = vm.createContext({ window, AudioContext: Context, Math: math });
  vm.runInContext(
    `${compile(readFileSync(score, "utf8"))}\n${compile(readFileSync(source, "utf8"))}\nglobalThis.audio=sfx;globalThis.phrase=battlePhrase;`,
    context,
  );
  return {
    audio: context.audio,
    phrase: context.phrase,
    window,
    contexts,
    timers,
    storageWrites,
    randomDraws: () => randomDraws,
    unlock() {
      context.audio.unlock();
    },
    run(ms) {
      const end = wall + ms;
      while (true) {
        const pair = [...timers].toSorted((a, b) => a[1].next - b[1].next)[0];
        if (!pair || pair[1].next > end) break;
        const [id, timer] = pair;
        const delta = timer.next - wall;
        wall = timer.next;
        for (const c of contexts) c.advance(delta / 1000);
        if (timers.has(id)) {
          timer.next += timer.ms;
          timer.fn();
        }
      }
      for (const c of contexts) c.advance((end - wall) / 1000);
      wall = end;
    },
    jump(ms) {
      wall += ms;
      for (const c of contexts) c.advance(ms / 1000);
      for (const timer of timers.values()) timer.next = wall + timer.ms;
    },
  };
}

export const settle = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};
export const plain = (value) => JSON.parse(JSON.stringify(value));
export const hash = (value) => createHash("sha256").update(value).digest("hex");
export function buffers(audio) {
  return [...audio.buffers, ...audio.musicBuffers].map(([name, buffer]) => ({
    name,
    length: buffer.length,
    rate: buffer.sampleRate,
    hash: hash(Buffer.from(buffer.getChannelData(0).buffer)),
  }));
}
export function sourceRecord(ctx, source) {
  const gain = source.links[0];
  const bus = gain.links[0];
  return {
    buffer: hash(Buffer.from(source.buffer.getChannelData(0).buffer)),
    starts: source.starts,
    rate: source.playbackRate.value,
    gain: gain.gain.value,
    bus: ctx.gains.indexOf(bus),
  };
}
export function recipeReceipt(source) {
  const e = environment({ source });
  e.unlock();
  const c = e.contexts[0];
  const original = buffers(e.audio);
  for (const opts of [{}, { gain: 0.63, rate: 1.17 }]) {
    for (const name of e.audio.buffers.keys()) {
      e.audio.play(name, opts);
      e.run(2000);
    }
  }
  const receipt = {
    buffers: original,
    sources: c.sources.map((s) => sourceRecord(c, s)),
    duck: c.gains[1].gain.events,
    randomDraws: e.randomDraws(),
    masterGain: c.gains[0].gain.value,
    musicGain: c.gains[2].gain.value,
  };
  e.audio.dispose();
  return receipt;
}
