// What a player can see, pre-digested for `vg playtest run`: its decision model
// has no eyes and cannot rank a table, so every ranking is made here and handed
// over as one named field (`bestTarget`, `threat`, `incoming`, `loot`, `home`).
// Read-only over the World — nothing here may write sim state.
import { CHAMP_BY_ID } from "../data/champions";
import { OBSTACLES } from "../data/map";
import { isEnemy } from "../sim/combat";
import { MELEE_OVERREACH } from "../sim/combat-geometry";
import { nearestStair, onPlateau } from "../sim/elevation";
import { homeSpawn, inOwnBase } from "../sim/home-base";
import type { Vec2 } from "../sim/math";
import { isDisabled, isUntargetable } from "../sim/stats";
import { ABILITY_KEYS } from "../sim/types";
import type { AbilityKey, Unit, World } from "../sim/types";

const r1 = (n: number): number => Math.round(n * 10) / 10;
const r2 = (n: number): number => Math.round(n * 100) / 100;

/** A place relative to the player. `dx`/`dy` point straight at it; `pathX`/
 *  `pathY` is the unit heading to WALK (round cover, via the throne stairs). */
export interface Bearing {
  dx: number;
  dy: number;
  dist: number;
  pathX: number;
  pathY: number;
}

export interface TargetSense extends Bearing {
  kind: "hero" | "creep";
  name: string;
  hp: number;
  hpPct: number;
  /** Its blow is already in motion — it lands in `strikeInMs`. */
  windingUp: boolean;
  strikeInMs: number;
  stunned: boolean;
  /** Close enough that a basic attack started now connects. */
  inReach: boolean;
}

export interface IncomingSense {
  kind: "melee" | "shot" | "blast";
  dx: number;
  dy: number;
  inMs: number;
}

export interface LootSense extends Bearing {
  gold: number;
}

export interface HomeSense extends Bearing {
  /** Standing on the fountain: it heals fast, and enemies who follow burn. */
  onFountain: boolean;
}

/** The player's own read of their health bar, thresholds already applied —
 *  the decision model compares words far more reliably than numbers. */
export type Condition = "healthy" | "hurt" | "critical" | "recovering" | "dead";

export interface PlaytestSense {
  champ: string;
  condition: Condition;
  hpPct: number;
  maxHp: number;
  level: number;
  gold: number;
  attackRange: number;
  aim: { x: number; y: number };
  respawnInMs: number;
  ready: Record<AbilityKey, boolean>;
  bestTarget: TargetSense | null;
  threat: TargetSense | null;
  enemiesNear: number;
  incoming: IncomingSense | null;
  loot: LootSense | null;
  home: HomeSense;
}

// How much farther a target has to be before it stops being worth the trip:
// enemy champions hit back hard, and the Frost Golem is a mid-game elite.
const HERO_DETOUR = 12;
const GOLEM_DETOUR = 45;
const WOUNDED_PULL = 4;
const NEAR_RADIUS = 8;
const HURT_BELOW = 0.45;
const CRITICAL_BELOW = 0.3;
const RECOVERED_ABOVE = 0.8;
const OUTNUMBERED_AT = 4;

const conditionOf = (me: Unit, onFountain: boolean, enemiesNear: number): Condition => {
  const hpPct = me.hp / me.maxHp;
  if (!me.alive) {
    return "dead";
  }
  if (hpPct < CRITICAL_BELOW) {
    return "critical";
  }
  if (onFountain && hpPct < RECOVERED_ABOVE) {
    return "recovering";
  }
  return hpPct < HURT_BELOW || enemiesNear >= OUTNUMBERED_AT ? "hurt" : "healthy";
};
const COVER_MARGIN = 0.6;

/** Unit heading from the player to a goal: through the nearest stair gap when
 *  the goal is across the throne-plateau edge, and round the first piece of
 *  cover the straight line would clip. */
