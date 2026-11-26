import type { Vector } from "#rapier";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { WheelSurface } from "../src/world/land-class";
import type { CarInput } from "../src/vehicle/car";
import type { WaterBody } from "../src/world/water";
import type { SurfaceDeck } from "../src/shared/types";

const url = process.argv[2] ?? "http://localhost:5193/?time=noon&offline=1";
const out = path.resolve(process.argv[3] ?? "/private/tmp/waymo-water-review");
const session = `crazy-waymo-water-${process.pid}-${Date.now().toString(36)}`;

mkdirSync(out, { recursive: true });

const browser = (...args: string[]) => {
  const result = JSON.parse(
    execFileSync("agent-browser", ["--session", session, ...args, "--json"], {
      encoding: "utf-8",
      maxBuffer: 8e6,
      timeout: 90_000,
    }),
  );

  if (!result.success) {
    throw new Error(JSON.stringify(result.error));
  }

  return result.data;
};

const evaluate = (
  fn: {
    (n: any): Promise<void>;
    (s: any): void;
    (): void;
    (
      controls: any,
      frameCount: any,
      velocity: any,
      stop: any,
    ): Promise<{
      pending: {
        builtMs: number;
        bytes: number;
        cells: number;
        detailedCells: number;
        pending: number;
        resident: number;
        verts: number;
      } | null;
      probe: {
        x: number;
        z: number;
        y: number;
        speed: number;
        heading: number;
        airborne: boolean;
        drifting: boolean;
        boosting: boolean;
        carrying: boolean;
        objective: { u: number; v: number } | null;
        wreckedCount: number;
        nearestTraffic: { dist: number; wrecked: boolean; y: number } | null;
      } | null;
      reached: boolean;
      samples: any[];
    }>;
    (): void;
    (): Promise<{
      boundedSolids: number;
      decks: SurfaceDeck[];
      installedRevision: any;
      revision: any;
    }>;
    (): Promise<any>;
    (): {
      x: number;
      z: number;
      y: number;
      speed: number;
      heading: number;
      airborne: boolean;
      drifting: boolean;
      boosting: boolean;
      carrying: boolean;
      objective: { u: number; v: number } | null;
      wreckedCount: number;
      nearestTraffic: { dist: number; wrecked: boolean; y: number } | null;
    } | null;
    (): {
      x: number;
      z: number;
      y: number;
      speed: number;
      heading: number;
      airborne: boolean;
      drifting: boolean;
      boosting: boolean;
      carrying: boolean;
      objective: { u: number; v: number } | null;
      wreckedCount: number;
      nearestTraffic: { dist: number; wrecked: boolean; y: number } | null;
    } | null;
    (): void;
    (): WaterBody[];
    toString?: any;
  },
  ...args: undefined[]
) => browser("eval", `(${fn.toString()})(...${JSON.stringify(args)})`).result;

const frames = (count: number) =>
  evaluate(async (n: number) => {
    const { promise, resolve } = Promise.withResolvers<void>();
    let i = 0;
    let sampledAt = 0;

    const step = (now: number) => {
      if (now - sampledAt < 15) {
        return requestAnimationFrame(step);
      }

      sampledAt = now;
      i += 1;

      if (i >= n) {
        resolve();
      } else {
        requestAnimationFrame(step);
      }
    };

    requestAnimationFrame(step);

    await promise;
  }, count);

const report = { cases: [], checkedAt: new Date().toISOString(), checks: [], session, url };

const check = (
  name: string,
  passed: boolean,
  detail:
    | {
        end?: any;
        frames?: any;
        maxLateral?: number;
        minY?: number;
        finish?: any;
        start?: any;
        maxX?: number;
        before?: any;
        maxBodyY?: number;
        minBodyY?: number;
        pool?: any;
      }
    | undefined,
) => {
  report.checks.push({ detail, name, passed });
  console.log(`${passed ? "PASS" : "FAIL"} ${name}: ${JSON.stringify(detail)}`);
};

