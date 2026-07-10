import * as THREE from "three";

import { GRID_X, GRID_Z, ROAD_TILE, WORLD_HALF_X, WORLD_HALF_Z, WORLD_W } from "../shared/constants";
import { CUSTOM_MAP, type FloorKind, loadLocalOverrides } from "./custom-map";
import type { CityPlan } from "./grid";
import type { RoadNetwork } from "./network";
import { districtAt } from "./sf-map";
import type { Terrain } from "./terrain";
import { landuseGreenAt, landuseSandAt } from "./sf-landuse";

// Ground shading + street-depression callbacks, extracted so the gen worker
// and the main thread run EXACTLY the same code (a fork here would paint two
// different cities).

const CONCRETE = new THREE.Color(0x9a9b92);
const SAND = new THREE.Color(0xd9c9a1);
const PARK = new THREE.Color(0x67a86b); // matched to the KayKit tile green

const gridX = (x: number): number => Math.floor((x + WORLD_HALF_X) / ROAD_TILE);
const gridZ = (z: number): number => Math.floor((z + WORLD_HALF_Z) / ROAD_TILE);

export function makeGroundColorAt(
  plan: CityPlan,
  terrain: Terrain,
): (x: number, z: number, into: THREE.Color) => void {
  const greenSet = new Set(plan.greenCells.map((g) => `${g.gx},${g.gz}`));
  // Painted floors (editor "Floor" mode): baked + this browser's local edits.
  const floorAt = new Map<string, FloorKind>();
  const local = loadLocalOverrides();
  for (const [fgx, fgz, kind] of [...CUSTOM_MAP.floor, ...local.floor]) {
    floorAt.set(`${fgx},${fgz}`, kind);
  }
  return (x, z, into) => {
    into.copy(CONCRETE);
    const gx = Math.min(GRID_X - 1, Math.max(0, gridX(x)));
    const gz = Math.min(GRID_Z - 1, Math.max(0, gridZ(z)));
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
    const land = terrain.landAt(x, z);
    const shore = 1 - THREE.MathUtils.smoothstep(land, 0.3, 0.55);
    if (shore > 0) {
      const u = x / WORLD_W + 0.5;
      into.lerp(SAND, u < 0.12 ? shore : shore * 0.5); // Ocean Beach reads strongest
    }
  };
}

// Park cells are TILE territory: the ground flattens each park cell to one
// terraced height (sampled at the cell centre) so KayKit park tiles seat on
// it exactly — the "grid for tiles, curves for roads" rule.
export function isParkCell(gx: number, gz: number): boolean {
  return landuseGreenAt(gx, gz) || districtAt(gx, gz).character === "park";
}

export function parkCellHeight(
  terrain: Terrain,
  gx: number,
  gz: number,
): number {
  // Seat at the HIGHEST corner. No quantization: tiles only go on flat
  // cells now, where neighbours land within centimetres of each other —
  // no visible layering.
  const x0 = gx * ROAD_TILE - WORLD_HALF_X;
  const z0 = gz * ROAD_TILE - WORLD_HALF_Z;
  const h = Math.max(
    terrain.heightAt(x0, z0),
    terrain.heightAt(x0 + ROAD_TILE, z0),
    terrain.heightAt(x0, z0 + ROAD_TILE),
    terrain.heightAt(x0 + ROAD_TILE, z0 + ROAD_TILE),
    terrain.heightAt(x0 + ROAD_TILE / 2, z0 + ROAD_TILE / 2),
  );
  return h + 0.05;
}

export function parkCellFloor(terrain: Terrain, gx: number, gz: number): number {
  const x0 = gx * ROAD_TILE - WORLD_HALF_X;
  const z0 = gz * ROAD_TILE - WORLD_HALF_Z;
  return Math.min(
    terrain.heightAt(x0, z0),
    terrain.heightAt(x0 + ROAD_TILE, z0),
    terrain.heightAt(x0, z0 + ROAD_TILE),
    terrain.heightAt(x0 + ROAD_TILE, z0 + ROAD_TILE),
  );
}

