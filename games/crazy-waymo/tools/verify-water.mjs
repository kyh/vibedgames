// Shore protection, water access and flotation on the live Rapier taxi.
// Usage: node tools/verify-water.mjs [dev-url] [output-directory]
// Requires agent-browser and the __taxi dev hook. Each run owns one session;
// screenshots and the complete trajectory report survive failures.
/* eslint-disable no-underscore-dangle */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
const url = process.argv[2] ?? "http://localhost:5193/?time=noon&offline=1";
const out = path.resolve(process.argv[3] ?? "/private/tmp/waymo-water-review");
const session = `crazy-waymo-water-${process.pid}-${Date.now().toString(36)}`;
mkdirSync(out, { recursive: true });
function browser(...args) {
  const result = JSON.parse(
    execFileSync("agent-browser", ["--session", session, ...args, "--json"], {
      encoding: "utf8",
      timeout: 90000,
      maxBuffer: 8e6,
    }),
  );
  if (!result.success) throw new Error(JSON.stringify(result.error));
  return result.data;
}
function evaluate(fn, ...args) {
  return browser("eval", `(${fn.toString()})(...${JSON.stringify(args)})`).result;
}
function frames(n) {
  return evaluate(async (n) => {
    await new Promise((resolve) => {
      let i = 0;
      let sampledAt = 0;
      const step = (now) => {
        if (now - sampledAt < 15) return requestAnimationFrame(step);
        sampledAt = now;
        if (++i >= n) resolve();
        else requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    });
  }, n);
}
const report = { url, checkedAt: new Date().toISOString(), checks: [], cases: [], session };
function check(name, passed, detail) {
  report.checks.push({ name, passed, detail });
  console.log(`${passed ? "PASS" : "FAIL"} ${name}: ${JSON.stringify(detail)}`);
}
function prepare(spot) {
  evaluate((s) => {
    const g = window.__taxi.game;
    g.input.setScripted({ throttle: 0, brake: 0, steer: 0, boost: false });
    g.car.reset(s.x, s.z, s.yaw);
    g.freecam = false;
    g.rig.snapTo(g.car);
  }, spot);
  frames(75);
  evaluate(() => window.__taxi.game.rig.snapTo(window.__taxi.game.car));
}
function drive(controls, frameCount, velocity, stop) {
  return evaluate(
    async (controls, frameCount, velocity, stop) => {
      const g = window.__taxi.game;
      if (velocity) g.car.physicsVehicle.chassis.setLinvel(velocity, true);
      g.input.setScripted(controls);
      const samples = [];
      let wetFrames = 0;
      let reached = false;
      await new Promise((resolve) => {
        let n = 0;
        let sampledAt = 0;
        const step = (now) => {
          // The game presents at 60Hz even on 120Hz displays. Do not halve a
          // ten-second reverse budget by counting duplicate display callbacks.
          if (now - sampledAt < 15) return requestAnimationFrame(step);
          sampledAt = now;
          const p = g.car.position;
          const body = g.car.physicsVehicle.chassis.translation();
          samples.push({
            x: p.x,
            y: p.y,
            z: p.z,
            bodyY: body.y,
            speed: g.car.speed,
            heading: g.car.heading,
            airborne: g.car.airborne,
            drifting: g.car.isDrifting,
            water: { ...g.car.waterContact },
            vx: g.car.velocity.x,
            vz: g.car.velocity.y,
            floor: g.city.heightAt(p.x, p.z),
            surface: g.city.surfaceKindAt(p.x, p.z, p.y),
          });
          wetFrames = g.car.waterContact.kind === "floating" ? wetFrames + 1 : 0;
          reached =
            stop?.kind === "wet"
              ? wetFrames >= 20
              : stop?.kind === "dry"
                ? n > 20 &&
                  g.car.waterContact.kind === "dry" &&
                  Math.hypot(p.x - stop.x, p.z - stop.z) < 5
                : false;
          if (++n >= frameCount || reached) resolve();
          else requestAnimationFrame(step);
        };
        requestAnimationFrame(step);
      });
      g.input.setScripted({ throttle: 0, brake: 1, steer: 0, boost: false });
      return {
        samples,
        reached,
        probe: window.__taxi.probe(),
        pending: g.city.parcelStreamStats(),
      };
    },
    controls,
    frameCount,
    velocity,
    stop,
  );
}
function run(name, spot, controls, frameCount, velocity) {
  prepare(spot);
  browser("screenshot", `${out}/${name}-before.png`);
  const result = drive(controls, frameCount, velocity);
  browser("screenshot", `${out}/${name}-after.png`);
  report.cases.push({ name, spot, controls, ...result });
  check(
    `${name} records live finite physics samples`,
    result.samples.length === frameCount &&
      result.samples.every((p) => [p.x, p.y, p.z, p.bodyY, p.speed].every(Number.isFinite)),
    { frames: result.samples.length, end: result.samples.at(-1) },
  );
  return result.samples;
}
try {
  const revisionSource = readFileSync(
    new URL("../src/world/world-bin.ts", import.meta.url),
    "utf8",
  );
  const expectedRevision = Number(revisionSource.match(/export const WORLD_REV = (\d+);/)?.[1]);
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision <= 0)
    throw new Error("Cannot read current WORLD_REV from repository");
  report.expectedRevision = expectedRevision;
  browser("--headed", "open", url);
  browser("set", "viewport", "1440", "900");
  browser("wait", "--fn", "window.__taxi?.game?.isReady===true");
  evaluate(() => {
    window.__taxi.game.restartRun();
    window.__taxi.setPhase(0.25);
  });
  browser("wait", "--fn", "window.__taxi.game.mode.kind==='playing'");
  report.world = evaluate(async () => {
    const { WORLD_REV, deserializeWorldBin } = await import("/src/world/world-bin.ts");
    const response = await fetch("/world/world.bin");
    if (!response.ok) throw new Error("Installed world unavailable");
    const packed = await response.arrayBuffer();
    const bytes = new Uint8Array(packed);
    const expanded =
      bytes[0] === 0x1f && bytes[1] === 0x8b
        ? await new Response(
            new Blob([packed]).stream().pipeThrough(new DecompressionStream("gzip")),
          ).arrayBuffer()
        : packed;
    const installed = deserializeWorldBin(expanded);
    const g = window.__taxi.game;
    return {
      revision: WORLD_REV,
      installedRevision: installed.rev,
      boundedSolids: g.city.solids.filter((s) => s.minY !== undefined).length,
      decks: g.city.getDecks(),
    };
  });
  check(
    `revision${expectedRevision} includes bounded water walls`,
    report.world.revision === expectedRevision &&
      report.world.installedRevision === expectedRevision &&
      report.world.boundedSolids > 2000,
    report.world,
  );
  for (const side of [-1, 1]) {
    const spot = { x: -500.5, z: -1150, yaw: 0 };
    const samples = run(
      `golden-gate-${side < 0 ? "left" : "right"}`,
      spot,
      { throttle: 1, brake: 0, steer: side, boost: true },
      120,
      { x: 0, y: 0, z: 30 },
    );
    const maxLateral = Math.max(...samples.map((p) => Math.abs(p.x - spot.x)));
    const minY = Math.min(...samples.map((p) => p.y));
    check(
      `GG ${side < 0 ? "left" : "right"} full-lock stays on deck`,
      maxLateral > 3 && maxLateral < 5.5 && minY > 6.8,
      { maxLateral, minY },
    );
  }
  const pier = report.world.decks.find(
    (d) => d.minX > 190 && d.minX < 200 && d.y2 === undefined && d.maxZ - d.minZ > 20,
  );
  if (!pier) throw new Error("First Wharf deck missing");
  const pierX = (pier.minX + pier.maxX) / 2;
  const entry = run(
    "pier-ramp-entry",
    { x: pierX, z: pier.maxZ + 13, yaw: Math.PI },
    { throttle: 0.8, brake: 0, steer: 0, boost: false },
    130,
    { x: 0, y: 0, z: -12 },
  );
  check(
    "Wharf ramp reaches supported pier without stair snag",
    entry.some((p) => p.z < pier.maxZ - 4) &&
      entry.every((p) => p.z >= pier.maxZ || p.y > pier.y - 0.2),
    { start: entry[0], finish: entry.at(-1), minY: Math.min(...entry.map((p) => p.y)) },
  );
  const pierEdge = run(
    "pier-edge-impact",
    { x: pierX, z: (pier.minZ + pier.maxZ) / 2, yaw: Math.PI / 2 },
    { throttle: 1, brake: 0, steer: 0, boost: true },
    100,
    { x: 36, y: 0, z: 0 },
  );
  check(
    "Wharf edge holds boosted taxi above water",
    Math.max(...pierEdge.map((p) => p.x)) > pier.maxX - 3 &&
      pierEdge.every((p) => p.x < pier.maxX + 0.5 && p.y > pier.y - 0.2),
    { maxX: Math.max(...pierEdge.map((p) => p.x)), minY: Math.min(...pierEdge.map((p) => p.y)) },
  );
  report.access = evaluate(
    async () => (await import("/src/world/shoreline.ts")).SHORE_ACCESS_SITES,
  );
  check(
    "beach and lake each expose intentional water access",
    report.access.length >= 2,
    report.access,
  );
  for (const access of report.access) {
    const yaw = Math.atan2(access.wet.x - access.dry.x, access.wet.z - access.dry.z);
    prepare({ ...access.dry, yaw });
    const before = evaluate(() => window.__taxi.probe());
    browser("screenshot", `${out}/${access.id}-approach.png`);
    const entry = drive({ throttle: 1, brake: 0, steer: 0, boost: false }, 540, undefined, {
      kind: "wet",
    });
    report.cases.push({ name: `${access.id}-entry`, ...entry });
    browser("screenshot", `${out}/${access.id}-entry.png`);
    check(
      `${access.id} drives from land into water using held throttle`,
      before.waterContact.kind === "dry" &&
        entry.reached &&
        entry.samples.some((p) => Math.hypot(p.x - before.x, p.z - before.z) > 5),
      { before, end: entry.probe, frames: entry.samples.length },
    );

    const idle = drive({ throttle: 0, brake: 0, steer: 0, boost: false }, 120);
    report.cases.push({ name: `${access.id}-float`, ...idle });
    const settled = idle.samples.slice(-45);
    check(
      `${access.id} settles afloat without sinking, drifting or airborne score`,
      settled.length === 45 &&
        settled.every(
          (p) =>
            p.water.kind === "floating" &&
            Math.abs(p.bodyY - p.water.waterY - 0.42) < 0.35 &&
            !p.airborne &&
            !p.drifting,
        ),
      {
        end: idle.probe,
        minBodyY: Math.min(...settled.map((p) => p.bodyY)),
        maxBodyY: Math.max(...settled.map((p) => p.bodyY)),
      },
    );
    browser("screenshot", `${out}/${access.id}-floating.png`);

    const exit = drive({ throttle: 0, brake: 1, steer: 0, boost: false }, 600, undefined, {
      kind: "dry",
      ...access.dry,
    });
    report.cases.push({ name: `${access.id}-exit`, ...exit });
    check(
      `${access.id} reverses back onto land through the same opening`,
      exit.reached && exit.probe.waterContact.kind === "dry",
      { end: exit.probe, frames: exit.samples.length },
    );
    browser("screenshot", `${out}/${access.id}-exit.png`);
  }

  // Open sea leaves enough room to exercise boat steering without crossing a
  // bank. Initial placement is staged; propulsion and turning remain physical.
  prepare({ x: -1510, z: 200, yaw: 0 });
  const start = evaluate(() => window.__taxi.probe());
  const turn = drive({ throttle: 1, brake: 0, steer: 0.65, boost: false }, 240);
  report.cases.push({ name: "ocean-steering", ...turn });
  check(
    "floating taxi accelerates and steers across open water",
    turn.samples.every((p) => p.water.kind === "floating") &&
      turn.samples.some((p) => p.speed > 3) &&
      Math.hypot(turn.probe.x - start.x, turn.probe.z - start.z) > 8 &&
      Math.abs(turn.probe.heading - start.heading) > 0.3,
    { start, end: turn.probe },
  );
  browser("screenshot", `${out}/ocean-steering.png`);

  // Gravity creates the impact velocity. No artificial horizontal launch or
  // renderer/physics patches: water must catch the normal falling chassis.
  evaluate(() => {
    const g = window.__taxi.game;
    g.car.reset(-1510, 200, 0);
    g.car.physicsVehicle.teleport(-1510, 20, 200, 0);
    g.rig.snapTo(g.car);
  });
  const fall = drive({ throttle: 0, brake: 0, steer: 0, boost: false }, 240);
  report.cases.push({ name: "ocean-fall", ...fall });
  const finalFall = fall.samples.slice(-45);
  check(
    "water catches a falling taxi and settles it at the surface",
    fall.samples.some((p) => p.airborne && p.bodyY > 10) &&
      finalFall.every(
        (p) => p.water.kind === "floating" && Math.abs(p.bodyY - p.water.waterY - 0.42) < 0.35,
      ) &&
      fall.samples.every((p) => p.bodyY > -1.3),
    { minBodyY: Math.min(...fall.samples.map((p) => p.bodyY)), end: fall.probe },
  );
  report.pools = evaluate(() => window.__taxi.game.city.getWaterBodies());
  check("Palace and all four Sutro pools publish water surfaces", report.pools.length === 5);
  for (const [i, pool] of report.pools.entries()) {
    prepare({ x: pool.x, z: pool.z, yaw: pool.yaw });
    const idle = drive({ throttle: 0, brake: 0, steer: 0, boost: false }, 120);
    report.cases.push({ name: `ornamental-pool-${i}`, ...idle });
    check(
      `ornamental pool ${i + 1} floats without invisible reservation collisions`,
      idle.samples
        .slice(-45)
        .every(
          (p) =>
            p.water.kind === "floating" &&
            Math.abs(p.bodyY - pool.y - 0.42) < 0.45 &&
            Math.hypot(p.x - pool.x, p.z - pool.z) < 1.5,
        ),
      { pool, end: idle.probe },
    );
    if (i < 2) browser("screenshot", `${out}/ornamental-pool-${i}.png`);
  }
  check(
    "all water trajectories remain finite",
    report.cases.every((c) =>
      c.samples.every((p) => [p.x, p.y, p.z, p.bodyY, p.speed].every(Number.isFinite)),
    ),
  );
  report.errors = browser("errors");
  check("no runtime errors", report.errors.errors.length === 0, report.errors);
} catch (error) {
  report.failure = String(error);
  process.exitCode = 1;
  console.error(error);
} finally {
  try {
    browser("close");
  } catch (error) {
    report.cleanupFailure = String(error);
    console.error("Own session close failed", error);
  }
  report.passed =
    !report.failure &&
    !report.cleanupFailure &&
    report.cases.length >= 17 &&
    report.checks.length >= 25 &&
    report.checks.every((c) => c.passed);
  writeFileSync(`${out}/report.json`, JSON.stringify(report, null, 2));
  if (!report.passed) process.exitCode = 1;
}
