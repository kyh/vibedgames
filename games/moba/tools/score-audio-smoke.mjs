import assert from "node:assert/strict";
import { SCORE_STEP_SECONDS } from "../src/render/score.ts";

// Exercise the real owner against a small sample-clock graph. No browser,
// speaker, waveform or perceptual mix claim; root captures the actual graph.
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
const originalPerformance = Object.getOwnPropertyDescriptor(globalThis, "performance");
const originalFetch = globalThis.fetch;
let serial = 0;
class Param {
  value = 1;
  setValueAtTime(value) {
    this.value = value;
  }
  exponentialRampToValueAtTime() {}
  linearRampToValueAtTime() {}
  cancelScheduledValues() {}
}
class GraphNode {
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
async function setup(stored = "1", sampleReady = false) {
  let clock = 10000;
  const contexts = [];
  const requests = [];
  globalThis.fetch = async (url) => {
    requests.push(url);
    return { ok: sampleReady, arrayBuffer: async () => new ArrayBuffer(4) };
  };
  class Context {
    state = "running";
    currentTime = 0;
    sampleRate = 8000;
    destination = {};
    sources = [];
    gains = [];
    closed = 0;
    constructor() {
      contexts.push(this);
    }
    createGain() {
      const node = new GraphNode();
      node.gain = new Param();
      this.gains.push(node);
      return node;
    }
    createBiquadFilter() {
      const node = new GraphNode();
      node.frequency = new Param();
      node.Q = new Param();
      return node;
    }
    createBuffer(channels, length, sampleRate) {
      const data = new Float32Array(length);
      return { length, sampleRate, getChannelData: () => data };
    }
    async decodeAudioData() {
      return { foley: true, duration: 0.5, length: 4000, sampleRate: 8000 };
    }
    source() {
      const node = new GraphNode();
      node.listeners = new Set();
      node.addEventListener = (event, fn) => node.listeners.add(fn);
      node.removeEventListener = (event, fn) => node.listeners.delete(fn);
      node.start = (time) => {
        node.startsAt = time;
        if (node.buffer) node.endsAt = time + node.buffer.length / node.buffer.sampleRate;
      };
      node.stop = (time = this.currentTime) => {
        node.endsAt = time;
      };
      this.sources.push(node);
      return node;
    }
    createOscillator() {
      const node = this.source();
      node.frequency = new Param();
      return node;
    }
    createBufferSource() {
      return this.source();
    }
    resume() {
      this.state = "running";
      return Promise.resolve();
    }
    suspend() {
      this.state = "suspended";
      return Promise.resolve();
    }
    close() {
      this.closed++;
      this.state = "closed";
      return Promise.resolve();
    }
    advance(seconds) {
      this.currentTime += seconds;
      for (const node of this.sources) {
        if (node.endsAt <= this.currentTime && !node.finished) {
          node.finished = true;
          for (const fn of node.listeners) fn();
        }
      }
    }
  }
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { AudioContext: Context, localStorage: { getItem: () => stored, setItem() {} } },
  });
  Object.defineProperty(globalThis, "performance", {
    configurable: true,
    value: { now: () => clock },
  });
  const mod = await import(`../src/render/audio.ts?score-case=${serial++}`);
  return {
    mod,
    contexts,
    requests,
    bump: () => {
      clock += 100;
    },
  };
}
const settle = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};
const frame = (step, kind = "quiet") => ({
  kind,
  time: step * SCORE_STEP_SECONDS + 0.00001,
  water: true,
});
let groups = 0;
try {
  {
    const { mod, contexts } = await setup();
    for (let step = 0; step < 192; step++) {
      contexts[0]?.advance(SCORE_STEP_SECONDS);
      const kind = step < 48 ? "quiet" : step < 96 ? "skirmish" : step < 160 ? "battle" : "fallen";
      mod.updateSoundscape(frame(step, kind));
      const d = mod.soundDiagnostics();
      assert.ok(d.musicSources <= 6 && d.ambienceSources <= 2 && d.ownedSources <= 32);
      const accepted = d.acceptedSources;
      mod.updateSoundscape(frame(step, kind));
      assert.equal(
        mod.soundDiagnostics().acceptedSources,
        accepted,
        "duplicate snapshot is silent",
      );
      for (const source of contexts[0].sources.filter((node) => !node.disconnected))
        assert.ok(
          source.startsAt <= contexts[0].currentTime + 0.051,
          "only a current step is scheduled",
        );
    }
    contexts[0].advance(4);
    assert.equal(mod.soundDiagnostics().ownedSources, 0, "natural expiry releases every node");
    mod.disposeSound();
    assert.equal(contexts[0].closed, 1);
    for (const gain of contexts[0].gains) assert.equal(gain.disconnected, 1);
    groups++;
  }
  {
    const { mod, contexts, bump } = await setup();
    for (let step = 0; step < 16; step++) mod.updateSoundscape(frame(step));
    assert.equal(mod.soundDiagnostics().musicSources, 6);
    assert.equal(mod.soundDiagnostics().ambienceSources, 2);
    for (let i = 0; i < 8; i++) {
      mod.sfx.ability("boomtinker:Q");
      bump();
    }
    let d = mod.soundDiagnostics();
    assert.equal(d.routineSources, 24);
    assert.equal(d.musicSources + d.ambienceSources, 0, "ordinary SFX reclaim background first");
    mod.sfx.level();
    mod.sfx.victory(true);
    mod.sfx.structureDown();
    d = mod.soundDiagnostics();
    assert.equal(d.ownedSources, 32);
    assert.equal(d.essentialSources, 8, "essential reserve remains available");
    const accepted = d.acceptedSources;
    mod.updateSoundscape(frame(16));
    assert.equal(mod.soundDiagnostics().acceptedSources, accepted, "background never evicts SFX");
    mod.resetSound();
    assert.equal(mod.soundDiagnostics().ownedSources, 0);
    assert.equal(mod.soundDiagnostics().phrases, 0);
    for (const source of contexts[0].sources) assert.equal(source.disconnected, 1);
    mod.disposeSound();
    groups++;
  }
  {
    const { mod, contexts } = await setup();
    mod.updateSoundscape(frame(0));
    mod.updateSoundscape(frame(320));
    assert.equal(
      mod.soundDiagnostics().ownedSources,
      2,
      "forward jump replaces old bed with current step",
    );
    mod.updateSoundscape(frame(0));
    assert.equal(mod.soundDiagnostics().ownedSources, 2, "backward clock replaces old bed");
    mod.sfx.victory(true);
    mod.updateSoundscape({ kind: "ended", time: 1 });
    let d = mod.soundDiagnostics();
    assert.equal(d.musicSources + d.ambienceSources, 0);
    assert.equal(d.ownedSources, 4, "ended preserves the actual outcome phrase");
    mod.updateSoundscape({ kind: "ended", time: 0 });
    mod.updateSoundscape({ kind: "silent", time: 0 });
    assert.equal(mod.soundDiagnostics().ownedSources, 4, "result/spectator cannot wake background");
    mod.setSoundPaused(true);
    await settle();
    d = mod.soundDiagnostics();
    assert.equal(d.ownedSources, 0);
    assert.equal(d.scheduledSources, 0);
    mod.setMuted(false);
    mod.updateSoundscape(frame(64));
    assert.equal(mod.soundDiagnostics().ownedSources, 0);
    mod.setSoundPaused(false);
    await settle();
    mod.updateSoundscape(frame(64));
    assert.equal(mod.soundDiagnostics().ownedSources, 0, "resume never repeats the observed step");
    mod.updateSoundscape(frame(66));
    assert.ok(mod.soundDiagnostics().ownedSources > 0);
    mod.setMuted(true);
    await settle();
    assert.equal(mod.soundDiagnostics().ownedSources, 0);
    mod.setMuted(false);
    await settle();
    for (let i = 0; i < 3; i++) {
      mod.resetSound();
      mod.updateSoundscape(frame(0));
    }
    assert.equal(contexts.length, 1, "match reset reuses context");
    mod.disposeSound();
    mod.disposeSound();
    mod.updateSoundscape(frame(2));
    assert.equal(mod.soundDiagnostics().ownedSources, 0);
    assert.equal(contexts[0].closed, 1);
    groups++;
  }
  {
    const { mod, contexts } = await setup();
    mod.updateSoundscape({ kind: "quiet", time: 0.2, water: false });
    mod.sfx.victory(true);
    const outcome = contexts[0].sources.slice(-4);
    contexts[0].advance(0.05);
    const before = mod.soundDiagnostics();
    assert.equal(before.musicSources, 2);
    assert.equal(before.essentialSources, 4);
    mod.updateSoundscape({ kind: "quiet", time: 0.1, water: false });
    const after = mod.soundDiagnostics();
    assert.equal(after.score.step, before.score.step, "correction stays within one grid step");
    assert.equal(after.musicSources, 2, "same-step rewind replaces the old background");
    assert.equal(after.stoppedSources - before.stoppedSources, 2);
    assert.equal(after.essentialSources, 4, "live and future outcome notes survive the rewind");
    for (const source of outcome) assert.equal(source.disconnected, 0);
    mod.disposeSound();
    groups++;
  }
  {
    const { mod, contexts } = await setup(null);
    mod.updateSoundscape(frame(0));
    assert.equal(contexts.length, 0, "default muted allocates nothing");
    mod.setMuted(false);
    mod.resumeAudio();
    mod.updateSoundscape(frame(0));
    assert.equal(mod.soundDiagnostics().ownedSources, 0, "unlock skips old grid step");
    mod.updateSoundscape(frame(2));
    assert.equal(mod.soundDiagnostics().musicSources, 1);
    mod.updateSoundscape({ kind: "quiet", time: NaN, water: false });
    assert.equal(mod.soundDiagnostics().ownedSources, 0, "invalid clock becomes silent");
    mod.disposeSound();
    groups++;
  }
  {
    const { mod, contexts, requests, bump } = await setup("1", true);
    mod.sfx.ability("ironvow:Q", 1, true);
    assert.equal(mod.soundDiagnostics().ownedSources, 2, "loading plays immediate fallback");
    assert.equal(
      contexts[0].sources.some((s) => s.buffer?.foley),
      false,
    );
    await settle();
    assert.equal(mod.soundDiagnostics().foley.ready, 6);
    assert.equal(mod.soundDiagnostics().acceptedSources, 2, "decode cannot replay missed accent");
    contexts[0].advance(1);
    bump();
    mod.sfx.ability("ironvow:Q", 0.6);
    mod.sfx.ability("ironvow:Q", 1, true);
    assert.equal(mod.soundDiagnostics().ownedSources, 4, "ally cannot swallow local cast");
    assert.equal(mod.soundDiagnostics().essentialSources, 2);
    assert.equal(contexts[0].sources.filter((s) => !s.disconnected && s.buffer?.foley).length, 2);
    mod.sfx.ability("ironvow:Q", 1, true);
    assert.equal(mod.soundDiagnostics().ownedSources, 4, "same local duplicate stays throttled");
    mod.sfx.ability("ironvow:W", 1, true);
    assert.equal(mod.soundDiagnostics().ownedSources, 6, "different accepted spell has own gate");
    for (let i = 0; i < 30; i++) {
      bump();
      mod.sfx.ability("boomtinker:Q", 1, i % 2 === 0);
      assert.ok(mod.soundDiagnostics().ownedSources <= 32, "sample voices share existing cap");
    }
    mod.resetSound();
    assert.equal(mod.soundDiagnostics().ownedSources, 0);
    assert.equal(mod.soundDiagnostics().foley.ready, 6, "reset retains six reusable buffers");
    mod.resumeAudio();
    assert.equal(requests.length, 6, "reset cannot refetch samples");
    mod.disposeSound();
    assert.equal(mod.soundDiagnostics().foley.status, "disposed");
    assert.equal(mod.soundDiagnostics().foley.ready, 0);
    for (const source of contexts[0].sources) assert.equal(source.disconnected, 1);
    groups++;
  }
  console.log(
    `✓ ${groups} actual score/audio graph groups: natural expiry, 32/6/2 caps, SFX priority, clock jumps, outcome, pause/mute/reset/dispose`,
  );
} finally {
  globalThis.fetch = originalFetch;
  if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
  else delete globalThis.window;
  if (originalPerformance) Object.defineProperty(globalThis, "performance", originalPerformance);
}
