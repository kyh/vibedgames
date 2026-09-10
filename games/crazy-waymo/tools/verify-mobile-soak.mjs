// Sustained real-touch road driving. Owned headed Chrome; desktop stress proxy only.
// node tools/verify-mobile-soak.mjs [dev-url] [output] --minutes=5 --cpu=4
// Options: --minutes=5..10, --multi-draw, --tier=0..4, --smoke (28 timed seconds).
// Duration means steady driving time. Loading, resets, pauses and captures add wall time.
/* eslint-disable unicorn/consistent-function-scoping */
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { createMobileSession } from "./mobile-browser-session.mjs";

// Self-contained: installed into the page without imports or source changes.
const installMetrics = () => {
  const { game } = window.__taxi;
  const renderer = window.__renderer;
  const histogram = (step = 0.25, bins = 4096) => {
    const counts = new Uint32Array(bins + 1);
    let count = 0;
    let sum = 0;
    let max = 0;
    let over33 = 0;
    let over50 = 0;
    let over100 = 0;
    return {
      add(value) {
        if (!Number.isFinite(value) || value < 0) {
          return;
        }
        counts[Math.min(bins, Math.floor(value / step))] += 1;
        count += 1;
        sum += value;
        max = Math.max(max, value);
        if (value > 33.4) {
          over33 += 1;
        }
        if (value > 50) {
          over50 += 1;
        }
        if (value > 100) {
          over100 += 1;
        }
      },
      summary() {
        const percentile = (fraction) => {
          if (!count) {
            return null;
          }
          const target = Math.ceil(count * fraction);
          let total = 0;
          for (let index = 0; index < counts.length; index += 1) {
            total += counts[index];
            if (total >= target) {
              return index === bins ? max : index * step;
            }
          }
          return max;
        };
        return {
          count,
          max,
          mean: count ? sum / count : null,
          median: percentile(0.5),
          over100,
          over33,
          over50,
          overflow: counts[bins],
          p95: percentile(0.95),
          p99: percentile(0.99),
          resolution: step,
        };
      },
    };
  };
  const audit = {
    active: false,
    contextLost: false,
    current: null,
    sampledSerial: -1,
    start() {
      this.current = {
        calls: histogram(1, 8192),
        distance: 0,
        frame: histogram(),
        frames: 0,
        invalid: 0,
        lastX: null,
        lastZ: null,
        longTasks: { count: 0, maxMs: 0, totalMs: 0 },
        moving: 0,
        previous: 0,
        render: histogram(),
        started: performance.now(),
        stream: histogram(),
        tiers: new Uint32Array(5),
        triangles: histogram(1000, 8192),
        update: histogram(),
      };
      this.sampledSerial = this.updateSerial;
      this.active = true;
    },
    stop() {
      this.active = false;
      const { current } = this;
      if (!current) {
        throw new Error("No active soak window");
      }
      current.previous = 0;
      return {
        calls: current.calls.summary(),
        distance: current.distance,
        frameMs: current.frame.summary(),
        invalidMotionFrames: current.invalid,
        longTasks: current.longTasks,
        movingFrames: current.moving,
        presentedFrames: current.frames,
        renderMs: current.render.summary(),
        steadyMs: performance.now() - current.started,
        streamMs: current.stream.summary(),
        tierFrames: [...current.tiers],
        triangles: current.triangles.summary(),
        updateMs: current.update.summary(),
      };
    },
    submitted: 0,
    updateSerial: 0,
    updates: 0,
  };
  window.__mobileSoak = audit;
  renderer.domElement.addEventListener("webglcontextlost", () => {
    audit.contextLost = true;
  });
  const baseUpdate = game.update;
  game.update = function update(dt, ...args) {
    const start = performance.now();
    const playing = !this.paused && this.mode.kind === "playing" && dt > 0;
    const result = baseUpdate.call(this, dt, ...args);
    audit.updates += 1;
    if (playing) {
      audit.updateSerial += 1;
    }
    if (playing && audit.active) {
      audit.current.update.add(performance.now() - start);
    }
    return result;
  };
  const stream = game.city.updateStreaming;
  game.city.updateStreaming = function updateStreaming(...args) {
    const start = performance.now();
    const result = stream.apply(this, args);
    if (audit.active) {
      audit.current.stream.add(performance.now() - start);
    }
    return result;
  };
  const baseRender = renderer.render;
  renderer.render = function render(scene, camera) {
    // Count main-scene submissions only. Sky cube faces and repeated draws after
    // the same update are not extra gameplay frames on a 120 Hz display.
    const main = scene === game.scene && camera === game.camera && this.getRenderTarget() === null;
    const start = performance.now();
    const result = baseRender.call(this, scene, camera);
    if (main) {
      audit.submitted += 1;
    }
    if (
      main &&
      audit.active &&
      !game.paused &&
      game.mode.kind === "playing" &&
      audit.sampledSerial !== audit.updateSerial
    ) {
      audit.sampledSerial = audit.updateSerial;
      const { current } = audit;
      current.frames += 1;
      current.render.add(performance.now() - start);
      if (current.previous) {
        current.frame.add(start - current.previous);
      }
      current.previous = start;
      current.calls.add(this.info.render.calls);
      current.triangles.add(this.info.render.triangles);
      current.tiers[window.__perf.tier()] += 1;
      const { car } = game;
      const { x, y, z } = car.position;
      if (
        !Number.isFinite(x) ||
        !Number.isFinite(y) ||
        !Number.isFinite(z) ||
        !Number.isFinite(car.heading) ||
        !Number.isFinite(car.speed)
      ) {
        current.invalid += 1;
      }
      if (Math.abs(car.speed) > 5) {
        current.moving += 1;
      }
      if (current.lastX !== null) {
        current.distance += Math.hypot(x - current.lastX, z - current.lastZ);
      }
      current.lastX = x;
      current.lastZ = z;
    }
    return result;
  };
  new PerformanceObserver((list) => {
    if (!audit.active) {
      return;
    }
    for (const entry of list.getEntries()) {
      if (entry.startTime < audit.current.started) {
        continue;
      }
      const tasks = audit.current.longTasks;
      tasks.count += 1;
      tasks.totalMs += entry.duration;
      tasks.maxMs = Math.max(tasks.maxMs, entry.duration);
    }
  }).observe({ type: "longtask" });
};

