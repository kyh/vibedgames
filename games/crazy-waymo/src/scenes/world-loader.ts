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
import { RemoteCars } from "../net/remote-cars";
import { PhysicsWorld } from "../physics/physics-world";
import { Rng } from "../shared/rng";
import { Car, skinById, skinModelUrl } from "../vehicle/car";
import { RaycastVehicle } from "../vehicle/raycast-vehicle";
import { CityModel, tileHoldRadius } from "../world/city";
import { safeMode } from "../render/safe-mode";
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

/** The built city, from whichever source answered: the baked meta (its
 *  tiles stream separately), the IndexedDB rest cache of a cold gen, or
 *  neither (generate). */
interface RestSource {
  readonly meta: CityRestMeta | null;
  readonly rest: CityRestPayload | null;
}

// The title waits for the tiles this close to the spawn. A phone downloads
// its neighbourhood and lets the rest stream in behind the title (the fog
// hides most of it); a desktop pipe takes everything in draw range up front.
// A phone gates on a fixed ring around the spawn; safe mode shrinks it with
// the rest of the reach so the title frame is smaller too.
const gateRadius = (): number =>
  isCoarsePointer()
    ? Math.round(480 * (safeMode() ? SAFE_REACH / PHONE_REACH : 1))
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
}

// Kick the city-gen worker. Returns null (main-thread gen) when the city has
// street/floor edits — local overrides live in localStorage, which the worker
// cannot see — or when the worker fails for any reason.
const cityEdited = (): boolean => {
  // A runtime map file replaces the world outright — never mix with baked
  // artifacts or caches. Baked CUSTOM_MAP edits are module constants.
  if (getRuntimeMap()) {
    return true;
  }
  const local = loadLocalOverrides();
  return (
    editorMode() && (local.add.length > 0 || local.remove.length > 0 || local.floor.length > 0)
  );
};

// Cache writes serialize large object graphs on the main thread. Never during
// load; a browser without requestIdleCallback gets a plain delay instead.
const runWhenIdle = (task: () => void): void => {
  if ("requestIdleCallback" in window) {
    requestIdleCallback(task, { timeout: 30_000 });
  } else {
    setTimeout(task, 8000);
  }
};

// Work that must not land inside the load at all — an idle deadline can
// still expire mid-build on a slow phone. Queued until the loading veil
// drops, then handed to idle time. `hideLoading` only STARTS the veil's
// 350 ms fade, and the title's first frames follow it; an idle slot between
// those frames would still take a multi-second put(), so the hand-off waits
// out the transition first.
const AFTER_VEIL_MS = 1500;
let loadFinished = false;
const afterLoad: (() => void)[] = [];
const runAfterLoad = (task: () => void): void => {
  if (loadFinished) {
    runWhenIdle(task);
  } else {
    afterLoad.push(task);
  }
};
const flushAfterLoad = (): void => {
  const queued = afterLoad.splice(0);
  setTimeout(() => {
    loadFinished = true;
    for (const task of queued) {
      runWhenIdle(task);
    }
  }, AFTER_VEIL_MS);
};

const fromWorker = (r: ParcelWorkerResponse): ParcelPlanResult => ({
  covered: new Set(r.covered),
  lots: r.lots,
  plans: r.plans,
  stats: r.stats,
});

/** The worker's plan, or the decoded source for the city to plan from itself. */
interface ParcelResolved {
  readonly plan: ParcelPlanResult | null;
  readonly source: ParcelSource | null;
}

