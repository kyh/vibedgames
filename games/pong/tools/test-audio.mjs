import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { compile } from "./scene-harness.mjs";

export function soundFixture(path = "../src/fx/sfx.ts") {
  const nodes = [],
    trace = [],
    contexts = [],
    operations = [],
    storage = [];
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
    state = "suspended";
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
      return new Promise((resolve) =>
        operations.push(() => {
          if (this.state !== "closed") this.state = "running";
          resolve();
        }),
      );
    }
    close() {
      this.closes++;
      this.state = "closed";
      return Promise.resolve();
    }
  }
  const window = {
    AudioContext,
    localStorage: { getItem: () => "1", setItem: (...entry) => storage.push(entry) },
  };
  const exports =
    path.endsWith("/src/fx/sfx.ts") && !path.startsWith("/tmp/")
      ? "{sfx,isMuted,setMuted,setSoundPaused,clearSound,disposeSound,soundDiagnostics}"
      : "{sfx,isMuted,setMuted,setSoundPaused}";
  const sound = new Function(
    "window",
    "AudioContext",
    "Math",
    `${compile(path)};return ${exports};`,
  )(window, AudioContext, math);
  return { ...sound, nodes, contexts, operations, trace, storage };
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
