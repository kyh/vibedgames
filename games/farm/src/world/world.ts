import { MAP_W, MAP_H } from "../config";
import type { CropId } from "../data/crops";
import { CELL, type Cell, type WorldMap, buildSemantics } from "./worldmap";

// Legacy ground vocabulary kept for the scenes: grass = tillable, water =
// fishable/refill, sand = any other walkable ground.
export const GROUND = { grass: 0, water: 1, sand: 2 } as const;
export type Ground = (typeof GROUND)[keyof typeof GROUND];

export type CropState = {
  crop: CropId;
  daysGrown: number; // watered days accumulated
};

export type ObjType =
  | "tree"
  | "rock"
  | "house"
  | "shop"
  | "bin"
  | "cave"
  | "barn"
  | "coop"
  | "forage"
  | "ore"; // ore nodes used in the mine

export type WorldObject = {
  id: number;
  type: ObjType;
  tx: number;
  ty: number; // anchor tile (bottom for buildings/trees)
  w: number; // footprint width in tiles (collision)
  h: number; // footprint height in tiles (collision)
  hp: number;
  maxHp: number;
  variant?: string; // e.g. forage kind, ore kind, tree art
  solid?: boolean; // override: forage is non-solid (walk over to pick)
};

export function inBounds(tx: number, ty: number): boolean {
  return tx >= 0 && ty >= 0 && tx < MAP_W && ty < MAP_H;
}

// Buildings/trees occupy their footprint counting up from the anchor tile.
function covers(o: WorldObject, tx: number, ty: number): boolean {
  const x0 = o.tx - ((o.w - 1) >> 1);
  return tx >= x0 && tx <= x0 + o.w - 1 && ty >= o.ty - o.h + 1 && ty <= o.ty;
}

function footprintKeys(o: WorldObject): number[] {
  const keys: number[] = [];
  const x0 = o.tx - ((o.w - 1) >> 1);
  for (let ty = o.ty - o.h + 1; ty <= o.ty; ty++) {
    for (let tx = x0; tx < x0 + o.w; tx++) {
      if (inBounds(tx, ty)) keys.push(ty * MAP_W + tx);
    }
  }
  return keys;
}

export class World {
  // static, derived from the world map — never serialized
  kind: Uint8Array = new Uint8Array(MAP_W * MAP_H);
  // dynamic state
  tilled: Uint8Array = new Uint8Array(MAP_W * MAP_H);
  watered: Uint8Array = new Uint8Array(MAP_W * MAP_H);
  crops = new Map<number, CropState>();
  objects: WorldObject[] = [];
  nextId = 1;
  // tile idx -> first object (in array order) covering it. Objects never move,
  // so the index only changes in addObject/removeObject/fromJSON.
  private occupied = new Map<number, WorldObject>();

  constructor(worldMap?: WorldMap) {
    if (worldMap) this.kind = buildSemantics(worldMap).kind;
  }

  idx(tx: number, ty: number): number {
    return ty * MAP_W + tx;
  }

  cellKind(tx: number, ty: number): Cell {
    const v = this.kind[this.idx(tx, ty)] ?? CELL.void;
    return v as Cell;
  }

  getGround(tx: number, ty: number): Ground {
    switch (this.cellKind(tx, ty)) {
      case CELL.grass:
        return GROUND.grass;
      case CELL.water:
      case CELL.void:
        return GROUND.water;
      default:
        return GROUND.sand;
    }
  }

  addObject(o: Omit<WorldObject, "id">): WorldObject {
    const obj = { ...o, id: this.nextId++ };
    this.objects.push(obj);
    this.indexObject(obj);
    return obj;
  }

  removeObject(o: WorldObject): void {
    const i = this.objects.indexOf(o);
    if (i >= 0) this.objects.splice(i, 1);
    for (const key of footprintKeys(o)) {
      if (this.occupied.get(key) !== o) continue;
      this.occupied.delete(key);
      // an overlapping object may have been shadowed on this tile
      const tx = key % MAP_W;
      const ty = (key / MAP_W) | 0;
      const other = this.objects.find((c) => covers(c, tx, ty));
      if (other) this.occupied.set(key, other);
    }
  }

  private indexObject(o: WorldObject): void {
    for (const key of footprintKeys(o)) {
      if (!this.occupied.has(key)) this.occupied.set(key, o);
    }
  }

  // Object occupying a tile (for collision / targeting).
  objectAt(tx: number, ty: number): WorldObject | null {
    if (!inBounds(tx, ty)) return null;
    return this.occupied.get(this.idx(tx, ty)) ?? null;
  }

  isSolidTile(tx: number, ty: number): boolean {
    if (!inBounds(tx, ty)) return true;
    const k = this.cellKind(tx, ty);
    if (k === CELL.solid || k === CELL.water || k === CELL.void) return true;
    const o = this.objectAt(tx, ty);
    return o !== null && o.solid !== false;
  }

  canTill(tx: number, ty: number): boolean {
    if (!inBounds(tx, ty)) return false;
    if (this.cellKind(tx, ty) !== CELL.grass) return false;
    if (this.tilled[this.idx(tx, ty)]) return false;
    if (this.objectAt(tx, ty)) return false;
    return true;
  }

  // ---- serialization (dynamic state only; terrain rebuilds from the world map) ----
  toJSON() {
    return {
      tilled: Array.from(this.tilled),
      watered: Array.from(this.watered),
      crops: Array.from(this.crops.entries()),
      objects: this.objects,
      nextId: this.nextId,
    };
  }

  static fromJSON(d: ReturnType<World["toJSON"]>, worldMap: WorldMap): World {
    const w = new World(worldMap);
    w.tilled = new Uint8Array(d.tilled);
    w.watered = new Uint8Array(d.watered);
    w.crops = new Map(d.crops);
    w.objects = d.objects;
    w.nextId = d.nextId;
    for (const o of w.objects) w.indexObject(o);
    return w;
  }
}
