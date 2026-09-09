// The authoritative World: construction, spawning, and the master step() that
// advances every subsystem one fixed tick. Host-only logic.

import {
  CREEPS,
  ECON,
  PASSIVE_GOLD_PER_SEC,
  SIM_DT,
  STRUCTS,
  TEAMS,
  TOWER_RAMP_PER_HIT,
  WAVE,
} from "../data/config";
import type { CreepKind, Team } from "../data/config";
import { DEFAULT_HERO, HERO_BY_ID } from "../data/heroes";
import {
  BASES,
  LANE_IDS,
  NEUTRAL_CAMPS,
  TOWERS,
  WORLD,
  cellElev,
  isBlockedHighCell,
  isCliffCell,
  isRampCell,
  isWater,
  lanePath,
} from "../data/map";
import type { LaneId, NeutralCampSpec, NeutralKind } from "../data/map";
import {
  acquireTarget,
  dealDamage,
  isEnemy,
  resolvePendingAttacks,
  stepProjectiles,
  targetable,
  tryAttack,
  updateStructureGating,
} from "./combat";
import { recomputeHeroStats } from "./herokit";
import { dist, moveToward } from "./math";
import type { Vec2 } from "./math";
import { findPath } from "./nav";
import {
  disabled,
  effectiveMoveSpeed,
  expireStatuses,
  rooted,
  tauntTarget,
  untargetable,
} from "./stats";
import { tickAbilities, breakChannel } from "./abilities";
import { tickBots } from "./ai";
import type { Mine, Unit, World } from "./types";
import { nextId, rand } from "./types";

export { enemyOf } from "../data/config";
export { buyItem, issueOrder } from "./orders";

const SEPARATION_PUSH = 0.5;
const ARRIVE_RADIUS = 14;
const CELL = WORLD.cell;

/** Whether a unit may move from one point to another on foot: the destination is
 *  standable terrain and the step doesn't climb a cliff edge (only ramps bridge
 *  elevations). Mirrors the NavGrid edge rule so keyboard/chase movement and A*
 *  paths agree on what's walkable. */
const legalMove = (fromX: number, fromY: number, toX: number, toY: number): boolean => {
  if (isWater(toX, toY)) {
    return false;
  }
  const tc = Math.floor(toX / CELL);
  const tr = Math.floor(toY / CELL);
  if (isBlockedHighCell(tc, tr) || isCliffCell(tc, tr)) {
    return false;
  }
  const fc = Math.floor(fromX / CELL);
  const fr = Math.floor(fromY / CELL);
  if (cellElev(fc, fr) !== cellElev(tc, tr) && !isRampCell(fc, fr) && !isRampCell(tc, tr)) {
    return false;
  }
  return true;
};

/** Apply a desired move with terrain collision: take it if legal, else slide along
 *  whichever axis is still legal, else stay put. Returns the resolved position. */
const collide = (u: Unit, toX: number, toY: number) => {
  if (legalMove(u.x, u.y, toX, toY)) {
    return { x: toX, y: toY };
  }
  if (legalMove(u.x, u.y, toX, u.y)) {
    return { x: toX, y: u.y };
  }
  if (legalMove(u.x, u.y, u.x, toY)) {
    return { x: u.x, y: toY };
  }
  return { x: u.x, y: u.y };
};
// generous so creeps advance past waypoints near towers
const LANE_ARRIVE = 110;
// creeps notice enemies within this and peel off lane
const CREEP_AGGRO = 480;

export const baseUnit = (
  id: string,
  kind: Unit["kind"],
  team: Team,
  x: number,
  y: number,
  radius: number,
): Unit => ({
  alive: true,
  armor: 0,
  attackRange: 0,
  attackSpeedBase: 0,
  baseDamage: 0,
  bonusLifesteal: 0,
  bonusSpellAmp: 0,
  facing: team === "radiant" ? 1 : -1,
  hp: 1,
  hpRegen: 0,
  id,
  kind,
  lastAttackAt: 0,
  magicResist: 0,
  maxHp: 1,
  maxMp: 0,
  moveSpeedBase: 0,
  mp: 0,
  mpRegen: 0,
  order: { type: "idle" },
  path: [],
  pathIdx: 0,
  pendingAttack: null,
  projectileSpeed: 0,
  radius,
  repathAt: 0,
  statuses: [],
  team,
  vx: 0,
  vy: 0,
  x,
  y,
});

