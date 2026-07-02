import * as THREE from "three";

import type { ModelCache } from "../assets/loader";
import {
  BRIDGE_PILLAR,
  LIGHT_CURVED,
  LIGHT_CURVED_CROSS,
  LIGHT_SQUARE,
  LIGHT_SQUARE_DOUBLE,
  modelUrl,
  PROP_AWNING,
  PROP_AWNING_WIDE,
  PROP_BARRIER,
  PROP_CHIMNEY_LARGE,
  PROP_CHIMNEY_MEDIUM,
  PROP_CHIMNEY_SMALL,
  PROP_CONE,
  PROP_CONSTRUCTION_LIGHT,
  PROP_DRIVEWAY,
  PROP_FENCE_LOW,
  PROP_OVERHANG,
  PROP_PARASOL_A,
  PROP_PARASOL_B,
  PROP_PATH,
  PROP_PATH_STONES,
  PROP_PLANTER,
  PROP_TANK,
  ROAD_CROSSROAD,
  ROAD_INTERSECTION,
  ROAD_STRAIGHT,
  TRAFFIC_CARS,
  TREE_LARGE,
} from "../assets/manifest";
import { GRID, ROAD_TILE, ROAD_Y, WORLD_SIZE } from "../shared/constants";
import type { Rng } from "../shared/rng";
import { type Dir, DIR_DELTA, E, N, S, W } from "../shared/types";
import type { Solid } from "./city";
import { conformToTerrain } from "./conform";
import type { CityPlan, RoadResolved } from "./grid";
import { type DistrictChar, districtAt } from "./sf-map";
import type { Terrain } from "./terrain";

// Street-furniture pass: streetlights, parked cars, awnings, suburban yards,
// industrial smokestacks, construction chicanes, Golden Gate Park allées, the
// Fisherman's Wharf piers and the wharf seawall. Everything static is returned
// as world-baked objects for the caller to collect + merge by material; only a
// handful of collision Solids (parked cars, barriers, pier railings/buildings)
// are appended.

export type FurnitureCtx = {
  readonly plan: CityPlan;
  readonly terrain: Terrain;
  readonly cache: ModelCache;
  readonly rng: Rng;
  readonly reserved: ReadonlySet<string>; // "gx,gz" cells to leave alone (landmarks)
  readonly worldX: (gx: number) => number;
  readonly worldZ: (gz: number) => number;
};

export type PierDeck = { minX: number; maxX: number; minZ: number; maxZ: number; y: number };

export type FurnitureResult = {
  readonly objects: THREE.Object3D[]; // static, world-transform set; caller merges
  readonly solids: Solid[]; // collision boxes to append
  readonly openWaterCells: ReadonlySet<string>; // water cells the shoreline-wall pass must skip (piers)
  readonly pierDecks: readonly PierDeck[]; // drivable flat decks (caller overrides surface height)
};

const HALF_PI = Math.PI / 2;
const DIRS: readonly Dir[] = [N, E, S, W];

// --- Tunables ---
const LIGHT_HEIGHT = 5; // streetlight world height
const LIGHT_LATERAL = ROAD_TILE * 0.42; // lamp offset from the road centreline
const PARK_LATERAL = ROAD_TILE * 0.36; // parked-car offset from centreline
const PIER_DECK_Y = 0.55; // flat pier deck height over the water
const PIER_WIDTH = ROAD_TILE * 1.03; // decks scaled like road tiles
const PIER_RAMP_RUN = ROAD_TILE * 0.6; // horizontal run of the shore→deck ramp
const CONSTRUCTION_POCKETS = 6;

// Model catalogs used only here.
const AWNINGS: readonly string[] = [PROP_AWNING, PROP_AWNING_WIDE, PROP_OVERHANG];
const CHIMNEYS: readonly string[] = [PROP_CHIMNEY_SMALL, PROP_CHIMNEY_MEDIUM, PROP_CHIMNEY_LARGE];
// Pier 39 stand-ins at the middle pier's end (commercial kit, tinted brick-red).
const PIER_END_BUILDINGS: readonly string[] = ["com-building-a", "com-building-f"];
const PIER_BUILDING_TINT = 0xc45a3a;