const pathTo = (me: Unit, gx: number, gy: number): Vec2 => {
  let tx = gx;
  let ty = gy;
  if (onPlateau(me.x, me.y) !== onPlateau(gx, gy)) {
    const stair = nearestStair(me.x, me.y);
    if (Math.hypot(me.x - stair.x, me.y - stair.y) >= 1.8) {
      tx = stair.x;
      ty = stair.y;
    }
  }
  const len = Math.hypot(tx - me.x, ty - me.y);
  if (len < 0.001) {
    return { x: 0, y: 0 };
  }
  const ux = (tx - me.x) / len;
  const uy = (ty - me.y) / len;
  let firstAlong = len;
  let around: Vec2 | null = null;
  for (const o of OBSTACLES) {
    const ox = o.x - me.x;
    const oy = o.y - me.y;
    const along = ox * ux + oy * uy;
    const across = ox * uy - oy * ux;
    const clearance = o.radius + me.radius + COVER_MARGIN;
    if (along <= 0 || along >= firstAlong || Math.abs(across) >= clearance) {
      continue;
    }
    firstAlong = along;
    // pass on the side of the line the cover is NOT on
    const side = across >= 0 ? 1 : -1;
    around = { x: o.x + uy * side * -clearance * 1.3, y: o.y + ux * side * clearance * 1.3 };
  }
  if (!around) {
    return { x: r2(ux), y: r2(uy) };
  }
  const al = Math.hypot(around.x - me.x, around.y - me.y) || 1;
  return { x: r2((around.x - me.x) / al), y: r2((around.y - me.y) / al) };
};

const bearing = (me: Unit, x: number, y: number, edge = 0): Bearing => {
  const path = pathTo(me, x, y);
  return {
    dist: r1(Math.max(0, Math.hypot(x - me.x, y - me.y) - edge)),
    dx: r1(x - me.x),
    dy: r1(y - me.y),
    pathX: path.x,
    pathY: path.y,
  };
};

/** How far a basic attack from `u` reaches, centre to centre, against `t`. */
const reachOf = (u: Unit, t: Unit): number =>
  u.attackType === "melee" ? u.attackRange + MELEE_OVERREACH + t.radius : u.attackRange + t.radius;

const senseTarget = (w: World, me: Unit, t: Unit): TargetSense => {
  const centre = Math.hypot(t.x - me.x, t.y - me.y);
  return {
    ...bearing(me, t.x, t.y, t.radius),
    hp: Math.round(t.hp),
    hpPct: r2(t.hp / t.maxHp),
    // the swing is committed at the start of the wind-up, so lead it a little
    inReach: centre <= reachOf(me, t) - 0.3,
    kind: t.kind === "hero" ? "hero" : "creep",
    name: t.name,
    strikeInMs: t.pendingAttack ? Math.max(0, Math.round(t.pendingAttack.resolveAt - w.now)) : 0,
    stunned: isDisabled(t),
    windingUp: t.pendingAttack !== null,
  };
};

const targetCost = (me: Unit, t: Unit): number => {
  let cost = Math.hypot(t.x - me.x, t.y - me.y);
  if (t.kind === "hero") {
    cost += HERO_DETOUR;
  }
  if (t.champId === "frostgolem") {
    cost += GOLEM_DETOUR;
  }
  if (t.hp / t.maxHp < 0.35) {
    cost -= WOUNDED_PULL;
  }
  return cost;
};

const visibleEnemies = (w: World, me: Unit): Unit[] => {
  const out: Unit[] = [];
  for (const t of w.units.values()) {
    if (t === me || !t.alive || (t.kind !== "hero" && t.kind !== "creep")) {
      continue;
    }
    if (isEnemy(me, t) && !isUntargetable(t)) {
      out.push(t);
    }
  }
  return out;
};