const prepareRoute = () => {
  const { network } = window.__taxi.game.city;
  const byId = new Map(network.edges.map((edge) => [edge.id, edge]));
  const startsInSunset = (first) => {
    const midpoint = network.sample(first, first.len * 0.5);
    return (
      midpoint.x >= -1150 &&
      midpoint.x <= -650 &&
      midpoint.z >= 100 &&
      midpoint.z <= 650 &&
      first.half >= 3.5
    );
  };
  const straightestContinuation = (edge, dir, seen) => {
    const end = dir > 0 ? edge.b : edge.a;
    const tangent = network.sample(edge, dir > 0 ? edge.len : 0);
    let next = null;
    let score = 0.985;
    for (const id of network.nodeEdges[end] ?? []) {
      const candidate = byId.get(id);
      if (!candidate || seen.has(id)) {
        continue;
      }
      const d = candidate.a === end ? 1 : -1;
      const p = network.sample(candidate, d > 0 ? 0 : candidate.len);
      const dot = tangent.tx * dir * p.tx * d + tangent.tz * dir * p.tz * d;
      if (dot > score) {
        next = { dir: d, edge: candidate };
        score = dot;
      }
    }
    return next;
  };
  const walk = (first, direction) => {
    let edge = first;
    let dir = direction;
    let length = 0;
    const steps = [];
    const seen = new Set();
    for (let count = 0; count < 30; count += 1) {
      if (seen.has(edge.id)) {
        break;
      }
      seen.add(edge.id);
      steps.push({ dir, edge });
      length += edge.len;
      const next = straightestContinuation(edge, dir, seen);
      if (!next) {
        break;
      }
      ({ dir, edge } = next);
    }
    return { length, steps };
  };
  let best = null;
  for (const first of network.edges) {
    if (!startsInSunset(first)) {
      continue;
    }
    for (const direction of [1, -1]) {
      const { length, steps } = walk(first, direction);
      if (length > 240 && (!best || length > best.length)) {
        best = { length, steps };
      }
    }
  }
  if (!best) {
    throw new Error("No repeatable 240-unit Sunset road route");
  }
  const points = [];
  for (const { edge, dir } of best.steps) {
    for (let s = 0; s < edge.len; s += 6) {
      const p = network.sample(edge, dir > 0 ? s : edge.len - s);
      points.push({ x: p.x, z: p.z });
    }
  }
  const route = points.slice(2);
  const [a, b] = route;
  if (!a || !b) {
    throw new Error("Route has no launch tangent");
  }
  window.__mobileSoakRoute = {
    index: 0,
    length: best.length,
    points: route,
    u: a.x / 3172 + 0.5,
    v: a.z / 2600 + 0.5,
    yaw: Math.atan2(b.x - a.x, b.z - a.z),
  };
  return {
    length: best.length,
    u: window.__mobileSoakRoute.u,
    v: window.__mobileSoakRoute.v,
    yaw: window.__mobileSoakRoute.yaw,
  };
};

