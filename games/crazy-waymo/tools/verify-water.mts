import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { z } from "zod";
import type { JsonValue } from "../src/shared/json.ts";
import { jsonObjectSchema, jsonSchema, probeSchema } from "./page-shapes.mts";

const url = process.argv[2] ?? "http://localhost:5193/?time=noon&offline=1";
const out = path.resolve(process.argv[3] ?? "/private/tmp/waymo-water-review");
const session = `crazy-waymo-water-${process.pid}-${Date.now().toString(36)}`;

mkdirSync(out, { recursive: true });

const agentResultSchema = z.object({
  data: z.unknown().optional(),
  error: jsonSchema.optional(),
  success: z.boolean(),
});

const browser = (...args: string[]) => {
  const result = agentResultSchema.parse(
    JSON.parse(
      execFileSync("agent-browser", ["--session", session, ...args, "--json"], {
        encoding: "utf-8",
        maxBuffer: 8e6,
        timeout: 90_000,
      }),
    ),
  );

  if (!result.success) {
    throw new Error(JSON.stringify(result.error));
  }

  return result.data;
};

const evalSchema = z.object({ result: z.unknown().optional() });

const evaluate = (expression: string) => evalSchema.parse(browser("eval", expression)).result;

const pageCall = (source: string, ...args: JsonValue[]) =>
  `(${source})(...${JSON.stringify(args)})`;

const controlsSchema = z.object({
  boost: z.boolean(),
  brake: z.number(),
  steer: z.number(),
  throttle: z.number(),
});

type Controls = z.infer<typeof controlsSchema>;

const spotSchema = z.object({ x: z.number(), yaw: z.number(), z: z.number() });

type Spot = z.infer<typeof spotSchema>;

const vectorSchema = z.object({ x: z.number(), y: z.number(), z: z.number() });

type Velocity = z.infer<typeof vectorSchema>;

const stopSchema = z.union([
  z.object({ kind: z.literal("wet") }),
  z.object({ kind: z.literal("dry"), x: z.number(), z: z.number() }),
]);

type Stop = z.infer<typeof stopSchema>;

const waterProbeSchema = probeSchema.extend({ waterContact: z.object({ kind: z.string() }) });

const sampleSchema = z.object({
  airborne: z.boolean(),
  bodyY: z.number(),
  drifting: z.boolean(),
  floor: z.number(),
  heading: z.number(),
  speed: z.number(),
  surface: z.string(),
  vx: z.number(),
  vz: z.number(),
  water: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("dry") }),
    z.object({ kind: z.literal("floating"), waterY: z.number() }),
  ]),
  x: z.number(),
  y: z.number(),
  z: z.number(),
});

type Sample = z.infer<typeof sampleSchema>;

const driveSchema = z.object({
  probe: waterProbeSchema,
  reached: z.boolean(),
  samples: z.array(sampleSchema),
});

const deckSchema = z.object({
  maxX: z.number(),
  maxZ: z.number(),
  minX: z.number(),
  minZ: z.number(),
  y: z.number(),
  y2: z.number().optional(),
});

const worldSchema = z.object({
  boundedSolids: z.number(),
  decks: z.array(deckSchema),
  installedRevision: z.number(),
  revision: z.number(),
});

const pointSchema = z.object({ x: z.number(), z: z.number() });

const accessSchema = z.array(z.object({ dry: pointSchema, id: z.string(), wet: pointSchema }));

const poolsSchema = z.array(
  z.object({ x: z.number(), y: z.number(), yaw: z.number(), z: z.number() }),
);

const errorsSchema = z.object({ errors: z.array(jsonSchema) });

interface WaterCheck {
  readonly detail?: JsonValue;
  readonly name: string;
  readonly passed: boolean;
}

interface WaterReport {
  access?: JsonValue;
  cases: JsonValue[];
  checkedAt: string;
  checks: WaterCheck[];
  cleanupFailure?: string;
  errors?: JsonValue;
  expectedRevision?: number;
  failure?: string;
  passed?: boolean;
  pools?: JsonValue;
  session: string;
  url: string;
  world?: JsonValue;
}

