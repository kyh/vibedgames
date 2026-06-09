import { MAP_W, MAP_H } from "../config";
import type { CropId } from "../data/crops";

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
  | "windmill"
  | "fence"
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
  variant?: string; // e.g. forage kind, ore kind
  solid?: boolean; // override: forage is non-solid (walk over to pick)
};

export function inBounds(tx: number, ty: number): boolean {
  return tx >= 0 && ty >= 0 && tx < MAP_W && ty < MAP_H;
}

// Non-colliding, non-interactive scenery (flowers, bushes, boat). Render-only.
export type Decal = {
  type: "flower" | "bush" | "coracle";
  tx: number;
  ty: number;
  variant: string;
};

export class World {
  ground = new Uint8Array(MAP_W * MAP_H);
  gv = new Uint8Array(MAP_W * MAP_H); // grass variant 0..5
  tilled = new Uint8Array(MAP_W * MAP_H);
  watered = new Uint8Array(MAP_W * MAP_H);
  crops = new Map<number, CropState>();
  objects: WorldObject[] = [];
  decals: Decal[] = [];
  nextId = 1;

  idx(tx: number, ty: number): number {
    return ty * MAP_W + tx;
  }

  getGround(tx: number, ty: number): Ground {
    return this.ground[this.idx(tx, ty)] as Ground;
  }

  addObject(o: Omit<WorldObject, "id">): WorldObject {
    const obj = { ...o, id: this.nextId++ };
    this.objects.push(obj);
    return obj;
  }

  removeObject(o: WorldObject): void {
    const i = this.objects.indexOf(o);
    if (i >= 0) this.objects.splice(i, 1);
  }

  // Object occupying a tile (for collision / targeting). Buildings/trees occupy
  // their footprint counting up from the anchor tile.
  objectAt(tx: number, ty: number): WorldObject | null {
    for (const o of this.objects) {
      const x0 = o.tx - ((o.w - 1) >> 1);
      const x1 = x0 + o.w - 1;
      const y0 = o.ty - o.h + 1;
      const y1 = o.ty;
      if (tx >= x0 && tx <= x1 && ty >= y0 && ty <= y1) return o;
    }
    return null;
  }

  isSolidTile(tx: number, ty: number): boolean {
    if (!inBounds(tx, ty)) return true;
    if (this.getGround(tx, ty) === GROUND.water) return true;
    const o = this.objectAt(tx, ty);
    return o !== null && o.solid !== false;
  }

  canTill(tx: number, ty: number): boolean {
    if (!inBounds(tx, ty)) return false;
    const g = this.getGround(tx, ty);
    if (g === GROUND.water) return false;
    if (this.tilled[this.idx(tx, ty)]) return false;
    if (this.objectAt(tx, ty)) return false;
    return true;
  }

  // ---- serialization (compact) ----
  toJSON() {
    return {
      ground: Array.from(this.ground),
      gv: Array.from(this.gv),
      tilled: Array.from(this.tilled),
      watered: Array.from(this.watered),
      crops: Array.from(this.crops.entries()),
      objects: this.objects,
      decals: this.decals,
      nextId: this.nextId,
    };
  }

  static fromJSON(d: ReturnType<World["toJSON"]>): World {
    const w = new World();
    w.ground = Uint8Array.from(d.ground);
    w.gv = Uint8Array.from(d.gv);
    w.tilled = Uint8Array.from(d.tilled);
    w.watered = Uint8Array.from(d.watered);
    w.crops = new Map(d.crops);
    w.objects = d.objects;
    w.decals = d.decals ?? [];
    w.nextId = d.nextId;
    return w;
  }
}
