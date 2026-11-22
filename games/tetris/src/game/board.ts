import { WELL_DEPTH, WELL_HEIGHT, WELL_WIDTH } from "../shared/constants";

export interface Cell {
  x: number;
  y: number;
  z: number;
}

export interface LockedCube {
  x: number;
  y: number;
  z: number;
  colorIndex: number;
  id: number;
}

export interface ClearResult {
  /** Full columns (fixed x, spanning z). */
  xColumns: number;
  /** Full rows (fixed z, spanning x). */
  zRows: number;
  lines: number;
  /** Cubes removed this clear (for scoring / fx). */
  cubes: number;
  /** Exact pre-drop footprint, with crossing row/column intersections once. */
  clearedCells: Cell[];
}

/** Clockwise rotation of an XZ footprint = transpose + reverse rows. */
export const rotateCW = (m: number[][]) => {
  const rows = m.length;
  const cols = m[0]?.length ?? 0;
  const out: number[][] = [];

  for (let c = 0; c < cols; c += 1) {
    const row: number[] = [];

    for (let r = rows - 1; r >= 0; r -= 1) {
      row.push(m[r]?.[c] ?? 0);
    }

    out.push(row);
  }

  return out;
};

export class Board {
  readonly width = WELL_WIDTH;
  readonly depth = WELL_DEPTH;
  readonly height = WELL_HEIGHT;
  private readonly cells = new Int16Array(WELL_WIDTH * WELL_HEIGHT * WELL_DEPTH);
  private readonly ids = new Int16Array(WELL_WIDTH * WELL_HEIGHT * WELL_DEPTH);
  private nextId = 1;

  reset() {
    this.cells.fill(0);
    this.ids.fill(0);
    this.nextId = 1;
  }

  private idx(x: number, y: number, z: number) {
    return (x * this.height + y) * this.depth + z;
  }

  /** Inside the open play volume in x/z (y may be above the top). */
  inBounds(x: number, z: number) {
    return x >= 0 && x < this.width && z >= 0 && z < this.depth;
  }

  occupied(x: number, y: number, z: number) {
    if (!this.inBounds(x, z) || y < 0 || y >= this.height) {
      return false;
    }

    return (this.cells[this.idx(x, y, z)] ?? 0) > 0;
  }

  /** Would any of these cells hit a wall, the floor, or a locked cube? */
  collides(cells: Cell[]) {
    for (const c of cells) {
      if (!this.inBounds(c.x, c.z)) {
        return true;
      }

      if (c.y < 0) {
        return true;
      }

      if (c.y < this.height && (this.cells[this.idx(c.x, c.y, c.z)] ?? 0) > 0) {
        return true;
      }
    }

    return false;
  }

  /** Write a piece's cells as locked cubes; returns the layer they locked at. */
  lock(cells: Cell[], colorIndex: number) {
    let layer = 0;

    for (const c of cells) {
      if (this.inBounds(c.x, c.z) && c.y >= 0 && c.y < this.height) {
        const i = this.idx(c.x, c.y, c.z);
        this.cells[i] = colorIndex;
        this.ids[i] = this.nextId;
        this.nextId += 1;
        layer = Math.max(layer, c.y);
      }
    }

    return layer;
  }

  private dropColumnAbove(x: number, z: number, from: number) {
    for (let yy = from; yy < this.height - 1; yy += 1) {
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
  clearLayer(y: number) {
    const empty: ClearResult = { clearedCells: [], cubes: 0, lines: 0, xColumns: 0, zRows: 0 };

    if (y < 0 || y >= this.height) {
      return empty;
    }

    const fullX: boolean[] = [];

    for (let x = 0; x < this.width; x += 1) {
      let full = true;

      for (let z = 0; z < this.depth; z += 1) {
        if (!this.occupied(x, y, z)) {
          full = false;
          break;
        }
      }

      fullX[x] = full;
    }

    const fullZ: boolean[] = [];

    for (let z = 0; z < this.depth; z += 1) {
      let full = true;

      for (let x = 0; x < this.width; x += 1) {
        if (!this.occupied(x, y, z)) {
          full = false;
          break;
        }
      }

      fullZ[z] = full;
    }

    const xColumns = fullX.filter(Boolean).length;
    const zRows = fullZ.filter(Boolean).length;

    if (xColumns === 0 && zRows === 0) {
      return empty;
    }

    const pillars = new Set<number>();

    for (let x = 0; x < this.width; x += 1) {
      if (fullX[x]) {
        for (let z = 0; z < this.depth; z += 1) {
          pillars.add(x * this.depth + z);
        }
      }
    }

    for (let z = 0; z < this.depth; z += 1) {
      if (fullZ[z]) {
        for (let x = 0; x < this.width; x += 1) {
          pillars.add(x * this.depth + z);
        }
      }
    }

    let cubes = 0;
    const clearedCells: Cell[] = [];

    for (const k of pillars) {
      const x = Math.floor(k / this.depth);
      const z = k % this.depth;

      if (this.occupied(x, y, z)) {
        cubes += 1;
        clearedCells.push({ x, y, z });
      }

      this.dropColumnAbove(x, z, y);
    }

    return { clearedCells, cubes, lines: xColumns + zRows, xColumns, zRows };
  }

  /** Charged power-sweep: clear the lowest layer that has any cube and drop
   *  everything above it. Returns cubes removed (0 if the well is empty). */
  sweepLowestLayer() {
    let y = -1;

    for (let yy = 0; yy < this.height && y < 0; yy += 1) {
      for (let x = 0; x < this.width && y < 0; x += 1) {
        for (let z = 0; z < this.depth; z += 1) {
          if (this.occupied(x, yy, z)) {
            y = yy;
            break;
          }
        }
      }
    }

    if (y < 0) {
      return 0;
    }

    let removed = 0;

    for (let x = 0; x < this.width; x += 1) {
      for (let z = 0; z < this.depth; z += 1) {
        if (this.occupied(x, y, z)) {
          removed += 1;
        }

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
  collapseDown() {
    for (let x = 0; x < this.width; x += 1) {
      for (let z = 0; z < this.depth; z += 1) {
        let writeY = 0;

        for (let y = 0; y < this.height; y += 1) {
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

  /**
   * Every locked cube (for rendering / physics handoff).
   *
   * @yields {LockedCube} each occupied cell with its color index and stable id.
   */
  *cubes() {
    for (let x = 0; x < this.width; x += 1) {
      for (let y = 0; y < this.height; y += 1) {
        for (let z = 0; z < this.depth; z += 1) {
          const i = this.idx(x, y, z);
          const c = this.cells[i] ?? 0;

          if (c > 0) {
            yield { colorIndex: c, id: this.ids[i] ?? 0, x, y, z };
          }
        }
      }
    }
  }
}