// Shared static geometry/materials at module scope so merged batches stay few.
const UNIT_BOX = new THREE.BoxGeometry(1, 1, 1);
const RAIL_MAT = new THREE.MeshStandardMaterial({ color: 0x8a6f4d, roughness: 0.9 }); // pier wood
const SEAWALL_MAT = new THREE.MeshStandardMaterial({ color: 0x9aa2a6, roughness: 1 }); // concrete lip
const LAKE_MAT = new THREE.MeshStandardMaterial({ color: 0x3f6f8f, roughness: 0.4 }); // Stow Lake

// Tinted material clones, cached so tinted meshes still merge into one batch.
const tintCache = new Map<string, THREE.Material>();
function tintMaterial(base: THREE.Material, hex: number, amt: number): THREE.Material {
  if (!(base instanceof THREE.MeshStandardMaterial)) return base;
  const cacheKey = `${base.uuid}:${hex}:${amt}`;
  const cached = tintCache.get(cacheKey);
  if (cached) return cached;
  const m = base.clone();
  m.color.copy(base.color).lerp(new THREE.Color(hex), amt);
  tintCache.set(cacheKey, m);
  return m;
}
function tintNode(node: THREE.Object3D, hex: number, amt: number): void {
  node.traverse((c) => {
    if (c instanceof THREE.Mesh && c.material instanceof THREE.Material) {
      c.material = tintMaterial(c.material, hex, amt);
    }
  });
}

const cellKey = (gx: number, gz: number): string => `${gx},${gz}`;
const inBounds = (gx: number, gz: number): boolean => gx >= 0 && gz >= 0 && gx < GRID && gz < GRID;

