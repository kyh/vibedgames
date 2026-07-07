import { TILE } from "../config";
import { COLS, Grid, ROWS } from "../sys/grid";

// Rooms are built programmatically (no ASCII grids to miscount). Feet-anchored
// markers: a marker at tile (cx, cy) stands on top of the solid tile at cy+1.

export type RoomType = "start" | "combat" | "elite" | "merchant" | "rest" | "treasure" | "boss";
// Runtime list of every room type — lets the net layer parse a wire string back
// into a RoomType without a cast.
export const ROOM_TYPES: readonly RoomType[] = [
  "start",
  "combat",
  "elite",
  "merchant",
  "rest",
  "treasure",
  "boss",
];
export const parseRoomType = (s: string): RoomType | null =>
  ROOM_TYPES.find((t) => t === s) ?? null;
export type Spawn = { x: number; y: number };

// Rooms are now multi-screen: each RoomDef sizes its own Grid (cols × rows) and
// the camera scrolls over it. Bottom 2 rows are the floor; feet stand on tile
// cy+1, so the ground stand row is `rows - 3`.
export class RoomDef {
  readonly grid: Grid;
  readonly cols: number;
  readonly rows: number;
  readonly stand: number; // ground stand row (feet marker cy)
  playerSpawn: Spawn;
  enemySpawns: Spawn[] = [];
  doorSlots: Spawn[] = [];
  featureSpot: Spawn | null = null;
  bossSpawn: Spawn | null = null;

  constructor(cols: number = COLS, rows: number = ROWS) {
    this.grid = new Grid(cols, rows);
    this.cols = cols;
    this.rows = rows;
    this.stand = rows - 3;
    this.playerSpawn = { x: 3 * TILE, y: (this.stand + 1) * TILE };
  }

  private feet(cx: number, cy: number): Spawn {
    return { x: (cx + 0.5) * TILE, y: (cy + 1) * TILE };
  }

  arena(): this {
    for (let y = 0; y < this.rows; y++) {
      this.grid.set(0, y, 1);
      this.grid.set(this.cols - 1, y, 1);
    }
    this.grid.fill(0, 0, this.cols - 1, 0, 1); // ceiling
    this.grid.fill(0, this.rows - 2, this.cols - 1, this.rows - 1, 1); // floor
    return this;
  }
  // A solid platform that's `h` tiles thick (chunky ledge, like the art).
  block(cx0: number, cy: number, cx1: number, h = 2): this {
    this.grid.fill(cx0, cy, cx1, cy + h - 1, 1);
    return this;
  }
  oneway(cx0: number, cy: number, cx1: number): this {
    this.grid.fill(cx0, cy, cx1, cy, 2);
    return this;
  }
  player(cx: number, cy: number): this {
    this.playerSpawn = this.feet(cx, cy);
    return this;
  }
  enemy(cx: number, cy: number): this {
    this.enemySpawns.push(this.feet(cx, cy));
    return this;
  }
  door(cx: number, cy: number): this {
    this.doorSlots.push(this.feet(cx, cy));
    return this;
  }
  feature(cx: number, cy: number): this {
    this.featureSpot = this.feet(cx, cy);
    return this;
  }
  boss(cx: number, cy: number): this {
    this.bossSpawn = this.feet(cx, cy);
    return this;
  }
}

// Standard room extent (tiles). ~2.7 screens wide, taller for verticality.
const RW = 52;
const RH = 21;
const S = RH - 3; // 18 — ground stand row

export const START = (): RoomDef =>
  new RoomDef(46, RH)
    .arena()
    .block(9, S - 3, 15) // gentle left step
    .oneway(20, S - 5, 27)
    .block(31, S - 4, 38) // right ledge with the exit
    .player(4, S)
    .door(35, S - 5);

export const SAFE = (): RoomDef =>
  new RoomDef(44, RH)
    .arena()
    .block(17, S - 3, 26) // central shrine dais
    .oneway(6, S - 5, 13)
    .oneway(30, S - 5, 37)
    .player(4, S)
    .feature(21, S - 4)
    .door(8, S - 6)
    .door(35, S - 6);

// Online versus duel stage: compact (~one screen), left-right symmetric so
// neither duelist has an advantage. playerSpawn is the host's (left) point; the
// guest spawns at its mirror (cols*TILE - x). No doors/enemies/features.
export const VERSUS = (): RoomDef =>
  new RoomDef(32, 17)
    .arena()
    .block(14, 13, 17, 1) // low centre riser
    .block(4, 12, 9, 2) // left ledge
    .block(22, 12, 27, 2) // right ledge (mirror)
    .oneway(12, 9, 19) // high centre platform
    .player(4, 14);

export const BOSS = (): RoomDef =>
  new RoomDef(50, RH + 1)
    .arena()
    .block(4, RH - 5, 11)
    .block(38, RH - 5, 45)
    .oneway(18, RH - 8, 31)
    .player(6, RH - 2)
    .boss(25, RH - 2)
    .door(43, RH - 6);

export const ROOM_ICON: Record<RoomType, string> = {
  start: "◆",
  combat: "⚔",
  elite: "☠",
  merchant: "◈",
  rest: "✚",
  treasure: "◇",
  boss: "✦",
};

export const ROOM_LABEL: Record<RoomType, string> = {
  start: "START",
  combat: "FIGHT",
  elite: "ELITE",
  merchant: "SHRINE",
  rest: "REST",
  treasure: "CACHE",
  boss: "BOSS",
};
