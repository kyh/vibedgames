import * as THREE from "three";

import { ModelCache } from "../assets/loader";
import { earlyModelUrls, lateModelUrls } from "../assets/manifest";
import { AmbientLife } from "../fx/ambient-life";
import { SmashCones } from "../fx/cones";
import { Debris } from "../fx/debris";
import { LampGlow, type LampGlowBudget } from "../fx/lamp-glow";
import { registerStreetLuminaires } from "../fx/street-luminaires";
import { SkidMarks } from "../fx/skids";
import { DriftTrails } from "../fx/trails";
import { FareManager } from "../game/fares";
import { ParkedCars } from "../game/parked-cars";
import { Traffic } from "../game/traffic";
import { RemoteCars } from "../net/remote-cars";
import { PhysicsWorld } from "../physics/physics-world";
import { Rng } from "../shared/rng";
import { Car, skinById, skinModelUrl } from "../vehicle/car";
import { RaycastVehicle } from "../vehicle/raycast-vehicle";
import { CityModel, type CityRestPayload } from "../world/city";
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
import { decodeParcelSource, type ParcelSource } from "../world/parcel-source";
import type { ParcelWorkerRequest, ParcelWorkerResponse } from "../world/parcel-worker";
import { fetchBakedRest, fetchBakedWorld, fetchParcelSource } from "../world/world-fetch";
import { Minimap } from "../ui/minimap";

export type WorldSpawn = PlayerSpawn;

export type WorldCoreSystems = {
  readonly solidIndex: SolidIndex;
  readonly fares: FareManager;
  readonly skids: SkidMarks;
  readonly trails: DriftTrails;
  readonly lampGlow: LampGlow;
  readonly minimap: Minimap;
};

