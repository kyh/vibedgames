import * as THREE from "three";

import { ModelCache } from "../assets/loader";
import { earlyModelUrls, lateModelUrls } from "../assets/manifest";
import { AmbientLife } from "../fx/ambient-life";
import { SmashCones } from "../fx/cones";
import { Debris } from "../fx/debris";
import { LampGlow, type LampGlowBudget } from "../fx/lamp-glow";
import { NightWindows } from "../fx/night-windows";
import { SkidMarks } from "../fx/skids";
import { DriftTrails } from "../fx/trails";
import { FareManager } from "../game/fares";
import { ParkedCars } from "../game/parked-cars";
import { Traffic } from "../game/traffic";
import { RemoteCars } from "../net/remote-cars";
import { PhysicsWorld } from "../physics/physics-world";
import { Rng } from "../shared/rng";
import { Car } from "../vehicle/car";
import { RaycastVehicle } from "../vehicle/raycast-vehicle";
import { mountTunePanel } from "../vehicle/tune-panel";
import { skinById } from "../vehicle/car";
import { CityModel, type CityRestPayload } from "../world/city";
import { editorMode, loadLocalOverrides } from "../world/custom-map";
import { freewayPhysics } from "../world/freeways";
import type { CityGenPayload } from "../world/gen-worker";
import { getRuntimeMap, parseMapFile, setRuntimeMap } from "../world/map-file";
import { SolidIndex } from "../world/solid-index";
import {
  readRestCache,
  readWorldCache,
  writeRestCache,
  writeWorldCache,
} from "../world/world-cache";
import { fetchBakedRest, fetchBakedWorld } from "../world/world-fetch";
import { packRest, packWorld, serializeWorldBin, WORLD_REV } from "../world/world-bin";
import { Minimap } from "../ui/minimap";

export type WorldSpawn = {
  readonly x: number;
  readonly z: number;
  readonly yaw: number;
  readonly gx: number;
  readonly gz: number;
};

export type WorldCoreSystems = {
  readonly solidIndex: SolidIndex;
  readonly fares: FareManager;
  readonly skids: SkidMarks;
  readonly trails: DriftTrails;
  readonly lampGlow: LampGlow;
  readonly nightWindows: NightWindows | null;
  readonly minimap: Minimap;
};

export type WorldLoadResult = {
  readonly city: CityModel;
  readonly car: Car;
  readonly spawn: WorldSpawn;
  readonly skinId: string;
  readonly latePreload: Promise<void>;
  readonly restPromise: Promise<CityRestPayload | null>;
  readonly bakePayload: CityGenPayload | null;
  readonly ready: Promise<void>;
};

type RestState = {
  fromBake: boolean;
};

type WorldLoaderDeps = {
  readonly scene: THREE.Scene;
  readonly cache: ModelCache;
  readonly sceneFog: THREE.Fog;
  readonly lampGlowBudget: LampGlowBudget | null;
  readonly setLoading: (progress: number) => void;
  readonly hideLoading: () => void;
  readonly showTitle: () => void;
  readonly setStage: (label: string) => void;
  readonly computeSpawn: (city: CityModel) => WorldSpawn;
  readonly snapToCar: (car: Car) => void;
  readonly setupGarages: (city: CityModel) => void;
  readonly remoteSay: (anchor: THREE.Object3D, text: string) => void;
  readonly getRenderer: () => THREE.WebGLRenderer | null;
  readonly getCamera: () => THREE.Camera;
  readonly onCoreSystems: (systems: WorldCoreSystems) => void;
  readonly onRemoteCars: (remoteCars: RemoteCars) => void;
  readonly onPhysics: (physics: PhysicsWorld) => void;
  readonly onTraffic: (traffic: Traffic) => void;
  readonly onParked: (parked: ParkedCars) => void;
  readonly onDebris: (debris: Debris) => void;
  readonly onCones: (cones: SmashCones) => void;
  readonly onAmbient: (ambient: AmbientLife) => void;
  readonly onPlayable: () => void;
};

