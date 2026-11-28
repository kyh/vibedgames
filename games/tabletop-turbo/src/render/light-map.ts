import { FLOOR_SIZE, FLOOR_SPAN } from "../pixel/stage";

const CELL = FLOOR_SPAN / FLOOR_SIZE;
const HALF = FLOOR_SPAN / 2;

const clampCell = (v: number) => Math.min(FLOOR_SIZE - 1, Math.max(0, v));

/**
 * Light thrown on the floor this frame: a hit, a landing, a lane about to
 * fire. One byte a cell; the floor steps up its ramp under it.
 */
export class LightMap {
  readonly bytes = new Uint8Array(FLOOR_SIZE * FLOOR_SIZE);
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
    const cx = (x + HALF) / CELL;
    const cz = (z + HALF) / CELL;
    const r = radius / CELL;
    const x0 = clampCell(Math.floor(cx - r));
    const x1 = clampCell(Math.ceil(cx + r));
    const z0 = clampCell(Math.floor(cz - r));
    const z1 = clampCell(Math.ceil(cz + r));
    this.lit = true;

    for (let j = z0; j <= z1; j += 1) {
      for (let i = x0; i <= x1; i += 1) {
        const d = Math.hypot(i + 0.5 - cx, j + 0.5 - cz);

        if (d < r) {
          const fall = 1 - d / r;
          const cell = j * FLOOR_SIZE + i;
          const add = power * fall * (2 - fall) * 255;
          this.bytes[cell] = Math.min(255, (this.bytes[cell] ?? 0) + add);
        }
      }
    }
  }
}
