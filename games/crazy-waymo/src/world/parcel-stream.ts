import * as THREE from "three";

import { WORLD_HALF_X, WORLD_HALF_Z } from "../shared/constants";
import { drawDistance } from "../render/quality";
import { parcelMeshOf } from "./parcel-build";
import { buildParcelGeometrySteps } from "./parcel-mesh";
import type { DetailLevel, ParcelGeometry } from "./parcel-mesh";
import type { ParcelLot, ParcelPlan } from "./parcel-plan";
import { packedCentre, unpackLots, unpackPlans } from "./parcel-pack";
import type { PackedLots, PackedPlans } from "./parcel-pack";

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
export const parcelDetailForDistance = (
  distance: number,
  detail: DetailLevel,
  previous: DetailLevel = 0,
): DetailLevel => {
  if (detail === 0) {
    return 0;
  }
  const radius = FACADE_RADIUS * (detail === 1 ? 0.8 : 1);
  return distance <= radius + (previous > 0 ? FACADE_HYSTERESIS : 0) ? detail : 0;
};

/** Radius the fabric is held to, for a quality tier's model band. */
// Low tiers and phones hold less fabric than the draw distance would fill;
// the ring past it sits deep in the fog, and on a phone that ring is the
// difference between a resident set the GPU process survives and one it
// does not.
export const streamRadiusFor = (detailScale: number, detail: DetailLevel = 2): number =>
  (drawDistance() + STREAM_PAD) * (detail === 1 || detailScale < 1 ? 0.72 : 1);

export const streamCellKey = (x: number, z: number): number =>
  Math.floor((x + WORLD_HALF_X) / STREAM_CELL) * 4096 +
  Math.floor((z + WORLD_HALF_Z) / STREAM_CELL);

export interface StreamCellPlans {
  readonly plans: ParcelPlan[];
  readonly lots: ParcelLot[];
}

/** Split plans and lots into stream cells by their centre. */
export const streamCells = (
  plans: readonly ParcelPlan[],
  lots: readonly ParcelLot[],
): ReadonlyMap<number, StreamCellPlans> => {
  const cells = new Map<number, StreamCellPlans>();
  const at = (x: number, z: number): StreamCellPlans => {
    const k = streamCellKey(x, z);
    let c = cells.get(k);
    if (!c) {
      c = { lots: [], plans: [] };
      cells.set(k, c);
    }
    return c;
  };
  for (const p of plans) {
    at(p.obb.cx, p.obb.cz).plans.push(p);
  }
  for (const l of lots) {
    at(l.obb.cx, l.obb.cz).lots.push(l);
  }
  return cells;
};

/** GPU bytes of built geometry, as three uploads it. */
export const geometryBytes = (geometry: ParcelGeometry): number => {
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
};

/** A cell's plans and lots, still packed: materialized only while its
 *  geometry builds (see world/parcel-pack.ts). */
interface CellSource {
  readonly plans: PackedPlans;
  readonly planIdx: Uint32Array;
  readonly lots: PackedLots;
  readonly lotIdx: Uint32Array;
}

interface Cell {
  readonly key: number;
  /** The world tile that owns the cell — removeTile drops every cell of one. */
  readonly tile: number;
  readonly cx: number;
  readonly cz: number;
  readonly source: CellSource;
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
}

export interface ParcelStreamStats {
  readonly cells: number;
  readonly resident: number;
  readonly detailedCells: number;
  readonly verts: number;
  readonly bytes: number;
  readonly builtMs: number;
  readonly pending: number;
}

interface CellBuild {
  readonly cell: Cell;
  readonly detail: DetailLevel;
  readonly steps: Generator<void, ParcelGeometry>;
}

/** Which stream cell each packed plan/lot files under, by its centre. */
const cellIndices = (p: PackedPlans | PackedLots): Map<number, number[]> => {
  const cells = new Map<number, number[]>();
  for (let i = 0; i < p.count; i += 1) {
    const [x, z] = packedCentre(p, i);
    const k = streamCellKey(x, z);
    const list = cells.get(k);
    if (list) {
      list.push(i);
    } else {
      cells.set(k, [i]);
    }
  }
  return cells;
};

interface Want {
  readonly cell: Cell;
  readonly distance: number;
  readonly detail: DetailLevel;
}

export class ParcelStreamer {
  private readonly cells = new Map<number, Cell>();
  private readonly resident = new Set<number>();
  private view: { readonly x: number; readonly z: number } | null = null;
  private builtMs = 0;
  private pending = 0;
  private building: CellBuild | null = null;
  private readonly root: THREE.Object3D;
  private readonly detail: DetailLevel;

  constructor(root: THREE.Object3D, detail: DetailLevel) {
    this.root = root;
    this.detail = detail;
  }

