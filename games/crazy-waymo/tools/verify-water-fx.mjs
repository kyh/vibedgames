// Mobile water effects on the real taxi, using native CDP touch throughout.
// Usage: node tools/verify-water-fx.mjs [dev-url] [output-directory] [--cpu=4] [--multi-draw]
// Desktop Chrome CPU throttling is a stress proxy, never a physical-phone FPS claim.
/* eslint-disable unicorn/consistent-function-scoping */
import { writeFileSync } from "node:fs";
import path from "node:path";
import { createMobileSession } from "./mobile-browser-session.mjs";

const url = process.argv[2] ?? "http://localhost:5193/?time=noon&offline=1";
const output = path.resolve(process.argv[3] ?? "/private/tmp/waymo-water-fx");
const cpuRate = Number(process.argv.find((value) => value.startsWith("--cpu="))?.slice(6) ?? 4);
if (!Number.isFinite(cpuRate) || cpuRate < 1) {
  throw new Error("Expected --cpu=1 or greater");
}
const noMultiDraw = !process.argv.includes("--multi-draw");
const { call, evaluate, until, tap, touchPoint, screenshot, close, pageErrors } =
  await createMobileSession({ output, sessionPrefix: "crazy-waymo-water-fx" });
const report = {
  checkedAt: new Date().toISOString(),
  checks: [],
  cpuRate,
  interpretation: "Headed desktop Chrome stress proxy; not physical-phone performance",
  noMultiDraw,
  url,
  views: [],
};
const run = (fn, ...args) => evaluate(`(${fn.toString()})(...${JSON.stringify(args)})`);
const check = (name, passed, evidence) => {
  report.checks.push({ evidence, name, passed });
  console.log(`${passed ? "PASS" : "FAIL"} ${name}: ${JSON.stringify(evidence)}`);
};

const installMetrics = () => {
  const g = window.__taxi.game;
  const { fx } = g;
  const { water } = fx;
  const r = window.__renderer;
  const m = {
    active: false,
    capturing: false,
    entry: 0,
    exit: 0,
    frames: [],
    pauseAtWetSeconds: 0,
    peakFoamDraws: 0,
    peakFoamTriangles: 0,
    peakParticles: 0,
    previousFrame: 0,
    renderMs: [],
    samples: [],
    tireWet: {},
    updateMs: [],
    wake: 0,
    wetFrames: 0,
    wetSeconds: 0,
  };
  window.__waterFxAudit = m;
  const baseSpray = water.spray;
  water.spray = function spray(...args) {
    if (m.active) {
      m[args[6]] += 1;
    }
    return baseSpray.apply(this, args);
  };
  const tire = (owner, key) => {
    if (!owner) {
      return;
    }
    const original = owner[key];
    owner[key] = function countingTire(...args) {
      if (m.active && g.car.waterContact.kind === "floating") {
        m.tireWet[key] = (m.tireWet[key] ?? 0) + 1;
      }
      return original.apply(this, args);
    };
  };
  for (const key of ["driftPuff", "kickup", "driftShower", "dustRing", "promotionBurst"]) {
    tire(fx, key);
  }
  tire(g.trails, "emit");
  tire(g.skids, "stampSegment");
  const baseUpdate = g.update;
  g.update = function update(...args) {
    const start = performance.now();
    const wasPaused = this.paused;
    const result = baseUpdate.apply(this, args);
    if (!m.active || wasPaused || this.mode.kind !== "playing" || args[0] <= 0) {
      return result;
    }
    if (!m.capturing) {
      m.updateMs.push(performance.now() - start);
    }
    const { car } = this;
    const wet = car.waterContact.kind === "floating";
    if (wet) {
      m.wetFrames += 1;
      m.wetSeconds += args[0];
    }
    const life = fx.smoke.points.geometry.getAttribute("aLife");
    let live = 0;
    for (let i = 0; i < life.count; i += 1) {
      if (life.getX(i) > 0) {
        live += 1;
      }
    }
    m.peakParticles = Math.max(m.peakParticles, live);
    m.peakFoamTriangles = Math.max(m.peakFoamTriangles, water.mesh.geometry.drawRange.count / 3);
    if (m.samples.length < 7200) {
      m.samples.push({
        airTime: car.airTime,
        airborne: car.airborne,
        drifting: car.isDrifting,
        heading: car.heading,
        speed: car.speed,
        tier: window.__perf.tier(),
        water: car.waterContact.kind,
        x: car.position.x,
        y: car.position.y,
        z: car.position.z,
      });
    }
    if (m.pauseAtWetSeconds > 0 && m.wetSeconds >= m.pauseAtWetSeconds) {
      m.pauseAtWetSeconds = 0;
      this.requestPause();
    }
    return result;
  };
  let beforeFoam = 0;
  const before = water.mesh.onBeforeRender;
  const after = water.mesh.onAfterRender;
  water.mesh.onBeforeRender = function onBeforeRender(...args) {
    beforeFoam = r.info.render.calls;
    return before.apply(this, args);
  };
  water.mesh.onAfterRender = function onAfterRender(...args) {
    if (m.active) {
      m.peakFoamDraws = Math.max(m.peakFoamDraws, r.info.render.calls - beforeFoam);
    }
    return after.apply(this, args);
  };
  const baseRender = r.render;
  r.render = function render(...args) {
    const presented = this.getRenderTarget() === null;
    const start = performance.now();
    const result = baseRender.apply(this, args);
    if (m.active && presented && !g.paused && !m.capturing) {
      m.renderMs.push(performance.now() - start);
      if (m.previousFrame > 0) {
        m.frames.push(start - m.previousFrame);
      }
      m.previousFrame = start;
    } else {
      m.previousFrame = 0;
    }
    return result;
  };
};

