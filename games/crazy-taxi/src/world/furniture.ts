import * as THREE from "three";

import type { ModelCache } from "../assets/loader";
import {
  BRIDGE_PILLAR,
  BUSHES,
  LIGHT_CURVED,
  LIGHT_CURVED_CROSS,
  LIGHT_OLD,
  LIGHT_OLD_DOUBLE,
  LIGHT_SQUARE,
  LIGHT_SQUARE_DOUBLE,
  modelUrl,
  PARK_ENTRY,
  PARK_TREES,
  PARK_WALL,
  PROP_AWNING,
  PROP_AWNING_WIDE,
  PROP_BARRIER,
  PROP_BENCH,
  PROP_BOX_A,
  PROP_BOX_B,
  PROP_CHIMNEY_LARGE,
  PROP_CHIMNEY_MEDIUM,
  PROP_CHIMNEY_SMALL,
  PROP_CONE,
  PROP_CONSTRUCTION_LIGHT,
  PROP_DRIVEWAY,
  PROP_DUMPSTER,
  PROP_FENCE_LOW,
  PROP_HYDRANT,
  PROP_OVERHANG,
  PROP_PARASOL_A,
  PROP_PARASOL_B,
  PROP_PATH,
  PROP_PATH_STONES,
  PROP_PLANTER,
  PROP_TANK,
  PROP_TRAFFICLIGHT,
  PROP_TRASH_A,
  PROP_TRASH_B,
  PROP_WATERTOWER,
  ROAD_CROSSROAD,
  ROAD_INTERSECTION,
  ROAD_STRAIGHT,
  TRAFFIC_CARS,
  TREE_LARGE,
} from "../assets/manifest";
import { GRID_X, GRID_Z, ROAD_TILE, ROAD_Y, WORLD_H, WORLD_W } from "../shared/constants";
import type { Rng } from "../shared/rng";
import { type Dir, DIR_DELTA, E, N, S, W } from "../shared/types";
import type { Solid } from "./city";
import { conformToTerrain } from "./conform";
import { ASPHALT_W, SIDEWALK_W } from "./roads";
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
// Offsets derive from the procedural street profile (world/roads.ts): lamps
// stand on the sidewalk, parked cars sit inside the outer parking lane.
const LIGHT_LATERAL = ASPHALT_W / 2 + SIDEWALK_W * 0.45;
const PARK_LATERAL = ASPHALT_W / 2 - 1.05;
const PIER_DECK_Y = 0.55; // flat pier deck height over the water
const PIER_WIDTH = ROAD_TILE * 1.03; // decks scaled like road tiles
const PIER_RAMP_RUN = ROAD_TILE * 0.6; // horizontal run of the shore→deck ramp
const PIER_DECK_MAT = new THREE.MeshStandardMaterial({ color: 0x9c8158, roughness: 0.9 });
const CONSTRUCTION_POCKETS = 6;

// Model catalogs used only here.
const AWNINGS: readonly string[] = [PROP_AWNING, PROP_AWNING_WIDE, PROP_OVERHANG];
const CHIMNEYS: readonly string[] = [PROP_CHIMNEY_SMALL, PROP_CHIMNEY_MEDIUM, PROP_CHIMNEY_LARGE];
// Pier 39 stand-ins at the middle pier's end (commercial kit, tinted brick-red).
const PIER_END_BUILDINGS: readonly string[] = ["com-building-a", "com-building-f"];
const PIER_BUILDING_TINT = 0xc45a3a;
// KayKit props run warmer than the Kenney kits — nudge them toward the Kenney
// paper tone so the street reads as one palette. Tints go through tintMaterial,
// so each (material, tint) pair clones exactly once and merged batches stay few.
const KK_TINT = 0xd8d2c4;
const KK_TINT_AMT = 0.15;
// KayKit pass caps + sizes.
const HYDRANT_CAP = 40;
const SIGNAL_CAP = 25;
const SEATING_CAP = 50; // benches + trash cans combined
const VICTORIAN_LAMP_HEIGHT = 4.2;

