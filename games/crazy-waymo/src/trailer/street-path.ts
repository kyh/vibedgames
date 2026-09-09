import * as THREE from "three";

import type { NetEdge } from "../world/network";
import type { ScoutCtx } from "./scout";

const { clamp } = THREE.MathUtils;

export interface Point {
  x: number;
  z: number;
}

/** Lane-aware path over the actual network. Segment projection avoids the
 * steering jumps produced by chasing discrete sampled vertices. */
export class StreetPath {
  private readonly scout: ScoutCtx;
  readonly edge: NetEdge;
  readonly dir: 1 | -1;

  constructor(scout: ScoutCtx, edge: NetEdge, dir: 1 | -1) {
    this.scout = scout;
    this.edge = edge;
    this.dir = dir;
  }
  at(s: number) {
    const p = this.scout.network.sample(
      this.edge,
      this.dir > 0 ? clamp(s, 0, this.edge.len) : this.edge.len - clamp(s, 0, this.edge.len),
    );
    const tx = p.tx * this.dir;
    const tz = p.tz * this.dir;
    const lane = -Math.min(1.6, Math.max(0, this.edge.half - 3.6));
    return { tx, tz, x: p.x + tz * lane, z: p.z - tx * lane };
  }
  project(pos: Point): number {
    let best = 0;
    let distance = Infinity;
    for (let s = 0; s < this.edge.len; s += 4) {
      const a = this.at(s);
      const b = this.at(s + 4);
      const dx = b.x - a.x;
      const dz = b.z - a.z;
      const lengthSq = dx * dx + dz * dz;
      if (lengthSq < 1e-8) {
        continue;
      }
      const f = clamp(((pos.x - a.x) * dx + (pos.z - a.z) * dz) / lengthSq, 0, 1);
      const d = (pos.x - a.x - dx * f) ** 2 + (pos.z - a.z - dz * f) ** 2;
      if (d < distance) {
        distance = d;
        best = s + Math.min(4, this.edge.len - s) * f;
      }
    }
    return best;
  }
}