const report: WaterReport = {
  cases: [],
  checkedAt: new Date().toISOString(),
  checks: [],
  session,
  url,
};

const trajectories: Sample[][] = [];

const check = (name: string, passed: boolean, detail?: JsonValue) => {
  report.checks.push(detail === undefined ? { name, passed } : { detail, name, passed });
  console.log(`${passed ? "PASS" : "FAIL"} ${name}: ${JSON.stringify(detail)}`);
};

const FRAMES = String.raw`async (n) => {
  const { promise, resolve } = Promise.withResolvers();
  let i = 0;
  let sampledAt = 0;
  const step = (now) => {
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
}`;

const PLACE = String.raw`(s) => {
  const g = window.__taxi.game;
  g.input.setScripted({ boost: false, brake: 0, steer: 0, throttle: 0 });
  g.car.reset(s.x, s.z, s.yaw);
  g.freecam = false;
  g.rig.snapTo(g.car);
}`;

const DRIVE = String.raw`async (controls, frameCount, velocity, stop) => {
  const g = window.__taxi.game;
  if (velocity) {
    g.car.physicsVehicle.chassis.setLinvel(velocity, true);
  }
  g.input.setScripted(controls);
  const samples = [];
  let wetFrames = 0;
  let reached = false;
  const { promise, resolve } = Promise.withResolvers();
  let n = 0;
  let sampledAt = 0;
  const step = (now) => {
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
      reached = n > 20 && g.car.waterContact.kind === "dry" && Math.hypot(p.x - stop.x, p.z - stop.z) < 5;
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
}`;

const WORLD = String.raw`(async () => {
  const { WORLD_REV, deserializeWorldBin } = await import("/src/world/world-bin.ts");
  const response = await fetch("/world/world.bin");
  if (!response.ok) {
    throw new Error("Installed world unavailable");
  }
  const packed = await response.arrayBuffer();
  const bytes = new Uint8Array(packed);
  const expanded =
    bytes[0] === 0x1f && bytes[1] === 0x8b
      ? await new Response(new Blob([packed]).stream().pipeThrough(new DecompressionStream("gzip"))).arrayBuffer()
      : packed;
  const installed = deserializeWorldBin(expanded);
  const g = window.__taxi.game;
  return {
    boundedSolids: g.city.solids.filter((s) => s.minY !== undefined).length,
    decks: g.city.getDecks(),
    installedRevision: installed.rev,
    revision: WORLD_REV,
  };
})()`;

const PROBE_WATER = "window.__taxi.probe()";

const frames = (count: number) => {
  evaluate(pageCall(FRAMES, count));
};

const prepare = (spot: Spot) => {
  evaluate(pageCall(PLACE, spot));
  frames(75);
  evaluate("window.__taxi.game.rig.snapTo(window.__taxi.game.car)");
};

const drive = (
  input: Controls,
  frameBudget: number,
  initialVelocity: Velocity | null = null,
  until: Stop | null = null,
) => {
  const value = evaluate(pageCall(DRIVE, input, frameBudget, initialVelocity, until));
  const result = driveSchema.parse(value);

  trajectories.push(result.samples);

  return { raw: jsonObjectSchema.parse(value), result };
};

const run = (
  name: string,
  spot: Spot,
  controls: Controls,
  frameCount: number,
  velocity: Velocity,
) => {
  prepare(spot);
  browser("screenshot", `${out}/${name}-before.png`);

  const { raw, result } = drive(controls, frameCount, velocity);

  browser("screenshot", `${out}/${name}-after.png`);
  report.cases.push({ controls, name, spot, ...raw });
  check(
    `${name} records live finite physics samples`,
    result.samples.length === frameCount &&
      result.samples.every((p) => [p.x, p.y, p.z, p.bodyY, p.speed].every(Number.isFinite)),
    { end: result.samples.at(-1) ?? null, frames: result.samples.length },
  );

  return result.samples;
};