const resetMetrics = (pauseAtWetSeconds = 0) => {
  const m = window.__waterFxAudit;
  for (const key of [
    "entry",
    "wake",
    "exit",
    "peakParticles",
    "peakFoamDraws",
    "peakFoamTriangles",
    "wetFrames",
    "wetSeconds",
    "previousFrame",
  ]) {
    m[key] = 0;
  }
  for (const key of ["frames", "updateMs", "renderMs", "samples"]) {
    m[key].length = 0;
  }
  m.tireWet = {};
  m.pauseAtWetSeconds = pauseAtWetSeconds;
  m.active = true;
};

const summarize = () => {
  const m = window.__waterFxAudit;
  m.active = false;
  const timing = (values) => {
    const sorted = values.toSorted((a, b) => a - b);
    return {
      count: sorted.length,
      max: sorted.at(-1) ?? null,
      median: sorted[Math.floor(sorted.length * 0.5)] ?? null,
      p95: sorted[Math.floor(sorted.length * 0.95)] ?? null,
    };
  };
  return {
    entrySprays: m.entry,
    exitSprays: m.exit,
    frameMs: timing(m.frames),
    peakFoamDraws: m.peakFoamDraws,
    peakFoamTriangles: m.peakFoamTriangles,
    peakParticles: m.peakParticles,
    renderMs: timing(m.renderMs),
    samples: m.samples,
    tireWet: m.tireWet,
    updateMs: timing(m.updateMs),
    wakeSprays: m.wake,
    wetSeconds: m.wetSeconds,
  };
};

