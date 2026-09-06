// Sustained real-touch road driving. Owned headed Chrome; desktop stress proxy only.
// node tools/verify-mobile-soak.mjs [dev-url] [output] --minutes=5 --cpu=4
// Options: --minutes=5..10, --multi-draw, --tier=0..4, --smoke (28 timed seconds).
// Duration means steady driving time. Loading, resets, pauses and captures add wall time.
/* eslint-disable no-underscore-dangle, unicorn/consistent-function-scoping */
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { createMobileSession } from "./mobile-browser-session.mjs";

// Self-contained: installed into the page without imports or source changes.
function installMetrics() {
  const game = window.__taxi.game;
  const renderer = window.__renderer;
  function histogram(step = 0.25, bins = 4096) {
    const counts = new Uint32Array(bins + 1);
    let count = 0;
    let sum = 0;
    let max = 0;
    let over33 = 0;
    let over50 = 0;
    let over100 = 0;
    return {
      add(value) {
        if (!Number.isFinite(value) || value < 0) return;
        counts[Math.min(bins, Math.floor(value / step))]++;
        count++;
        sum += value;
        max = Math.max(max, value);
        if (value > 33.4) over33++;
        if (value > 50) over50++;
        if (value > 100) over100++;
      },
      summary() {
        function percentile(fraction) {
          if (!count) return null;
          const target = Math.ceil(count * fraction);
          let total = 0;
          for (let index = 0; index < counts.length; index++) {
            total += counts[index];
            if (total >= target) return index === bins ? max : index * step;
          }
          return max;
        }
        return {
          count,
          mean: count ? sum / count : null,
          median: percentile(0.5),
          p95: percentile(0.95),
          p99: percentile(0.99),
          max,
          over33,
          over50,
          over100,
          resolution: step,
          overflow: counts[bins],
        };
      },
    };
  }
  const audit = (window.__mobileSoak = {
    active: false,
    updateSerial: 0,
    sampledSerial: -1,
    submitted: 0,
    updates: 0,
    contextLost: false,
    current: null,
    start() {
      this.current = {
        started: performance.now(),
        previous: 0,
        frame: histogram(),
        update: histogram(),
        render: histogram(),
        stream: histogram(),
        calls: histogram(1, 8192),
        triangles: histogram(1000, 8192),
        tiers: new Uint32Array(5),
        frames: 0,
        moving: 0,
        invalid: 0,
        distance: 0,
        lastX: null,
        lastZ: null,
        longTasks: { count: 0, totalMs: 0, maxMs: 0 },
      };
      this.sampledSerial = this.updateSerial;
      this.active = true;
    },
    stop() {
      this.active = false;
      const current = this.current;
      if (!current) throw new Error("No active soak window");
      current.previous = 0;
      return {
        steadyMs: performance.now() - current.started,
        frameMs: current.frame.summary(),
        updateMs: current.update.summary(),
        renderMs: current.render.summary(),
        streamMs: current.stream.summary(),
        calls: current.calls.summary(),
        triangles: current.triangles.summary(),
        tierFrames: Array.from(current.tiers),
        presentedFrames: current.frames,
        movingFrames: current.moving,
        invalidMotionFrames: current.invalid,
        distance: current.distance,
        longTasks: current.longTasks,
      };
    },
  });
  renderer.domElement.addEventListener("webglcontextlost", () => {
    audit.contextLost = true;
  });
  const update = game.update;
  game.update = function (dt, ...args) {
    const start = performance.now();
    const playing = !this.paused && this.mode.kind === "playing" && dt > 0;
    const result = update.call(this, dt, ...args);
    audit.updates++;
    if (playing) audit.updateSerial++;
    if (playing && audit.active) audit.current.update.add(performance.now() - start);
    return result;
  };
  const stream = game.city.updateStreaming;
  game.city.updateStreaming = function (...args) {
    const start = performance.now();
    const result = stream.apply(this, args);
    if (audit.active) audit.current.stream.add(performance.now() - start);
    return result;
  };
  const render = renderer.render;
  renderer.render = function (scene, camera) {
    // Count main-scene submissions only. Sky cube faces and repeated draws after
    // the same update are not extra gameplay frames on a 120 Hz display.
    const main = scene === game.scene && camera === game.camera && this.getRenderTarget() === null;
    const start = performance.now();
    const result = render.call(this, scene, camera);
    if (main) audit.submitted++;
    if (
      main &&
      audit.active &&
      !game.paused &&
      game.mode.kind === "playing" &&
      audit.sampledSerial !== audit.updateSerial
    ) {
      audit.sampledSerial = audit.updateSerial;
      const current = audit.current;
      current.frames++;
      current.render.add(performance.now() - start);
      if (current.previous) current.frame.add(start - current.previous);
      current.previous = start;
      current.calls.add(this.info.render.calls);
      current.triangles.add(this.info.render.triangles);
      current.tiers[window.__perf.tier()]++;
      const car = game.car;
      const { x, y, z } = car.position;
      if (
        !Number.isFinite(x) ||
        !Number.isFinite(y) ||
        !Number.isFinite(z) ||
        !Number.isFinite(car.heading) ||
        !Number.isFinite(car.speed)
      )
        current.invalid++;
      if (Math.abs(car.speed) > 5) current.moving++;
      if (current.lastX !== null)
        current.distance += Math.hypot(x - current.lastX, z - current.lastZ);
      current.lastX = x;
      current.lastZ = z;
    }
    return result;
  };
  new PerformanceObserver((list) => {
    if (!audit.active) return;
    for (const entry of list.getEntries()) {
      if (entry.startTime < audit.current.started) continue;
      const tasks = audit.current.longTasks;
      tasks.count++;
      tasks.totalMs += entry.duration;
      tasks.maxMs = Math.max(tasks.maxMs, entry.duration);
    }
  }).observe({ type: "longtask" });
}

