// Where scenery can go: how far a point is from the road, and whether it is
// inside the loop the circuit draws.

import type { Track } from "../sim/track";

/** Where things can go: distance to the road, and which side of it is the infield. */
export class Site {
  readonly track: Track;

  constructor(track: Track) {
    this.track = track;
  }

  /** Distance from (x, z) to the centreline. */
  distance(x: number, z: number): number {
    const { track } = this;
    let best = Number.POSITIVE_INFINITY;
    for (let i = 0; i < track.n; i += 2) {
      const dx = x - (track.xs[i] ?? 0);
      const dz = z - (track.zs[i] ?? 0);
      best = Math.min(best, dx * dx + dz * dz);
    }
    return Math.sqrt(best);
  }

  /** Is (x, z) inside the loop the circuit draws? */
  inside(x: number, z: number): boolean {
    const { track } = this;
    let hit = false;
    for (let i = 0, j = track.n - 4; i < track.n; j = i, i += 4) {
      const xi = track.xs[i] ?? 0;
      const zi = track.zs[i] ?? 0;
      const xj = track.xs[j] ?? 0;
      const zj = track.zs[j] ?? 0;
      if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) {
        hit = !hit;
      }
    }
    return hit;
  }
}
