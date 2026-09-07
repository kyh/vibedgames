import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import test from "node:test";

const current = readFileSync(new URL("../src/input/camera.ts", import.meta.url), "utf8");
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
class Surface extends EventTarget {
  children = [];
  parent = null;
  id = "";
  style = {};
  attributes = new Map();
  width = 0;
  height = 0;
  videoWidth = 640;
  videoHeight = 480;
  currentTime = 0;
  readyState = 4;
  srcObject = null;
  disabled = false;
  listeners = new Map();
  classes = new Set();
  classList = {
    toggle: (name) => {
      if (this.classes.delete(name)) return false;
      this.classes.add(name);
      return true;
    },
    add: (name) => this.classes.add(name),
    remove: (name) => this.classes.delete(name),
    contains: (name) => this.classes.has(name),
  };
  append(...nodes) {
    for (const node of nodes) {
      this.children.push(node);
      node.parent = this;
    }
  }
  appendChild(node) {
    this.append(node);
  }
  remove() {
    if (this.parent) this.parent.children = this.parent.children.filter((node) => node !== this);
    this.parent = null;
  }
  setAttribute(name, value) {
    this.attributes.set(name, value);
  }
  addEventListener(type, callback, options) {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(callback);
    this.listeners.set(type, listeners);
    super.addEventListener(type, callback, options);
  }
  removeEventListener(type, callback, options) {
    this.listeners.get(type)?.delete(callback);
    super.removeEventListener(type, callback, options);
  }
  get listenerCount() {
    return [...this.listeners.values()].reduce((sum, value) => sum + value.size, 0);
  }
}
function setup({ coarse = false, source = current } = {}) {
  const rafs = new Map(),
    stages = [],
    models = [],
    drawings = [],
    streams = [],
    poses = [],
    drawing = [],
    timestamps = [];
  let nextRaf = 0,
    now = 1000;
  const config = {
    media: async () => {
      const stream = { stops: 0, getTracks: () => [{ stop: () => stream.stops++ }] };
      streams.push(stream);
      return stream;
    },
    play: async () => {},
    imports: async () => tasks,
    fileset: async () => ({}),
    model: async () => {
      const model = {
        closes: 0,
        next: [],
        error: null,
        close() {
          this.closes++;
        },
        detectForVideo(video, time) {
          timestamps.push(time);
          if (this.error) throw this.error;
          return { landmarks: this.next };
        },
      };
      models.push(model);
      return model;
    },
  };
  const tasks = {
    FilesetResolver: {
      forVisionTasks: (url) => {
        stages.push(["fileset", url]);
        return config.fileset();
      },
    },
    PoseLandmarker: {
      POSE_CONNECTIONS: [[0, 1]],
      createFromOptions: (fileset, options) => {
        stages.push(["model", options]);
        return config.model();
      },
    },
    DrawingUtils: class {
      closes = 0;
      constructor() {
        drawings.push(this);
      }
      close() {
        this.closes++;
      }
      drawLandmarks(landmarks, options) {
        drawing.push(["points", landmarks, options]);
      }
      drawConnectors(landmarks, connections, options) {
        drawing.push(["lines", landmarks, connections, options]);
      }
    },
  };
  const body = new Surface();
  const context = { clearRect: (...args) => drawing.push(["clear", ...args]) };
  const document = {
    body,
    getElementById: (id) => body.children.find((node) => node.id === id) ?? null,
    createElement: (tag) => {
      const element = new Surface();
      if (tag === "video") {
        element.play = () => {
          stages.push(["play"]);
          return config.play();
        };
        element.pause = () => {};
      }
      if (tag === "canvas") element.getContext = () => context;
      return element;
    },
  };
  const deps = {
    document,
    isCoarsePointer: () => coarse,
    navigator: {
      mediaDevices: {
        getUserMedia: (options) => {
          stages.push(["media", options]);
          return config.media();
        },
      },
    },
    performance: { now: () => now },
    requestAnimationFrame: (callback) => {
      const id = ++nextRaf;
      rafs.set(id, callback);
      return id;
    },
    cancelAnimationFrame: (id) => rafs.delete(id),
    loadTasks: () => {
      stages.push(["import"]);
      return config.imports();
    },
    console: { error: (...args) => stages.push(["error", args[0]]) },
    MediaStream: Surface,
  };
  const code = stripTypeScriptTypes(source)
    .replace(/^import[^;]+;\n/gm, "")
    .replace(/^export /gm, "")
    .replace('import("@mediapipe/tasks-vision")', "loadTasks()");
  const Camera = new Function(...Object.keys(deps), `${code};return PoseCamera;`)(
    ...Object.values(deps),
  );
  const camera = new Camera((pose, overlay) => {
    assert.equal(overlay, context);
    poses.push(structuredClone(pose));
    config.onPose?.();
  });
  const frame = (time, videoTime) => {
    now = time;
    camera.video.currentTime = videoTime;
    const pending = [...rafs.values()];
    rafs.clear();
    pending.forEach((callback) => callback());
  };
  return {
    camera,
    config,
    stages,
    models,
    drawings,
    streams,
    poses,
    drawing,
    timestamps,
    body,
    rafs,
    frame,
  };
}
const landmarks = (offset) =>
  Array.from({ length: 33 }, (_, index) => ({
    x: (index + offset) / 40,
    y: (33 - index) / 40,
    z: index / 100,
    visibility: index % 3 ? 0.9 : 0.2,
  }));

