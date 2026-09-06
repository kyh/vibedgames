// Browser audio acceptance: real controls and staged game positions/timers.
// Usage: node tools/verify-sfx.mjs [dev-url] [output-directory]
import { writeFileSync } from "node:fs";
import path from "node:path";
import { createMobileSession } from "./mobile-browser-session.mjs";

const url = process.argv[2] ?? "http://localhost:5193/?time=noon&offline=1";
const output = path.resolve(process.argv[3] ?? "/private/tmp/waymo-sfx");
const { call, evaluate, until, sleep, screenshot, close, pageErrors } = await createMobileSession({
  sessionPrefix: "crazy-waymo-sfx",
  output,
});
const report = { url, checkedAt: new Date().toISOString(), checks: [] };
function check(name, passed, evidence) {
  report.checks.push({ name, passed, evidence });
  console.log(JSON.stringify({ name, passed, evidence }));
  if (!passed) throw new Error(name);
}
const count = (method) =>
  evaluate(`window.__sfxEvents.filter(event => event.method === ${JSON.stringify(method)}).length`);
const diagnostics = () => evaluate("window.__taxi.game.sfx.diagnostics()");
async function key(name, code, virtualKey, hold = 80) {
  const event = { key: name, code, windowsVirtualKeyCode: virtualKey };
  await call("Input.dispatchKeyEvent", { ...event, type: "keyDown" });
  await sleep(hold);
  await call("Input.dispatchKeyEvent", { ...event, type: "keyUp" });
}
async function click(selector) {
  await until(
    `(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)return false;const r=e.getBoundingClientRect();return r.width>0&&r.height>0&&e.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2))})()`,
  );
  const point = await evaluate(
    `(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`,
  );
  await call("Input.dispatchMouseEvent", { type: "mouseMoved", ...point });
  await call("Input.dispatchMouseEvent", {
    type: "mousePressed",
    button: "left",
    clickCount: 1,
    ...point,
  });
  await call("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    button: "left",
    clickCount: 1,
    ...point,
  });
}
async function stageFareObjective() {
  await evaluate(`(()=>{
    const game = window.__taxi.game;
    const objective = game.fares.objective();
    if (!objective) throw new Error("No passenger objective");
    const pos = objective.pos;
    const hit = game.city.network.nearest(pos.x, pos.z, 80);
    if (!hit) throw new Error("Fare has no reachable road");
    const dx = pos.x - hit.x, dz = pos.z - hit.z;
    const distance = Math.hypot(dx, dz) || 1;
    const offset = Math.min(hit.edge.half - 1, Math.max(0, distance - 2.8));
    game.car.reset(hit.x + dx / distance * offset, hit.z + dz / distance * offset, Math.atan2(hit.tx, hit.tz));
    game.rig.snapTo(game.car);
  })()`);
}
try {
  await call("Runtime.enable");
  await call("Page.enable");
  await call("Emulation.setDeviceMetricsOverride", {
    width: 1440,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await call("Page.navigate", { url });
  await until('window.__taxi?.game.isReady && window.__taxi.game.mode.kind === "title"');
  await evaluate(`(()=>{
    const sfx = window.__taxi.game.sfx;
    window.__sfxEvents = [];
    for (const method of ["ui", "countdown", "go", "pause", "resume", "reset", "boost", "boostEnd", "boostReady", "miniTurbo", "driftArm", "jump", "landThud", "crash", "thud", "pickup", "dropoff", "passengerWarning", "passengerBail", "unlock", "denied", "waterSplash", "honk", "nearMiss"]) {
      const original = sfx[method].bind(sfx);
      sfx[method] = (...args) => {
        window.__sfxEvents.push({ method, args, at: performance.now() });
        return original(...args);
      };
    }
  })()`);
  if (await evaluate("window.__taxi.game.sfx.muted")) await key("m", "KeyM", 77);
  await click("#banner-cta");
  await until('window.__taxi.game.mode.kind === "playing"');
  await until(
    "(()=>{const bank=window.__taxi.game.sfx.diagnostics().bank;return bank.loaded + bank.failed.length === bank.total})()",
  );
  const bank = (await diagnostics()).bank;
  if (bank.failed.length > 0) {
    report.assetFailures = await evaluate(`(async()=>{
      const ctx = new AudioContext();
      const failures = [];
      for (const name of window.__taxi.game.sfx.diagnostics().bank.failed) {
        const response = await fetch("/audio/cozy/" + name + ".ogg");
        const bytes = await response.arrayBuffer();
        const entry = { name, status: response.status, mime: response.headers.get("content-type"), bytes: bytes.byteLength };
        try { await ctx.decodeAudioData(bytes); } catch (error) { entry.error = String(error); }
        failures.push(entry);
      }
      await ctx.close();
      return failures;
    })()`);
  }
  check("complete sound bank loaded", bank.loaded === bank.total && bank.total > 0, bank);
  await evaluate(`(()=>{
    const sfx = window.__taxi.game.sfx;
    const analyser = sfx.ctx.createAnalyser();
    analyser.fftSize = 2048;
    const silent = sfx.ctx.createGain();
    silent.gain.value = 0;
    sfx.master.connect(analyser);
    analyser.connect(silent);
    silent.connect(sfx.ctx.destination);
    window.__sfxLevel = async () => {
      const values = new Float32Array(analyser.fftSize);
      let sum = 0, peak = 0;
      for (let sample = 0; sample < 12; sample++) {
        analyser.getFloatTimeDomainData(values);
        for (const value of values) { sum += value * value; peak = Math.max(peak, Math.abs(value)); }
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      return { rms: Math.sqrt(sum / (12 * values.length)), peak };
    };
  })()`);
  const motion = (await diagnostics()).loops;
  check(
    "every motion layer uses a generated clip",
    motion.length === 6 && motion.every((loop) => loop.sampled),
    motion,
  );
  check(
    "start countdown and GO cues",
    (await count("countdown")) === 3 && (await count("go")) === 1,
    await evaluate("window.__sfxEvents"),
  );

  await evaluate("window.__taxi.teleport(0.37, 0.39)");
  await call("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: "w",
    code: "KeyW",
    windowsVirtualKeyCode: 87,
  });
  await until("window.__taxi.game.car.speed > 10");
  const drivingSignal = await evaluate("window.__sfxLevel()");
  check(
    "driving produces a bounded audio signal",
    drivingSignal.rms > 0.0001 && drivingSignal.peak < 1,
    drivingSignal,
  );
  await key("Shift", "ShiftLeft", 16, 400);
  await call("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "w",
    code: "KeyW",
    windowsVirtualKeyCode: 87,
  });
  await until('window.__sfxEvents.some(event => event.method === "boostEnd")');
  check(
    "boost ignition and release sound once",
    (await count("boost")) === 1 && (await count("boostEnd")) === 1,
    await evaluate('window.__sfxEvents.filter(event => event.method.startsWith("boost"))'),
  );
  await evaluate("window.__taxi.game.car.boostMeter = 99.99");
  await until('window.__sfxEvents.some(event => event.method === "boostReady")');
  await sleep(350);
  check(
    "full boost meter announces once",
    (await count("boostReady")) === 1,
    await count("boostReady"),
  );

  await key("Escape", "Escape", 27);
  await until("window.__taxi.game.paused");
  const paused = await diagnostics();
  check("pause mutes the soundscape", paused.paused === true, paused);
  await sleep(1200);
  const pauseSignal = await evaluate("window.__sfxLevel()");
  check("paused output is silent after its UI cue", pauseSignal.rms < 0.0001, pauseSignal);
  await screenshot("paused");
  await key("Escape", "Escape", 27);
  await until("!window.__taxi.game.paused");
  check(
    "resume restores audio",
    (await diagnostics()).paused === false && (await count("resume")) === 1,
    await diagnostics(),
  );
  await key("r", "KeyR", 82);
  await until('window.__taxi.game.mode.kind === "countdown"');
  report.restartAudio = await diagnostics();
  check("restart uses its own cue", (await count("reset")) === 1, report.restartAudio);
  check(
    "countdown clears every motion layer",
    !report.restartAudio.boostLoopOn && report.restartAudio.loops.every((loop) => loop.level === 0),
    report.restartAudio,
  );
  await until('window.__taxi.game.mode.kind === "playing"');

  await stageFareObjective();
  await until("window.__taxi.probe().carrying");
  check("passenger boards with pickup cue", (await count("pickup")) === 1, await count("pickup"));
  await stageFareObjective();
  await until("window.__taxi.game.state.fares > 0");
  check("delivery plays payout cue", (await count("dropoff")) === 1, await count("dropoff"));
  await stageFareObjective();
  await until("window.__taxi.probe().carrying");
  await evaluate(
    `(()=>{const f=window.__taxi.game.fares,c=f.carryingInfo();if(!c)throw new Error("No rider");f.clock=c.rideStart+c.patienceBudget*0.76})()`,
  );
  await until('window.__sfxEvents.some(event => event.method === "passengerWarning")');
  await sleep(350);
  check(
    "low patience warns once",
    (await count("passengerWarning")) === 1,
    await count("passengerWarning"),
  );
  await evaluate(
    `(()=>{const f=window.__taxi.game.fares,c=f.carryingInfo();if(!c)throw new Error("No rider");f.clock=c.rideStart+c.patienceBudget+1})()`,
  );
  await until("!window.__taxi.probe().carrying");
  check(
    "passenger bail has a distinct cue",
    (await count("passengerBail")) === 1,
    await count("passengerBail"),
  );

  await evaluate(`(()=>{
    const game=window.__taxi.game, garage=game.city.garages[0];
    if(!garage)throw new Error("No garage");
    game.state.score=0;
    game.ownedSkins=new Set(["waymo"]);
    game.car.reset(garage.padX,garage.padZ,0);
    game.rig.snapTo(game.car);
  })()`);
  await until("window.__taxi.game.garageOpen");
  await click('[data-skin="cruise"]');
  check("unaffordable car signals denial", (await count("denied")) === 1, await count("denied"));
  await evaluate("window.__taxi.game.state.score = 100");
  await click('[data-skin="cruise"]');
  await until('window.__taxi.game.skinId === "cruise"');
  check("garage unlock plays reward cue", (await count("unlock")) === 1, await count("unlock"));
  await click('[data-skin="waymo"]');
  await screenshot("garage");
  await evaluate("window.__taxi.teleport(0.37, 0.39)");
  await until("!window.__taxi.game.garageOpen");
  const ui = await evaluate(
    'window.__sfxEvents.filter(event => event.method === "ui").map(event => event.args[0])',
  );
  check(
    "garage browse, select, open and close cues",
    ["open", "move", "select", "back"].every((cue) => ui.includes(cue)),
    ui,
  );
  const { targetInfo } = await call("Target.getTargetInfo");
  const { targetId: otherTab } = await call("Target.createTarget", { url: "about:blank" });
  await call("Target.activateTarget", { targetId: otherTab });
  await until("document.hidden && window.__taxi.game.sfx.diagnostics().context === 'suspended'");
  check(
    "hidden page suspends audio",
    (await diagnostics()).hidden === true && (await diagnostics()).context === "suspended",
    await diagnostics(),
  );
  await call("Target.activateTarget", { targetId: targetInfo.targetId });
  await call("Target.closeTarget", { targetId: otherTab });
  await until("!document.hidden && window.__taxi.game.sfx.diagnostics().context === 'running'");
  check("visible page restores audio", (await diagnostics()).hidden === false, await diagnostics());
  await key("Escape", "Escape", 27);
  await until("window.__taxi.game.paused");
  const { targetId: pausedTab } = await call("Target.createTarget", { url: "about:blank" });
  await call("Target.activateTarget", { targetId: pausedTab });
  await until("document.hidden && window.__taxi.game.sfx.diagnostics().context === 'suspended'");
  await call("Target.activateTarget", { targetId: targetInfo.targetId });
  await call("Target.closeTarget", { targetId: pausedTab });
  await until("!document.hidden && window.__taxi.game.sfx.diagnostics().context === 'running'");
  const stillPaused = await diagnostics();
  check(
    "returning visible preserves wrapper pause",
    stillPaused.paused &&
      !stillPaused.hidden &&
      stillPaused.loops.every((loop) => loop.level === 0),
    stillPaused,
  );
  await key("Escape", "Escape", 27);
  await until("!window.__taxi.game.paused");
  await screenshot("complete");
  check("no page errors", pageErrors.length === 0, pageErrors);
  report.events = await evaluate("window.__sfxEvents");
  report.finalAudio = await diagnostics();
} catch (error) {
  report.failure = String(error);
  report.pageErrors = pageErrors;
  try {
    report.finalAudio = await diagnostics();
    report.events = await evaluate("window.__sfxEvents");
  } catch {}
  try {
    await screenshot("failure");
  } catch {}
} finally {
  report.passed = !report.failure && report.checks.every((entry) => entry.passed);
  writeFileSync(path.join(output, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  close();
}
if (!report.passed) process.exitCode = 1;