// Street depression profile: the ground drops −0.35 under the pavement
// (clearance v < 1.6 beyond the asphalt edge) and feathers back to the
// natural field by v = 4.6.
function streetDepression(v: number): number {
  if (v > 4.6) return 0;
  return v < 1.6 ? -0.35 : -0.35 * Math.max(0, 1 - (v - 1.6) / 3);
}

// Clearance field: for every ~3.25u cell, (distance to nearest edge
// centreline − that edge's half width; 1e9 far from any street). Stamped once
// along each edge — O(street length) — then lookups are O(1).
function makeClearanceAt(network: RoadNetwork): (x: number, z: number) => number {
  const RES = ROAD_TILE / 4;
  const FW = Math.ceil((WORLD_HALF_X * 2) / RES) + 2;
  const FH = Math.ceil((WORLD_HALF_Z * 2) / RES) + 2;
  const field = new Float32Array(FW * FH).fill(1e9);
  const BAND = 5.2; // pave apron 1.6 + feather 3 + slack
  for (const e of network.edges) {
    const band = e.half + BAND;
    for (let k = 0; k + 3 < e.pts.length; k += 2) {
      const ax = e.pts[k] ?? 0;
      const az = e.pts[k + 1] ?? 0;
      const bx = e.pts[k + 2] ?? 0;
      const bz = e.pts[k + 3] ?? 0;
      const i0 = Math.max(0, Math.floor((Math.min(ax, bx) - band + WORLD_HALF_X) / RES));
      const i1 = Math.min(FW - 1, Math.ceil((Math.max(ax, bx) + band + WORLD_HALF_X) / RES));
      const j0 = Math.max(0, Math.floor((Math.min(az, bz) - band + WORLD_HALF_Z) / RES));
      const j1 = Math.min(FH - 1, Math.ceil((Math.max(az, bz) + band + WORLD_HALF_Z) / RES));
      const dx = bx - ax;
      const dz = bz - az;
      const l2 = dx * dx + dz * dz || 1;
      for (let i = i0; i <= i1; i++) {
        const px = i * RES - WORLD_HALF_X;
        for (let j = j0; j <= j1; j++) {
          const pz = j * RES - WORLD_HALF_Z;
          let t = ((px - ax) * dx + (pz - az) * dz) / l2;
          t = t < 0 ? 0 : t > 1 ? 1 : t;
          const d = Math.hypot(px - (ax + dx * t), pz - (az + dz * t)) - e.half;
          const idx = i * FH + j;
          const cur = field[idx];
          if (cur === undefined || d < cur) field[idx] = d;
        }
      }
    }
  }
  return (x: number, z: number): number => {
    const i = Math.round((x + WORLD_HALF_X) / RES);
    const j = Math.round((z + WORLD_HALF_Z) / RES);
    if (i >= 0 && j >= 0 && i < FW && j < FH) {
      const v = field[i * FH + j];
      if (v !== undefined) return v;
    }
    return 1e9;
  };
}

// Ground-mesh vertex offset: the street depression, everywhere.
export function makeGroundOffset(
  network: RoadNetwork,
  terrain?: Terrain,
): (x: number, z: number) => number {
  void terrain;
  const clearanceAt = makeClearanceAt(network);
  return (x, z) => streetDepression(clearanceAt(x, z));
}

// Offset of the RENDERED top surface relative to the raw height field, for
// the driving/height queries (city.heightAt). The paved band — curb +
// sidewalk, SIDEWALK_W beyond the asphalt edge — rides at field level like
// the asphalt does; past its outer edge the exposed ground is the
// street-depressed mesh. Without this the car hovers on the invisible raw
// field next to downhill kerbs (the visible ground there sits up to 0.35
// lower).
export function makeDriveSurfaceOffset(network: RoadNetwork): (x: number, z: number) => number {
  const clearanceAt = makeClearanceAt(network);
  return (x, z) => {
    const v = clearanceAt(x, z);
    if (v <= SIDEWALK_W) return 0; // asphalt / curb / sidewalk
    return streetDepression(v);
  };
}
