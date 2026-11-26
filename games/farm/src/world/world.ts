import { MAP_W, MAP_H } from "../config";
import type { Season } from "../data/calendar";
import { CROPS } from "../data/crops";
import type { CropId } from "../data/crops";
import { CELL, buildSemantics } from "./worldmap";
import type { Cell, WorldMap } from "./worldmap";

const isCell = (v: number): v is Cell => Number.isInteger(v) && v >= CELL.void && v <= CELL.solid;

export const GROUND = { grass: 0, sand: 2, water: 1 } as const;

export type Ground = (typeof GROUND)[keyof typeof GROUND];

export interface CropState {
  crop: CropId;
  daysGrown: number;
}

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
  | "ore";

export interface WorldObject {
  id: number;
  type: ObjType;
  tx: number;
  ty: number;
  w: number;
  h: number;
  hp: number;
  maxHp: number;
  variant?: string;
  solid?: boolean;
}

export const inBounds = (tx: number, ty: number) => tx >= 0 && ty >= 0 && tx < MAP_W && ty < MAP_H;

/** Trees, rocks and forage: the objects a farmer can take off the map. */
export const isClearable = (o: WorldObject) =>
  o.type === "tree" || o.type === "rock" || o.type === "forage";

export const tileIdx = (tx: number, ty: number) => ty * MAP_W + tx;

const footprintX0 = (o: WorldObject) => o.tx - Math.floor((o.w - 1) / 2);

const covers = (o: WorldObject, tx: number, ty: number) => {
  const x0 = footprintX0(o);

  return tx >= x0 && tx <= x0 + o.w - 1 && ty >= o.ty - o.h + 1 && ty <= o.ty;
};

const footprintKeys = (o: WorldObject) => {
  const keys: number[] = [];
  const x0 = footprintX0(o);

  for (let ty = o.ty - o.h + 1; ty <= o.ty; ty += 1) {
    for (let tx = x0; tx < x0 + o.w; tx += 1) {
      if (inBounds(tx, ty)) {
        keys.push(tileIdx(tx, ty));
      }
    }
  }

  return keys;
};

export class World {
  kind: Uint8Array = new Uint8Array(MAP_W * MAP_H);
  tilled: Uint8Array = new Uint8Array(MAP_W * MAP_H);
  watered: Uint8Array = new Uint8Array(MAP_W * MAP_H);
  crops = new Map<number, CropState>();
  gens: Uint16Array = new Uint16Array(MAP_W * MAP_H);
  objects: WorldObject[] = [];
  nextId = 1;
  private readonly occupied = new Map<number, WorldObject>();

  constructor(worldMap?: WorldMap) {
    if (worldMap) {
      this.kind = buildSemantics(worldMap).kind;
    }
  }

  cellKind(tx: number, ty: number) {
    const v = this.kind[tileIdx(tx, ty)] ?? CELL.void;

    return isCell(v) ? v : CELL.void;
  }

  getGround(tx: number, ty: number) {
    const kind = this.cellKind(tx, ty);

    switch (kind) {
      case CELL.grass: {
        return GROUND.grass;
      }

      case CELL.water:
      case CELL.void: {
        return GROUND.water;
      }

      case CELL.sand:
      case CELL.dirt:
      case CELL.solid: {
        return GROUND.sand;
      }

      default: {
        const unhandled: never = kind;
        throw new Error("unhandled case", { cause: unhandled });
      }
    }
  }

  addObject(o: Omit<WorldObject, "id">) {
    const obj = { ...o, id: this.nextId };
    this.nextId += 1;
    this.objects.push(obj);
    this.indexObject(obj);

    return obj;
  }

  /** Put back an object removed earlier, under its original id — co-op object
   *  keys name generated ids, which addObject would not keep. */
  restoreObject(o: WorldObject) {
    this.objects.push(o);
    this.indexObject(o);
    this.nextId = Math.max(this.nextId, o.id + 1);
  }

  removeObject(o: WorldObject) {
    const i = this.objects.indexOf(o);

    if (i !== -1) {
      this.objects.splice(i, 1);
    }

    for (const key of footprintKeys(o)) {
      if (this.occupied.get(key) !== o) {
        continue;
      }

      this.occupied.delete(key);
      const tx = key % MAP_W;
      const ty = Math.trunc(key / MAP_W);
      const other = this.objects.find((c) => covers(c, tx, ty));

      if (other) {
        this.occupied.set(key, other);
      }
    }
  }

  private indexObject(o: WorldObject) {
    for (const key of footprintKeys(o)) {
      if (!this.occupied.has(key)) {
        this.occupied.set(key, o);
      }
    }
  }

  objectAt(tx: number, ty: number) {
    if (!inBounds(tx, ty)) {
      return null;
    }

    return this.occupied.get(tileIdx(tx, ty)) ?? null;
  }

  isSolidTile(tx: number, ty: number) {
    if (!inBounds(tx, ty)) {
      return true;
    }

    const k = this.cellKind(tx, ty);

    if (k === CELL.solid || k === CELL.water || k === CELL.void) {
      return true;
    }

    const o = this.objectAt(tx, ty);

    return o !== null && o.solid !== false;
  }

  canTill(tx: number, ty: number) {
    if (!inBounds(tx, ty)) {
      return false;
    }

    if (this.cellKind(tx, ty) !== CELL.grass) {
      return false;
    }

    if ((this.tilled[tileIdx(tx, ty)] ?? 0) !== 0) {
      return false;
    }

    if (this.objectAt(tx, ty)) {
      return false;
    }

    return this.objectAt(tx, ty + 1)?.type !== "tree";
  }

  /**
   * The soil's night before a day in `season`: crops out of season wither,
   * watered (or rained-on) ones grow a day, and the soil dries — or stays wet
   * under rain. Returns the tiles that changed, so co-op sends only those.
   */
  growOvernight(season: Season, rainy: boolean) {
    const changed = new Set<number>();

    for (const [i, cs] of this.crops) {
      const def = CROPS[cs.crop];

      if (!def.seasons.includes(season)) {
        this.crops.delete(i);
        changed.add(i);
      } else if ((this.watered[i] === 1 || rainy) && cs.daysGrown < def.growthDays) {
        cs.daysGrown += 1;
        changed.add(i);
      }
    }

    for (let i = 0; i < this.watered.length; i += 1) {
      const wet = rainy && this.tilled[i] === 1 ? 1 : 0;

      if (this.watered[i] !== wet) {
        this.watered[i] = wet;
        changed.add(i);
      }
    }

    return changed;
  }

  toJSON() {
    return {
      crops: [...this.crops.entries()],
      nextId: this.nextId,
      objects: this.objects,
      tilled: [...this.tilled],
      watered: [...this.watered],
    };
  }

  static fromJSON(d: ReturnType<World["toJSON"]>, worldMap: WorldMap) {
    const w = new World(worldMap);
    w.tilled = new Uint8Array(d.tilled);
    w.watered = new Uint8Array(d.watered);
    w.crops = new Map(d.crops);
    w.objects = d.objects;
    w.nextId = d.nextId;

    for (const o of w.objects) {
      w.indexObject(o);
    }

    return w;
  }
}
