// The twist: every kart lays a glowing stripe of its own paint, and paint is
// terrain. Your own colour is a fast lane; anyone else's is slick. The newest
// coat wins a cell, so a racing line is something you keep, lose and take back.
//
// A flat grid over the whole circuit: one owner byte and one strength float per
// cell. Each client paints from the karts it sees, so the grid never rides the
// wire — it is derived from poses everyone already has.

import { PAINT_ACTIVE, PAINT_CELL, PAINT_LIFE, PAINT_SIZE } from "../shared/constants";

const HALF = (PAINT_SIZE * PAINT_CELL) / 2;

export class PaintGrid {
  /** 0 = bare road, otherwise the painter's slot (1-based). */
  readonly owner = new Uint8Array(PAINT_SIZE * PAINT_SIZE);
  /** 1 fresh → 0 gone. */
  readonly strength = new Float32Array(PAINT_SIZE * PAINT_SIZE);
  /** Bumped on every change a renderer would care about. */
  version = 0;

  clear(): void {
    this.owner.fill(0);
    this.strength.fill(0);
    this.version += 1;
  }

  /** Paint a disc of `radius` world units at (x, z) in `slot`'s colour. */
  stamp(x: number, z: number, radius: number, slot: number): void {
    const cx = (x + HALF) / PAINT_CELL;
    const cz = (z + HALF) / PAINT_CELL;
    const r = radius / PAINT_CELL;
    const x0 = Math.max(0, Math.floor(cx - r));
    const x1 = Math.min(PAINT_SIZE - 1, Math.ceil(cx + r));
    const z0 = Math.max(0, Math.floor(cz - r));
    const z1 = Math.min(PAINT_SIZE - 1, Math.ceil(cz + r));
    const r2 = r * r;
    for (let j = z0; j <= z1; j += 1) {
      for (let i = x0; i <= x1; i += 1) {
        const dx = i + 0.5 - cx;
        const dz = j + 0.5 - cz;
        if (dx * dx + dz * dz <= r2) {
          const cell = j * PAINT_SIZE + i;
          this.owner[cell] = slot;
          this.strength[cell] = 1;
        }
      }
    }
    this.version += 1;
  }

  /** Strip every colour but `keep` from a disc of `radius` world units at (x, z). */
  wipe(x: number, z: number, radius: number, keep: number): void {
    const cx = (x + HALF) / PAINT_CELL;
    const cz = (z + HALF) / PAINT_CELL;
    const r = radius / PAINT_CELL;
    const x0 = Math.max(0, Math.floor(cx - r));
    const x1 = Math.min(PAINT_SIZE - 1, Math.ceil(cx + r));
    const z0 = Math.max(0, Math.floor(cz - r));
    const z1 = Math.min(PAINT_SIZE - 1, Math.ceil(cz + r));
    for (let j = z0; j <= z1; j += 1) {
      for (let i = x0; i <= x1; i += 1) {
        const cell = j * PAINT_SIZE + i;
        const inside = (i + 0.5 - cx) ** 2 + (j + 0.5 - cz) ** 2 <= r * r;
        if (inside && this.owner[cell] !== keep) {
          this.owner[cell] = 0;
          this.strength[cell] = 0;
        }
      }
    }
    this.version += 1;
  }

  /** Age every cell by `dt` seconds. */
  decay(dt: number): void {
    const fade = dt / PAINT_LIFE;
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
    this.version += 1;
  }

  /** The slot whose paint still has bite at (x, z), or 0. */
  ownerAt(x: number, z: number): number {
    const i = Math.floor((x + HALF) / PAINT_CELL);
    const j = Math.floor((z + HALF) / PAINT_CELL);
    if (i < 0 || j < 0 || i >= PAINT_SIZE || j >= PAINT_SIZE) {
      return 0;
    }
    const cell = j * PAINT_SIZE + i;
    return (this.strength[cell] ?? 0) > PAINT_ACTIVE ? (this.owner[cell] ?? 0) : 0;
  }

  /** Share of painted cells each slot holds, for the results screen. */
  coverage(slots: number): number[] {
    const counts: number[] = Array.from({ length: slots + 1 }, () => 0);
    let painted = 0;
    for (const slot of this.owner) {
      if (slot !== 0 && slot <= slots) {
        counts[slot] = (counts[slot] ?? 0) + 1;
        painted += 1;
      }
    }
    return counts.map((count) => (painted > 0 ? count / painted : 0));
  }
}