test("native button retries denial on fine and coarse pointers; one live camera owns one drawing helper", async () => {
  for (const coarse of [false, true]) {
    const h = setup({ coarse });
    const media = h.config.media;
    h.config.media = async () => {
      throw new Error("denied");
    };
    await h.camera.start();
    assert.equal(h.camera.diagnostics().state, "unavailable");
    assert.equal(h.stages.filter(([stage]) => stage === "import").length, 0);
    assert.match(h.camera.toggle.attributes.get("aria-label"), /Retry/);
    h.config.media = media;
    h.camera.toggle.dispatchEvent(new Event("click"));
    await settle();
    assert.equal(h.camera.diagnostics().state, "live");
    assert.deepEqual(
      h.stages.filter(([stage]) => stage !== "error").map(([stage]) => stage),
      ["media", "media", "play", "import", "fileset", "model"],
    );
    h.models[0].next = [landmarks(0)];
    for (let i = 1; i <= 4; i++) h.frame(1000 + i, i / 30);
    assert.equal(h.drawings.length, 1);
    assert.equal(h.poses.length, 4);
    assert.equal(h.rafs.size, 1);
    const mediaCount = h.stages.filter(([stage]) => stage === "media").length;
    h.camera.toggle.dispatchEvent(new Event("click"));
    await h.camera.start();
    assert.equal(h.stages.filter(([stage]) => stage === "media").length, mediaCount);
    assert.equal(h.camera.diagnostics().stream, true);
    h.camera.destroy();
    h.camera.destroy();
    await h.camera.start();
    assert.equal(h.models[0].closes, 1);
    assert.equal(h.drawings[0].closes, 1);
    assert.equal(h.streams[0].stops, 1);
    assert.equal(h.rafs.size, 0);
    assert.equal(h.body.children.length, 0);
    assert.equal(h.camera.toggle.listenerCount, 0);
  }
});

test("each pending startup stage releases only its owner after final destruction", async () => {
  for (const stage of ["media", "play", "imports", "fileset", "model"]) {
    const h = setup(),
      wait = deferred();
    const original = h.config[stage];
    h.config[stage] = () => wait.promise;
    const start = h.camera.start();
    await settle();
    h.camera.destroy();
    wait.resolve(await original());
    await start;
    await settle();
    assert.equal(h.camera.diagnostics().state, "destroyed", stage);
    assert.equal(h.camera.diagnostics().stream, false, stage);
    assert.equal(h.camera.diagnostics().model, false, stage);
    assert.equal(h.rafs.size, 0, stage);
    for (const stream of h.streams) assert.equal(stream.stops, 1, stage);
    for (const model of h.models) assert.equal(model.closes, 1, stage);
    assert.equal(h.body.children.length, 0, stage);
  }
});

test("video/model/detection failures are retryable and stale callbacks cannot revive the old attempt", async () => {
  for (const stage of ["play", "fileset", "model"]) {
    const h = setup(),
      original = h.config[stage];
    h.config[stage] = async () => {
      throw new Error(stage);
    };
    await h.camera.start();
    assert.equal(h.camera.diagnostics().state, "unavailable");
    assert.equal(h.streams[0].stops, 1);
    h.config[stage] = original;
    await h.camera.start();
    assert.equal(h.camera.diagnostics().state, "live");
    h.camera.destroy();
  }
  const h = setup();
  await h.camera.start();
  const stale = [...h.rafs.values()][0];
  h.models[0].error = new Error("detector");
  h.frame(1001, 1);
  assert.equal(h.camera.diagnostics().state, "unavailable");
  assert.equal(h.rafs.size, 0);
  await h.camera.start();
  const before = h.camera.diagnostics();
  stale();
  assert.deepEqual(h.camera.diagnostics(), before);
  assert.equal(h.rafs.size, 1);
  h.config.onPose = () => h.camera.destroy();
  h.models[1].next = [landmarks(0)];
  h.frame(1002, 2);
  assert.equal(h.camera.diagnostics().state, "destroyed");
  assert.equal(h.rafs.size, 0);
  assert.equal(h.models[1].closes, 1);
  assert.equal(h.drawings.at(-1).closes, 1);
});

async function trace(source) {
  const h = setup({ source });
  await h.camera.start();
  h.poses.length = 0;
  h.drawing.length = 0;
  h.timestamps.length = 0;
  for (let i = 1; i <= 160; i++) {
    h.camera.video.readyState = i % 17 === 0 ? 3 : 4;
    h.models[0].next = i % 11 === 0 ? [] : [landmarks(i / 100)];
    h.frame(1000 + Math.floor(i / 3), Math.floor(i / 2) / 30);
  }
  return { poses: h.poses, drawing: h.drawing, timestamps: h.timestamps };
}
test("original keypoint conversion, skeleton order and detection timestamp/cadence stay exact", async () => {
  const actual = await trace(current);
  if (process.env.TETRIS_CAMERA_BASELINE)
    assert.deepEqual(actual, await trace(readFileSync(process.env.TETRIS_CAMERA_BASELINE, "utf8")));
  const digest = createHash("sha256").update(JSON.stringify(actual)).digest("hex");
  // Pinned after full equality against the immutable pre-completion source.
  assert.equal(digest, "c5aa20c93b3f05c7de7998a7fbec7be0460962ee49fae11f46633330b81f7c7b");
});
