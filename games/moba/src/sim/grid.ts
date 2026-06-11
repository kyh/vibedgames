// A boolean walkability grid + A* pathfinding over it.
//
// The world is divided into square cells. A cell is blocked if any map blocker
// (river without a bridge, cliff, base wall, tree cluster) overlaps it. Heroes
// path with A*; lane creeps follow authored waypoints and only fall back to the
// grid for local steering. Pure TS — no Phaser.

import type { Vec2 } from "./math";

export type Blocker =
  | { kind: "rect"; x: number; y: number; w: number; h: number }
  | { kind: "circle"; x: number; y: number; r: number }
  // A "gap" carves walkability back IN (e.g. a bridge across a river). Applied
  // after blockers so bridges win over the water beneath them.
  | { kind: "gap"; x: number; y: number; w: number; h: number };

export class NavGrid {
  readonly cols: number;
  readonly rows: number;
  readonly cell: number;
  /** walkable[r*cols + c] — true if a unit may stand there. */
  private walkable: Uint8Array;

  constructor(worldW: number, worldH: number, cell: number, blockers: Blocker[]) {
    this.cell = cell;
    this.cols = Math.ceil(worldW / cell);
    this.rows = Math.ceil(worldH / cell);
    this.walkable = new Uint8Array(this.cols * this.rows).fill(1);
    this.applyBlockers(blockers);
  }

  private applyBlockers(blockers: Blocker[]): void {
    // Two passes so "gap" (bridge) re-opens cells closed by overlapping water.
    for (const b of blockers) {
      if (b.kind === "gap") continue;
      this.stamp(b, 0);
    }
    for (const b of blockers) {
      if (b.kind !== "gap") continue;
      this.stamp(b, 1);
    }
  }

  private stamp(b: Blocker, value: 0 | 1): void {
    if (b.kind === "circle") {
      const minC = Math.max(0, Math.floor((b.x - b.r) / this.cell));
      const maxC = Math.min(this.cols - 1, Math.floor((b.x + b.r) / this.cell));
      const minR = Math.max(0, Math.floor((b.y - b.r) / this.cell));
      const maxR = Math.min(this.rows - 1, Math.floor((b.y + b.r) / this.cell));
      const r2 = b.r * b.r;
      for (let r = minR; r <= maxR; r++) {
        for (let c = minC; c <= maxC; c++) {
          const cx = (c + 0.5) * this.cell;
          const cy = (r + 0.5) * this.cell;
          const dx = cx - b.x;
          const dy = cy - b.y;
          if (dx * dx + dy * dy <= r2) this.walkable[r * this.cols + c] = value;
        }
      }
      return;
    }
    const minC = Math.max(0, Math.floor(b.x / this.cell));
    const maxC = Math.min(this.cols - 1, Math.floor((b.x + b.w) / this.cell));
    const minR = Math.max(0, Math.floor(b.y / this.cell));
    const maxR = Math.min(this.rows - 1, Math.floor((b.y + b.h) / this.cell));
    for (let r = minR; r <= maxR; r++) {
      for (let c = minC; c <= maxC; c++) this.walkable[r * this.cols + c] = value;
    }
  }

  inBounds(c: number, r: number): boolean {
    return c >= 0 && r >= 0 && c < this.cols && r < this.rows;
  }

  isWalkableCell(c: number, r: number): boolean {
    return this.inBounds(c, r) && this.walkable[r * this.cols + c] === 1;
  }

  isWalkableWorld(x: number, y: number): boolean {
    return this.isWalkableCell(Math.floor(x / this.cell), Math.floor(y / this.cell));
  }

  cellCenter(c: number, r: number): Vec2 {
    return { x: (c + 0.5) * this.cell, y: (r + 0.5) * this.cell };
  }

  worldToCell(x: number, y: number): { c: number; r: number } {
    return { c: Math.floor(x / this.cell), r: Math.floor(y / this.cell) };
  }

  /** Nearest walkable cell to a world point (spiral search), for snapping goals. */
  nearestWalkable(x: number, y: number, maxRing = 24): { c: number; r: number } | null {
    const { c, r } = this.worldToCell(x, y);
    if (this.isWalkableCell(c, r)) return { c, r };
    for (let ring = 1; ring <= maxRing; ring++) {
      for (let dc = -ring; dc <= ring; dc++) {
        for (let dr = -ring; dr <= ring; dr++) {
          if (Math.max(Math.abs(dc), Math.abs(dr)) !== ring) continue;
          if (this.isWalkableCell(c + dc, r + dr)) return { c: c + dc, r: r + dr };
        }
      }
    }
    return null;
  }

