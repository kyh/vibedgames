import { ROAD_TILE, WORLD_H, WORLD_HALF_X, WORLD_HALF_Z, WORLD_W } from "../shared/constants";
import type { Solid } from "./city";

// Uniform-grid spatial index over the static city solids. The city carries
// ~10k collision boxes (buildings, seawalls, railings, border walls); the car
// resolves against them every sub-step and the chase camera marches a clip
// ray through them every frame — a linear scan made both O(n). Bucketing by
// world cell turns each lookup into a handful of nearby boxes.
//
// Built once (CSR layout: one flat index array + per-bucket offsets, no
// per-bucket allocation) and queried with a stamp array so a solid spanning
// several buckets is visited once per query without a Set.

const CELL = ROAD_TILE * 2; // ~4 buildings per bucket
const MARGIN = 32; // border walls and bridge decks poke past the map edge

export class SolidIndex {
  readonly solids: readonly Solid[];
  private readonly nx: number;
  private readonly nz: number;
  private readonly minX: number;
  private readonly minZ: number;
  private readonly starts: Uint32Array; // bucket -> first slot in `items`
  private readonly items: Uint32Array; // solid indices, bucket-contiguous
  private readonly stamp: Uint32Array; // solid -> last query id that visited it
  private queryId = 0;

  constructor(solids: readonly Solid[]) {
    this.solids = solids;
    this.minX = -WORLD_HALF_X - MARGIN;
    this.minZ = -WORLD_HALF_Z - MARGIN;
    this.nx = Math.ceil((WORLD_W + MARGIN * 2) / CELL);
    this.nz = Math.ceil((WORLD_H + MARGIN * 2) / CELL);
    const buckets = this.nx * this.nz;

    // Two passes: count entries per bucket, then fill (classic CSR build).
    // Rotated solids bucket by their world-space AABB (extents expanded by
    // the rotation).
    const counts = new Uint32Array(buckets + 1);
    const range = (s: Solid): readonly [number, number, number, number] => {
      const yaw = s.yaw ?? 0;
      if (yaw === 0) {
        return [this.clampX(s.minX), this.clampX(s.maxX), this.clampZ(s.minZ), this.clampZ(s.maxZ)];
      }
      const cx = (s.minX + s.maxX) / 2;
      const cz = (s.minZ + s.maxZ) / 2;
      const hx = (s.maxX - s.minX) / 2;
      const hz = (s.maxZ - s.minZ) / 2;
      const ac = Math.abs(Math.cos(yaw));
      const as = Math.abs(Math.sin(yaw));
      const ex = hx * ac + hz * as;
      const ez = hx * as + hz * ac;
      return [
        this.clampX(cx - ex),
        this.clampX(cx + ex),
        this.clampZ(cz - ez),
        this.clampZ(cz + ez),
      ];
    };
    for (const s of solids) {
      const [x0, x1, z0, z1] = range(s);
      for (let x = x0; x <= x1; x++) {
        for (let z = z0; z <= z1; z++) {
          const b = x * this.nz + z + 1;
          counts[b] = (counts[b] ?? 0) + 1;
        }
      }
    }
    for (let i = 1; i <= buckets; i++) counts[i] = (counts[i] ?? 0) + (counts[i - 1] ?? 0);
    this.starts = counts;
    const total = counts[buckets] ?? 0;
    this.items = new Uint32Array(total);
    const cursor = counts.slice(0, buckets);
    for (let i = 0; i < solids.length; i++) {
      const s = solids[i];
      if (!s) continue;
      const [x0, x1, z0, z1] = range(s);
      for (let x = x0; x <= x1; x++) {
        for (let z = z0; z <= z1; z++) {
          const b = x * this.nz + z;
          this.items[cursor[b] ?? 0] = i;
          cursor[b] = (cursor[b] ?? 0) + 1;
        }
      }
    }
    this.stamp = new Uint32Array(solids.length);
  }

  private clampX(x: number): number {
    return Math.min(this.nx - 1, Math.max(0, Math.floor((x - this.minX) / CELL)));
  }
  private clampZ(z: number): number {
    return Math.min(this.nz - 1, Math.max(0, Math.floor((z - this.minZ) / CELL)));
  }

  // Visit every solid whose bucket range intersects the query box, once each.
  forEachIn(minX: number, maxX: number, minZ: number, maxZ: number, fn: (s: Solid) => void): void {
    const id = ++this.queryId;
    const x0 = this.clampX(minX);
    const x1 = this.clampX(maxX);
    const z0 = this.clampZ(minZ);
    const z1 = this.clampZ(maxZ);
    for (let x = x0; x <= x1; x++) {
      for (let z = z0; z <= z1; z++) {
        const b = x * this.nz + z;
        const end = this.starts[b + 1] ?? 0;
        for (let k = this.starts[b] ?? 0; k < end; k++) {
          const idx = this.items[k] ?? 0;
          if (this.stamp[idx] === id) continue;
          this.stamp[idx] = id;
          const s = this.solids[idx];
          if (s) fn(s);
        }
      }
    }
  }

  // Is the point inside any solid? (camera clip march)
  hitAt(x: number, z: number): boolean {
    const b = this.clampX(x) * this.nz + this.clampZ(z);
    const end = this.starts[b + 1] ?? 0;
    for (let k = this.starts[b] ?? 0; k < end; k++) {
      const s = this.solids[this.items[k] ?? 0];
      if (!s) continue;
      const yaw = s.yaw ?? 0;
      if (yaw === 0) {
        if (x > s.minX && x < s.maxX && z > s.minZ && z < s.maxZ) return true;
        continue;
      }
      const cx = (s.minX + s.maxX) / 2;
      const cz = (s.minZ + s.maxZ) / 2;
      const cos = Math.cos(yaw);
      const sin = Math.sin(yaw);
      const dx = x - cx;
      const dz = z - cz;
      const lx = dx * cos - dz * sin;
      const lz = dx * sin + dz * cos;
      const hx = (s.maxX - s.minX) / 2;
      const hz = (s.maxZ - s.minZ) / 2;
      if (lx > -hx && lx < hx && lz > -hz && lz < hz) return true;
    }
    return false;
  }
}
