import type * as THREE from "three";

import type { ModelCache } from "../assets/loader";
import { earlyModelUrls, lateModelUrls } from "../assets/manifest";
import { AmbientLife } from "../fx/ambient-life";
import { SmashCones } from "../fx/cones";
import { Debris } from "../fx/debris";
import { LampGlow } from "../fx/lamp-glow";
import type { LampGlowBudget } from "../fx/lamp-glow";
import { registerStreetLuminaires } from "../fx/street-luminaires";
import { SkidMarks } from "../fx/skids";
import { DriftTrails } from "../fx/trails";
import { FareManager } from "../game/fares";
import { ParkedCars } from "../game/parked-cars";
import { Traffic } from "../game/traffic";
import { PhysicsWorld } from "../physics/physics-world";
import { Rng } from "../shared/rng";
import { Car, skinById, skinModelUrl } from "../vehicle/car";
import { RaycastVehicle } from "../vehicle/raycast-vehicle";
import { CityModel, tileHoldRadius } from "../world/city";
import { contextLostBefore } from "../render/safe-mode";
import type { CityRestPayload } from "../world/city";
import { editorMode, loadLocalOverrides } from "../world/custom-map";
import { freewayPhysics } from "../world/freeways";
import { surfaceDeckPhysics } from "../world/surface-decks";
import type { CityGenPayload } from "../world/gen-worker";
import { getRuntimeMap, parseMapFile, setRuntimeMap } from "../world/map-file";
import { SolidIndex } from "../world/solid-index";
import {
  readParcelPlanCache,
  readRestCache,
  readWorldCache,
  writeParcelPlanCache,
  writeRestCache,
  writeWorldCache,
} from "../world/world-cache";
import type { ParcelPlanResult } from "../world/parcel-plan";
import type { PlayerSpawn } from "../world/player-spawn";
import { decodeParcelSource } from "../world/parcel-source";
import type { ParcelSource } from "../world/parcel-source";
import type { ParcelWorkerRequest, ParcelWorkerResponse } from "../world/parcel-worker";
import { fetchBakedWorld, fetchParcelSource, fetchWorldMeta } from "../world/world-fetch";
import type { CityRestMeta } from "../world/world-bin";
import { PHONE_REACH, SAFE_REACH, isCoarsePointer } from "../render/quality";
import { Minimap } from "../ui/minimap";

export type WorldSpawn = PlayerSpawn;

export interface WorldCoreSystems {
  readonly solidIndex: SolidIndex;
  readonly fares: FareManager;
  readonly skids: SkidMarks;
  readonly trails: DriftTrails;
  readonly lampGlow: LampGlow;
  readonly minimap: Minimap;
}

export interface WorldLoadResult {
  readonly city: CityModel;
  readonly car: Car;
  readonly spawn: WorldSpawn;
  readonly skinId: string;
  readonly ready: Promise<void>;
}

interface RestSource {
  readonly meta: CityRestMeta | null;
  readonly rest: CityRestPayload | null;
}

const gateRadius = () =>
  isCoarsePointer()
    ? Math.round(480 * (contextLostBefore() ? SAFE_REACH / PHONE_REACH : 1))
    : tileHoldRadius();

interface WorldLoaderDeps {
  readonly scene: THREE.Scene;
  readonly cache: ModelCache;
  readonly sceneFog: THREE.Fog;
  readonly lampGlowBudget: LampGlowBudget | null;
  readonly setLoading: (progress: number, label?: string) => void;
  /** CSS-driven glide for stages that block the main thread. */
  readonly glideLoading: (progress: number, seconds: number, label?: string) => void;
  readonly hideLoading: () => void;
  readonly showTitle: () => void;
  readonly setStage: (label: string) => void;
  readonly computeSpawn: (city: CityModel) => WorldSpawn;
  readonly snapToCar: (car: Car) => void;
  readonly setupGarages: (city: CityModel) => void;
  readonly getRenderer: () => THREE.WebGLRenderer | null;
  readonly getCamera: () => THREE.Camera;
  /** Mobile sun: warm its shadowless floor tier too. Null keeps one pass. */
  readonly shadowlessWarmup: THREE.DirectionalLight | null;
  readonly onCoreSystems: (systems: WorldCoreSystems) => void;
  readonly onPhysics: (physics: PhysicsWorld) => void;
  readonly onTraffic: (traffic: Traffic) => void;
  readonly onParked: (parked: ParkedCars) => void;
  readonly onDebris: (debris: Debris) => void;
  readonly onCones: (cones: SmashCones) => void;
  /** Attach world-dependent actors and lighting before shader warmup. */
  readonly onAmbient: (ambient: AmbientLife, city: CityModel) => void;
  readonly onPlayable: () => void;
}

