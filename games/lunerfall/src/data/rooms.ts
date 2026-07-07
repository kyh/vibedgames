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

// Legacy single-screen stand row (kept for anything still referencing it).
export const STAND_ROW = ROWS - 3;

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
  solid(cx0: number, cy: number, cx1: number): this {
    this.grid.fill(cx0, cy, cx1, cy, 1);
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

export const COMBAT_TEMPLATES: (() => RoomDef)[] = [
  // Symmetric twin towers + central ruin (Image #1 layout).
  () =>
    new RoomDef(RW, RH)
      .arena()
      .oneway(7, S - 3, 13)
      .block(3, S - 6, 12) // left tower platform (door)
      .oneway(38, S - 3, 44)
      .block(39, S - 6, 48) // right tower platform (door)
      .block(22, S - 2, 29) // central raised ruin
      .oneway(19, S - 6, 32) // ruin high ledge
      .player(6, S)
      .enemy(26, S)
      .enemy(26, S - 7)
      .enemy(7, S - 7)
      .enemy(44, S - 7)
      .door(6, S - 7)
      .door(45, S - 7),
  // Staggered rising ledges across.
  () =>
    new RoomDef(RW, RH)
      .arena()
      .oneway(6, S - 3, 12)
      .block(15, S - 4, 21)
      .oneway(24, S - 6, 30)
      .block(33, S - 5, 40)
      .oneway(43, S - 3, 49)
      .player(4, S)
      .enemy(18, S - 5)
      .enemy(36, S - 6)
      .enemy(48, S)
      .enemy(27, S - 7)
      .door(4, S - 4)
      .door(47, S - 4),
  // Cavernous — hanging one-ways + low pits of ledges.
  () =>
    new RoomDef(RW, RH)
      .arena()
      .block(10, S - 2, 16)
      .block(35, S - 2, 41)
      .oneway(8, S - 6, 18)
      .oneway(33, S - 6, 43)
      .oneway(22, S - 4, 29)
      .block(23, S - 8, 28)
      .player(4, S)
      .enemy(13, S - 3)
      .enemy(38, S - 3)
      .enemy(25, S - 9)
      .enemy(48, S)
      .door(6, S - 7)
      .door(46, S - 7),
];

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
