import { GRID_X, GRID_Z, ROAD_TILE, WORLD_HALF_X, WORLD_HALF_Z } from "../shared/constants";
import { landuseGreenAt } from "./sf-landuse";
import { districtAt } from "./sf-map";
import { type RawEdge, SF_EDGES, SF_NODES } from "./sf-network";

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

// Edges are CLIPPED at the park boundary, never dropped whole: an edge 60%
// inside GGP still serves real streets on both sides — removing it entirely
// leaves the grid's outside road cells with no asphalt and no nearest-edge,
// so building setbacks collapse and houses land on the street fabric (the
// "buildings in the middle of the road" bug). Outside portions survive as
// dead-end fragments; a fragment's cut end gets a FRESH degree-1 node —
// keeping the original node id would make the junction patch at that node
// span the gap with one giant asphalt polygon.
const extraNodes: [number, number][] = [];
function cutNode(x: number, z: number): number {
  extraNodes.push([x, z]);
  return SF_NODES.length + extraNodes.length - 1;
}

const MIN_FRAGMENT_LEN = 14; // shorter outside stubs aren't worth a street

function clipEdge(e: RawEdge): RawEdge[] {
  // Densify to ~4u samples, keeping original vertices; classify each point.
  const pts: [number, number][] = [];
  for (let k = 0; k + 1 < e.p.length; k += 2) {
    const ax = e.p[k] ?? 0;
    const az = e.p[k + 1] ?? 0;
    if (k + 3 < e.p.length) {
      const bx = e.p[k + 2] ?? 0;
      const bz = e.p[k + 3] ?? 0;
      const steps = Math.max(1, Math.ceil(Math.hypot(bx - ax, bz - az) / 4));
      for (let s = 0; s < steps; s++) {
        const t = s / steps;
        pts.push([ax + (bx - ax) * t, az + (bz - az) * t]);
      }
    } else {
      pts.push([ax, az]);
    }
  }
  const green = pts.map(([x, z]) => greenAtWorld(x, z));
  // Bridge SHORT green runs (a grazed corner, a median nick): cutting there
  // would split a working street around a hole. Only a real park crossing
  // (≥ ~1 cell of green) severs the edge.
  for (let i = 0; i < green.length;) {
    if (!green[i]) {
      i++;
      continue;
    }
    let j = i;
    let len = 0;
    while (j < green.length && green[j]) {
      const a = pts[j - 1];
      const b = pts[j];
      if (j > i && a && b) len += Math.hypot(b[0] - a[0], b[1] - a[1]);
      j++;
    }
    if (len < 12) for (let k = i; k < j; k++) green[k] = false;
    i = j;
  }
  const out: RawEdge[] = [];
  let run: [number, number][] = [];
  let runStartsAtA = false;
  const flush = (endsAtB: boolean): void => {
    if (run.length >= 2) {
      let len = 0;
      for (let i = 1; i < run.length; i++) {
        const a = run[i - 1];
        const b = run[i];
        if (a && b) len += Math.hypot(b[0] - a[0], b[1] - a[1]);
      }
      const first = run[0];
      const last = run[run.length - 1];
      if (len >= MIN_FRAGMENT_LEN && first && last) {
        out.push({
          a: runStartsAtA ? e.a : cutNode(first[0], first[1]),
          b: endsAtB ? e.b : cutNode(last[0], last[1]),
          w: e.w,
          p: run.flat(),
        });
      }
    }
    run = [];
  };
  for (let i = 0; i < pts.length; i++) {
    const pt = pts[i];
    if (!pt) continue;
    if (green[i]) {
      flush(false);
    } else {
      if (run.length === 0) runStartsAtA = i === 0;
      run.push(pt);
    }
  }
  flush(true);
  // Whole edge survived — return it untouched (exact original polyline).
  if (out.length === 1 && out[0] && out[0].a === e.a && out[0].b === e.b) return [e];
  return out;
}

/** SF edges with park-interior street sections removed. RoadNetwork default. */
export const SF_EDGES_PARK_CLEARED: readonly (RawEdge | undefined)[] = SF_EDGES.flatMap((e) => {
  if (!e || e.w >= PARK_KEEP_HALF || parkFrac(e.p) <= 0.02) return [e];
  if (e.w >= CROSSOVER_KEEP_HALF && inCrossover(e.p)) return [e];
  return clipEdge(e);
});

/** SF nodes + the fresh endpoints minted for clipped fragments. */
export const SF_NODES_PARK_CLEARED: readonly (readonly [number, number])[] = [
  ...SF_NODES,
  ...extraNodes,
];

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
