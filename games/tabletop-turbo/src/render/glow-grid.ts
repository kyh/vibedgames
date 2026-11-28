import { FLOOR_CELLS, FLOOR_COLS, FLOOR_ROWS } from "../pixel/stage";

const HALF_X = FLOOR_COLS / FLOOR_CELLS / 2;
const HALF_Z = FLOOR_ROWS / FLOOR_CELLS / 2;

/** The slot tyre marks are laid in: the floor's own colour, a step down. */
export const SKID_SLOT = 31;

const clampCell = (v: number, cells: number) => Math.min(cells - 1, Math.max(0, v));

/**
 * What cars leave on the floor: glow trails in their own colour and tyre
 * marks. Looks only; nothing in the sim reads it.
 */
export class GlowGrid {
  /** 0 = bare floor, otherwise the slot that marked it. */
  readonly owner = new Uint8Array(FLOOR_COLS * FLOOR_ROWS);
  /** 1 fresh → 0 gone. */
  readonly strength = new Float32Array(FLOOR_COLS * FLOOR_ROWS);

  clear() {
    this.owner.fill(0);
    this.strength.fill(0);
  }

  /** Mark a disc of `radius` world units at (x, z) for `slot`, as strong as `strength`. */
  stamp(x: number, z: number, radius: number, slot: number, strength = 1) {
    const cx = (x + HALF_X) * FLOOR_CELLS;
    const cz = (z + HALF_Z) * FLOOR_CELLS;
    const r = radius * FLOOR_CELLS;
    const x0 = clampCell(Math.floor(cx - r), FLOOR_COLS);
    const x1 = clampCell(Math.ceil(cx + r), FLOOR_COLS);
    const z0 = clampCell(Math.floor(cz - r), FLOOR_ROWS);
    const z1 = clampCell(Math.ceil(cz + r), FLOOR_ROWS);

    for (let j = z0; j <= z1; j += 1) {
      for (let i = x0; i <= x1; i += 1) {
        const cell = j * FLOOR_COLS + i;
        const inside = (i + 0.5 - cx) ** 2 + (j + 0.5 - cz) ** 2 <= r * r;
        const had = this.owner[cell] ?? 0;
        const left = this.strength[cell] ?? 0;
        const underGlow = slot === SKID_SLOT && had !== SKID_SLOT && had !== 0 && left > 0.2;

        if (inside && !underGlow) {
          this.owner[cell] = slot;
          this.strength[cell] = had === slot ? Math.max(left, strength) : strength;
        }
      }
    }
  }

  /** Age every mark by `dt` seconds; a full-strength one lasts `life`. */
  decay(dt: number, life: number) {
    const fade = dt / life;
    const { owner, strength } = this;

    for (let cell = 0; cell < strength.length; cell += 1) {
      if (owner[cell] !== 0) {
        const next = (strength[cell] ?? 0) - fade;

        if (next <= 0) {
          owner[cell] = 0;
          strength[cell] = 0;
        } else {
          strength[cell] = next;
        }
      }
    }
  }
}