const spawnStructures = (w: World): void => {
  for (const t of TOWERS) {
    const def = STRUCTS[t.tier];
    const u: Unit = baseUnit(t.id, "structure", t.team, t.x, t.y, def.radius);
    u.maxHp = def.hp;
    u.hp = def.hp;
    u.armor = def.armor;
    u.baseDamage = def.damage;
    u.attackRange = def.attackRange;
    u.attackSpeedBase = def.attackSpeed;
    u.projectileSpeed = def.projectileSpeed;
    u.structure = {
      attackable: t.tier === "t1",
      lane: t.lane,
      rampStacks: 0,
      rampTargetId: null,
      structId: t.id,
      tier: t.tier,
    };
    w.units.set(u.id, u);
  }
  for (const team of TEAMS) {
    const b = BASES[team];
    const def = STRUCTS.ancient;
    const id = team === "radiant" ? "r-ancient" : "d-ancient";
    const u: Unit = baseUnit(id, "structure", team, b.ancient.x, b.ancient.y, def.radius);
    u.maxHp = def.hp;
    u.hp = def.hp;
    u.armor = def.armor;
    u.structure = {
      attackable: false,
      lane: "base",
      rampStacks: 0,
      rampTargetId: null,
      structId: id,
      tier: "ancient",
    };
    w.units.set(u.id, u);
  }
  updateStructureGating(w);
};

export const createWorld = (seed: number): World => {
  const w: World = {
    campRespawnAt: {},
    fx: [],
    gameTime: 0,
    groundEffects: [],
    mines: new Map(),
    nextWaveAt: WAVE.firstWaveSec,
    now: 0,
    phase: "playing",
    projectiles: new Map(),
    rngState: seed,
    seq: 0,
    units: new Map(),
    waveCount: 0,
    winner: null,
  };
  spawnStructures(w);
  // camps first appear at 1:00, Roshan at 5:00.
  for (const c of NEUTRAL_CAMPS) {
    w.campRespawnAt[c.id] = c.kind === "roshan" ? 300 : 60;
  }
  return w;
};

export const spawnHero = (
  w: World,
  defId: string,
  team: Team,
  ownerId: string,
  isBot: boolean,
  slot: number,
): Unit => {
  const def = HERO_BY_ID[defId] ?? DEFAULT_HERO;
  const b = BASES[team];
  const spread = (slot - 2) * 70;
  const u = baseUnit(`h-${ownerId}`, "hero", team, b.heroSpawn.x + spread, b.heroSpawn.y, 30);
  u.hero = {
    abilities: {
      E: { rank: 0, readyAt: 0 },
      Q: { rank: 0, readyAt: 0 },
      R: { rank: 0, readyAt: 0 },
      W: { rank: 0, readyAt: 0 },
    },
    abilityPoints: 1,
    assists: 0,
    botLane: slot % 2 === 0 ? "top" : "bottom",
    botNextDecisionAt: 0,
    botRetreating: false,
    channel: null,
    dashReadyAt: 0,
    dashUntil: 0,
    dashX: 1,
    dashY: 0,
    deaths: 0,
    defId: def.id,
    denies: 0,
    gold: ECON.startingGold,
    isBot,
    itemActiveReadyAt: {},
    items: [],
    killStreak: 0,
    kills: 0,
    lastHits: 0,
    level: 1,
    ownerId,
    recentDamageFrom: {},
    reliableGoldSpent: 0,
    respawnAt: 0,
    slot,
    xp: 0,
  };
  recomputeHeroStats(u);
  u.hp = u.maxHp;
  u.mp = u.maxMp;
  w.units.set(u.id, u);
  return u;
};

// ---- spawning creeps -------------------------------------------------------

/** The waypoint a mid-lane spawned creep should march toward: the one after the
 *  nearest, so it keeps moving forward instead of walking back to the base. */
