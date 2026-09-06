import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { poseStatus } from "../src/input/pose-status.ts";

export function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
export async function settle() {
  for (let i = 0; i < 12; i++) await Promise.resolve();
}
export function compile(path) {
  return stripTypeScriptTypes(readFileSync(new URL(path, import.meta.url), "utf8"), {
    mode: "transform",
  })
    .replace(/^import[\s\S]*?;\s*/gm, "")
    .replace(/^export /gm, "");
}
export class Element extends EventTarget {
  classes = new Set();
  children = [];
  attributes = new Map();
  textContent = "";
  parent = null;
  removed = 0;
  readyState = 0;
  videoWidth = 640;
  videoHeight = 480;
  currentTime = 0;
  srcObject = null;
  plays = 0;
  pauses = 0;
  playResult = null;
  listenerRecords = new Map();
  context = { clearRect() {} };
  styleValues = new Map();
  style = {
    setProperty: (key, value) => this.styleValues.set(key, value),
    removeProperty: (key) => this.styleValues.delete(key),
  };
  set className(value) {
    this.classes = new Set(value.split(" "));
  }
  get className() {
    return [...this.classes].join(" ");
  }
  classList = {
    add: (...names) => names.forEach((name) => this.classes.add(name)),
    remove: (...names) => names.forEach((name) => this.classes.delete(name)),
    contains: (name) => this.classes.has(name),
    toggle: (name, on = !this.classes.has(name)) =>
      on ? this.classes.add(name) : this.classes.delete(name),
  };
  addEventListener(name, callback, options) {
    if (!this.listenerRecords.has(name)) this.listenerRecords.set(name, new Set());
    this.listenerRecords.get(name).add(callback);
    options?.signal?.addEventListener(
      "abort",
      () => this.listenerRecords.get(name)?.delete(callback),
      { once: true },
    );
    super.addEventListener(name, callback, options);
  }
  removeEventListener(name, callback, options) {
    this.listenerRecords.get(name)?.delete(callback);
    super.removeEventListener(name, callback, options);
  }
  get listenerCount() {
    return [...this.listenerRecords.values()].reduce((count, set) => count + set.size, 0);
  }
  append(...children) {
    for (const child of children) {
      child.parent = this;
      this.children.push(child);
    }
  }
  appendChild(child) {
    this.append(child);
    return child;
  }
  replaceChildren(...children) {
    this.children = [];
    this.append(...children);
  }
  setAttribute(name, value) {
    this.attributes.set(name, value);
  }
  remove() {
    this.removed++;
    if (this.parent) this.parent.children = this.parent.children.filter((child) => child !== this);
    this.parent = null;
  }
  getBoundingClientRect() {
    return { height: 120 };
  }
  getContext() {
    return this.context;
  }
  play() {
    this.plays++;
    return this.playResult ?? Promise.resolve();
  }
  pause() {
    this.pauses++;
  }
  blur() {}
  click() {
    this.dispatchEvent(new Event("click", { bubbles: true }));
  }
}
export function cameraFixture(path = "../src/input/camera.ts", coarse = true) {
  const media = [],
    vision = [],
    models = [],
    drawers = [],
    observers = [],
    frames = new Map(),
    elements = [],
    jumps = [],
    clock = { now: 1000 };
  let rafId = 0;
  const document = {
    body: new Element(),
    head: new Element(),
    documentElement: new Element(),
    createElement() {
      const element = new Element();
      elements.push(element);
      return element;
    },
    getElementById(id) {
      return elements.find((element) => element.id === id && element.parent !== null) ?? null;
    },
  };
  const window = { innerWidth: 1280, innerHeight: 800, matchMedia: () => ({ matches: coarse }) };
  class ResizeObserver {
    disconnected = 0;
    constructor(callback) {
      this.callback = callback;
      observers.push(this);
    }
    observe(root) {
      this.root = root;
    }
    disconnect() {
      this.disconnected++;
    }
  }
  class DrawingUtils {
    closed = 0;
    constructor() {
      drawers.push(this);
    }
    drawLandmarks() {}
    drawConnectors() {}
    close() {
      this.closed++;
    }
  }
  const dependencies = {
    document,
    window,
    ResizeObserver,
    DrawingUtils,
    poseStatus,
    navigator: {
      mediaDevices: {
        getUserMedia(options) {
          const request = deferred();
          media.push({ ...request, options });
          return request.promise;
        },
      },
    },
    FilesetResolver: {
      forVisionTasks(url) {
        const request = deferred();
        vision.push({ ...request, url });
        return request.promise;
      },
    },
    PoseLandmarker: {
      POSE_CONNECTIONS: [],
      createFromOptions(fileset, options) {
        const request = deferred();
        models.push({ ...request, fileset, options });
        return request.promise;
      },
    },
    performance: { now: () => clock.now },
    requestAnimationFrame: (fn) => {
      frames.set(++rafId, fn);
      return rafId;
    },
    cancelAnimationFrame: (id) => frames.delete(id),
  };
  const code = compile(path);
  const finalApi = code.includes("function disposePoseCamera") ? ",disposePoseCamera" : "";
  const api = new Function(
    ...Object.keys(dependencies),
    `${code};return {PoseCamera,buildPanel,initPoseCamera,setPoseLocked,recalibratePose,get active(){return active;}${finalApi}};`,
  )(...Object.values(dependencies));
  return {
    ...dependencies,
    api,
    media,
    vision,
    models,
    drawers,
    observers,
    frames,
    elements,
    jumps,
    clock,
    init() {
      api.initPoseCamera((...jump) => jumps.push(jump));
      return api.active;
    },
    detector() {
      return new api.PoseCamera(
        api.buildPanel(document.body, false),
        (...jump) => jumps.push(jump),
        false,
      );
    },
    frame() {
      const next = frames.entries().next().value;
      if (!next) return;
      frames.delete(next[0]);
      next[1]();
    },
  };
}
export function stream() {
  const track = {
    stopped: 0,
    stop() {
      this.stopped++;
    },
  };
  return { track, getTracks: () => [track] };
}
export function model() {
  return {
    closed: 0,
    calls: [],
    result: { landmarks: [] },
    close() {
      this.closed++;
    },
    detectForVideo(video, time) {
      this.calls.push([video.currentTime, time]);
      return this.result;
    },
  };
}
export async function connect(f, camera = f.api.active) {
  const feed = stream();
  f.media.at(-1).resolve(feed);
  await settle();
  camera.ui.video.readyState = 4;
  camera.ui.video.dispatchEvent(new Event("loadedmetadata"));
  await settle();
  f.vision.at(-1).resolve({});
  await settle();
  const tracker = model();
  f.models.at(-1).resolve(tracker);
  await settle();
  return { feed, tracker };
}