// Shared static geometry/materials at module scope so merged batches stay few.
const UNIT_BOX = new THREE.BoxGeometry(1, 1, 1);
const RAIL_MAT = new THREE.MeshStandardMaterial({ color: 0x8a6f4d, roughness: 0.9 }); // pier wood
const SEAWALL_MAT = new THREE.MeshStandardMaterial({ color: 0x9aa2a6, roughness: 1 }); // concrete lip
const LAKE_MAT = new THREE.MeshStandardMaterial({ color: 0x3f6f8f, roughness: 0.4 }); // Stow Lake
const PATH_MAT = new THREE.MeshStandardMaterial({ color: 0xd9c3a1, roughness: 1 }); // park paths

// Tint via per-instance color (picked up by the city batcher's setColorAt) —
// tint variants no longer clone materials or multiply batch count.
function tintNode(node: THREE.Object3D, hex: number, amt: number): void {
  node.traverse((c) => {
    if (c instanceof THREE.Mesh && c.material instanceof THREE.MeshStandardMaterial) {
      c.userData.tint = c.material.color.clone().lerp(new THREE.Color(hex), amt);
    }
  });
}

const cellKey = (gx: number, gz: number): string => `${gx},${gz}`;
const inBounds = (gx: number, gz: number): boolean => gx >= 0 && gz >= 0 && gx < GRID_X && gz < GRID_Z;

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
  // Road axis from actual neighbours — tile quarterTurns encode the tile set's
  // native orientation and flip when the set changes; neighbours never lie.
  const straightAlongX = (gx: number, gz: number): boolean =>
    cellAt(gx + 1, gz) === "road" || cellAt(gx - 1, gz) === "road";
  const centreX = (GRID_X - 1) / 2;
  const centreZ = (GRID_Z - 1) / 2;
  const nearCentre = (gx: number, gz: number, r: number): boolean =>
    Math.hypot(gx - centreX, gz - centreZ) <= r;

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
  // KayKit variants: same as place/seat but tinted toward the Kenney palette.
  const placeKK = (url: string, x: number, y: number, z: number, yaw: number, s: number): void => {
    const node = cache.instance(url);
    tintNode(node, KK_TINT, KK_TINT_AMT);
    node.scale.setScalar(s);
    node.rotation.y = yaw;
    node.position.set(x, y, z);
    node.updateMatrixWorld(true);
    objects.push(node);
  };
  const seatKK = (url: string, x: number, z: number, yaw: number, s: number): void => {
    placeKK(url, x, terrain.heightAt(x, z), z, yaw, s);
  };
  // True when a 4-neighbor is a junction tile (crossroad or T).
  const nextToJunction = (gx: number, gz: number): boolean => {
    for (const d of DIRS) {
      const [dx, dz] = DIR_DELTA[d];
      const nb = roadAt(gx + dx, gz + dz);
      if (nb && (nb.tile === ROAD_CROSSROAD || nb.tile === ROAD_INTERSECTION)) return true;
    }
    return false;
  };
  // Mirrors city.ts's decoratedTile: straights feeding a junction in walkable
  // districts render as zebra crossings.
  const isCrossingCell = (gx: number, gz: number): boolean => {
    const r = roadAt(gx, gz);
    if (!r || r.tile !== ROAD_STRAIGHT) return false;
    const c = districtAt(gx, gz).character;
    if (c !== "commercial" && c !== "downtown" && c !== "wharf" && c !== "victorian") return false;
    return nextToJunction(gx, gz);
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
  for (let gx = 0; gx < GRID_X; gx++) {
    for (let gz = 0; gz < GRID_Z; gz++) {
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
      const alongX = straightAlongX(gx, gz);
      const side: 1 | -1 = Math.floor((gx + gz) / 2) % 2 === 0 ? 1 : -1;
      const wx = worldX(gx);
      const wz = worldZ(gz);
      const px = alongX ? wx : wx + side * LIGHT_LATERAL;
      const pz = alongX ? wz + side * LIGHT_LATERAL : wz;
      // Lamp arm (local +Z) points back toward the road centreline.
      const yaw = alongX ? (side > 0 ? Math.PI : 0) : -side * HALF_PI;
      const char = districtAt(gx, gz).character;
      if (char === "victorian") {
        // Gas-lamp era ironwork; a two-lantern post where a crossing is next
        // door. The double's lanterns run local ±X, so quarter-turn the arm
        // rule to swing them curb→road.
        let doubled = false;
        for (const d of DIRS) {
          const [dx, dz] = DIR_DELTA[d];
          if (isCrossingCell(gx + dx, gz + dz)) doubled = true;
        }
        const url = modelUrl("props", doubled ? LIGHT_OLD_DOUBLE : LIGHT_OLD);
        const kkYaw = doubled ? yaw + HALF_PI : yaw;
        seatKK(url, px, pz, kkYaw, scaleToHeight(url, VICTORIAN_LAMP_HEIGHT));
      } else {
        const url = modelUrl("props", lightFor(char));
        seat(url, px, pz, yaw, scaleToHeight(url, LIGHT_HEIGHT));
      }
      lightSide.set(cellKey(gx, gz), side);
    }
  }

  // ------------------------------------------------------------------
  // 2. PARKED CARS — curbs of residential/victorian/commercial streets.
  // ------------------------------------------------------------------
  for (let gx = 0; gx < GRID_X; gx++) {
    for (let gz = 0; gz < GRID_Z; gz++) {
      const road = roadAt(gx, gz);
      if (!road || road.tile !== ROAD_STRAIGHT) continue;
      if (reserved.has(cellKey(gx, gz))) continue;
      if (nearCentre(gx, gz, 2)) continue; // keep the spawn block clear
      const char = districtAt(gx, gz).character;
      if (char !== "residential" && char !== "victorian" && char !== "commercial") continue;
      if (!rng.chance(0.3)) continue;
      const taken = lightSide.get(cellKey(gx, gz));
      const side: 1 | -1 = taken !== undefined ? (taken > 0 ? -1 : 1) : rng.chance(0.5) ? 1 : -1;
      const alongX = straightAlongX(gx, gz);
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
  // Mirrors the building pass: lots too steep to build get greenery, so no
  // awnings/fences/yard bits should orphan there either.
  const steepLot = (gx: number, gz: number): boolean => {
    const wx = worldX(gx);
    const wz = worldZ(gz);
    const fh = ROAD_TILE * 0.4;
    const hs = [
      terrain.heightAt(wx - fh, wz - fh),
      terrain.heightAt(wx + fh, wz - fh),
      terrain.heightAt(wx - fh, wz + fh),
      terrain.heightAt(wx + fh, wz + fh),
    ];
    return Math.max(...hs) - Math.min(...hs) > 5;
  };
  for (const b of plan.buildingCells) {
    if (reserved.has(cellKey(b.gx, b.gz))) continue;
    if (steepLot(b.gx, b.gz)) continue;
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
  for (let gx = 0; gx < GRID_X; gx++) {
    for (let gz = 0; gz < GRID_Z; gz++) {
      const road = roadAt(gx, gz);
      if (!road || road.tile !== ROAD_STRAIGHT) continue;
      if (reserved.has(cellKey(gx, gz))) continue;
      if (nearCentre(gx, gz, 3)) continue;
      pocketCandidates.push({ gx, gz, alongX: straightAlongX(gx, gz) });
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
  for (let gx = 0; gx < GRID_X; gx++) {
    for (let gz = 0; gz < GRID_Z; gz++) {
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
  const lakeGx = Math.round(0.22 * GRID_X - 0.5);
  const lakeGz = Math.round(0.4 * GRID_Z - 0.5);
  if (isGGPark(lakeGx, lakeGz) && !reserved.has(cellKey(lakeGx, lakeGz))) {
    const lake = new THREE.Mesh(new THREE.CircleGeometry(1, 48), LAKE_MAT);
    lake.scale.set(ROAD_TILE * 1.15, ROAD_TILE * 0.75, 1);
    lake.rotation.x = -HALF_PI;
    lake.position.set((0.22 - 0.5) * WORLD_W, 0, (0.4 - 0.5) * WORLD_H);
    drape(lake, 0.07);
  }

  // ------------------------------------------------------------------
  // 7b. PARK BLOCKS (all park districts) — the KayKit-sample look: low
  // stone walls with entry gates on road-facing edges, fountains where
  // tan paths cross, benches + lamps around them, bushes and blobby
  // KayKit trees filling the lawns.
  // ------------------------------------------------------------------
  const isParkCell = (gx: number, gz: number): boolean =>
    inBounds(gx, gz) && cellAt(gx, gz) === "lot" && districtAt(gx, gz).character === "park";
  const wallUrl = modelUrl("props", PARK_WALL);
  const entryUrl = modelUrl("props", PARK_ENTRY);
  const wallBounds = cache.bounds(wallUrl);
  const wallH = 1.1 / Math.max(wallBounds.size.y, 0.001); // low stone wall
  const parkBenchUrl = modelUrl("props", PROP_BENCH);
  const parkLampUrl = modelUrl("props", LIGHT_OLD);
  for (let gx = 0; gx < GRID_X; gx++) {
    for (let gz = 0; gz < GRID_Z; gz++) {
      if (!isParkCell(gx, gz)) continue;
      if (reserved.has(cellKey(gx, gz))) continue;
      const wx = worldX(gx);
      const wz = worldZ(gz);

      // Walls + a centre entry on every edge that faces a road.
      for (const d of DIRS) {
        const [dx, dz] = DIR_DELTA[d];
        if (cellAt(gx + dx, gz + dz) !== "road") continue;
        const edgeOff = ROAD_TILE / 2 - 0.5;
        const along = dx === 0 ? "x" : "z"; // wall runs perpendicular to dir
        const runLen = ROAD_TILE / 2 - 2.2; // leave a 4.4u centre gap
        // The KayKit wall piece runs along its LOCAL Z — scale the run there
        // and yaw so that axis lies along the park edge (X-edges need the 90°).
        const wallRun = runLen / Math.max(wallBounds.size.z, 0.001);
        for (const side of [-1, 1] as const) {
          const mid = side * (2.2 + runLen / 2);
          const px = along === "x" ? wx + mid : wx + dx * edgeOff;
          const pz = along === "x" ? wz + dz * edgeOff : wz + mid;
          const wall = cache.instance(wallUrl);
          wall.scale.set(wallH, wallH, wallRun);
          wall.rotation.y = along === "x" ? HALF_PI : 0;
          wall.position.set(px, terrain.heightAt(px, pz), pz);
          wall.updateMatrixWorld(true);
          objects.push(wall);
          // Matching low solid so the wall is real (enter via the gate).
          const t = 0.5;
          solids.push(
            along === "x"
              ? {
                  minX: px - runLen / 2,
                  maxX: px + runLen / 2,
                  minZ: pz - t,
                  maxZ: pz + t,
                  maxY: terrain.heightAt(px, pz) + 1.4,
                }
              : {
                  minX: px - t,
                  maxX: px + t,
                  minZ: pz - runLen / 2,
                  maxZ: pz + runLen / 2,
                  maxY: terrain.heightAt(px, pz) + 1.4,
                },
          );
        }
        // Gate posts at the entry gap.
        const ex = along === "x" ? wx : wx + dx * edgeOff;
        const ez = along === "x" ? wz + dz * edgeOff : wz;
        seat(entryUrl, ex, ez, along === "x" ? HALF_PI : 0, scaleToHeight(entryUrl, 2.3));
      }

      // Fountain plaza: basin + water + radiating tan paths + benches/lamps.
      if (rng.chance(0.08)) {
        const fy = terrain.heightAt(wx, wz);
        const basin = new THREE.Mesh(new THREE.CylinderGeometry(2.4, 2.7, 0.75, 18), SEAWALL_MAT);
        basin.position.set(wx, fy + 0.35, wz);
        basin.updateMatrixWorld(true);
        objects.push(basin);
        const water = new THREE.Mesh(new THREE.CircleGeometry(2.1, 18), LAKE_MAT);
        water.rotation.x = -HALF_PI;
        water.position.set(wx, fy + 0.72, wz);
        water.updateMatrixWorld(true);
        objects.push(water);
        const spire = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.55, 1.5, 10), SEAWALL_MAT);
        spire.position.set(wx, fy + 1.3, wz);
        spire.updateMatrixWorld(true);
        objects.push(spire);
        // Tan paths out to each edge.
        for (const [px, pz] of [
          [1, 0],
          [-1, 0],
          [0, 1],
          [0, -1],
        ] as const) {
          const path = new THREE.Mesh(new THREE.PlaneGeometry(2.4, ROAD_TILE / 2 - 2.4, 1, 3), PATH_MAT);
          path.rotation.x = -HALF_PI;
          path.rotation.z = px !== 0 ? HALF_PI : 0;
          const off = 2.6 + (ROAD_TILE / 2 - 2.4) / 2;
          path.position.set(wx + px * off, 0, wz + pz * off);
          drape(path, 0.06);
        }
        // Benches facing the water, victorian lamps at the diagonals.
        for (const [bx, bz] of [
          [3.6, 0],
          [-3.6, 0],
          [0, 3.6],
          [0, -3.6],
        ] as const) {
          if (!rng.chance(0.75)) continue;
          const yaw = Math.atan2(-bx, -bz);
          seat(parkBenchUrl, wx + bx, wz + bz, yaw, scaleToHeight(parkBenchUrl, 0.85));
        }
        for (const [lx, lz] of [
          [3.2, 3.2],
          [-3.2, -3.2],
        ] as const) {
          seat(parkLampUrl, wx + lx, wz + lz, 0, scaleToHeight(parkLampUrl, 4.2));
        }
      } else {
        // Lawn cells: bushes + blobby KayKit trees (denser than street green).
        const bushes = 2 + rng.int(3);
        for (let i = 0; i < bushes; i++) {
          const bUrl = modelUrl("props", rng.pick(BUSHES));
          seat(
            bUrl,
            wx + rng.range(-4.6, 4.6),
            wz + rng.range(-4.6, 4.6),
            rng.range(0, Math.PI * 2),
            scaleToHeight(bUrl, rng.range(0.8, 1.5)),
          );
        }
        if (rng.chance(0.55)) {
          const count = 1 + rng.int(2);
          for (let i = 0; i < count; i++) {
            const tUrl = modelUrl("props", rng.pick(PARK_TREES));
            seat(
              tUrl,
              wx + rng.range(-4, 4),
              wz + rng.range(-4, 4),
              rng.range(0, Math.PI * 2),
              scaleToHeight(tUrl, rng.range(4.5, 6.5)),
            );
          }
        }
      }
    }
  }

  // ------------------------------------------------------------------
  // 8. WHARF PIERS — three piers off the Fisherman's Wharf shoreline,
  // flat road-tile decks on bridge-pillar stilts, railed so the taxi can
  // drive out but not fall off. The middle pier gets Pier 39 buildings.
  // ------------------------------------------------------------------
  type PierColumn = { gx: number; landGz: number };
  const pierCandidates: PierColumn[] = [];
  for (let gx = 0; gx < GRID_X; gx++) {
    let landGz = -1;
    for (let gz = 0; gz < GRID_Z; gz++) {
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
      // Generated deck slab — top face exactly at deck height.
      const tile = new THREE.Mesh(new THREE.BoxGeometry(PIER_WIDTH, 0.5, PIER_WIDTH), PIER_DECK_MAT);
      tile.castShadow = true;
      tile.receiveShadow = true;
      tile.position.set(px, deckY - 0.25, worldZ(gz));
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
    // Ramp slab connecting the shore grid to the deck (pitched box; the car
    // rides the stepped surface rects below, the slab just has to match).
    const shoreH = terrain.heightAt(px, boundary + PIER_RAMP_RUN) + ROAD_Y;
    const drop = deckY - shoreH;
    const rampLen = Math.hypot(PIER_RAMP_RUN, drop);
    const ramp = new THREE.Mesh(new THREE.BoxGeometry(PIER_WIDTH, 0.5, rampLen), PIER_DECK_MAT);
    ramp.castShadow = true;
    ramp.receiveShadow = true;
    ramp.rotation.x = Math.atan(drop / PIER_RAMP_RUN);
    ramp.position.set(px, (deckY + shoreH) / 2 - 0.25, boundary + PIER_RAMP_RUN / 2);
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
  for (let gx = 0; gx < GRID_X; gx++) {
    for (let gz = 0; gz < GRID_Z; gz++) {
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

  // ------------------------------------------------------------------
  // 10. FIRE HYDRANTS — sidewalk corners of walkable streets that feed a
  // junction (where SF actually puts them).
  // ------------------------------------------------------------------
  const hydrantUrl = modelUrl("props", PROP_HYDRANT);
  const hydrantScale = scaleToHeight(hydrantUrl, 0.9);
  let hydrants = 0;
  for (let gx = 0; gx < GRID_X && hydrants < HYDRANT_CAP; gx++) {
    for (let gz = 0; gz < GRID_Z && hydrants < HYDRANT_CAP; gz++) {
      if (!roadAt(gx, gz)) continue;
      if (reserved.has(cellKey(gx, gz))) continue;
      const char = districtAt(gx, gz).character;
      if (char !== "commercial" && char !== "downtown" && char !== "wharf") continue;
      if (!nextToJunction(gx, gz)) continue;
      if (!rng.chance(0.3)) continue;
      const sx: 1 | -1 = rng.chance(0.5) ? 1 : -1;
      const sz: 1 | -1 = rng.chance(0.5) ? 1 : -1;
      const px = worldX(gx) + sx * ROAD_TILE * 0.42;
      const pz = worldZ(gz) + sz * ROAD_TILE * 0.42;
      seatKK(hydrantUrl, px, pz, rng.range(0, Math.PI * 2), hydrantScale);
      hydrants++;
    }
  }

  // ------------------------------------------------------------------
  // 11. TRAFFIC SIGNALS — downtown/highrise crossroads get one corner
  // signal, arm swung out over the junction.
  // ------------------------------------------------------------------
  const signalUrl = modelUrl("props", PROP_TRAFFICLIGHT);
  const signalScale = scaleToHeight(signalUrl, 5);
  let signals = 0;
  for (let gx = 0; gx < GRID_X && signals < SIGNAL_CAP; gx++) {
    for (let gz = 0; gz < GRID_Z && signals < SIGNAL_CAP; gz++) {
      const road = roadAt(gx, gz);
      if (!road || road.tile !== ROAD_CROSSROAD) continue;
      if (reserved.has(cellKey(gx, gz))) continue;
      const char = districtAt(gx, gz).character;
      if (char !== "downtown" && char !== "highrise") continue;
      const sx: 1 | -1 = rng.chance(0.5) ? 1 : -1;
      const sz: 1 | -1 = rng.chance(0.5) ? 1 : -1;
      const px = worldX(gx) + sx * ROAD_TILE * 0.44;
      const pz = worldZ(gz) + sz * ROAD_TILE * 0.44;
      // The signal arm hangs along local -X: yaw so -X points back across the
      // corner toward the junction centre.
      seatKK(signalUrl, px, pz, Math.atan2(-sz, sx), signalScale);
      signals++;
    }
  }

  // ------------------------------------------------------------------
  // 12. BENCHES + TRASH — wharf/park kerbs that front a lot or green get a
  // bench facing the street with a trash can beside it.
  // ------------------------------------------------------------------
  const benchUrl = modelUrl("props", PROP_BENCH);
  const benchScale = scaleToHeight(benchUrl, 0.85);
  let seating = 0;
  for (let gx = 0; gx < GRID_X && seating < SEATING_CAP; gx++) {
    for (let gz = 0; gz < GRID_Z && seating < SEATING_CAP; gz++) {
      const road = roadAt(gx, gz);
      if (!road) continue;
      if (reserved.has(cellKey(gx, gz))) continue;
      const char = districtAt(gx, gz).character;
      if (char !== "wharf" && char !== "park") continue;
      let lotDir: Dir | null = null;
      for (const d of DIRS) {
        const [dx, dz] = DIR_DELTA[d];
        if (cellAt(gx + dx, gz + dz) === "lot") {
          lotDir = d;
          break;
        }
      }
      if (lotDir === null) continue;
      if (!rng.chance(0.25)) continue;
      const [dx, dz] = DIR_DELTA[lotDir];
      // If this cell's streetlight took the same kerb, slide down the block.
      const lampSide = lightSide.get(cellKey(gx, gz));
      const alongX = road.tile === ROAD_STRAIGHT && straightAlongX(gx, gz);
      const clash = lampSide !== undefined && (alongX ? dz : dx) === lampSide;
      const slide = clash ? ROAD_TILE * 0.24 : 0;
      // perp (dz, dx) runs along the kerb; lotDir is the lateral axis.
      const bx = worldX(gx) + dx * ROAD_TILE * 0.42 + dz * slide;
      const bz = worldZ(gz) + dz * ROAD_TILE * 0.42 + dx * slide;
      // Back to the lot: bench long axis (local X) runs parallel to the road.
      seatKK(benchUrl, bx, bz, dirToYaw(lotDir) + Math.PI, benchScale);
      seating++;
      if (seating >= SEATING_CAP) break;
      const along: 1 | -1 = clash ? 1 : rng.chance(0.5) ? 1 : -1;
      const trashUrl = modelUrl("props", rng.chance(0.5) ? PROP_TRASH_A : PROP_TRASH_B);
      const trashBounds = cache.bounds(trashUrl);
      // KayKit's "trash" is a low kerbside pile, not a can — size it by
      // footprint (scaling to a can's height would blow it up 17×).
      const trashScale = 0.55 / Math.max(trashBounds.size.x, trashBounds.size.z, 0.001);
      seatKK(
        trashUrl,
        bx + dz * along * 1.3,
        bz + dx * along * 1.3,
        rng.range(0, Math.PI * 2),
        trashScale,
      );
      seating++;
    }
  }

  // ------------------------------------------------------------------
  // 13. DUMPSTERS + CRATES — service clutter at industrial back corners
  // (offsets tucked inside the smokestack ring so the two passes coexist).
  // ------------------------------------------------------------------
  const dumpsterUrl = modelUrl("props", PROP_DUMPSTER);
  const dumpsterScale = scaleToHeight(dumpsterUrl, 1.5);
  for (const b of plan.buildingCells) {
    if (reserved.has(cellKey(b.gx, b.gz))) continue;
    if (districtAt(b.gx, b.gz).character !== "industrial") continue;
    const [dx, dz] = DIR_DELTA[b.faceDir];
    const perpX = dz;
    const perpZ = dx;
    const wx = worldX(b.gx);
    const wz = worldZ(b.gz);
    if (rng.chance(0.4)) {
      const corner: 1 | -1 = rng.chance(0.5) ? 1 : -1;
      const px = wx - dx * ROAD_TILE * 0.4 + perpX * corner * ROAD_TILE * 0.16;
      const pz = wz - dz * ROAD_TILE * 0.4 + perpZ * corner * ROAD_TILE * 0.16;
      // Long axis (local X) parallel to the back wall, hand-shoved jitter.
      seatKK(dumpsterUrl, px, pz, dirToYaw(b.faceDir) + rng.range(-0.08, 0.08), dumpsterScale);
    }
    if (rng.chance(0.5)) {
      const crates = 1 + rng.int(2);
      for (let i = 0; i < crates; i++) {
        const url = modelUrl("props", rng.chance(0.5) ? PROP_BOX_A : PROP_BOX_B);
        const back = 0.28 + rng.range(0, 0.1);
        const lat = rng.range(-0.24, 0.24);
        const px = wx - dx * ROAD_TILE * back + perpX * lat * ROAD_TILE;
        const pz = wz - dz * ROAD_TILE * back + perpZ * lat * ROAD_TILE;
        seatKK(url, px, pz, rng.range(0, Math.PI * 2), scaleToHeight(url, 0.8));
      }
    }
  }

  // ------------------------------------------------------------------
  // 14. WATER TOWERS — 2–3 tank-on-legs landmarks for the Dogpatch skyline,
  // tall enough that the tank clears the host building's roofline.
  // ------------------------------------------------------------------
  const towerLots = plan.buildingCells.filter(
    (b) => !reserved.has(cellKey(b.gx, b.gz)) && districtAt(b.gx, b.gz).character === "industrial",
  );
  const towerUrl = modelUrl("props", PROP_WATERTOWER);
  const towerScale = scaleToHeight(towerUrl, 13);
  const towerCount = Math.min(2 + rng.int(2), towerLots.length);
  for (let i = 0; i < towerCount; i++) {
    const idx = rng.int(towerLots.length);
    const lot = towerLots[idx];
    if (lot === undefined) continue;
    towerLots.splice(idx, 1);
    const [dx, dz] = DIR_DELTA[lot.faceDir];
    const px = worldX(lot.gx) - dx * ROAD_TILE * 0.18;
    const pz = worldZ(lot.gz) - dz * ROAD_TILE * 0.18;
    seatKK(towerUrl, px, pz, rng.range(0, Math.PI * 2), towerScale);
  }

  return { objects, solids, openWaterCells, pierDecks };
}
