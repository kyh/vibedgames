// What a player can read off the screen, as small vectors relative to the
// player: the fight worth taking, the loot worth walking to, where the gas
// is. `vg playtest run`'s decision model sees nothing else, so rankings are
// digested here into single named fields rather than left as lists to sort.

import { nearestBox, nearestCube } from "./ai/goals";
import type { Brawler } from "./entities/brawler";
import type { Game } from "./game";
import { dist } from "./utils";

/** Roughly the half-width of the match camera's view; further brawlers are off screen. */
const VIEW_RANGE = 16;
const CROWD_RANGE = 9;
const UNDER_FIRE_S = 1.5;

export interface SensedTarget {
  /** A shot fired now would reach: inside weapon range with nothing in the way. */
  canHit: boolean;
  dist: number;
  dx: number;
  dz: number;
  hpPct: number;
  /** Their health fraction is below the player's. */
  weakerThanYou: boolean;
}

export interface SensedLoot {
  dist: number;
  dx: number;
  dz: number;
  kind: "box" | "cube";
}

export interface SensedZone {
  centreDx: number;
  centreDz: number;
  /** The gas is visible and shrinking the safe zone. */
  closing: boolean;
  /** Units of safe ground between the player and the gas; negative once inside it. */
  margin: number;
  outside: boolean;
}

export interface PlaytestSense {
  ammo: number;
  bestTarget: SensedTarget | null;
  enemiesNear: number;
  hpPct: number;
  nearestLoot: SensedLoot | null;
  superReady: boolean;
  underFire: boolean;
  weaponRange: number;
  zone: SensedZone;
}

const round1 = (value: number): number => Math.round(value * 10) / 10;
const round2 = (value: number): number => Math.round(value * 100) / 100;

/** Throwers lob over walls; everyone else needs a clear line. */
export const canHit = (game: Game, player: Brawler, x: number, z: number): boolean => {
  const { attack } = player.def;
  if (dist(player.x, player.z, x, z) > attack.range * 0.95) {
    return false;
  }
  return attack.kind === "lob" || game.world.hasLineOfSight(player.x, player.z, x, z);
};

const isVisibleEnemy = (player: Brawler, other: Brawler): boolean =>
  other !== player && other.alive && !other.hidden && !other.airborne;

/**
 * The opponent worth fighting: one a shot reaches beats one that needs a
 * walk, then the closer and the more hurt. Null when nobody is on screen.
 */
export const pickBestTarget = (game: Game, player: Brawler): Brawler | null => {
  let best: Brawler | null = null;
  let bestCost = Number.POSITIVE_INFINITY;
  for (const other of game.brawlers) {
    if (!isVisibleEnemy(player, other)) {
      continue;
    }
    const range = dist(player.x, player.z, other.x, other.z);
    if (range > VIEW_RANGE) {
      continue;
    }
    const reachable = canHit(game, player, other.x, other.z) ? 0 : 4;
    const cost = range + reachable + (other.hp / other.maxHp) * 3;
    if (cost < bestCost) {
      best = other;
      bestCost = cost;
    }
  }
  return best;
};

const senseTarget = (game: Game, player: Brawler): SensedTarget | null => {
  const target = pickBestTarget(game, player);
  if (!target) {
    return null;
  }
  const hpPct = target.hp / target.maxHp;
  return {
    canHit: canHit(game, player, target.x, target.z),
    dist: round1(dist(player.x, player.z, target.x, target.z)),
    dx: round1(target.x - player.x),
    dz: round1(target.z - player.z),
    hpPct: round2(hpPct),
    weakerThanYou: hpPct < player.hp / player.maxHp,
  };
};

const senseLoot = (game: Game, player: Brawler): SensedLoot | null => {
  const cube = nearestCube(game, player);
  const found = cube ?? nearestBox(game, player);
  if (!found) {
    return null;
  }
  return {
    dist: round1(dist(player.x, player.z, found.x, found.z)),
    dx: round1(found.x - player.x),
    dz: round1(found.z - player.z),
    kind: cube ? "cube" : "box",
  };
};

const countNear = (player: Brawler, brawlers: readonly Brawler[]): number =>
  brawlers.filter(
    (other) =>
      isVisibleEnemy(player, other) && dist(player.x, player.z, other.x, other.z) < CROWD_RANGE,
  ).length;

export const sensePlaytest = (game: Game): PlaytestSense | null => {
  const { gas, player } = game;
  if (!player) {
    return null;
  }
  const depth = gas.depthAt(player.x, player.z);
  return {
    ammo: Math.floor(player.ammo),
    bestTarget: senseTarget(game, player),
    enemiesNear: countNear(player, game.brawlers),
    hpPct: round2(player.hp / player.maxHp),
    nearestLoot: senseLoot(game, player),
    superReady: player.superReady,
    underFire: game.elapsed - player.lastHitTime < UNDER_FIRE_S,
    weaponRange: player.def.attack.range,
    zone: {
      centreDx: round1(-player.x),
      centreDz: round1(-player.z),
      closing: gas.active,
      margin: round1(-depth),
      outside: depth > 0,
    },
  };
};
