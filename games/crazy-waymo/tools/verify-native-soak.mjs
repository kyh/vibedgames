import { execFile, spawn } from "node:child_process";
import { createWriteStream, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

// Run serially; keep other rendering browsers and heavy builds idle.
// This script owns exactly one newly created simulator, one Appium process,
// and one session. No `all`, no existing device reuse, no agent-browser close.
const run = promisify(execFile);
if (process.argv.includes("--help")) {
  console.log(
    "node tools/verify-native-soak.mjs [dev-url] [output-dir] [seconds=240]\nRequires Appium on PATH with XCUITest installed; inherits APPIUM_HOME. WAYMO_APPIUM_MAIN optionally selects a local Appium module run with Node. WAYMO_APPIUM_HOME optionally overrides the inherited driver home.\nExample for this machine's temporary install:\nWAYMO_APPIUM_MAIN=/private/tmp/crazy-waymo-ios-tools/node_modules/appium/index.js WAYMO_APPIUM_HOME=/private/tmp/crazy-waymo-ios-appium node tools/verify-native-soak.mjs\nCreates/deletes one owned simulator; preserves every existing simulator. Run serially.",
  );
  process.exit(0);
}
const url = process.argv[2] ?? "http://localhost:5193/?time=noon&offline=1";
const durationSeconds = Number(process.argv[4] ?? 240);
if (!Number.isFinite(durationSeconds) || durationSeconds < 120 || durationSeconds > 600)
  throw new Error("Soak duration must be 120..600 seconds");
const out = process.argv[3] ?? `/private/tmp/waymo-native-soak-${process.pid}`;
const preserved = new Set();
mkdirSync(out, { recursive: true });
const revisionSource = readFileSync(
  fileURLToPath(new URL("../src/world/world-bin.ts", import.meta.url)),
  "utf8",
);
const expectedRevision = Number(revisionSource.match(/export const WORLD_REV = (\d+);/)?.[1]);
if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1)
  throw new Error("Cannot read expected WORLD_REV from source");
const report = {
  checkedAt: new Date().toISOString(),
  url,
  scope:
    "Native iOS Safari simulator sustained rendering and resource stability. Default-framebuffer render submissions, not display callbacks or GPU timings. Staged routes; trusted native touch drives. No physical-phone, heap, power or thermal claim.",
  expectedRevision,
  durationSeconds,
  checks: [],
  cases: [],
};
let ownedId = null;
let appium = null;
let sessionId = null;
let endpoint = "";
let cleaned = null;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const save = () => writeFileSync(join(out, "report.json"), JSON.stringify(report, null, 2) + "\n");
const check = (name, passed, evidence) => {
  const entry = { name, passed, evidence };
  report.checks.push(entry);
  console.log(JSON.stringify(entry));
  save();
};
const command = async (name, args, timeout = 120000) =>
  (await run(name, args, { timeout, maxBuffer: 8 * 1024 * 1024 })).stdout.trim();