function prepareRoute() {
  const network = window.__taxi.game.city.network;
  const byId = new Map(network.edges.map((edge) => [edge.id, edge]));
  let best = null;
  for (const first of network.edges) {
    const midpoint = network.sample(first, first.len * 0.5);
    if (
      midpoint.x < -1150 ||
      midpoint.x > -650 ||
      midpoint.z < 100 ||
      midpoint.z > 650 ||
      first.half < 3.5
    )
      continue;
    for (const direction of [1, -1]) {
      let edge = first;
      let dir = direction;
      let length = 0;
      const steps = [];
      const seen = new Set();
      for (let count = 0; count < 30; count++) {
        if (seen.has(edge.id)) break;
        seen.add(edge.id);
        steps.push({ edge, dir });
        length += edge.len;
        const end = dir > 0 ? edge.b : edge.a;
        const tangent = network.sample(edge, dir > 0 ? edge.len : 0);
        let next = null;
        let score = 0.985;
        for (const id of network.nodeEdges[end] ?? []) {
          const candidate = byId.get(id);
          if (!candidate || seen.has(id)) continue;
          const d = candidate.a === end ? 1 : -1;
          const p = network.sample(candidate, d > 0 ? 0 : candidate.len);
          const dot = tangent.tx * dir * p.tx * d + tangent.tz * dir * p.tz * d;
          if (dot > score) {
            next = { edge: candidate, dir: d };
            score = dot;
          }
        }
        if (!next) break;
        edge = next.edge;
        dir = next.dir;
      }
      if (length > 240 && (!best || length > best.length)) best = { steps, length };
    }
  }
  if (!best) throw new Error("No repeatable 240-unit Sunset road route");
  const points = [];
  for (const { edge, dir } of best.steps) {
    for (let s = 0; s < edge.len; s += 6) {
      const p = network.sample(edge, dir > 0 ? s : edge.len - s);
      points.push({ x: p.x, z: p.z });
    }
  }
  const a = points[2];
  const b = points[3];
  if (!a || !b) throw new Error("Route has no launch tangent");
  window.__mobileSoakRoute = {
    u: a.x / 3172 + 0.5,
    v: a.z / 2600 + 0.5,
    yaw: Math.atan2(b.x - a.x, b.z - a.z),
    points: points.slice(2),
    index: 0,
    length: best.length,
  };
  return {
    u: window.__mobileSoakRoute.u,
    v: window.__mobileSoakRoute.v,
    yaw: window.__mobileSoakRoute.yaw,
    length: best.length,
  };
}

function steering() {
  const route = window.__mobileSoakRoute;
  const car = window.__taxi.probe();
  if (!car) throw new Error("Missing taxi during drive");
  let index = route.index;
  let distance = Infinity;
  for (let i = index; i < Math.min(index + 20, route.points.length); i++) {
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
    steer: Math.max(-0.8, Math.min(0.8, -error * 1.7)),
    distance,
    speed: car.speed,
    mode: window.__taxi.game.mode.kind,
    nearEnd: index >= route.points.length - 4,
  };
}

function snapshot() {
  const renderer = window.__renderer;
  return {
    browserMs: performance.now(),
    car: window.__taxi.probe(),
    tier: window.__perf.tier(),
    pixelRatio: renderer.getPixelRatio(),
    memory: { ...renderer.info.memory },
    stream: window.__taxi.game.city.parcelStreamStats(),
    submitted: window.__mobileSoak.submitted,
    updates: window.__mobileSoak.updates,
    contextLost: window.__mobileSoak.contextLost,
  };
}

