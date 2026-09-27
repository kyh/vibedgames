// What a player reads off the screen, as the small relative vectors a
// vision-less playtester decides from. Pure over the sim — the camera rect is
// the only view input, and only to say where a target sits on screen.

import { enemyOf } from "../data/config";
import { HERO_BY_ID, valAt } from "../data/heroes";
import type { AbilityDef, AbilityKey } from "../data/heroes";
import { BASES, ELEV_LIFT, TOWERS, WORLD, elevationFrac } from "../data/map";
import type { LaneId } from "../data/map";
import { laneObjective } from "../sim/ai";
import { isEnemy, targetable } from "../sim/combat";
import { dist } from "../sim/math";
import type { Vec2 } from "../sim/math";
import { findPath } from "../sim/nav";
import { effectiveAttackDamage, silenced } from "../sim/stats";
import type { Unit, World } from "../sim/types";

export interface ViewRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface ScreenPoint {
  sx: number;
  sy: number;
}

export interface TargetSense {
  dx: number;
  dy: number;
  dist: number;
  hpPct: number;
  /** Inside the hero's attack range right now. */
  inRange: boolean;
  /** Already the hero's ordered attack target. */
  targeted: boolean;
  /** Where it sits on screen, in viewport fractions; null when off screen. */
  screen: ScreenPoint | null;
}

export interface AbilitySense {
  name: string;
  ready: boolean;
  /** Ready AND a sensible target is in reach — press it now. */
  usable: boolean;
}

export type PlaytestSense = ReturnType<ReturnType<typeof createPlaytestSense>>;

const ABILITY_KEYS: readonly AbilityKey[] = ["Q", "W", "E", "R"];
const SIGHT = 1100;
const FIGHT_RADIUS = 600;
const REPATH_MS = 300;
// A* nodes closer than this are already reached; steering at one jitters.
const NODE_REACHED = 48;
const POINT_CAST_SLACK = 80;

const pct = (u: Unit): number => Math.round((u.hp / u.maxHp) * 100) / 100;

const unitStep = (from: Vec2, to: Vec2): Vec2 => {
  const d = dist(from, to);
  return d < 1
    ? { x: 0, y: 0 }
    : {
        x: Math.round(((to.x - from.x) / d) * 100) / 100,
        y: Math.round(((to.y - from.y) / d) * 100) / 100,
      };
};

const onScreen = (u: Unit, view: ViewRect): ScreenPoint | null => {
  // Units on high ground render lifted; the click hit-test follows the sprite.
  const y = u.y - elevationFrac(u.x, u.y) * ELEV_LIFT;
  const sx = (u.x - view.x) / view.width;
  const sy = (y - view.y) / view.height;
  if (sx < 0.02 || sx > 0.98 || sy < 0.02 || sy > 0.98) {
    return null;
  }
  return { sx: Math.round(sx * 1000) / 1000, sy: Math.round(sy * 1000) / 1000 };
};

const nearest = (w: World, me: Unit, want: (u: Unit) => boolean): Unit | null => {
  let best: Unit | null = null;
  let bestD = SIGHT;
  for (const u of w.units.values()) {
    if (!isEnemy(me, u) || !want(u)) {
      continue;
    }
    const d = dist(me, u);
    if (d < bestD) {
      bestD = d;
      best = u;
    }
  }
  return best;
};

const count = (w: World, at: Vec2, radius: number, want: (u: Unit) => boolean): number => {
  let n = 0;
  for (const u of w.units.values()) {
    if (u.alive && want(u) && dist(at, u) <= radius) {
      n += 1;
    }
  }
  return n;
};

const isLaneCreep = (u: Unit): boolean => u.kind === "creep" && !u.neutral && targetable(u);
const isHero = (u: Unit): boolean => u.kind === "hero" && targetable(u);

const abilityUsable = (
  def: AbilityDef,
  me: Unit,
  hero: Unit | null,
  creep: Unit | null,
): boolean => {
  const heroDist = hero ? dist(me, hero) : Infinity;
  const creepDist = creep ? dist(me, creep) : Infinity;
  // The ultimate's cooldown is a whole fight long; creeps are not worth it.
  const reach = def.key === "R" ? heroDist : Math.min(heroDist, creepDist);
  if (def.targeting === "unit") {
    return reach <= def.castRange;
  }
  if (def.targeting === "point") {
    return reach <= Math.max(def.castRange, me.attackRange) + POINT_CAST_SLACK;
  }
  return reach <= FIGHT_RADIUS;
};

const senseAbilities = (w: World, me: Unit, hero: Unit | null, creep: Unit | null) => {
  const h = me.hero;
  const def = h ? HERO_BY_ID[h.defId] : undefined;
  const abilities: Partial<Record<AbilityKey, AbilitySense>> = {};
  if (!h || !def) {
    return abilities;
  }
  for (const key of ABILITY_KEYS) {
    const ad = def.abilities[key];
    const slot = h.abilities[key];
    if (ad.targeting !== "passive") {
      const ready =
        me.alive &&
        slot.rank > 0 &&
        w.now >= slot.readyAt &&
        me.mp >= valAt(ad.manaCost, slot.rank) &&
        !silenced(me);
      abilities[key] = {
        name: ad.name,
        ready,
        usable: ready && abilityUsable(ad, me, hero, creep),
      };
    }
  }
  return abilities;
};