const states = async () => {
  const data = JSON.parse(await command("xcrun", ["simctl", "list", "devices", "--json"]));
  return Object.values(data.devices)
    .flat()
    .filter((device) => !ownedId || device.udid !== ownedId)
    .map((device) => ({ id: device.udid, state: device.state }))
    .toSorted((a, b) => a.id.localeCompare(b.id));
};
async function port() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!Number.isSafeInteger(address?.port)) throw new Error("No owned local port");
  const result = address.port;
  await new Promise((resolve) => server.close(resolve));
  return result;
}
async function http(method, path, body, timeout = 180000) {
  const options = {
    method,
    headers: { "content-type": "application/json" },
    signal: AbortSignal.timeout(timeout),
  };
  if (body !== undefined) options.body = JSON.stringify(body);
  const response = await fetch(`${endpoint}${path}`, options);
  const data = await response.json();
  if (!response.ok || data.value?.error)
    throw new Error(`${method} ${path}: ${JSON.stringify(data.value ?? data)}`);
  return data.value;
}
const call = (method, path, body) => {
  if (!sessionId) throw new Error("Owned Safari session absent");
  return http(method, `/session/${sessionId}${path}`, body);
};
const evaluate = (script) => call("POST", "/execute/sync", { script, args: [] });
async function until(script, timeout = 120000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await evaluate(script)) return;
    await sleep(500);
  }
  throw new Error(`Timeout: ${script}`);
}
async function startSnapshot() {
  return evaluate(`
    const cta=document.querySelector('#banner-cta'),banner=document.querySelector('#banner');
    const rect=cta?.getBoundingClientRect(),style=cta?getComputedStyle(cta):null,bs=banner?getComputedStyle(banner):null;
    const center=rect?{x:rect.x+rect.width/2,y:rect.y+rect.height/2}:null;
    const describe=element=>element?{id:element.id,tag:element.tagName,cta:!!element.closest('#banner-cta'),ignored:!!element.closest('[data-gamepad-ignore]')}:null;
    return {mode:window.__taxi?.game.mode.kind,ready:window.__taxi?.game.isReady,fonts:document.fonts?.status,focus:document.hasFocus(),visibility:document.visibilityState,
      banner:{classes:banner?.className,inert:banner?.inert,opacity:bs?.opacity,display:bs?.display,visibility:bs?.visibility},
      cta:{rect:rect?.toJSON(),center,pointerEvents:style?.pointerEvents,visibility:style?.visibility,transform:style?.transform,animation:style?.animationName},
      hit:center?describe(document.elementFromPoint(center.x,center.y)):null,
      active:describe(document.activeElement),viewport:{width:innerWidth,height:innerHeight,screenWidth:screen.width,screenHeight:screen.height,dpr:devicePixelRatio,scrollX,scrollY,visual:window.visualViewport?{offsetLeft:visualViewport.offsetLeft,offsetTop:visualViewport.offsetTop,pageTop:visualViewport.pageTop,width:visualViewport.width,height:visualViewport.height,scale:visualViewport.scale}:null},
      events:window.__coastSafari?.events??[],errors:window.__coastSafari?.errors??[]};
  `);
}
async function waitForStartTarget() {
  let previous = null,
    stable = 0;
  const begin = Date.now();
  while (Date.now() - begin < 15000) {
    const state = await startSnapshot(),
      center = state.cta.center;
    const visible =
      state.ready &&
      state.fonts === "loaded" &&
      state.visibility === "visible" &&
      !state.banner.inert &&
      Number(state.banner.opacity) >= 0.99 &&
      state.cta.pointerEvents === "auto" &&
      state.hit?.cta &&
      state.cta.rect.width > 0;
    // The CTA pulses continuously. Its center must be stable; waiting for
    // every animation to end would never finish, and pausing it hides bugs.
    if (
      visible &&
      center &&
      previous &&
      Math.hypot(center.x - previous.x, center.y - previous.y) < 0.5
    )
      stable++;
    else stable = 0;
    if (stable >= 2) return state;
    previous = center;
    await sleep(250);
  }
  throw new Error("Start CTA did not become visible, hit-testable and center-stable");
}
async function directStartTouch(before, attempt) {
  // Resolve the existing accessibility label, never rewrite DOM attributes.
  // Native and web centers also record Safari's actual viewport offset.
  const webContext = await call("GET", "/context");
  await call("POST", "/context", { name: "NATIVE_APP" });
  try {
    const elements = await call("POST", "/elements", {
      using: "accessibility id",
      value: "Start driving",
    });
    if (elements.length !== 1)
      throw new Error(`Expected one native Start button, found ${elements.length}`);
    const id = elements[0]["element-6066-11e4-a52e-4f735466cecf"];
    if (!id) throw new Error("Native Start accessibility element missing ID");
    const rect = await call("GET", `/element/${id}/rect`);
    const x = Math.round(rect.x + rect.width / 2),
      y = Math.round(rect.y + rect.height / 2);
    const evidence = {
      method: "native-w3c-touch",
      duration: 100,
      nativeRect: rect,
      nativeCenter: { x, y },
      webCenter: before.cta.center,
      offset: { x: x - before.cta.center.x, y: y - before.cta.center.y },
    };
    await call("POST", "/actions", {
      actions: [
        {
          type: "pointer",
          id: `start-${attempt}`,
          parameters: { pointerType: "touch" },
          actions: [
            { type: "pointerMove", duration: 0, origin: "viewport", x, y },
            { type: "pointerDown", button: 0 },
            { type: "pause", duration: 100 },
            { type: "pointerUp", button: 0 },
          ],
        },
      ],
    });
    return evidence;
  } finally {
    await call("POST", "/context", { name: webContext });
  }
}
async function activateStart() {
  const before = await waitForStartTarget(),
    eventIndex = before.events.length;
  const entry = { attempt: 1, before };
  report.startAttempts = [entry];
  save();
  entry.gesture = await directStartTouch(before, 1);
  await sleep(700);
  entry.after = await startSnapshot();
  entry.events = entry.after.events.slice(eventIndex);
  const down = entry.events.find(
    (event) =>
      event.type === "pointerdown" &&
      event.phase === "capture" &&
      event.trusted &&
      event.cta &&
      event.pointer === "touch",
  );
  const up = entry.events.find(
    (event) =>
      event.type === "pointerup" &&
      event.phase === "capture" &&
      event.trusted &&
      event.cta &&
      event.pointer === "touch" &&
      event.pointerId === down?.pointerId,
  );
  const validTouch =
    !!down &&
    !!up &&
    Math.hypot(up.x - down.x, up.y - down.y) <= 12 &&
    !entry.events.some(
      (event) => event.type === "pointercancel" && event.pointerId === down.pointerId,
    );
  entry.delivery = validTouch ? "trusted-cta-pointerup" : "invalid-first-touch";
  save();
  if (!validTouch)
    throw new Error("First native Start gesture was not a valid trusted touch release; no retries");
  try {
    await until('return window.__taxi.game.mode.kind === "playing";', 25000);
  } catch (error) {
    entry.failureState = await startSnapshot();
    save();
    throw new Error(`First native touch did not start play (mode ${entry.failureState.mode})`, {
      cause: error,
    });
  }
  entry.completed = await startSnapshot();
  save();
  check(
    "First native Start touch reaches play without retry",
    entry.completed.mode === "playing" && validTouch,
    { attempts: report.startAttempts },
  );
}
async function screenshot(name) {
  const png = await call("GET", "/screenshot");
  writeFileSync(join(out, `${name}.png`), Buffer.from(png, "base64"));
}
async function cleanup() {
  if (cleaned) return cleaned;
  cleaned = (async () => {
    if (sessionId) {
      try {
        await http("DELETE", `/session/${sessionId}`, undefined, 45000);
      } catch (error) {
        report.sessionCleanup = String(error);
      }
      sessionId = null;
    }
    if (appium) {
      appium.kill("SIGTERM");
      await Promise.race([new Promise((resolve) => appium.once("exit", resolve)), sleep(3000)]);
      if (appium.exitCode === null && appium.signalCode === null) appium.kill("SIGKILL");
    }
    if (ownedId && !preserved.has(ownedId)) {
      try {
        await command("xcrun", ["simctl", "shutdown", ownedId], 60000);
      } catch (error) {
        report.shutdownNote = String(error);
      }
      try {
        await command("xcrun", ["simctl", "delete", ownedId], 60000);
        report.ownedSimulatorDeleted = true;
      } catch (error) {
        report.deleteFailure = String(error);
      }
    }
    try {
      const after = await states();
      check(
        "Existing simulator states preserved",
        JSON.stringify(after) === JSON.stringify(report.preservedBefore),
        after,
      );
    } catch (error) {
      report.preservationFailure = String(error);
    }
    save();
  })();
  return cleaned;
}
for (const signal of ["SIGINT", "SIGTERM"])
  process.once(signal, async () => {
    report.interrupted = signal;
    await cleanup();
    process.exit(1);
  });