const prepare = (spot: { x: any; yaw: any; z: any }) => {
  evaluate((s: { x: number; z: number; yaw: number }) => {
    const g = window.__taxi.game;
    g.input.setScripted({ boost: false, brake: 0, steer: 0, throttle: 0 });
    g.car.reset(s.x, s.z, s.yaw);
    g.freecam = false;
    g.rig.snapTo(g.car);
  }, spot);
  frames(75);
  evaluate(() => {
    window.__taxi.game.rig.snapTo(window.__taxi.game.car);
  });
};

const drive = (
  input: { boost: boolean; brake: number; steer: number; throttle: number },
  frameBudget: number,
  initialVelocity: undefined,
  until: { kind: string } | undefined,
) =>
  evaluate(
    async (
      controls: CarInput | null,
      frameCount: number,
      velocity: Vector,
      stop: { kind: string; x: number; z: number },
    ) => {
      const g = window.__taxi.game;

      if (velocity) {
        g.car.physicsVehicle.chassis.setLinvel(velocity, true);
      }

      g.input.setScripted(controls);

      const samples: {
        airborne: boolean;
        bodyY: number;
        drifting: boolean;
        floor: number;
        heading: number;
        speed: number;
        surface: WheelSurface;
        vx: number;
        vz: number;
        water:
          | { kind: "dry" }
          | {
              entrySpeed: number;
              entryVerticalSpeed: number;
              immersion: number;
              kind: "floating";
              waterY: number;
            };
        x: number;
        y: number;
        z: number;
      }[] = [];

      let wetFrames = 0;
      let reached = false;
      const { promise, resolve } = Promise.withResolvers<void>();
      let n = 0;
      let sampledAt = 0;

      const step = (now: number) => {
        if (now - sampledAt < 15) {
          return requestAnimationFrame(step);
        }

        sampledAt = now;
        const p = g.car.position;
        const body = g.car.physicsVehicle.chassis.translation();
        samples.push({
          airborne: g.car.airborne,
          bodyY: body.y,
          drifting: g.car.isDrifting,
          floor: g.city.heightAt(p.x, p.z),
          heading: g.car.heading,
          speed: g.car.speed,
          surface: g.city.surfaceKindAt(p.x, p.z, p.y),
          vx: g.car.velocity.x,
          vz: g.car.velocity.y,
          water: { ...g.car.waterContact },
          x: p.x,
          y: p.y,
          z: p.z,
        });
        wetFrames = g.car.waterContact.kind === "floating" ? wetFrames + 1 : 0;

        if (stop?.kind === "wet") {
          reached = wetFrames >= 20;
        } else if (stop?.kind === "dry") {
          reached =
            n > 20 &&
            g.car.waterContact.kind === "dry" &&
            Math.hypot(p.x - stop.x, p.z - stop.z) < 5;
        } else {
          reached = false;
        }

        n += 1;

        if (n >= frameCount || reached) {
          resolve();
        } else {
          requestAnimationFrame(step);
        }
      };

      requestAnimationFrame(step);

      await promise;
      g.input.setScripted({ boost: false, brake: 1, steer: 0, throttle: 0 });

      return {
        pending: g.city.parcelStreamStats(),
        probe: window.__taxi.probe(),
        reached,
        samples,
      };
    },
    input,
    frameBudget,
    initialVelocity,
    until,
  );

const run = (
  name: string,
  spot: { x: number; yaw: number; z: any },
  controls: { boost: boolean; brake: number; steer: number; throttle: number },
  frameCount: number,
  velocity: { x: number; y: number; z: number },
) => {
  prepare(spot);
  browser("screenshot", `${out}/${name}-before.png`);
  const result = drive(controls, frameCount, velocity);
  browser("screenshot", `${out}/${name}-after.png`);
  report.cases.push({ controls, name, spot, ...result });
  check(
    `${name} records live finite physics samples`,
    result.samples.length === frameCount &&
      result.samples.every((p: { x: any; y: any; z: any; bodyY: any; speed: any }) =>
        [p.x, p.y, p.z, p.bodyY, p.speed].every(Number.isFinite),
      ),
    { end: result.samples.at(-1), frames: result.samples.length },
  );

  return result.samples;
};

