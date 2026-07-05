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
import { CUSTOM_PROPS } from "./custom-props";
import { buildFurniture, type LampHead, type ParkedSpec } from "./furniture";
import { buildGoldenGate } from "./golden-gate";
import { RoadNetwork } from "./network";
import { type CityPlan, generateCity } from "./grid";
import { CUSTOM_MAP, type FloorKind, loadLocalOverrides } from "./custom-map";
import { buildGridNetwork } from "./grid-network";
import { SF_BUILDINGS, SF_BUILDINGS_BOUNDS } from "./sf-buildings";
import { landuseGreenAt, landuseSandAt } from "./sf-landuse";
import { buildRoads } from "./roads";
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
type Chunk = { cx: number; cz: number; radius: number; group: THREE.Group };

// Batched-instance streaming scratch (per-frame, allocation-free).
const NEAR_ALWAYS = 220; // chunks this close are always on (off-screen shadow casters)
const DETAIL_DISTANCE = 520; // trees/cars/props cull here; buildings at DRAW_DISTANCE
const BIG_SILHOUETTE_R = 5; // world-space radius that counts as skyline
const SCRATCH_SCALE = new THREE.Vector3();
const STREAM_MAT = new THREE.Matrix4();
const STREAM_FRUSTUM = new THREE.Frustum();
const STREAM_SPHERE = new THREE.Sphere();

export class CityModel {
  readonly group = new THREE.Group();
  readonly solids: Solid[] = [];
  readonly roadCells: RoadCell[] = [];
  readonly plan: CityPlan;
  readonly terrain: Terrain;
  readonly network: RoadNetwork; // vector road graph (rendering/traffic/alignment)
  parkedCarSpecs: readonly ParkedSpec[] = []; // punt-able parked cars (built by furniture)
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
  private chunkVisibleNear: Uint8Array | null = null;