const forwardWaypoint = (wps: Vec2[], at: Vec2): number => {
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < wps.length; i += 1) {
    const p = wps[i];
    if (!p) {
      continue;
    }
    const d = (p.x - at.x) ** 2 + (p.y - at.y) ** 2;
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return Math.min(best + 1, Math.max(0, wps.length - 1));
};
const spawnCreep = (
  w: World,
  team: Team,
  lane: LaneId,
  ckind: CreepKind,
  idx: number,
  at?: Vec2,
): Unit => {
  const def = CREEPS[ckind];
  const wps = lanePath(lane, team);
  const start = at ?? wps[0] ?? BASES[team].creepSpawn;
  // staged spawns (trailer/director) want tight placement; wave spawns spread out
  const jitter = (n: number) => (rand(w) - 0.5) * (at ? 24 : n);
  const u = baseUnit(
    nextId(w, "c"),
    "creep",
    team,
    start.x + jitter(90) + (at ? 0 : idx * 12),
    start.y + jitter(90),
    def.radius,
  );
  // ramp creep stats over time to push the game to a close
  const minutes = w.gameTime / 60;
  const hpRamp = Math.floor(minutes) * WAVE.hpRampPer60s;
  const dmgRamp = Math.floor(minutes) * WAVE.dmgRampPer60s;
  // Megacreeps: once this team has destroyed the enemy's T2 in this lane, its
  // creeps in that lane surge — the snowball that closes out a won lane.
  const enemyPrefix = team === "radiant" ? "d" : "r";
  const laneCode = lane === "bottom" ? "bot" : lane;
  const enemyT2 = w.units.get(`${enemyPrefix}-${laneCode}-t2`);
  const mega = enemyT2 ? !enemyT2.alive : false;
  const megaHp = mega ? 1.6 : 1;
  const megaDmg = mega ? 1.5 : 1;
  u.maxHp = (def.hp + hpRamp) * megaHp;
  u.hp = u.maxHp;
  u.armor = def.armor + (mega ? 4 : 0);
  u.baseDamage = (def.damage + dmgRamp) * megaDmg;
  u.attackRange = def.attackRange;
  u.attackSpeedBase = def.attackSpeed;
  u.projectileSpeed = def.projectileSpeed;
  u.moveSpeedBase = def.moveSpeed;
  u.order = { type: "lane" };
  u.creep = {
    ckind,
    lane,
    spawnWave: w.waveCount,
    waypoints: wps,
    wpIdx: at ? forwardWaypoint(wps, at) : 1,
  };
  w.units.set(u.id, u);
  return u;
};

/** Staging hook (trailer/director): spawn a single lane creep at an arbitrary
 *  world point, already marching its lane. Uses the exact wave-creep stat path
 *  (ramps, megacreeps) so a staged creep is indistinguishable from a real one. */
export const spawnCreepAt = (
  w: World,
  team: Team,
  lane: LaneId,
  ckind: CreepKind,
  x: number,
  y: number,
): Unit => spawnCreep(w, team, lane, ckind, 0, { x, y });

const spawnWave = (w: World): void => {
  w.waveCount += 1;
  const siege = w.waveCount % WAVE.siegeEveryNthWave === 0;
  for (const team of TEAMS) {
    for (const lane of LANE_IDS) {
      let i = 0;
      for (let m = 0; m < WAVE.melee; m += 1) {
        spawnCreep(w, team, lane, "melee", i);
        i += 1;
      }
      for (let r = 0; r < WAVE.ranged; r += 1) {
        spawnCreep(w, team, lane, "ranged", i);
        i += 1;
      }
      if (siege) {
        spawnCreep(w, team, lane, "siege", i);
        i += 1;
      }
    }
  }
};

// ---- neutral jungle camps + Roshan -----------------------------------------
// sentinel in campRespawnAt: members still standing
const CAMP_ALIVE = -1;
const CAMP_RESPAWN_SEC = {
  large: 90,
  medium: 80,
  roshan: 300,
  small: 70,
} satisfies Record<NeutralKind, number>;

interface NeutralStat {
  hp: number;
  damage: number;
  armor: number;
  attackRange: number;
  moveSpeed: number;
  attackSpeed: number;
  projectileSpeed: number;
  gold: [number, number];
  xp: number;
  radius: number;
}
export const N_SMALL: NeutralStat = {
  armor: 2,
  attackRange: 80,
  attackSpeed: 0.8,
  damage: 20,
  gold: [20, 28],
  hp: 240,
  moveSpeed: 200,
  projectileSpeed: 0,
  radius: 26,
  xp: 38,
};
export const N_LARGE: NeutralStat = {
  armor: 5,
  attackRange: 95,
  attackSpeed: 0.7,
  damage: 36,
  gold: [55, 72],
  hp: 720,
  moveSpeed: 185,
  projectileSpeed: 0,
  radius: 34,
  xp: 95,
};
export const N_BOSS: NeutralStat = {
  armor: 12,
  attackRange: 130,
  attackSpeed: 0.95,
  damage: 95,
  gold: [200, 260],
  hp: 4200,
  moveSpeed: 150,
  projectileSpeed: 0,
  radius: 56,
  xp: 320,
};