export type WorldLoadResult = {
  readonly city: CityModel;
  readonly car: Car;
  readonly spawn: WorldSpawn;
  readonly skinId: string;
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
  readonly setLoading: (progress: number, label?: string) => void;
  /** CSS-driven glide for stages that block the main thread. */
  readonly glideLoading: (progress: number, seconds: number, label?: string) => void;
  readonly hideLoading: () => void;
  readonly showTitle: () => void;
  readonly setStage: (label: string) => void;
  readonly computeSpawn: (city: CityModel) => WorldSpawn;
  readonly snapToCar: (car: Car) => void;
  readonly setupGarages: (city: CityModel) => void;
  readonly remoteSay: (anchor: THREE.Object3D, text: string) => void;
  readonly getRenderer: () => THREE.WebGLRenderer | null;
  readonly getCamera: () => THREE.Camera;
  /** Mobile sun: warm its shadowless floor tier too. Null keeps one pass. */
  readonly shadowlessWarmup: THREE.DirectionalLight | null;
  readonly onCoreSystems: (systems: WorldCoreSystems) => void;
  readonly onRemoteCars: (remoteCars: RemoteCars) => void;
  readonly onPhysics: (physics: PhysicsWorld) => void;
  readonly onTraffic: (traffic: Traffic) => void;
  readonly onParked: (parked: ParkedCars) => void;
  readonly onDebris: (debris: Debris) => void;
  readonly onCones: (cones: SmashCones) => void;
  /** Attach world-dependent actors and lighting before shader warmup. */
  readonly onAmbient: (ambient: AmbientLife, city: CityModel) => void;
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

function fromWorker(r: ParcelWorkerResponse): ParcelPlanResult {
  return { plans: r.plans, lots: r.lots, stats: r.stats, covered: new Set(r.covered) };
}

/** The worker's plan, or the decoded source for the city to plan from itself. */
type ParcelResolved = {
  readonly plan: ParcelPlanResult | null;
  readonly source: ParcelSource | null;
};

function startGenWorker(): Promise<CityGenPayload | null> {
  if (cityEdited()) return Promise.resolve(null);
  // Repeat visits: the finished world is in IndexedDB — skip generation.
  return readWorldCache().then((cached) => {
    if (cached) return cached;
    return runGenWorker();
  });
}

/**
 * The parcel plan in its worker (world/parcel-worker.ts). Resolves null on
 * any failure and the city plans on the main thread instead.
 */
function runParcelWorker(source: ArrayBuffer): Promise<ParcelPlanResult | null> {
  const bytes = source.byteLength;
  return new Promise((resolve) => {
    try {
      const worker = new Worker(new URL("../world/parcel-worker.ts", import.meta.url), {
        type: "module",
      });
      worker.onmessage = (ev: MessageEvent<ParcelWorkerResponse>) => {
        const r = ev.data;
        console.log(`[parcel-worker] planned ${r.plans.length} parcels in ${r.ms}ms`);
        writeParcelPlanCache(bytes, r);
        resolve(fromWorker(r));
        worker.terminate();
      };
      worker.onerror = (e) => {
        console.log(`[parcel-worker] failed: ${e.message}`);
        resolve(null);
        worker.terminate();
      };
      const req: ParcelWorkerRequest = { source };
      worker.postMessage(req, [source]);
    } catch (e) {
      console.log(`[parcel-worker] unavailable: ${e instanceof Error ? e.message : e}`);
      resolve(null);
    }
  });
}

function runGenWorker(): Promise<CityGenPayload | null> {
  return new Promise((resolve) => {
    try {
      const worker = new Worker(new URL("../world/gen-worker.ts", import.meta.url), {
        type: "module",
      });
      // A bake needs the worker payload to export world.bin. Under CPU load
      // its pure geometry pass can exceed the interactive fallback deadline.
      const timeout = new URLSearchParams(window.location.search).has("bake") ? 900000 : 90000;
      const bail = setTimeout(() => {
        worker.terminate();
        resolve(null);
      }, timeout);
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
  // Fetch terrain and city dressing concurrently. The complete-scene loading
  // gate waits for both; failures fall back to the worker + IndexedDB path.
  const bakedWorldPromise = skipBaked ? Promise.resolve(null) : fetchBakedWorld();
  const bakedRestPromise = skipBaked ? Promise.resolve(null) : fetchBakedRest();
  // The parcel source is an INPUT to the city, not a baked output: every
  // path fetches it, bake mode included. The plan starts in its worker the
  // moment the bytes land — it assembles its own reservation — so it runs
  // alongside the model download.
  // An edited city has a grid-derived network the worker does not have and
  // plans itself, later, from the decoded source.
  const parcelPromise: Promise<ParcelResolved> = fetchParcelSource().then(async (bytes) => {
    if (!bytes) return { plan: null, source: null };
    if (edited) return { plan: null, source: decodeParcelSource(bytes) };
    // A revisit has the plan already (world-cache.ts): the same build, rev
    // and source bytes, so the worker would compute the identical result.
    const cached = await readParcelPlanCache(bytes.byteLength);
    if (cached) {
      console.log(`[parcel-worker] plan from cache: ${cached.plans.length} parcels`);
      return { plan: fromWorker(cached), source: null };
    }
    // Decode a copy for the fallback before the buffer is transferred away.
    const copy = bytes.slice(0);
    const plan = await runParcelWorker(bytes);
    return { plan, source: plan ? null : decodeParcelSource(copy) };
  });
  const genPromise = bakedWorldPromise.then((baked) => baked ?? startGenWorker());
  const restState: RestState = { fromBake: false };
  const restPromise = bakedRestPromise.then((baked) => {
    if (baked) restState.fromBake = true;
    return baked ? baked : edited ? null : readRestCache();
  });
  // Two-stage preload overlaps the small player/terrain set with the rest
  // of the city. The loading screen stays up until the complete scene is
  // ready, so the title never pans across temporarily empty city blocks.
  // Stage budget. The old split gave 0-70% to the ~200KB early model set and
  // left 70-84% for the city, so on a cold mobile load the bar sat at nothing
  // through the bundle, snapped to 70 when five small GLBs resolved together,
  // then crawled — motion in inverse proportion to the work. These track how
  // long each stage actually takes on a throttled first visit.
  const MODELS_TO = 0.26;
  const WORLD_TO = 0.46;
  await deps.cache.preload(earlyModelUrls(), (frac) => {
    deps.setLoading(0.14 + frac * (MODELS_TO - 0.14), "Loading models…");
  });
  const latePreload = deps.cache.preload(lateModelUrls(), () => {});
  // This stage decodes the world on the main thread, so a setInterval crawl
  // stops firing exactly when it is needed and the bar freezes. Hand the
  // motion to CSS instead — it survives the block.
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
  // Only the equipped body — the other operators stay unfetched until the
  // player rolls onto a garage forecourt.
  await deps.cache.ensure(skinModelUrl(skin));
  const car = new Car(deps.cache, skinId);
  car.setSurface(city);
  deps.scene.add(car.object3D);
  car.reset(spawn.x, spawn.z, spawn.yaw);

  // Publish the world early so its streaming and camera can settle while
  // the loading screen covers geometry uploads and physics preparation.
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
    restState,
  );
  return {
    city,
    car,
    spawn,
    skinId,
    ready,
  };
}

// Everything required by the first playable frame: buildings, furniture,
// physics and traffic. The title is revealed only after this gate.
async function finishLoad(
  deps: WorldLoaderDeps,
  city: CityModel,
  car: Car,
  spawn: WorldSpawn,
  restPromise: Promise<CityRestPayload | null>,
  parcelPromise: Promise<ParcelResolved>,
  latePreload: Promise<void>,
  bakePayload: CityGenPayload | null,
  restState: RestState,
): Promise<void> {
  const paint = (): Promise<void> =>
    new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
  deps.setStage("DOWNLOADING THE CITY…");
  deps.glideLoading(0.64, 12, "Building San Francisco…");
  const [rest, parcels] = await Promise.all([restPromise, parcelPromise, latePreload]);
  city.setRestPayload(rest);
  city.setParcelPlan(parcels.plan);
  city.setParcelSource(parcels.source);
  let lastPct = -1;
  await city.initLate((f) => {
    const pct = Math.min(99, Math.round(f * 100));
    if (pct !== lastPct) {
      lastPct = pct;
      deps.setStage(`FINISHING THE CITY… ${pct}%`);
      deps.setLoading(0.64 + f * 0.2, "Building San Francisco…");
    }
  });
  // Static city built: freeze its matrices (editor sessions keep them live
  // so props/streets can be rebuilt and dragged).
  if (!editorMode()) city.freezeStatic();

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
  // Downtown's mast luminaires come from the batch records — the baked
  // payload on the deployed path, the live capture on the generated/editor
  // path — and must register before attachNightAndLife drains the beacons.
  const propItems = rest?.batchItems ?? city.restCapture?.batchItems;
  if (propItems) registerStreetLuminaires(propItems);
  const minimap = new Minimap(city.plan, city.getDecks());
  deps.onCoreSystems({ solidIndex, fares, skids, trails, lampGlow, minimap });

  await paint();

  // Physics and local actors must exist before driving starts. Otherwise
  // the first route can acquire parked cars and solid walls mid-drive.
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
  const deckFloor = surfaceDeckPhysics(city.getDecks());
  if (deckFloor.length > 0) physics.addStaticTrimesh(deckFloor);
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
  deps.setLoading(0.91, "Preparing your ride…");
  if (new URLSearchParams(window.location.search).has("tune")) {
    // Optional dev tooling: a failed chunk fetch degrades to no-panel rather
    // than blocking boot. (The ?bake import below stays loud on purpose.)
    try {
      const { mountTunePanel } = await import("../vehicle/tune-panel");
      mountTunePanel(vehicle);
    } catch (e) {
      console.error("[tune] panel failed to load:", e);
    }
  }
  await paint();

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

  physics.addStaticSolids(city.solids, city.terrain);
  // Seed the first resident set at the spawn NOW so the initial insert burst
  // (+ its BVH incorporation) lands during load, not on a live frame.
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
  deps.onAmbient(ambient, city);
  lap("debris+cones");

  // Prewarm the complete first scene, including traffic and parked cars.
  // KHR_parallel_shader_compile keeps compilation off the first driving frame.
  deps.setStage("WARMING UP…");
  deps.setLoading(0.97, "Almost ready…");
  await paint();
  const renderer = deps.getRenderer();
  if (renderer) {
    const sun = deps.shadowlessWarmup;
    const originalCastShadow = sun?.castShadow ?? false;
    try {
      if (sun) sun.castShadow = true;
      await renderer.compileAsync(deps.scene, deps.getCamera());
      if (sun) {
        // The phone floor tier removes this light from Three's shadow list.
        // Keep shadowMap.enabled/type intact: disabling the renderer's map
        // alone does not compile the same directional-shadow-count variant.
        sun.castShadow = false;
        await renderer.compileAsync(deps.scene, deps.getCamera());
      }
    } catch {
      // A failed prewarm just means compiles happen on first render.
    } finally {
      if (sun) {
        sun.castShadow = originalCastShadow;
        // Frames rendered during the async shadowless compile skipped the
        // depth pass; refresh it even if the governor has a slower cadence.
        if (originalCastShadow) renderer.shadowMap.needsUpdate = true;
      }
    }
  }

  // ?bake=1: download the two world artifacts (gzipped) for public/world/.
  // Run on a COLD dev build so the capture reflects the current pipeline.
  // Machinery lives in world/bake-download.ts, lazy-loaded behind the param.
  if (new URLSearchParams(window.location.search).has("bake")) {
    const { downloadWorldArtifacts } = await import("../world/bake-download");
    await downloadWorldArtifacts(bakePayload, city.restCapture);
  }
  deps.setLoading(1, "Ready to drive");
  deps.showTitle();
  deps.onPlayable();
  deps.hideLoading();
}

function storageGet(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}