const release = async () => {
  await call("Input.dispatchTouchEvent", { touchPoints: [], type: "touchEnd" });
};
const capture = async (name) => {
  await evaluate("window.__waterFxAudit.capturing = true");
  try {
    await screenshot(name);
  } finally {
    await evaluate(
      "window.__waterFxAudit.capturing = false; window.__waterFxAudit.previousFrame = 0",
    );
  }
};
const metrics = async (width, height, waitForLayout = true) => {
  await call("Emulation.setDeviceMetricsOverride", {
    deviceScaleFactor: 3,
    height,
    mobile: true,
    width,
  });
  if (waitForLayout) {
    await until(`innerWidth === ${width} && innerHeight === ${height}`);
  }
};
const checkRun = (name, result, requireAllWet) => {
  const wet = result.samples.filter((sample) => sample.water === "floating");
  check(
    `${name} keeps finite physical motion and clears drift/airtime afloat`,
    wet.length > 30 &&
      (!requireAllWet || wet.length === result.samples.length) &&
      result.samples.every((sample) =>
        [sample.x, sample.y, sample.z, sample.heading, sample.speed].every(Number.isFinite),
      ) &&
      wet.every((sample) => !sample.airborne && !sample.drifting && sample.airTime === 0),
    {
      first: result.samples[0],
      frames: result.samples.length,
      last: result.samples.at(-1),
      wetFrames: wet.length,
    },
  );
  check(
    `${name} emits no tire matter or marks while wet`,
    Object.keys(result.tireWet).length === 0,
    result.tireWet,
  );
  check(
    `${name} water effects stay within one foam draw and compact pools`,
    result.peakFoamDraws === 1 && result.peakParticles <= 80 && result.peakFoamTriangles <= 1920,
    {
      draws: result.peakFoamDraws,
      particles: result.peakParticles,
      triangles: result.peakFoamTriangles,
    },
  );
};

