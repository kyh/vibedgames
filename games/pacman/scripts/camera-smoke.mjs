import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { stripTypeScriptTypes } from "node:module";
import test from "node:test";
import * as constants from "../src/shared/constants.ts";

const current = readFileSync(new URL("../src/input/face-camera.ts", import.meta.url), "utf8");
const settle = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve();
};
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
class Element extends EventTarget {
  style = {};
  width = 0;
  height = 0;
  videoWidth = 640;
  videoHeight = 480;
  readyState = 0;
  currentTime = 0;
  srcObject = null;
  pauses = 0;
  textContent = "";
  play() {
    return Promise.resolve();
  }
  pause() {
    this.pauses++;
  }
  getContext() {
    return { save() {}, restore() {}, clearRect() {} };
  }
}
function harness(source = current) {
  const frame = new Map();
  const calls = {
    media: 0,
    imports: 0,
    fileset: 0,
    models: [],
    drawings: [],
    stops: 0,
    events: [],
    states: [],
  };
  let now = 1000,
    nextRaf = 0;
  const video = new Element(),
    overlay = new Element(),
    status = new Element();
  const stream = { getTracks: () => [{ stop: () => calls.stops++ }] };
  const config = {
    media: async () => stream,
    fileset: async () => ({}),
    model: async () => {
      const model = {
        closes: 0,
        next: { faceLandmarks: [] },
        detects: 0,
        close() {
          this.closes++;
        },
        detectForVideo() {
          this.detects++;
          if (this.error) throw this.error;
          return this.next;
        },
      };
      calls.models.push(model);
      return model;
    },
  };
  class Drawing {
    closes = 0;
    constructor() {
      calls.drawings.push(this);
    }
    close() {
      this.closes++;
    }
    drawConnectors() {}
  }
  const deps = {
    ...constants,
    IS_TOUCH: false,
    navigator: {
      mediaDevices: {
        getUserMedia: () => {
          calls.media++;
          return config.media();
        },
      },
    },
    performance: { now: () => now },
    console: { warn() {} },
    window: {
      requestAnimationFrame: (cb) => {
        frame.set(++nextRaf, cb);
        return nextRaf;
      },
      cancelAnimationFrame: (id) => frame.delete(id),
    },
    visionLoader: async () => {
      calls.imports++;
      return {
        DrawingUtils: Drawing,
        FilesetResolver: {
          forVisionTasks: () => {
            calls.fileset++;
            return config.fileset();
          },
        },
        FaceLandmarker: { createFromOptions: config.model },
      };
    },
  };
  const code = source
    .replace(/^import[^]*?;\n/gm, "")
    .replace('await import("@mediapipe/tasks-vision")', "await visionLoader()")
    .replaceAll("export ", "");
  const Camera = new Function(
    "deps",
    `${stripTypeScriptTypes(`const {${Object.keys(deps).join(",")}}=deps;\n${code}`, { mode: "strip" })};return FaceCamera;`,
  )(deps);
  const camera = new Camera({
    video,
    overlay,
    status,
    onState: (state) => calls.states.push(state),
    onMouthChange: (open) => calls.events.push([now, "mouth", open]),
    onHeadTurnLeft: () => calls.events.push([now, "left"]),
    onHeadTurnRight: () => calls.events.push([now, "right"]),
  });
  return {
    camera,
    calls,
    config,
    video,
    frame,
    async start() {
      await camera.start();
      video.readyState = 2;
      video.dispatchEvent(new Event("loadeddata"));
    },
    tick(time, result, advance = true) {
      now = time;
      if (advance) video.currentTime++;
      const model = calls.models.at(-1);
      if (model) model.next = result;
      const entries = [...frame];
      frame.clear();
      for (const [, cb] of entries) cb();
    },
  };
}
function face(mouth = false, head = "center") {
  const points = Array.from({ length: 455 }, () => ({ x: 0.5, y: 0.5, z: 0 }));
  points[10].y = 0.2;
  points[152].y = 0.8;
  points[13].y = 0.45;
  points[14].y = mouth ? 0.52 : 0.48;
  points[234].x = 0.2;
  points[454].x = 0.8;
  points[4].x = head === "left" ? 0.65 : head === "right" ? 0.35 : 0.5;
  return { faceLandmarks: [points] };
}
async function trace(source) {
  const h = harness(source);
  await h.start();
  for (let i = 0; i < 600; i++) {
    const head = i % 120 < 45 ? "left" : i % 120 < 90 ? "right" : "center";
    h.tick(1000 + i * 17, i % 41 < 4 ? { faceLandmarks: [] } : face(i % 13 < 6, head), i % 3 !== 0);
  }
  return {
    events: h.calls.events,
    hash: createHash("sha256").update(JSON.stringify(h.calls.events)).digest("hex"),
  };
}

