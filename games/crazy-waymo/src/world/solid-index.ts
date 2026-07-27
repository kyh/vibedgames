import * as THREE from "three";

import {
  CEILING,
  ROAD_TILE,
  WORLD_H,
  WORLD_HALF_X,
  WORLD_HALF_Z,
  WORLD_W,
} from "../shared/constants";
import type { SurfaceDeck } from "../shared/types";
import type { Solid } from "./city";
import type { RoadNetwork } from "./network";
import type { Terrain } from "./terrain";

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

// The bucket arithmetic both indexes share. One copy so a query and the build
// that filled it can never disagree about which cell a coordinate lands in.
class BucketGrid {
  readonly nx = Math.ceil((WORLD_W + MARGIN * 2) / CELL);
  readonly nz = Math.ceil((WORLD_H + MARGIN * 2) / CELL);
  readonly count = this.nx * this.nz;
  private readonly minX = -WORLD_HALF_X - MARGIN;
  private readonly minZ = -WORLD_HALF_Z - MARGIN;

  cellX(x: number): number {
    return Math.min(this.nx - 1, Math.max(0, Math.floor((x - this.minX) / CELL)));
  }
  cellZ(z: number): number {
    return Math.min(this.nz - 1, Math.max(0, Math.floor((z - this.minZ) / CELL)));
  }
  bucketAt(x: number, z: number): number {
    return this.cellX(x) * this.nz + this.cellZ(z);
  }
}