try {
  await call("Page.enable");
  await call("Runtime.enable");
  await metrics(390, 844, false);
  await call("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
  await call("Emulation.setCPUThrottlingRate", { rate: cpuRate });
  if (noMultiDraw) {
    await call("Page.addScriptToEvaluateOnNewDocument", {
      source: `const get = WebGL2RenderingContext.prototype.getExtension;
        WebGL2RenderingContext.prototype.getExtension = function(name) {
          return name === 'WEBGL_multi_draw' ? null : get.call(this, name);
        };`,
    });
  }
  await call("Page.navigate", { url });
  await until("window.__taxi?.game.isReady === true");
  report.worldRevision = await evaluate(
    'import("/src/world/world-bin.ts").then(module => module.WORLD_REV)',
  );
  report.device = await run(() => {
    const r = window.__renderer;
    const gl = r.getContext();
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
    };
  });
  check(
    "actual coarse-pointer DPR3 phone path and requested extension fallback",
    report.device.coarse &&
      report.device.touch > 0 &&
      report.device.dpr === 3 &&
      !report.device.post &&
      (!noMultiDraw || !report.device.multiDraw),
    report.device,
  );
  await tap("#banner-cta");
  await until('window.__taxi.game.mode.kind === "playing"');
  await evaluate("window.__taxi.setTime(300);window.__taxi.setPhase(.25)");
  await run(installMetrics);

  const access = await evaluate(
    'import("/src/world/shoreline.ts").then(module => module.SHORE_ACCESS_SITES.find(site => site.id.includes("ocean")))',
  );
  if (!access) {
    throw new Error("Authored ocean access is missing");
  }
  report.access = access;
  await run((site) => {
    const g = window.__taxi.game;
    const yaw = Math.atan2(site.wet.x - site.dry.x, site.wet.z - site.dry.z);
    g.car.reset(site.dry.x, site.dry.z, yaw);
    g.rig.snapTo(g.car);
  }, access);
  await until(
    'window.__taxi.game.car.waterContact.kind === "dry" && window.__taxi.game.car.physicsVehicle.groundedWheels() >= 2',
  );
  await until("(window.__taxi.game.city.parcelStreamStats()?.pending ?? 0) === 0");
  await run(resetMetrics, 0.1);
  const stick = { id: 1, x: 100, y: 520 };
  await call("Input.dispatchTouchEvent", { touchPoints: [stick], type: "touchStart" });
  await until("window.__taxi.game.paused && window.__waterFxAudit.entry === 2", 45_000);
  await capture("portrait-day-entry");
  await evaluate("window.__taxi.game.requestResume()");
  await until("window.__waterFxAudit.wetSeconds >= 1.5", 15_000);
  await capture("portrait-day-wake");
  await release();
  await until("window.__taxi.game.car.speed < .5", 15_000);
  const brake = await touchPoint("#t-brake", 2);
  await call("Input.dispatchTouchEvent", { touchPoints: [brake], type: "touchStart" });
  await until(
    'window.__waterFxAudit.exit === 2 && window.__taxi.game.car.waterContact.kind === "dry"',
    45_000,
  );
  await capture("portrait-day-exit");
  await release();
  const contactRun = await run(summarize);
  report.contactRun = contactRun;
  check(
    "native touch entry and reverse exit each emit one paired splash",
    contactRun.entrySprays === 2 && contactRun.exitSprays === 2 && contactRun.wakeSprays > 4,
    { entry: contactRun.entrySprays, exit: contactRun.exitSprays, wake: contactRun.wakeSprays },
  );
  checkRun("shore transitions", contactRun, false);

  for (const [name, width, height, phase] of [
    ["portrait-day", 390, 844, 0.25],
    ["landscape-day", 844, 390, 0.25],
    ["portrait-night", 390, 844, 0.7],
    ["landscape-night", 844, 390, 0.7],
  ]) {
    await metrics(width, height);
    await run((day) => {
      const g = window.__taxi.game;
      window.__taxi.setPhase(day);
      g.car.reset(-1510, 200, 0);
      const waterY = g.city.waterHeightAt(-1510, 200);
      if (waterY === null) {
        throw new Error("Ocean staging point is dry");
      }
      g.car.physicsVehicle.teleport(-1510, waterY + 0.7, 200, 0);
      g.rig.snapTo(g.car);
    }, phase);
    await until(
      'window.__taxi.game.car.waterContact.kind === "floating" && window.__taxi.game.car.speed < .5',
    );
    await until("(window.__taxi.game.city.parcelStreamStats()?.pending ?? 0) === 0");
    await run(resetMetrics);
    const thumb = { id: 1, x: width < height ? 100 : 250, y: height * 0.62 };
    const start = await evaluate("window.__taxi.probe()");
    await call("Input.dispatchTouchEvent", { touchPoints: [thumb], type: "touchStart" });
    await until("window.__taxi.game.car.speed > 5", 15_000);
    await call("Input.dispatchTouchEvent", {
      touchPoints: [{ ...thumb, x: thumb.x - 28 }],
      type: "touchMove",
    });
    await until("window.__waterFxAudit.wetSeconds >= 4", 25_000);
    const result = await run(summarize);
    await screenshot(name);
    const end = result.samples.at(-1);
    const headingDelta = end
      ? Math.atan2(Math.sin(end.heading - start.heading), Math.cos(end.heading - start.heading))
      : 0;
    report.views.push({ name, ...result });
    check(
      `${name} native touch propels and steers within a bounded ocean route`,
      end &&
        end.speed > 3 &&
        Math.hypot(end.x - start.x, end.z - start.z) > 8 &&
        Math.abs(headingDelta) > 0.2 &&
        result.samples.every((sample) => Math.hypot(sample.x + 1510, sample.z - 200) < 60),
      { end, headingDelta, start },
    );
    checkRun(name, result, true);
    check(
      `${name} wakes follow sustained movement without repeated entry spray`,
      result.entrySprays === 0 && result.wakeSprays > 10,
      { entry: result.entrySprays, wake: result.wakeSprays },
    );
    await release();
  }
  check("no water VFX page errors", pageErrors.length === 0, pageErrors);
  if (report.checks.some((entry) => !entry.passed)) {
    process.exitCode = 1;
  }
} catch (error) {
  check("water VFX run completed", false, String(error));
  process.exitCode = 1;
  try {
    await screenshot("failure");
    report.failureState = await evaluate(
      "({probe:window.__taxi?.probe(),audit:window.__waterFxAudit,text:document.body.innerText})",
    );
  } catch (captureError) {
    report.captureError = String(captureError);
  }
} finally {
  writeFileSync(path.join(output, "report.json"), JSON.stringify(report, null, 2));
  close();
}