  /**
   * A* from world start to world goal. Returns a list of world-space waypoints
   * (cell centers), already line-of-sight smoothed, or null if unreachable.
   * Goal is snapped to the nearest walkable cell.
   */
  findPath(start: Vec2, goal: Vec2): Vec2[] | null {
    const s = this.nearestWalkable(start.x, start.y);
    const g = this.nearestWalkable(goal.x, goal.y);
    if (!s || !g) return null;
    const startIdx = s.r * this.cols + s.c;
    const goalIdx = g.r * this.cols + g.c;
    if (startIdx === goalIdx) return [this.cellCenter(g.c, g.r)];

    const n = this.cols * this.rows;
    const gScore = new Float64Array(n).fill(Infinity);
    const fScore = new Float64Array(n).fill(Infinity);
    const came = new Int32Array(n).fill(-1);
    const closed = new Uint8Array(n);
    gScore[startIdx] = 0;
    fScore[startIdx] = this.heur(s.c, s.r, g.c, g.r);

    // Binary min-heap keyed on fScore.
    const heap: number[] = [startIdx];
    const inHeap = new Uint8Array(n);
    inHeap[startIdx] = 1;
    const less = (a: number, b: number) => fScore[a]! < fScore[b]!;
    const swap = (i: number, j: number) => {
      const t = heap[i]!;
      heap[i] = heap[j]!;
      heap[j] = t;
    };
    const up = (i: number) => {
      while (i > 0) {
        const p = (i - 1) >> 1;
        if (less(heap[i]!, heap[p]!)) {
          swap(i, p);
          i = p;
        } else break;
      }
    };
    const down = (i: number) => {
      const sz = heap.length;
      for (;;) {
        let m = i;
        const l = 2 * i + 1;
        const r = 2 * i + 2;
        if (l < sz && less(heap[l]!, heap[m]!)) m = l;
        if (r < sz && less(heap[r]!, heap[m]!)) m = r;
        if (m === i) break;
        swap(i, m);
        i = m;
      }
    };
    const push = (idx: number) => {
      heap.push(idx);
      up(heap.length - 1);
    };
    const pop = (): number => {
      const top = heap[0]!;
      const last = heap.pop()!;
      if (heap.length > 0) {
        heap[0] = last;
        down(0);
      }
      return top;
    };

    let guard = 0;
    const maxIters = n * 2;
    while (heap.length > 0) {
      if (++guard > maxIters) break;
      const cur = pop();
      inHeap[cur] = 0;
      if (cur === goalIdx) return this.reconstruct(came, cur, s);
      if (closed[cur]) continue;
      closed[cur] = 1;
      const cc = cur % this.cols;
      const cr = (cur - cc) / this.cols;
      for (let k = 0; k < 8; k++) {
        const nc = cc + NEI[k]![0];
        const nr = cr + NEI[k]![1];
        if (!this.isWalkableCell(nc, nr)) continue;
        const diag = NEI[k]![0] !== 0 && NEI[k]![1] !== 0;
        // Disallow corner-cutting through blocked orthogonal neighbours.
        if (
          diag &&
          (!this.isWalkableCell(cc + NEI[k]![0], cr) || !this.isWalkableCell(cc, cr + NEI[k]![1]))
        )
          continue;
        const nIdx = nr * this.cols + nc;
        if (closed[nIdx]) continue;
        const step = diag ? 1.41421356 : 1;
        const tentative = gScore[cur]! + step;
        if (tentative < gScore[nIdx]!) {
          came[nIdx] = cur;
          gScore[nIdx] = tentative;
          fScore[nIdx] = tentative + this.heur(nc, nr, g.c, g.r);
          if (!inHeap[nIdx]) {
            inHeap[nIdx] = 1;
            push(nIdx);
          } else {
            // decrease-key: cheap re-push, stale entries skipped via `closed`.
            push(nIdx);
          }
        }
      }
    }
    return null;
  }

  private heur(c0: number, r0: number, c1: number, r1: number): number {
    // Octile distance — admissible for 8-connected grids.
    const dc = Math.abs(c0 - c1);
    const dr = Math.abs(r0 - r1);
    return dc + dr + (1.41421356 - 2) * Math.min(dc, dr);
  }

  private reconstruct(came: Int32Array, end: number, _start: { c: number; r: number }): Vec2[] {
    const cells: number[] = [end];
    let cur = end;
    while (came[cur] !== -1) {
      cur = came[cur]!;
      cells.push(cur);
    }
    cells.reverse();
    // String-pull: drop intermediate cells that have line of sight from the
    // last kept waypoint, so units walk in straight diagonals not stairsteps.
    const pts: Vec2[] = [];
    let anchor = 0;
    pts.push(this.cellIdxCenter(cells[0]!));
    for (let i = 2; i < cells.length; i++) {
      if (!this.cellLineOfSight(cells[anchor]!, cells[i]!)) {
        pts.push(this.cellIdxCenter(cells[i - 1]!));
        anchor = i - 1;
      }
    }
    pts.push(this.cellIdxCenter(cells[cells.length - 1]!));
    return pts;
  }

  private cellIdxCenter(idx: number): Vec2 {
    const c = idx % this.cols;
    const r = (idx - c) / this.cols;
    return this.cellCenter(c, r);
  }

  /** Supercover line walk between two cells; true if every cell is walkable. */
  private cellLineOfSight(a: number, b: number): boolean {
    let c0 = a % this.cols;
    let r0 = (a - c0) / this.cols;
    const c1 = b % this.cols;
    const r1 = (b - c1) / this.cols;
    const dc = Math.abs(c1 - c0);
    const dr = Math.abs(r1 - r0);
    const sc = c0 < c1 ? 1 : -1;
    const sr = r0 < r1 ? 1 : -1;
    let err = dc - dr;
    for (;;) {
      if (!this.isWalkableCell(c0, r0)) return false;
      if (c0 === c1 && r0 === r1) return true;
      const e2 = 2 * err;
      if (e2 > -dr) {
        err -= dr;
        c0 += sc;
      }
      if (e2 < dc) {
        err += dc;
        r0 += sr;
      }
    }
  }
}

const NEI: Array<[number, number]> = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
  [1, 1],
  [1, -1],
  [-1, 1],
  [-1, -1],
];