export class SolidIndex {
  readonly solids: readonly Solid[];
  private readonly grid = new BucketGrid();
  private readonly nz: number;
  private readonly starts: Uint32Array; // bucket -> first slot in `items`
  private readonly items: Uint32Array; // solid indices, bucket-contiguous
  private readonly stamp: Uint32Array; // solid -> last query id that visited it
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
    return this.grid.cellX(x);
  }
  private clampZ(z: number): number {
    return this.grid.cellZ(z);
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
    const b = this.grid.bucketAt(x, z);
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

// --- Overhead structure ---------------------------------------------------
//
// `SolidIndex` is 2-D and solids-only, so the chase camera's clip march is
// blind to anything the player drives UNDER: the Bay Bridge approach viaduct
// emits no Solid at all (it must not, or the Embarcadero would be walled off),
// the freeway decks are a physics trimesh, and the Golden Gate ramp is a
// SurfaceDeck. Marching those with `hitAt` finds nothing, the camera rides its
// 6.8u up into the soffit and the screen fills with grey.
//
// A ceiling is the SOFFIT of a drawn slab with drivable room under it. This
// index answers "what is the lowest such soffit over (x, z) that is above the
// car?" in one bucket lookup, which is what the camera needs every frame.

/** A drawn slab overhead. `y` is the soffit at minZ, `y2` at maxZ (sloped). */
export type CeilingSpan = {
  readonly minX: number;
  readonly maxX: number;
  readonly minZ: number;
  readonly maxZ: number;
  readonly y: number;
  readonly y2?: number;
};

const SPAN_STRIDE = 6; // minX, maxX, minZ, maxZ, y, y2

export class CeilingIndex {
  private readonly grid = new BucketGrid();
  private readonly starts: Uint32Array; // bucket -> first slot in `items`
  private readonly items: Uint32Array; // span indices, bucket-contiguous
  private readonly data: Float32Array; // spans, SPAN_STRIDE floats each

  constructor(spans: readonly CeilingSpan[]) {
    const buckets = this.grid.count;
    this.data = new Float32Array(spans.length * SPAN_STRIDE);
    for (let i = 0; i < spans.length; i++) {
      const s = spans[i];
      if (!s) continue;
      const o = i * SPAN_STRIDE;
      this.data[o] = s.minX;
      this.data[o + 1] = s.maxX;
      this.data[o + 2] = s.minZ;
      this.data[o + 3] = s.maxZ;
      this.data[o + 4] = s.y;
      this.data[o + 5] = s.y2 ?? s.y;
    }

    // Same two-pass CSR build as SolidIndex: count per bucket, then fill.
    const counts = new Uint32Array(buckets + 1);
    let total = 0;
    for (const s of spans) {
      const x0 = this.grid.cellX(s.minX);
      const x1 = this.grid.cellX(s.maxX);
      const z0 = this.grid.cellZ(s.minZ);
      const z1 = this.grid.cellZ(s.maxZ);
      for (let x = x0; x <= x1; x++) {
        for (let z = z0; z <= z1; z++) {
          const b = x * this.grid.nz + z + 1;
          counts[b] = (counts[b] ?? 0) + 1;
          total++;
        }
      }
    }
    for (let i = 1; i <= buckets; i++) counts[i] = (counts[i] ?? 0) + (counts[i - 1] ?? 0);
    this.starts = counts;
    this.items = new Uint32Array(total);
    const cursor = counts.slice(0, buckets);
    for (let i = 0; i < spans.length; i++) {
      const s = spans[i];
      if (!s) continue;
      const x0 = this.grid.cellX(s.minX);
      const x1 = this.grid.cellX(s.maxX);
      const z0 = this.grid.cellZ(s.minZ);
      const z1 = this.grid.cellZ(s.maxZ);
      for (let x = x0; x <= x1; x++) {
        for (let z = z0; z <= z1; z++) {
          const b = x * this.grid.nz + z;
          this.items[cursor[b] ?? 0] = i;
          cursor[b] = (cursor[b] ?? 0) + 1;
        }
      }
    }
  }

  /** Number of indexed slabs — dev/diagnostic only. */
  get size(): number {
    return this.data.length / SPAN_STRIDE;
  }

  /**
   * Lowest soffit over (x, z) that is strictly above `aboveY`, or +Infinity
   * under open sky. `aboveY` is what makes the query cheap AND correct: a deck
   * the car is standing ON is below it and is ignored, so the same span serves
   * as road when you drive over it and as ceiling when you drive under it.
   */
  ceilingAt(x: number, z: number, aboveY: number): number {
    const b = this.grid.bucketAt(x, z);
    const end = this.starts[b + 1] ?? 0;
    let best = Infinity;
    for (let k = this.starts[b] ?? 0; k < end; k++) {
      const o = (this.items[k] ?? 0) * SPAN_STRIDE;
      const minZ = this.data[o + 2] ?? 0;
      const maxZ = this.data[o + 3] ?? 0;
      if (x < (this.data[o] ?? 0) || x > (this.data[o + 1] ?? 0) || z < minZ || z > maxZ) continue;
      const y = this.data[o + 4] ?? 0;
      const y2 = this.data[o + 5] ?? 0;
      const soffit = maxZ > minZ ? y + (y2 - y) * ((z - minZ) / (maxZ - minZ)) : y;
      if (soffit > aboveY && soffit < best) best = soffit;
    }
    return best;
  }
}

/**
 * Drive surfaces that float over the terrain (pier decks, the Golden Gate
 * ramp) are already modelled — `surface.ts` needs them to hold the car up.
 * Their undersides are ceilings for free, and unlike the geometry harvest
 * below they are present on BOTH load paths (the Golden Gate's meshes live in
 * rest.bin, so a cold-gen-only walk would miss them).
 */
export function deckCeilings(decks: readonly SurfaceDeck[]): CeilingSpan[] {
  return decks.map((d) => ({
    minX: d.minX,
    maxX: d.maxX,
    minZ: d.minZ,
    maxZ: d.maxZ,
    y: d.y - CEILING.deckThickness,
    y2: d.y2 === undefined ? undefined : d.y2 - CEILING.deckThickness,
  }));
}

/**
 * Harvest ceilings from whatever the world actually DREW — no registration, so
 * a viaduct nobody remembered to declare still stops burying the camera.
 *
 * A triangle earns a span when it is (1) near horizontal, (2) big enough to be
 * structure rather than trim, (3) standing clear of the terrain by more than a
 * car, and (4) over the drawn roadway. Those four together are the definition
 * of "something the player drives under", which is exactly the set the chase
 * camera can bury in — a house eave fails (3) and (4), a lamp bracket fails
 * (2), a roof over its own lot fails (4).
 *
 * Instanced and batched meshes are skipped: their per-instance transforms are
 * not in the geometry, so their vertices are not world space. Nothing the
 * player drives under is drawn that way (trees and props are).
 *
 * Runs once, off the load path, yielding through `breathe` on a time budget so
 * it never costs a frame — the camera simply has no ceiling until it lands.
 */
export async function harvestCeilingSpans(
  root: THREE.Object3D,
  terrain: Terrain,
  network: RoadNetwork,
  breathe: () => Promise<void>,
): Promise<CeilingSpan[]> {
  root.updateMatrixWorld(true);
  const meshes: THREE.Mesh[] = [];
  root.traverse((o) => {
    if (!(o instanceof THREE.Mesh)) return;
    if (o instanceof THREE.InstancedMesh || o instanceof THREE.BatchedMesh) return;
    meshes.push(o);
  });

  const spans: CeilingSpan[] = [];
  const px = [0, 0, 0];
  const pz = [0, 0, 0];
  let slice = performance.now();
  for (let m = 0; m < meshes.length; m++) {
    const mesh = meshes[m];
    if (!mesh) continue;
    const geo = mesh.geometry;
    const posAttr = geo.getAttribute("position");
    if (!(posAttr instanceof THREE.BufferAttribute)) continue;
    const pos = posAttr.array;
    const stride = posAttr.itemSize;
    const index = geo.index;
    const idx = index === null ? null : index.array;
    const count = idx === null ? posAttr.count : idx.length;
    // Column-major 4×4; hoisted so the inner loop is pure arithmetic.
    const e = mesh.matrixWorld.elements;
    const xx = e[0] ?? 0;
    const xy = e[4] ?? 0;
    const xz = e[8] ?? 0;
    const xw = e[12] ?? 0;
    const yx = e[1] ?? 0;
    const yy = e[5] ?? 0;
    const yz = e[9] ?? 0;
    const yw = e[13] ?? 0;
    const zx = e[2] ?? 0;
    const zy = e[6] ?? 0;
    const zz = e[10] ?? 0;
    const zw = e[14] ?? 0;
    for (let i = 0; i + 2 < count; i += 3) {
      if (
        i % (CEILING.harvestCheckTris * 3) === 0 &&
        performance.now() - slice > CEILING.harvestSliceMs
      ) {
        await breathe();
        slice = performance.now();
      }
      // Vertical extent first: it needs one matrix ROW, and it rejects every
      // wall, kerb and facade triangle — ~97% of the city — before the full
      // transform is worth paying for.
      let lo = Infinity;
      let hi = -Infinity;
      for (let k = 0; k < 3; k++) {
        const v = (idx === null ? i + k : (idx[i + k] ?? 0)) * stride;
        const y = yx * (pos[v] ?? 0) + yy * (pos[v + 1] ?? 0) + yz * (pos[v + 2] ?? 0) + yw;
        if (y < lo) lo = y;
        if (y > hi) hi = y;
      }
      if (hi - lo > CEILING.flatTol) continue;
      for (let k = 0; k < 3; k++) {
        const v = (idx === null ? i + k : (idx[i + k] ?? 0)) * stride;
        const x = pos[v] ?? 0;
        const y = pos[v + 1] ?? 0;
        const z = pos[v + 2] ?? 0;
        px[k] = xx * x + xy * y + xz * z + xw;
        pz[k] = zx * x + zy * y + zz * z + zw;
      }
      const ax = px[0] ?? 0;
      const az = pz[0] ?? 0;
      const bx = px[1] ?? 0;
      const bz = pz[1] ?? 0;
      const cx = px[2] ?? 0;
      const cz = pz[2] ?? 0;
      const area = Math.abs((bx - ax) * (cz - az) - (cx - ax) * (bz - az)) / 2;
      if (area < CEILING.minArea) continue;
      const mx = (ax + bx + cx) / 3;
      const mz = (az + bz + cz) / 3;
      if (lo - terrain.heightAt(mx, mz) < CEILING.minClear) continue;
      const hit = network.nearest(mx, mz, ROAD_TILE * 2);
      if (hit === null || hit.dist > hit.edge.half + CEILING.roadMargin) continue;
      spans.push({
        minX: Math.min(ax, bx, cx),
        maxX: Math.max(ax, bx, cx),
        minZ: Math.min(az, bz, cz),
        maxZ: Math.max(az, bz, cz),
        y: lo,
      });
    }
  }
  return spans;
}