const steering = () => {
  const route = window.__mobileSoakRoute;
  const car = window.__taxi.probe();
  if (!car) {
    throw new Error("Missing taxi during drive");
  }
  let { index } = route;
  let distance = Infinity;
  for (let i = index; i < Math.min(index + 20, route.points.length); i += 1) {
    const point = route.points[i];
    const d = Math.hypot(point.x - car.x, point.z - car.z);
    if (d < distance) {
      distance = d;
      index = i;
    }
  }
  route.index = index;
  const point = route.points[Math.min(index + 2, route.points.length - 1)];
  const want = Math.atan2(point.x - car.x, point.z - car.z);
  const error = ((want - car.heading + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
  return {
    distance,
    mode: window.__taxi.game.mode.kind,
    nearEnd: index >= route.points.length - 4,
    speed: car.speed,
    steer: Math.max(-0.8, Math.min(0.8, -error * 1.7)),
  };
};

const snapshot = () => {
  const renderer = window.__renderer;
  return {
    browserMs: performance.now(),
    car: window.__taxi.probe(),
    contextLost: window.__mobileSoak.contextLost,
    memory: { ...renderer.info.memory },
    pixelRatio: renderer.getPixelRatio(),
    stream: window.__taxi.game.city.parcelStreamStats(),
    submitted: window.__mobileSoak.submitted,
    tier: window.__perf.tier(),
    updates: window.__mobileSoak.updates,
  };
};

const captureDiagnostics = () => {
  const { city } = window.__taxi.game;
  const allBuffers = new Set();
  const fields = {};
  for (const name of ["restItems", "rawGeos", "capturedMerged", "rawGeoIds"]) {
    const root = city[name];
    if (root === undefined) {
      fields[name] = { available: false };
      continue;
    }
    const views = new Set();
    const buffers = new Set();
    let viewBytes = 0;
    // Known City capture record fields, not a generic recursive scene walk.
    // rawGeoIds maps strings to numbers and therefore has no typed buffers.
    for (const record of Array.isArray(root) ? root : []) {
      for (const key of ["m", "position", "normal", "uv", "color", "index"]) {
        const view = record[key];
        if (!ArrayBuffer.isView(view) || views.has(view)) {
          continue;
        }
        views.add(view);
        viewBytes += view.byteLength;
        buffers.add(view.buffer);
        allBuffers.add(view.buffer);
      }
    }
    let entries = null;
    if (root instanceof Map) {
      entries = root.size;
    } else if (Array.isArray(root)) {
      entries = root.length;
    }
    fields[name] = {
      available: true,
      backingBytes: [...buffers].reduce((sum, buffer) => sum + buffer.byteLength, 0),
      entries,
      typedViewBytes: viewBytes,
      uniqueBackingBuffers: buffers.size,
    };
  }
  return {
    fields,
    interpretation:
      "Typed views and reachable backing buffers only; excludes JS object/string overhead. Shared backing bytes deduplicated across fields; may also be owned by live render geometry.",
    sharedBackingBytes: [...allBuffers].reduce((sum, buffer) => sum + buffer.byteLength, 0),
  };
};

// Same pose + view + tier only. Natural JS GC sawteeth are not leaks: require
// three consecutive late samples above a deliberately generous warmed floor.
const resourceGrowth = (samples) => {
  const specs = [
    ["geometries", (s) => s.memory.geometries, 128, 0.5],
    ["textures", (s) => s.memory.textures, 16, 0.35],
    ["parcelBytes", (s) => s.stream?.bytes ?? 0, 8 * 1024 * 1024, 0.35],
    ["residentCells", (s) => s.stream?.resident ?? 0, 24, 0.25],
    ["jsHeapUsed", (s) => s.heap.usedSize, 128 * 1024 * 1024, 0.75],
  ];
  const results = [];
  const tiers = new Set(samples.map((s) => s.tier));
  for (const tier of tiers) {
    const stable = samples.filter((s) => s.tier === tier).slice(2);
    if (stable.length < 6) {
      continue;
    }
    for (const [name, read, allowance, fraction] of specs) {
      const first = stable.slice(0, 3).map(read);
      const last = stable.slice(-3).map(read);
      const baseline = Math.min(...first);
      const threshold = baseline + Math.max(allowance, baseline * fraction);
      results.push({
        baseline,
        last,
        name,
        runaway: last.every((value) => value > threshold),
        threshold,
        tier,
      });
    }
  }
  return results;
};

const resourceVerdict = (growth) => {
  if (growth.length === 0) {
    return "insufficient-samples";
  }
  return growth.some((entry) => entry.runaway) ? "runaway" : "stable";
};

const parseOptions = (args) => {
  const positional = args.filter((value) => !value.startsWith("--"));
  const option = (name, fallback) =>
    args.find((value) => value.startsWith(`--${name}=`))?.split("=")[1] ?? fallback;
  const minutes = Number(option("minutes", "5"));
  const cpu = Number(option("cpu", "4"));
  const tierValue = option("tier", null);
  const tier = tierValue === null ? null : Number(tierValue);
  if (!Number.isFinite(minutes) || minutes < 5 || minutes > 10) {
    throw new Error("--minutes must be 5..10");
  }
  if (!Number.isFinite(cpu) || cpu < 1 || cpu > 20) {
    throw new Error("--cpu must be 1..20");
  }
  if (tier !== null && (!Number.isInteger(tier) || tier < 0 || tier > 4)) {
    throw new Error("--tier must be 0..4");
  }
  const smoke = args.includes("--smoke");
  return {
    cpu,
    durationMs: smoke ? 28_000 : minutes * 60_000,
    noMultiDraw: !args.includes("--multi-draw"),
    output: path.resolve(positional[1] ?? "/private/tmp/waymo-mobile-soak"),
    smoke,
    tier,
    url: positional[0] ?? "http://localhost:5193/?time=noon&offline=1",
  };
};

const main = async () => {
  const args = process.argv.slice(2);
  if (args.includes("--help")) {
    console.log(
      "node tools/verify-mobile-soak.mjs [dev-url] [output] --minutes=5..10 --cpu=4 [--multi-draw] [--tier=0..4] [--smoke]",
    );
    return;
  }
  const { cpu, durationMs, noMultiDraw, output, smoke, tier, url } = parseOptions(args);
  const report = {
    checkedAt: new Date().toISOString(),
    checks: [],
    cpuRate: cpu,
    fixedTier: tier,
    kind: smoke ? "harness-smoke" : "sustained-soak",
    limitations: [
      "Headed desktop Chrome with coarse touch/DPR 3 and CPU throttling. Not physical-phone GPU, thermal or battery evidence.",
      "Frames are completed main-scene render submissions after distinct game updates; no raw rAF counts or compositor presentation timestamps.",
      "Repeated staged Sunset route; real CDP touch propulsion/steering. Fleet relocated and recycling held for reproducibility.",
      "Resets, settling, 500 ms acceleration, rotations, screenshots, heap reads and pauses excluded from steady timing. No forced GC anywhere.",
      "Timing percentiles use fixed 0.25 ms bins; overflow counts/max retained. Resource counts are not byte measurements.",
      "Resource growth gates need 8 same-view/tier route-start samples; passing is bounded evidence, not proof against smaller leaks.",
    ],
    metricStorage: {
      fixedHistogramBytes: (4 * 4097 + 2 * 8193) * 4,
      maxWindows: 128,
      rawFrameSamples: 0,
    },
    noMultiDraw,
    pauses: [],
    requestedSteadyMs: durationMs,
    url,
    views: [],
  };
  const session = await createMobileSession({ output, sessionPrefix: "crazy-waymo-mobile-soak" });
  const { call, evaluate, until, tap, sleep, screenshot, close, pageErrors } = session;
  const run = (fn, ...values) => evaluate(`(${fn.toString()})(...${JSON.stringify(values)})`);
  const save = () =>
    writeFileSync(path.join(output, "report.json"), JSON.stringify(report, null, 2));
  const check = (name, passed, evidence) => {
    report.checks.push({ evidence, name, passed });
    if (!passed) {
      throw new Error(`${name}: ${JSON.stringify(evidence)}`);
    }
  };
  const release = () => call("Input.dispatchTouchEvent", { touchPoints: [], type: "touchEnd" });
  const resources = async () => ({
    ...(await run(snapshot)),
    heap: await call("Runtime.getHeapUsage"),
  });
  const pauseCheck = async (name) => {
    await tap('[aria-label="Pause"]');
    await until("window.__taxi.game.paused === true");
    await sleep(300);
    const before = await run(snapshot);
    await sleep(2000);
    const after = await run(snapshot);
    const movement = Math.hypot(
      after.car.x - before.car.x,
      after.car.z - before.car.z,
      after.car.y - before.car.y,
    );
    const entry = {
      drawDelta: after.submitted - before.submitted,
      durationMs: after.browserMs - before.browserMs,
      movement,
      name,
      updateDelta: after.updates - before.updates,
    };
    report.pauses.push(entry);
    check(
      `${name} pause stops drawing and simulation`,
      entry.drawDelta === 0 && entry.updateDelta === 0 && movement < 0.001,
      entry,
    );
    await tap("#waymo-pause .pcta");
    await until("window.__taxi.game.paused === false");
    await until(`window.__mobileSoak.submitted > ${after.submitted}`);
    const resumed = await run(snapshot);
    check(`${name} resumes drawing`, true, { submitted: resumed.submitted });
  };
  let steadyMs = 0;
  const started = Date.now();
  try {
    await call("Page.enable");
    await call("Runtime.enable");
    await call("Emulation.setDeviceMetricsOverride", {
      deviceScaleFactor: 3,
      height: 844,
      mobile: true,
      width: 390,
    });
    await call("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
    if (noMultiDraw) {
      await call("Page.addScriptToEvaluateOnNewDocument", {
        source:
          "const getExtension=WebGL2RenderingContext.prototype.getExtension;WebGL2RenderingContext.prototype.getExtension=function(name){return name==='WEBGL_multi_draw'?null:getExtension.call(this,name)}",
      });
    }
    await call("Page.navigate", { url });
    await until("window.__taxi?.game.isReady === true");
    report.readyMs = Date.now() - started;
    report.device = await run(() => {
      const renderer = window.__renderer;
      const gl = renderer.getContext();
      const debug = gl.getExtension("WEBGL_debug_renderer_info");
      return {
        coarse: matchMedia("(pointer:coarse)").matches,
        dpr: devicePixelRatio,
        multiDraw: !!gl.getExtension("WEBGL_multi_draw"),
        post: window.__post !== null,
        renderer: debug
          ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL)
          : gl.getParameter(gl.RENDERER),
        touch: navigator.maxTouchPoints,
        userAgent: navigator.userAgent,
      };
    });
    check(
      "coarse DPR 3 single-pass game renderer",
      report.device.coarse &&
        report.device.dpr === 3 &&
        report.device.touch > 0 &&
        !report.device.post &&
        (!noMultiDraw || !report.device.multiDraw),
      report.device,
    );
    report.worldRevision = await evaluate(
      "import('/src/world/world-bin.ts').then(module=>module.WORLD_REV)",
    );
    await tap("#banner-cta");
    await until('window.__taxi.game.mode.kind === "playing"');
    await run(installMetrics);
    report.initialCityCapture = await run(captureDiagnostics);
    report.route = await run(prepareRoute);
    await call("Emulation.setCPUThrottlingRate", { rate: cpu });
    if (tier !== null) {
      await evaluate(`window.__perf.pin(${tier})`);
    }
    const views = [
      { height: 844, name: "portrait-day", phase: 0.25, width: 390 },
      { height: 390, name: "landscape-day", phase: 0.25, width: 844 },
      { height: 844, name: "portrait-night", phase: 0.7, width: 390 },
      { height: 390, name: "landscape-night", phase: 0.7, width: 844 },
    ];
    const soakView = async (view) => {
      const result = { ...view, growth: [], windows: [] };
      report.views.push(result);
      await call("Emulation.setDeviceMetricsOverride", {
        deviceScaleFactor: 3,
        height: view.height,
        mobile: true,
        width: view.width,
      });
      await until(`innerWidth === ${view.width} && innerHeight === ${view.height}`);
      await run((phase) => window.__taxi.setPhase(phase), view.phase);
      let viewMs = 0;
      const anchor = {
        id: 1,
        x: view.width === 390 ? 100 : 250,
        y: view.height === 844 ? 520 : 200,
      };
      while (viewMs < durationMs / 4) {
        if (result.windows.length >= 32) {
          throw new Error("Window budget exceeded");
        }
        await run(() => {
          const taxi = window.__taxi;
          const route = window.__mobileSoakRoute;
          taxi.setTime(3600);
          taxi.teleport(route.u, route.v, route.yaw);
          route.index = 0;
          const car = taxi.probe();
          taxi.game.traffic.reset(
            { gx: taxi.game.city.gridX(car.x), gz: taxi.game.city.gridZ(car.z) },
            70,
          );
          taxi.game.traffic.setHoldRecycle(true);
        });
        const resetStarted = Date.now();
        await sleep(1500);
        await until("(window.__taxi.game.city.parcelStreamStats()?.pending ?? 0) === 0", 45_000);
        const before = await resources();
        await call("Input.dispatchTouchEvent", { touchPoints: [anchor], type: "touchStart" });
        await sleep(500);
        await evaluate("window.__mobileSoak.start()");
        const driveStarted = Date.now();
        // Avoid a handful of frames in a tiny remainder becoming a false
        // movement failure. The requested duration is a minimum.
        const legMs = Math.min(7000, Math.max(1500, durationMs / 4 - viewMs));
        let worstRoadDistance = 0;
        while (Date.now() - driveStarted < legMs) {
          const control = await run(steering);
          if (!Number.isFinite(control.steer) || control.mode !== "playing") {
            throw new Error("Nonfinite steering or run ended during soak");
          }
          worstRoadDistance = Math.max(worstRoadDistance, control.distance);
          if (control.nearEnd) {
            break;
          }
          await call("Input.dispatchTouchEvent", {
            touchPoints: [{ ...anchor, x: anchor.x + control.steer * 62 }],
            type: "touchMove",
          });
          await sleep(100);
          if (pageErrors.length) {
            throw new Error("Page exception during soak");
          }
        }
        const measured = await evaluate("window.__mobileSoak.stop()");
        await release();
        const after = await resources();
        const entry = {
          before,
          excludedResetMs: driveStarted - resetStarted,
          index: result.windows.length,
          ...measured,
          after,
          worstRoadDistance,
        };
        result.windows.push(entry);
        viewMs += measured.steadyMs;
        steadyMs += measured.steadyMs;
        report.steadyMs = steadyMs;
        report.wallMs = Date.now() - started;
        save();
        check(
          `${view.name} window ${entry.index} keeps finite moving road frames`,
          measured.invalidMotionFrames === 0 &&
            measured.presentedFrames >= (measured.steadyMs / 1000) * 10 &&
            measured.movingFrames >= measured.presentedFrames * 0.8 &&
            measured.distance > (measured.steadyMs / 1000) * 5 &&
            worstRoadDistance < 12 &&
            !after.contextLost,
          {
            contextLost: after.contextLost,
            distance: measured.distance,
            moving: measured.movingFrames,
            presented: measured.presentedFrames,
            worstRoadDistance,
          },
        );
        console.log(
          `SOAK ${view.name} ${Math.round(steadyMs / 1000)}/${durationMs / 1000}s ${JSON.stringify({ frameMs: measured.frameMs, heapUsed: after.heap.usedSize, memory: after.memory, tier: after.tier })}`,
        );
      }
      result.growth = resourceGrowth(result.windows.map((entry) => entry.before));
      result.resourceVerdict = resourceVerdict(result.growth);
      if (result.resourceVerdict === "insufficient-samples") {
        console.log(`SOAK ${view.name} resource gate inconclusive: fewer than 8 same-tier starts`);
      } else {
        check(
          `${view.name} has no sustained warmed resource runaway`,
          result.resourceVerdict === "stable",
          result.growth,
        );
      }
      await screenshot(view.name);
      await pauseCheck(view.name);
      save();
    };
    for (const view of views) {
      await soakView(view);
    }
    check("requested steady duration completed", steadyMs >= durationMs, {
      requestedMs: durationMs,
      steadyMs,
    });
    check("no page exceptions", pageErrors.length === 0, pageErrors);
  } catch (error) {
    report.error = String(error);
    process.exitCode = 1;
    console.error(error);
    await evaluate("if(window.__mobileSoak)window.__mobileSoak.active=false").catch(() => {
      /* empty */
    });
    await release().catch(() => {
      /* empty */
    });
    await screenshot("failure").catch(() => {
      /* empty */
    });
  } finally {
    report.finalCityCapture = await run(captureDiagnostics).catch((error) => ({
      unavailable: String(error),
    }));
    report.wallMs = Date.now() - started;
    report.pageErrors = pageErrors.slice(0, 20);
    report.pageErrorCount = pageErrors.length;
    report.passed = !report.error && report.checks.every((entry) => entry.passed);
    save();
    close();
  }
};

const selfTest = () => {
  const sample = (value) => ({
    heap: { usedSize: 200_000_000 },
    memory: { geometries: value, textures: 70 },
    stream: { bytes: 34_000_000, resident: 205 },
    tier: 4,
  });
  const stable = Array.from({ length: 12 }, (_, index) => sample(600 + (index % 3)));
  assert.ok(resourceGrowth(stable).every((entry) => !entry.runaway));
  assert.ok(
    resourceGrowth([...stable.slice(0, 8), sample(1200), sample(1300), sample(1400)]).some(
      (entry) => entry.name === "geometries" && entry.runaway,
    ),
  );
  assert.ok(resourceGrowth([...stable, sample(4000)]).every((entry) => !entry.runaway));
  assert.equal(resourceGrowth(stable.slice(0, 7)).length, 0);
  console.log(
    "PASS resource gates distinguish persistent growth from one spike and insufficient warmup",
  );
};

if (process.argv.includes("--self-test")) {
  selfTest();
} else {
  await main();
}
