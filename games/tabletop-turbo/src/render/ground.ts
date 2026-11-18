// A coarse map of how far every patch of floor is from the road, so the floor
// stops where the room goes dark and toys stay off the track.

import type { Track } from "../sim/track";

/** How far from the road the floor is laid: past it there is only the dark of the room. */
export const FLOOR_REACH = 66;

export class Ground {
  private static readonly CELL = 2;
  private static readonly HALF = 170;
  private readonly side = (Ground.HALF * 2) / Ground.CELL;
  private readonly cells = new Float32Array(this.side * this.side).fill(999);

  constructor(track: Track) {
    const reach = Math.ceil(FLOOR_REACH / Ground.CELL) + 1;
    for (let i = 0; i < track.n; i += 2) {
      const x = track.xs[i] ?? 0;
      const z = track.zs[i] ?? 0;
      const ci = Math.floor((x + Ground.HALF) / Ground.CELL);
      const cj = Math.floor((z + Ground.HALF) / Ground.CELL);
      for (let dj = -reach; dj <= reach; dj += 1) {
        for (let di = -reach; di <= reach; di += 1) {
          this.note(ci + di, cj + dj, x, z);
        }
      }
    }
  }

  /** Metres from (x, z) to the nearest stretch of centreline, to within a cell. */
  distance(x: number, z: number): number {
    const i = Math.floor((x + Ground.HALF) / Ground.CELL);
    const j = Math.floor((z + Ground.HALF) / Ground.CELL);
    if (i < 0 || j < 0 || i >= this.side || j >= this.side) {
      return 999;
    }
    return this.cells[j * this.side + i] ?? 999;
  }

  /** Mark a disc as taken, as if road ran through it. */
  block(x: number, z: number, radius: number): void {
    const reach = Math.ceil(radius / Ground.CELL);
    const ci = Math.floor((x + Ground.HALF) / Ground.CELL);
    const cj = Math.floor((z + Ground.HALF) / Ground.CELL);
    for (let dj = -reach; dj <= reach; dj += 1) {
      for (let di = -reach; di <= reach; di += 1) {
        const i = ci + di;
        const j = cj + dj;
        if (i >= 0 && j >= 0 && i < this.side && j < this.side) {
          this.cells[j * this.side + i] = 0;
        }
      }
    }
  }

  private note(i: number, j: number, x: number, z: number): void {
    if (i < 0 || j < 0 || i >= this.side || j >= this.side) {
      return;
    }
    const cx = (i + 0.5) * Ground.CELL - Ground.HALF;
    const cz = (j + 0.5) * Ground.CELL - Ground.HALF;
    const d = Math.hypot(cx - x, cz - z);
    const cell = j * this.side + i;
    if (d < (this.cells[cell] ?? 999)) {
      this.cells[cell] = d;
    }
  }
}