  /**
   * Take on a world tile's fabric. Cells are keyed on the 80u grid inside the
   * tile; a later update() streams them like any other. A tile already
   * present is replaced.
   */
  addTile(tile: number, plans: PackedPlans, lots: PackedLots): void {
    this.removeTile(tile);
    const planCells = cellIndices(plans);
    const lotCells = cellIndices(lots);
    const keys = new Set([...planCells.keys(), ...lotCells.keys()]);
    for (const key of keys) {
      const gx = Math.floor(key / 4096);
      const gz = key % 4096;
      const cell: Cell = {
        cx: (gx + 0.5) * STREAM_CELL - WORLD_HALF_X,
        cz: (gz + 0.5) * STREAM_CELL - WORLD_HALF_Z,
        key,
        residence: { kind: "absent" },
        source: {
          lotIdx: Uint32Array.from(lotCells.get(key) ?? []),
          lots,
          planIdx: Uint32Array.from(planCells.get(key) ?? []),
          plans,
        },
        targetDetail: 0,
        tile,
      };
      const previous = this.cells.get(key);
      if (previous) {
        this.free(previous);
      }
      this.cells.set(key, cell);
    }
  }

  /** Drop a tile's cells: resident geometry disposes, queued work is abandoned. */
  removeTile(tile: number): void {
    if (this.building && this.building.cell.tile === tile) {
      this.building = null;
    }
    for (const [key, cell] of this.cells) {
      if (cell.tile !== tile) {
        continue;
      }
      this.free(cell);
      this.cells.delete(key);
    }
  }

  stats(): ParcelStreamStats {
    let verts = 0;
    let bytes = 0;
    let detailedCells = 0;
    for (const k of this.resident) {
      const c = this.cells.get(k);
      if (!c || c.residence.kind === "absent") {
        continue;
      }
      if (c.residence.detail > 0) {
        detailedCells += 1;
      }
      verts += c.residence.verts;
      bytes += c.residence.bytes;
    }
    return {
      builtMs: this.builtMs,
      bytes,
      cells: this.cells.size,
      detailedCells,
      pending: this.pending,
      resident: this.resident.size,
      verts,
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
    const reach = Number.isFinite(radius)
      ? Math.min(radius, streamRadiusFor(1, this.detail))
      : radius;
    const jump =
      this.view === null || Math.hypot(x - this.view.x, z - this.view.z) > STREAM_CELL * 2;
    this.view = { x, z };
    const want = this.wanted(x, z, reach, jump);
    this.pending = want.length;
    const { building } = this;
    if (
      building &&
      (jump || !want.some((next) => next.cell === building.cell && next.detail === building.detail))
    ) {
      // Unattached typed arrays need no GPU disposal. Dropping the generator
      // also drops its buckets, so abandoned teleports cannot leave queued work.
      this.building = null;
    }
    if (want.length === 0) {
      return;
    }
    want.sort((a, b) => a.distance - b.distance);
    const deadline = fill ? Infinity : started + BUILD_BUDGET_MS;
    // Even scanning/disposal can exhaust a weak device's slice. Always advance
    // one parcel or flush so a populated frontier cannot starve indefinitely.
    let advanced = false;
    while (want.length > 0 && (!advanced || performance.now() < deadline)) {
      const [next] = want;
      if (!next) {
        break;
      }
      // Finish a valid in-flight cell before starting another. During normal
      // driving the camera barely moves within this short construction window.
      if (!this.building) {
        const src = next.cell.source;
        this.building = {
          cell: next.cell,
          detail: next.detail,
          steps: buildParcelGeometrySteps(
            unpackPlans(src.plans, src.planIdx),
            next.detail,
            unpackLots(src.lots, src.lotIdx),
          ),
        };
      }
      const job = this.building;
      const t0 = performance.now();
      let result = job.steps.next();
      advanced = true;
      while (!result.done && performance.now() < deadline) {
        result = job.steps.next();
      }
      if (result.done) {
        this.install(job.cell, job.detail, result.value);
        this.building = null;
        this.pending -= 1;
        const completed = want.findIndex((item) => item.cell === job.cell);
        want.splice(completed, 1);
      }
      this.builtMs += performance.now() - t0;
      if (!result.done) {
        break;
      }
    }
  }

  /** Cells to (re)build around (x, z), freeing the ones that fell out of reach. */
  private wanted(x: number, z: number, radius: number, jump: boolean): Want[] {
    const want: Want[] = [];
    // Departed neighbourhoods release immediately after a teleport; building
    // the destination is budgeted just like ordinary movement.
    const drop = radius + (jump ? 0 : STREAM_HYSTERESIS);
    for (const c of this.cells.values()) {
      const d = Math.hypot(c.cx - x, c.cz - z);
      const oldDetail = c.residence.kind === "resident" ? c.residence.detail : 0;
      const detail = parcelDetailForDistance(d, this.detail, jump ? 0 : c.targetDetail);
      c.targetDetail = detail;
      if (c.residence.kind === "absent") {
        if (d < radius) {
          want.push({ cell: c, detail, distance: d });
        }
      } else if (d > drop) {
        this.free(c);
      } else if (detail !== oldDetail) {
        want.push({ cell: c, detail, distance: d });
      }
    }
    return want;
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
      bytes: geometryBytes(geometry),
      detail,
      group,
      kind: "resident",
      verts: geometry.stats.vertices,
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
    if (c.residence.kind === "absent") {
      return;
    }
    for (const child of c.residence.group.children) {
      if (child instanceof THREE.Mesh) {
        child.geometry.dispose();
      }
    }
    this.root.remove(c.residence.group);
    c.residence = { kind: "absent" };
    this.resident.delete(c.key);
  }
}