const cityEdited = () => {
  if (getRuntimeMap()) {
    return true;
  }

  const local = loadLocalOverrides();

  return (
    editorMode() && (local.add.length > 0 || local.remove.length > 0 || local.floor.length > 0)
  );
};

const runWhenIdle = (task: () => void) => {
  if ("requestIdleCallback" in window) {
    requestIdleCallback(task, { timeout: 30_000 });
  } else {
    setTimeout(task, 8000);
  }
};

const AFTER_VEIL_MS = 1500;
let loadFinished = false;
const afterLoad: (() => void)[] = [];

const runAfterLoad = (task: () => void) => {
  if (loadFinished) {
    runWhenIdle(task);
  } else {
    afterLoad.push(task);
  }
};

const flushAfterLoad = () => {
  const queued = afterLoad.splice(0);
  setTimeout(() => {
    loadFinished = true;

    for (const task of queued) {
      runWhenIdle(task);
    }
  }, AFTER_VEIL_MS);
};

const fromWorker = (r: ParcelWorkerResponse) => ({
  covered: new Set(r.covered),
  lots: r.lots,
  plans: r.plans,
  stats: r.stats,
});

interface ParcelResolved {
  readonly plan: ParcelPlanResult | null;
  readonly source: ParcelSource | null;
}

const runGenWorker: () => Promise<CityGenPayload | null> = () =>
  // oxlint-disable-next-line promise/avoid-new -- wraps the gen worker's message/error callbacks
  new Promise((resolve) => {
    try {
      const worker = new Worker(new URL("../world/gen-worker.ts", import.meta.url), {
        type: "module",
      });

      const timeout = new URLSearchParams(window.location.search).has("bake") ? 900_000 : 90_000;

      const bail = setTimeout(() => {
        worker.terminate();
        resolve(null);
      }, timeout);

      worker.addEventListener("message", (ev: MessageEvent<CityGenPayload>) => {
        clearTimeout(bail);
        worker.terminate();
        writeWorldCache(ev.data);
        resolve(ev.data);
      });
      worker.addEventListener("error", () => {
        clearTimeout(bail);
        worker.terminate();
        resolve(null);
      });
    } catch {
      resolve(null);
    }
  });

const startGenWorker: () => Promise<CityGenPayload | null> = () => {
  if (cityEdited()) {
    return Promise.resolve(null);
  }

  return readWorldCache().then((cached) => {
    if (cached) {
      return cached;
    }

    return runGenWorker();
  });
};

const runParcelWorker: (source: ArrayBuffer) => Promise<ParcelPlanResult | null> = (source) => {
  const bytes = source.byteLength;

  // oxlint-disable-next-line promise/avoid-new -- wraps the parcel worker's message/error callbacks
  return new Promise((resolve) => {
    try {
      const worker = new Worker(new URL("../world/parcel-worker.ts", import.meta.url), {
        type: "module",
      });

      worker.addEventListener("message", (ev: MessageEvent<ParcelWorkerResponse>) => {
        const r = ev.data;
        console.log(`[parcel-worker] planned ${r.plans.length} parcels in ${r.ms}ms`);
        runAfterLoad(() => writeParcelPlanCache(bytes, r));
        resolve(fromWorker(r));
        worker.terminate();
      });
      worker.addEventListener("error", (e) => {
        console.log(`[parcel-worker] failed: ${e.message}`);
        resolve(null);
        worker.terminate();
      });
      const req: ParcelWorkerRequest = { source };
      worker.postMessage(req, [source]);
    } catch (error) {
      console.log(`[parcel-worker] unavailable: ${error instanceof Error ? error.message : error}`);
      resolve(null);
    }
  });
};

const resolveParcels: (
  metaPromise: Promise<CityRestMeta | null>,
  edited: boolean,
) => Promise<ParcelResolved> = async (metaPromise, edited) => {
  const meta = await metaPromise;

  if (meta) {
    return { plan: null, source: null };
  }

  const bytes = await fetchParcelSource();

  if (!bytes) {
    return { plan: null, source: null };
  }

  if (edited) {
    return { plan: null, source: decodeParcelSource(bytes) };
  }

  const cached = await readParcelPlanCache(bytes.byteLength);

  if (cached) {
    console.log(`[parcel-worker] plan from cache: ${cached.plans.length} parcels`);

    return { plan: fromWorker(cached), source: null };
  }

  // oxlint-disable-next-line unicorn/prefer-spread -- ArrayBuffer#slice copies the buffer; spreading it is not the same operation
  const copy = bytes.slice(0);
  const plan = await runParcelWorker(bytes);

  return { plan, source: plan ? null : decodeParcelSource(copy) };
};

