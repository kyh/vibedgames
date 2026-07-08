import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";

import type { ModelCache } from "../assets/loader";
import {
  BUILDINGS_COMMERCIAL,
  BUILDINGS_INDUSTRIAL,
  BUILDINGS_SKYSCRAPER,
  BUILDINGS_SUBURBAN,
  modelUrl,
  TREE_LARGE,
  TREE_SMALL,
  GARAGE_MODEL,
} from "../assets/manifest";
import {
  CHUNK,
  CITY_SEED,
  DRAW_DISTANCE,
  GRID_X,
  GRID_Z,
  ROAD_TILE,
  WORLD_H,
  WORLD_HALF_X,
  WORLD_HALF_Z,
  WORLD_W,
} from "../shared/constants";
import { Rng } from "../shared/rng";
import { type Dir, DIR_DELTA, E, N, S, W } from "../shared/types";
import { toFloat32Attributes } from "./conform";
import { activeMapProps } from "./map-file";
import { buildFurniture, type LampHead, type ParkedSpec } from "./furniture";
import { buildGoldenGate } from "./golden-gate";
import { RoadNetwork } from "./network";
import { type CityPlan, generateCity } from "./grid";
import { CUSTOM_MAP, editorMode, loadLocalOverrides } from "./custom-map";
import { isParkCell, makeGroundColorAt, makeGroundOffset, parkCellHeight } from "./ground";
import { buildGridNetwork } from "./grid-network";
import { SF_BUILDINGS, SF_BUILDINGS_BOUNDS } from "./sf-buildings";
import { buildRoads, ROAD_MATERIALS, roadPartsToMeshes } from "./roads";
import type { CityGenPayload } from "./gen-worker";
import { buildLandmarks, landmarkProtection } from "./landmarks";
import { type DistrictChar, districtAt, isLandCell, makeTerrain, paletteFor, tintAmountFor } from "./sf-map";
import type { Terrain } from "./terrain";

export type Solid = {
  readonly minX: number;
  readonly maxX: number;
  readonly minZ: number;
  readonly maxZ: number;
  // World-space top of the obstacle, when it CAN be jumped over (traffic).
  // Absent = infinitely tall (buildings, walls).
  readonly maxY?: number;
  // Rotation about the box CENTRE (three.js rotation.y convention). min/max
  // describe the UNROTATED box; consumers (car collision, camera clip,
  // physics) transform into the box's local frame. Absent = axis-aligned.
  readonly yaw?: number;
  // Skip the Rapier static collider (car/camera still collide). Used for the
  // thousands of tree trunks — punted debris passing through a tree is
  // invisible; ten thousand extra broadphase boxes is not.
  readonly noBody?: boolean;
};

export type RoadCell = { readonly gx: number; readonly gz: number };

const HALF_PI = Math.PI / 2;

// Building front faces +Z in the native model; this offset rotates it to face
// the street. Tune if entrances point the wrong way.
const HALF_PI_CITY = Math.PI / 2;
const BUILDING_FRONT_OFFSET = Math.PI;
// Hillside foundations: concrete plinth under buildings on a grade.
const PLINTH_GEO = new THREE.BoxGeometry(1, 1, 1);
const PLINTH_MAT = new THREE.MeshStandardMaterial({ color: 0xb3aca0, roughness: 1 });

function dirToYaw(d: Dir): number {
  // Yaw that points "toward" the given grid direction (about +Y).
  switch (d) {
    case N:
      return Math.PI;
    case S:
      return 0;
    case E:
      return -HALF_PI;
    case W:
      return HALF_PI;
    default:
      return 0;
  }
}

// A streamed tile of static city geometry: its own merged meshes under one
// group, tagged with a centre + cull radius so it can be hidden when far away.
type MatRec = {
  color: number;
  roughness: number;
  metalness: number;
  vertexColors: boolean;
  polygonOffset: boolean;
  polygonOffsetFactor: number;
  polygonOffsetUnits: number;
  transparent: boolean;
  opacity: number;
};
export type MergedChunkRec = {
  cx: number;
  cz: number;
  dist: number;
  position: Float32Array;
  normal: Float32Array | null;
  uv: Float32Array | null;
  color: Float32Array | null;
  index: Uint16Array | Uint32Array | null;
  mat: MatRec;
  srcMat: { url: string; idx: number } | null;
};
export type BatchItemRec = {
  url: string | null; // GLB source ref…
  idx: number;
  raw: number | null; // …or an index into rawGeos
  m: Float32Array; // 16 elements
  tint: number | null;
  big: boolean;
};
export type RawGeoRec = {
  position: Float32Array;
  normal: Float32Array | null;
  uv: Float32Array | null;
  index: Uint16Array | Uint32Array | null;
  mat: MatRec;
};
export type CityRestPayload = {
  mergedChunks: MergedChunkRec[];
  rawGeos: RawGeoRec[];
  batchItems: BatchItemRec[];
  solids: Solid[];
  parkedCars: ParkedSpec[];
  lampHeads: LampHead[];
  decks: readonly SurfaceDeck[];
};

type BatchBucket = {
  material: THREE.Material;
  geoVerts: Map<THREE.BufferGeometry, number>;
  items: { geo: THREE.BufferGeometry; matrix: THREE.Matrix4; tint?: THREE.Color; src?: { url: string; idx: number } }[];
  verts: number;
  indices: number;
};

type Chunk = { cx: number; cz: number; radius: number; dist: number; group: THREE.Object3D };

// Batched-instance streaming scratch (per-frame, allocation-free).
const NEAR_ALWAYS = 170; // chunks this close are always on (off-screen shadow casters)
const DETAIL_DISTANCE = 360; // trees/cars/props cull here; buildings at DRAW_DISTANCE
const BIG_SILHOUETTE_H = 13; // world-space HEIGHT that counts as skyline
const SCRATCH_SCALE = new THREE.Vector3();
const STREAM_MAT = new THREE.Matrix4();
const STREAM_FRUSTUM = new THREE.Frustum();
const STREAM_SPHERE = new THREE.Sphere();

// A robotaxi garage: the depot building plus the drive-in pad in front where
// the skin-swap UI opens. Spots are derived deterministically from the plan,
// so BOTH the generated and the baked-artifact boot paths agree on them.
export type Garage = { x: number; z: number; yaw: number; padX: number; padZ: number };

const GARAGE_COUNT = 7;
const GARAGE_MIN_DIST = 350;

function pickGarageSpots(plan: CityPlan, terrain: Terrain): Garage[] {
  const cells = plan.cells;
  const dirs: readonly (readonly [number, number])[] = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ];
  const cellAt = (gx: number, gz: number): string | undefined => cells[gx]?.[gz];
  type Cand = { gx: number; gz: number; dx: number; dz: number };
  const cands: Cand[] = [];
  for (let gx = 4; gx < GRID_X - 4; gx += 2) {
    for (let gz = 4; gz < GRID_Z - 4; gz += 2) {
      if (cellAt(gx, gz) !== "lot") continue;
      for (const [dx, dz] of dirs) {
        if (cellAt(gx + dx, gz + dz) !== "road") continue;
        // depth: the cell behind must be lot too (the depot is deep)
        if (cellAt(gx - dx, gz - dz) !== "lot") continue;
        const wx = (gx + 0.5) * ROAD_TILE - WORLD_HALF_X;
        const wz = (gz + 0.5) * ROAD_TILE - WORLD_HALF_Z;
        const r = ROAD_TILE;
        const hs = [
          terrain.heightAt(wx - r, wz - r),
          terrain.heightAt(wx + r, wz - r),
          terrain.heightAt(wx - r, wz + r),
          terrain.heightAt(wx + r, wz + r),
        ];
        if (Math.max(...hs) - Math.min(...hs) > 1.4) continue; // flat pads only
        cands.push({ gx, gz, dx, dz });
        break;
      }
    }
  }
  // Seeded shuffle, then greedy max-spread accept.
  const rng = new Rng(424242);
  for (let i = cands.length - 1; i > 0; i--) {
    const j = rng.int(i + 1);
    const a = cands[i];
    const b = cands[j];
    if (a && b) {
      cands[i] = b;
      cands[j] = a;
    }
  }
  const picked: Garage[] = [];
  for (const c of cands) {
    if (picked.length >= GARAGE_COUNT) break;
    const wx = (c.gx + 0.5) * ROAD_TILE - WORLD_HALF_X;
    const wz = (c.gz + 0.5) * ROAD_TILE - WORLD_HALF_Z;
    if (picked.some((g) => Math.hypot(g.x - wx, g.z - wz) < GARAGE_MIN_DIST)) continue;
    picked.push({
      x: wx,
      z: wz,
      yaw: Math.atan2(c.dx, c.dz), // model faces +Z — turn it toward the road
      padX: wx + c.dx * ROAD_TILE * 1.15,
      padZ: wz + c.dz * ROAD_TILE * 1.15,
    });
  }
  return picked;
}

export class CityModel {
  readonly group = new THREE.Group();
  readonly solids: Solid[] = [];
  readonly roadCells: RoadCell[] = [];
  plan: CityPlan; // mutable: live street rebuild replaces it
  readonly terrain: Terrain;
  network: RoadNetwork; // vector road graph (rendering/traffic/alignment); live rebuild replaces it
  parkedCarSpecs: readonly ParkedSpec[] = []; // punt-able parked cars (built by furniture)
  readonly garages: readonly Garage[]; // robotaxi skin-swap depots (+ drive-in pads)
  lampHeads: readonly LampHead[] = []; // streetlight glow anchors (night pass)
  private chunks: Chunk[] = [];
  // Global model batches; instances flip visibility by chunk on transitions.
  private batches: { mesh: THREE.BatchedMesh; chunkIds: Uint16Array }[] = [];
  private batchChunkGrid = { nx: 1, nz: 1 };
  private chunkVisible: Uint8Array | null = null;
  // chunk key → [batchIndex, instanceId] pairs, so a chunk transition touches
  // only its own instances (a moving camera transitions chunks every frame).
  // Two tiers: big silhouettes (buildings) draw to the fog line; detail
  // (trees, parked cars, props) only needs DETAIL_DISTANCE — the far city
  // stays a skyline instead of 36k full-detail instances.
  private chunkInstancesFar = new Map<number, [number, number][]>();
  private chunkInstancesNear = new Map<number, [number, number][]>();
  private imposterInstances = new Map<number, number[]>();
  private imposterMesh: THREE.BatchedMesh | null = null;
  private imposterVisible: Uint8Array | null = null;
  // City-rest cache: everything phases 2+3 produce, in serializable form.
  restCapture: CityRestPayload | null = null;
  private capturedMerged: MergedChunkRec[] = [];
  private restItems: BatchItemRec[] = [];
  private restComplete = true;
  private rawGeos: RawGeoRec[] = [];
  private rawGeoIds = new Map<string, number>();
  private restSkipLogged = new Set<string>();

