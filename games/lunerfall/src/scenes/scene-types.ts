import type Phaser from "phaser";

import type { Relic } from "../data/relics";
import type { Enemy } from "../entities/enemy";
import type { Player } from "../entities/player";

export type SceneState = "active" | "dead" | "transition" | "connecting";

export interface Arrow {
  spr: Phaser.GameObjects.Sprite;
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  dmg: number;
}
export interface Shot {
  spr: Phaser.GameObjects.Sprite;
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  dmg: number;
  // caster — a shot never hits its own thrower (versus)
  owner: Player | null;
  hit: Set<Enemy>;
  // versus: per-duelist hit dedup
  hitP: Set<Player>;
  hitBoss: boolean;
}
export interface Hazard {
  spr: Phaser.GameObjects.Sprite;
  x: number;
  y: number;
  vx: number;
  life: number;
  dmg: number;
  hitPlayer: boolean;
}
export interface Feature {
  x: number;
  y: number;
  used: boolean;
  g: Phaser.GameObjects.Container;
}
export interface MerchantItem {
  x: number;
  y: number;
  relic: Relic;
  bought: boolean;
  g: Phaser.GameObjects.Container;
}

// Per-player melee/special hit-dedup so one swing hits each enemy once.
export interface CombatState {
  hitSwing: Set<Enemy>;
  lastSwing: number;
  hitSpecial: Set<Enemy>;
  lastSpecial: number;
  bossSwing: number;
  bossSpecial: number;
}
export const newCombatState = (): CombatState => ({
  bossSpecial: -1,
  bossSwing: -1,
  hitSpecial: new Set(),
  hitSwing: new Set(),
  lastSpecial: -1,
  lastSwing: -1,
});