// Fixed-size page instrumentation. No frame/pose history grows with soak time.
const instrumentation = `
  const s = window.__coastSafari, renderer = window.__renderer, game = window.__taxi.game;
  const foam = game.scene.getObjectByName('vehicle-water-foam');
  const make = () => ({ bins: new Uint32Array(4001), count: 0, sum: 0, max: 0, over50: 0, over100: 0 });
  const add = (h, ms) => { if (!Number.isFinite(ms) || ms < 0) return; h.bins[Math.min(4000, Math.floor(ms * 4))]++; h.count++; h.sum += ms; h.max = Math.max(h.max, ms); if (ms > 50) h.over50++; if (ms > 100) h.over100++; };
  const summary = h => { const q = f => { let n = 0; const at = Math.ceil(h.count * f); for (let i = 0; i < h.bins.length; i++) { n += h.bins[i]; if (n >= at) return i / 4; } return null; }; return { count: h.count, medianMs: h.count ? q(.5) : null, p95Ms: h.count ? q(.95) : null, maxMs: h.max, meanMs: h.count ? h.sum / h.count : null, over50: h.over50, over100: h.over100, precisionMs: .25, histogramCeilingMs: 1000 }; };
  s.measure = { all: make(), moving: make(), cpu: make(), transition: make(), active: false, previous: null, frames: 0, movingFrames: 0, maxCalls: 0, maxTriangles: 0, callSum: 0, triangleSum: 0, finite: true, wetFrames: 0, maxThrottle: 0, maxSteer: 0, maxFoamIndices: 0, tiers: new Uint32Array(5), totalRenders: 0 };
  s.metrics = () => { const m = s.measure; return { all: summary(m.all), moving: summary(m.moving), renderCpu: summary(m.cpu), transition: summary(m.transition), frames: m.frames, movingFrames: m.movingFrames, movingFraction: m.frames ? m.movingFrames / m.frames : 0, meanCalls: m.frames ? m.callSum / m.frames : 0, maxCalls: m.maxCalls, meanTriangles: m.frames ? m.triangleSum / m.frames : 0, maxTriangles: m.maxTriangles, finite: m.finite, wetFrames: m.wetFrames, maxThrottle: m.maxThrottle, maxSteer: m.maxSteer, maxFoamIndices: m.maxFoamIndices, tiers: Array.from(m.tiers), totalRenders: m.totalRenders }; };
  s.resources = () => ({ at: performance.now(), renderer: { ...renderer.info.memory }, programs: renderer.info.programs?.length ?? 0, parcels: game.city.parcelStreamStats(), tier: window.__perf.tier(), pixelRatio: renderer.getPixelRatio(), buffer: { width: renderer.domElement.width, height: renderer.domElement.height }, mode: game.mode.kind, visibility: document.visibilityState, contextLost: renderer.getContext().isContextLost() });
  const render = renderer.render;
  renderer.render = function(...args) {
    if (this.getRenderTarget() !== null) return render.apply(this, args);
    const m = s.measure, now = performance.now(), dt = m.previous === null ? null : now - m.previous;
    const result = render.apply(this, args), cpu = performance.now() - now;
    m.previous = now; m.totalRenders++;
    if (dt !== null) add(m.active ? m.all : m.transition, dt);
    if (m.active) {
      const car = game.car, input = game.input.carInput(); m.frames++;
      if (Math.abs(car.speed) > 1) { m.movingFrames++; if (dt !== null) add(m.moving, dt); }
      add(m.cpu, cpu); m.callSum += this.info.render.calls; m.triangleSum += this.info.render.triangles;
      m.maxCalls = Math.max(m.maxCalls, this.info.render.calls); m.maxTriangles = Math.max(m.maxTriangles, this.info.render.triangles);
      m.finite &&= [car.position.x, car.position.y, car.position.z, car.speed, car.heading].every(Number.isFinite);
      if (car.waterContact.kind === 'floating') m.wetFrames++;
      m.maxThrottle = Math.max(m.maxThrottle, input.throttle); m.maxSteer = Math.max(m.maxSteer, Math.abs(input.steer));
      if (foam?.visible) m.maxFoamIndices = Math.max(m.maxFoamIndices, foam.geometry.drawRange.count);
      const tier = window.__perf.tier(); if (tier >= 0 && tier < 5) m.tiers[tier]++;
    }
    return result;
  };
  s.resetMetrics = () => { for (const key of ['all','moving','cpu','transition']) { const h = s.measure[key]; h.bins.fill(0); h.count = h.sum = h.max = h.over50 = h.over100 = 0; } Object.assign(s.measure,{ active:false, previous:null, frames:0, movingFrames:0, maxCalls:0, maxTriangles:0, callSum:0, triangleSum:0, finite:true, wetFrames:0, maxThrottle:0, maxSteer:0, maxFoamIndices:0 }); s.measure.tiers.fill(0); };
  return true;
`;