  private captureMerged(mesh: THREE.Mesh, cx: number, cz: number, dist: number): void {
    const geo = mesh.geometry;
    const mat = mesh.material;
    if (Array.isArray(mat) || !(mat instanceof THREE.MeshStandardMaterial)) return;
    const srcMat =
      (mesh.userData.srcMat as { url: string; idx: number } | undefined) ??
      (mat.map ? this.cache.srcOfMaterial(mat) : null);
    if (mat.map && !srcMat) {
      // Textured material with no source ref can't survive serialization.
      this.restComplete = false;
      if (!this.restSkipLogged.has(mat.uuid)) {
        this.restSkipLogged.add(mat.uuid);
        console.log(`[city] merged mesh untagged texture: ${mat.name || mat.uuid}`);
      }
      return;
    }
    const pos = geo.getAttribute("position");
    if (!pos) return;
    const nor = geo.getAttribute("normal");
    const uv = geo.getAttribute("uv");
    const col = geo.getAttribute("color");
    this.capturedMerged.push({
      cx,
      cz,
      dist,
      position: pos.array as Float32Array,
      normal: nor ? (nor.array as Float32Array) : null,
      uv: uv ? (uv.array as Float32Array) : null,
      color: col ? (col.array as Float32Array) : null,
      index: geo.index ? (geo.index.array as Uint16Array | Uint32Array) : null,
      mat: {
        color: mat.color.getHex(),
        roughness: mat.roughness,
        metalness: mat.metalness,
        vertexColors: mat.vertexColors,
        polygonOffset: mat.polygonOffset,
        polygonOffsetFactor: mat.polygonOffsetFactor,
        polygonOffsetUnits: mat.polygonOffsetUnits,
        transparent: mat.transparent,
        opacity: mat.opacity,
      },
      srcMat,
    });
  }
  private chunkVisibleNear: Uint8Array | null = null;

  private restPayload: CityRestPayload | null = null;
  private lateRoadFallback: (() => void) | null = null;

  // The rest payload can arrive AFTER construction (it streams behind the
  // title on the baked path) — set before initLate().
  setRestPayload(p: CityRestPayload | null): void {
    this.restPayload = p;
  }

  constructor(
    private cache: ModelCache,
    private genPayload: CityGenPayload | null = null,
    private rng = new Rng(CITY_SEED),
  ) {
    this.terrain = makeTerrain();
    this.plan = generateCity();
    this.garages = pickGarageSpots(this.plan, this.terrain);
    // Pristine cities drive the BAKED VECTOR network — exact OSM centrelines,
    // no raster quantisation, per-class widths, true diagonals and curves.
    // Cities with painted street edits fall back to the grid-derived graph so
    // the editor's changes stay real everywhere (sim + render).
    const local = loadLocalOverrides();
    const streetEdits =
      CUSTOM_MAP.add.length > 0 ||
      CUSTOM_MAP.remove.length > 0 ||
      local.add.length > 0 ||
      local.remove.length > 0;
    if (streetEdits) {
      const gridNet = buildGridNetwork(this.plan, (gx) => this.worldX(gx), (gz) => this.worldZ(gz));
      this.network = new RoadNetwork(gridNet.nodes, gridNet.edges);
    } else {
      this.network = new RoadNetwork();
    }
    // build happens in init() so the loading bar can breathe between phases
  }

  // Live street rebuild (editor): regenerate the plan + grid network from the
  // CURRENT overrides, strip every mesh that uses a road material, and lay
  // fresh roads. Buildings/props stay as-is (the CLEAR brush + reload handle
  // those); terrain street-depressions stay stale, which the drape absorbs.
  rebuildStreetsLive(root: THREE.Object3D): void {
    this.plan = generateCity();
    const gridNet = buildGridNetwork(this.plan, (gx) => this.worldX(gx), (gz) => this.worldZ(gz));
    this.network = new RoadNetwork(gridNet.nodes, gridNet.edges);
    const roadMats = new Set(Object.values(ROAD_MATERIALS));
    const doomed: THREE.Mesh[] = [];
    root.traverse((o) => {
      if (o instanceof THREE.Mesh && o.material instanceof THREE.Material && roadMats.has(o.material)) {
        doomed.push(o);
      }
    });
    for (const m of doomed) {
      m.parent?.remove(m);
      m.geometry.dispose();
    }
    for (const m of buildRoads(this.network, this.terrain)) root.add(m);
  }

  worldX(gx: number): number {
    return (gx + 0.5) * ROAD_TILE - WORLD_HALF_X;
  }
  worldZ(gz: number): number {
    return (gz + 0.5) * ROAD_TILE - WORLD_HALF_Z;
  }
  gridX(x: number): number {
    return Math.floor((x + WORLD_HALF_X) / ROAD_TILE);
  }
  gridZ(z: number): number {
    return Math.floor((z + WORLD_HALF_Z) / ROAD_TILE);
  }

  private poolFor(c: DistrictChar): readonly string[] {
    switch (c) {
      case "downtown":
      case "highrise":
        return this.rng.chance(0.55) ? BUILDINGS_SKYSCRAPER : BUILDINGS_COMMERCIAL;
      case "commercial":
      case "wharf":
        return BUILDINGS_COMMERCIAL;
      case "industrial":
        return BUILDINGS_INDUSTRIAL;
      case "victorian":
      case "residential":
      case "park":
        return BUILDINGS_SUBURBAN;
    }
  }

  private heightScaleFor(c: DistrictChar): number {
    switch (c) {
      case "highrise":
        return 1.6;
      case "downtown":
        return 1.3;
      case "commercial":
        return 1.05;
      case "industrial":
        return 1.0;
      case "park":
        return 1.0;
      case "victorian":
        return 0.9;
      case "residential":
        return 0.85;
      case "wharf":
        return 0.8;
    }
  }

  // District-tinted material clones, cached so tinted buildings still merge.
  // Tint via per-INSTANCE color (BatchedMesh.setColorAt): the batcher
  // multiplies it with the material map exactly like the old cloned-material
  // lerp did for white-based kit materials — and tint variants stop
  // multiplying batch count (and material count).
  private tintNode(node: THREE.Object3D, hex: number, amt: number): void {
    node.traverse((c) => {
      if (c instanceof THREE.Mesh && c.material instanceof THREE.MeshStandardMaterial) {
        c.userData.tint = c.material.color.clone().lerp(new THREE.Color(hex), amt);
      }
    });
  }

  // Build in yielded phases so the loading bar paints during city gen.
  async init(onProgress?: (f: number) => void): Promise<void> {
    await this.initEarly(onProgress);
    await this.initLate(onProgress);
  }

  // Phase 1 only: terrain + streets + network — enough world for the title
  // screen. The heavy passes (buildings, furniture, batching) run in
  // initLate BEHIND the title, so time-to-title is a third of full gen.
  async initEarly(onProgress?: (f: number) => void): Promise<void> {
    const tick = async (f: number): Promise<void> => {
      onProgress?.(f);
      await new Promise((r) => requestAnimationFrame(() => r(undefined)));
    };
    const t0 = performance.now();
    await tick(0.87);
    this.buildPhase1();
    console.log(`[city] phase1 ${Math.round(performance.now() - t0)}ms`);
    await tick(0.95);
  }

  async initLate(onProgress?: (f: number) => void): Promise<void> {
    const tick = async (f: number): Promise<void> => {
      onProgress?.(f);
      await new Promise((r) => requestAnimationFrame(() => r(undefined)));
    };
    if (this.restPayload) {
      const tR = performance.now();
      await this.rebuildRest(this.restPayload);
      console.log(`[city] rest rebuild ${Math.round(performance.now() - tR)}ms`);
      await tick(0.97);
      return;
    }
    this.lateRoadFallback?.();
    const t0 = performance.now();
    await this.phase2();
    const t1 = performance.now();
    await tick(0.9);
    await this.phase3();
    console.log(
      `[city] phase2 ${Math.round(t1 - t0)}ms phase3 ${Math.round(performance.now() - t1)}ms`,
    );
    await tick(0.97);
  }

  private phase2!: () => Promise<void>;
  private phase3!: () => Promise<void>;
  // Yield to the event loop so the title screen stays interactive while the
  // city finishes building behind it.
  private lastBreathe = 0;
  private async breathe(): Promise<void> {
    if (performance.now() - this.lastBreathe < 12) return;
    await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
    this.lastBreathe = performance.now();
  }

