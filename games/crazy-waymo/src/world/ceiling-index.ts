import * as THREE from "three";

import { CEILING, ROAD_TILE } from "../shared/constants";
import type { SurfaceDeck } from "../shared/types";
import { BucketGrid } from "./bucket-grid";
import type { RoadNetwork } from "./network";
import { normalizedScale } from "./quantized-geometry";
import type { Terrain } from "./terrain";
import { isMesh } from "../shared/three-guards";
import { inOrder } from "../shared/paced";

/** A drawn slab overhead. `y` is the soffit at minZ, `y2` at maxZ (sloped). */
export interface CeilingSpan {
  readonly minX: number;
  readonly maxX: number;
  readonly minZ: number;
  readonly maxZ: number;
  readonly y: number;
  readonly y2?: number;
}

const SPAN_STRIDE = 6;

export class CeilingIndex {
  private readonly grid = new BucketGrid();
  private readonly starts: Uint32Array;
  private readonly items: Uint32Array;
  private readonly data: Float32Array;

  constructor(spans: readonly CeilingSpan[]) {
    const buckets = this.grid.count;
    this.data = new Float32Array(spans.length * SPAN_STRIDE);

    for (let i = 0; i < spans.length; i += 1) {
      const s = spans[i];

      if (!s) {
        continue;
      }

      const o = i * SPAN_STRIDE;
      this.data[o] = s.minX;
      this.data[o + 1] = s.maxX;
      this.data[o + 2] = s.minZ;
      this.data[o + 3] = s.maxZ;
      this.data[o + 4] = s.y;
      this.data[o + 5] = s.y2 ?? s.y;
    }

    const counts = new Uint32Array(buckets + 1);
    let total = 0;

    for (const s of spans) {
      const x0 = this.grid.cellX(s.minX);
      const x1 = this.grid.cellX(s.maxX);
      const z0 = this.grid.cellZ(s.minZ);
      const z1 = this.grid.cellZ(s.maxZ);

      for (let x = x0; x <= x1; x += 1) {
        for (let z = z0; z <= z1; z += 1) {
          const b = x * this.grid.nz + z + 1;
          counts[b] = (counts[b] ?? 0) + 1;
          total += 1;
        }
      }
    }

    for (let i = 1; i <= buckets; i += 1) {
      counts[i] = (counts[i] ?? 0) + (counts[i - 1] ?? 0);
    }

    this.starts = counts;
    this.items = new Uint32Array(total);
    const cursor = counts.slice(0, buckets);

    for (let i = 0; i < spans.length; i += 1) {
      const s = spans[i];

      if (!s) {
        continue;
      }

      const x0 = this.grid.cellX(s.minX);
      const x1 = this.grid.cellX(s.maxX);
      const z0 = this.grid.cellZ(s.minZ);
      const z1 = this.grid.cellZ(s.maxZ);

      for (let x = x0; x <= x1; x += 1) {
        for (let z = z0; z <= z1; z += 1) {
          const b = x * this.grid.nz + z;
          this.items[cursor[b] ?? 0] = i;
          cursor[b] = (cursor[b] ?? 0) + 1;
        }
      }
    }
  }

  /** Number of indexed slabs — dev/diagnostic only. */
  get size() {
    return this.data.length / SPAN_STRIDE;
  }