test("camera denial retries before model costs; readiness follows real face results", async () => {
  const h = harness();
  h.config.media = async () => {
    throw new Error("denied");
  };
  await h.camera.start();
  assert.equal(h.calls.imports, 0);
  assert.equal(h.camera.diagnostics().state.kind, "unavailable");
  h.config.media = async () => ({ getTracks: () => [{ stop: () => h.calls.stops++ }] });
  await h.start();
  assert.deepEqual(h.camera.diagnostics().state, { kind: "live", tracking: false });
  h.tick(1200, face());
  assert.deepEqual(h.camera.diagnostics().state, { kind: "live", tracking: true });
  h.tick(1300, { faceLandmarks: [] });
  assert.equal(h.camera.diagnostics().state.tracking, false);
  assert.equal(h.frame.size, 1);
  h.camera.dispose();
  assert.equal(h.frame.size, 0);
});
test("late media and model completions release once after stop/dispose", async () => {
  const h = harness(),
    media = deferred();
  h.config.media = () => media.promise;
  const start = h.camera.start();
  h.camera.dispose();
  media.resolve({ getTracks: () => [{ stop: () => h.calls.stops++ }] });
  await start;
  assert.equal(h.calls.stops, 1);
  assert.equal(h.calls.imports, 0);
  await h.camera.start();
  assert.equal(h.calls.media, 1);
  const m = harness(),
    late = deferred();
  m.config.model = () => late.promise;
  const pending = m.camera.start();
  await settle();
  assert.equal(m.calls.drawings.length, 1);
  m.camera.stop();
  let closed = 0;
  late.resolve({ close: () => closed++ });
  await pending;
  assert.equal(closed, 1);
  assert.equal(m.calls.drawings[0].closes, 1);
  assert.equal(m.calls.stops, 1);
  assert.equal(m.frame.size, 0);
  assert.equal(m.camera.diagnostics().state.kind, "idle");
  m.camera.dispose();
  assert.equal(closed, 1);
});
test("play/model failures and detector throws clean up and permit one retry loop", async () => {
  const h = harness();
  h.video.play = async () => {
    throw new Error("play failed");
  };
  await h.camera.start();
  assert.equal(h.camera.diagnostics().state.kind, "unavailable");
  assert.equal(h.calls.models[0].closes, 1);
  assert.equal(h.calls.drawings[0].closes, 1);
  h.video.dispatchEvent(new Event("loadeddata"));
  assert.equal(h.frame.size, 0);
  h.video.play = async () => {};
  await h.start();
  const oldFrame = [...h.frame.values()][0];
  h.calls.models.at(-1).error = new Error("detector failed");
  h.tick(1400, face());
  assert.equal(h.camera.diagnostics().state.kind, "unavailable");
  assert.equal(h.frame.size, 0);
  await h.start();
  oldFrame();
  assert.equal(h.frame.size, 1, "stale callback cannot erase a new owner's RAF");
  h.tick(1800, face());
  assert.ok(h.calls.events.length > 0);
  h.camera.dispose();
  for (const model of h.calls.models) assert.equal(model.closes, 1);
  for (const drawing of h.calls.drawings) assert.equal(drawing.closes, 1);
});
test("paused recognition stays live; held mouth/head need neutral before resume action", async () => {
  const h = harness();
  await h.start();
  h.camera.setActionsPaused(true);
  h.tick(2000, face(true, "left"));
  h.tick(2400, face(true, "left"));
  assert.equal(h.calls.events.length, 0);
  assert.equal(h.calls.models[0].detects, 3);
  h.camera.setActionsPaused(false);
  h.tick(2800, face(true, "left"));
  assert.equal(h.calls.events.length, 0);
  h.tick(3200, face(false, "center"));
  assert.deepEqual(h.calls.events.at(-1), [3200, "mouth", false]);
  h.tick(3600, face(true, "left"));
  assert.deepEqual(h.calls.events.slice(-2), [
    [3600, "mouth", true],
    [3600, "left"],
  ]);
  h.camera.dispose();
});
test("pending fileset and disposal from a live callback cannot continue capture", async () => {
  const h = harness();
  const fileset = deferred();
  h.config.fileset = () => fileset.promise;
  const pending = h.camera.start();
  await settle();
  assert.equal(h.calls.fileset, 1);
  h.camera.dispose();
  fileset.resolve({});
  await pending;
  assert.equal(h.calls.models.length, 0);
  assert.equal(h.calls.drawings[0].closes, 1);
  assert.equal(h.calls.stops, 1);
  const live = harness();
  await live.start();
  live.camera.opts.onMouthChange = () => live.camera.dispose();
  live.tick(2000, face(true, "left"));
  assert.equal(live.frame.size, 0);
  assert.equal(live.calls.models[0].closes, 1);
  assert.equal(live.calls.events.length, 0, "head callback after disposal is suppressed");
});
test("600-frame mouth/head/held-repeat trace matches original detector and order", async () => {
  const output = await trace(current);
  if (process.env.PACMAN_CAMERA_BASELINE) {
    const before = await trace(readFileSync(process.env.PACMAN_CAMERA_BASELINE, "utf8"));
    assert.deepEqual(output.events, before.events);
    console.log(
      JSON.stringify({ detectorEvents: output.events.length, baselineHash: before.hash }),
    );
  }
  assert.equal(output.hash, "8226c13a52b8b0aeb291fb8d847cccb6454ef37b07d6303407a4f3ad13d5e2a3");
});