  private buildPhase1(): void {
    const staticMeshes: THREE.Mesh[] = [];
    const collect = (obj: THREE.Object3D): void => {
      obj.updateMatrixWorld(true);
      obj.traverse((c) => {
        if (c instanceof THREE.Mesh) staticMeshes.push(c);
      });
    };

    // Large tree trunks are REAL (arcade collision, no physics body) — the
    // taxi bounces off a tree instead of ghosting through the canopy.
    const treeSolid = (tx: number, tz: number): void => {
      const h = 0.55;
      this.solids.push({ minX: tx - h, maxX: tx + h, minZ: tz - h, maxZ: tz + h, noBody: true });
    };

    // Grass patch + scattered trees on a cell (parks + block interiors).
    const placeGreen = (gx: number, gz: number): void => {
      const wx = this.worldX(gx);
      const wz = this.worldZ(gz);
      // The lawn itself is painted by the ground mesh's vertex grading (see
      // colorAt below) — a draped quad per green cell was ~half the map's
      // conform geometry for something vertex colors do for free.
      if (this.rng.chance(0.55)) {
        const count = 1 + this.rng.int(2);
        for (let i = 0; i < count; i++) {
          const large = this.rng.chance(0.6);
          const treeUrl = modelUrl("props", large ? TREE_LARGE : TREE_SMALL);
          const tb = this.cache.bounds(treeUrl);
          const tsc = (ROAD_TILE * 0.42) / Math.max(tb.size.y, 0.001);
          const tree = this.cache.instance(treeUrl);
          tree.scale.setScalar(tsc);
          const tx = wx + this.rng.range(-2.6, 2.6);
          const tz = wz + this.rng.range(-2.6, 2.6);
          tree.position.set(tx, this.terrain.heightAt(tx, tz), tz);
          tree.rotation.y = this.rng.range(0, Math.PI * 2);
          collect(tree);
          if (large) treeSolid(tx, tz);
        }
      }
    };

    // --- Roads: procedural street geometry generated straight from the
    // network graph (world/roads.ts) — asphalt/curbs/sidewalks/markings can
    // never disagree with the connections. ---
    for (let gx = 0; gx < GRID_X; gx++) {
      for (let gz = 0; gz < GRID_Z; gz++) {
        if (this.plan.roads[gx]?.[gz]) this.roadCells.push({ gx, gz });
      }
    }

    const pushRoads = (meshes: THREE.Mesh[]): void => {
      for (const mesh of meshes) {
        mesh.userData.merge = true; // road ribbons are unique conformed buffers
        staticMeshes.push(mesh);
      }
    };
    if (this.genPayload && this.genPayload.roadParts.length > 0) {
      pushRoads(roadPartsToMeshes(this.genPayload.roadParts));
    } else if (!this.genPayload) {
      pushRoads(buildRoads(this.network, this.terrain));
    }
    // Baked world payloads carry no roadParts (rest.bin's merged chunks have
    // the roads). If rest FAILS to arrive, initLate generates them here.
    this.lateRoadFallback = () => {
      if (this.genPayload && this.genPayload.roadParts.length === 0) {
        pushRoads(buildRoads(this.network, this.terrain));
      }
    };

    // --- Landmark footprints: cells the procedural city leaves alone.
    // Editor "clear" cells join the reservation, so every placement pass
    // (buildings, furniture, park tiles) skips them. ---
    const lmBase = landmarkProtection(this.plan);
    const reservedAll = new Set(lmBase.reserved);
    for (const [cgx, cgz] of loadLocalOverrides().clear ?? []) {
      reservedAll.add(`${cgx},${cgz}`);
    }
    // Garages claim their two cells before anything else builds there.
    for (const g of this.garages) {
      const ggx = Math.floor((g.x + WORLD_HALF_X) / ROAD_TILE);
      const ggz = Math.floor((g.z + WORLD_HALF_Z) / ROAD_TILE);
      reservedAll.add(`${ggx},${ggz}`);
    }
    const lm = { ...lmBase, reserved: reservedAll };
    for (const s of lm.solids) this.solids.push(s);
    // The depot buildings themselves (orange roller-door warehouse).
    for (const g of this.garages) {
      const url = modelUrl("buildings", GARAGE_MODEL);
      const node = this.cache.instance(url);
      const b = this.cache.bounds(url);
      const sc = (ROAD_TILE * 0.78) / Math.max(b.size.x, b.size.z, 0.001); // house-sized
      node.scale.setScalar(sc);
      node.rotation.y = g.yaw;
      node.position.set(g.x, this.terrain.heightAt(g.x, g.z), g.z);
      node.updateMatrixWorld(true);
      collect(node);
      const half = ROAD_TILE * 0.42;
      this.solids.push({
        minX: g.x - half,
        maxX: g.x + half,
        minZ: g.z - half,
        maxZ: g.z + half,
      });
    }

    // --- Street alignment (universal): every frontage building projects its
    // lot onto the nearest NETWORK edge — facade parallel to the real street,
    // pulled to a consistent setback. Axis streets come out axis-aligned;
    // diagonals and curves align to their true bearing. ---
    const NUDGE_MAX = 3.0;
    type AvenuePose = { x: number; z: number; yaw: number };
    const avenuePose = (gx: number, gz: number): AvenuePose | null => {
      const cx = this.worldX(gx);
      const cz = this.worldZ(gz);
      const hit = this.network.nearest(cx, cz, ROAD_TILE * 1.6);
      if (!hit) return null;
      // Facade normal: edge perpendicular pointing at the lot.
      let nx = -hit.tz;
      let nz = hit.tx;
      if (nx * (cx - hit.x) + nz * (cz - hit.z) < 0) {
        nx = -nx;
        nz = -nz;
      }
      // Front of the building looks back at the street (−n).
      const yaw = Math.atan2(-nx, -nz);
      // Facade centre sits at a consistent setback from the centreline; the
      // lot can be pulled at most NUDGE_MAX so neighbours never collide.
      const setback = hit.edge.half + 1.3 + ROAD_TILE * 0.34;
      let ax = hit.x + nx * setback;
      let az = hit.z + nz * setback;
      const mx = ax - cx;
      const mz = az - cz;
      const ml = Math.hypot(mx, mz);
      if (ml > NUDGE_MAX) {
        ax = cx + (mx / ml) * NUDGE_MAX;
        az = cz + (mz / ml) * NUDGE_MAX;
      }
      return { x: ax, z: az, yaw };
    };

    // One building on a lot cell: pool/palette by district, seated on the
    // hill's high corner with a plinth, solid footprint. `footprint` is the
    // target size as a fraction of the tile; frontage rows run larger than
    // block-interior infill. Avenue-frontage lots pass a pose (rotated to the
    // spine + setback). Returns false when the grade is too steep (the lot
    // goes green instead).
    // Coarse occupancy hash: one entry per placed building (circle approx).
    const placedHash = new Map<string, { x: number; z: number; r: number }[]>();
    const OCC = 26;
    const occKey = (x: number, z: number): string => `${Math.floor(x / OCC)},${Math.floor(z / OCC)}`;
    const occupied = (x: number, z: number, r: number): boolean => {
      const bx = Math.floor(x / OCC);
      const bz = Math.floor(z / OCC);
      for (let ix = bx - 1; ix <= bx + 1; ix++) {
        for (let iz = bz - 1; iz <= bz + 1; iz++) {
          for (const o of placedHash.get(`${ix},${iz}`) ?? []) {
            if (Math.hypot(o.x - x, o.z - z) < o.r + r) return true;
          }
        }
      }
      return false;
    };
    const occupy = (x: number, z: number, r: number): void => {
      const k = occKey(x, z);
      const arr = placedHash.get(k) ?? [];
      arr.push({ x, z, r });
      placedHash.set(k, arr);
    };

    const placeBuilding = (
      gx: number,
      gz: number,
      faceDir: Dir,
      footprintFrac: number,
      dressing: boolean, // rooftop towers + curbside trees (frontage only)
      pose: AvenuePose | null = null,
    ): boolean => {
      const district = districtAt(gx, gz);
      const wx = pose ? pose.x : this.worldX(gx);
      const wz = pose ? pose.z : this.worldZ(gz);
      if (occupied(wx, wz, ROAD_TILE * footprintFrac * 0.45)) return false;
      const key = this.rng.pick(this.poolFor(district.character));
      const url = modelUrl("buildings", key);
      const bounds = this.cache.bounds(url);
      const footprint = Math.max(bounds.size.x, bounds.size.z, 0.001);
      const targetFootprint = ROAD_TILE * footprintFrac;
      const scale = targetFootprint / footprint;
      const node = this.cache.instance(url);
      // Victorians go narrow and tall — the SF row-house silhouette.
      const vict = district.character === "victorian";
      const sxz = scale * (vict ? 0.75 : 1);
      const sy = scale * this.heightScaleFor(district.character) * (vict ? 1.4 : 1);
      node.scale.set(sxz, sy, sxz);
      node.rotation.y = (pose ? pose.yaw : dirToYaw(faceDir)) + BUILDING_FRONT_OFFSET;
      // Buildings stay vertical. Seat at the HIGHEST corner so the hill never
      // cuts through walls; a concrete plinth fills the downhill gap (stilted
      // SF hillside foundations). Extreme grades get greenery instead.
      const fh = targetFootprint / 2;
      const corners = [
        this.terrain.heightAt(wx, wz),
        this.terrain.heightAt(wx - fh, wz - fh),
        this.terrain.heightAt(wx + fh, wz - fh),
        this.terrain.heightAt(wx - fh, wz + fh),
        this.terrain.heightAt(wx + fh, wz + fh),
      ];
      const loY = Math.min(...corners);
      let seatY = Math.max(...corners);
      // Park/landuse-green cells carry a flat terrace TILE seated at the
      // cell's highest corner — a house seated on the raw field there gets
      // buried by its own lawn. Seat on the terrace instead.
      const cgx = this.gridX(wx);
      const cgz = this.gridZ(wz);
      if (isParkCell(cgx, cgz)) {
        seatY = Math.max(seatY, parkCellHeight(this.terrain, cgx, cgz));
      }
      const drop = seatY - loY;
      if (drop > 5) {
        // Too steep to build — real SF leaves these faces green.
        for (let i = 0; i < 3; i++) {
          const steepTreeUrl = modelUrl("props", this.rng.chance(0.5) ? TREE_LARGE : TREE_SMALL);
          const stb = this.cache.bounds(steepTreeUrl);
          const sts = (ROAD_TILE * 0.3) / Math.max(stb.size.y, 0.001);
          const steepTree = this.cache.instance(steepTreeUrl);
          steepTree.scale.setScalar(sts);
          const stx = wx + this.rng.range(-3.5, 3.5);
          const stz = wz + this.rng.range(-3.5, 3.5);
          steepTree.position.set(stx, this.terrain.heightAt(stx, stz), stz);
          steepTree.rotation.y = this.rng.range(0, Math.PI * 2);
          collect(steepTree);
        }
        return false;
      }
      if (drop > 0.7) {
        const plinth = new THREE.Mesh(PLINTH_GEO, PLINTH_MAT);
        const ph = drop + 0.8;
        plinth.scale.set(targetFootprint * 0.98, ph, targetFootprint * 0.98);
        if (pose) plinth.rotation.y = pose.yaw; // follow the rotated building
        plinth.position.set(wx, seatY - 0.1 - ph / 2, wz);
        plinth.updateMatrixWorld(true);
        collect(plinth);
      }
      node.position.set(wx, seatY - 0.15, wz);
      this.tintNode(node, this.rng.pick(paletteFor(district)), tintAmountFor(district));
      collect(node);

      // Solid footprint (a touch smaller than the visual so curbs are
      // forgiving); avenue buildings carry their rotation as an OBB.
      const half = (targetFootprint / 2) * 0.96;
      this.solids.push({
        minX: wx - half,
        maxX: wx + half,
        minZ: wz - half,
        maxZ: wz + half,
        ...(pose ? { yaw: pose.yaw } : {}),
      });
      occupy(wx, wz, targetFootprint * 0.38);

      if (!dressing) return true;

      // Rooftop watertower — the classic city-builder silhouette — on some
      // mid-rise commercial roofs.
      if (
        (district.character === "commercial" || district.character === "downtown") &&
        this.rng.chance(0.09)
      ) {
        const towerUrl = modelUrl("props", "kk-watertower");
        const twb = this.cache.bounds(towerUrl);
        // Actual world-space roof of the placed building — bulletproof against
        // any model origin/height quirk that made towers float.
        node.updateMatrixWorld(true);
        const roofBox = new THREE.Box3().setFromObject(node);
        const roofY = roofBox.max.y;
        const tws = 3.4 / Math.max(twb.size.y, 0.001);
        const tower = this.cache.instance(towerUrl);
        tower.scale.setScalar(tws);
        tower.rotation.y = this.rng.range(0, Math.PI * 2);
        // Dead-centre on the roof so it never reads as hanging off an edge.
        tower.position.set(wx, roofY - 0.15, wz);
        collect(tower);
      }

      // Occasional curbside tree, nudged toward the street.
      if (this.rng.chance(0.3)) {
        const [dx, dz] = DIR_DELTA[faceDir];
        const large = this.rng.chance(0.5);
        const treeUrl = modelUrl("props", large ? TREE_LARGE : TREE_SMALL);
        const tb = this.cache.bounds(treeUrl);
        const ts = (ROAD_TILE * 0.32) / Math.max(tb.size.y, 0.001);
        const tree = this.cache.instance(treeUrl);
        tree.scale.setScalar(ts);
        const tx = wx + dx * ROAD_TILE * 0.46 + this.rng.range(-1, 1);
        const tz = wz + dz * ROAD_TILE * 0.46 + this.rng.range(-1, 1);
        tree.position.set(tx, this.terrain.heightAt(tx, tz), tz);
        tree.rotation.y = this.rng.range(0, Math.PI * 2);
        collect(tree);
        if (large) treeSolid(tx, tz);
      }
      return true;
    };

    // --- Buildings (district-driven pool, palette tint, height) ---
    const inRealData = (x: number, z: number): boolean =>
      x >= SF_BUILDINGS_BOUNDS.minX &&
      x <= SF_BUILDINGS_BOUNDS.maxX &&
      z >= SF_BUILDINGS_BOUNDS.minZ &&
      z <= SF_BUILDINGS_BOUNDS.maxZ;
    for (const b of this.plan.buildingCells) {
      const cellId = `${b.gx},${b.gz}`;
      if (lm.reserved.has(cellId)) continue; // a landmark stands here
      if (districtAt(b.gx, b.gz).character === "park" || lm.parkGreen.has(cellId)) {
        placeGreen(b.gx, b.gz); // park frontage → green, drivable (no solid)
      }
    }

    this.phase2 = async () => {
    // --- REAL downtown buildings: positions, footprints and heights from the
    // licensed SF model (calibrated in tools/sf-data/calibrate-downtown.mjs).
    // Kit models are chosen by height class and stretched to the real
    // footprint — the actual skyline at the actual addresses. ---
    {
      let placed = 0;
      for (const [bx0, bz0, bw, bd, bh] of SF_BUILDINGS) {
        if (placed >= 2600) break;
        if (bh < 1.2 || bw < 2.2 || bd < 2.2) continue;
        let bx = bx0;
        let bz = bz0;
        let fitScale = 1;
        if (!isLandCell(this.gridX(bx), this.gridZ(bz))) continue;
        // Real parcels abut real streets; ours are ~2x wide, so NUDGE the
        // building outward instead of rejecting it.
        const nearHit = this.network.nearest(bx, bz, ROAD_TILE * 1.6);
        if (nearHit) {
          const want = nearHit.edge.half + Math.min(bw, bd) / 2 + 0.4;
          if (nearHit.dist < want) {
            const push = Math.min(want - nearHit.dist, 7);
            const dx = bx - nearHit.x;
            const dz = bz - nearHit.z;
            const dl = Math.hypot(dx, dz) || 1;
            bx += (dx / dl) * push;
            bz += (dz / dl) * push;
            const re = this.network.nearest(bx, bz, ROAD_TILE * 1.6);
            if (re && re.dist < re.edge.half + Math.min(bw, bd) / 2 - 0.6) {
              const maxFit = (re.dist - re.edge.half + 0.6) * 2;
              if (maxFit < Math.max(bw, bd) * 0.45 || maxFit < 3) continue;
              const shrink = maxFit / Math.max(bw, bd);
              // shrink footprint to the block, keep the real height
              // (bw/bd are consts from destructuring — scale via locals)
              fitScale = Math.min(1, shrink);
            }
          }
        }
        if (occupied(bx, bz, Math.max(bw, bd) * 0.45)) continue;
        const pool = bh > 28 ? BUILDINGS_SKYSCRAPER : bh > 9 ? BUILDINGS_COMMERCIAL : BUILDINGS_SUBURBAN;
        const key = this.rng.pick(pool);
        const url = modelUrl("buildings", key);
        const bounds = this.cache.bounds(url);
        const fw = bw * fitScale;
        const fd = bd * fitScale;
        const sxz = Math.max(fw, fd) / Math.max(bounds.size.x, bounds.size.z, 0.001);
        const sy = bh / Math.max(bounds.size.y, 0.001);
        const fh = Math.max(fw, fd) / 2;
        const corners = [
          this.terrain.heightAt(bx, bz),
          this.terrain.heightAt(bx - fh, bz - fh),
          this.terrain.heightAt(bx + fh, bz - fh),
          this.terrain.heightAt(bx - fh, bz + fh),
          this.terrain.heightAt(bx + fh, bz + fh),
        ];
        let seatY = Math.max(...corners);
        if (seatY - Math.min(...corners) > 5) continue;
        // Terrace-aware, same as placeBuilding: don't get buried by park tiles.
        const bgx = this.gridX(bx);
        const bgz = this.gridZ(bz);
        if (isParkCell(bgx, bgz)) {
          seatY = Math.max(seatY, parkCellHeight(this.terrain, bgx, bgz));
        }
        const node = this.cache.instance(url);
        node.scale.set(sxz, sy, sxz);
        node.position.set(bx, seatY - 0.15, bz);
        const district = districtAt(this.gridX(bx), this.gridZ(bz));
        this.tintNode(node, this.rng.pick(paletteFor(district)), tintAmountFor(district));
        collect(node);
        const hw = (fw / 2) * 0.94;
        const hd = (fd / 2) * 0.94;
        this.solids.push({
          minX: bx - hw,
          maxX: bx + hw,
          minZ: bz - hd,
          maxZ: bz + hd,
        });
        occupy(bx, bz, Math.max(fw, fd) * 0.5);
        placed++;
      }
      console.log(`[city] real downtown buildings placed: ${placed}`);
    }

    // --- FRONTAGE ROWS along the network edges: buildings walk each street
    // with a consistent setback, facing the kerb — rows follow diagonals and
    // curves exactly, which cell-based lots never could. ---
    let walkN = 0;
    for (const edge of this.network.edges) {
      if (++walkN % 40 === 0) await this.breathe();
      // Corner buildings are real — the cross-street clearance check below
      // is the guard, so row trims stay small even at wide junctions.
      const trimA = Math.min(this.network.nodeTrim(edge.a) * 0.6 + 1.5, edge.len * 0.4);
      const trimB = Math.min(this.network.nodeTrim(edge.b) * 0.6 + 1.5, edge.len * 0.4);
      if (edge.len - trimA - trimB < 5) continue;
      for (const side of [1, -1] as const) {
        let s = trimA + this.rng.range(0, 4);
        while (s < edge.len - trimB) {
          const smp = this.network.sample(edge, s);
          const gx = this.gridX(smp.x);
          const gz = this.gridZ(smp.z);
          const district = districtAt(gx, gz);
          const dense =
            district.character === "residential" || district.character === "victorian";
          const frac =
            district.character === "downtown" || district.character === "highrise"
              ? this.rng.range(0.7, 0.82)
              : dense
                ? this.rng.range(0.46, 0.56) // row-houses, shoulder to shoulder
                : this.rng.range(0.58, 0.7);
          const footprint = ROAD_TILE * frac;
          // Dense districts: models stack shoulder-to-shoulder (attached SF
          // rows) — a hair of overlap guarantees no light gap between walls.
          const step = dense
            ? footprint * this.rng.range(0.97, 1.0)
            : footprint + this.rng.range(0.6, 1.8);
          const off = edge.half + 1.7 + footprint / 2 + 0.7;
          const px = smp.x - smp.tz * off * side;
          const pz = smp.z + smp.tx * off * side;
          s += step;
          if (district.character === "park") continue;
          if (!isLandCell(this.gridX(px), this.gridZ(pz))) continue;
          if (lm.reserved.has(`${this.gridX(px)},${this.gridZ(pz)}`)) continue;
          if (occupied(px, pz, footprint * 0.42)) continue;
          // Clearance vs OTHER streets (corners, parallel edges): tight
          // downtown blocks fit a SMALLER building rather than none.
          let useFrac = frac;
          const near = this.network.nearest(px, pz, ROAD_TILE * 1.6);
          if (near && near.dist < near.edge.half + footprint / 2 - 0.4) {
            const maxFoot = (near.dist - near.edge.half + 0.4) * 2;
            if (maxFoot < 3.2) continue;
            useFrac = Math.min(frac, maxFoot / ROAD_TILE);
          }
          if (this.rng.chance(0.04)) continue; // rare vacancy
          const yaw = Math.atan2(smp.tx * side, smp.tz * side) + HALF_PI_CITY;
          const cardinal = Math.abs(Math.sin(2 * yaw)) < 0.18;
          placeBuilding(gx, gz, 0, useFrac, cardinal, { x: px, z: pz, yaw });
          // Back row: real SF blocks are packed two-deep, no green gap.
          if (this.rng.chance(0.8)) {
            const off2 = off + footprint + this.rng.range(0.8, 1.8);
            const bx2 = smp.x - smp.tz * off2 * side;
            const bz2 = smp.z + smp.tx * off2 * side;
            if (
              isLandCell(this.gridX(bx2), this.gridZ(bz2)) &&
              districtAt(this.gridX(bx2), this.gridZ(bz2)).character !== "park" &&
              !occupied(bx2, bz2, footprint * 0.52)
            ) {
              const near2 = this.network.nearest(bx2, bz2, ROAD_TILE * 1.6);
              if (!near2 || near2.dist >= near2.edge.half + footprint / 2 - 0.4) {
                placeBuilding(gx, gz, 0, frac * 0.94, false, { x: bx2, z: bz2, yaw });
              }
            }
          }
        }
      }
    }

    // --- Green block interiors: real SF blocks are packed back-to-back, so
    // the row directly behind a frontage gets infill houses (slightly smaller,
    // facing the same street). Deeper cells and parks stay green. ---
    const frontageDirs = new Map<string, Dir>();
    for (const b of this.plan.buildingCells) frontageDirs.set(`${b.gx},${b.gz}`, b.faceDir);
    for (const g of this.plan.greenCells) {
      const cellId = `${g.gx},${g.gz}`;
      if (!lm.reserved.has(cellId) && !lm.parkGreen.has(cellId)) {
        const district = districtAt(g.gx, g.gz);
        if (district.character !== "park") {
          let face: Dir | null = null;
          for (const d of [N, E, S, W] as const) {
            const [dx, dz] = DIR_DELTA[d];
            const f = frontageDirs.get(`${g.gx + dx},${g.gz + dz}`);
            if (f !== undefined) {
              face = f;
              break;
            }
          }
          if (face !== null && this.rng.chance(0.6)) {
            if (placeBuilding(g.gx, g.gz, face, this.rng.range(0.6, 0.74), false)) continue;
          }
        }
      }
      placeGreen(g.gx, g.gz);
    }

    };
    this.phase3 = async () => {
    // --- Street furniture: lights, parked cars, yards, awnings, smokestacks,
    // construction chicanes, park allées, wharf piers + seawall. ---
    const tFurn = performance.now();
    const fr = await buildFurniture({
      plan: this.plan,
      network: this.network,
      terrain: this.terrain,
      cache: this.cache,
      rng: this.rng,
      reserved: lm.reserved,
      worldX: (g) => this.worldX(g),
      worldZ: (g) => this.worldZ(g),
    });
    console.log(`[city] furniture ${Math.round(performance.now() - tFurn)}ms`);
    await this.breathe();
    for (const o of fr.objects) collect(o);
    for (const s of fr.solids) this.solids.push(s);
    this.addDecks(fr.pierDecks);
    this.parkedCarSpecs = fr.parkedCars;
    this.lampHeads = fr.lampHeads;

    // --- The drivable Golden Gate: ramp off the Presidio coast road onto an
    // orange deck over the strait, out to a railed vista turnaround. ---
    const gg = buildGoldenGate({
      plan: this.plan,
      terrain: this.terrain,
      cache: this.cache,
      worldX: (g) => this.worldX(g),
      worldZ: (g) => this.worldZ(g),
    });
    for (const o of gg.objects) collect(o);
    for (const s of gg.solids) this.solids.push(s);
    this.addDecks(gg.decks);

    // --- Shoreline collision: wall off each water cell that borders land so
    // the taxi can reach the waterfront but not drive into the bay. ---
    for (let gx = 0; gx < GRID_X; gx++) {
      for (let gz = 0; gz < GRID_Z; gz++) {
        if (this.plan.cells[gx]?.[gz] !== "water") continue;
        const waterKey = `${gx},${gz}`;
        if (fr.openWaterCells.has(waterKey)) continue; // pier runs out here
        if (gg.openWaterCells.has(waterKey)) continue; // Golden Gate span
        let coastal = false;
        for (const d of [N, E, S, W] as const) {
          const [dx, dz] = DIR_DELTA[d];
          const nb = this.plan.cells[gx + dx]?.[gz + dz];
          if (nb === "road" || nb === "lot") coastal = true;
        }
        if (!coastal) continue;
        const wx = this.worldX(gx);
        const wz = this.worldZ(gz);
        const half = ROAD_TILE * 0.46;
        this.solids.push({ minX: wx - half, maxX: wx + half, minZ: wz - half, maxZ: wz + half });
      }
    }

    // --- Outer border walls (close the south/inland map edge) ---
    const t = 3;
    const LX = WORLD_HALF_X;
    const LZ = WORLD_HALF_Z;
    this.solids.push({ minX: -LX - t, maxX: -LX, minZ: -LZ - t, maxZ: LZ + t }); // west
    this.solids.push({ minX: LX, maxX: LX + t, minZ: -LZ - t, maxZ: LZ + t }); // east
    this.solids.push({ minX: -LX - t, maxX: LX + t, minZ: -LZ - t, maxZ: -LZ }); // north
    this.solids.push({ minX: -LX - t, maxX: LX + t, minZ: LZ, maxZ: LZ + t }); // south

    this.buildGround();


    // --- Hand-placed decorations from the map editor (world/custom-props.ts,
    // this browser's editor props, or a runtime ?map= file) ---
    for (const p of activeMapProps(editorMode())) {
      const parts = p.model.split("/");
      const cat = parts[0];
      const name = parts[1];
      if (!cat || !name) continue;
      const node = this.cache.instance(modelUrl(cat, name));
      node.scale.setScalar(p.s);
      node.rotation.y = p.yaw;
      const x = (p.u - 0.5) * WORLD_W;
      const z = (p.v - 0.5) * WORLD_H;
      node.position.set(x, this.heightAt(x, z), z);
      collect(node);
      if (p.solid) {
        const b = this.cache.bounds(modelUrl(cat, name));
        const hx = (b.size.x * p.s) / 2;
        const hz = (b.size.z * p.s) / 2;
        this.solids.push({ minX: x - hx, maxX: x + hx, minZ: z - hz, maxZ: z + hz });
      }
    }

    // --- Two render paths for the static city ---
    // 1) Unique conformed buffers (roads, drapes; userData.merge): merged by
    //    material into spatial CHUNK tiles the streamer shows/hides.
    // 2) Everything else (buildings, trees, props — repeated models): ONE
    //    global BatchedMesh per (material, attribute layout). Geometry is
    //    uploaded once per unique mesh; placements are 64B matrices. Streaming
    //    is per-instance (setVisibleAt on a slow cadence) — per-chunk batches
    //    would re-copy each model's geometry into every chunk that uses it.
    const nx = Math.ceil(WORLD_W / CHUNK);
    const nz = Math.ceil(WORLD_H / CHUNK);
    const mergeBuckets = new Map<number, THREE.Mesh[]>();
    const batchBuckets = new Map<string, BatchBucket>();
    const centroid = new THREE.Vector3();
    for (const mesh of staticMeshes) {
      if (!(mesh.geometry instanceof THREE.BufferGeometry)) continue;
      const mat = mesh.material;
      if (mesh.userData.merge === true || Array.isArray(mat)) {
        mesh.geometry.computeBoundingBox();
        const bb = mesh.geometry.boundingBox;
        const spanX = bb ? bb.max.x - bb.min.x : 0;
        const spanZ = bb ? bb.max.z - bb.min.z : 0;
        if (!Array.isArray(mat) && Math.max(spanX, spanZ) > CHUNK * 1.5) {
          // Whole-map surface (planar-map asphalt/walk/curb): split by chunk
          // so culling and the rest cache both work per-tile.
          mesh.updateMatrixWorld(true);
          const world = mesh.geometry.clone().applyMatrix4(mesh.matrixWorld);
          for (const [key, g] of splitGeoByChunk(world, nx, nz)) {
            const piece = new THREE.Mesh(g, mat);
            piece.userData.merge = true;
            if (mesh.userData.srcMat) piece.userData.srcMat = mesh.userData.srcMat;
            const list = mergeBuckets.get(key);
            if (list) list.push(piece);
            else mergeBuckets.set(key, [piece]);
          }
          continue;
        }
        bb?.getCenter(centroid);
        centroid.applyMatrix4(mesh.matrixWorld);
        const cx = Math.min(nx - 1, Math.max(0, Math.floor((centroid.x + WORLD_HALF_X) / CHUNK)));
        const cz = Math.min(nz - 1, Math.max(0, Math.floor((centroid.z + WORLD_HALF_Z) / CHUNK)));
        const key = cz * nx + cx;
        const list = mergeBuckets.get(key);
        if (list) list.push(mesh);
        else mergeBuckets.set(key, [mesh]);
        continue;
      }
      // Batches must share an attribute layout — key on material + attrs.
      const geo = mesh.geometry;
      const attrKey = Object.keys(geo.attributes).sort().join(",");
      const bKey = `${mat.uuid}|${attrKey}|${geo.index ? "i" : "n"}`;
      let bucket = batchBuckets.get(bKey);
      if (!bucket) {
        bucket = { material: mat, geoVerts: new Map(), items: [], verts: 0, indices: 0 };
        batchBuckets.set(bKey, bucket);
      }
      if (!bucket.geoVerts.has(geo)) {
        const vCount = geo.attributes.position?.count ?? 0;
        bucket.geoVerts.set(geo, vCount);
        bucket.verts += vCount;
        bucket.indices += geo.index ? geo.index.count : vCount;
      }
      const tint = mesh.userData.tint instanceof THREE.Color ? mesh.userData.tint : undefined;
      const src = mesh.userData.src as { url: string; idx: number } | undefined;
      bucket.items.push({
        geo,
        matrix: mesh.matrixWorld.clone(),
        ...(tint ? { tint } : {}),
        ...(src ? { src } : {}),
      });
    }

    // Chunked merges (roads + drapes). Thin paint (markings, curb lips) is
    // sub-pixel beyond DETAIL_DISTANCE — it culls there instead of the fog line.
    const DETAIL_HEXES = new Set(["dfe3e3", "d8a13c", "d8a23c", "8f938c"]);
    const cullRadius = CHUNK * 0.71 + ROAD_TILE * 2;
    const tMerge = performance.now();
    let mergeN = 0;
    for (const [key, meshes] of mergeBuckets) {
      if (++mergeN % 2 === 0) await this.breathe();
      const cx = key % nx;
      const cz = Math.floor(key / nx);
      const isDetail = (m: THREE.Mesh): boolean => {
        const mat = m.material;
        return !Array.isArray(mat) && "color" in mat
          ? DETAIL_HEXES.has((mat as THREE.MeshStandardMaterial).color.getHexString())
          : false;
      };
      const main = meshes.filter((m) => !isDetail(m));
      const detail = meshes.filter(isDetail);
      const ccx = (cx + 0.5) * CHUNK - WORLD_HALF_X;
      const ccz = (cz + 0.5) * CHUNK - WORLD_HALF_Z;
      if (main.length > 0) {
        const group = new THREE.Group();
        for (const merged of mergeByMaterial(main)) {
          group.add(merged);
          this.captureMerged(merged, ccx, ccz, DRAW_DISTANCE);
        }
        this.group.add(group);
        this.chunks.push({ cx: ccx, cz: ccz, radius: cullRadius, dist: DRAW_DISTANCE, group });
      }
      if (detail.length > 0) {
        const group = new THREE.Group();
        for (const merged of mergeByMaterial(detail)) {
          group.add(merged);
          this.captureMerged(merged, ccx, ccz, DETAIL_DISTANCE);
        }
        this.group.add(group);
        this.chunks.push({ cx: ccx, cz: ccz, radius: cullRadius, dist: DETAIL_DISTANCE, group });
      }
    }

    console.log(`[city] merges ${Math.round(performance.now() - tMerge)}ms`);
    await this.buildBatchesFrom(batchBuckets, nx, nz);

    // --- Iconic landmarks (procedural; kept separate — always visible) ---
    this.group.add(buildLandmarks(this.terrain, this.cache));

    // City-rest cache capture: phases 2+3 output in serializable form. Only
    // stored when every batch item is source-tagged (else a rebuild would
    // drop geometry silently).
    if (this.restComplete) {
      this.restCapture = {
        mergedChunks: this.capturedMerged,
        rawGeos: this.rawGeos,
        batchItems: [...this.restItems],
        solids: this.solids,
        parkedCars: [...this.parkedCarSpecs],
        lampHeads: [...this.lampHeads],
        decks: this.getDecks(),
      };
      console.log(
        `[city] rest capture: ${this.capturedMerged.length} merged, ${this.restItems.length} items`,
      );
    } else {
      console.log("[city] rest capture skipped: untagged batch items");
    }
    };
  }

