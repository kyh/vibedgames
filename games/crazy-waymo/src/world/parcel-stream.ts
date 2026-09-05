import * as THREE from "three";

import { DRAW_DISTANCE, WORLD_HALF_X, WORLD_HALF_Z } from "../shared/constants";
import { parcelMeshOf } from "./parcel-build";
import { buildParcelGeometrySync, type DetailLevel, type ParcelGeometry } from "./parcel-mesh";
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
export const STREAM_HYSTERESIS = 80;
/** Cells built per tick after the first fill. */
const BUILDS_PER_TICK = 1;
/** Dimensional facades are subpixel beyond this band; distant cells use shader walls. */
const FACADE_RADIUS = 220;
const FACADE_HYSTERESIS = 40;

/** Shared with the residency harness so the memory gate measures the drawn LOD. */
export function parcelDetailForDistance(
  distance: number,
  detail: DetailLevel,
  previous: DetailLevel = 0,
): DetailLevel {
  if (detail === 0) return 0;
  const radius = FACADE_RADIUS * (detail === 1 ? 0.8 : 1);
  return distance <= radius + (previous > 0 ? FACADE_HYSTERESIS : 0) ? detail : 0;
}

/** Radius the fabric is held to, for a quality tier's model band. */
export function streamRadiusFor(detailScale: number, detail: DetailLevel = 2): number {
  return (DRAW_DISTANCE + STREAM_PAD) * (detail === 1 || detailScale < 1 ? 0.72 : 1);
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
export function geometryBytes(geometry: ParcelGeometry): number {
  let bytes = 0;
  for (const g of geometry.geos) {
    bytes +=
      g.position.byteLength +
      g.normal.byteLength +
      g.color.byteLength +
      g.index.byteLength +
      (g.fuv?.byteLength ?? 0) +
      (g.facade?.byteLength ?? 0) +
      (g.facade2?.byteLength ?? 0) +
      (g.uv?.byteLength ?? 0);
  }
  return bytes;
}

type Cell = {
  readonly key: number;
  readonly cx: number;
  readonly cz: number;
  readonly plans: ParcelPlan[];
  readonly lots: ParcelLot[];
  residence:
    | { readonly kind: "absent" }
    | {
        readonly kind: "resident";
        readonly group: THREE.Group;
        readonly detail: DetailLevel;
        readonly verts: number;
        readonly bytes: number;
      };
};

export type ParcelStreamStats = {
  readonly cells: number;
  readonly resident: number;
  readonly detailedCells: number;
  readonly verts: number;
  readonly bytes: number;
  readonly builtMs: number;
};

export class ParcelStreamer {
  private readonly cells = new Map<number, Cell>();
  private readonly resident = new Set<number>();
  private view: { readonly x: number; readonly z: number } | null = null;
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
        residence: { kind: "absent" },
      });
    }
  }

  stats(): ParcelStreamStats {
    let verts = 0;
    let bytes = 0;
    let detailedCells = 0;
    for (const k of this.resident) {
      const c = this.cells.get(k);
      if (!c || c.residence.kind === "absent") continue;
      if (c.residence.detail > 0) detailedCells++;
      verts += c.residence.verts;
      bytes += c.residence.bytes;
    }
    return {
      cells: this.cells.size,
      resident: this.resident.size,
      detailedCells,
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
    // Earned pixel/shadow quality must not expand a phone's memory budget.
    // Explicit show-all editor views still opt out with an infinite radius.
    if (Number.isFinite(radius)) radius = Math.min(radius, streamRadiusFor(1, this.detail));
    const want: { cell: Cell; distance: number; detail: DetailLevel }[] = [];
    const jump =
      this.view === null || Math.hypot(x - this.view.x, z - this.view.z) > STREAM_CELL * 2;
    this.view = { x, z };
    // Debug/garage teleports must reconcile immediately. Incremental updates
    // would otherwise leave several old neighbourhoods at full detail while
    // the new street takes seconds to appear, inflating GPU residency too.
    const drop = radius + (jump ? 0 : STREAM_HYSTERESIS);
    for (const c of this.cells.values()) {
      const d = Math.hypot(c.cx - x, c.cz - z);
      const oldDetail = c.residence.kind === "resident" ? c.residence.detail : 0;
      const detail = parcelDetailForDistance(d, this.detail, jump ? 0 : oldDetail);
      if (c.residence.kind === "absent") {
        if (d < radius) want.push({ cell: c, distance: d, detail });
      } else if (d > drop) {
        this.free(c);
      } else if (detail !== oldDetail) {
        want.push({ cell: c, distance: d, detail });
      }
    }
    if (want.length === 0) return;
    want.sort((a, b) => a.distance - b.distance);
    const budget = jump ? want.length : BUILDS_PER_TICK;
    for (let i = 0; i < Math.min(budget, want.length); i++) {
      const next = want[i];
      if (next) this.build(next.cell, next.detail);
    }
  }

  private build(c: Cell, detail: DetailLevel): void {
    const t0 = performance.now();
    const geometry = buildParcelGeometrySync(c.plans, detail, c.lots);
    const group = new THREE.Group();
    group.name = "parcel-cell";
    for (const g of geometry.geos) {
      const mesh = parcelMeshOf(g);
      mesh.name = `parcel-${g.tier}-${g.mat}`;
      // Near bays, cornices and awnings need cast shadows to read as volumes.
      mesh.castShadow = detail > 0 && (g.mat === "wall" || g.mat === "facade");
      mesh.receiveShadow = true;
      mesh.matrixAutoUpdate = false;
      group.add(mesh);
    }
    this.free(c);
    c.residence = {
      kind: "resident",
      group,
      detail,
      verts: geometry.stats.vertices,
      bytes: geometryBytes(geometry),
    };
    this.root.add(group);
    // Streamed cells arrive after City.freezeStatic. Compose their inherited
    // transform once, then inherit the city's static-world contract. Editor
    // roots retain live world transforms so moving a parent still works.
    group.updateMatrixWorld(true);
    group.traverse((object) => {
      object.matrixAutoUpdate = false;
      object.matrixWorldAutoUpdate = this.root.matrixWorldAutoUpdate;
    });
    this.resident.add(c.key);
    this.builtMs += performance.now() - t0;
  }

  private free(c: Cell): void {
    if (c.residence.kind === "absent") return;
    for (const child of c.residence.group.children) {
      if (child instanceof THREE.Mesh) child.geometry.dispose();
    }
    this.root.remove(c.residence.group);
    c.residence = { kind: "absent" };
    this.resident.delete(c.key);
  }
}