const CAMP_PACK = {
  large: [N_LARGE, N_SMALL, N_SMALL],
  medium: [N_LARGE, N_SMALL],
  roshan: [N_BOSS],
  small: [N_SMALL, N_SMALL],
} satisfies Record<NeutralKind, NeutralStat[]>;

const spawnNeutralUnit = (
  w: World,
  camp: NeutralCampSpec,
  st: NeutralStat,
  idx: number,
  boss: boolean,
): void => {
  const jitter = (n: number) => (rand(w) - 0.5) * n;
  const ox = boss ? 0 : (idx - 0.5) * 70 + jitter(40);
  const oy = boss ? 0 : jitter(60);
  const u = baseUnit(nextId(w, "n"), "creep", "dire", camp.x + ox, camp.y + oy, st.radius);
  const minutes = w.gameTime / 60;
  // Roshan scales hard over the game
  const ramp = boss ? minutes * 150 : minutes * 12;
  u.neutral = true;
  u.homeX = camp.x + ox;
  u.homeY = camp.y + oy;
  u.maxHp = st.hp + ramp;
  u.hp = u.maxHp;
  u.armor = st.armor;
  u.baseDamage = st.damage + (boss ? minutes * 4 : minutes * 1);
  u.attackRange = st.attackRange;
  u.attackSpeedBase = st.attackSpeed;
  u.projectileSpeed = st.projectileSpeed;
  u.moveSpeedBase = st.moveSpeed;
  u.order = { type: "neutral" };
  u.creep = {
    boss,
    camp: camp.id,
    ckind: "melee",
    goldOverride: st.gold,
    lane: "top",
    spawnWave: w.waveCount,
    waypoints: [],
    wpIdx: 0,
    xpOverride: st.xp,
  };
  w.units.set(u.id, u);
};

const spawnCamp = (w: World, camp: NeutralCampSpec): void => {
  for (const [i, st] of CAMP_PACK[camp.kind].entries()) {
    spawnNeutralUnit(w, camp, st, i, camp.kind === "roshan");
  }
};

const tickNeutrals = (w: World): void => {
  const aliveByCamp: Record<string, number> = {};
  for (const u of w.units.values()) {
    if (u.neutral && u.alive && u.creep?.camp) {
      aliveByCamp[u.creep.camp] = (aliveByCamp[u.creep.camp] ?? 0) + 1;
    }
  }
  for (const camp of NEUTRAL_CAMPS) {
    const alive = aliveByCamp[camp.id] ?? 0;
    if (alive > 0) {
      w.campRespawnAt[camp.id] = CAMP_ALIVE;
      continue;
    }
    const due = w.campRespawnAt[camp.id] ?? 0;
    if (due === CAMP_ALIVE) {
      // just cleared this frame — schedule the next spawn
      w.campRespawnAt[camp.id] = w.gameTime + CAMP_RESPAWN_SEC[camp.kind];
    } else if (w.gameTime >= due) {
      spawnCamp(w, camp);
      w.campRespawnAt[camp.id] = CAMP_ALIVE;
    }
  }
};

// ---- the master step -------------------------------------------------------

/** Reap dead creeps (heroes respawn; structures stay as rubble/gated). */
const cleanupDead = (w: World): void => {
  for (const [id, u] of w.units) {
    if (u.kind === "creep" && !u.alive) {
      w.units.delete(id);
    }
  }
};

const regen = (w: World, u: Unit, dt: number): void => {
  if (u.kind === "structure") {
    return;
  }
  if (u.hp < u.maxHp) {
    u.hp = Math.min(u.maxHp, u.hp + u.hpRegen * dt);
  }
  if (u.mp < u.maxMp) {
    u.mp = Math.min(u.maxMp, u.mp + u.mpRegen * dt);
  }
};

