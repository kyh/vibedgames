import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { test } from "node:test";

// Execute the actual panel/async owner with controlled media/model promises.
// Native browser activation is covered separately; these fixtures test races.
const source = stripTypeScriptTypes(
  readFileSync(new URL("../src/input/camera.ts", import.meta.url), "utf8"),
)
  .replace(/^import[^;]*;\s*/gm, "")
  .replace('import("@mediapipe/tasks-vision")', "loadVision()")
  .replace(/^export /gm, "");
const settle = async () => {
  for (let i = 0; i < 16; i++) await Promise.resolve();
};
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function harness({ coarse = false } = {}) {
  const elements = [],
    frames = new Map(),
    requests = [],
    models = [],
    logs = [],
    wrists = [];
  let nextFrame = 0,
    now = 1000,
    fists = 0,
    result = { landmarks: [], gestures: [] };
  let modelResult = null,
    playResult = null;
  class Element extends EventTarget {
    dataset = {};
    attributes = new Map();
    currentTime = 0;
    videoWidth = 320;
    videoHeight = 240;
    srcObject = null;
    removed = false;
    paused = 0;
    closed = 0;
    constructor(tag) {
      super();
      this.tag = tag;
      elements.push(this);
    }
    setAttribute(key, value) {
      this.attributes.set(key, value);
    }
    append() {}
    remove() {
      this.removed = true;
    }
    pause() {
      this.paused++;
    }
    play() {
      return playResult ?? Promise.resolve();
    }
    getContext() {
      return { clearRect() {}, save() {}, restore() {} };
    }
  }
  const vision = {
    FilesetResolver: { forVisionTasks: async () => ({}) },
    GestureRecognizer: class {
      static HAND_CONNECTIONS = [];
      static async createFromOptions(_files, options) {
        assert.equal(options.runningMode, "VIDEO");
        assert.equal(options.numHands, 1);
        const model = modelResult ? await modelResult : new this();
        models.push(model);
        return model;
      }
      closed = 0;
      timestamps = [];
      close() {
        this.closed++;
      }
      recognizeForVideo(_video, time) {
        this.timestamps.push(time);
        return result;
      }
    },
    DrawingUtils: class {
      close() {}
      drawConnectors() {}
      drawLandmarks() {}
    },
  };
  const api = new Function(
    "document",
    "navigator",
    "loadVision",
    "performance",
    "requestAnimationFrame",
    "cancelAnimationFrame",
    "console",
    "COARSE_INPUT",
    "CLICK_DRAG_TOLERANCE_PX",
    "HAND_TIMEOUT_MS",
    `${source};return {createHandCamera,handCameraState,watchHandCamera};`,
  )(
    { createElement: (tag) => new Element(tag), body: { appendChild() {} } },
    {
      mediaDevices: {
        getUserMedia: () => {
          const request = deferred();
          requests.push(request);
          return request.promise;
        },
      },
    },
    async () => vision,
    { now: () => now },
    (callback) => {
      frames.set(++nextFrame, callback);
      return nextFrame;
    },
    (id) => frames.delete(id),
    { error: (...args) => logs.push(args) },
    coarse,
    6,
    500,
  );
  const camera = api.createHandCamera(
    (x) => wrists.push(x),
    () => fists++,
  );
  const panel = elements.find((e) => e.tag === "button"),
    video = elements.find((e) => e.tag === "video");
  function stream() {
    const track = {
      stopped: 0,
      stop() {
        this.stopped++;
      },
    };
    return { track, getTracks: () => [track] };
  }
  function frame(ms = 17) {
    now += ms;
    video.currentTime += ms / 1000;
    const work = [...frames.values()];
    frames.clear();
    for (const callback of work) callback(now);
  }
  return {
    api,
    camera,
    panel,
    video,
    requests,
    models,
    logs,
    wrists,
    frames,
    stream,
    frame,
    setResult(next) {
      result = next;
    },
    setModelPromise(value) {
      modelResult = value;
    },
    setPlayPromise(value) {
      playResult = value;
    },
    get fists() {
      return fists;
    },
  };
}