async function heldTouch(label, holdMs, dragX) {
  const point = await evaluate(
    `const x=Math.round(innerWidth*.3),y=Math.round(innerHeight*.58),e=document.elementFromPoint(x,y);return {x,y,tag:e?.tagName};`,
  );
  if (point.tag !== "CANVAS") throw new Error(`Drive input covered: ${JSON.stringify(point)}`);
  const offset = report.startAttempts[0].gesture.offset;
  const x = Math.round(point.x + offset.x),
    y = Math.round(point.y + offset.y);
  const context = await call("GET", "/context");
  await call("POST", "/context", { name: "NATIVE_APP" });
  try {
    await call("POST", "/actions", {
      actions: [
        {
          type: "pointer",
          id: label,
          parameters: { pointerType: "touch" },
          actions: [
            { type: "pointerMove", duration: 0, origin: "viewport", x, y },
            { type: "pointerDown", button: 0 },
            ...(dragX
              ? [{ type: "pointerMove", duration: 200, origin: "viewport", x: x + dragX, y }]
              : []),
            { type: "pause", duration: holdMs },
            { type: "pointerUp", button: 0 },
          ],
        },
      ],
    });
  } finally {
    await call("POST", "/context", { name: context });
  }
}

async function stage(kind, phase) {
  await evaluate(`const t=window.__taxi,g=t.game,s=window.__coastSafari;
    s.measure.active=false;s.measure.previous=null;t.setTime(600);t.setPhase(${phase});t.setFreecam(false);g.input.setScripted(null);
    const pose=${kind === "coast" ? "{x:-1510,z:200,yaw:0}" : "s.denseSpawn"};
    g.car.reset(pose.x,pose.z,pose.yaw);g.rig.snapTo(g.car);
    g.traffic.reset({gx:g.city.gridX(pose.x),gz:g.city.gridZ(pose.z)},70);g.traffic.setHoldRecycle(true);return true;`);
  await sleep(1500);
}

