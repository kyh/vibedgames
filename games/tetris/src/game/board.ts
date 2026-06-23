// The logical 3D well — a renderer-agnostic integer grid. Backed by flat
// Int16Arrays (typed-array indexing returns a plain number, so the grid needs
// no non-null assertions and stays fast). Cells hold 0 (empty) or a colour
// index 1..7; ids[] is a parallel grid of stable per-cube ids so the renderer
// can track a cube across line-clear shifts (smooth drop instead of pop).
//
// The defining 3D-Tetris twist lives in clearLayer(): a locked layer clears
// along BOTH axes — any full column (fixed x, all z) and any full row (fixed
// z, all x) is removed, and the stack above each affected pillar drops one.

import { WELL_DEPTH, WELL_HEIGHT, WELL_WIDTH } from "../shared/constants";

export type Cell = { x: number; y: number; z: number };

export type ClearResult = {
  /** Full columns (fixed x, spanning z). */
  xColumns: number;
  /** Full rows (fixed z, spanning x). */
  zRows: number;
  lines: number;
  /** Cubes removed this clear (for scoring / fx). */
  cubes: number;
};

/** Clockwise rotation of an XZ footprint = transpose + reverse rows. */
export function rotateCW(m: number[][]): number[][] {
  const rows = m.length;
  const cols = m[0]?.length ?? 0;
  const out: number[][] = [];
  for (let c = 0; c < cols; c++) {
    const row: number[] = [];
    for (let r = rows - 1; r >= 0; r--) row.push(m[r]?.[c] ?? 0);
    out.push(row);
  }
  return out;
}

export class Board {
  readonly width = WELL_WIDTH;
  readonly depth = WELL_DEPTH;
  readonly height = WELL_HEIGHT;
  private readonly cells = new Int16Array(WELL_WIDTH * WELL_HEIGHT * WELL_DEPTH);
  private readonly ids = new Int16Array(WELL_WIDTH * WELL_HEIGHT * WELL_DEPTH);
  private nextId = 1;

  reset(): void {
    this.cells.fill(0);
    this.ids.fill(0);
    this.nextId = 1;
  }

  private idx(x: number, y: number, z: number): number {
    return (x * this.height + y) * this.depth + z;
  }

  /** Inside the open play volume in x/z (y may be above the top). */
  inBounds(x: number, z: number): boolean {
    return x >= 0 && x < this.width && z >= 0 && z < this.depth;
  }

  occupied(x: number, y: number, z: number): boolean {
    if (!this.inBounds(x, z) || y < 0 || y >= this.height) return false;
    return (this.cells[this.idx(x, y, z)] ?? 0) > 0;
  }

  /** Would any of these cells hit a wall, the floor, or a locked cube? */
  collides(cells: Cell[]): boolean {
    for (const c of cells) {
      if (!this.inBounds(c.x, c.z)) return true; // wall
      if (c.y < 0) return true; // floor
      if (c.y < this.height && (this.cells[this.idx(c.x, c.y, c.z)] ?? 0) > 0) return true; // locked
    }
    return false;
  }

  /** Write a piece's cells as locked cubes; returns the layer they locked at. */
  lock(cells: Cell[], colorIndex: number): number {
    let layer = 0;
    for (const c of cells) {
      if (this.inBounds(c.x, c.z) && c.y >= 0 && c.y < this.height) {
        const i = this.idx(c.x, c.y, c.z);
        this.cells[i] = colorIndex;
        this.ids[i] = this.nextId++;
        layer = Math.max(layer, c.y);
      }
    }
    return layer;
  }

  /** Drop the column at (x,z) down by one from layer `from` upward. */
  private dropColumnAbove(x: number, z: number, from: number): void {
    for (let yy = from; yy < this.height - 1; yy++) {
      const dst = this.idx(x, yy, z);
      const src = this.idx(x, yy + 1, z);
      this.cells[dst] = this.cells[src] ?? 0;
      this.ids[dst] = this.ids[src] ?? 0;
    }
    const top = this.idx(x, this.height - 1, z);
    this.cells[top] = 0;
    this.ids[top] = 0;
  }