const runGenWorker = (): Promise<CityGenPayload | null> =>
  // oxlint-disable-next-line promise/avoid-new -- wraps the gen worker's message/error callbacks
  new Promise((resolve) => {
    try {
      const worker = new Worker(new URL("../world/gen-worker.ts", import.meta.url), {
        type: "module",
      });
      // A bake needs the worker payload to export world.bin. Under CPU load
      // its pure geometry pass can exceed the interactive fallback deadline.
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

const startGenWorker = (): Promise<CityGenPayload | null> => {
  if (cityEdited()) {
    return Promise.resolve(null);
  }
  // Repeat visits: the finished world is in IndexedDB — skip generation.
  return readWorldCache().then((cached) => {
    if (cached) {
      return cached;
    }
    return runGenWorker();
  });
};

/**
 * The parcel plan in its worker (world/parcel-worker.ts). Resolves null on
 * any failure and the city plans on the main thread instead.
 */
const runParcelWorker = (source: ArrayBuffer): Promise<ParcelPlanResult | null> => {
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
        // The put() serializes ~500k plan objects on the main thread — a
        // multi-second block on a phone if it lands mid-load. After load,
        // in idle time only.
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

/** An edited city has a grid-derived network the worker does not have, so it
 *  gets the decoded source and plans itself later. */
const resolveParcels = async (
  metaPromise: Promise<CityRestMeta | null>,
  edited: boolean,
): Promise<ParcelResolved> => {
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
  // A revisit has the plan already (world-cache.ts): the same build, rev
  // and source bytes, so the worker would compute the identical result.
  const cached = await readParcelPlanCache(bytes.byteLength);
  if (cached) {
    console.log(`[parcel-worker] plan from cache: ${cached.plans.length} parcels`);
    return { plan: fromWorker(cached), source: null };
  }
  // Decode a copy for the fallback before the buffer is transferred away.
  // oxlint-disable-next-line unicorn/prefer-spread -- ArrayBuffer#slice copies the buffer; spreading it is not the same operation
  const copy = bytes.slice(0);
  const plan = await runParcelWorker(bytes);
  return { plan, source: plan ? null : decodeParcelSource(copy) };
};

const resolveGen = async (
  bakedWorldPromise: Promise<CityGenPayload | null>,
): Promise<CityGenPayload | null> => (await bakedWorldPromise) ?? startGenWorker();

const resolveRest = async (
  metaPromise: Promise<CityRestMeta | null>,
  edited: boolean,
): Promise<RestSource> => {
  const meta = await metaPromise;
  if (meta) {
    return { meta, rest: null };
  }
  return { meta: null, rest: edited ? null : await readRestCache() };
};

const paint = (): Promise<void> =>
  // oxlint-disable-next-line promise/avoid-new -- wraps the requestAnimationFrame + setTimeout callbacks
  new Promise((resolve) => {
    requestAnimationFrame(() => setTimeout(resolve, 0));
  });

const warmupShaders = async (deps: WorldLoaderDeps): Promise<void> => {
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
      if (originalCastShadow) {
        renderer.shadowMap.needsUpdate = true;
      }
    }
  }
};

// Everything required by the first playable frame: buildings, furniture,
// physics and traffic. The title is revealed only after this gate.
const finishLoad = async (
  deps: WorldLoaderDeps,
  city: CityModel,
  car: Car,
  spawn: WorldSpawn,
  restPromise: Promise<RestSource>,
  parcelPromise: Promise<ParcelResolved>,
  latePreload: Promise<void>,
  bakePayload: CityGenPayload | null,
): Promise<void> => {
  deps.setStage("DOWNLOADING THE CITY…");
  deps.glideLoading(0.64, 12, "Building San Francisco…");
  const [{ meta, rest }, parcels] = await Promise.all([restPromise, parcelPromise, latePreload]);
  city.setRestMeta(meta);
  city.setRestPayload(rest);
  city.setParcelPlan(parcels.plan);
  city.setParcelSource(parcels.source);
  // The baked path spends its time downloading tiles, the generated one
  // building; the bar splits the same span between them either way.
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
  // Static city built: freeze its matrices (editor sessions keep them live
  // so props/streets can be rebuilt and dragged).
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
  // Downtown's mast luminaires come from the batch records — the baked
  // payload on the deployed path, the live capture on the generated/editor
  // path — and must register before attachNightAndLife drains the beacons.
  const propItems = meta?.batchItems ?? rest?.batchItems ?? city.restCapture?.batchItems;
  if (propItems) {
    registerStreetLuminaires(propItems);
  }
  const minimap = new Minimap(city.plan, city.getDecks());
  deps.onCoreSystems({ fares, lampGlow, minimap, skids, solidIndex, trails });

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
  if (deckFloor.length > 0) {
    physics.addStaticTrimesh(deckFloor);
  }
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
    } catch (error) {
      console.error("[tune] panel failed to load:", error);
    }
  }
  await paint();

  // The rest-cache write serializes ~100MB — idle time only, never at start.
  if (city.restCapture && !meta) {
    const { restCapture } = city;
    runWhenIdle(() => writeRestCache(restCapture));
  }
  await paint();

  physics.addStaticSolids(city.solids, city.terrain);
  // The parcel walls ride their world tiles: whatever is resident now, and
  // every tile that streams in or out from here on.
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
  await warmupShaders(deps);

  // ?bake=1: download the two world artifacts (gzipped) for public/world/.
  // Run on a COLD dev build so the capture reflects the current pipeline.
  // Machinery lives in world/bake-download.ts, lazy-loaded behind the param.
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

const storageGet = (key: string): string | null => {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
};

export const loadWorld = async (deps: WorldLoaderDeps): Promise<WorldLoadResult> => {
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
    } catch (error) {
      console.log(`[map] ${mapUrl} failed: ${error instanceof Error ? error.message : error}`);
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
  const metaPromise: Promise<CityRestMeta | null> = skipBaked
    ? Promise.resolve(null)
    : fetchWorldMeta();
  // The baked tiles carry the parcel plan; only a city that plans itself —
  // edited, baking, or a cold fallback with no usable bins — needs the
  // source. The plan then starts in its worker the moment the bytes land
  // (it assembles its own reservation), alongside the model download.
  const parcelPromise = resolveParcels(metaPromise, edited);
  const genPromise = resolveGen(bakedWorldPromise);
  const restPromise = resolveRest(metaPromise, edited);
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
  const latePreload = deps.cache.preload(lateModelUrls(), () => {
    /* empty */
  });
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
  );
  return {
    car,
    city,
    ready,
    skinId,
    spawn,
  };
};