  /**
   * Lowest soffit over (x, z) that is strictly above `aboveY`, or +Infinity
   * under open sky. `aboveY` is what makes the query cheap AND correct: a deck
   * the car is standing ON is below it and is ignored, so the same span serves
   * as road when you drive over it and as ceiling when you drive under it.
   */
  ceilingAt(x: number, z: number, aboveY: number) {
    const b = this.grid.bucketAt(x, z);
    const end = this.starts[b + 1] ?? 0;
    let best = Infinity;

    for (let k = this.starts[b] ?? 0; k < end; k += 1) {
      const o = (this.items[k] ?? 0) * SPAN_STRIDE;
      const minZ = this.data[o + 2] ?? 0;
      const maxZ = this.data[o + 3] ?? 0;

      if (x < (this.data[o] ?? 0) || x > (this.data[o + 1] ?? 0) || z < minZ || z > maxZ) {
        continue;
      }

      const y = this.data[o + 4] ?? 0;
      const y2 = this.data[o + 5] ?? 0;
      const soffit = maxZ > minZ ? y + (y2 - y) * ((z - minZ) / (maxZ - minZ)) : y;

      if (soffit > aboveY && soffit < best) {
        best = soffit;
      }
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
export const deckCeilings = (decks: readonly SurfaceDeck[]) =>
  decks.map((d) => ({
    maxX: d.maxX,
    maxZ: d.maxZ,
    minX: d.minX,
    minZ: d.minZ,
    y: d.y - CEILING.deckThickness,
    y2: d.y2 === undefined ? undefined : d.y2 - CEILING.deckThickness,
  }));

interface HarvestMesh {
  readonly pos: ArrayLike<number>;
  readonly stride: number;
  readonly norm: number;
  readonly idx: ArrayLike<number> | null;
  readonly count: number;
  readonly m: readonly number[];
}

const harvestMesh = (mesh: THREE.Mesh) => {
  const geo = mesh.geometry;
  const posAttr = geo.getAttribute("position");

  if (!(posAttr instanceof THREE.BufferAttribute)) {
    return null;
  }

  const { index } = geo;
  const idx = index === null ? null : index.array;

  return {
    count: idx === null ? posAttr.count : idx.length,
    idx,
    m: mesh.matrixWorld.elements,
    norm: normalizedScale(posAttr),
    pos: posAttr.array,
    stride: posAttr.itemSize,
  };
};

const vertexOffset = (h: HarvestMesh, i: number, k: number) =>
  (h.idx === null ? i + k : (h.idx[i + k] ?? 0)) * h.stride;

const triangleYRange: (h: HarvestMesh, i: number) => readonly [number, number] = (h, i) => {
  const yx = h.m[1] ?? 0;
  const yy = h.m[5] ?? 0;
  const yz = h.m[9] ?? 0;
  const yw = h.m[13] ?? 0;
  let lo = Infinity;
  let hi = -Infinity;

  for (let k = 0; k < 3; k += 1) {
    const v = vertexOffset(h, i, k);

    const y =
      (yx * (h.pos[v] ?? 0) + yy * (h.pos[v + 1] ?? 0) + yz * (h.pos[v + 2] ?? 0)) * h.norm + yw;

    lo = Math.min(lo, y);
    hi = Math.max(hi, y);
  }

  return [lo, hi];
};

const triangleXZ = (h: HarvestMesh, i: number, px: number[], pz: number[]) => {
  const xx = h.m[0] ?? 0;
  const xy = h.m[4] ?? 0;
  const xz = h.m[8] ?? 0;
  const xw = h.m[12] ?? 0;
  const zx = h.m[2] ?? 0;
  const zy = h.m[6] ?? 0;
  const zz = h.m[10] ?? 0;
  const zw = h.m[14] ?? 0;

  for (let k = 0; k < 3; k += 1) {
    const v = vertexOffset(h, i, k);
    const x = (h.pos[v] ?? 0) * h.norm;
    const y = (h.pos[v + 1] ?? 0) * h.norm;
    const z = (h.pos[v + 2] ?? 0) * h.norm;
    px[k] = xx * x + xy * y + xz * z + xw;
    pz[k] = zx * x + zy * y + zz * z + zw;
  }
};

const triangleSpan = (
  px: readonly number[],
  pz: readonly number[],
  lo: number,
  terrain: Terrain,
  network: RoadNetwork,
) => {
  const [ax = 0, bx = 0, cx = 0] = px;
  const [az = 0, bz = 0, cz = 0] = pz;
  const area = Math.abs((bx - ax) * (cz - az) - (cx - ax) * (bz - az)) / 2;

  if (area < CEILING.minArea) {
    return null;
  }

  const mx = (ax + bx + cx) / 3;
  const mz = (az + bz + cz) / 3;

  if (lo - terrain.heightAt(mx, mz) < CEILING.minClear) {
    return null;
  }

  const hit = network.nearest(mx, mz, ROAD_TILE * 2);

  if (hit === null || hit.dist > hit.edge.half + CEILING.roadMargin) {
    return null;
  }

  return {
    maxX: Math.max(ax, bx, cx),
    maxZ: Math.max(az, bz, cz),
    minX: Math.min(ax, bx, cx),
    minZ: Math.min(az, bz, cz),
    y: lo,
  };
};

type Harvested = NonNullable<ReturnType<typeof harvestMesh>>;

export const harvestCeilingSpans = async (
  root: THREE.Object3D,
  terrain: Terrain,
  network: RoadNetwork,
  breathe: () => Promise<void>,
) => {
  root.updateMatrixWorld(true);
  const meshes: THREE.Mesh[] = [];
  root.traverse((o) => {
    if (!isMesh(o)) {
      return;
    }

    if (o instanceof THREE.InstancedMesh || o instanceof THREE.BatchedMesh) {
      return;
    }

    meshes.push(o);
  });

  const spans: CeilingSpan[] = [];
  const px = [0, 0, 0];
  const pz = [0, 0, 0];
  let slice = performance.now();

  const harvestRun = (h: Harvested, from: number, resumed: boolean) => {
    for (let i = from; i + 2 < h.count; i += 3) {
      if (
        !(resumed && i === from) &&
        i % (CEILING.harvestCheckTris * 3) === 0 &&
        performance.now() - slice > CEILING.harvestSliceMs
      ) {
        return i;
      }

      const [lo, hi] = triangleYRange(h, i);

      if (hi - lo > CEILING.flatTol) {
        continue;
      }

      triangleXZ(h, i, px, pz);
      const span = triangleSpan(px, pz, lo, terrain, network);

      if (span) {
        spans.push(span);
      }
    }

    return h.count;
  };

  const harvestPaced: (h: Harvested, from: number, resumed: boolean) => Promise<void> = async (
    h,
    from,
    resumed,
  ) => {
    const stop = harvestRun(h, from, resumed);

    if (stop === h.count) {
      return;
    }

    await breathe();
    slice = performance.now();
    await harvestPaced(h, stop, true);
  };

  for await (const mesh of inOrder(meshes)) {
    const h = harvestMesh(mesh);

    if (h) {
      await harvestPaced(h, 0, false);
    }
  }

  return spans;
};