  /**
   * Clear full columns/rows at a single layer (all pieces are 1 layer tall,
   * so only the just-locked layer can complete a line). Drops the stack above
   * each cleared pillar down by one. Returns counts for scoring/fx.
   */
  clearLayer(y: number): ClearResult {
    const empty: ClearResult = { xColumns: 0, zRows: 0, lines: 0, cubes: 0 };
    if (y < 0 || y >= this.height) return empty;

    const fullX: boolean[] = []; // fullX[x] = column x (all z) full
    for (let x = 0; x < this.width; x++) {
      let full = true;
      for (let z = 0; z < this.depth; z++) {
        if (!this.occupied(x, y, z)) {
          full = false;
          break;
        }
      }
      fullX[x] = full;
    }
    const fullZ: boolean[] = []; // fullZ[z] = row z (all x) full
    for (let z = 0; z < this.depth; z++) {
      let full = true;
      for (let x = 0; x < this.width; x++) {
        if (!this.occupied(x, y, z)) {
          full = false;
          break;
        }
      }
      fullZ[z] = full;
    }

    const xColumns = fullX.filter(Boolean).length;
    const zRows = fullZ.filter(Boolean).length;
    if (xColumns === 0 && zRows === 0) return empty;

    // Collect (x,z) pillars to drop. A pillar in both a cleared column and row
    // appears once (deduped) so it drops by exactly one.
    const pillars = new Set<number>();
    for (let x = 0; x < this.width; x++) {
      if (fullX[x]) for (let z = 0; z < this.depth; z++) pillars.add(x * this.depth + z);
    }
    for (let z = 0; z < this.depth; z++) {
      if (fullZ[z]) for (let x = 0; x < this.width; x++) pillars.add(x * this.depth + z);
    }

    let cubes = 0;
    for (const k of pillars) {
      const x = Math.floor(k / this.depth);
      const z = k % this.depth;
      if (this.occupied(x, y, z)) cubes += 1;
      this.dropColumnAbove(x, z, y);
    }
    return { xColumns, zRows, lines: xColumns + zRows, cubes };
  }

  /** Charged power-sweep: clear the lowest layer that has any cube and drop
   *  everything above it. Returns cubes removed (0 if the well is empty). */
  sweepLowestLayer(): number {
    let y = -1;
    for (let yy = 0; yy < this.height && y < 0; yy++) {
      for (let x = 0; x < this.width && y < 0; x++) {
        for (let z = 0; z < this.depth; z++) {
          if (this.occupied(x, yy, z)) {
            y = yy;
            break;
          }
        }
      }
    }
    if (y < 0) return 0;
    let removed = 0;
    for (let x = 0; x < this.width; x++) {
      for (let z = 0; z < this.depth; z++) {
        if (this.occupied(x, y, z)) removed += 1;
        this.dropColumnAbove(x, z, y);
      }
    }
    return removed;
  }

  /**
   * Settle every column straight down, removing gaps (the "catch" rescue:
   * rubble re-packs into a shorter, messier-but-playable stack). Cubes keep
   * their colour and id so the renderer can rebuild from this.
   */
  collapseDown(): void {
    for (let x = 0; x < this.width; x++) {
      for (let z = 0; z < this.depth; z++) {
        let writeY = 0;
        for (let y = 0; y < this.height; y++) {
          const i = this.idx(x, y, z);
          if ((this.cells[i] ?? 0) > 0) {
            if (y !== writeY) {
              const dst = this.idx(x, writeY, z);
              this.cells[dst] = this.cells[i] ?? 0;
              this.ids[dst] = this.ids[i] ?? 0;
              this.cells[i] = 0;
              this.ids[i] = 0;
            }
            writeY += 1;
          }
        }
      }
    }
  }

  /** Visit every locked cube (for rendering / physics handoff). */
  forEachCube(cb: (x: number, y: number, z: number, colorIndex: number, id: number) => void): void {
    for (let x = 0; x < this.width; x++) {
      for (let y = 0; y < this.height; y++) {
        for (let z = 0; z < this.depth; z++) {
          const i = this.idx(x, y, z);
          const c = this.cells[i] ?? 0;
          if (c > 0) cb(x, y, z, c, this.ids[i] ?? 0);
        }
      }
    }
  }
}