// Yaw that points local +Z toward the given grid direction (matches city.ts).
function dirToYaw(d: Dir): number {
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

// Streetlight model per district character.
function lightFor(c: DistrictChar): string {
  switch (c) {
    case "residential":
    case "victorian":
    case "park":
      return LIGHT_CURVED;
    case "downtown":
    case "highrise":
    case "industrial":
      return LIGHT_SQUARE;
    case "commercial":
      return LIGHT_SQUARE_DOUBLE;
    case "wharf":
      return LIGHT_CURVED_CROSS;
  }
}

export function buildFurniture(ctx: FurnitureCtx): FurnitureResult {
  const { plan, terrain, cache, rng, reserved, worldX, worldZ } = ctx;
  const objects: THREE.Object3D[] = [];
  const solids: Solid[] = [];
  const openWaterCells = new Set<string>();
  const pierDecks: PierDeck[] = [];

  const roadAt = (gx: number, gz: number): RoadResolved | null =>
    inBounds(gx, gz) ? (plan.roads[gx]?.[gz] ?? null) : null;
  const cellAt = (gx: number, gz: number): "road" | "lot" | "water" | null =>
    inBounds(gx, gz) ? (plan.cells[gx]?.[gz] ?? null) : null;
  const centre = (GRID - 1) / 2;
  const nearCentre = (gx: number, gz: number, r: number): boolean =>
    Math.hypot(gx - centre, gz - centre) <= r;

  // Place a cached model with world transform baked (caller merges).
  const place = (url: string, x: number, y: number, z: number, yaw: number, s: number): void => {
    const node = cache.instance(url);
    node.scale.setScalar(s);
    node.rotation.y = yaw;
    node.position.set(x, y, z);
    node.updateMatrixWorld(true);
    objects.push(node);
  };
  const seat = (url: string, x: number, z: number, yaw: number, s: number): void => {
    place(url, x, terrain.heightAt(x, z), z, yaw, s);
  };
  const scaleToHeight = (url: string, h: number): number =>
    h / Math.max(cache.bounds(url).size.y, 0.001);
  // Long-axis info for strip pieces (fences, paths): scale by the long side and
  // rotate so the long axis runs along the requested yaw's Z direction.
  const longAxis = (url: string): { len: number; yawAdj: number } => {
    const b = cache.bounds(url);
    return b.size.x >= b.size.z
      ? { len: Math.max(b.size.x, 0.001), yawAdj: HALF_PI }
      : { len: Math.max(b.size.z, 0.001), yawAdj: 0 };
  };
  // Bake a node to world space, drape its geometry over the terrain, and emit
  // identity-transform meshes (thin ground pieces: fences, paths, the lake).
  const drape = (node: THREE.Object3D, lift: number): void => {
    node.updateMatrixWorld(true);
    node.traverse((c) => {
      if (!(c instanceof THREE.Mesh) || !(c.geometry instanceof THREE.BufferGeometry)) return;
      const mat = c.material;
      if (Array.isArray(mat)) return;
      const baked = c.geometry.clone();
      baked.applyMatrix4(c.matrixWorld);
      const mesh = new THREE.Mesh(conformToTerrain(baked, terrain, lift), mat);
      mesh.updateMatrixWorld(true);
      objects.push(mesh);
    });
  };
  // World-baked box helper (pier railings, seawall lips).
  const box = (
    mat: THREE.Material,
    sx: number,
    sy: number,
    sz: number,
    x: number,
    y: number,
    z: number,
  ): void => {
    const mesh = new THREE.Mesh(UNIT_BOX, mat);
    mesh.scale.set(sx, sy, sz);
    mesh.position.set(x, y, z);
    mesh.updateMatrixWorld(true);
    objects.push(mesh);
  };

  // ------------------------------------------------------------------
  // 1. STREETLIGHTS — every 2nd straight road cell, alternating curb side.
  // ------------------------------------------------------------------
  const lightSide = new Map<string, 1 | -1>(); // which side a cell's lamp took
  for (let gx = 0; gx < GRID; gx++) {
    for (let gz = 0; gz < GRID; gz++) {
      const road = roadAt(gx, gz);
      if (!road || road.tile !== ROAD_STRAIGHT) continue;
      if ((gx + gz) % 2 !== 0) continue;
      if (reserved.has(cellKey(gx, gz))) continue;
      // Keep junction mouths clear.
      let nearJunction = false;
      for (const d of DIRS) {
        const [dx, dz] = DIR_DELTA[d];
        const nb = roadAt(gx + dx, gz + dz);
        if (nb && (nb.tile === ROAD_CROSSROAD || nb.tile === ROAD_INTERSECTION)) {
          nearJunction = true;
        }
      }
      if (nearJunction) continue;
      const alongX = road.quarterTurns % 2 === 0; // straight base mask runs E–W
      const side: 1 | -1 = Math.floor((gx + gz) / 2) % 2 === 0 ? 1 : -1;
      const wx = worldX(gx);
      const wz = worldZ(gz);
      const px = alongX ? wx : wx + side * LIGHT_LATERAL;
      const pz = alongX ? wz + side * LIGHT_LATERAL : wz;
      // Lamp arm (local +Z) points back toward the road centreline.
      const yaw = alongX ? (side > 0 ? Math.PI : 0) : -side * HALF_PI;
      const url = modelUrl("props", lightFor(districtAt(gx, gz).character));
      seat(url, px, pz, yaw, scaleToHeight(url, LIGHT_HEIGHT));
      lightSide.set(cellKey(gx, gz), side);
    }
  }

  // ------------------------------------------------------------------
  // 2. PARKED CARS — curbs of residential/victorian/commercial streets.
  // ------------------------------------------------------------------
  for (let gx = 0; gx < GRID; gx++) {
    for (let gz = 0; gz < GRID; gz++) {
      const road = roadAt(gx, gz);
      if (!road || road.tile !== ROAD_STRAIGHT) continue;
      if (reserved.has(cellKey(gx, gz))) continue;
      if (nearCentre(gx, gz, 2)) continue; // keep the spawn block clear
      const char = districtAt(gx, gz).character;
      if (char !== "residential" && char !== "victorian" && char !== "commercial") continue;
      if (!rng.chance(0.3)) continue;
      const taken = lightSide.get(cellKey(gx, gz));
      const side: 1 | -1 = taken !== undefined ? (taken > 0 ? -1 : 1) : rng.chance(0.5) ? 1 : -1;
      const alongX = road.quarterTurns % 2 === 0;
      const wx = worldX(gx);
      const wz = worldZ(gz);
      const px = alongX ? wx : wx + side * PARK_LATERAL;
      const pz = alongX ? wz + side * PARK_LATERAL : wz;
      // Length axis along the road; side flips facing so cars read as parked
      // with the flow of their curb. Tiny yaw jitter sells hand-parking.
      const yaw = (alongX ? HALF_PI : 0) + (side > 0 ? 0 : Math.PI) + rng.range(-0.04, 0.04);
      seat(modelUrl("cars", rng.pick(TRAFFIC_CARS)), px, pz, yaw, 1);
      solids.push(
        alongX
          ? { minX: px - 2, maxX: px + 2, minZ: pz - 1, maxZ: pz + 1 }
          : { minX: px - 1, maxX: px + 1, minZ: pz - 2, maxZ: pz + 2 },
      );
    }
  }

  // ------------------------------------------------------------------
  // 3/4/5. LOT DRESSING — awnings + parasols (commercial/wharf), yards
  // (residential/victorian), smokestack yards (industrial). One sweep over
  // buildingCells keeps the rng stream deterministic and cache-friendly.
  // ------------------------------------------------------------------
  for (const b of plan.buildingCells) {
    if (reserved.has(cellKey(b.gx, b.gz))) continue;
    const district = districtAt(b.gx, b.gz);
    const [dx, dz] = DIR_DELTA[b.faceDir]; // toward the street
    const perpX = dz; // lot-side axis (perpendicular to faceDir)
    const perpZ = dx;
    const wx = worldX(b.gx);
    const wz = worldZ(b.gz);
    const faceYaw = dirToYaw(b.faceDir);

    if (district.character === "commercial" || district.character === "wharf") {
      // Awning on the street-facing facade.
      if (rng.chance(0.55)) {
        const url = modelUrl("props", rng.pick(AWNINGS));
        const bnd = cache.bounds(url);
        const s = (ROAD_TILE * 0.55) / Math.max(bnd.size.x, bnd.size.z, 0.001);
        const px = wx + dx * ROAD_TILE * 0.42;
        const pz = wz + dz * ROAD_TILE * 0.42;
        place(url, px, terrain.heightAt(px, pz) + 2.6, pz, faceYaw, s);
      }
      // Parasols near wharf street corners.
      if (district.character === "wharf" && rng.chance(0.2)) {
        const corner: 1 | -1 = rng.chance(0.5) ? 1 : -1;
        const px = wx + dx * ROAD_TILE * 0.38 + perpX * corner * ROAD_TILE * 0.3;
        const pz = wz + dz * ROAD_TILE * 0.38 + perpZ * corner * ROAD_TILE * 0.3;
        const url = modelUrl("props", rng.chance(0.5) ? PROP_PARASOL_A : PROP_PARASOL_B);
        seat(url, px, pz, rng.range(0, Math.PI * 2), scaleToHeight(url, 2.4));
      }
    } else if (district.character === "residential" || district.character === "victorian") {
      // Low fences on the two side edges (never the street-facing edge).
      const fenceUrl = modelUrl("props", PROP_FENCE_LOW);
      const fenceAxis = longAxis(fenceUrl);
      for (const sideSign of [1, -1] as const) {
        if (!rng.chance(0.45)) continue;
        const fence = cache.instance(fenceUrl);
        fence.scale.setScalar((ROAD_TILE * 0.88) / fenceAxis.len);
        fence.rotation.y = faceYaw + fenceAxis.yawAdj; // long axis runs street→back
        fence.position.set(
          wx + perpX * sideSign * ROAD_TILE * 0.47 - dx * ROAD_TILE * 0.04,
          0,
          wz + perpZ * sideSign * ROAD_TILE * 0.47 - dz * ROAD_TILE * 0.04,
        );
        drape(fence, 0.06);
      }
      // Front path from the curb to the lot centre.
      if (rng.chance(0.6)) {
        const url = modelUrl("props", rng.chance(0.5) ? PROP_PATH : PROP_PATH_STONES);
        const axis = longAxis(url);
        const path = cache.instance(url);
        path.scale.setScalar((ROAD_TILE * 0.5) / axis.len);
        path.rotation.y = faceYaw + axis.yawAdj;
        path.position.set(wx + dx * ROAD_TILE * 0.25, 0, wz + dz * ROAD_TILE * 0.25);
        drape(path, 0.06);
      }
      // Occasional driveway, offset beside the path.
      if (rng.chance(0.2)) {
        const url = modelUrl("props", PROP_DRIVEWAY);
        const axis = longAxis(url);
        const lat: 1 | -1 = rng.chance(0.5) ? 1 : -1;
        const drive = cache.instance(url);
        drive.scale.setScalar((ROAD_TILE * 0.5) / axis.len);
        drive.rotation.y = faceYaw + axis.yawAdj;
        drive.position.set(
          wx + dx * ROAD_TILE * 0.25 + perpX * lat * ROAD_TILE * 0.24,
          0,
          wz + dz * ROAD_TILE * 0.25 + perpZ * lat * ROAD_TILE * 0.24,
        );
        drape(drive, 0.06);
      }
    } else if (district.character === "industrial" && rng.chance(0.5)) {
      // Dogpatch skyline: 1–2 smokestacks at the lot's back corners.
      const stacks = 1 + rng.int(2);
      const firstCorner: 1 | -1 = rng.chance(0.5) ? 1 : -1;
      for (let i = 0; i < stacks; i++) {
        const corner = i === 0 ? firstCorner : -firstCorner;
        const url = modelUrl("props", rng.pick(CHIMNEYS));
        const px = wx - dx * ROAD_TILE * 0.32 + perpX * corner * ROAD_TILE * 0.3;
        const pz = wz - dz * ROAD_TILE * 0.32 + perpZ * corner * ROAD_TILE * 0.3;
        seat(url, px, pz, rng.range(0, Math.PI * 2), scaleToHeight(url, rng.range(6, 11)));
      }
      if (rng.chance(0.3)) {
        const url = modelUrl("props", PROP_TANK);
        const px = wx - dx * ROAD_TILE * 0.3;
        const pz = wz - dz * ROAD_TILE * 0.3;
        seat(url, px, pz, rng.range(0, Math.PI * 2), scaleToHeight(url, 4));
      }
    }
  }

  // ------------------------------------------------------------------
  // 6. CONSTRUCTION POCKETS — cones + barrier + light across half a lane.
  // ------------------------------------------------------------------
  const pocketCandidates: { gx: number; gz: number; alongX: boolean }[] = [];
  for (let gx = 0; gx < GRID; gx++) {
    for (let gz = 0; gz < GRID; gz++) {
      const road = roadAt(gx, gz);
      if (!road || road.tile !== ROAD_STRAIGHT) continue;
      if (reserved.has(cellKey(gx, gz))) continue;
      if (nearCentre(gx, gz, 3)) continue;
      pocketCandidates.push({ gx, gz, alongX: road.quarterTurns % 2 === 0 });
    }
  }
  const pocketCount = Math.min(CONSTRUCTION_POCKETS, pocketCandidates.length);
  for (let p = 0; p < pocketCount; p++) {
    const idx = rng.int(pocketCandidates.length);
    const cell = pocketCandidates[idx];
    if (cell === undefined) continue;
    pocketCandidates.splice(idx, 1);
    const wx = worldX(cell.gx);
    const wz = worldZ(cell.gz);
    const ax = cell.alongX ? 1 : 0; // road axis
    const az = cell.alongX ? 0 : 1;
    const px = cell.alongX ? 0 : 1; // perpendicular (lane) axis
    const pz = cell.alongX ? 1 : 0;
    const laneSide: 1 | -1 = rng.chance(0.5) ? 1 : -1;
    // Diagonal from the lane edge to the road centre — a chicane, not a wall.
    const at = (t: number): { x: number; z: number } => {
      const along = ROAD_TILE * (-0.3 + 0.6 * t);
      const lateral = laneSide * ROAD_TILE * 0.32 * (1 - t);
      return { x: wx + ax * along + px * lateral, z: wz + az * along + pz * lateral };
    };
    const coneUrl = modelUrl("props", PROP_CONE);
    const coneScale = scaleToHeight(coneUrl, 0.75);
    const cones = 3 + rng.int(2);
    for (let i = 0; i < cones; i++) {
      const t = cones > 1 ? i / (cones - 1) : 0.5;
      const pos = at(t);
      seat(
        coneUrl,
        pos.x + rng.range(-0.3, 0.3),
        pos.z + rng.range(-0.3, 0.3),
        rng.range(0, Math.PI * 2),
        coneScale,
      );
    }
    const barrierYaw = cell.alongX ? HALF_PI : 0; // long axis across the lane
    const bPos = at(0.5);
    const barrierUrl = modelUrl("props", PROP_BARRIER);
    seat(barrierUrl, bPos.x, bPos.z, barrierYaw, scaleToHeight(barrierUrl, 1.1));
    solids.push(
      cell.alongX
        ? { minX: bPos.x - 0.4, maxX: bPos.x + 0.4, minZ: bPos.z - 1.4, maxZ: bPos.z + 1.4 }
        : { minX: bPos.x - 1.4, maxX: bPos.x + 1.4, minZ: bPos.z - 0.4, maxZ: bPos.z + 0.4 },
    );
    const lPos = at(0.08);
    const lightUrl = modelUrl("props", PROP_CONSTRUCTION_LIGHT);
    seat(lightUrl, lPos.x, lPos.z, barrierYaw, scaleToHeight(lightUrl, 2));
  }

  // ------------------------------------------------------------------
  // 7. GOLDEN GATE PARK — tree allées on the edge bands, planter flower
  // beds, and Stow Lake.
  // ------------------------------------------------------------------
  const isGGPark = (gx: number, gz: number): boolean =>
    inBounds(gx, gz) && districtAt(gx, gz).name === "Golden Gate Park";
  const treeUrl = modelUrl("props", TREE_LARGE);
  const planterUrl = modelUrl("props", PROP_PLANTER);
  const planterScale = 1.5 / Math.max(cache.bounds(planterUrl).size.x, 0.001);
  for (let gx = 0; gx < GRID; gx++) {
    for (let gz = 0; gz < GRID; gz++) {
      if (!isGGPark(gx, gz)) continue;
      if (reserved.has(cellKey(gx, gz))) continue;
      if (cellAt(gx, gz) !== "lot") continue; // keep park roads + water clear
      const wx = worldX(gx);
      const wz = worldZ(gz);
      // Regular allées along the park's north/south edge bands (spacing T/2).
      const edges: number[] = [];
      if (!isGGPark(gx, gz - 1)) edges.push(-1);
      if (!isGGPark(gx, gz + 1)) edges.push(1);
      for (const edge of edges) {
        const tz = wz + edge * (ROAD_TILE * 0.5 - 0.9);
        for (const off of [-0.25, 0.25] as const) {
          const tx = wx + off * ROAD_TILE;
          seat(treeUrl, tx, tz, rng.range(0, Math.PI * 2), scaleToHeight(treeUrl, rng.range(5, 6.5)));
        }
      }
      // Planter clusters as flower beds.
      if (rng.chance(0.25)) {
        const count = 3 + rng.int(3);
        for (let i = 0; i < count; i++) {
          const px = wx + rng.range(-2.6, 2.6);
          const pz = wz + rng.range(-2.6, 2.6);
          seat(planterUrl, px, pz, rng.range(0, Math.PI * 2), planterScale);
        }
      }
    }
  }
  // Stow Lake: a flat blue ellipse draped into the park bowl at u≈0.22 v≈0.40.
  const lakeGx = Math.round(0.22 * GRID - 0.5);
  const lakeGz = Math.round(0.4 * GRID - 0.5);
  if (isGGPark(lakeGx, lakeGz) && !reserved.has(cellKey(lakeGx, lakeGz))) {
    const lake = new THREE.Mesh(new THREE.CircleGeometry(1, 48), LAKE_MAT);
    lake.scale.set(ROAD_TILE * 1.15, ROAD_TILE * 0.75, 1);
    lake.rotation.x = -HALF_PI;
    lake.position.set((0.22 - 0.5) * WORLD_SIZE, 0, (0.4 - 0.5) * WORLD_SIZE);
    drape(lake, 0.07);
  }

  // ------------------------------------------------------------------
  // 8. WHARF PIERS — three piers off the Fisherman's Wharf shoreline,
  // flat road-tile decks on bridge-pillar stilts, railed so the taxi can
  // drive out but not fall off. The middle pier gets Pier 39 buildings.
  // ------------------------------------------------------------------
  type PierColumn = { gx: number; landGz: number };
  const pierCandidates: PierColumn[] = [];
  for (let gx = 0; gx < GRID; gx++) {
    let landGz = -1;
    for (let gz = 0; gz < GRID; gz++) {
      if (cellAt(gx, gz) !== "water") {
        landGz = gz;
        break;
      }
    }
    if (landGz < 2) continue; // need at least two water cells to the north
    if (districtAt(gx, landGz).name !== "Fisherman's Wharf") continue;
    // The pier must connect to something drivable: a shore road, or at least
    // an unbuilt lot (built lots have a solid the ramp would dead-end into).
    const shoreKind = cellAt(gx, landGz);
    const shoreBuilt = plan.buildingCells.some((b) => b.gx === gx && b.gz === landGz);
    if (shoreKind !== "road" && shoreBuilt) continue;
    let anyReserved = reserved.has(cellKey(gx, landGz));
    for (let gz = 0; gz < landGz; gz++) {
      if (reserved.has(cellKey(gx, gz))) anyReserved = true;
    }
    if (anyReserved) continue;
    pierCandidates.push({ gx, landGz });
  }
  const chosenPiers: PierColumn[] = [];
  if (pierCandidates.length > 0) {
    const idxs = [
      0,
      Math.floor((pierCandidates.length - 1) / 2),
      pierCandidates.length - 1,
    ];
    for (const i of idxs) {
      const col = pierCandidates[i];
      if (col && !chosenPiers.includes(col)) chosenPiers.push(col);
    }
  }
  const pillarUrl = modelUrl("roads", BRIDGE_PILLAR);
  const pillarBounds = cache.bounds(pillarUrl);
  const deckTileUrl = modelUrl("roads", ROAD_STRAIGHT);
  for (let pierIdx = 0; pierIdx < chosenPiers.length; pierIdx++) {
    const pier = chosenPiers[pierIdx];
    if (pier === undefined) continue;
    const deckY = PIER_DECK_Y + pierIdx * 0.02; // stagger so adjacent decks never z-fight
    const len = Math.min(2 + rng.int(2), pier.landGz); // 2–3 tiles over water
    const px = worldX(pier.gx);
    const boundary = worldZ(pier.landGz) - ROAD_TILE / 2; // shore edge (water is north = -Z)
    // Deck tiles + stilts, one per water cell, flat at deck height.
    for (let i = 1; i <= len; i++) {
      const gz = pier.landGz - i;
      openWaterCells.add(cellKey(pier.gx, gz));
      const tile = cache.instance(deckTileUrl);
      tile.scale.set(PIER_WIDTH, ROAD_TILE, PIER_WIDTH);
      tile.rotation.y = HALF_PI; // run north–south
      tile.position.set(px, deckY, worldZ(gz));
      tile.updateMatrixWorld(true);
      objects.push(tile);
      const pScale = 5.5 / Math.max(pillarBounds.size.y, 0.001);
      const pillar = cache.instance(pillarUrl);
      pillar.scale.setScalar(pScale);
      pillar.position.set(
        px,
        deckY - (pillarBounds.min.y + pillarBounds.size.y) * pScale,
        worldZ(gz),
      );
      pillar.updateMatrixWorld(true);
      objects.push(pillar);
    }
    // Ramp tile connecting the shore grid to the deck (pitched road tile, so
    // the entry reads as part of the street). Local +X ends up pointing north.
    const shoreH = terrain.heightAt(px, boundary + PIER_RAMP_RUN) + ROAD_Y;
    const drop = deckY - shoreH;
    const rampLen = Math.hypot(PIER_RAMP_RUN, drop);
    const ramp = cache.instance(deckTileUrl);
    ramp.scale.set(rampLen, ROAD_TILE, PIER_WIDTH);
    ramp.rotation.order = "YZX";
    ramp.rotation.y = HALF_PI;
    ramp.rotation.z = Math.asin(drop / rampLen);
    ramp.position.set(px, (deckY + shoreH) / 2, boundary + PIER_RAMP_RUN / 2);
    ramp.updateMatrixWorld(true);
    objects.push(ramp);
    // Drivable surface rects: the flat deck plus stepped slices down the ramp
    // (callers snap the car to rect y inside these).
    const halfW = PIER_WIDTH / 2;
    const zNorth = worldZ(pier.landGz - len) - PIER_WIDTH / 2;
    pierDecks.push({ minX: px - halfW, maxX: px + halfW, minZ: zNorth, maxZ: boundary, y: deckY });
    const rampSteps = 3;
    for (let i = 0; i < rampSteps; i++) {
      pierDecks.push({
        minX: px - halfW,
        maxX: px + halfW,
        minZ: boundary + (PIER_RAMP_RUN * i) / rampSteps,
        maxZ: boundary + (PIER_RAMP_RUN * (i + 1)) / rampSteps,
        y: deckY + (shoreH - deckY) * ((i + 0.5) / rampSteps),
      });
    }
    // Wood railings (visual box + matching Solid): both sides + the far end.
    const railLen = boundary - zNorth;
    const railMidZ = (boundary + zNorth) / 2;
    for (const sideSign of [1, -1] as const) {
      const rx = px + sideSign * (halfW - 0.13);
      box(RAIL_MAT, 0.26, 0.6, railLen, rx, deckY + 0.3, railMidZ);
      solids.push({ minX: rx - 0.3, maxX: rx + 0.3, minZ: zNorth, maxZ: boundary });
    }
    box(RAIL_MAT, PIER_WIDTH, 0.6, 0.26, px, deckY + 0.3, zNorth + 0.13);
    solids.push({ minX: px - halfW, maxX: px + halfW, minZ: zNorth - 0.1, maxZ: zNorth + 0.4 });
    // Pier 39: two tinted commercial buildings at the middle pier's end.
    if (pierIdx === 1) {
      for (let i = 0; i < PIER_END_BUILDINGS.length; i++) {
        const name = PIER_END_BUILDINGS[i];
        if (name === undefined) continue;
        const url = modelUrl("buildings", name);
        const bnd = cache.bounds(url);
        const s = (ROAD_TILE * 0.4) / Math.max(bnd.size.x, bnd.size.z, 0.001);
        const bx = px + (i === 0 ? -1 : 1) * ROAD_TILE * 0.24;
        const bz = zNorth + ROAD_TILE * 0.35;
        const node = cache.instance(url);
        tintNode(node, PIER_BUILDING_TINT, 0.5);
        node.scale.setScalar(s);
        node.rotation.y = Math.PI; // face back down the pier toward shore
        node.position.set(bx, deckY, bz);
        node.updateMatrixWorld(true);
        objects.push(node);
        const half = ROAD_TILE * 0.19;
        solids.push({ minX: bx - half, maxX: bx + half, minZ: bz - half, maxZ: bz + half });
      }
    }
  }

  // ------------------------------------------------------------------
  // 9. SEAWALL — concrete lip where wharf/Embarcadero land meets the bay
  // (purely visual; the shoreline solids already exist). Pier cells skipped.
  // ------------------------------------------------------------------
  for (let gx = 0; gx < GRID; gx++) {
    for (let gz = 0; gz < GRID; gz++) {
      if (cellAt(gx, gz) !== "water") continue;
      if (openWaterCells.has(cellKey(gx, gz))) continue;
      if (reserved.has(cellKey(gx, gz))) continue;
      const wx = worldX(gx);
      const wz = worldZ(gz);
      for (const d of DIRS) {
        const [dx, dz] = DIR_DELTA[d];
        const nb = cellAt(gx + dx, gz + dz);
        if (nb !== "road" && nb !== "lot") continue;
        if (districtAt(gx + dx, gz + dz).character !== "wharf") continue;
        // Lip along the shared edge, seated on the land-side ground height.
        const ex = wx + dx * (ROAD_TILE / 2);
        const ez = wz + dz * (ROAD_TILE / 2);
        const groundY = terrain.heightAt(wx + dx * ROAD_TILE * 0.62, wz + dz * ROAD_TILE * 0.62);
        if (dx !== 0) box(SEAWALL_MAT, 0.6, 1.0, ROAD_TILE, ex, groundY + 0.15, ez);
        else box(SEAWALL_MAT, ROAD_TILE, 1.0, 0.6, ex, groundY + 0.15, ez);
      }
    }
  }

  return { objects, solids, openWaterCells, pierDecks };
}