  // Terrain ground tiles (worker buffers or live gen) — called by phase 3 on
  // cold builds AND by the city-rest rebuild (the rest cache stores merged
  // city geometry, not the ground).
  private buildGround(): void {
    // --- Displaced terrain ground (hills + island; ocean plane sits below),
    // vertex-graded: concrete in the city, Ocean Beach sand along the west
    // shore (half-strength on other shores), park green under the big parks. ---
    const groundMat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      vertexColors: true,
      roughness: 1,
    });
    let ground: THREE.Group;
    if (this.genPayload) {
      ground = new THREE.Group();
      for (const t of this.genPayload.tiles) {
        const geo = new THREE.BufferGeometry();
        geo.setAttribute("position", new THREE.BufferAttribute(t.position, 3));
        if (t.color) geo.setAttribute("color", new THREE.BufferAttribute(t.color, 3));
        if (t.index) geo.setIndex(new THREE.BufferAttribute(t.index, 1));
        if (t.normal) geo.setAttribute("normal", new THREE.BufferAttribute(t.normal, 3));
        else geo.computeVertexNormals(); // baked artifacts ship without normals
        const mesh = new THREE.Mesh(geo, groundMat);
        mesh.position.set(t.x, 0, t.z);
        mesh.rotation.x = -Math.PI / 2;
        mesh.receiveShadow = true;
        mesh.name = "terrain-ground";
        ground.add(mesh);
      }
    } else {
      ground = this.terrain.buildMesh(
        groundMat,
        makeGroundColorAt(this.plan, this.terrain),
        makeGroundOffset(this.network, this.terrain),
      );
    }
    ground.name = "terrain-ground"; // the map editor raycasts against this
    this.group.add(ground);
    // Ground tiles distance-cull like any chunk (half-diagonal as radius).
    for (const tile of ground.children) {
      this.chunks.push({
        cx: tile.position.x,
        cz: tile.position.z,
        radius: 660,
        dist: DRAW_DISTANCE,
        group: tile,
      });
    }

  }

  // Rebuild phases 2+3 from the city-rest cache: merged chunk meshes from
  // raw buffers, model batches from source-tagged records. Skips ALL
  // placement, furniture and merge compute.
  private async rebuildRest(rest: CityRestPayload): Promise<void> {
    const nx = Math.ceil(WORLD_W / CHUNK);
    const nz = Math.ceil(WORLD_H / CHUNK);
    const cullRadius = CHUNK * 0.71 + ROAD_TILE * 2;
    // Merged chunks: dedupe materials by descriptor so draw batching holds.
    const mats = new Map<string, THREE.MeshStandardMaterial>();
    const matFor = (m: MergedChunkRec["mat"]): THREE.MeshStandardMaterial => {
      const k = JSON.stringify(m);
      let mat = mats.get(k);
      if (!mat) {
        mat = new THREE.MeshStandardMaterial({
          color: m.color,
          roughness: m.roughness,
          metalness: m.metalness,
          vertexColors: m.vertexColors,
          polygonOffset: m.polygonOffset,
          polygonOffsetFactor: m.polygonOffsetFactor,
          polygonOffsetUnits: m.polygonOffsetUnits,
          transparent: m.transparent,
          opacity: m.opacity,
        });
        mats.set(k, mat);
      }
      return mat;
    };
    const groups = new Map<string, { group: THREE.Group; cx: number; cz: number; dist: number }>();
    let n = 0;
    for (const rec of rest.mergedChunks) {
      if (++n % 24 === 0) await this.breathe();
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.BufferAttribute(rec.position, 3));
      if (rec.uv) geo.setAttribute("uv", new THREE.BufferAttribute(rec.uv, 2));
      if (rec.color) geo.setAttribute("color", new THREE.BufferAttribute(rec.color, 3));
      if (rec.index) geo.setIndex(new THREE.BufferAttribute(rec.index, 1));
      if (rec.normal) geo.setAttribute("normal", new THREE.BufferAttribute(rec.normal, 3));
      else geo.computeVertexNormals();
      const srcM = rec.srcMat ? this.cache.srcMesh(rec.srcMat.url, rec.srcMat.idx) : null;
      const srcMatOk = srcM && !Array.isArray(srcM.material) ? srcM.material : null;
      const mesh = new THREE.Mesh(geo, srcMatOk ?? matFor(rec.mat));
      mesh.receiveShadow = true;
      const gk = `${rec.cx},${rec.cz},${rec.dist}`;
      let g = groups.get(gk);
      if (!g) {
        g = { group: new THREE.Group(), cx: rec.cx, cz: rec.cz, dist: rec.dist };
        groups.set(gk, g);
      }
      g.group.add(mesh);
    }
    for (const g of groups.values()) {
      this.group.add(g.group);
      this.chunks.push({ cx: g.cx, cz: g.cz, radius: cullRadius, dist: g.dist, group: g.group });
    }
    // Model batches from source tags (or the raw-geo table).
    const rawBuilt: { geo: THREE.BufferGeometry; mat: THREE.MeshStandardMaterial }[] = [];
    for (const rg of rest.rawGeos) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.BufferAttribute(rg.position, 3));
      if (rg.uv) geo.setAttribute("uv", new THREE.BufferAttribute(rg.uv, 2));
      if (rg.index) geo.setIndex(new THREE.BufferAttribute(rg.index, 1));
      if (rg.normal) geo.setAttribute("normal", new THREE.BufferAttribute(rg.normal, 3));
      else geo.computeVertexNormals();
      rawBuilt.push({ geo, mat: matFor(rg.mat) });
    }
    const buckets = new Map<string, BatchBucket>();
    let dropSrc = 0;
    let dropRaw = 0;
    let okN = 0;
    for (const rec of rest.batchItems) {
      let geo: THREE.BufferGeometry;
      let mat: THREE.Material;
      if (rec.url !== null) {
        const srcMesh = this.cache.srcMesh(rec.url, rec.idx);
        if (!srcMesh || Array.isArray(srcMesh.material)) {
          if (dropSrc++ < 3) console.log(`[city] rest drop src: ${rec.url}#${rec.idx}`);
          continue;
        }
        geo = srcMesh.geometry;
        mat = srcMesh.material;
      } else if (rec.raw !== null && rawBuilt[rec.raw]) {
        const rb = rawBuilt[rec.raw];
        if (!rb) continue;
        geo = rb.geo;
        mat = rb.mat;
      } else {
        dropRaw++;
        continue;
      }
      okN++;
      const attrKey = Object.keys(geo.attributes).sort().join(",");
      const bKey = `${mat.uuid}|${attrKey}|${geo.index ? "i" : "n"}`;
      let bucket = buckets.get(bKey);
      if (!bucket) {
        bucket = { material: mat, geoVerts: new Map(), items: [], verts: 0, indices: 0 };
        buckets.set(bKey, bucket);
      }
      if (!bucket.geoVerts.has(geo)) {
        const vCount = geo.attributes.position?.count ?? 0;
        bucket.geoVerts.set(geo, vCount);
        bucket.verts += vCount;
        bucket.indices += geo.index ? geo.index.count : vCount;
      }
      bucket.items.push({
        geo,
        matrix: new THREE.Matrix4().fromArray(rec.m),
        ...(rec.tint !== null ? { tint: new THREE.Color(rec.tint) } : {}),
        ...(rec.url !== null ? { src: { url: rec.url, idx: rec.idx } } : {}),
      });
    }
    console.log(`[city] rest items ok ${okN} dropSrc ${dropSrc} dropRaw ${dropRaw}`);
    await this.buildBatchesFrom(buckets, nx, nz);
    // Game data.
    this.solids.length = 0;
    for (const so of rest.solids) this.solids.push(so);
    this.parkedCarSpecs = rest.parkedCars;
    this.lampHeads = rest.lampHeads;
    this.addDecks(rest.decks);
    this.buildGround();
    // Landmarks are procedural + cheap — always rebuilt live.
    this.group.add(buildLandmarks(this.terrain, this.cache));
  }

  // Build BatchedMeshes (+ box imposters + chunk instance maps) from filled
  // buckets — called by phase 3 (from staticMeshes) AND the city-rest cache
  // rebuild (from serialized records).
  private async buildBatchesFrom(batchBuckets: Map<string, BatchBucket>, nx: number, nz: number): Promise<void> {
    // Global batches (models). Each instance is assigned to a spatial chunk;
    // updateStreaming() flips whole chunks of instances on visibility
    // transitions, so per-frame cost is ~chunk count, not instance count.
    const pos = new THREE.Vector3();
    const tBatch = performance.now();
    type ImposterSpec = { key: number; item: { geo: THREE.BufferGeometry; matrix: THREE.Matrix4; tint?: THREE.Color } };
    const imposters: ImposterSpec[] = [];
    const restItems = this.restItems;
    restItems.length = 0;
    const untagged = new Map<string, number>();
    let batchN = 0;
    for (const bucket of batchBuckets.values()) {
      await this.breathe();
      const batched = new THREE.BatchedMesh(
        bucket.items.length,
        bucket.verts,
        bucket.indices,
        bucket.material,
      );
      batched.castShadow = true;
      batched.receiveShadow = true;
      // Whole-batch bounds span the map — chunk visibility below is the cull.
      batched.perObjectFrustumCulled = false;
      batched.sortObjects = false;
      const geoIds = new Map<THREE.BufferGeometry, number>();
      const chunkIds = new Uint16Array(bucket.items.length);
      // no-op marker retained for rebuild parity
      for (let i = 0; i < bucket.items.length; i++) {
        const item = bucket.items[i];
        if (!item) continue;
        let gid = geoIds.get(item.geo);
        if (gid === undefined) {
          gid = batched.addGeometry(item.geo);
          geoIds.set(item.geo, gid);
        }
        const iid = batched.addInstance(gid);
        batched.setMatrixAt(iid, item.matrix);
        if (item.src) {
          restItems.push({
            url: item.src.url,
            idx: item.src.idx,
            raw: null,
            m: new Float32Array(item.matrix.elements),
            tint: item.tint ? item.tint.getHex() : null,
            big: false,
          });
        } else {
          const mat = bucket.material;
          if (mat instanceof THREE.MeshStandardMaterial && !mat.map) {
            // Shared generated geometry (plinths, seawall, lake…): serialize
            // once into the raw-geo table, reference by index.
            let rawId = this.rawGeoIds.get(item.geo.uuid);
            if (rawId === undefined) {
              const pos2 = item.geo.getAttribute("position");
              const nor2 = item.geo.getAttribute("normal");
              const uv2 = item.geo.getAttribute("uv");
              rawId = this.rawGeos.length;
              this.rawGeoIds.set(item.geo.uuid, rawId);
              this.rawGeos.push({
                position: pos2.array as Float32Array,
                normal: nor2 ? (nor2.array as Float32Array) : null,
                uv: uv2 ? (uv2.array as Float32Array) : null,
                index: item.geo.index
                  ? (item.geo.index.array as Uint16Array | Uint32Array)
                  : null,
                mat: {
                  color: mat.color.getHex(),
                  roughness: mat.roughness,
                  metalness: mat.metalness,
                  vertexColors: mat.vertexColors,
                  polygonOffset: mat.polygonOffset,
                  polygonOffsetFactor: mat.polygonOffsetFactor,
                  polygonOffsetUnits: mat.polygonOffsetUnits,
                  transparent: mat.transparent,
                  opacity: mat.opacity,
                },
              });
            }
            restItems.push({
              url: null,
              idx: 0,
              raw: rawId,
              m: new Float32Array(item.matrix.elements),
              tint: item.tint ? item.tint.getHex() : null,
              big: false,
            });
          } else {
            this.restComplete = false;
            const tag =
              mat instanceof THREE.MeshStandardMaterial
                ? `${mat.name || "?"}#${mat.color.getHexString()}`
                : mat.type;
            untagged.set(tag, (untagged.get(tag) ?? 0) + 1);
          }
        }
        if (item.tint) batched.setColorAt(iid, item.tint);
        pos.setFromMatrixPosition(item.matrix);
        const ccx = Math.min(nx - 1, Math.max(0, Math.floor((pos.x + WORLD_HALF_X) / CHUNK)));
        const ccz = Math.min(nz - 1, Math.max(0, Math.floor((pos.z + WORLD_HALF_Z) / CHUNK)));
        chunkIds[iid] = ccz * nx + ccx;
      }
      batched.computeBoundingSphere();
      this.group.add(batched);
      const bIndex = this.batches.length;
      this.batches.push({ mesh: batched, chunkIds });
      let anyBig = false;
      for (let iid = 0; iid < chunkIds.length; iid++) {
        const key = chunkIds[iid] ?? 0;
        const item = bucket.items[iid];
        let worldH = 3;
        if (item) {
          if (!item.geo.boundingBox) item.geo.computeBoundingBox();
          const sc = SCRATCH_SCALE.setFromMatrixScale(item.matrix);
          const bb = item.geo.boundingBox;
          worldH = bb ? (bb.max.y - bb.min.y) * sc.y : 3;
        }
        // Skyline = TALL: only buildings that read above the fog at distance
        // keep the far tier; row-houses and low-rises cull with the detail set.
        const big = worldH >= BIG_SILHOUETTE_H;
        if (big) anyBig = true;
        // LOD: tall buildings render the FULL model only within
        // DETAIL_DISTANCE; beyond that a tinted box imposter carries the
        // skyline to the fog line (fog hides the swap).
        const map = this.chunkInstancesNear;
        const list = map.get(key);
        if (list) list.push([bIndex, iid]);
        else map.set(key, [[bIndex, iid]]);
        if (big && item) {
          imposters.push({ key, item });
        }
      }
      // Small-prop shadows don't read at chase-cam scale; skip their pass.
      if (!anyBig) batched.castShadow = false;
    }
    if (imposters.length > 0) {
      const boxGeo = new THREE.BoxGeometry(1, 1, 1);
      boxGeo.translate(0, 0.5, 0); // origin at the base, like buildings
      const boxMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.95 });
      const imp = new THREE.BatchedMesh(imposters.length, 24, 36, boxMat);
      imp.castShadow = false;
      imp.frustumCulled = false;
      const gid = imp.addGeometry(boxGeo);
      const m4 = new THREE.Matrix4();
      const box = new THREE.Box3();
      const sizeV = new THREE.Vector3();
      const ctrV = new THREE.Vector3();
      const defaultTint = new THREE.Color(0x97a1ae);
      for (const { key, item } of imposters) {
        if (!item.geo.boundingBox) item.geo.computeBoundingBox();
        if (!item.geo.boundingBox) continue;
        box.copy(item.geo.boundingBox);
        box.getSize(sizeV);
        box.getCenter(ctrV);
        // unit box (base-origin) -> local bbox -> world
        m4.makeScale(Math.max(sizeV.x, 0.1), Math.max(sizeV.y, 0.1), Math.max(sizeV.z, 0.1));
        m4.setPosition(ctrV.x, box.min.y, ctrV.z);
        m4.premultiply(item.matrix);
        const iid = imp.addInstance(gid);
        imp.setMatrixAt(iid, m4);
        imp.setColorAt(iid, item.tint ?? defaultTint);
        imp.setVisibleAt(iid, false);
        const list = this.imposterInstances.get(key);
        if (list) list.push(iid);
        else this.imposterInstances.set(key, [iid]);
      }
      imp.computeBoundingSphere();
      this.group.add(imp);
      this.imposterMesh = imp;
      console.log(`[city] imposters ${imposters.length}`);
    }
    if (untagged.size > 0) {
      console.log("[city] untagged batch items:", JSON.stringify([...untagged.entries()]));
    }
    // Publish the chunk grid ONLY now, after chunkInstancesNear is fully mapped.
    // Both callers reach here (cold gen AND the baked-rest rebuild); the rebuild
    // path used to skip this, leaving the grid at 1×1 so updateStreaming culled
    // only chunk 0 and the whole map's props drew every frame. It must be the
    // LAST step because buildBatchesFrom yields (await breathe) mid-loop: if the
    // grid went live earlier, an updateStreaming during a yield would mark far
    // chunks hidden in the array before their instances were mapped, skip the
    // setVisibleAt, and never re-fire — stranding those props visible forever.
    // Nulling the arrays forces a clean re-alloc + full cull on the next pass.
    this.batchChunkGrid = { nx, nz };
    this.chunkVisible = null;
    this.chunkVisibleNear = null;
    console.log(`[city] batches ${Math.round(performance.now() - tBatch)}ms`);
  }

  // Chunked visibility: merged road/drape tiles show/hide as whole groups
  // (three frustum-culls them per mesh); batched model instances flip by chunk
  // — distance AND view frustum, near chunks always on so shadow casters just
  // off-screen keep their shadows. Flips apply only on TRANSITIONS, so the
  // steady-state per-frame cost is one sphere test per chunk.
  updateStreaming(camera: THREE.Camera, showAll = false): void {
    const camX = camera.position.x;
    const camZ = camera.position.z;
    for (const c of this.chunks) {
      const d = Math.hypot(camX - c.cx, camZ - c.cz) - c.radius;
      const visible = showAll || d < c.dist;
      if (c.group.visible !== visible) c.group.visible = visible;
    }
    const { nx, nz } = this.batchChunkGrid;
    const total = nx * nz;
    if (!this.chunkVisible) this.chunkVisible = new Uint8Array(total).fill(1);
    if (!this.chunkVisibleNear) this.chunkVisibleNear = new Uint8Array(total).fill(1);
    STREAM_MAT.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    STREAM_FRUSTUM.setFromProjectionMatrix(STREAM_MAT);
    const pad = CHUNK * 0.71 + ROAD_TILE * 2;
    for (let key = 0; key < total; key++) {
      const cx = ((key % nx) + 0.5) * CHUNK - WORLD_HALF_X;
      const cz = (Math.floor(key / nx) + 0.5) * CHUNK - WORLD_HALF_Z;
      const dist = Math.hypot(camX - cx, camZ - cz);
      let inFrustum = false;
      if (dist - pad < DRAW_DISTANCE) {
        STREAM_SPHERE.center.set(cx, 14, cz);
        STREAM_SPHERE.radius = pad + 30; // tall roofs/trees overhang the tile
        inFrustum = STREAM_FRUSTUM.intersectsSphere(STREAM_SPHERE);
      }
      const near = dist < NEAR_ALWAYS;
      const visFar: 0 | 1 = showAll || near || (inFrustum && dist - pad < DRAW_DISTANCE) ? 1 : 0;
      const visNear: 0 | 1 = showAll || near || (inFrustum && dist - pad < DETAIL_DISTANCE) ? 1 : 0;
      if (this.chunkVisible[key] !== visFar) {
        this.chunkVisible[key] = visFar;
        const list = this.chunkInstancesFar.get(key);
        if (list) for (const [b, iid] of list) this.batches[b]?.mesh.setVisibleAt(iid, visFar === 1);
      }
      if (this.chunkVisibleNear[key] !== visNear) {
        this.chunkVisibleNear[key] = visNear;
        const list = this.chunkInstancesNear.get(key);
        if (list) for (const [b, iid] of list) this.batches[b]?.mesh.setVisibleAt(iid, visNear === 1);
      }
      // Imposters live in the far band only: full models take over up close.
      if (this.imposterMesh) {
        if (!this.imposterVisible) this.imposterVisible = new Uint8Array(total).fill(0);
        const visImp: 0 | 1 = visFar === 1 && visNear === 0 ? 1 : 0;
        if (this.imposterVisible[key] !== visImp) {
          this.imposterVisible[key] = visImp;
          const list = this.imposterInstances.get(key);
          if (list) for (const iid of list) this.imposterMesh.setVisibleAt(iid, visImp === 1);
        }
      }
    }
  }

  // Is the world position over a road cell (vs a building lot)?
  isOnRoad(x: number, z: number): boolean {
    const gx = this.gridX(x);
    const gz = this.gridZ(z);
    if (gx < 0 || gz < 0 || gx >= GRID_X || gz >= GRID_Z) return false;
    return this.plan.cells[gx]?.[gz] === "road";
  }

  // --- Surface (what the car drives on): terrain, overridden by decks —
  // flat (wharf piers) or Z-sloped ramps (bridge approaches). `y` is the
  // height at minZ; `y2` (when set) is the height at maxZ, lerped between. ---
  private decks: SurfaceDeck[] = [];

  addDecks(decks: readonly SurfaceDeck[]): void {
    for (const d of decks) this.decks.push(d);
  }

  getDecks(): readonly SurfaceDeck[] {
    return this.decks;
  }

  private deckHeight(d: SurfaceDeck, z: number): number {
    if (d.y2 === undefined || d.maxZ <= d.minZ) return d.y;
    const t = (z - d.minZ) / (d.maxZ - d.minZ);
    return d.y + (d.y2 - d.y) * t;
  }

  heightAt(x: number, z: number): number {
    for (const d of this.decks) {
      if (x >= d.minX && x <= d.maxX && z >= d.minZ && z <= d.maxZ) {
        return Math.max(this.deckHeight(d, z), this.terrain.heightAt(x, z));
      }
    }
    return this.terrain.heightAt(x, z);
  }

  normalInto(out: THREE.Vector3, x: number, z: number): THREE.Vector3 {
    for (const d of this.decks) {
      if (x >= d.minX && x <= d.maxX && z >= d.minZ && z <= d.maxZ) {
        // Only take the deck normal where the deck actually IS the surface.
        if (this.deckHeight(d, z) >= this.terrain.heightAt(x, z) - 0.05) {
          if (d.y2 === undefined || d.maxZ <= d.minZ) return out.set(0, 1, 0);
          const slope = (d.y2 - d.y) / (d.maxZ - d.minZ);
          return out.set(0, 1, -slope).normalize();
        }
      }
    }
    return this.terrain.normalInto(out, x, z);
  }
}