// Kick the city-gen worker. Returns null (main-thread gen) when the city has
// street/floor edits — local overrides live in localStorage, which the worker
// cannot see — or when the worker fails for any reason.
function cityEdited(): boolean {
  // A runtime map file replaces the world outright — never mix with baked
  // artifacts or caches. Baked CUSTOM_MAP edits are module constants.
  if (getRuntimeMap()) return true;
  const local = loadLocalOverrides();
  return (
    editorMode() && (local.add.length > 0 || local.remove.length > 0 || local.floor.length > 0)
  );
}

function startGenWorker(): Promise<CityGenPayload | null> {
  if (cityEdited()) return Promise.resolve(null);
  // Repeat visits: the finished world is in IndexedDB — skip generation.
  return readWorldCache().then((cached) => {
    if (cached) return cached;
    return runGenWorker();
  });
}

function runGenWorker(): Promise<CityGenPayload | null> {
  return new Promise((resolve) => {
    try {
      const worker = new Worker(new URL("../world/gen-worker.ts", import.meta.url), {
        type: "module",
      });
      const bail = setTimeout(() => {
        worker.terminate();
        resolve(null);
      }, 90000);
      worker.onmessage = (ev: MessageEvent<CityGenPayload>) => {
        clearTimeout(bail);
        worker.terminate();
        writeWorldCache(ev.data);
        resolve(ev.data);
      };
      worker.onerror = () => {
        clearTimeout(bail);
        worker.terminate();
        resolve(null);
      };
    } catch {
      resolve(null);
    }
  });
}

export async function loadWorld(deps: WorldLoaderDeps): Promise<WorldLoadResult> {
  // ?map=<url>: build the world from a saved map file (editor export).
  const mapUrl = new URLSearchParams(window.location.search).get("map");
  if (mapUrl) {
    try {
      const res = await fetch(mapUrl);
      const parsed = parseMapFile(await res.json());
      if (parsed) {
        setRuntimeMap(parsed);
        console.log(`[map] loaded ${mapUrl}: ${parsed.props.length} props`);
      } else {
        console.log(`[map] ${mapUrl} rejected (bad format/version)`);
      }
    } catch (e) {
      console.log(`[map] ${mapUrl} failed: ${e instanceof Error ? e.message : e}`);
    }
  }
  // City geometry generates in a WORKER, in parallel with the model
  // download — the main thread only uploads the returned buffers. Edited
  // cities (baked or local street/floor overrides) keep main-thread gen so
  // editor changes stay real; the worker never sees localStorage.
  const edited = cityEdited();
  // ?bake=1 must GENERATE (it produces the artifacts) — never consume them.
  const bakeMode = new URLSearchParams(window.location.search).has("bake");
  const skipBaked = edited || bakeMode;
  // world.bin is small (terrain) and usually beats the worker; rest.bin is
  // big (the whole built city) and STREAMS BEHIND THE TITLE — initLate
  // waits for it, the title doesn't. Any failure falls back to the
  // worker + IndexedDB pipeline.
  const bakedWorldPromise = skipBaked ? Promise.resolve(null) : fetchBakedWorld();
  const bakedRestPromise = skipBaked ? Promise.resolve(null) : fetchBakedRest();
  const genPromise = bakedWorldPromise.then((baked) => baked ?? startGenWorker());
  const restState: RestState = { fromBake: false };
  const restPromise = bakedRestPromise.then((baked) => {
    if (baked) restState.fromBake = true;
    return baked ? baked : edited ? null : readRestCache();
  });
  // Two-stage model preload: the title needs only the ~200KB early set
  // (player car + everything buildPhase1 touches); the other ~7MB of GLBs
  // stream behind the title, and finishLoad waits for them before the late
  // city build (rebuildRest resolves building/prop refs from the cache).
  await deps.cache.preload(earlyModelUrls(), (frac) => {
    deps.setLoading(frac * 0.7);
  });
  const latePreload = deps.cache.preload(lateModelUrls(), () => {});
  // The worker may still be generating — keep the bar honest but ALIVE
  // (a frozen bar reads as a hang; this crawls 70 -> 84% while waiting).
  let waitFrac = 0.7;
  const crawl = setInterval(() => {
    waitFrac = Math.min(0.84, waitFrac + 0.01);
    deps.setLoading(waitFrac);
  }, 400);
  const payload = await genPromise;
  console.log(`[city] worker payload: ${payload ? "yes" : "fallback to main-thread gen"}`);
  clearInterval(crawl);
  const city = new CityModel(deps.cache, payload);
  await city.initEarly((frac) => {
    deps.setLoading(frac);
  });
  deps.scene.add(city.group);

  const spawn = deps.computeSpawn(city);
  const skinId = skinById(storageGet("crazy-waymo:skin")).id;
  const car = new Car(deps.cache, skinId);
  car.setSurface(city);
  deps.scene.add(car.object3D);
  car.reset(spawn.x, spawn.z, spawn.yaw);

  // Title NOW — the heavy city passes finish behind it while the player
  // reads the screen. Enter is gated on `ready`.
  deps.snapToCar(car);
  deps.hideLoading();
  deps.showTitle();
  const ready = finishLoad(deps, city, car, spawn, restPromise, latePreload, payload, restState);
  return {
    city,
    car,
    spawn,
    skinId,
    latePreload,
    restPromise,
    bakePayload: payload,
    ready,
  };
}

