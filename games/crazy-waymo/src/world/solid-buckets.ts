import { BucketGrid } from "./bucket-grid";
import type { Solid } from "./city";

// CSR layout: one flat index array + per-bucket offsets, no per-bucket
// allocation; queried with a stamp array so a solid spanning several buckets
// is visited once per query without a Set.
export class SolidBuckets {
  readonly solids: readonly Solid[];
  private readonly grid = new BucketGrid();
  private readonly nz: number;
  // bucket -> first slot in `items`
  private readonly starts: Uint32Array;
  // solid indices, bucket-contiguous
  private readonly items: Uint32Array;
  // solid -> last query id that visited it
  private readonly stamp: Uint32Array;
  private queryId = 0;

  constructor(solids: readonly Solid[]) {
    this.solids = solids;
    this.nz = this.grid.nz;
    const buckets = this.grid.count;

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
      for (let x = x0; x <= x1; x += 1) {
        for (let z = z0; z <= z1; z += 1) {
          const b = x * this.nz + z + 1;
          counts[b] = (counts[b] ?? 0) + 1;
        }
      }
    }
    for (let i = 1; i <= buckets; i += 1) {
      counts[i] = (counts[i] ?? 0) + (counts[i - 1] ?? 0);
    }
    this.starts = counts;
    const total = counts[buckets] ?? 0;
    this.items = new Uint32Array(total);
    const cursor = counts.slice(0, buckets);
    for (let i = 0; i < solids.length; i += 1) {
      const s = solids[i];
      if (!s) {
        continue;
      }
      const [x0, x1, z0, z1] = range(s);
      for (let x = x0; x <= x1; x += 1) {
        for (let z = z0; z <= z1; z += 1) {
          const b = x * this.nz + z;
          this.items[cursor[b] ?? 0] = i;
          cursor[b] = (cursor[b] ?? 0) + 1;
        }
      }
    }
    this.stamp = new Uint32Array(solids.length);
  }

  private clampX(x: number): number {
    return this.grid.cellX(x);
  }
  private clampZ(z: number): number {
    return this.grid.cellZ(z);
  }

  // Visit every solid whose bucket range intersects the query box, once each.
  forEachIn(minX: number, maxX: number, minZ: number, maxZ: number, fn: (s: Solid) => void): void {
    this.queryId += 1;
    const id = this.queryId;
    const x0 = this.clampX(minX);
    const x1 = this.clampX(maxX);
    const z0 = this.clampZ(minZ);
    const z1 = this.clampZ(maxZ);
    for (let x = x0; x <= x1; x += 1) {
      for (let z = z0; z <= z1; z += 1) {
        const b = x * this.nz + z;
        const end = this.starts[b + 1] ?? 0;
        for (let k = this.starts[b] ?? 0; k < end; k += 1) {
          const idx = this.items[k] ?? 0;
          if (this.stamp[idx] === id) {
            continue;
          }
          this.stamp[idx] = id;
          const s = this.solids[idx];
          if (s) {
            fn(s);
          }
        }
      }
    }
  }

  // Is the point inside any solid? (camera clip march)
  hitAt(x: number, z: number, y?: number): boolean {
    const b = this.grid.bucketAt(x, z);
    const end = this.starts[b + 1] ?? 0;
    for (let k = this.starts[b] ?? 0; k < end; k += 1) {
      const s = this.solids[this.items[k] ?? 0];
      if (!s) {
        continue;
      }
      if (y !== undefined && s.minY !== undefined && (y < s.minY || y > s.maxY)) {
        continue;
      }
      const yaw = s.yaw ?? 0;
      if (yaw === 0) {
        if (x > s.minX && x < s.maxX && z > s.minZ && z < s.maxZ) {
          return true;
        }
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
      if (lx > -hx && lx < hx && lz > -hz && lz < hz) {
        return true;
      }
    }
    return false;
  }
}