/** The soonest blow that will actually reach the player if they stand still. */
const senseIncoming = (w: World, me: Unit, enemies: Unit[]): IncomingSense | null => {
  let best: IncomingSense | null = null;
  const offer = (kind: IncomingSense["kind"], x: number, y: number, at: number): void => {
    const inMs = Math.max(0, Math.round(at - w.now));
    if (!best || inMs < best.inMs) {
      best = { dx: r1(x - me.x), dy: r1(y - me.y), inMs, kind };
    }
  };
  for (const t of enemies) {
    if (t.pendingAttack && Math.hypot(t.x - me.x, t.y - me.y) <= reachOf(t, me) + 0.5) {
      offer(t.attackType === "melee" ? "melee" : "shot", t.x, t.y, t.pendingAttack.resolveAt);
    }
  }
  for (const g of w.grounds) {
    if (
      g.telegraph &&
      g.detonateAt !== undefined &&
      g.team !== me.team &&
      Math.hypot(g.x - me.x, g.y - me.y) <= g.radius + me.radius
    ) {
      offer("blast", g.x, g.y, g.detonateAt);
    }
  }
  for (const p of w.projectiles.values()) {
    if (p.team === me.team) {
      continue;
    }
    const px = me.x - p.x;
    const py = me.y - p.y;
    const along = (px * p.vx + py * p.vy) / (p.speed || 1);
    const across = Math.abs(px * p.vy - py * p.vx) / (p.speed || 1);
    if (along > 0 && along < 12 && across <= p.hitRadius + me.radius + 0.4) {
      offer("shot", p.x, p.y, w.now + (along / (p.speed || 1)) * 1000);
    }
  }
  return best;
};

const senseLoot = (w: World, me: Unit): LootSense | null => {
  let best: LootSense | null = null;
  let bestD = Infinity;
  for (const c of w.coins) {
    const d = Math.hypot(c.x - me.x, c.y - me.y);
    // a coin still in the air cannot be claimed, and one about to vanish is a wasted trip
    if (w.now < c.landAt || c.expireAt - w.now < (d / me.moveSpeed) * 1000 || d >= bestD) {
      continue;
    }
    bestD = d;
    best = { ...bearing(me, c.x, c.y), gold: c.gold };
  }
  return best;
};

export const sensePlaytest = (w: World, me: Unit): PlaytestSense => {
  const enemies = visibleEnemies(w, me);
  let best: Unit | null = null;
  let nearest: Unit | null = null;
  let enemiesNear = 0;
  for (const t of enemies) {
    const d = Math.hypot(t.x - me.x, t.y - me.y);
    if (d <= NEAR_RADIUS) {
      enemiesNear += 1;
    }
    if (!nearest || d < Math.hypot(nearest.x - me.x, nearest.y - me.y)) {
      nearest = t;
    }
    if (!best || targetCost(me, t) < targetCost(me, best)) {
      best = t;
    }
  }
  const home = homeSpawn(me.slot);
  const ready: Record<AbilityKey, boolean> = {
    DASH: false,
    E: false,
    JUMP: false,
    Q: false,
    R: false,
    W: false,
  };
  const canCast = me.alive && !isDisabled(me);
  const onFountain = me.alive && inOwnBase(me);
  for (const key of [...ABILITY_KEYS, "DASH", "JUMP"] satisfies AbilityKey[]) {
    const slot = me.abilities[key];
    ready[key] = canCast && slot.rank >= 1 && slot.readyAt <= w.now;
  }
  return {
    aim: { x: r2(me.aimX), y: r2(me.aimY) },
    attackRange: r1(me.attackRange),
    bestTarget: best ? senseTarget(w, me, best) : null,
    champ: CHAMP_BY_ID[me.champId]?.name ?? me.champId,
    condition: conditionOf(me, onFountain, enemiesNear),
    enemiesNear,
    gold: Math.floor(me.gold),
    home: {
      ...bearing(me, home.x, home.y),
      onFountain,
    },
    hpPct: r2(me.hp / me.maxHp),
    incoming: senseIncoming(w, me, enemies),
    level: me.level,
    loot: senseLoot(w, me),
    maxHp: Math.round(me.maxHp),
    ready,
    respawnInMs: me.alive ? 0 : Math.max(0, Math.round(me.respawnAt - w.now)),
    threat: nearest ? senseTarget(w, me, nearest) : null,
  };
};