// Everything that needs the fully built city (buildings, furniture,
// physics, traffic…) — runs behind the title screen.
async function finishLoad(
  deps: WorldLoaderDeps,
  city: CityModel,
  car: Car,
  spawn: WorldSpawn,
  restPromise: Promise<CityRestPayload | null>,
  latePreload: Promise<void>,
  bakePayload: CityGenPayload | null,
  restState: RestState,
): Promise<void> {
  const paint = (): Promise<void> =>
    new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
  deps.setStage("DOWNLOADING THE CITY…");
  const [rest] = await Promise.all([restPromise, latePreload]);
  city.setRestPayload(rest);
  let lastPct = -1;
  await city.initLate((f) => {
    const pct = Math.min(99, Math.round(f * 100));
    if (pct !== lastPct) {
      lastPct = pct;
      deps.setStage(`FINISHING THE CITY… ${pct}%`);
    }
  });
  // Static city built: freeze its matrices (editor sessions keep them live
  // so props/streets can be rebuilt and dragged).
  if (!editorMode()) city.freezeStatic();

  // --- PLAYABLE GATE: driving needs city meshes + solids + fares. ---
  const solidIndex = new SolidIndex(city.solids);
  const fares = new FareManager(deps.cache, city);
  deps.scene.add(fares.group);
  const skids = new SkidMarks((x, z) => city.heightAt(x, z));
  deps.scene.add(skids.mesh);
  const trails = new DriftTrails((x, z) => city.heightAt(x, z));
  deps.scene.add(trails.mesh);
  const lampGlow = new LampGlow(city.lampHeads, deps.lampGlowBudget);
  deps.scene.add(lampGlow.group);
  // Lit windows come from the batch records: the baked payload on the
  // deployed path, the live capture on the generated/editor path.
  const windowItems = rest?.batchItems ?? city.restCapture?.batchItems;
  const nightWindows = windowItems
    ? new NightWindows(windowItems, deps.cache, deps.lampGlowBudget ? 12000 : 32000)
    : null;
  if (nightWindows) deps.scene.add(nightWindows.mesh);
  const minimap = new Minimap(city.plan, city.getDecks());
  deps.onCoreSystems({ solidIndex, fares, skids, trails, lampGlow, nightWindows, minimap });

  await paint();

  // --- STREAMED TAIL: bounce physics, traffic, parked cars, props. The
  // game is already playable; these appear within the first seconds. ---
  const lap = (() => {
    let t = performance.now();
    return (label: string): void => {
      const now = performance.now();
      console.log(`[tail] ${label} ${Math.round(now - t)}ms`);
      t = now;
    };
  })();
  const remoteCars = new RemoteCars(deps.cache, city, (anchor, text) => {
    deps.remoteSay(anchor, text);
  });
  deps.scene.add(remoteCars.group);
  deps.onRemoteCars(remoteCars);
  deps.setupGarages(city);
  lap("remoteCars");
  await paint();

  const physics = await PhysicsWorld.create();
  lap("physics wasm");
  await paint();
  physics.addGround((x, z) => city.heightAt(x, z));
  lap("ground collider");
  await paint();
  // Freeway decks + barriers as a second drivable level over the streets.
  physics.addStaticTrimesh(freewayPhysics(city.terrain, city.network));
  lap("freeway collider");
  await paint();
  // Prewarm with the ground only — a small BVH builds fast. The 20k
  // building colliders STREAM IN below (incremental inserts amortize);
  // they only matter once something bounces off them.
  physics.prewarm();
  lap("physics prewarm");
  deps.onPhysics(physics);
  // The player car goes physics-native: Rapier raycast suspension drives it
  // from here on (kinematic sim stays as the pre-physics fallback).
  const vehicle = new RaycastVehicle(physics, 0, 0, 0, 0);
  car.attachPhysics(vehicle);
  deps.snapToCar(car);
  if (new URLSearchParams(window.location.search).has("tune")) mountTunePanel(vehicle);
  await paint();

  // Prewarm shaders BEFORE declaring playable: the countdown swoop reveals
  // the whole city at once, and first-render program compiles on a phone
  // GPU are a multi-hundred-ms stall landing on a live frame otherwise.
  // compileAsync uses KHR_parallel_shader_compile where available.
  deps.setStage("WARMING UP…");
  const renderer = deps.getRenderer();
  if (renderer) {
    try {
      await renderer.compileAsync(deps.scene, deps.getCamera());
    } catch {
      // A failed prewarm just means compiles happen on first render.
    }
  }

  // PLAYABLE: city, arcade solids and stepping physics are ready.
  deps.onPlayable();
  // The rest-cache write serializes ~100MB — idle time only, never at start.
  if (city.restCapture && !restState.fromBake) {
    const restCapture = city.restCapture;
    const idle =
      "requestIdleCallback" in window
        ? (cb: () => void): void => void requestIdleCallback(cb, { timeout: 30000 })
        : (cb: () => void): void => void setTimeout(cb, 8000);
    idle(() => writeRestCache(restCapture));
  }
  await paint();

  await physics.addStaticSolids(city.solids, city.terrain);
  lap("static solids (streamed)");
  await paint();

  const traffic = new Traffic(
    deps.cache,
    city,
    { avoid: { gx: spawn.gx, gz: spawn.gz }, avoidR: 4 },
    physics,
  );
  deps.scene.add(traffic.group);
  deps.onTraffic(traffic);
  lap("traffic");
  await paint();

  // Parked cars: punt-able bodies (bounce when rammed), not static solids.
  const parked = new ParkedCars(deps.cache, city.parkedCarSpecs, physics, (x, z) =>
    city.heightAt(x, z),
  );
  deps.scene.add(parked.group);
  deps.onParked(parked);
  lap("parked");
  await paint();

  const debris = new Debris(deps.cache, (x, z) => city.heightAt(x, z));
  deps.scene.add(debris.group);
  deps.onDebris(debris);
  const cones = new SmashCones(deps.cache, city, new Rng(777), physics);
  deps.scene.add(cones.mesh);
  deps.onCones(cones);
  const lifeRng = new Rng(4242);
  const ambient = new AmbientLife(
    deps.sceneFog,
    (x, z) => city.heightAt(x, z),
    () => lifeRng.range(0, 1),
  );
  deps.scene.add(ambient.group);
  deps.onAmbient(ambient);
  lap("debris+cones");

  // ?bake=1: download the two world artifacts (gzipped) for public/world/.
  // Run on a COLD dev build so the capture reflects the current pipeline.
  if (new URLSearchParams(window.location.search).has("bake")) {
    const gzip = async (bytes: Uint8Array): Promise<Blob> => {
      const stream = new Blob([new Uint8Array(bytes)])
        .stream()
        .pipeThrough(new CompressionStream("gzip"));
      return await new Response(stream).blob();
    };
    const save = (blob: Blob, name: string): void => {
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = name;
      a.click();
    };
    const worldPayload = bakePayload;
    if (worldPayload) {
      console.log("[bake] packing world…");
      save(
        await gzip(serializeWorldBin({ rev: WORLD_REV, world: packWorld(worldPayload) })),
        "world.bin",
      );
    }
    if (city.restCapture) {
      console.log("[bake] packing rest…");
      const packed = packRest(city.restCapture);
      console.log("[bake] serializing rest…");
      const bin = serializeWorldBin({ rev: WORLD_REV, rest: packed });
      console.log(`[bake] gzipping rest (${bin.byteLength} bytes)…`);
      save(await gzip(bin), "rest.bin");
    }
    console.log("[bake] artifacts downloaded — move into public/world/ and commit");
  }
}

function storageGet(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}