const respawnHero = (w: World, u: Unit): void => {
  const h = u.hero;
  if (!h) {
    return;
  }
  const b = BASES[u.team];
  h.respawnAt = 0;
  u.alive = true;
  u.x = b.heroSpawn.x + (h.slot - 2) * 70;
  u.y = b.heroSpawn.y;
  u.hp = u.maxHp;
  u.mp = u.maxMp;
  u.statuses = [];
  u.order = { type: "idle" };
  u.path = [];
  u.pendingAttack = null;
  h.dashUntil = 0;
};

const tickHero = (w: World, u: Unit, dt: number): void => {
  const h = u.hero;
  if (!h) {
    return;
  }
  if (!u.alive) {
    if (h.respawnAt > 0 && w.now >= h.respawnAt) {
      respawnHero(w, u);
    }
    return;
  }
  // fountain heal
  const b = BASES[u.team];
  if (dist(u, b.fountain) <= b.fountainRadius) {
    u.hp = Math.min(u.maxHp, u.hp + u.maxHp * 0.06 * dt);
    u.mp = Math.min(u.maxMp, u.mp + u.maxMp * 0.06 * dt);
  }
  // prune stale assist credit
  h.recentDamageFrom = Object.fromEntries(
    Object.entries(h.recentDamageFrom).filter(([, t]) => w.now - t <= 15_000),
  );
};

// px/sec
const DASH_SPEED = 1150;

const acquireNearbyEnemy = (w: World, u: Unit, radius: number): Unit | null => {
  let best: Unit | null = null;
  let bestD = radius * radius;
  for (const t of w.units.values()) {
    if (!isEnemy(u, t) || !t.alive) {
      continue;
    }
    if (t.kind === "structure" && !t.structure?.attackable) {
      continue;
    }
    if (t.statuses.some((s) => s.kind === "untargetable")) {
      continue;
    }
    const dx = t.x - u.x;
    const dy = t.y - u.y;
    const d2 = dx * dx + dy * dy;
    if (d2 < bestD) {
      // structures only if very close (in lane); prefer units
      bestD = d2;
      best = t;
    }
  }
  return best;
};

/** Decide what (if anything) this unit should be attacking right now. */
const pickCombatTarget = (w: World, u: Unit): Unit | null => {
  const taunt = tauntTarget(u);
  if (taunt) {
    const t = w.units.get(taunt);
    if (t && t.alive) {
      return t;
    }
  }
  if (u.order.type === "attackUnit") {
    const t = w.units.get(u.order.targetId);
    // targetable enforces structure gating, so an ordered attack on a protected
    // tower is dropped instead of chased
    if (t && isEnemy(u, t) && targetable(t, { allowStructure: true })) {
      return t;
    }
    u.order = { type: "idle" };
  }
  if (u.kind === "creep") {
    if (u.neutral) {
      // jungle camps guard a leash radius: ignore targets while walking home.
      const home = { x: u.homeX ?? u.x, y: u.homeY ?? u.y };
      if (dist(u, home) > 360) {
        return null;
      }
      const acq = acquireNearbyEnemy(w, u, 420);
      return acq && dist(acq, home) < 540 ? acq : null;
    }
    // creeps: engage enemies near their current lane node
    const acq = acquireNearbyEnemy(w, u, CREEP_AGGRO);
    if (acq) {
      return acq;
    }
    return null;
  }
  // heroes only auto-attack on hold/attackMove (not while plain-moving)
  if (u.order.type === "hold" || u.order.type === "attackMove" || u.order.type === "idle") {
    return acquireTarget(w, u);
  }
  return null;
};

/** Velocity steering toward a point. */
const steerTo = (w: World, u: Unit, to: Vec2, dt: number, _chase: boolean): void => {
  if (rooted(u)) {
    u.vx = 0;
    u.vy = 0;
    return;
  }
  const speed = effectiveMoveSpeed(u);
  const dx = to.x - u.x;
  const dy = to.y - u.y;
  const d = Math.hypot(dx, dy);
  if (d < 1) {
    return;
  }
  const nx = dx / d;
  const ny = dy / d;
  u.vx = nx * speed;
  u.vy = ny * speed;
  const next = moveToward(u, to, speed * dt);
  const resolved = collide(u, next.x, next.y);
  u.x = resolved.x;
  u.y = resolved.y;
  if (Math.abs(nx) > 0.2) {
    u.facing = nx >= 0 ? 1 : -1;
  }
};