const resolveGen: (
  bakedWorldPromise: Promise<CityGenPayload | null>,
) => Promise<CityGenPayload | null> = async (bakedWorldPromise) =>
  (await bakedWorldPromise) ?? startGenWorker();

const resolveRest: (
  metaPromise: Promise<CityRestMeta | null>,
  edited: boolean,
) => Promise<RestSource> = async (metaPromise, edited) => {
  const meta = await metaPromise;

  if (meta) {
    return { meta, rest: null };
  }

  return { meta: null, rest: edited ? null : await readRestCache() };
};

const paint: () => Promise<void> = () =>
  // oxlint-disable-next-line promise/avoid-new -- wraps the requestAnimationFrame + setTimeout callbacks
  new Promise((resolve) => {
    requestAnimationFrame(() => setTimeout(resolve, 0));
  });

const warmupShaders = async (deps: WorldLoaderDeps) => {
  const renderer = deps.getRenderer();

  if (!renderer) {
    return;
  }

  const sun = deps.shadowlessWarmup;
  const originalCastShadow = sun?.castShadow ?? false;

  try {
    if (sun) {
      sun.castShadow = true;
    }

    await renderer.compileAsync(deps.scene, deps.getCamera());

    if (sun) {
      sun.castShadow = false;
      await renderer.compileAsync(deps.scene, deps.getCamera());
    }
  } catch {
  } finally {
    if (sun) {
      sun.castShadow = originalCastShadow;

      if (originalCastShadow) {
        renderer.shadowMap.needsUpdate = true;
      }
    }
  }
};

const finishLoad = async (
  deps: WorldLoaderDeps,
  city: CityModel,
  car: Car,
  spawn: WorldSpawn,
  restPromise: Promise<RestSource>,
  parcelPromise: Promise<ParcelResolved>,
  latePreload: Promise<void>,
  bakePayload: CityGenPayload | null,
) => {
  deps.setStage("DOWNLOADING THE CITY…");
  deps.glideLoading(0.64, 12, "Building San Francisco…");
  const [{ meta, rest }, parcels] = await Promise.all([restPromise, parcelPromise, latePreload]);
  city.setRestMeta(meta);
  city.setRestPayload(rest);
  city.setParcelPlan(parcels.plan);
  city.setParcelSource(parcels.source);
  const buildTo = meta ? 0.7 : 0.84;
  let lastPct = -1;
  await city.initLate((f) => {
    const pct = Math.min(99, Math.round(f * 100));

    if (pct !== lastPct) {
      lastPct = pct;
      deps.setStage(`FINISHING THE CITY… ${pct}%`);
      deps.setLoading(0.64 + f * (buildTo - 0.64), "Building San Francisco…");
    }
  });

  if (meta) {
    deps.setStage("DOWNLOADING THE CITY…");
    await city.streamGate(spawn.x, spawn.z, gateRadius(), (done, total) => {
      const f = total > 0 ? done / total : 1;
      deps.setLoading(buildTo + f * (0.84 - buildTo), "Downloading San Francisco…");
    });
  }

  if (!editorMode()) {
    city.freezeStatic();
  }

  deps.setLoading(0.85, "Preparing your ride…");
  const solidIndex = new SolidIndex(city.solids);
  const fares = new FareManager(deps.cache, city);
  deps.scene.add(fares.group);
  const skids = new SkidMarks((x, z) => city.heightAt(x, z));
  deps.scene.add(skids.mesh);
  const trails = new DriftTrails((x, z) => city.heightAt(x, z));
  deps.scene.add(trails.mesh);
  const lampGlow = new LampGlow(city.lampHeads, deps.lampGlowBudget);
  deps.scene.add(lampGlow.group);
  const propItems = meta?.batchItems ?? rest?.batchItems ?? city.restCapture?.batchItems;

  if (propItems) {
    registerStreetLuminaires(propItems);
  }

  const minimap = new Minimap(city.plan, city.getDecks());
  deps.onCoreSystems({ fares, lampGlow, minimap, skids, solidIndex, trails });

  await paint();

  const lap = (() => {
    let t = performance.now();

    return (label: string) => {
      const now = performance.now();
      console.log(`[tail] ${label} ${Math.round(now - t)}ms`);
      t = now;
    };
  })();

  deps.setupGarages(city);
  lap("garages");
  await paint();

  const physics = await PhysicsWorld.create();
  lap("physics wasm");
  await paint();
  physics.addGround((x, z) => city.heightAt(x, z));
  lap("ground collider");
  await paint();
  physics.addStaticTrimesh(freewayPhysics(city.terrain, city.network));
  const deckFloor = surfaceDeckPhysics(city.getDecks());

  if (deckFloor.length > 0) {
    physics.addStaticTrimesh(deckFloor);
  }

  lap("freeway collider");
  await paint();
  physics.prewarm();
  lap("physics prewarm");
  deps.onPhysics(physics);
  const vehicle = new RaycastVehicle(physics, 0, 0, 0, 0);
  car.attachPhysics(vehicle);
  deps.snapToCar(car);
  deps.setLoading(0.91, "Preparing your ride…");

  if (new URLSearchParams(window.location.search).has("tune")) {
    try {
      const { mountTunePanel } = await import("../vehicle/tune-panel");
      mountTunePanel(vehicle);
    } catch (error) {
      console.error("[tune] panel failed to load:", error);
    }
  }

  await paint();

  if (city.restCapture && !meta) {
    const { restCapture } = city;
    runWhenIdle(() => writeRestCache(restCapture));
  }

  await paint();

  physics.addStaticSolids(city.solids, city.terrain);
  city.setSolidSink({
    add: (tile, solids) => {
      solidIndex.addTile(tile, solids);
      physics.addStaticSolids(solids, city.terrain, tile);
    },
    remove: (tile) => {
      solidIndex.removeTile(tile);
      physics.removeStaticSolids(tile);
    },
  });
  physics.streamSolids(car.position.x, car.position.z);
  physics.prewarm();
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
  deps.onAmbient(ambient, city);
  lap("debris+cones");

  deps.setStage("WARMING UP…");
  deps.setLoading(0.97, "Almost ready…");
  await paint();
  await warmupShaders(deps);

  if (new URLSearchParams(window.location.search).has("bake")) {
    const { downloadWorldArtifacts } = await import("../world/bake-download");
    await downloadWorldArtifacts(bakePayload, city);
  }

  deps.setLoading(1, "Ready to drive");
  deps.showTitle();
  deps.onPlayable();
  deps.hideLoading();
  flushAfterLoad();
};

