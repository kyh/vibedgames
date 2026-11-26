import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Vector3 } from "three";
import { z } from "zod";

import type { JsonValue } from "../src/shared/json.ts";
import { jsonSchema, probeSchema } from "./page-shapes.mts";
import type { CheckEntry } from "./page-shapes.mts";

const url = process.argv[2] ?? "http://localhost:5193/?time=noon&offline=1";
const output = path.resolve(process.argv[3] ?? "/private/tmp/waymo-studio-review");
const session = process.env.WAYMO_REVIEW_SESSION ?? `crazy-waymo-studio-${process.pid}`;

mkdirSync(output, { recursive: true });

const browser = (...args: string[]) => {
  const stdout = execFileSync("agent-browser", ["--session", session, ...args, "--json"], {
    encoding: "utf-8",
    maxBuffer: 8 * 1024 * 1024,
    timeout: 90_000,
  });

  const result = agentResultSchema.parse(JSON.parse(stdout));

  if (!result.success) {
    throw new Error(JSON.stringify(result.error));
  }

  return result.data;
};

const agentResultSchema = z.object({
  data: z.unknown().optional(),
  error: jsonSchema.optional(),
  success: z.boolean(),
});

const evalSchema = z.object({ result: jsonSchema.optional() });

type PageResult = JsonValue | undefined;

type PageFn<A extends JsonValue[]> = (...args: A) => PageResult | Promise<PageResult>;

const runExpression = (expression: string) => evalSchema.parse(browser("eval", expression)).result;

const run = <A extends JsonValue[]>(fn: PageFn<A>, ...args: A) =>
  runExpression(`(${fn.toString()})(...${JSON.stringify(args)})`);

const read = <T, A extends JsonValue[]>(schema: z.ZodType<T>, fn: PageFn<A>, ...args: A) =>
  schema.parse(run(fn, ...args));

interface StudioReport {
  checkedAt: string;
  checks: CheckEntry[];
  url: string;
  views: JsonValue[];
  worldRevision?: number;
  display?: JsonValue;
}

const report: StudioReport = { checkedAt: new Date().toISOString(), checks: [], url, views: [] };

const check = (name: string, passed: boolean, evidence: JsonValue) => {
  report.checks.push({ evidence, name, passed });
  console.log(`${passed ? "PASS" : "FAIL"} ${name}: ${JSON.stringify(evidence)}`);
};

const streamSchema = z
  .object({
    builtMs: z.number(),
    bytes: z.number(),
    cells: z.number(),
    detailedCells: z.number(),
    pending: z.number(),
    resident: z.number(),
    verts: z.number(),
  })
  .nullable();