async function nativePauseResume() {
  const context = await call("GET", "/context");
  // A page cannot synthesize a trusted native touch. Use calibrated viewport
  // coordinates for both pause and resume; never call game.requestPause here.
  for (const [selector, pause] of [
    ['.waymo-touch [aria-label="Pause"]', true],
    ["#waymo-pause .pcta", false],
  ]) {
    const target = await evaluate(
      `const e=document.querySelector(${JSON.stringify(selector)});if(!e)return null;const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};`,
    );
    if (!target) return { unsupportedSelector: selector };
    const offset = report.startAttempts[0].gesture.offset;
    await call("POST", "/context", { name: "NATIVE_APP" });
    try {
      await call("POST", "/actions", {
        actions: [
          {
            type: "pointer",
            id: "pause-native",
            parameters: { pointerType: "touch" },
            actions: [
              {
                type: "pointerMove",
                duration: 0,
                origin: "viewport",
                x: Math.round(target.x + offset.x),
                y: Math.round(target.y + offset.y),
              },
              { type: "pointerDown", button: 0 },
              { type: "pause", duration: 100 },
              { type: "pointerUp", button: 0 },
            ],
          },
        ],
      });
    } finally {
      await call("POST", "/context", { name: context });
    }
    await until(`return window.__taxi.game.paused === ${pause};`, 5000);
    if (pause) {
      const before = await evaluate("return window.__coastSafari.measure.totalRenders;");
      await sleep(1500);
      const after = await evaluate("return window.__coastSafari.measure.totalRenders;");
      check("Native pause stops repeated rendering", after - before <= 1, { before, after });
    }
  }
  const before = await evaluate("return window.__coastSafari.measure.totalRenders;");
  await sleep(700);
  const after = await evaluate("return window.__coastSafari.measure.totalRenders;");
  return { resumed: after - before > 10, renders: after - before };
}

