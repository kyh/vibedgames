import { Audio } from "../src/render/audio.ts";
export class Param {
  constructor(owner, key) {
    this.owner = owner;
    this.key = key;
    this.value = 0;
    this.events = [];
  }
  setValueAtTime(v, t) {
    this.value = v;
    this.events.push(["set", v, t]);
    return this;
  }
  exponentialRampToValueAtTime(v, t) {
    if (!(v > 0)) throw Error("non-positive exponential endpoint");
    this.events.push(["exp", v, t]);
    return this;
  }
  linearRampToValueAtTime(v, t) {
    this.events.push(["linear", v, t]);
    return this;
  }
  setTargetAtTime(v, t, c) {
    this.events.push(["target", v, t, c]);
    return this;
  }
  cancelScheduledValues(t) {
    this.events.push(["cancel", t]);
    return this;
  }
}
class Node {
  constructor(kind) {
    this.kind = kind;
    this.links = [];
    this.disconnected = 0;
  }
  connect(n) {
    this.links.push(n);
    return n;
  }
  disconnect() {
    this.disconnected++;
  }
}
export async function environment({
  AudioClass = Audio,
  initial = "running",
  delayed = false,
  stored = "0",
  storageFail = false,
  unsupported = false,
  activation = true,
} = {}) {
  let seed = 123456789,
    wall = 10000,
    nextTimer = 0;
  Math.random = () => {
    seed = (1664525 * seed + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  const contexts = [],
    timers = new Map(),
    listeners = new Map(),
    writes = [];
  class Context {
    constructor() {
      this.state = initial;
      this.currentTime = 10;
      this.sampleRate = 8000;
      this.destination = new Node("destination");
      this.nodes = [];
      this.sources = [];
      this.gains = [];
      this.operations = [];
      this.closed = 0;
      contexts.push(this);
    }
    node(kind) {
      const n = new Node(kind);
      this.nodes.push(n);
      return n;
    }
    createGain() {
      const n = this.node("gain");
      n.gain = new Param(n, "gain");
      n.gain.value = 1;
      this.gains.push(n);
      return n;
    }
    source(kind) {
      const n = this.node(kind);
      n.listeners = new Set();
      n.addEventListener = (t, f) => n.listeners.add(f);
      n.removeEventListener = (t, f) => n.listeners.delete(f);
      n.starts = [];
      n.stops = [];
      n.finished = false;
      n.nativeEnd = Infinity;
      n.requestedEnd = Infinity;
      n.finish = () => {
        if (n.finished) return;
        n.finished = true;
        for (const f of n.listeners) f();
      };
      n.start = (t = this.currentTime, offset) => {
        n.starts.push([t, offset ?? null]);
        if (n.buffer && !n.loop)
          n.nativeEnd = t + Math.max(0, n.buffer.length / n.buffer.sampleRate - (offset ?? 0));
      };
      n.stop = (t = this.currentTime) => {
        n.stops.push(t);
        n.requestedEnd = t;
      };
      this.sources.push(n);
      return n;
    }
    createOscillator() {
      const n = this.source("oscillator");
      n.frequency = new Param(n, "frequency");
      n.frequency.value = 440;
      n.detune = new Param(n, "detune");
      return n;
    }
    createBufferSource() {
      return this.source("buffer");
    }
    createBiquadFilter() {
      const n = this.node("filter");
      n.frequency = new Param(n, "frequency");
      n.frequency.value = 350;
      n.Q = new Param(n, "Q");
      n.Q.value = 1;
      return n;
    }
    createStereoPanner() {
      const n = this.node("panner");
      n.pan = new Param(n, "pan");
      return n;
    }
    createDynamicsCompressor() {
      const n = this.node("compressor");
      for (const key of ["threshold", "knee", "ratio", "attack", "release"])
        n[key] = new Param(n, key);
      return n;
    }
    createBuffer(ch, length, rate) {
      const data = new Float32Array(length);
      return { length, sampleRate: rate, getChannelData: () => data };
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
      return Promise.resolve();
    }
    advance(seconds) {
      if (this.state === "running") this.currentTime += seconds;
      for (const n of this.sources)
        if (Math.min(n.nativeEnd, n.requestedEnd) <= this.currentTime) n.finish();
    }
  }
  const interval = (fn, ms) => {
    timers.set(++nextTimer, { fn, ms, next: wall + ms });
    return nextTimer;
  };
  const clear = (id) => timers.delete(id);
  const storage = {
    getItem() {
      if (storageFail) throw Error("denied");
      return stored;
    },
    setItem(k, v) {
      if (storageFail) throw Error("denied");
      writes.push([k, v]);
    },
  };
  globalThis.localStorage = storage;
  globalThis.AudioContext = unsupported ? undefined : Context;
  globalThis.window = {
    AudioContext: globalThis.AudioContext,
    localStorage: storage,
    navigator: { userActivation: { isActive: activation } },
    setInterval: interval,
    clearInterval: clear,
    addEventListener(t, f) {
      let set = listeners.get(t);
      if (!set) {
        set = new Set();
        listeners.set(t, set);
      }
      set.add(f);
    },
    removeEventListener(t, f) {
      listeners.get(t)?.delete(f);
    },
  };
  const audio = new AudioClass();
  function label() {
    const c = contexts[0];
    if (!c) return;
    for (const [i, name] of [
      "master",
      "sfx",
      "ui",
      "music",
      "amb",
      "drone",
      "pulse",
      "kit",
      "lead",
    ].entries())
      if (c.gains[i]) c.gains[i].role = name;
  }
  return {
    audio,
    Context,
    contexts,
    timers,
    listeners,
    writes,
    gesture() {
      for (const fn of listeners.get("pointerdown") ?? []) fn();
      label();
    },
    label,
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
      const delta = end - wall;
      wall = end;
      for (const c of contexts) c.advance(delta / 1000);
    },
    jump(ms) {
      wall += ms;
      for (const c of contexts) c.advance(ms / 1000);
    },
  };
}
function param(p) {
  return { value: p.value, events: p.events };
}
function walk(n) {
  if (n instanceof Param) return { param: n.key, node: n.owner.kind, type: n.owner.type };
  if (n.role) return { bus: n.role };
  if (n.kind === "destination") return { destination: true };
  const result = { kind: n.kind };
  for (const k of [
    "gain",
    "frequency",
    "detune",
    "Q",
    "pan",
    "threshold",
    "knee",
    "ratio",
    "attack",
    "release",
  ])
    if (n[k]) result[k] = param(n[k]);
  if (n.type !== undefined) result.type = n.type;
  result.links = n.links.map(walk);
  return result;
}
export function records(ctx, start = 0) {
  return structuredClone(
    ctx.sources.slice(start).map((n) => ({
      kind: n.kind,
      type: n.type ?? null,
      freq: n.frequency ? param(n.frequency) : null,
      detune: n.detune ? param(n.detune) : null,
      loop: n.loop ?? false,
      buffer: n.buffer
        ? {
            length: n.buffer.length,
            sampleRate: n.buffer.sampleRate,
            data: Array.from(n.buffer.getChannelData(0)),
          }
        : null,
      starts: n.starts,
      stops: n.stops,
      links: n.links.map(walk),
    })),
  );
}
export const settle = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};
