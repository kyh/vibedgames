import { TILE } from "../config";
import { COLS, Grid, ROWS } from "../sys/grid";

export type RoomType = "start" | "combat" | "elite" | "merchant" | "rest" | "treasure" | "boss";

export const ROOM_TYPES: readonly RoomType[] = [
  "start",
  "combat",
  "elite",
  "merchant",
  "rest",
  "treasure",
  "boss",
];

export const parseRoomType = (s: string) => ROOM_TYPES.find((t) => t === s) ?? null;

export interface Spawn {
  x: number;
  y: number;
}

const feet = (cx: number, cy: number) => ({ x: (cx + 0.5) * TILE, y: (cy + 1) * TILE });

export class RoomDef {
  readonly grid: Grid;
  readonly cols: number;
  readonly rows: number;
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

  arena() {
    for (let y = 0; y < this.rows; y += 1) {
      this.grid.set(0, y, 1);
      this.grid.set(this.cols - 1, y, 1);
    }

    this.grid.fill(0, 0, this.cols - 1, 0, 1);
    this.grid.fill(0, this.rows - 2, this.cols - 1, this.rows - 1, 1);

    return this;
  }
  block(cx0: number, cy: number, cx1: number, h = 2) {
    this.grid.fill(cx0, cy, cx1, cy + h - 1, 1);

    return this;
  }
  oneway(cx0: number, cy: number, cx1: number) {
    this.grid.fill(cx0, cy, cx1, cy, 2);

    return this;
  }
  player(cx: number, cy: number) {
    this.playerSpawn = feet(cx, cy);

    return this;
  }
  enemy(cx: number, cy: number) {
    this.enemySpawns.push(feet(cx, cy));

    return this;
  }
  door(cx: number, cy: number) {
    this.doorSlots.push(feet(cx, cy));

    return this;
  }
  feature(cx: number, cy: number) {
    this.featureSpot = feet(cx, cy);

    return this;
  }
  boss(cx: number, cy: number) {
    this.bossSpawn = feet(cx, cy);

    return this;
  }
}

const RH = 21;
const S = RH - 3;

export const START = () =>
  new RoomDef(46, RH)
    .arena()
    .block(9, S - 3, 15)
    .oneway(20, S - 5, 27)
    .block(31, S - 4, 38)
    .player(4, S)
    .door(35, S - 5);

export const SAFE = () =>
  new RoomDef(44, RH)
    .arena()
    .block(17, S - 3, 26)
    .oneway(6, S - 5, 13)
    .oneway(30, S - 5, 37)
    .player(4, S)
    .feature(21, S - 4)
    .door(8, S - 6)
    .door(35, S - 6);

export const VERSUS = () =>
  new RoomDef(32, 17)
    .arena()
    .block(14, 13, 17, 1)
    .block(4, 12, 9, 2)
    .block(22, 12, 27, 2)
    .oneway(12, 9, 19)
    .player(11, 14);

export const BOSS = () =>
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
