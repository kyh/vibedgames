import { TILE } from "../config";
import { COLS, Grid, ROWS } from "../sys/grid";

// Rooms are built programmatically (no ASCII grids to miscount). Feet-anchored
// markers: a marker at tile (cx, cy) stands on top of the solid tile at cy+1.

export type RoomType = "start" | "combat" | "elite" | "merchant" | "rest" | "treasure" | "boss";
export type Spawn = { x: number; y: number };

export const STAND_ROW = ROWS - 3; // feet rest here on the 2-row floor (y = 240)

export class RoomDef {
  grid = new Grid();
  playerSpawn: Spawn = { x: 3 * TILE, y: (STAND_ROW + 1) * TILE };
  enemySpawns: Spawn[] = [];
  doorSlots: Spawn[] = [];
  featureSpot: Spawn | null = null;
  bossSpawn: Spawn | null = null;

  private feet(cx: number, cy: number): Spawn {
    return { x: (cx + 0.5) * TILE, y: (cy + 1) * TILE };
  }

  arena(): this {
    for (let y = 0; y < ROWS; y++) {
      this.grid.set(0, y, 1);
      this.grid.set(COLS - 1, y, 1);
    }
    this.grid.fill(0, 0, COLS - 1, 0, 1); // ceiling
    this.grid.fill(0, ROWS - 2, COLS - 1, ROWS - 1, 1); // floor
    return this;
  }
  solid(cx0: number, cy: number, cx1: number): this {
    this.grid.fill(cx0, cy, cx1, cy, 1);
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

const S = STAND_ROW; // 14

export const START = (): RoomDef =>
  new RoomDef()
    .arena()
    .oneway(11, 6, 18)
    .solid(4, 9, 8)
    .solid(21, 9, 25)
    .player(3, S)
    .door(25, S);

export const COMBAT_TEMPLATES: (() => RoomDef)[] = [
  () =>
    new RoomDef()
      .arena()
      .solid(6, 10, 10)
      .solid(19, 10, 23)
      .oneway(12, 6, 17)
      .player(3, S)
      .enemy(25, S)
      .enemy(14, S)
      .enemy(8, 9)
      .enemy(21, 9)
      .door(8, 9)
      .door(21, 9),
  () =>
    new RoomDef()
      .arena()
      .oneway(3, 11, 9)
      .oneway(20, 11, 26)
      .solid(12, 8, 17)
      .oneway(12, 12, 17)
      .player(3, S)
      .enemy(26, S)
      .enemy(6, 10)
      .enemy(23, 10)
      .enemy(14, 7)
      .door(4, 11)
      .door(25, 11),
  () =>
    new RoomDef()
      .arena()
      .solid(9, 12, 13)
      .solid(16, 12, 20)
      .oneway(4, 8, 8)
      .oneway(21, 8, 25)
      .oneway(12, 5, 17)
      .player(3, S)
      .enemy(6, S)
      .enemy(23, S)
      .enemy(14, S)
      .enemy(6, 7)
      .enemy(23, 7)
      .door(6, 7)
      .door(23, 7),
];

export const SAFE = (): RoomDef =>
  new RoomDef()
    .arena()
    .solid(11, 10, 18)
    .oneway(4, 12, 8)
    .oneway(21, 12, 25)
    .player(3, S)
    .feature(14, S)
    .door(6, 12)
    .door(23, 12);

export const BOSS = (): RoomDef =>
  new RoomDef()
    .arena()
    .solid(3, 11, 7)
    .solid(22, 11, 26)
    .oneway(12, 7, 17)
    .player(3, S)
    .boss(15, S)
    .door(25, 11);

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