try {
  report.preservedBefore = await states();
  for (const device of report.preservedBefore) preserved.add(device.id);
  const runtimes = JSON.parse(
    await command("xcrun", ["simctl", "list", "runtimes", "--json"]),
  ).runtimes;
  const runtime = runtimes
    .filter((runtime) => runtime.isAvailable && runtime.name.startsWith("iOS"))
    .toSorted((a, b) => b.version.localeCompare(a.version, undefined, { numeric: true }))[0];
  const types = JSON.parse(
    await command("xcrun", ["simctl", "list", "devicetypes", "--json"]),
  ).devicetypes;
  const type = types.find((type) => type.name === "iPhone 17 Pro");
  if (!runtime || !type)
    throw new Error("Available iOS runtime / iPhone 17 Pro device type missing");
  ownedId = await command("xcrun", [
    "simctl",
    "create",
    `Crazy Waymo Soak ${Date.now()}`,
    type.identifier,
    runtime.identifier,
  ]);
  if (!/^[0-9A-F-]{36}$/i.test(ownedId) || preserved.has(ownedId))
    throw new Error("Fresh simulator ownership validation failed");
  report.ownedSimulator = ownedId;
  report.runtime = { name: runtime.name, version: runtime.version, device: type.name };
  save();
  console.log("Created owned simulator; booting.");
  await command("xcrun", ["simctl", "boot", ownedId]);
  await command("xcrun", ["simctl", "bootstatus", ownedId, "-b"], 180000);
  await command("open", ["-a", "Simulator", "--args", "-CurrentDeviceUDID", ownedId]);
  const appiumPort = await port(),
    wdaPort = await port();
  endpoint = `http://127.0.0.1:${appiumPort}`;
  const log = createWriteStream(join(out, "appium.log"));
  const appiumArgs = [
    "--address",
    "127.0.0.1",
    "--port",
    String(appiumPort),
    "--log-level",
    "warn",
    "--log-timestamp",
  ];
  const appiumEnv = { ...process.env };
  if (process.env.WAYMO_APPIUM_HOME !== undefined)
    appiumEnv.APPIUM_HOME = process.env.WAYMO_APPIUM_HOME;
  const appiumMain = process.env.WAYMO_APPIUM_MAIN;
  if (appiumMain !== undefined) appiumArgs.unshift(appiumMain);
  appium = spawn(appiumMain === undefined ? "appium" : process.execPath, appiumArgs, {
    env: appiumEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let appiumFailure = null;
  appium.once("error", (error) => {
    appiumFailure = error;
  });
  appium.stdout.pipe(log);
  appium.stderr.pipe(log);
  report.appiumPid = appium.pid;
  let ready = false;
  for (let i = 0; i < 60; i++) {
    if (appiumFailure) throw new Error("Could not launch owned Appium", { cause: appiumFailure });
    try {
      await http("GET", "/status", undefined, 1000);
      ready = true;
      break;
    } catch {
      await sleep(500);
    }
  }
  if (!ready) throw new Error("Owned Appium server did not become ready");
  console.log("Creating native Safari session; WDA may compile.");
  const session = await http(
    "POST",
    "/session",
    {
      capabilities: {
        alwaysMatch: {
          platformName: "iOS",
          browserName: "Safari",
          "appium:automationName": "XCUITest",
          "appium:deviceName": type.name,
          "appium:udid": ownedId,
          "appium:platformVersion": runtime.version,
          "appium:wdaLocalPort": wdaPort,
          "appium:shutdownOtherSimulators": false,
          "appium:showXcodeLog": false,
          "appium:showSafariConsoleLog": true,
          "appium:showSafariNetworkLog": true,
          "appium:newCommandTimeout": 1800,
          "appium:nativeWebTap": true,
          "appium:waitForIdleTimeout": 0,
          "appium:safariInitialUrl": "about:blank",
          "appium:noReset": true,
        },
        firstMatch: [{}],
      },
    },
    300000,
  );
  sessionId = session.sessionId;
  if (!sessionId) throw new Error("Appium did not return owned session ID");
  report.sessionId = sessionId;
  save();
  await call("POST", "/orientation", { orientation: "PORTRAIT" });
  await call("POST", "/url", { url });
  await until(
    'return window.__taxi?.game.isReady === true && getComputedStyle(document.querySelector("#loading")).display === "none" && document.querySelector("#banner-cta").getBoundingClientRect().width > 0;',
    150000,
  );
  const env = await evaluate(
    'return {title:document.title,width:innerWidth,height:innerHeight,dpr:devicePixelRatio,coarse:matchMedia("(pointer:coarse)").matches,post:window.__post !== null,renderer:window.__renderer.getContext().getParameter(window.__renderer.getContext().RENDERER)};',
  );
  check(
    "Native Safari initializes the coarse DPR3 phone render path",
    env.title === "Crazy Waymo" && env.coarse && env.dpr === 3 && !env.post,
    env,
  );
  await evaluate(`
    window.__coastSafari={errors:[],events:[]};
    const bounded=(array,value)=>{if(array.length<64)array.push(value);};
    window.addEventListener('error',e=>bounded(window.__coastSafari.errors,String(e.message)));
    window.addEventListener('unhandledrejection',e=>bounded(window.__coastSafari.errors,String(e.reason)));
    const canvas=window.__renderer.domElement;
    canvas.addEventListener('webglcontextlost',()=>bounded(window.__coastSafari.errors,'webglcontextlost'));
    for(const type of ['pointerdown','pointerup','pointercancel']) for(const capture of [true,false]) document.addEventListener(type,e=>{
      const a=window.__coastSafari.events;if(a.length>=64)a.shift();a.push({type,phase:capture?'capture':'bubble',trusted:e.isTrusted,pointer:e.pointerType,pointerId:e.pointerId,mode:window.__taxi.game.mode.kind,cta:!!e.target.closest?.('#banner-cta'),tag:e.target.tagName,x:e.clientX,y:e.clientY});
    },{capture,passive:true});return true;
  `);
  await activateStart();
  await evaluate(instrumentation);
  // Boundary parsing stays on the page because Vite resolves these modules.
  // Use the installed spawn contract, including full solid/deck clearance.
  await evaluate(`
    window.__nativeSetup=null;
    Promise.all([import('/src/world/player-spawn.ts'),import('/src/world/world-bin.ts')]).then(async([spawn,bin])=>{
      const g=window.__taxi.game,c=g.city;
      const world={network:c.network,solids:g.solidIndex,decks:c.getDecks(),heightAt:(x,z)=>c.heightAt(x,z)};
      const target={x:420,z:-450};
      const edges=c.network.edges.filter(e=>e.len>=30).map(e=>({e,p:c.network.sample(e,e.len*.5)})).toSorted((a,b)=>Math.hypot(a.p.x-target.x,a.p.z-target.z)-Math.hypot(b.p.x-target.x,b.p.z-target.z));
      let candidate=null;
      for(const {e} of edges.slice(0,512)) { for(const sign of [-1,1]) { const p=spawn.spawnOnEdge(c.network,e,.5,sign);if(spawn.isPlayerSpawnSafe(world,p)){candidate=p;break;} } if(candidate)break; }
      if(!candidate)throw new Error('No safe dense-district 80u driving corridor');
      window.__coastSafari.denseSpawn=candidate;
      const bytes=await(await fetch('/world/world.bin?v='+bin.WORLD_REV)).arrayBuffer();
      const inflated=await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
      const installed=bin.deserializeWorldBin(inflated);
      window.__nativeSetup={revision:bin.WORLD_REV,installedRevision:installed.rev,denseSpawn:candidate};
    }).catch(e=>window.__nativeSetup={error:String(e)});return true;
  `);
  await until("return window.__nativeSetup!==null;", 30000);
  report.world = await evaluate("return window.__nativeSetup;");
  check(
    "Source and installed world match",
    report.world.revision === expectedRevision &&
      report.world.installedRevision === expectedRevision,
    report.world,
  );
  if (!report.checks.at(-1).passed) throw new Error("Native soak world mismatch");
  report.initialResources = await evaluate("return window.__coastSafari.resources();");
  const phases = [
    { name: "dense-day", kind: "dense", phase: 0.25 },
    { name: "coast-day", kind: "coast", phase: 0.25 },
    { name: "dense-night", kind: "dense", phase: 0.7 },
    { name: "coast-night", kind: "coast", phase: 0.7 },
  ];
  for (const phase of phases) {
    await stage(phase.kind, phase.phase);
    // Fill the destination outside steady drive histograms. Timed separately.
    const loadingStart = Date.now();
    await until("return window.__taxi.game.city.parcelStreamStats().pending===0;", 60000);
    const loadingMs = Date.now() - loadingStart;
    await evaluate("window.__coastSafari.resetMetrics();return true;");
    const stageReport = {
      name: phase.name,
      kind: phase.kind,
      phase: phase.phase,
      loadingMs,
      resourcesBefore: await evaluate("return window.__coastSafari.resources();"),
      samples: [],
      legs: [],
    };
    const deadline = Date.now() + (durationSeconds * 1000) / phases.length;
    let nextResource = 0;
    while (Date.now() < deadline) {
      await stage(phase.kind, phase.phase);
      const before = await evaluate("return window.__taxi.probe();");
      await evaluate(
        "window.__coastSafari.measure.active=true;window.__coastSafari.measure.previous=null;return true;",
      );
      const holdMs = phase.kind === "coast" ? 8000 : 3000;
      await heldTouch(
        `${phase.name}-${stageReport.legs.length}`,
        holdMs,
        phase.kind === "coast" ? 35 : 0,
      );
      await evaluate(
        "window.__coastSafari.measure.active=false;window.__coastSafari.measure.previous=null;return true;",
      );
      const after = await evaluate("return window.__taxi.probe();");
      stageReport.legs.push({
        holdMs,
        travel: Math.hypot(after.x - before.x, after.z - before.z),
        endSpeed: after.speed,
        water: after.waterContact.kind,
        headingChange: after.heading - before.heading,
      });
      if (Date.now() >= nextResource) {
        stageReport.samples.push(await evaluate("return window.__coastSafari.resources();"));
        nextResource = Date.now() + 15000;
      }
    }
    stageReport.metrics = await evaluate("return window.__coastSafari.metrics();");
    stageReport.resourcesAfter = await evaluate("return window.__coastSafari.resources();");
    report.cases.push(stageReport);
    save();
    const m = stageReport.metrics;
    check(
      `Sustained native motion and finite rendering (${phase.name})`,
      m.frames > 60 &&
        m.movingFraction > 0.45 &&
        m.maxThrottle === 1 &&
        m.finite &&
        stageReport.legs.every((leg) => leg.travel > 8),
      { metrics: m, legs: stageReport.legs.length },
    );
    if (phase.kind === "coast")
      check(
        `Floating steering and foam (${phase.name})`,
        m.wetFrames / m.frames > 0.95 && m.maxSteer > 0.4 && m.maxFoamIndices > 0,
        {
          wetFraction: m.wetFrames / m.frames,
          maxSteer: m.maxSteer,
          maxFoamIndices: m.maxFoamIndices,
        },
      );
    await screenshot(phase.name);
  }
  const resumed = await nativePauseResume();
  check("Native resume restores rendering", resumed.resumed === true, resumed);
  report.finalResources = await evaluate("return window.__coastSafari.resources();");
  const errors = await evaluate(
    "return {errors:window.__coastSafari.errors,failedPrograms:(window.__renderer.info.programs??[]).filter(p=>p.diagnostics?.runnable===false).length,contextLost:window.__renderer.getContext().isContextLost()};",
  );
  check(
    "No observed runtime, shader or context-loss failures",
    errors.errors.length === 0 && errors.failedPrograms === 0 && !errors.contextLost,
    errors,
  );
  const logs = await call("POST", "/log", { type: "safariConsole" });
  writeFileSync(join(out, "safari-console.json"), JSON.stringify(logs, null, 2) + "\n");
  const parsed = logs.map((entry) => {
    try {
      return JSON.parse(entry.message);
    } catch {
      return { level: entry.level, text: entry.message };
    }
  });
  const severe = parsed.filter(
    (entry) =>
      (entry.level === "error" || entry.level === "SEVERE") &&
      !(
        entry.source === "network" &&
        /\/world\/rest\.bin\?v=\d+$/.test(entry.url ?? "") &&
        String(entry.text).includes("404")
      ),
  );
  check("No Safari console errors", severe.length === 0, severe.slice(0, 64));
} catch (error) {
  report.failure = String(error);
  console.error(String(error));
  if (sessionId) {
    try {
      report.failureState = await startSnapshot();
    } catch {}
    try {
      await screenshot("failure");
    } catch {}
  }
} finally {
  await cleanup();
  report.passed =
    !report.failure &&
    !report.deleteFailure &&
    !report.preservationFailure &&
    !report.sessionCleanup &&
    report.cases.length === 4 &&
    report.checks.every((c) => c.passed);
  save();
  if (!report.passed) process.exitCode = 1;
  console.log(
    JSON.stringify({
      passed: report.passed,
      checks: report.checks.length,
      report: join(out, "report.json"),
      ownedSimulatorDeleted: report.ownedSimulatorDeleted,
    }),
  );
}
