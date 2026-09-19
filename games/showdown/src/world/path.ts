// A* over the tile grid with 8-way movement (no corner cutting past solids)
// and an octile heuristic. The open set is a binary heap of [f, index]
// pairs; per-node bookkeeping lives in preallocated arrays stamped with a
// search id so nothing is cleared between calls.
import type { TileCoord } from "./grid";
import { GRID, TILE_COUNT, gridIndex, inGrid } from "./grid";

type HeapEntry = [number, number];

const heapPush = (heap: HeapEntry[], index: number, cost: number): void => {
  heap.push([cost, index]);
  let i = heap.length - 1;
  while (i > 0) {
    const parent = Math.trunc((i - 1) / 2);
    const parentEntry = heap[parent];
    const entry = heap[i];
    if (!parentEntry || !entry || parentEntry[0] <= entry[0]) {
      break;
    }
    heap[parent] = entry;
    heap[i] = parentEntry;
    i = parent;
  }
};

const heapCost = (heap: HeapEntry[], i: number): number => heap[i]?.[0] ?? 0;

const siftDown = (heap: HeapEntry[]): void => {
  let i = 0;
  for (;;) {
    const left = i * 2 + 1;
    const right = left + 1;
    let smallest = i;
    if (left < heap.length && heapCost(heap, left) < heapCost(heap, smallest)) {
      smallest = left;
    }
    if (right < heap.length && heapCost(heap, right) < heapCost(heap, smallest)) {
      smallest = right;
    }
    if (smallest === i) {
      return;
    }
    const a = heap[smallest];
    const b = heap[i];
    if (a && b) {
      heap[smallest] = b;
      heap[i] = a;
    }
    i = smallest;
  }
};

const heapPop = (heap: HeapEntry[]): number => {
  const [top] = heap;
  const last = heap.pop();
  if (heap.length && last) {
    heap[0] = last;
    siftDown(heap);
  }
  return top ? top[1] : -1;
};

export type Walkable = (x: number, y: number) => boolean;

/** Extra per-tile cost, e.g. to steer bots around the gas. */
export type ExtraCost = ((x: number, y: number) => number) | null | undefined;

// Octile step costs; the four-digit rounding is part of the tuned path costs.
// oxlint-disable-next-line oxc/approx-constant -- kept at the tuned precision so paths tie-break the same way
const DIAGONAL_STEP = 1.4142;
const HEURISTIC_DIAGONAL = 0.4142;

interface Search {
  isWalkable: Walkable;
  extraCost: ExtraCost;
  goal: number;
  tx: number;
  ty: number;
  heap: HeapEntry[];
}

/** Octile distance to the search goal. */
const heuristic = (search: Search, x: number, y: number): number => {
  const dx = Math.abs(x - search.tx);
  const dy = Math.abs(y - search.ty);
  return Math.max(dx, dy) + HEURISTIC_DIAGONAL * Math.min(dx, dy);
};

export class Pathfinder {
  private readonly gScore = new Float32Array(TILE_COUNT);
  private readonly cameFrom = new Int32Array(TILE_COUNT);
  private readonly stamp = new Uint32Array(TILE_COUNT);
  private readonly closed = new Uint32Array(TILE_COUNT);
  private tick = 0;

  /**
   * Path from (sx, sy) to (tx, ty) as tile coordinates, excluding the start
   * tile; the goal may be solid (so a bot can walk up to a loot box). Gives
   * up after 4000 expansions.
   */
  find(
    isWalkable: Walkable,
    sx: number,
    sy: number,
    tx: number,
    ty: number,
    extraCost?: ExtraCost,
  ): TileCoord[] | null {
    if (!inGrid(sx, sy) || !inGrid(tx, ty)) {
      return null;
    }
    this.tick += 1;
    const start = gridIndex(sx, sy);
    const search: Search = { extraCost, goal: gridIndex(tx, ty), heap: [], isWalkable, tx, ty };
    this.gScore[start] = 0;
    this.stamp[start] = this.tick;
    this.cameFrom[start] = -1;
    heapPush(search.heap, start, heuristic(search, sx, sy));
    let expansions = 0;
    while (search.heap.length && expansions < 4000) {
      expansions += 1;
      const current = heapPop(search.heap);
      if (current === search.goal) {
        return this.tracePath(start, current);
      }
      if (this.closed[current] === this.tick) {
        continue;
      }
      this.closed[current] = this.tick;
      this.expand(search, current);
    }
    return null;
  }

  /** Relaxes the eight neighbours of `current`, refusing to cut solid corners. */
  private expand(search: Search, current: number): void {
    const { isWalkable, extraCost, goal, heap } = search;
    const cx = current % GRID;
    const cy = Math.trunc(current / GRID);
    for (let dy = -1; dy <= 1; dy += 1) {
      for (let dx = -1; dx <= 1; dx += 1) {
        if (!dx && !dy) {
          continue;
        }
        const nx = cx + dx;
        const ny = cy + dy;
        if (!inGrid(nx, ny)) {
          continue;
        }
        const next = gridIndex(nx, ny);
        if (next !== goal && !isWalkable(nx, ny)) {
          continue;
        }
        if (dx && dy && (!isWalkable(cx + dx, cy) || !isWalkable(cx, cy + dy))) {
          continue;
        }
        const step = dx && dy ? DIAGONAL_STEP : 1;
        const cost = (this.gScore[current] ?? 0) + step + (extraCost ? extraCost(nx, ny) : 0);
        if (this.stamp[next] === this.tick && cost >= (this.gScore[next] ?? 0)) {
          continue;
        }
        this.gScore[next] = cost;
        this.stamp[next] = this.tick;
        this.cameFrom[next] = current;
        heapPush(heap, next, cost + heuristic(search, nx, ny));
      }
    }
  }

  private tracePath(start: number, end: number): TileCoord[] {
    const path: TileCoord[] = [];
    let node = end;
    while (node !== start && node >= 0) {
      path.push([node % GRID, Math.trunc(node / GRID)]);
      node = this.cameFrom[node] ?? -1;
    }
    return path.toReversed();
  }
}