/** Follow the A* path toward `goal`, repathing when needed. */
const followPath = (w: World, u: Unit, dt: number, goal: Vec2): void => {
  if (dist(u, goal) < ARRIVE_RADIUS) {
    u.order = { type: "idle" };
    u.path = [];
    u.vx = 0;
    u.vy = 0;
    return;
  }
  if (u.path.length === 0 || u.pathIdx >= u.path.length || w.now >= u.repathAt) {
    const last = u.path.at(-1);
    if (!last || dist(last, goal) > 60 || u.pathIdx >= u.path.length) {
      u.path = findPath(u, goal);
      u.pathIdx = 0;
      u.repathAt = w.now + 1500;
    }
  }
  let node = u.path[u.pathIdx];
  while (node && dist(u, node) < ARRIVE_RADIUS) {
    u.pathIdx += 1;
    node = u.path[u.pathIdx];
  }
  if (!node) {
    steerTo(w, u, goal, dt, false);
    return;
  }
  steerTo(w, u, node, dt, false);
};

const followOrder = (w: World, u: Unit, dt: number): void => {
  const o = u.order;
  if (o.type === "lane" && u.creep) {
    const wps = u.creep.waypoints;
    let wp = wps[u.creep.wpIdx];
    if (!wp) {
      // reached end: attack the enemy ancient
      const enemyAncient = w.units.get(u.team === "radiant" ? "d-ancient" : "r-ancient");
      if (enemyAncient && enemyAncient.alive) {
        steerTo(w, u, enemyAncient, dt, true);
      }
      return;
    }
    if (dist(u, wp) < LANE_ARRIVE) {
      u.creep.wpIdx += 1;
      wp = wps[u.creep.wpIdx] ?? wp;
    }
    steerTo(w, u, wp, dt, true);
    return;
  }
  if (o.type === "moveDir") {
    // keyboard steering: travel straight in the held direction, no pathfinding.
    const len = Math.hypot(o.dx, o.dy);
    if (len < 0.01) {
      u.vx = 0;
      u.vy = 0;
      return;
    }
    steerTo(w, u, { x: u.x + (o.dx / len) * 200, y: u.y + (o.dy / len) * 200 }, dt, false);
    return;
  }
  if (o.type === "move" || o.type === "attackMove") {
    followPath(w, u, dt, o.to);
    return;
  }
  if (o.type === "neutral") {
    // jungle camp: leash home when dragged off, otherwise guard in place.
    const home = { x: u.homeX ?? u.x, y: u.homeY ?? u.y };
    if (dist(u, home) > 360) {
      steerTo(w, u, home, dt, false);
    } else {
      u.vx = 0;
      u.vy = 0;
      if (u.hp < u.maxHp) {
        u.hp = Math.min(u.maxHp, u.hp + u.maxHp * 0.5 * dt);
        // reset between pulls
      }
    }
    return;
  }
  if (o.type === "fountain") {
    followPath(w, u, dt, BASES[u.team].fountain);
    return;
  }
  // idle/hold: stop
  u.vx = 0;
  u.vy = 0;
};

const unitTick = (w: World, u: Unit, dt: number): void => {
  // dash overlay: zoom in the dash direction, ignoring orders/targets/collision
  if (u.hero && w.now < u.hero.dashUntil) {
    const { dashX, dashY } = u.hero;
    u.vx = dashX * DASH_SPEED;
    u.vy = dashY * DASH_SPEED;
    u.x += dashX * DASH_SPEED * dt;
    u.y += dashY * DASH_SPEED * dt;
    if (Math.abs(dashX) > 0.2) {
      u.facing = dashX >= 0 ? 1 : -1;
    }
    return;
  }
  if (disabled(u)) {
    u.vx = 0;
    u.vy = 0;
    if (u.hero?.channel) {
      breakChannel(w, u);
    }
    return;
  }
  if (u.hero?.channel) {
    // channeling: stand still, ability tick handles effect
    u.vx = 0;
    u.vy = 0;
    return;
  }

  const target = pickCombatTarget(w, u);
  if (target) {
    const range = u.attackRange + u.radius + target.radius;
    if (dist(u, target) <= range) {
      u.vx = 0;
      u.vy = 0;
      u.facing = target.x >= u.x ? 1 : -1;
      tryAttack(w, u, target);
      return;
    }
    // chase directly
    if (!rooted(u)) {
      steerTo(w, u, { x: target.x, y: target.y }, dt, true);
    }
    return;
  }

  // no combat target: follow order
  followOrder(w, u, dt);
};

