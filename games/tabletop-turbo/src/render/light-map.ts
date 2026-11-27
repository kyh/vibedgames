import { FLOOR_SIZE, FLOOR_SPAN } from "../splat/stage";

const CELL = FLOOR_SPAN / FLOOR_SIZE;
const HALF = FLOOR_SPAN / 2;

const clampCell = (v: number) => Math.min(FLOOR_SIZE - 1, Math.max(0, v));

/**
 * How lit each patch of floor is: the lamps, baked once, plus whatever shines
 * this frame (headlights, flashes). One byte a cell.
 */
export class LightMap {
  readonly bytes = new Uint8Array(FLOOR_SIZE * FLOOR_SIZE);
  private readonly base = new Uint8Array(FLOOR_SIZE * FLOOR_SIZE);

  /** Bake the standing light: `ambient` everywhere (0–1), then a pool per lamp. */
  bake(ambient: number, lamps: readonly (readonly [number, number])[], radius: number) {
    this.base.fill(Math.round(ambient * 255));
    this.bytes.set(this.base);

    for (const [x, z] of lamps) {
      this.pool(x, z, radius, 0.62);
    }

    this.base.set(this.bytes);
  }

  /** Start a frame from the standing light. */
  reset() {
    this.bytes.set(this.base);
  }

  /** A round pool of light, brightest in the middle. */
  pool(x: number, z: number, radius: number, power: number) {
    this.cone(x, z, 1, 0, radius, -1, power);
  }

  /**
   * Light thrown from (x, z) along (dx, dz), `reach` long. `spread` is the
   * cosine of the half angle; -1 lights all the way round.
   */
  cone(x: number, z: number, dx: number, dz: number, reach: number, spread: number, power: number) {
    const cx = (x + HALF) / CELL;
    const cz = (z + HALF) / CELL;
    const r = reach / CELL;
    const x0 = clampCell(Math.floor(cx - r));
    const x1 = clampCell(Math.ceil(cx + r));
    const z0 = clampCell(Math.floor(cz - r));
    const z1 = clampCell(Math.ceil(cz + r));

    for (let j = z0; j <= z1; j += 1) {
      for (let i = x0; i <= x1; i += 1) {
        const ox = i + 0.5 - cx;
        const oz = j + 0.5 - cz;
        const d = Math.hypot(ox, oz);

        if (d < r) {
          const along = d > 0.01 ? (ox * dx + oz * dz) / d : 1;
          const edge = spread <= -1 ? 1 : Math.min(1, Math.max(0, (along - spread) / 0.07));
          const fall = 1 - d / r;
          const cell = j * FLOOR_SIZE + i;
          const add = power * edge * (spread <= -1 ? fall * (2 - fall) : Math.sqrt(fall)) * 255;
          this.bytes[cell] = Math.min(255, (this.bytes[cell] ?? 0) + add);
        }
      }
    }
  }
}