const nearestEnemyTower = (w: World, me: Unit): Unit | null => {
  const enemyTeam = enemyOf(me.team);
  let tower: Unit | null = null;
  let towerD = Infinity;
  for (const spec of TOWERS) {
    const t = spec.team === enemyTeam ? w.units.get(spec.id) : undefined;
    if (t?.alive && dist(me, t) < towerD) {
      towerD = dist(me, t);
      tower = t;
    }
  }
  return tower;
};

/** One sensor per match: it caches the two A* paths it steers by. */
export const createPlaytestSense = () => {
  const paths = new Map<string, { at: number; goal: Vec2; path: Vec2[] }>();

  /** Unit step along the WALKABLE route — a straight line lies across water and cliffs. */
  const routeStep = (w: World, me: Unit, key: string, goal: Vec2): Vec2 => {
    const cached = paths.get(key);
    const stale =
      !cached || w.now < cached.at || w.now - cached.at > REPATH_MS || dist(cached.goal, goal) > 96;
    const entry = stale ? { at: w.now, goal, path: findPath(me, goal) } : cached;
    if (stale) {
      paths.set(key, entry);
    }
    const node = entry.path.find((p) => dist(me, p) > NODE_REACHED) ?? goal;
    return unitStep(me, node);
  };

  return (w: World, me: Unit, view: ViewRect) => {
    const lane: LaneId = me.y < WORLD.height / 2 ? "top" : "bottom";
    const reach = me.attackRange + me.radius - 6;
    const orderTarget = me.order.type === "attackUnit" ? me.order.targetId : null;
    const sense = (u: Unit | null): TargetSense | null =>
      u
        ? {
            dist: Math.round(dist(me, u)),
            dx: Math.round(u.x - me.x),
            dy: Math.round(u.y - me.y),
            hpPct: pct(u),
            inRange: dist(me, u) <= reach,
            screen: onScreen(u, view),
            targeted: orderTarget === u.id,
          }
        : null;

    const creep = nearest(w, me, isLaneCreep);
    const hero = nearest(w, me, isHero);
    // Two swings' worth, not one: the arrow is in flight for a beat and the
    // wave is hitting the same creep, so an order given at one swing lands late.
    const finishable = effectiveAttackDamage(me) * 2;
    const lastHit = nearest(
      w,
      me,
      (u) => isLaneCreep(u) && u.hp <= finishable && dist(me, u) <= reach + 80,
    );

    const tower = nearestEnemyTower(w, me);
    const towerReach = tower ? tower.attackRange + tower.radius + me.radius : 0;
    const alliedCreepsAtTower = tower
      ? count(w, tower, towerReach, (u) => u.kind === "creep" && u.team === me.team)
      : 0;
    const underEnemyTower = tower !== null && dist(me, tower) <= towerReach;
    const towerAttackable = tower?.structure?.attackable ?? false;

    const home = BASES[me.team].fountain;
    const objective = laneObjective(w, me, lane);
    const aimAt = hero && dist(me, hero) <= SIGHT * 0.8 ? hero : (creep ?? hero);

    return {
      abilities: senseAbilities(w, me, hero, creep),
      /** Unit step along the walkable route to the lane front (the allied wave, then the next enemy tower). */
      advance: routeStep(w, me, "advance", objective),
      /** Where the parked cursor should sit so casts fly at the best target. */
      aim: aimAt ? onScreen(aimAt, view) : null,
      alliedCreepsNear: count(w, me, FIGHT_RADIUS, (u) => u.kind === "creep" && u.team === me.team),
      /** Mid-channel: any new order breaks the spell, so the reflexes stand still. */
      channeling: Boolean(me.hero?.channel),
      enemyCreep: sense(creep),
      enemyCreepsNear: count(w, me, FIGHT_RADIUS, (u) => isEnemy(me, u) && isLaneCreep(u)),
      enemyHero: sense(hero),
      enemyHeroesNear: count(w, me, FIGHT_RADIUS + 200, (u) => isEnemy(me, u) && isHero(u)),
      enemyTower: tower
        ? {
            ...sense(tower),
            alliedCreepsInItsRange: alliedCreepsAtTower,
            attackable: towerAttackable,
            /** It shoots anything closer than this — creeps first, then you. */
            range: Math.round(towerReach),
          }
        : null,
      /** Unit step along the walkable route to the healing fountain, and how far it is. */
      home: { ...routeStep(w, me, "home", home), dist: Math.round(dist(me, home)) },
      lane,
      /** An enemy creep one hit from death, inside reach: the last hit is the gold. */
      lastHit: sense(lastHit),
      order: me.order.type,
      /** Inside an enemy tower's range with no allied creeps for it to shoot instead. */
      towerDanger: underEnemyTower && alliedCreepsAtTower === 0,
      underEnemyTower,
    };
  };
};
