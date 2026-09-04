import * as THREE from "three";

import { DRAW_DISTANCE, WORLD_HALF_X, WORLD_HALF_Z } from "../shared/constants";
import { materialFor, parcelGeometryOf } from "./parcel-build";
import { buildParcelGeometrySync, type DetailLevel, type ParcelGeoStats } from "./parcel-mesh";
import type { ParcelLot, ParcelPlan } from "./parcel-plan";

// The parcel fabric, STREAMED. Nothing past the fog line is visible, so the
// city's 130k buildings do not need to be on the GPU at once: the plan is
// grouped into 80u cells, a cell's geometry is generated when it comes
// within the stream radius and freed once it falls well outside it. A cell
// is ~100 parcels and builds in about 2 ms, so the frontier keeps up with
// the car at one cell a frame, nearest first (a 160u cell at two a frame was
// a 37 ms hitch); the first tick after a load, and any teleport, fills the
// whole radius at once.
//
// The skyline is the exception. Towers read from 1400u away and there are
// only a few hundred, so they are built once, statically, by the city
// (parcel-build.ts) and never enter the streamer.

export const STREAM_CELL = 80;
/** How far past the fog line cells are held: nothing pops inside it. */
const STREAM_PAD = 60;
/** A cell is freed this far beyond the build radius, so a U-turn does not thrash. */
const STREAM_HYSTERESIS = 180;
/** Cells built per tick after the first fill. */
const BUILDS_PER_TICK = 1;

/** Radius the fabric is held to, for a quality tier's model band. */
export function streamRadiusFor(detailScale: number): number {
  return (DRAW_DISTANCE + STREAM_PAD) * (detailScale < 1 ? 0.72 : 1);
}

export const streamCellKey = (x: number, z: number): number =>
  Math.floor((x + WORLD_HALF_X) / STREAM_CELL) * 4096 +
  Math.floor((z + WORLD_HALF_Z) / STREAM_CELL);

export type StreamCellPlans = { readonly plans: ParcelPlan[]; readonly lots: ParcelLot[] };

/** Split plans and lots into stream cells by their centre. */
export function streamCells(
  plans: readonly ParcelPlan[],
  lots: readonly ParcelLot[],
): ReadonlyMap<number, StreamCellPlans> {
  const cells = new Map<number, StreamCellPlans>();
  const at = (x: number, z: number): StreamCellPlans => {
    const k = streamCellKey(x, z);
    let c = cells.get(k);
    if (!c) {
      c = { plans: [], lots: [] };
      cells.set(k, c);
    }
    return c;
  };
  for (const p of plans) at(p.obb.cx, p.obb.cz).plans.push(p);
  for (const l of lots) at(l.obb.cx, l.obb.cz).lots.push(l);
  return cells;
}

/** GPU bytes of built geometry, as three uploads it. */
export function geometryBytes(stats: ParcelGeoStats, facadeVerts: number): number {
  return stats.vertices * (12 + 3 + 3) + facadeVerts * (4 + 8 + 4) + stats.triangles * 3 * 2;
}

type Cell = {
  readonly key: number;
  readonly cx: number;
  readonly cz: number;
  readonly plans: ParcelPlan[];
  readonly lots: ParcelLot[];
  group: THREE.Group | null;
  verts: number;
  bytes: number;
};

export type ParcelStreamStats = {
  readonly cells: number;
  readonly resident: number;
  readonly verts: number;
  readonly bytes: number;
  readonly builtMs: number;
};

export class ParcelStreamer {
  private readonly cells = new Map<number, Cell>();
  private readonly resident = new Set<number>();
  private filled = false;
  private builtMs = 0;

  constructor(
    private readonly root: THREE.Object3D,
    plans: readonly ParcelPlan[],
    lots: readonly ParcelLot[],
    private readonly detail: DetailLevel,
  ) {
    for (const [key, c] of streamCells(plans, lots)) {
      const gx = Math.floor(key / 4096);
      const gz = key % 4096;
      this.cells.set(key, {
        key,
        cx: (gx + 0.5) * STREAM_CELL - WORLD_HALF_X,
        cz: (gz + 0.5) * STREAM_CELL - WORLD_HALF_Z,
        plans: c.plans,
        lots: c.lots,
        group: null,
        verts: 0,
        bytes: 0,
      });
    }
  }

  stats(): ParcelStreamStats {
    let verts = 0;
    let bytes = 0;
    for (const k of this.resident) {
      const c = this.cells.get(k);
      if (!c) continue;
      verts += c.verts;
      bytes += c.bytes;
    }
    return {
      cells: this.cells.size,
      resident: this.resident.size,
      verts,
      bytes,
      builtMs: this.builtMs,
    };
  }

  /**
   * Hold the fabric around (x, z) to `radius`. The first call fills the
   * whole radius synchronously — it runs under the loading screen or a
   * teleport — and every call after builds at most a few cells, nearest
   * first, and frees cells that have fallen out of the hysteresis band.
   */
  update(x: number, z: number, radius: number): void {
    const want: Cell[] = [];
    const drop = radius + STREAM_HYSTERESIS;
    for (const c of this.cells.values()) {
      const d = Math.hypot(c.cx - x, c.cz - z);
      if (c.group === null) {
        if (d < radius) want.push(c);
      } else if (d > drop) {
        this.free(c);
      }
    }
    if (want.length === 0) return;
    want.sort((a, b) => Math.hypot(a.cx - x, a.cz - z) - Math.hypot(b.cx - x, b.cz - z));
    const budget = this.filled ? BUILDS_PER_TICK : want.length;
    for (let i = 0; i < Math.min(budget, want.length); i++) {
      const c = want[i];
      if (c) this.build(c);
    }
    this.filled = true;
  }

  private build(c: Cell): void {
    const t0 = performance.now();
    const geometry = buildParcelGeometrySync(c.plans, this.detail, c.lots);
    const group = new THREE.Group();
    group.name = "parcel-cell";
    let facadeVerts = 0;
    for (const g of geometry.geos) {
      const mesh = new THREE.Mesh(parcelGeometryOf(g), materialFor(g.mat));
      mesh.name = `parcel-${g.tier}-${g.mat}`;
      mesh.castShadow = g.tier !== "detail";
      mesh.receiveShadow = true;
      mesh.matrixAutoUpdate = false;
      group.add(mesh);
      if (g.fuv) facadeVerts += g.position.length / 3;
    }
    c.group = group;
    c.verts = geometry.stats.vertices;
    c.bytes = geometryBytes(geometry.stats, facadeVerts);
    this.root.add(group);
    this.resident.add(c.key);
    this.builtMs += performance.now() - t0;
  }

  private free(c: Cell): void {
    if (c.group === null) return;
    for (const child of c.group.children) {
      if (child instanceof THREE.Mesh) child.geometry.dispose();
    }
    this.root.remove(c.group);
    c.group = null;
    c.verts = 0;
    c.bytes = 0;
    this.resident.delete(c.key);
  }
}