  constructor(
    private cache: ModelCache,
    private rng = new Rng(CITY_SEED),
  ) {
    this.terrain = makeTerrain();
    this.plan = generateCity();
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
    this.build();
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

  private build(): void {
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

    for (const mesh of buildRoads(this.network, this.terrain)) {
      mesh.userData.merge = true; // road ribbons are unique conformed buffers
      staticMeshes.push(mesh);
    }

    // --- Landmark footprints: cells the procedural city leaves alone ---
    const lm = landmarkProtection(this.plan);
    for (const s of lm.solids) this.solids.push(s);

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
      const seatY = Math.max(...corners);
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
      occupy(wx, wz, targetFootprint * 0.5);

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
            if (re && re.dist < re.edge.half + Math.min(bw, bd) / 2 - 0.6) continue;
          }
        }
        if (occupied(bx, bz, Math.max(bw, bd) * 0.45)) continue;
        const pool = bh > 28 ? BUILDINGS_SKYSCRAPER : bh > 9 ? BUILDINGS_COMMERCIAL : BUILDINGS_SUBURBAN;
        const key = this.rng.pick(pool);
        const url = modelUrl("buildings", key);
        const bounds = this.cache.bounds(url);
        const sxz = Math.max(bw, bd) / Math.max(bounds.size.x, bounds.size.z, 0.001);
        const sy = bh / Math.max(bounds.size.y, 0.001);
        const fh = Math.max(bw, bd) / 2;
        const corners = [
          this.terrain.heightAt(bx, bz),
          this.terrain.heightAt(bx - fh, bz - fh),
          this.terrain.heightAt(bx + fh, bz - fh),
          this.terrain.heightAt(bx - fh, bz + fh),
          this.terrain.heightAt(bx + fh, bz + fh),
        ];
        const seatY = Math.max(...corners);
        if (seatY - Math.min(...corners) > 5) continue;
        const node = this.cache.instance(url);
        node.scale.set(sxz, sy, sxz);
        node.position.set(bx, seatY - 0.15, bz);
        const district = districtAt(this.gridX(bx), this.gridZ(bz));
        this.tintNode(node, this.rng.pick(paletteFor(district)), tintAmountFor(district));
        collect(node);
        const hw = (bw / 2) * 0.94;
        const hd = (bd / 2) * 0.94;
        this.solids.push({
          minX: bx - hw,
          maxX: bx + hw,
          minZ: bz - hd,
          maxZ: bz + hd,
        });
        occupy(bx, bz, Math.max(bw, bd) * 0.5);
        placed++;
      }
      console.log(`[city] real downtown buildings placed: ${placed}`);
    }

    // --- FRONTAGE ROWS along the network edges: buildings walk each street
    // with a consistent setback, facing the kerb — rows follow diagonals and
    // curves exactly, which cell-based lots never could. ---
    for (const edge of this.network.edges) {
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
          const step = footprint + (dense ? this.rng.range(0.2, 0.9) : this.rng.range(0.6, 1.8));
          const off = edge.half + 1.7 + footprint / 2 + 0.7;
          const px = smp.x - smp.tz * off * side;
          const pz = smp.z + smp.tx * off * side;
          s += step;
          if (district.character === "park") continue;
          if (!isLandCell(this.gridX(px), this.gridZ(pz))) continue;
          if (lm.reserved.has(`${this.gridX(px)},${this.gridZ(pz)}`)) continue;
          if (occupied(px, pz, footprint * 0.52)) continue;
          // Clearance vs OTHER streets (corners, parallel edges).
          const near = this.network.nearest(px, pz, ROAD_TILE * 1.6);
          if (near && near.dist < near.edge.half + footprint / 2 - 0.4) continue;
          if (this.rng.chance(0.04)) continue; // rare vacancy
          const yaw = Math.atan2(smp.tx * side, smp.tz * side) + HALF_PI_CITY;
          const cardinal = Math.abs(Math.sin(2 * yaw)) < 0.18;
          placeBuilding(gx, gz, 0, frac, cardinal, { x: px, z: pz, yaw });
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

    // --- Street furniture: lights, parked cars, yards, awnings, smokestacks,
    // construction chicanes, park allées, wharf piers + seawall. ---
    const fr = buildFurniture({
      plan: this.plan,
      network: this.network,
      terrain: this.terrain,
      cache: this.cache,
      rng: this.rng,
      reserved: lm.reserved,
      worldX: (g) => this.worldX(g),
      worldZ: (g) => this.worldZ(g),
    });
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

    // --- Displaced terrain ground (hills + island; ocean plane sits below),
    // vertex-graded: concrete in the city, Ocean Beach sand along the west
    // shore (half-strength on other shores), park green under the big parks. ---
    const groundMat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      vertexColors: true,
      roughness: 1,
    });
    const CONCRETE = new THREE.Color(0x9a9b92);
    const SAND = new THREE.Color(0xd9c9a1);
    const PARK = new THREE.Color(0x74975c);
    const greenSet = new Set(this.plan.greenCells.map((g) => `${g.gx},${g.gz}`));
    // Painted floors (editor "Floor" mode): baked + this browser's local edits.
    const floorAt = new Map<string, FloorKind>();
    {
      const local = loadLocalOverrides();
      for (const [fgx, fgz, kind] of [...CUSTOM_MAP.floor, ...local.floor]) {
        floorAt.set(`${fgx},${fgz}`, kind);
      }
    }
    const ground = this.terrain.buildMesh(
      groundMat,
      (x, z, into) => {
        into.copy(CONCRETE);
        const gx = Math.min(GRID_X - 1, Math.max(0, this.gridX(x)));
        const gz = Math.min(GRID_Z - 1, Math.max(0, this.gridZ(z)));
        if (landuseGreenAt(gx, gz) || districtAt(gx, gz).character === "park") {
          into.lerp(PARK, 0.8); // real OSM green space
        } else if (greenSet.has(`${gx},${gz}`)) {
          into.lerp(PARK, 0.3); // interior lots: subtle, not lawn-prairie
        }
        if (landuseSandAt(gx, gz)) into.lerp(SAND, 0.85);
        const painted = floorAt.get(`${gx},${gz}`);
        if (painted === "plaza") into.copy(CONCRETE).lerp(new THREE.Color(0xffffff), 0.12);
        else if (painted === "grass") into.copy(PARK);
        else if (painted === "sand") into.copy(SAND);
        const land = this.terrain.landAt(x, z);
        const shore = 1 - THREE.MathUtils.smoothstep(land, 0.3, 0.55);
        if (shore > 0) {
          const u = x / WORLD_W + 0.5;
          into.lerp(SAND, u < 0.12 ? shore : shore * 0.5); // Ocean Beach reads strongest
        }
      },
      // Depress the ground under streets: this mesh tessellates the height
      // field ~4× coarser than the draped roads, and on tight hills its
      // linear interpolation bows up to ~0.25u ABOVE the true field — up
      // through the asphalt. Depression follows the NETWORK (distance to the
      // nearest edge), not raster cells: the smoothed diagonals no longer
      // match the cell staircase, and a cell-based dip pokes out as dark
      // jagged zigzags beside every diagonal street.
      (x, z) => {
        const hit = this.network.nearest(x, z, ROAD_TILE * 1.05);
        if (!hit) return 0;
        const pave = hit.edge.half + 1.6; // asphalt + sidewalk apron
        if (hit.dist < pave) return -0.35;
        // Feather back to grade so the lip never shows as a step.
        return -0.35 * Math.max(0, 1 - (hit.dist - pave) / 3);
      },
    );
    ground.name = "terrain-ground"; // the map editor raycasts against this
    this.group.add(ground);

    // --- Hand-placed decorations from the map editor (world/custom-props.ts) ---
    for (const p of CUSTOM_PROPS) {
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
    type BatchBucket = {
      material: THREE.Material;
      geoVerts: Map<THREE.BufferGeometry, number>;
      items: { geo: THREE.BufferGeometry; matrix: THREE.Matrix4; tint?: THREE.Color }[];
      verts: number;
      indices: number;
    };
    const mergeBuckets = new Map<number, THREE.Mesh[]>();
    const batchBuckets = new Map<string, BatchBucket>();
    const centroid = new THREE.Vector3();
    for (const mesh of staticMeshes) {
      if (!(mesh.geometry instanceof THREE.BufferGeometry)) continue;
      const mat = mesh.material;
      if (mesh.userData.merge === true || Array.isArray(mat)) {
        mesh.geometry.computeBoundingBox();
        mesh.geometry.boundingBox?.getCenter(centroid);
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
      bucket.items.push({ geo, matrix: mesh.matrixWorld.clone(), ...(tint ? { tint } : {}) });
    }

    // Chunked merges (roads + drapes).
    const cullRadius = CHUNK * 0.71 + ROAD_TILE * 2;
    for (const [key, meshes] of mergeBuckets) {
      const cx = key % nx;
      const cz = Math.floor(key / nx);
      const group = new THREE.Group();
      for (const merged of mergeByMaterial(meshes)) group.add(merged);
      this.group.add(group);
      this.chunks.push({
        cx: (cx + 0.5) * CHUNK - WORLD_HALF_X,
        cz: (cz + 0.5) * CHUNK - WORLD_HALF_Z,
        radius: cullRadius,
        group,
      });
    }

    // Global batches (models). Each instance is assigned to a spatial chunk;
    // updateStreaming() flips whole chunks of instances on visibility
    // transitions, so per-frame cost is ~chunk count, not instance count.
    const pos = new THREE.Vector3();
    for (const bucket of batchBuckets.values()) {
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
        let worldR = 3;
        if (item) {
          if (!item.geo.boundingSphere) item.geo.computeBoundingSphere();
          const sc = SCRATCH_SCALE.setFromMatrixScale(item.matrix);
          worldR = (item.geo.boundingSphere?.radius ?? 1) * Math.max(sc.x, sc.y, sc.z);
        }
        const big = worldR >= BIG_SILHOUETTE_R;
        if (big) anyBig = true;
        const map = big ? this.chunkInstancesFar : this.chunkInstancesNear;
        const list = map.get(key);
        if (list) list.push([bIndex, iid]);
        else map.set(key, [[bIndex, iid]]);
      }
      // Small-prop shadows don't read at chase-cam scale; skip their pass.
      if (!anyBig) batched.castShadow = false;
    }
    // Chunk centres for the batched-instance visibility pass.
    this.batchChunkGrid = { nx, nz };

    // --- Iconic landmarks (procedural; kept separate — always visible) ---
    this.group.add(buildLandmarks(this.terrain, this.cache));
  }

  // Chunked visibility: merged road/drape tiles show/hide as whole groups
  // (three frustum-culls them per mesh); batched model instances flip by chunk
  // — distance AND view frustum, near chunks always on so shadow casters just
  // off-screen keep their shadows. Flips apply only on TRANSITIONS, so the
  // steady-state per-frame cost is one sphere test per chunk.
  updateStreaming(camera: THREE.Camera): void {
    const camX = camera.position.x;
    const camZ = camera.position.z;
    for (const c of this.chunks) {
      const d = Math.hypot(camX - c.cx, camZ - c.cz) - c.radius;
      const visible = d < DRAW_DISTANCE;
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
      const visFar: 0 | 1 = near || (inFrustum && dist - pad < DRAW_DISTANCE) ? 1 : 0;
      const visNear: 0 | 1 = near || (inFrustum && dist - pad < DETAIL_DISTANCE) ? 1 : 0;
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
function mergeByMaterial(meshes: readonly THREE.Mesh[]): THREE.Mesh[] {
  type Group = { material: THREE.Material; attrs: string; geometries: THREE.BufferGeometry[] };
  const groups = new Map<string, Group>();

  for (const mesh of meshes) {
    const mat = mesh.material;
    if (Array.isArray(mat)) continue; // multi-material meshes left un-merged (rare here)
    const geo = mesh.geometry;
    if (!(geo instanceof THREE.BufferGeometry)) continue;
    // De-index up front: conformed geometry is non-indexed, and mergeGeometries
    // refuses to mix indexed with non-indexed in one group.
    const baked = geo.index ? geo.toNonIndexed() : geo.clone();
    toFloat32Attributes(baked); // dequantize meshopt attrs BEFORE baking world coords
    baked.applyMatrix4(mesh.matrixWorld);
    // Normalize attributes so merge never fails on a mismatched set.
    const wanted = new Set(["position", "normal", "uv"]);
    for (const name of Object.keys(baked.attributes)) {
      if (!wanted.has(name)) baked.deleteAttribute(name);
    }
    if (!baked.getAttribute("uv") && baked.getAttribute("position")) {
      const count = baked.getAttribute("position").count;
      baked.setAttribute("uv", new THREE.BufferAttribute(new Float32Array(count * 2), 2));
    }
    // Deterministic signature in a fixed order (avoids a mutating sort).
    const attrs = ["position", "normal", "uv"].filter((n) => baked.getAttribute(n)).join(",");
    const key = `${mat.uuid}|${attrs}`;
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