const structureTick = (w: World, u: Unit): void => {
  const t = acquireTarget(w, u);
  if (t) {
    u.facing = t.x >= u.x ? 1 : -1;
    // tower ramp adds damage; fold stacks into a temporary damage figure
    const ramp = u.structure ? 1 + TOWER_RAMP_PER_HIT * u.structure.rampStacks : 1;
    const saved = u.baseDamage;
    u.baseDamage = saved * ramp;
    tryAttack(w, u, t);
    u.baseDamage = saved;
  } else if (u.structure) {
    u.structure.rampTargetId = null;
    u.structure.rampStacks = 0;
  }
};

/** Boid separation so units don't stack. Structures push but don't move. */
const separation = (w: World): void => {
  // iterate the units Map directly — the outer loop only mutates positions (never
  // the Map structure), so the old `[...values()].filter(...)` snapshot was a wasted
  // full-array allocation every tick.
  for (const a of w.units.values()) {
    if (!a.alive || a.kind === "structure") {
      continue;
    }
    if (a.statuses.some((s) => s.kind === "unstoppable")) {
      continue;
    }
    let sx = 0;
    let sy = 0;
    for (const b of w.units.values()) {
      if (b === a || !b.alive) {
        continue;
      }
      // keep units off each other; structures only push out of their actual
      // footprint so lane creeps flow past towers instead of jamming on them.
      const minD =
        b.kind === "structure" ? b.radius + a.radius * 0.6 : (a.radius + b.radius) * 1.05;
      const dx = a.x - b.x;
      const dy = a.y - b.y;
      const d2 = dx * dx + dy * dy;
      if (d2 < minD * minD && d2 > 0.01) {
        const d = Math.sqrt(d2);
        const push = minD - d;
        sx += (dx / d) * push;
        sy += (dy / d) * push;
      }
    }
    // resolve the push against terrain so crowding never shoves a unit off a cliff
    const pushed = collide(a, a.x + sx * SEPARATION_PUSH, a.y + sy * SEPARATION_PUSH);
    a.x = pushed.x;
    a.y = pushed.y;
  }
};

const detonateMine = (w: World, m: Mine): void => {
  w.mines.delete(m.id);
  w.fx.push({ color: 0xff_c2_4d, radius: m.triggerRadius, t: "explosion", x: m.x, y: m.y });
  const owner = w.units.get(m.ownerId) ?? null;
  for (const u of w.units.values()) {
    if ((!u.neutral && u.team === m.team) || !u.alive || u.kind === "structure") {
      continue;
    }
    if (untargetable(u)) {
      continue;
    }
    if (dist(u, m) <= m.triggerRadius + 30) {
      dealDamage(w, owner, u, m.damage, "magic", {});
      u.statuses.push({
        id: `mine:${m.id}:${u.id}`,
        kind: "slow",
        pct: m.slowPct,
        until: w.now + 1000,
      });
    }
  }
};

const tickMines = (w: World): void => {
  for (const m of w.mines.values()) {
    if (w.now >= m.expireAt) {
      w.mines.delete(m.id);
      continue;
    }
    if (w.now < m.armedAt) {
      continue;
    }
    for (const u of w.units.values()) {
      if ((!u.neutral && u.team === m.team) || !u.alive || u.kind === "structure") {
        continue;
      }
      if (untargetable(u)) {
        continue;
        // phased-out units (e.g. Death Waltz) don't trip mines
      }
      if (dist(u, m) <= m.triggerRadius) {
        detonateMine(w, m);
        break;
      }
    }
  }
};

const structureRegen = (w: World, dt: number): void => {
  for (const u of w.units.values()) {
    if (u.kind !== "structure" || !u.alive || !u.structure) {
      continue;
    }
    const def = STRUCTS[u.structure.tier];
    if (def.regenPerSec <= 0 || u.hp >= u.maxHp) {
      continue;
    }
    // only regen when no enemy creeps nearby (backdoor protection)
    const guardR = u.structure.tier === "ancient" ? 700 : 900;
    let enemyCreepNear = false;
    for (const e of w.units.values()) {
      if (e.kind === "creep" && e.alive && !e.neutral && isEnemy(e, u) && dist(e, u) <= guardR) {
        enemyCreepNear = true;
        break;
      }
    }
    if (!enemyCreepNear) {
      u.hp = Math.min(u.maxHp, u.hp + def.regenPerSec * dt);
    }
  }
};

