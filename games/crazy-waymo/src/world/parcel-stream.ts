import * as THREE from "three";

import { DRAW_DISTANCE, WORLD_HALF_X, WORLD_HALF_Z } from "../shared/constants";
import { parcelMeshOf } from "./parcel-build";
import { buildParcelGeometrySteps, type DetailLevel, type ParcelGeometry } from "./parcel-mesh";
import type { ParcelLot, ParcelPlan } from "./parcel-plan";

// The parcel fabric, STREAMED. Nothing past the fog line is visible, so the
// city's 130k buildings do not need to be on the GPU at once: the plan is
// grouped into 80u cells, a cell's geometry is generated when it comes
// within the stream radius and freed once it falls well outside it. A cell
// can contain hundreds of parcels, so construction yields between parcels
// within a small frame budget, nearest first. Only the first loading tick
// and explicit editor show-all fill the whole radius synchronously.
//
// The skyline is the exception. Towers read from 1400u away and there are
// only a few hundred, so they are built once, statically, by the city
// (parcel-build.ts) and never enter the streamer.

export const STREAM_CELL = 80;
/** How far past the fog line cells are held: nothing pops inside it. */
const STREAM_PAD = 60;
/** A cell is freed this far beyond the build radius, so a U-turn does not thrash. */
export const STREAM_HYSTERESIS = 80;
/** Soft CPU budget: one parcel, buffer flush or cell attachment remains atomic. */
const BUILD_BUDGET_MS = 3;
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
  /** LOD hysteresis follows the requested level even while a replacement builds. */
  targetDetail: DetailLevel;
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
  readonly pending: number;
};

type CellBuild = {
  readonly cell: Cell;
  readonly detail: DetailLevel;
  readonly steps: Generator<void, ParcelGeometry>;
};

export class ParcelStreamer {
  private readonly cells = new Map<number, Cell>();
  private readonly resident = new Set<number>();
  private view: { readonly x: number; readonly z: number } | null = null;
  private builtMs = 0;
  private pending = 0;
  private building: CellBuild | null = null;

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
        targetDetail: 0,
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
      pending: this.pending,
    };
  }

  /**
   * Hold the fabric around (x, z) to `radius`. The first call fills the
   * whole radius synchronously under the loading screen. Later calls yield
   * between parcels, nearest first, and atomically replace completed cells.
   * Editor show-all is explicit synchronous work, independent of the budget.
   */
  update(x: number, z: number, radius: number): void {
    const started = performance.now();
    const fill = this.view === null || radius === Infinity;
    // Earned pixel/shadow quality must not expand a phone's memory budget.
    // Explicit show-all editor views still opt out with an infinite radius.
    if (Number.isFinite(radius)) radius = Math.min(radius, streamRadiusFor(1, this.detail));
    const want: { cell: Cell; distance: number; detail: DetailLevel }[] = [];
    const jump =
      this.view === null || Math.hypot(x - this.view.x, z - this.view.z) > STREAM_CELL * 2;
    this.view = { x, z };
    // Departed neighbourhoods release immediately after a teleport; building
    // the destination is budgeted just like ordinary movement.
    const drop = radius + (jump ? 0 : STREAM_HYSTERESIS);
    for (const c of this.cells.values()) {
      const d = Math.hypot(c.cx - x, c.cz - z);
      const oldDetail = c.residence.kind === "resident" ? c.residence.detail : 0;
      const detail = parcelDetailForDistance(d, this.detail, jump ? 0 : c.targetDetail);
      c.targetDetail = detail;
      if (c.residence.kind === "absent") {
        if (d < radius) want.push({ cell: c, distance: d, detail });
      } else if (d > drop) {
        this.free(c);
      } else if (detail !== oldDetail) {
        want.push({ cell: c, distance: d, detail });
      }
    }
    this.pending = want.length;
    const building = this.building;
    if (
      building &&
      (jump || !want.some((next) => next.cell === building.cell && next.detail === building.detail))
    ) {
      // Unattached typed arrays need no GPU disposal. Dropping the generator
      // also drops its buckets, so abandoned teleports cannot leave queued work.
      this.building = null;
    }
    if (want.length === 0) return;
    want.sort((a, b) => a.distance - b.distance);
    const deadline = fill ? Infinity : started + BUILD_BUDGET_MS;
    // Even scanning/disposal can exhaust a weak device's slice. Always advance
    // one parcel or flush so a populated frontier cannot starve indefinitely.
    let advanced = false;
    while (want.length > 0 && (!advanced || performance.now() < deadline)) {
      const next = want[0];
      if (!next) break;
      // Finish a valid in-flight cell before starting another. During normal
      // driving the camera barely moves within this short construction window.
      if (!this.building) {
        this.building = {
          cell: next.cell,
          detail: next.detail,
          steps: buildParcelGeometrySteps(next.cell.plans, next.detail, next.cell.lots),
        };
      }
      const job = this.building;
      const t0 = performance.now();
      let result = job.steps.next();
      advanced = true;
      while (!result.done && performance.now() < deadline) result = job.steps.next();
      if (result.done) {
        this.install(job.cell, job.detail, result.value);
        this.building = null;
        this.pending--;
        const completed = want.findIndex((item) => item.cell === job.cell);
        want.splice(completed, 1);
      }
      this.builtMs += performance.now() - t0;
      if (!result.done) break;
    }
  }

  private install(c: Cell, detail: DetailLevel, geometry: ParcelGeometry): void {
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