// A drivable surface patch floating over the terrain (pier deck, bridge ramp).
export type SurfaceDeck = {
  readonly minX: number;
  readonly maxX: number;
  readonly minZ: number;
  readonly maxZ: number;
  readonly y: number; // height at minZ
  readonly y2?: number; // height at maxZ (sloped ramp when set)
};

// Bake world transforms and merge geometries that share a material, producing a
// handful of static meshes instead of hundreds of draw calls.
// Split a world-space geometry into per-chunk geometries (triangles bucketed
// by centroid, vertices remapped). Whole-map surfaces (the planar-map asphalt
// is ONE geometry) would otherwise defeat chunk culling AND the rest cache.
function splitGeoByChunk(
  geo: THREE.BufferGeometry,
  nx: number,
  nz: number,
): Map<number, THREE.BufferGeometry> {
  const pos = geo.getAttribute("position");
  const nor = geo.getAttribute("normal");
  const uv = geo.getAttribute("uv");
  const col = geo.getAttribute("color");
  const idx = geo.index;
  const triCount = idx ? idx.count / 3 : pos.count / 3;
  const vid = (k: number): number => (idx ? idx.getX(k) : k);
  type Piece = { map: Map<number, number>; pos: number[]; nor: number[]; uv: number[]; col: number[]; index: number[] };
  const pieces = new Map<number, Piece>();
  for (let t = 0; t < triCount; t++) {
    const a = vid(t * 3);
    const b = vid(t * 3 + 1);
    const c = vid(t * 3 + 2);
    const mx = (pos.getX(a) + pos.getX(b) + pos.getX(c)) / 3;
    const mz = (pos.getZ(a) + pos.getZ(b) + pos.getZ(c)) / 3;
    const cx = Math.min(nx - 1, Math.max(0, Math.floor((mx + WORLD_HALF_X) / CHUNK)));
    const cz = Math.min(nz - 1, Math.max(0, Math.floor((mz + WORLD_HALF_Z) / CHUNK)));
    const key = cz * nx + cx;
    let piece = pieces.get(key);
    if (!piece) {
      piece = { map: new Map(), pos: [], nor: [], uv: [], col: [], index: [] };
      pieces.set(key, piece);
    }
    for (const v of [a, b, c]) {
      let nid = piece.map.get(v);
      if (nid === undefined) {
        nid = piece.pos.length / 3;
        piece.map.set(v, nid);
        piece.pos.push(pos.getX(v), pos.getY(v), pos.getZ(v));
        if (nor) piece.nor.push(nor.getX(v), nor.getY(v), nor.getZ(v));
        if (uv) piece.uv.push(uv.getX(v), uv.getY(v));
        if (col) piece.col.push(col.getX(v), col.getY(v), col.getZ(v));
      }
      piece.index.push(nid);
    }
  }
  const out = new Map<number, THREE.BufferGeometry>();
  for (const [key, piece] of pieces) {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(piece.pos), 3));
    if (nor) g.setAttribute("normal", new THREE.BufferAttribute(new Float32Array(piece.nor), 3));
    if (uv) g.setAttribute("uv", new THREE.BufferAttribute(new Float32Array(piece.uv), 2));
    if (col) g.setAttribute("color", new THREE.BufferAttribute(new Float32Array(piece.col), 3));
    const IndexArr = piece.pos.length / 3 > 65535 ? Uint32Array : Uint16Array;
    g.setIndex(new THREE.BufferAttribute(new IndexArr(piece.index), 1));
    out.set(key, g);
  }
  return out;
}