try {
  const revisionSource = readFileSync(
    new URL("../src/world/world-bin.ts", import.meta.url),
    "utf-8",
  );

  const expectedRevision = Number(
    /export const WORLD_REV = (?<revision>\d+);/u.exec(revisionSource)?.groups?.revision,
  );

  if (!Number.isSafeInteger(expectedRevision) || expectedRevision <= 0) {
    throw new Error("Cannot read current WORLD_REV from repository");
  }

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

    if (!response.ok) {
      throw new Error("Installed world unavailable");
    }

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
      boundedSolids: g.city.solids.filter((s) => s.minY !== undefined).length,
      decks: g.city.getDecks(),
      installedRevision: installed.rev,
      revision: WORLD_REV,
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
    const spot = { x: -500.5, yaw: 0, z: -1150 };

    const samples = run(
      `golden-gate-${side < 0 ? "left" : "right"}`,
      spot,
      { boost: true, brake: 0, steer: side, throttle: 1 },
      120,
      { x: 0, y: 0, z: 30 },
    );

    const maxLateral = Math.max(...samples.map((p: { x: number }) => Math.abs(p.x - spot.x)));
    const minY = Math.min(...samples.map((p: { y: any }) => p.y));
    check(
      `GG ${side < 0 ? "left" : "right"} full-lock stays on deck`,
      maxLateral > 3 && maxLateral < 5.5 && minY > 6.8,
      { maxLateral, minY },
    );
  }

  const pier = report.world.decks.find(
    (d: { minX: number; y2: undefined; maxZ: number; minZ: number }) =>
      d.minX > 190 && d.minX < 200 && d.y2 === undefined && d.maxZ - d.minZ > 20,
  );

  if (!pier) {
    throw new Error("First Wharf deck missing");
  }

  const pierX = (pier.minX + pier.maxX) / 2;

  const entry = run(
    "pier-ramp-entry",
    { x: pierX, yaw: Math.PI, z: pier.maxZ + 13 },
    { boost: false, brake: 0, steer: 0, throttle: 0.8 },
    130,
    { x: 0, y: 0, z: -12 },
  );

  check(
    "Wharf ramp reaches supported pier without stair snag",
    entry.some((p: { z: number }) => p.z < pier.maxZ - 4) &&
      entry.every((p: { z: number; y: number }) => p.z >= pier.maxZ || p.y > pier.y - 0.2),
    { finish: entry.at(-1), minY: Math.min(...entry.map((p: { y: any }) => p.y)), start: entry[0] },
  );

  const pierEdge = run(
    "pier-edge-impact",
    { x: pierX, yaw: Math.PI / 2, z: (pier.minZ + pier.maxZ) / 2 },
    { boost: true, brake: 0, steer: 0, throttle: 1 },
    100,
    { x: 36, y: 0, z: 0 },
  );

  check(
    "Wharf edge holds boosted taxi above water",
    Math.max(...pierEdge.map((p: { x: any }) => p.x)) > pier.maxX - 3 &&
      pierEdge.every((p: { x: number; y: number }) => p.x < pier.maxX + 0.5 && p.y > pier.y - 0.2),
    {
      maxX: Math.max(...pierEdge.map((p: { x: any }) => p.x)),
      minY: Math.min(...pierEdge.map((p: { y: any }) => p.y)),
    },
  );
  report.access = evaluate(async () => {
    const shoreline = await import("/src/world/shoreline.ts");

    return shoreline.SHORE_ACCESS_SITES;
  });
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

    const waterEntry = drive({ boost: false, brake: 0, steer: 0, throttle: 1 }, 540, undefined, {
      kind: "wet",
    });

    report.cases.push({ name: `${access.id}-entry`, ...waterEntry });
    browser("screenshot", `${out}/${access.id}-entry.png`);
    check(
      `${access.id} drives from land into water using held throttle`,
      before.waterContact.kind === "dry" &&
        waterEntry.reached &&
        waterEntry.samples.some(
          (p: { x: number; z: number }) => Math.hypot(p.x - before.x, p.z - before.z) > 5,
        ),
      { before, end: waterEntry.probe, frames: waterEntry.samples.length },
    );

    const idle = drive({ boost: false, brake: 0, steer: 0, throttle: 0 }, 120);
    report.cases.push({ name: `${access.id}-float`, ...idle });
    const settled = idle.samples.slice(-45);
    check(
      `${access.id} settles afloat without sinking, drifting or airborne score`,
      settled.length === 45 &&
        settled.every(
          (p: {
            water: { kind: string; waterY: number };
            bodyY: number;
            airborne: any;
            drifting: any;
          }) =>
            p.water.kind === "floating" &&
            Math.abs(p.bodyY - p.water.waterY - 0.42) < 0.35 &&
            !p.airborne &&
            !p.drifting,
        ),
      {
        end: idle.probe,
        maxBodyY: Math.max(...settled.map((p: { bodyY: any }) => p.bodyY)),
        minBodyY: Math.min(...settled.map((p: { bodyY: any }) => p.bodyY)),
      },
    );
    browser("screenshot", `${out}/${access.id}-floating.png`);

    const exit = drive({ boost: false, brake: 1, steer: 0, throttle: 0 }, 600, undefined, {
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

  prepare({ x: -1510, yaw: 0, z: 200 });
  const start = evaluate(() => window.__taxi.probe());
  const turn = drive({ boost: false, brake: 0, steer: 0.65, throttle: 1 }, 240);
  report.cases.push({ name: "ocean-steering", ...turn });
  check(
    "floating taxi accelerates and steers across open water",
    turn.samples.every((p: { water: { kind: string } }) => p.water.kind === "floating") &&
      turn.samples.some((p: { speed: number }) => p.speed > 3) &&
      Math.hypot(turn.probe.x - start.x, turn.probe.z - start.z) > 8 &&
      Math.abs(turn.probe.heading - start.heading) > 0.3,
    { end: turn.probe, start },
  );
  browser("screenshot", `${out}/ocean-steering.png`);

  evaluate(() => {
    const g = window.__taxi.game;
    g.car.reset(-1510, 200, 0);
    g.car.physicsVehicle.teleport(-1510, 20, 200, 0);
    g.rig.snapTo(g.car);
  });
  const fall = drive({ boost: false, brake: 0, steer: 0, throttle: 0 }, 240);
  report.cases.push({ name: "ocean-fall", ...fall });
  const finalFall = fall.samples.slice(-45);
  check(
    "water catches a falling taxi and settles it at the surface",
    fall.samples.some((p: { airborne: any; bodyY: number }) => p.airborne && p.bodyY > 10) &&
      finalFall.every(
        (p: { water: { kind: string; waterY: number }; bodyY: number }) =>
          p.water.kind === "floating" && Math.abs(p.bodyY - p.water.waterY - 0.42) < 0.35,
      ) &&
      fall.samples.every((p: { bodyY: number }) => p.bodyY > -1.3),
    { end: fall.probe, minBodyY: Math.min(...fall.samples.map((p: { bodyY: any }) => p.bodyY)) },
  );
  report.pools = evaluate(() => window.__taxi.game.city.getWaterBodies());
  check("Palace and all four Sutro pools publish water surfaces", report.pools.length === 5);

  for (const [i, pool] of report.pools.entries()) {
    prepare({ x: pool.x, yaw: pool.yaw, z: pool.z });
    const idle = drive({ boost: false, brake: 0, steer: 0, throttle: 0 }, 120);
    report.cases.push({ name: `ornamental-pool-${i}`, ...idle });
    check(
      `ornamental pool ${i + 1} floats without invisible reservation collisions`,
      idle.samples
        .slice(-45)
        .every(
          (p: { water: { kind: string }; bodyY: number; x: number; z: number }) =>
            p.water.kind === "floating" &&
            Math.abs(p.bodyY - pool.y - 0.42) < 0.45 &&
            Math.hypot(p.x - pool.x, p.z - pool.z) < 1.5,
        ),
      { end: idle.probe, pool },
    );

    if (i < 2) {
      browser("screenshot", `${out}/ornamental-pool-${i}.png`);
    }
  }

  check(
    "all water trajectories remain finite",
    report.cases.every((c) =>
      c.samples.every((p: { x: any; y: any; z: any; bodyY: any; speed: any }) =>
        [p.x, p.y, p.z, p.bodyY, p.speed].every(Number.isFinite),
      ),
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

  if (!report.passed) {
    process.exitCode = 1;
  }
}