const review = () => {
  browser("--headed", "open", url);
  browser("set", "viewport", "1440", "900");
  browser("wait", "--fn", "window.__taxi?.game?.isReady === true");
  report.worldRevision = z
    .number()
    .parse(runExpression('import("/src/world/world-bin.ts").then((world) => world.WORLD_REV)'));
  report.display = read(jsonSchema, () => ({
    coarsePointer: matchMedia("(pointer: coarse)").matches,
    height: innerHeight,
    pixelRatio: devicePixelRatio,
    width: innerWidth,
  }));
  run(() => {
    const taxi = window.__taxi;

    if (!taxi) {
      throw new Error("Dev-only Taxi hooks unavailable");
    }

    taxi.game.restartRun();
    taxi.setPhase(0.25);
  });
  browser("wait", "--fn", "window.__taxi.game.mode.kind === 'playing'");

  const drivingSchema = z.object({
    boosted: z.boolean(),
    braked: probeSchema.nullable(),
    distance: z.number(),
    drifted: z.boolean(),
    driven: probeSchema.nullable(),
    first: probeSchema,
    frames: z.number(),
    peak: z.number(),
  });

  const driving = read(drivingSchema, async () => {
    const taxi = window.__taxi;

    if (!taxi) {
      throw new Error("Taxi not ready");
    }

    taxi.setFreecam(false);
    taxi.teleport(0.37, 0.39);
    const first = taxi.probe();

    if (!first) {
      throw new Error("No live vehicle");
    }

    const { city, traffic } = taxi.game;

    if (!city || !traffic) {
      throw new Error("Run not started");
    }

    traffic.reset({ gx: city.gridX(first.x), gz: city.gridZ(first.z) }, 7);

    let frames = 0;
    let peak = 0;
    let boosted = false;
    let drifted = false;

    const hold = async (keys: string[], ms: number, reached?: () => boolean) => {
      for (const held of keys) {
        window.dispatchEvent(new KeyboardEvent("keydown", { key: held }));
      }

      const until = performance.now() + ms;

      try {
        const { promise, resolve } = Promise.withResolvers<null>();

        const tick = () => {
          frames += 1;
          const p = taxi.probe();

          if (p) {
            peak = Math.max(peak, p.speed);
            boosted ||= p.boosting;
            drifted ||= p.drifting;
          }

          if (reached?.() === true || performance.now() >= until) {
            resolve(null);
          } else {
            requestAnimationFrame(tick);
          }
        };

        requestAnimationFrame(tick);

        await promise;
      } finally {
        for (const held of keys) {
          window.dispatchEvent(new KeyboardEvent("keyup", { key: held }));
        }
      }
    };

    await hold(["w"], 8000, () => {
      const p = taxi.probe();

      return p !== null && p.speed > 12 && Math.hypot(p.x - first.x, p.z - first.z) > 8;
    });
    const driven = taxi.probe();
    await hold(["w", "shift"], 350);
    await hold(["s"], 4000, () => (taxi.probe()?.speed ?? Infinity) < 2);
    const braked = taxi.probe();
    taxi.teleport(0.37, 0.39);
    await hold(["w"], 8000, () => (taxi.probe()?.speed ?? 0) > 12);
    await hold(["w", "s", "d"], 350);

    return {
      boosted,
      braked,
      distance: driven ? Math.hypot(driven.x - first.x, driven.z - first.z) : 0,
      drifted,
      driven,
      first,
      frames,
      peak,
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
  check(
    "brake reduces speed",
    driving.braked !== null && driving.braked.speed < driving.peak * 0.85,
    driving.braked === null
      ? { peak: driving.peak }
      : { peak: driving.peak, speed: driving.braked.speed },
  );
  browser("screenshot", path.join(output, "driving.png"));

  const fareSchema = z.object({
    completed: z.boolean(),
    fares: z.number().nullable(),
    pickedUp: z.boolean(),
    score: z.number(),
  });

  const fare = read(fareSchema, async () => {
    const taxi = window.__taxi;

    if (!taxi) {
      throw new Error("Taxi not ready");
    }

    const { game } = taxi;
    const { car, city, fares } = game;

    if (!car || !city || !fares) {
      throw new Error("Run not started");
    }

    const stageNear = (pos: Vector3) => {
      const hit = city.network.nearest(pos.x, pos.z, 80);

      if (!hit) {
        throw new Error("Fare has no reachable road");
      }

      const dx = pos.x - hit.x;
      const dz = pos.z - hit.z;
      const distance = Math.hypot(dx, dz) || 1;
      const offset = Math.min(hit.edge.half - 1, Math.max(0, distance - 2.8));
      car.reset(
        hit.x + (dx / distance) * offset,
        hit.z + (dz / distance) * offset,
        Math.atan2(hit.tx, hit.tz),
      );
      game.rig.snapTo(car);
    };

    const fareWaitMs = 5000;

    const until = async (predicate: () => boolean) => {
      const deadline = performance.now() + fareWaitMs;
      const { promise, resolve } = Promise.withResolvers<null>();

      const tick = () => {
        if (predicate() || performance.now() > deadline) {
          resolve(null);
        } else {
          requestAnimationFrame(tick);
        }
      };

      requestAnimationFrame(tick);

      await promise;
    };

    const objective = fares.objective();

    if (!objective) {
      throw new Error("No passenger objective");
    }

    stageNear(objective.pos);
    await until(() => taxi.probe()?.carrying === true);
    const pickedUp = taxi.probe()?.carrying === true;
    const destination = fares.objective();

    if (!pickedUp || !destination) {
      return { completed: false, fares: null, pickedUp, score: game.state.score };
    }

    const before = game.state.fares;
    stageNear(destination.pos);
    await until(() => game.state.fares > before);

    return {
      completed: game.state.fares > before,
      fares: game.state.fares,
      pickedUp,
      score: game.state.score,
    };
  });

  check(
    "staged passenger pickup and delivery pay",
    fare.pickedUp && fare.completed && fare.score > 0,
    fare,
  );

  const paused = read(z.object({ distance: z.number().nullable() }), async () => {
    const taxi = window.__taxi;

    if (!taxi) {
      throw new Error("Taxi not ready");
    }

    taxi.game.requestPause();
    const before = taxi.probe();
    const waited = Promise.withResolvers<null>();

    setTimeout(() => {
      waited.resolve(null);
    }, 300);

    await waited.promise;
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
    read(probeSchema, () => window.__taxi?.probe() ?? null),
  );

  const hillSchema = z.object({
    clearance: z.number(),
    drift: z.number().nullable(),
    speed: z.number().nullable(),
  });

  const hill = read(hillSchema, async () => {
    const taxi = window.__taxi;

    if (!taxi) {
      throw new Error("Taxi not ready");
    }

    taxi.teleport(0.437, 0.401);
    taxi.setPhase(0.25);
    const settled = Promise.withResolvers<null>();

    setTimeout(() => {
      settled.resolve(null);
    }, 1500);

    await settled.promise;
    const first = taxi.probe();
    const parked = Promise.withResolvers<null>();

    setTimeout(() => {
      parked.resolve(null);
    }, 3000);

    await parked.promise;
    const last = taxi.probe();
    const camera = taxi.camera.position;
    const { city } = taxi.game;

    if (!city) {
      throw new Error("City not ready");
    }

    const floor = city.cameraFloorAt(camera.x, camera.z, camera.y);

    return {
      clearance: camera.y - floor,
      drift: first && last ? Math.hypot(last.x - first.x, last.z - first.z) : null,
      speed: last?.speed ?? null,
    };
  });

  check("parked taxi holds a city hill", hill.drift !== null && hill.drift < 0.4, hill);
  check("hill camera clears the road", hill.clearance >= 0.6, hill);

  const views = [
    { name: "sunset-noon", phase: 0.25, u: 0.235, v: 0.674 },
    { name: "haight-noon", phase: 0.25, u: 0.437, v: 0.401 },
    { name: "chinatown-noon", phase: 0.25, u: 0.67, v: 0.167 },
    { name: "north-beach-golden", phase: 0.4, u: 0.675, v: 0.112 },
    { name: "dogpatch-noon", phase: 0.25, u: 0.79, v: 0.51 },
    { name: "downtown-noon", phase: 0.25, u: 0.738, v: 0.19 },
    { name: "downtown-night", phase: 0.7, u: 0.738, v: 0.19 },
  ];

  for (const view of views) {
    run(
      async (u: number, v: number, phase: number) => {
        const taxi = window.__taxi;

        if (!taxi) {
          throw new Error("Taxi not ready");
        }

        taxi.teleport(u, v);
        taxi.setPhase(phase);
        taxi.setFreecam(false);
        const { promise, resolve } = Promise.withResolvers<null>();
        let frames = 0;

        const tick = () => {
          frames += 1;

          if (frames >= 72) {
            resolve(null);
          } else {
            requestAnimationFrame(tick);
          }
        };

        requestAnimationFrame(tick);

        await promise;
        await Promise.all(
          (document.querySelector("#district")?.getAnimations() ?? []).map(
            async (animation) => await animation.finished.catch(() => null),
          ),
        );
      },
      view.u,
      view.v,
      view.phase,
    );
    const file = path.join(output, `${view.name}.png`);
    browser("screenshot", file);
    const stream = read(streamSchema, () => window.__taxi?.game.city?.parcelStreamStats() ?? null);
    report.views.push({ ...view, file: path.basename(file), stream });
    console.log(
      `VIEW ${view.name}: ${Math.round((stream?.bytes ?? Number.NaN) / 1024 / 1024)} MB parcel geometry`,
    );
  }

  const { errors } = z.object({ errors: jsonSchema }).parse(browser("errors"));
  check("no page errors", Array.isArray(errors) && errors.length === 0, errors);
  writeFileSync(path.join(output, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  console.log(`Review: ${output}`);

  if (report.checks.some((result) => !result.passed)) {
    process.exitCode = 1;
  }
};

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