test("denial releases the model; retry owns exactly one stream/model/RAF", async () => {
  const h = harness();
  h.camera.enable();
  h.camera.enable();
  await settle();
  assert.equal(h.requests.length, 1);
  h.requests[0].reject(new Error("permission denied"));
  await settle();
  assert.equal(h.api.handCameraState(), "error");
  assert.equal(h.models[0].closed, 1);
  assert.equal(h.panel.attributes.get("aria-label"), "Retry hand control camera");
  h.camera.enable();
  await settle();
  const media = h.stream();
  h.requests[1].resolve(media);
  await settle();
  assert.equal(h.api.handCameraState(), "live");
  assert.equal(h.frames.size, 1);
  h.camera.enable();
  assert.equal(h.requests.length, 2);
  h.camera.stop();
  h.camera.stop();
  assert.equal(media.track.stopped, 1);
  assert.equal(h.models[1].closed, 1);
  assert.equal(h.frames.size, 0);
  assert.equal(h.video.srcObject, null);
  assert.equal(h.api.handCameraState(), "off");
  assert.equal(h.panel.removed, true);
});

test("late rejected media after final stop cannot publish a false error", async () => {
  const h = harness(),
    states = [];
  h.api.watchHandCamera((state) => states.push(state));
  h.camera.enable();
  await settle();
  h.camera.stop();
  h.requests[0].reject(new Error("late rejection"));
  await settle();
  assert.deepEqual(states, ["loading", "off"]);
  assert.deepEqual(h.logs, []);
  assert.equal(h.models[0].closed, 1);
});

test("late successful media is released after final stop", async () => {
  const h = harness();
  h.camera.enable();
  await settle();
  h.camera.stop();
  const media = h.stream();
  h.requests[0].resolve(media);
  await settle();
  assert.equal(media.track.stopped, 1);
  assert.equal(h.video.srcObject, null);
  assert.equal(h.frames.size, 0);
  assert.equal(h.api.handCameraState(), "off");
});

test("late model creation closes its own model and never asks for media", async () => {
  const h = harness(),
    pending = deferred();
  h.setModelPromise(pending.promise);
  h.camera.enable();
  await settle();
  h.camera.stop();
  const model = {
    closed: 0,
    close() {
      this.closed++;
    },
  };
  pending.resolve(model);
  await settle();
  assert.equal(model.closed, 1);
  assert.equal(h.requests.length, 0);
  assert.deepEqual(h.logs, []);
});

test("a rejected play releases an opened stream and remains retryable", async () => {
  const h = harness(),
    play = deferred();
  h.setPlayPromise(play.promise);
  h.camera.enable();
  await settle();
  const media = h.stream();
  h.requests[0].resolve(media);
  await settle();
  play.reject(new Error("decoder failure"));
  await settle();
  assert.equal(h.api.handCameraState(), "error");
  assert.equal(media.track.stopped, 1);
  assert.equal(h.models[0].closed, 1);
  assert.equal(h.video.srcObject, null);
});

test("feed readiness, hand freshness, fist edge and recognition cadence remain honest", async () => {
  for (const coarse of [false, true]) {
    const h = harness({ coarse });
    h.camera.enable();
    await settle();
    h.requests[0].resolve(h.stream());
    await settle();
    assert.equal(h.panel.dataset.tracking, "waiting");
    const before = h.models[0].timestamps.length;
    h.setResult({
      landmarks: [[{ x: 0.25, y: 0.4, z: 0 }]],
      gestures: [[{ categoryName: "Closed_Fist" }]],
    });
    for (let i = 0; i < 4; i++) h.frame();
    assert.equal(h.models[0].timestamps.length - before, coarse ? 2 : 4);
    assert.equal(h.panel.dataset.tracking, "tracked");
    assert.equal(h.fists, 1);
    assert.ok(h.wrists.every((x) => x === 0.25));
    h.setResult({ landmarks: [], gestures: [] });
    h.frame(250);
    h.frame(251);
    assert.equal(h.panel.dataset.tracking, "lost");
    assert.equal(h.api.handCameraState(), "live");
    h.setResult({ landmarks: [[{ x: 0.7 }]], gestures: [[{ categoryName: "Closed_Fist" }]] });
    h.frame(400);
    h.frame();
    assert.equal(h.fists, 2);
    const times = h.models[0].timestamps;
    assert.ok(times.every((time, i) => i === 0 || time > times[i - 1]));
    h.camera.stop();
  }
});
