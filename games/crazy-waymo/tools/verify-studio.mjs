// Browser acceptance pass. Requires the dev server and agent-browser.
// Usage: node tools/verify-studio.mjs [url] [output-directory]
// The fare checks stage real pickup/dropoff positions; movement checks use
// held keyboard input and the live Rapier vehicle. No score/event injection.
// __taxi is the game's public dev hook. Helpers stay inside serialized page
// functions because evaluate() executes them in a separate browser context.
/* eslint-disable no-underscore-dangle, unicorn/consistent-function-scoping */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const url = process.argv[2] ?? "http://localhost:5193/?time=noon&offline=1";
const output = path.resolve(process.argv[3] ?? "/private/tmp/waymo-studio-review");
const session = process.env.WAYMO_REVIEW_SESSION ?? `crazy-waymo-studio-${process.pid}`;
mkdirSync(output, { recursive: true });

function browser(...args) {
  const stdout = execFileSync("agent-browser", ["--session", session, ...args, "--json"], {
    encoding: "utf8",
    timeout: 90_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  const result = JSON.parse(stdout);
  if (!result.success) throw new Error(JSON.stringify(result.error));
  return result.data;
}

function evaluate(fn, ...args) {
  return browser("eval", `(${fn.toString()})(...${JSON.stringify(args)})`).result;
}

const report = { url, checkedAt: new Date().toISOString(), checks: [], views: [] };
function check(name, passed, evidence) {
  report.checks.push({ name, passed, evidence });
  console.log(`${passed ? "PASS" : "FAIL"} ${name}: ${JSON.stringify(evidence)}`);
}

function review() {
  browser("--headed", "open", url);
  browser("set", "viewport", "1440", "900");
  browser("wait", "--fn", "window.__taxi?.game?.isReady === true");
  report.worldRevision = evaluate(async () => (await import("/src/world/world-bin.ts")).WORLD_REV);
  report.display = evaluate(() => ({
    width: innerWidth,
    height: innerHeight,
    pixelRatio: devicePixelRatio,
    coarsePointer: matchMedia("(pointer: coarse)").matches,
  }));
  evaluate(() => {
    const taxi = window.__taxi;
    if (!taxi) throw new Error("Dev-only Taxi hooks unavailable");
    taxi.game.restartRun();
    taxi.setPhase(0.25);
  });
  browser("wait", "--fn", "window.__taxi.game.mode.kind === 'playing'");

  const driving = evaluate(async () => {
    const taxi = window.__taxi;
    if (!taxi) throw new Error("Taxi not ready");
    taxi.setFreecam(false);
    taxi.teleport(0.37, 0.39);
    const first = taxi.probe();
    if (!first) throw new Error("No live vehicle");
    // Keep the isolated input check clear of traffic. The renderer/physics and
    // collision surfaces remain real; this is not an autonomous route score.
    taxi.game.traffic.reset(
      { gx: taxi.game.city.gridX(first.x), gz: taxi.game.city.gridZ(first.z) },
      7,
    );
    const key = (type, value) => window.dispatchEvent(new KeyboardEvent(type, { key: value }));
    let frames = 0;
    let peak = 0;
    let boosted = false;
    let drifted = false;
    async function hold(keys, ms, reached) {
      keys.forEach((k) => key("keydown", k));
      const until = performance.now() + ms;
      try {
        await new Promise((resolve) => {
          function tick() {
            frames++;
            const p = taxi.probe();
            if (p) {
              peak = Math.max(peak, p.speed);
              boosted ||= p.boosting;
              drifted ||= p.drifting;
            }
            if (reached?.() || performance.now() >= until) resolve();
            else requestAnimationFrame(tick);
          }
          requestAnimationFrame(tick);
        });
      } finally {
        keys.forEach((k) => key("keyup", k));
      }
    }
    // Assert physical progress within a timeout. Cold geometry uploads can
    // pause wall time; headless frame rate is not a gameplay benchmark.
    await hold(["w"], 8000, () => {
      const p = taxi.probe();
      return p && p.speed > 12 && Math.hypot(p.x - first.x, p.z - first.z) > 8;
    });
    const driven = taxi.probe();
    await hold(["w", "shift"], 350);
    await hold(["s"], 4000, () => taxi.probe()?.speed < 2);
    const braked = taxi.probe();
    taxi.teleport(0.37, 0.39);
    await hold(["w"], 8000, () => taxi.probe()?.speed > 12);
    await hold(["w", "s", "d"], 350);
    return {
      frames,
      peak,
      boosted,
      drifted,
      first,
      driven,
      braked,
      distance: driven ? Math.hypot(driven.x - first.x, driven.z - first.z) : 0,
    };
  });
  check(
    "live loop + keyboard acceleration",
    driving.frames > 10 && driving.distance > 5 && driving.peak > 5,
    driving,
  );
  check("boost and drift reach vehicle", driving.boosted && driving.drifted, {
    boosted: driving.boosted,
    drifted: driving.drifted,
  });
  check("brake reduces speed", driving.braked && driving.braked.speed < driving.peak * 0.85, {
    peak: driving.peak,
    speed: driving.braked?.speed,
  });
  browser("screenshot", path.join(output, "driving.png"));

  const fare = evaluate(async () => {
    const taxi = window.__taxi;
    if (!taxi) throw new Error("Taxi not ready");
    const game = taxi.game;
    function stageNear(pos) {
      const hit = game.city.network.nearest(pos.x, pos.z, 80);
      if (!hit) throw new Error("Fare has no reachable road");
      const dx = pos.x - hit.x;
      const dz = pos.z - hit.z;
      const distance = Math.hypot(dx, dz) || 1;
      // Park within the kerb lane, close enough to board, never inside a wall.
      const offset = Math.min(hit.edge.half - 1, Math.max(0, distance - 2.8));
      const x = hit.x + (dx / distance) * offset;
      const z = hit.z + (dz / distance) * offset;
      game.car.reset(x, z, Math.atan2(hit.tx, hit.tz));
      game.rig.snapTo(game.car);
    }
    async function until(predicate) {
      const deadline = performance.now() + 5000;
      await new Promise((resolve) => {
        function tick() {
          if (predicate() || performance.now() > deadline) resolve();
          else requestAnimationFrame(tick);
        }
        requestAnimationFrame(tick);
      });
    }
    const objective = game.fares.objective();
    if (!objective) throw new Error("No passenger objective");
    stageNear(objective.pos);
    await until(() => taxi.probe()?.carrying);
    const pickedUp = taxi.probe()?.carrying === true;
    const destination = game.fares.objective();
    if (!pickedUp || !destination) return { pickedUp, completed: false, score: game.state.score };
    const before = game.state.fares;
    stageNear(destination.pos);
    await until(() => game.state.fares > before);
    return {
      pickedUp,
      completed: game.state.fares > before,
      score: game.state.score,
      fares: game.state.fares,
    };
  });
  check(
    "staged passenger pickup and delivery pay",
    fare.pickedUp && fare.completed && fare.score > 0,
    fare,
  );

  const paused = evaluate(async () => {
    const taxi = window.__taxi;
    if (!taxi) throw new Error("Taxi not ready");
    taxi.game.requestPause();
    const before = taxi.probe();
    await new Promise((resolve) => setTimeout(resolve, 300));
    const after = taxi.probe();
    taxi.game.requestResume();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "r" }));
    window.dispatchEvent(new KeyboardEvent("keyup", { key: "r" }));
    return {
      distance: before && after ? Math.hypot(after.x - before.x, after.z - before.z) : null,
    };
  });
  check("pause freezes vehicle", paused.distance === 0, paused);
  browser(
    "wait",
    "--fn",
    "window.__taxi.game.mode.kind === 'playing' && window.__taxi.game.state.score === 0",
  );
  check(
    "R restarts a playable run",
    true,
    evaluate(() => window.__taxi.probe()),
  );

  const hill = evaluate(async () => {
    const taxi = window.__taxi;
    if (!taxi) throw new Error("Taxi not ready");
    taxi.teleport(0.437, 0.401);
    taxi.setPhase(0.25);
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const first = taxi.probe();
    await new Promise((resolve) => setTimeout(resolve, 3000));
    const last = taxi.probe();
    const camera = taxi.camera.position;
    const floor = taxi.game.city.cameraFloorAt(camera.x, camera.z, camera.y);
    return {
      drift: first && last ? Math.hypot(last.x - first.x, last.z - first.z) : null,
      clearance: camera.y - floor,
      speed: last?.speed,
    };
  });
  check("parked taxi holds a city hill", hill.drift !== null && hill.drift < 0.4, hill);
  check("hill camera clears the road", hill.clearance >= 0.6, hill);

  for (const view of [
    { name: "sunset-noon", u: 0.235, v: 0.674, phase: 0.25 },
    { name: "haight-noon", u: 0.437, v: 0.401, phase: 0.25 },
    { name: "chinatown-noon", u: 0.67, v: 0.167, phase: 0.25 },
    { name: "north-beach-golden", u: 0.675, v: 0.112, phase: 0.4 },
    { name: "dogpatch-noon", u: 0.79, v: 0.51, phase: 0.25 },
    { name: "downtown-noon", u: 0.738, v: 0.19, phase: 0.25 },
    { name: "downtown-night", u: 0.738, v: 0.19, phase: 0.7 },
  ]) {
    evaluate(async ({ u, v, phase }) => {
      const taxi = window.__taxi;
      if (!taxi) throw new Error("Taxi not ready");
      taxi.teleport(u, v);
      taxi.setPhase(phase);
      taxi.setFreecam(false);
      // Allow the camera, shadow frustum, and material uniforms to settle.
      await new Promise((resolve) => {
        let frames = 0;
        function tick() {
          if (++frames >= 72) resolve();
          else requestAnimationFrame(tick);
        }
        requestAnimationFrame(tick);
      });
      await Promise.all(
        (document.getElementById("district")?.getAnimations() ?? []).map((animation) =>
          animation.finished.catch(() => {}),
        ),
      );
    }, view);
    const file = path.join(output, `${view.name}.png`);
    browser("screenshot", file);
    const stream = evaluate(() => window.__taxi.game.city.parcelStreamStats());
    report.views.push({ ...view, file: path.basename(file), stream });
    console.log(`VIEW ${view.name}: ${Math.round(stream.bytes / 1024 / 1024)} MB parcel geometry`);
  }

  const errors = browser("errors").errors;
  check("no page errors", Array.isArray(errors) && errors.length === 0, errors);
  writeFileSync(path.join(output, "report.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(`Review: ${output}`);
  if (report.checks.some((result) => !result.passed)) process.exitCode = 1;
}

try {
  review();
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  try {
    browser("close");
  } catch (error) {
    console.error("Failed to close the owned review browser:", error);
    process.exitCode = 1;
  }
}