const passiveIncome = (w: World, dt: number): void => {
  for (const u of w.units.values()) {
    if (u.kind === "hero" && u.hero) {
      u.hero.gold += PASSIVE_GOLD_PER_SEC * dt;
    }
  }
};

/** Step toward the nearest standable ground (dry, not a blocked plateau or cliff),
 *  sampling outward rings — so a unit shoved into water lands somewhere legalMove
 *  will actually let it walk out of, not on a cliff/deco rise it then gets stuck on. */
const nudgeToLand = (u: Unit): void => {
  for (let r = 32; r <= 256; r += 32) {
    for (let k = 0; k < 8; k += 1) {
      const a = (k / 8) * Math.PI * 2;
      const x = u.x + Math.cos(a) * r;
      const y = u.y + Math.sin(a) * r;
      const cx = Math.floor(x / CELL);
      const cy = Math.floor(y / CELL);
      if (!isWater(x, y) && !isBlockedHighCell(cx, cy) && !isCliffCell(cx, cy)) {
        u.x += Math.cos(a) * 8;
        u.y += Math.sin(a) * 8;
        return;
      }
    }
  }
};

const clampToWorld = (w: World): void => {
  const pad = 40;
  for (const u of w.units.values()) {
    if (u.kind === "structure") {
      continue;
    }
    u.x = Math.max(pad, Math.min(WORLD.width - pad, u.x));
    u.y = Math.max(pad, Math.min(WORLD.height - pad, u.y));
    // shove out of impassable water (units can be pushed in by separation)
    if (u.alive && isWater(u.x, u.y)) {
      nudgeToLand(u);
    }
  }
};
export const step = (w: World, dt: number = SIM_DT): void => {
  if (w.phase === "ended") {
    // keep projectiles/fx settling but stop spawns/orders
    stepProjectiles(w, dt);
    return;
  }
  w.now += dt * 1000;
  w.gameTime += dt;

  // waves
  while (w.gameTime >= w.nextWaveAt) {
    spawnWave(w);
    w.nextWaveAt += WAVE.intervalSec;
  }
  tickNeutrals(w);

  // per-unit: status expiry, respawn, regen, orders+combat
  for (const u of w.units.values()) {
    expireStatuses(u, w.now);
    if (u.kind === "hero") {
      tickHero(w, u, dt);
    }
    if (!u.alive) {
      continue;
    }
    regen(w, u, dt);
  }

  // bot heroes decide orders / cast abilities before movement resolves
  tickBots(w, dt);

  // movement + combat for living, non-disabled units
  for (const u of w.units.values()) {
    if (!u.alive) {
      continue;
    }
    if (u.kind === "structure") {
      structureTick(w, u);
      continue;
    }
    unitTick(w, u, dt);
  }

  separation(w);
  resolvePendingAttacks(w);
  stepProjectiles(w, dt);
  tickAbilities(w, dt);
  tickMines(w);
  updateStructureGating(w);
  structureRegen(w, dt);
  passiveIncome(w, dt);
  clampToWorld(w);
  cleanupDead(w);
};
// sec
const DASH_DURATION = 0.18;
// ms
const DASH_COOLDOWN = 5000;

/** Universal dodge: a short unstoppable burst in (dx,dy). Host-validated cooldown. */
export const dashHero = (w: World, u: Unit, dx: number, dy: number): void => {
  const h = u.hero;
  if (!h || !u.alive || disabled(u)) {
    return;
  }
  if (w.now < h.dashReadyAt) {
    return;
  }
  const len = Math.hypot(dx, dy) || 1;
  h.dashX = dx / len;
  h.dashY = dy / len;
  h.dashUntil = w.now + DASH_DURATION * 1000;
  h.dashReadyAt = w.now + DASH_COOLDOWN;
  if (h.channel) {
    breakChannel(w, u);
  }
  u.facing = h.dashX >= 0 ? 1 : -1;
  u.statuses.push({ kind: "unstoppable", until: h.dashUntil });
  w.fx.push({ t: "blink", x: u.x, x2: u.x + h.dashX * 200, y: u.y, y2: u.y + h.dashY * 200 });
};