const settledAfloat = (p: Sample, surfaceY: number | null, tolerance: number) =>
  p.water.kind === "floating" &&
  Math.abs(p.bodyY - (surfaceY ?? p.water.waterY) - 0.42) < tolerance;

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
  evaluate("(() => { window.__taxi.game.restartRun(); window.__taxi.setPhase(0.25); })()");
  browser("wait", "--fn", "window.__taxi.game.mode.kind==='playing'");

  const worldValue = evaluate(WORLD);
  const world = worldSchema.parse(worldValue);

  report.world = jsonSchema.parse(worldValue);
  check(
    `revision${expectedRevision} includes bounded water walls`,
    world.revision === expectedRevision &&
      world.installedRevision === expectedRevision &&
      world.boundedSolids > 2000,
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

    const maxLateral = Math.max(...samples.map((p) => Math.abs(p.x - spot.x)));
    const minY = Math.min(...samples.map((p) => p.y));

    check(
      `GG ${side < 0 ? "left" : "right"} full-lock stays on deck`,
      maxLateral > 3 && maxLateral < 5.5 && minY > 6.8,
      { maxLateral, minY },
    );
  }

  const pier = world.decks.find(
    (d) => d.minX > 190 && d.minX < 200 && d.y2 === undefined && d.maxZ - d.minZ > 20,
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
    entry.some((p) => p.z < pier.maxZ - 4) &&
      entry.every((p) => p.z >= pier.maxZ || p.y > pier.y - 0.2),
    {
      finish: entry.at(-1) ?? null,
      minY: Math.min(...entry.map((p) => p.y)),
      start: entry[0] ?? null,
    },
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
    Math.max(...pierEdge.map((p) => p.x)) > pier.maxX - 3 &&
      pierEdge.every((p) => p.x < pier.maxX + 0.5 && p.y > pier.y - 0.2),
    {
      maxX: Math.max(...pierEdge.map((p) => p.x)),
      minY: Math.min(...pierEdge.map((p) => p.y)),
    },
  );

  const accessValue = evaluate(
    '(async () => (await import("/src/world/shoreline.ts")).SHORE_ACCESS_SITES)()',
  );

  const sites = accessSchema.parse(accessValue);

  report.access = jsonSchema.parse(accessValue);
  check("beach and lake each expose intentional water access", sites.length >= 2, report.access);

  for (const access of sites) {
    const yaw = Math.atan2(access.wet.x - access.dry.x, access.wet.z - access.dry.z);

    prepare({ ...access.dry, yaw });

    const beforeValue = evaluate(PROBE_WATER);
    const before = waterProbeSchema.parse(beforeValue);

    browser("screenshot", `${out}/${access.id}-approach.png`);

    const waterEntry = drive({ boost: false, brake: 0, steer: 0, throttle: 1 }, 540, null, {
      kind: "wet",
    });

    report.cases.push({ name: `${access.id}-entry`, ...waterEntry.raw });
    browser("screenshot", `${out}/${access.id}-entry.png`);
    check(
      `${access.id} drives from land into water using held throttle`,
      before.waterContact.kind === "dry" &&
        waterEntry.result.reached &&
        waterEntry.result.samples.some((p) => Math.hypot(p.x - before.x, p.z - before.z) > 5),
      {
        before: jsonSchema.parse(beforeValue),
        end: waterEntry.raw.probe ?? null,
        frames: waterEntry.result.samples.length,
      },
    );

    const idle = drive({ boost: false, brake: 0, steer: 0, throttle: 0 }, 120);

    report.cases.push({ name: `${access.id}-float`, ...idle.raw });

    const settled = idle.result.samples.slice(-45);

    check(
      `${access.id} settles afloat without sinking, drifting or airborne score`,
      settled.length === 45 &&
        settled.every((p) => settledAfloat(p, null, 0.35) && !p.airborne && !p.drifting),
      {
        end: idle.raw.probe ?? null,
        maxBodyY: Math.max(...settled.map((p) => p.bodyY)),
        minBodyY: Math.min(...settled.map((p) => p.bodyY)),
      },
    );
    browser("screenshot", `${out}/${access.id}-floating.png`);

    const exit = drive({ boost: false, brake: 1, steer: 0, throttle: 0 }, 600, null, {
      kind: "dry",
      ...access.dry,
    });

    report.cases.push({ name: `${access.id}-exit`, ...exit.raw });
    check(
      `${access.id} reverses back onto land through the same opening`,
      exit.result.reached && exit.result.probe.waterContact.kind === "dry",
      { end: exit.raw.probe ?? null, frames: exit.result.samples.length },
    );
    browser("screenshot", `${out}/${access.id}-exit.png`);
  }

  prepare({ x: -1510, yaw: 0, z: 200 });

  const startValue = evaluate(PROBE_WATER);
  const start = waterProbeSchema.parse(startValue);
  const turn = drive({ boost: false, brake: 0, steer: 0.65, throttle: 1 }, 240);

  report.cases.push({ name: "ocean-steering", ...turn.raw });
  check(
    "floating taxi accelerates and steers across open water",
    turn.result.samples.every((p) => p.water.kind === "floating") &&
      turn.result.samples.some((p) => p.speed > 3) &&
      Math.hypot(turn.result.probe.x - start.x, turn.result.probe.z - start.z) > 8 &&
      Math.abs(turn.result.probe.heading - start.heading) > 0.3,
    { end: turn.raw.probe ?? null, start: jsonSchema.parse(startValue) },
  );
  browser("screenshot", `${out}/ocean-steering.png`);

  evaluate(
    "(() => { const g = window.__taxi.game; g.car.reset(-1510, 200, 0); g.car.physicsVehicle.teleport(-1510, 20, 200, 0); g.rig.snapTo(g.car); })()",
  );

  const fall = drive({ boost: false, brake: 0, steer: 0, throttle: 0 }, 240);

  report.cases.push({ name: "ocean-fall", ...fall.raw });

  const finalFall = fall.result.samples.slice(-45);

  check(
    "water catches a falling taxi and settles it at the surface",
    fall.result.samples.some((p) => p.airborne && p.bodyY > 10) &&
      finalFall.every((p) => settledAfloat(p, null, 0.35)) &&
      fall.result.samples.every((p) => p.bodyY > -1.3),
    {
      end: fall.raw.probe ?? null,
      minBodyY: Math.min(...fall.result.samples.map((p) => p.bodyY)),
    },
  );

  const poolsValue = evaluate("window.__taxi.game.city.getWaterBodies()");
  const pools = poolsSchema.parse(poolsValue);

  const rawPools = z.array(jsonObjectSchema).parse(poolsValue);

  report.pools = rawPools;
  check("Palace and all four Sutro pools publish water surfaces", pools.length === 5);

  for (const [i, pool] of pools.entries()) {
    prepare({ x: pool.x, yaw: pool.yaw, z: pool.z });

    const idle = drive({ boost: false, brake: 0, steer: 0, throttle: 0 }, 120);

    report.cases.push({ name: `ornamental-pool-${i}`, ...idle.raw });
    check(
      `ornamental pool ${i + 1} floats without invisible reservation collisions`,
      idle.result.samples
        .slice(-45)
        .every(
          (p) => settledAfloat(p, pool.y, 0.45) && Math.hypot(p.x - pool.x, p.z - pool.z) < 1.5,
        ),
      { end: idle.raw.probe ?? null, pool: rawPools[i] ?? null },
    );

    if (i < 2) {
      browser("screenshot", `${out}/ornamental-pool-${i}.png`);
    }
  }

  check(
    "all water trajectories remain finite",
    trajectories.every((samples) =>
      samples.every((p) => [p.x, p.y, p.z, p.bodyY, p.speed].every(Number.isFinite)),
    ),
  );

  const errorsValue = browser("errors");
  const { errors } = errorsSchema.parse(errorsValue);

  report.errors = jsonSchema.parse(errorsValue);
  check("no runtime errors", errors.length === 0, report.errors);
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
    report.failure === undefined &&
    report.cleanupFailure === undefined &&
    report.cases.length >= 17 &&
    report.checks.length >= 25 &&
    report.checks.every((c) => c.passed);
  writeFileSync(`${out}/report.json`, JSON.stringify(report, null, 2));

  if (!report.passed) {
    process.exitCode = 1;
  }
}
