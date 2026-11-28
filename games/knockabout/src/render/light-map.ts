import { FLOOR_CELLS, FLOOR_COLS, FLOOR_ROWS } from "../pixel/stage";

const HALF_X = FLOOR_COLS / FLOOR_CELLS / 2;
const HALF_Z = FLOOR_ROWS / FLOOR_CELLS / 2;

const clampCell = (v: number, cells: number) => Math.min(cells - 1, Math.max(0, v));

/**
 * Light thrown on the floor this frame: a hit, a landing, a lane about to
 * fire. One byte a cell; the floor steps up its ramp under it.
 */
export class LightMap {
  readonly bytes = new Uint8Array(FLOOR_COLS * FLOOR_ROWS);
  private lit = false;
  private wasLit = false;

  /** Whether the map differs from what was last sent to the card. */
  get changed() {
    return this.lit || this.wasLit;
  }

  /** Start a frame with the floor in plain daylight. */
  reset() {
    this.wasLit = this.lit;

    if (this.lit) {
      this.bytes.fill(0);
      this.lit = false;
    }
  }

  /** A round pool of light at (x, z), brightest in the middle. */
  pool(x: number, z: number, radius: number, power: number) {
    const cx = (x + HALF_X) * FLOOR_CELLS;
    const cz = (z + HALF_Z) * FLOOR_CELLS;
    const r = radius * FLOOR_CELLS;
    const x0 = clampCell(Math.floor(cx - r), FLOOR_COLS);
    const x1 = clampCell(Math.ceil(cx + r), FLOOR_COLS);
    const z0 = clampCell(Math.floor(cz - r), FLOOR_ROWS);
    const z1 = clampCell(Math.ceil(cz + r), FLOOR_ROWS);
    this.lit = true;

    for (let j = z0; j <= z1; j += 1) {
      for (let i = x0; i <= x1; i += 1) {
        const d = Math.hypot(i + 0.5 - cx, j + 0.5 - cz);

        if (d < r) {
          const fall = 1 - d / r;
          const cell = j * FLOOR_COLS + i;
          const add = power * fall * (2 - fall) * 255;
          this.bytes[cell] = Math.min(255, (this.bytes[cell] ?? 0) + add);
        }
      }
    }
  }
}