function captureDiagnostics() {
  const city = window.__taxi.game.city;
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
        if (!ArrayBuffer.isView(view) || views.has(view)) continue;
        views.add(view);
        viewBytes += view.byteLength;
        buffers.add(view.buffer);
        allBuffers.add(view.buffer);
      }
    }
    fields[name] = {
      available: true,
      entries: root instanceof Map ? root.size : Array.isArray(root) ? root.length : null,
      typedViewBytes: viewBytes,
      uniqueBackingBuffers: buffers.size,
      backingBytes: [...buffers].reduce((sum, buffer) => sum + buffer.byteLength, 0),
    };
  }
  return {
    fields,
    sharedBackingBytes: [...allBuffers].reduce((sum, buffer) => sum + buffer.byteLength, 0),
    interpretation:
      "Typed views and reachable backing buffers only; excludes JS object/string overhead. Shared backing bytes deduplicated across fields; may also be owned by live render geometry.",
  };
}

// Same pose + view + tier only. Natural JS GC sawteeth are not leaks: require
// three consecutive late samples above a deliberately generous warmed floor.
function resourceGrowth(samples) {
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
    if (stable.length < 6) continue;
    for (const [name, read, allowance, fraction] of specs) {
      const first = stable.slice(0, 3).map(read);
      const last = stable.slice(-3).map(read);
      const baseline = Math.min(...first);
      const threshold = baseline + Math.max(allowance, baseline * fraction);
      results.push({
        name,
        tier,
        baseline,
        threshold,
        last,
        runaway: last.every((value) => value > threshold),
      });
    }
  }
  return results;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help")) {
    console.log(
      "node tools/verify-mobile-soak.mjs [dev-url] [output] --minutes=5..10 --cpu=4 [--multi-draw] [--tier=0..4] [--smoke]",
    );
    return;
  }
  const positional = args.filter((value) => !value.startsWith("--"));
  const option = (name, fallback) =>
    args.find((value) => value.startsWith(`--${name}=`))?.split("=")[1] ?? fallback;
  const minutes = Number(option("minutes", "5"));
  const cpu = Number(option("cpu", "4"));
  const tierValue = option("tier", null);
  const tier = tierValue === null ? null : Number(tierValue);
  if (!Number.isFinite(minutes) || minutes < 5 || minutes > 10)
    throw new Error("--minutes must be 5..10");
  if (!Number.isFinite(cpu) || cpu < 1 || cpu > 20) throw new Error("--cpu must be 1..20");
  if (tier !== null && (!Number.isInteger(tier) || tier < 0 || tier > 4))
    throw new Error("--tier must be 0..4");
  const smoke = args.includes("--smoke");
  const durationMs = smoke ? 28_000 : minutes * 60_000;
  const noMultiDraw = !args.includes("--multi-draw");
  const url = positional[0] ?? "http://localhost:5193/?time=noon&offline=1";
  const output = path.resolve(positional[1] ?? "/private/tmp/waymo-mobile-soak");
  const report = {
    url,
    checkedAt: new Date().toISOString(),
    kind: smoke ? "harness-smoke" : "sustained-soak",
    requestedSteadyMs: durationMs,
    cpuRate: cpu,
    fixedTier: tier,
    noMultiDraw,
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
    views: [],
    pauses: [],
    checks: [],
  };
  const session = await createMobileSession({ sessionPrefix: "crazy-waymo-mobile-soak", output });
  const { call, evaluate, until, tap, sleep, screenshot, close, pageErrors } = session;
  const run = (fn, ...values) => evaluate(`(${fn.toString()})(...${JSON.stringify(values)})`);
  const save = () =>
    writeFileSync(path.join(output, "report.json"), JSON.stringify(report, null, 2));
  function check(name, passed, evidence) {
    report.checks.push({ name, passed, evidence });
    if (!passed) throw new Error(`${name}: ${JSON.stringify(evidence)}`);
  }
  const release = () => call("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  async function resources() {
    return { ...(await run(snapshot)), heap: await call("Runtime.getHeapUsage") };
  }
  async function pauseCheck(name) {
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
      name,
      durationMs: after.browserMs - before.browserMs,
      drawDelta: after.submitted - before.submitted,
      updateDelta: after.updates - before.updates,
      movement,
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
    check(`${name} resumes drawing`, true, { submitted: (await run(snapshot)).submitted });
  }
  let steadyMs = 0;
  const started = Date.now();
  try {
    await call("Page.enable");
    await call("Runtime.enable");
    await call("Emulation.setDeviceMetricsOverride", {
      width: 390,
      height: 844,
      deviceScaleFactor: 3,
      mobile: true,
    });
    await call("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
    if (noMultiDraw)
      await call("Page.addScriptToEvaluateOnNewDocument", {
        source:
          "const getExtension=WebGL2RenderingContext.prototype.getExtension;WebGL2RenderingContext.prototype.getExtension=function(name){return name==='WEBGL_multi_draw'?null:getExtension.call(this,name)}",
      });
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
        touch: navigator.maxTouchPoints,
        renderer: debug
          ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL)
          : gl.getParameter(gl.RENDERER),
        multiDraw: !!gl.getExtension("WEBGL_multi_draw"),
        post: window.__post !== null,
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
    if (tier !== null) await evaluate(`window.__perf.pin(${tier})`);
    const views = [
      { name: "portrait-day", width: 390, height: 844, phase: 0.25 },
      { name: "landscape-day", width: 844, height: 390, phase: 0.25 },
      { name: "portrait-night", width: 390, height: 844, phase: 0.7 },
      { name: "landscape-night", width: 844, height: 390, phase: 0.7 },
    ];
    for (const view of views) {
      const result = { ...view, windows: [], growth: [] };
      report.views.push(result);
      await call("Emulation.setDeviceMetricsOverride", {
        width: view.width,
        height: view.height,
        deviceScaleFactor: 3,
        mobile: true,
      });
      await until(`innerWidth === ${view.width} && innerHeight === ${view.height}`);
      await run((phase) => window.__taxi.setPhase(phase), view.phase);
      let viewMs = 0;
      const anchor = {
        x: view.width === 390 ? 100 : 250,
        y: view.height === 844 ? 520 : 200,
        id: 1,
      };
      while (viewMs < durationMs / 4) {
        if (result.windows.length >= 32) throw new Error("Window budget exceeded");
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
        await call("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [anchor] });
        await sleep(500);
        await evaluate("window.__mobileSoak.start()");
        const driveStarted = Date.now();
        // Avoid a handful of frames in a tiny remainder becoming a false
        // movement failure. The requested duration is a minimum.
        const legMs = Math.min(7000, Math.max(1500, durationMs / 4 - viewMs));
        let worstRoadDistance = 0;
        while (Date.now() - driveStarted < legMs) {
          const control = await run(steering);
          if (!Number.isFinite(control.steer) || control.mode !== "playing")
            throw new Error("Nonfinite steering or run ended during soak");
          worstRoadDistance = Math.max(worstRoadDistance, control.distance);
          if (control.nearEnd) break;
          await call("Input.dispatchTouchEvent", {
            type: "touchMove",
            touchPoints: [{ ...anchor, x: anchor.x + control.steer * 62 }],
          });
          await sleep(100);
          if (pageErrors.length) throw new Error("Page exception during soak");
        }
        const measured = await evaluate("window.__mobileSoak.stop()");
        await release();
        const after = await resources();
        const entry = {
          index: result.windows.length,
          excludedResetMs: driveStarted - resetStarted,
          before,
          ...measured,
          worstRoadDistance,
          after,
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
            presented: measured.presentedFrames,
            moving: measured.movingFrames,
            distance: measured.distance,
            worstRoadDistance,
            contextLost: after.contextLost,
          },
        );
        console.log(
          `SOAK ${view.name} ${Math.round(steadyMs / 1000)}/${durationMs / 1000}s ${JSON.stringify({ frameMs: measured.frameMs, tier: after.tier, memory: after.memory, heapUsed: after.heap.usedSize })}`,
        );
      }
      result.growth = resourceGrowth(result.windows.map((entry) => entry.before));
      result.resourceVerdict =
        result.growth.length === 0
          ? "insufficient-samples"
          : result.growth.some((entry) => entry.runaway)
            ? "runaway"
            : "stable";
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
    }
    check("requested steady duration completed", steadyMs >= durationMs, {
      steadyMs,
      requestedMs: durationMs,
    });
    check("no page exceptions", pageErrors.length === 0, pageErrors);
  } catch (error) {
    report.error = String(error);
    process.exitCode = 1;
    console.error(error);
    await evaluate("if(window.__mobileSoak)window.__mobileSoak.active=false").catch(() => {});
    await release().catch(() => {});
    await screenshot("failure").catch(() => {});
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
}

function selfTest() {
  const sample = (value) => ({
    tier: 4,
    memory: { geometries: value, textures: 70 },
    stream: { bytes: 34_000_000, resident: 205 },
    heap: { usedSize: 200_000_000 },
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
}

if (process.argv.includes("--self-test")) selfTest();
else await main();
