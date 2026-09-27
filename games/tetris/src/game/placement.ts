// What a player reads off the well before committing a slab: how tall each
// pillar is, and what dropping the slab over each 2x2 patch of floor would do.
// Pure — the playtest diagnostics and its steering reflex both read from it.

import type { Board, Cell } from "./board";
import { WELL_DEPTH, WELL_WIDTH } from "../shared/constants";

const ZONE_SIZE = 2;
/** How many layers of height a completed line is worth trading for. */
const LINE_WORTH = 20;

export interface Zone {
  name: string;
  /** First x column and z row the zone covers; it spans ZONE_SIZE of each. */
  x: number;
  z: number;
}

export interface ZonePlan {
  /** World steps from where the slab is now to over the zone. */
  dx: number;
  dz: number;
  /** Layer the slab would come to rest on. */
  land: number;
  /** Empty cells it would seal underneath itself. */
  gaps: number;
  /** Full lines it would complete. */
  clears: number;
}

/** Keyed by zone name. */
export interface ZonePlans {
  [zone: string]: ZonePlan;
}

export const ZONES: Zone[] = [];
for (let z = 0; z + ZONE_SIZE <= WELL_DEPTH; z += ZONE_SIZE) {
  for (let x = 0; x + ZONE_SIZE <= WELL_WIDTH; x += ZONE_SIZE) {
    ZONES.push({ name: `x${x}${x + 1}_z${z}${z + 1}`, x, z });
  }
}

/** Height of every pillar: `heights[z][x]` = layers stacked at (x, z). */
export const pillarHeights = (board: Board): number[][] => {
  const rows: number[][] = [];
  for (let z = 0; z < board.depth; z += 1) {
    const row: number[] = [];
    for (let x = 0; x < board.width; x += 1) {
      let h = 0;
      for (let y = board.height - 1; y >= 0 && h === 0; y -= 1) {
        if (board.occupied(x, y, z)) {
          h = y + 1;
        }
      }
      row.push(h);
    }
    rows.push(row);
  }
  return rows;
};

/** Steps along one axis that bring the slab's centre over `target`, kept inside the walls. */
const shiftTowards = (coords: number[], target: number, size: number): number => {
  const min = Math.min(...coords);
  const max = Math.max(...coords);
  const centre = (min + max) / 2;
  const wanted = Math.round(target - centre);
  return Math.min(size - 1 - max, Math.max(-min, wanted));
};

const completedLines = (board: Board, cells: Cell[], layer: number): number => {
  const filled = (x: number, z: number): boolean =>
    board.occupied(x, layer, z) || cells.some((c) => c.x === x && c.z === z);
  let lines = 0;
  for (const x of new Set(cells.map((c) => c.x))) {
    let full = true;
    for (let z = 0; z < board.depth && full; z += 1) {
      full = filled(x, z);
    }
    lines += full ? 1 : 0;
  }
  for (const z of new Set(cells.map((c) => c.z))) {
    let full = true;
    for (let x = 0; x < board.width && full; x += 1) {
      full = filled(x, z);
    }
    lines += full ? 1 : 0;
  }
  return lines;
};

const dropAt = (
  board: Board,
  heights: number[][],
  cells: Cell[],
  dx: number,
  dz: number,
): ZonePlan | null => {
  const moved = cells.map((c) => ({ x: c.x + dx, y: c.y, z: c.z + dz }));
  const under = moved.map((c) => heights[c.z]?.[c.x] ?? 0);
  const land = Math.max(...under);
  // Already sunk below that patch of the stack: it cannot slide in over it.
  if (moved.some((c) => c.y < land)) {
    return null;
  }
  let gaps = 0;
  for (const h of under) {
    gaps += land - h;
  }
  return { clears: completedLines(board, moved, land), dx, dz, gaps, land };
};

/** Lower is better: a clear beats everything, then a low, snug fit. */
const cost = (plan: ZonePlan): number => plan.land + plan.gaps - plan.clears * LINE_WORTH;

const SNUG = [0, -1, 1];

/**
 * The outcome of hard-dropping `cells` over each zone — snugged up to one cell
 * either way to the best fit there, as a player nudges a slab into a notch.
 * Zones the slab can no longer reach are absent.
 */
export const planZones = (board: Board, heights: number[][], cells: Cell[]): ZonePlans => {
  const plans: ZonePlans = {};
  if (cells.length === 0) {
    return plans;
  }
  const xs = cells.map((c) => c.x);
  const zs = cells.map((c) => c.z);
  const centreOffset = (ZONE_SIZE - 1) / 2;
  for (const zone of ZONES) {
    let best: ZonePlan | null = null;
    for (const nudgeZ of SNUG) {
      for (const nudgeX of SNUG) {
        const dx = shiftTowards(xs, zone.x + centreOffset + nudgeX, board.width);
        const dz = shiftTowards(zs, zone.z + centreOffset + nudgeZ, board.depth);
        const plan = dropAt(board, heights, cells, dx, dz);
        if (plan && (best === null || cost(plan) < cost(best))) {
          best = plan;
        }
      }
    }
    if (best) {
      plans[zone.name] = best;
    }
  }
  return plans;
};

/** Zone names, best drop first; zones that resolve to the same drop appear once. */
export const rankZones = (plans: ZonePlans): string[] => {
  const seen = new Set<string>();
  const ranked: { name: string; plan: ZonePlan }[] = [];
  for (const zone of ZONES) {
    const plan = plans[zone.name];
    const spot = plan ? `${plan.dx},${plan.dz}` : "";
    if (plan && !seen.has(spot)) {
      seen.add(spot);
      ranked.push({ name: zone.name, plan });
    }
  }
  return ranked.toSorted((a, b) => cost(a.plan) - cost(b.plan)).map((entry) => entry.name);
};
