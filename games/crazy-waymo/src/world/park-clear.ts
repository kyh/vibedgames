import { GRID_X, GRID_Z, ROAD_TILE, WORLD_HALF_X, WORLD_HALF_Z } from "../shared/constants";
import { landuseGreenAt } from "./sf-landuse";
import { districtAt } from "./sf-map";
import { type RawEdge, SF_EDGES } from "./sf-network";

// Parks are car-free. The OSM network threads streets through every big green
// (JFK through GGP, paths through Dolores/Alamo/the Panhandle) — as CITY
// streets they read wrong. Drop park-interior edges from the vector network,
// keeping only the highway class (19th Ave / Crossover / Park Presidio), and
// give the grid the matching cell-level test. Freed road cells become park
// lots; furniture lays KayKit park paths along them instead.

export const PARK_KEEP_HALF = 7.0; // >= this half-width survives inside parks

// The one road allowed through Golden Gate Park: the Hwy-1 corridor
// (Park Presidio → Crossover Dr → 19th Ave). Its baked chain mixes 7.2 and
// 6.4 half-width segments — without the corridor exemption the 6.4 links
// drop and the highway fragments into dead stubs.
const CROSSOVER_X0 = -430;
const CROSSOVER_X1 = -320;
const CROSSOVER_KEEP_HALF = 6.0;

// Park test = OSM landuse OR traced park district (Dolores etc. are stamped
// as districts; landuse alone misses parts of them) — mirrors ground.ts.
// The Presidio is EXEMPT: it's parkland with a real street network (and the
// Golden Gate Bridge approach anchors on its northernmost road cell).
export const parkCell = (gx: number, gz: number): boolean => {
  if (gx < 0 || gz < 0 || gx >= GRID_X || gz >= GRID_Z) return false;
  const d = districtAt(gx, gz);
  if (d.name === "the Presidio") return false;
  return landuseGreenAt(gx, gz) || d.character === "park";
};
const cellGreen = parkCell;

const greenAtWorld = (x: number, z: number): boolean =>
  cellGreen(Math.floor((x + WORLD_HALF_X) / ROAD_TILE), Math.floor((z + WORLD_HALF_Z) / ROAD_TILE));

// Fraction of a polyline inside park landuse, sampled every ~6u of arclength.
function parkFrac(p: readonly number[]): number {
  let inside = 0;
  let total = 0;
  for (let k = 0; k + 3 < p.length; k += 2) {
    const ax = p[k] ?? 0;
    const az = p[k + 1] ?? 0;
    const bx = p[k + 2] ?? 0;
    const bz = p[k + 3] ?? 0;
    const len = Math.hypot(bx - ax, bz - az);
    const steps = Math.max(1, Math.ceil(len / 6));
    for (let s = 0; s <= steps; s++) {
      total++;
      const t = s / steps;
      if (greenAtWorld(ax + (bx - ax) * t, az + (bz - az) * t)) inside++;
    }
  }
  return total > 0 ? inside / total : 0;
}

// Every point of the polyline inside the Crossover corridor band.
function inCrossover(p: readonly number[]): boolean {
  for (let k = 0; k + 1 < p.length; k += 2) {
    const x = p[k] ?? 0;
    if (x < CROSSOVER_X0 || x > CROSSOVER_X1) return false;
  }
  return true;
}

/** SF edges with park-interior streets removed. RoadNetwork's default. */
export const SF_EDGES_PARK_CLEARED: readonly (RawEdge | undefined)[] = SF_EDGES.map((e) => {
  if (!e || e.w >= PARK_KEEP_HALF || parkFrac(e.p) <= 0.55) return e;
  if (e.w >= CROSSOVER_KEEP_HALF && inCrossover(e.p)) return e;
  return undefined;
});

// Grid-side mirror: a road cell INSIDE park landuse survives only when a kept
// edge actually passes through it (the highway, or a boundary street whose
// raster cells landed just inside the green). Band = half + sidewalk + slack.
let keptCells: Set<number> | null = null;

function stampKeptCells(): Set<number> {
  const out = new Set<number>();
  const band = (half: number): number => half + 2.0 + 1.6;
  for (const e of SF_EDGES_PARK_CLEARED) {
    if (!e) continue;
    const r = band(e.w);
    const p = e.p;
    for (let k = 0; k + 3 < p.length; k += 2) {
      const ax = p[k] ?? 0;
      const az = p[k + 1] ?? 0;
      const bx = p[k + 2] ?? 0;
      const bz = p[k + 3] ?? 0;
      const gx0 = Math.max(0, Math.floor((Math.min(ax, bx) - r + WORLD_HALF_X) / ROAD_TILE));
      const gx1 = Math.min(
        GRID_X - 1,
        Math.floor((Math.max(ax, bx) + r + WORLD_HALF_X) / ROAD_TILE),
      );
      const gz0 = Math.max(0, Math.floor((Math.min(az, bz) - r + WORLD_HALF_Z) / ROAD_TILE));
      const gz1 = Math.min(
        GRID_Z - 1,
        Math.floor((Math.max(az, bz) + r + WORLD_HALF_Z) / ROAD_TILE),
      );
      const dx = bx - ax;
      const dz = bz - az;
      const l2 = dx * dx + dz * dz || 1;
      for (let gx = gx0; gx <= gx1; gx++) {
        for (let gz = gz0; gz <= gz1; gz++) {
          const cx = (gx + 0.5) * ROAD_TILE - WORLD_HALF_X;
          const cz = (gz + 0.5) * ROAD_TILE - WORLD_HALF_Z;
          let t = ((cx - ax) * dx + (cz - az) * dz) / l2;
          t = t < 0 ? 0 : t > 1 ? 1 : t;
          if (Math.hypot(cx - (ax + dx * t), cz - (az + dz * t)) <= r) out.add(gx * GRID_Z + gz);
        }
      }
    }
  }
  return out;
}

/** True when a park-landuse road cell keeps its street. */
export function parkRoadCellKept(gx: number, gz: number): boolean {
  keptCells ??= stampKeptCells();
  return keptCells.has(gx * GRID_Z + gz);
}