function mergeByMaterial(meshes: readonly THREE.Mesh[]): THREE.Mesh[] {
  type Group = { material: THREE.Material; attrs: string; geometries: THREE.BufferGeometry[] };
  const groups = new Map<string, Group>();

  for (const mesh of meshes) {
    const mat = mesh.material;
    if (Array.isArray(mat)) continue; // multi-material meshes left un-merged (rare here)
    const geo = mesh.geometry;
    if (!(geo instanceof THREE.BufferGeometry)) continue;
    // Keep indices: conformed geometry is welded/indexed (~3x smaller) and
    // mergeGeometries handles all-indexed groups fine — the group key
    // includes indexedness so mixed sets never land in one merge call.
    const baked = geo.clone();
    toFloat32Attributes(baked); // dequantize meshopt attrs BEFORE baking world coords
    baked.applyMatrix4(mesh.matrixWorld);
    // Normalize attributes so merge never fails on a mismatched set.
    const wanted = new Set(["position", "normal", "uv", "color"]);
    for (const name of Object.keys(baked.attributes)) {
      if (!wanted.has(name)) baked.deleteAttribute(name);
    }
    if (!baked.getAttribute("uv") && baked.getAttribute("position")) {
      const count = baked.getAttribute("position").count;
      baked.setAttribute("uv", new THREE.BufferAttribute(new Float32Array(count * 2), 2));
    }
    // Deterministic signature in a fixed order (avoids a mutating sort).
    const attrs = ["position", "normal", "uv", "color"]
      .filter((n) => baked.getAttribute(n))
      .join(",");
    const key = `${mat.uuid}|${attrs}|${baked.index ? "i" : "n"}`;
    const g = groups.get(key);
    if (g) g.geometries.push(baked);
    else groups.set(key, { material: mat, attrs, geometries: [baked] });
  }

  const out: THREE.Mesh[] = [];
  for (const g of groups.values()) {
    const merged = mergeGeometries(g.geometries, false);
    if (!merged) {
      for (const geo of g.geometries) {
        const m = new THREE.Mesh(geo, g.material);
        m.castShadow = true;
        m.receiveShadow = true;
        out.push(m);
      }
      continue;
    }
    const mesh = new THREE.Mesh(merged, g.material);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    out.push(mesh);
  }
  return out;
}
