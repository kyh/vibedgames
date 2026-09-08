import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { compile } from "./scene-harness.mjs";

export function soundFixture(
  path = "../src/fx/sfx.ts",
  { state = "running", active = false } = {},
) {
  const nodes = [],
    trace = [],
    contexts = [],
    operations = [],
    storage = [],
    rejections = [];
  const activation = { isActive: active };
  const math = Object.create(Math);
  math.random = () => 0.5;
  class Param {
    constructor(id, kind) {
      this.id = id;
      this.kind = kind;
    }
    setValueAtTime(value, time) {
      trace.push([this.id, this.kind, "set", value, time]);
    }
    exponentialRampToValueAtTime(value, time) {
      assert.ok(value > 0);
      trace.push([this.id, this.kind, "exp", value, time]);
    }
  }
  class Node extends EventTarget {
    disconnected = 0;
    constructor(kind) {
      super();
      this.id = nodes.length;
      this.kind = kind;
      nodes.push(this);
      this.frequency = new Param(this.id, "frequency");
      this.gain = new Param(this.id, "gain");
    }
    connect(other) {
      trace.push([this.id, "connect", other.id ?? "output"]);
      return other;
    }
    disconnect() {
      this.disconnected++;
    }
    start(at) {
      trace.push([this.id, "start", at]);
    }
    stop(at) {
      trace.push([this.id, "stop", at]);
    }
  }
  class AudioContext {
    state = state;
    currentTime = 1;
    destination = {};
    closes = 0;
    constructor() {
      contexts.push(this);
    }
    createOscillator() {
      return new Node("oscillator");
    }
    createGain() {
      return new Node("gain");
    }
    resume() {
      return new Promise((resolve, reject) => {
        rejections.push(reject);
        operations.push(() => {
          if (this.state !== "closed") this.state = "running";
          resolve();
        });
      });
    }
    close() {
      this.closes++;
      this.state = "closed";
      return Promise.resolve();
    }
  }
  const window = {
    AudioContext,
    navigator: { userActivation: activation },
    localStorage: { getItem: () => "1", setItem: (...entry) => storage.push(entry) },
  };
  const exports =
    path.endsWith("/src/fx/sfx.ts") && !path.startsWith("/tmp/")
      ? "{sfx,isMuted,setMuted,setSoundPaused,clearSound,disposeSound,soundDiagnostics,resumeSound}"
      : "{sfx,isMuted,setMuted,setSoundPaused}";
  const sound = new Function(
    "window",
    "AudioContext",
    "Math",
    `${compile(path)};return ${exports};`,
  )(window, AudioContext, math);
  return { ...sound, nodes, contexts, operations, trace, storage, activation, rejections };
}
export function recipeTrace(path) {
  const f = soundFixture(path);
  f.sfx.serve();
  f.sfx.paddleHit(0);
  f.sfx.paddleHit(14);
  f.sfx.wall();
  f.sfx.score(true);
  f.sfx.score(false);
  f.sfx.win(true);
  f.sfx.win(false);
  return { graph: f.trace, types: f.nodes.map((node) => [node.kind, node.type]) };
}
test("actual audio cancel releases current and future oscillator/gain pairs once without waiting for ended", () => {
  const f = soundFixture();
  f.sfx.win(true);
  assert.equal(f.soundDiagnostics().ownedVoices, 4);
  f.clearSound();
  assert.equal(f.soundDiagnostics().ownedVoices, 0);
  assert.ok(f.nodes.every((node) => node.disconnected === 1));
  for (const node of f.nodes) node.dispatchEvent(new Event("ended"));
  assert.ok(f.nodes.every((node) => node.disconnected === 1));
  assert.equal(f.isMuted(), false);
  assert.equal(f.soundDiagnostics().paused, false);
  f.sfx.serve();
  assert.equal(f.soundDiagnostics().ownedVoices, 1);
  f.setSoundPaused(true);
  f.sfx.win(false);
  f.setMuted(false);
  assert.equal(f.nodes.length, 10);
  assert.equal(f.soundDiagnostics().ownedVoices, 0);
  f.disposeSound();
});
test("final audio disposal is permanent across late resume, callbacks, setters and input", async () => {
  const f = soundFixture();
  f.sfx.win(false);
  const context = f.contexts[0];
  f.disposeSound();
  f.disposeSound();
  assert.equal(context.closes, 1);
  assert.equal(context.state, "closed");
  const count = f.nodes.length,
    saved = f.storage.length;
  for (const complete of f.operations) complete();
  await Promise.resolve();
  f.setMuted(false);
  f.setSoundPaused(false);
  f.sfx.serve();
  f.sfx.win(true);
  assert.equal(f.nodes.length, count);
  assert.equal(f.contexts.length, 1);
  assert.equal(f.storage.length, saved);
  assert.equal(context.state, "closed");
  assert.equal(f.soundDiagnostics().disposed, true);
  assert.equal(f.soundDiagnostics().ownedVoices, 0);
  assert.ok(f.nodes.every((node) => node.disconnected === 1));
  assert.ok(Object.isFrozen(f.soundDiagnostics()));
});
test("disposing locked audio never creates a context; natural ended ownership also releases exactly once", () => {
  const locked = soundFixture();
  locked.disposeSound();
  locked.setMuted(false);
  locked.sfx.serve();
  assert.equal(locked.contexts.length, 0);
  const live = soundFixture();
  live.sfx.serve();
  live.nodes[0].dispatchEvent(new Event("ended"));
  live.disposeSound();
  assert.ok(live.nodes.every((node) => node.disconnected === 1));
});
test("original serve/contact/wall/point/win frequencies, envelopes and scheduled offsets remain exact", () => {
  const hash = createHash("sha256").update(JSON.stringify(recipeTrace())).digest("hex");
  assert.equal(hash, "8644676119d2e85b0018d3bcdb9a74edcda2597386aa967a171afdeec102e334");
});
test("passive locked contacts never create old notes; a permitted unlock is coalesced", async () => {
  const f = soundFixture(undefined, { state: "suspended" });
  for (let i = 0; i < 60; i++) f.sfx.paddleHit(i);
  assert.equal(f.nodes.length, 0);
  assert.equal(f.operations.length, 0, "no passive autoplay request waits for a future gesture");
  f.activation.isActive = true;
  f.setMuted(false);
  f.setMuted(false);
  for (let i = 0; i < 60; i++) f.sfx.paddleHit(i);
  assert.equal(f.operations.length, 1);
  assert.equal(f.nodes.length, 0);
  f.operations[0]();
  await Promise.resolve();
  assert.equal(f.nodes.length, 0, "old contact/serve/result calls never replay on unlock");
  f.sfx.serve();
  assert.equal(f.soundDiagnostics().ownedVoices, 1);
  f.disposeSound();
});
test("routine pressure never truncates point phrases; an intact result displaces whole lower phrases", () => {
  const f = soundFixture();
  for (let i = 0; i < 12; i++) f.sfx.serve();
  f.sfx.score(true);
  assert.equal(f.soundDiagnostics().ownedVoices, 12);
  assert.equal(f.nodes.filter((node) => node.kind === "oscillator").length, 14);
  f.sfx.win(true);
  assert.equal(f.soundDiagnostics().ownedVoices, 16);
  const before = f.nodes.length;
  f.sfx.paddleHit(12);
  assert.equal(f.nodes.length, before);
  f.sfx.win(false);
  assert.equal(f.nodes.length, before + 8);
  assert.equal(f.soundDiagnostics().ownedVoices, 16);
  f.disposeSound();
  assert.ok(f.nodes.every((node) => node.disconnected === 1));
});
test("a result with no lower-priority capacity is dropped whole", () => {
  const f = soundFixture();
  for (let i = 0; i < 4; i++) f.sfx.win(true);
  const before = f.nodes.length;
  f.sfx.win(false);
  assert.equal(f.nodes.length, before);
  assert.equal(f.soundDiagnostics().ownedVoices, 16);
  f.disposeSound();
});
test("rejected unlock cannot retry on contact ticks; a fresh native prime recovers without replay", async () => {
  const f = soundFixture(undefined, { state: "suspended", active: true });
  f.resumeSound();
  assert.equal(f.operations.length, 1);
  f.rejections[0](new Error("device not ready"));
  await Promise.resolve();
  // Transient activation can remain true for seconds after its event. It
  // must not make every automatic contact an explicit unlock retry.
  for (let i = 0; i < 40; i++) f.sfx.wall();
  assert.equal(f.operations.length, 1);
  assert.equal(f.nodes.length, 0);
  f.resumeSound();
  assert.equal(f.operations.length, 2);
  f.operations[1]();
  await Promise.resolve();
  assert.equal(f.nodes.length, 0);
  f.sfx.serve();
  assert.equal(f.soundDiagnostics().ownedVoices, 1);
  f.disposeSound();
});
test("mute, pause, practice clear and final disposal cannot replay a pending result after unlock", async () => {
  for (const operation of ["mute", "pause", "clear", "dispose"]) {
    const f = soundFixture(undefined, { state: "suspended", active: true });
    f.resumeSound();
    f.sfx.win(true);
    assert.equal(f.nodes.length, 0);
    if (operation === "mute") f.setMuted(true);
    if (operation === "pause") f.setSoundPaused(true);
    if (operation === "clear") f.clearSound();
    if (operation === "dispose") f.disposeSound();
    f.operations[0]();
    await Promise.resolve();
    assert.equal(f.nodes.length, 0);
    assert.equal(f.soundDiagnostics().ownedVoices, 0);
    assert.equal(f.soundDiagnostics().resumePending, false);
    f.disposeSound();
    assert.equal(f.contexts[0].closes, 1);
  }
});
test("early gesture priming allows a fresh serve and paused/unmuted sound remains quiet", async () => {
  const f = soundFixture(undefined, { state: "suspended" });
  f.setMuted(false);
  assert.equal(f.operations.length, 0);
  f.activation.isActive = true;
  f.resumeSound();
  f.operations[0]();
  await Promise.resolve();
  f.sfx.serve();
  assert.equal(f.soundDiagnostics().ownedVoices, 1);
  f.setSoundPaused(true);
  f.setMuted(true);
  f.setMuted(false);
  f.resumeSound();
  f.sfx.serve();
  assert.equal(f.soundDiagnostics().ownedVoices, 0);
  assert.equal(f.operations.length, 1);
  f.setSoundPaused(false);
  assert.equal(f.soundDiagnostics().ownedVoices, 0);
  f.sfx.serve();
  assert.equal(f.soundDiagnostics().ownedVoices, 1);
  f.disposeSound();
});
test("result eviction retires both voices of prior point phrases exactly once", () => {
  const f = soundFixture();
  for (let i = 0; i < 6; i++) f.sfx.score(true);
  f.sfx.win(true);
  f.sfx.win(false);
  assert.equal(f.soundDiagnostics().ownedVoices, 16);
  assert.ok(f.nodes.slice(0, 8).every((node) => node.disconnected === 1));
  assert.ok(f.nodes.slice(8).every((node) => node.disconnected === 0));
  assert.equal(f.soundDiagnostics().ownedPhrases, 6);
  f.disposeSound();
  assert.ok(f.nodes.every((node) => node.disconnected === 1));
});
