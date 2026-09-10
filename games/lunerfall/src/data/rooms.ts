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
export interface Spawn {
  x: number;
  y: number;
}

// Rooms are now multi-screen: each RoomDef sizes its own Grid (cols × rows) and
// the camera scrolls over it. Bottom 2 rows are the floor; feet stand on tile
// cy+1, so the ground stand row is `rows - 3`.
// Spawn point at the centre-bottom of a tile.
const feet = (cx: number, cy: number): Spawn => ({ x: (cx + 0.5) * TILE, y: (cy + 1) * TILE });

export class RoomDef {
  readonly grid: Grid;
  readonly cols: number;
  readonly rows: number;
  // ground stand row (feet marker cy)
  readonly stand: number;
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

  arena(): this {
    for (let y = 0; y < this.rows; y += 1) {
      this.grid.set(0, y, 1);
      this.grid.set(this.cols - 1, y, 1);
    }
    // ceiling
    this.grid.fill(0, 0, this.cols - 1, 0, 1);
    // floor
    this.grid.fill(0, this.rows - 2, this.cols - 1, this.rows - 1, 1);
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
    this.playerSpawn = feet(cx, cy);
    return this;
  }
  enemy(cx: number, cy: number): this {
    this.enemySpawns.push(feet(cx, cy));
    return this;
  }
  door(cx: number, cy: number): this {
    this.doorSlots.push(feet(cx, cy));
    return this;
  }
  feature(cx: number, cy: number): this {
    this.featureSpot = feet(cx, cy);
    return this;
  }
  boss(cx: number, cy: number): this {
    this.bossSpawn = feet(cx, cy);
    return this;
  }
}

// Standard room height (tiles) — taller than the screen, for verticality.
const RH = 21;
// 18 — ground stand row
const S = RH - 3;

export const START = (): RoomDef =>
  new RoomDef(46, RH)
    .arena()
    // gentle left step
    .block(9, S - 3, 15)
    .oneway(20, S - 5, 27)
    // right ledge with the exit
    .block(31, S - 4, 38)
    .player(4, S)
    .door(35, S - 5);

export const SAFE = (): RoomDef =>
  new RoomDef(44, RH)
    .arena()
    // central shrine dais
    .block(17, S - 3, 26)
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
    // low centre riser
    .block(14, 13, 17, 1)
    // left ledge
    .block(4, 12, 9, 2)
    // right ledge (mirror)
    .block(22, 12, 27, 2)
    // high centre platform
    .oneway(12, 9, 19)
    // Col 11 (mirror: col 20) is the only band clear of BOTH the side ledges
    // (cols 4-9 / 22-27) and the centre riser. Spawning under a ledge wedged the
    // 22px body into its underside — solid at row 13 — and both duelists were
    // frozen in place for the whole round.
    //
    // Note for anyone scripting this arena: every one of those slabs is head
    // height over a body standing on the floor, so the floor is four pens
    // (x 22-58 / 166-218 / 294-346 / 454-490) and crossing between them is a
    // jump, not a walk. sim.mts asserts they stay connected.
    .player(11, 14);

export const BOSS = (): RoomDef =>
  new RoomDef(50, RH + 1)
    .arena()
    .block(4, RH - 5, 11)
    .block(38, RH - 5, 45)
    .oneway(18, RH - 8, 31)
    .player(6, RH - 2)
    .boss(25, RH - 2)
    .door(43, RH - 6);

export const ROOM_ICON = {
  boss: "✦",
  combat: "⚔",
  elite: "☠",
  merchant: "◈",
  rest: "✚",
  start: "◆",
  treasure: "◇",
} satisfies Record<RoomType, string>;

export const ROOM_LABEL = {
  boss: "BOSS",
  combat: "FIGHT",
  elite: "ELITE",
  merchant: "SHRINE",
  rest: "REST",
  start: "START",
  treasure: "CACHE",
} satisfies Record<RoomType, string>;