const storageGet = (key: string) => {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
};

export const loadWorld = async (deps: WorldLoaderDeps) => {
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
    } catch (error) {
      console.log(`[map] ${mapUrl} failed: ${error instanceof Error ? error.message : error}`);
    }
  }

  const edited = cityEdited();
  const bakeMode = new URLSearchParams(window.location.search).has("bake");
  const skipBaked = edited || bakeMode;
  const bakedWorldPromise = skipBaked ? Promise.resolve(null) : fetchBakedWorld();

  const metaPromise: Promise<CityRestMeta | null> = skipBaked
    ? Promise.resolve(null)
    : fetchWorldMeta();

  const parcelPromise = resolveParcels(metaPromise, edited);
  const genPromise = resolveGen(bakedWorldPromise);
  const restPromise = resolveRest(metaPromise, edited);
  const MODELS_TO = 0.26;
  const WORLD_TO = 0.46;
  await deps.cache.preload(earlyModelUrls(), (frac) => {
    deps.setLoading(0.14 + frac * (MODELS_TO - 0.14), "Loading models…");
  });

  const latePreload = deps.cache.preload(lateModelUrls(), () => {});

  deps.glideLoading(
    WORLD_TO,
    14,
    skipBaked ? "Generating San Francisco…" : "Downloading San Francisco…",
  );
  const payload = await genPromise;
  console.log(`[city] worker payload: ${payload ? "yes" : "fallback to main-thread gen"}`);
  const city = new CityModel(deps.cache, payload);
  await city.initEarly((frac) => {
    deps.setLoading(WORLD_TO + frac * 0.06, "Laying out streets…");
  });
  deps.scene.add(city.group);

  const spawn = deps.computeSpawn(city);
  const skin = skinById(storageGet("crazy-waymo:skin"));
  const skinId = skin.id;
  await deps.cache.ensure(skinModelUrl(skin));
  const car = new Car(deps.cache, skinId);
  car.setSurface(city);
  deps.scene.add(car.object3D);
  car.reset(spawn.x, spawn.z, spawn.yaw);

  deps.snapToCar(car);

  const ready = finishLoad(
    deps,
    city,
    car,
    spawn,
    restPromise,
    parcelPromise,
    latePreload,
    payload,
  );

  return {
    car,
    city,
    ready,
    skinId,
    spawn,
  };
};
