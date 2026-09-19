// The authoritative host loop. step(world, dt) advances one fixed tick. Pure
// data in/out — no engine, no Math.random. Guests never call this; they render
// snapshots. createWorld is deterministic given (seed).
import { CHAMP_BY_ID, DEFAULT_CHAMP } from "../data/champions";
import {
  ARENA_BOT_FILL,
  FOUNTAIN_HEAL_PER_SEC,
  JUMP_MS,
  JUMP_RECOVER,
  KILL_GOAL_FFA,
  MATCH_TIME,
  NEUTRAL_TEAM,
  SHOP_RADIUS,
  SIM_DT,
  SPAWN_GUARD_DPS,
  SPAWN_GUARD_RADIUS,
  STARTING_GOLD,
} from "../data/config";
import { ITEM_BY_ID, MAX_ITEMS } from "../data/items";
import { BOSS_POS, CAMPS, SPAWNS, clampToArena, resolveObstacles } from "../data/map";
import type { CampSpec, SpawnPoint } from "../data/map";
import { destructibleProps } from "../data/props";
import { resolveElevation } from "./elevation";
import { nextId } from "./types";
import type { Unit, World } from "./types";
import { effectiveMoveSpeed, expireStatuses, isDisabled, isRooted, recomputeStats } from "./stats";
import { applyKnockback, dealDamage, resolveAttacks, stepProjectiles } from "./combat";
import { castAbility, tickAbilities } from "./abilities";
import { tickEconomy, updateLeader } from "./economy";
import { tickBots } from "./ai";

const BOT_NAMES = ["Ru{}", "Vex", "Kato", "Mire", "Brak", "Nyx", "Orin", "Pyra"];

const BOT_CHAMPS = ["knight", "ranger", "mage", "rogue", "blackknight", "witch"];

/** The spawn pad a slot belongs to. SPAWNS is generated from the arena's edge
 *  angles, so this only throws on a misbuilt map. */
const mustGetSpawn = (slot: number): SpawnPoint => {
  const sp = SPAWNS[slot % SPAWNS.length];
  if (!sp) {
    throw new Error(`no spawn point for slot ${slot}`);
  }
  return sp;
};

export interface SpawnArgs {
  id: string;
  ownerId: string;
  team: string;
  champId: string;
  name: string;
  isBot: boolean;
  slot: number;
}

/** A fully-zeroed Unit skeleton — the ONE place the 60-field literal lives.
 *  Spawners spread real stats over it. */
const blankCombatant = (
  id: string,
  kind: Unit["kind"],
  team: string,
  ownerId: string,
  champId: string,
  name: string,
): Unit => ({
  abilities: {
    DASH: { rank: 0, readyAt: 0 },
    E: { rank: 0, readyAt: 0 },
    JUMP: { rank: 0, readyAt: 0 },
    Q: { rank: 0, readyAt: 0 },
    R: { rank: 0, readyAt: 0 },
    W: { rank: 0, readyAt: 0 },
  },
  abilityPower: 0,
  aimX: 0,
  aimY: 1,
  alive: true,
  ambush: false,
  armor: 0,
  assists: 0,
  attackDamageType: "physical",
  attackHeld: false,
  attackKind: "melee",
  attackRange: 0,
  attackSpeed: 1,
  attackType: "melee",
  attr: { agi: 0, int: 0, str: 0 },
  baseDamage: 0,
  champId,
  dashUntil: 0,
  dashVx: 0,
  dashVy: 0,
  deaths: 0,
  empowerNext: 0,
  facing: 0,
  gold: 0,
  hp: 1,
  hpRegen: 0,
  id,
  isBot: true,
  itemReadyAt: {},
  items: [],
  jumpUntil: 0,
  kbUntil: 0,
  kbx: 0,
  kby: 0,
  killStreak: 0,
  kills: 0,
  kind,
  lastAttackAt: 0,
  lastCastAt: 0,
  lastCastKey: "",
  lastHitAt: 0,
  lastHitDx: 0,
  lastHitDy: 0,
  level: 1,
  lifesteal: 0,
  magicResist: 0,
  maxHp: 1,
  mercy: 0,
  moveSpeed: 0,
  moveX: 0,
  moveY: 0,
  name,
  ownerId,
  pendingAttack: null,
  projectileSpeed: 0,
  queuedCast: null,
  radius: 0.6,
  recentDamageFrom: {},
  respawnAt: 0,
  slot: 0,
  statuses: [],
  steerVx: 0,
  steerVy: 0,
  swingCount: 0,
  team,
  vx: 0,
  vy: 0,
  x: 0,
  xp: 0,
  y: 0,
});

/** Spawn the destructible props (host-side; guests receive them in snapshots).
 *  unit.slot = the spec index so the renderer can look the placement back up. */
const spawnProps = (w: World): void => {
  for (const [i, spec] of destructibleProps().entries()) {
    const u: Unit = {
      ...blankCombatant(nextId(w, "prop"), "prop", NEUTRAL_TEAM, "neutral", spec.model, spec.model),
      hp: spec.hp,
      maxHp: spec.hp,
      radius: spec.radius,
      slot: i,
      x: spec.x,
      y: spec.y,
    };
    w.units.set(u.id, u);
  }
};

export const createWorld = (seed: number, opts: { soloMercy?: boolean } = {}): World => {
  const boss = { alive: true, hp: 4000, maxHp: 4000, x: BOSS_POS.x, y: BOSS_POS.y };
  const w: World = {
    boss,
    campRespawnAt: {},
    coins: [],
    deliveries: [],
    fx: [],
    gameTime: 0,
    grounds: [],
    killGoal: KILL_GOAL_FFA,
    leaderId: null,
    matchTime: MATCH_TIME,
    nextCoinAt: 8,
    nextDeliveryAt: 15,
    now: 0,
    phase: "playing",
    projectiles: new Map(),
    // oxlint-disable-next-line no-bitwise -- uint32 coercion is what makes the seed a valid RNG state
    rngState: seed >>> 0 || 1,
    seq: 0,
    soloMercy: opts.soloMercy ?? false,
    strikes: [],
    suddenDeath: false,
    units: new Map(),
    winner: null,
  };
  spawnProps(w);
  return w;
};

/** Create a hero unit at its base spawn, fully statted and alive. */
export const spawnHero = (w: World, args: SpawnArgs): Unit => {
  const def = CHAMP_BY_ID[args.champId] ?? CHAMP_BY_ID[DEFAULT_CHAMP];
  if (!def) {
    throw new Error(`unknown champion: ${args.champId}`);
  }
  const sp = mustGetSpawn(args.slot);
  const u: Unit = {
    ...blankCombatant(args.id, "hero", args.team, args.ownerId, def.id, args.name),
    abilities: {
      DASH: { rank: 1, readyAt: 0 },
      E: { rank: 1, readyAt: 0 },
      JUMP: { rank: 1, readyAt: 0 },
      Q: { rank: 1, readyAt: 0 },
      R: { rank: 0, readyAt: 0 },
      W: { rank: 1, readyAt: 0 },
    },
    aimX: Math.cos(sp.facing),
    aimY: Math.sin(sp.facing),
    attackDamageType: def.attackDamageType,
    attackKind: def.attackKind,
    attackType: def.attackType,
    attr: { ...def.attr },
    facing: sp.facing,
    gold: STARTING_GOLD,
    isBot: args.isBot,
    moveSpeed: 6,
    radius: def.radius ?? 0.62,
    slot: args.slot,
    x: sp.x,
    y: sp.y,
  };
  recomputeStats(u);
  u.hp = u.maxHp;
  w.units.set(u.id, u);
  return u;
};

export const botName = (w: World, i: number): string =>
  (BOT_NAMES[i % BOT_NAMES.length] ?? "Bot{}").replace("{}", String(i));

// ── Neutral skeleton camps (PvE) ─────────────────────────────────────────────
const CAMP_RESPAWN_SEC = 28;
// sentinel: camp is alive (JSON-safe, unlike Infinity)
const POPULATED = 1e9;

interface CreepStat {
  model: string;
  attackType: "melee" | "ranged";
  attackDamageType: "physical" | "magic";
  attackKind: string;
  hp: number;
  damage: number;
  armor: number;
  attackRange: number;
  attackSpeed: number;
  moveSpeed: number;
  projectileSpeed: number;
  radius: number;
  bounty: number;
  xp: number;
  // display name (default "Skeleton")
  name?: string;
  // hp/s (default 6; the golem regens hard between fights)
  hpRegen?: number;
}

const CREEP_STATS = new Map<string, CreepStat>(
  Object.entries({
    frostgolem: {
      armor: 8,
      attackDamageType: "physical",
      attackKind: "melee",
      attackRange: 3.2,
      attackSpeed: 0.6,
      attackType: "melee",
      bounty: 500,
      damage: 95,
      hp: 2400,
      hpRegen: 20,
      model: "FrostGolem",
      moveSpeed: 4.4,
      name: "Frost Golem",
      projectileSpeed: 0,
      radius: 1.25,
      xp: 350,
    },
    skmage: {
      armor: 1,
      attackDamageType: "magic",
      attackKind: "bolt",
      attackRange: 8,
      attackSpeed: 0.7,
      attackType: "ranged",
      bounty: 70,
      damage: 30,
      hp: 230,
      model: "Skeleton_Mage",
      moveSpeed: 4.6,
      projectileSpeed: 16,
      radius: 0.55,
      xp: 60,
    },
    skminion: {
      armor: 1,
      attackDamageType: "physical",
      attackKind: "melee",
      attackRange: 2,
      attackSpeed: 0.95,
      attackType: "melee",
      bounty: 35,
      damage: 24,
      hp: 200,
      model: "Skeleton_Minion",
      moveSpeed: 5.4,
      projectileSpeed: 0,
      radius: 0.52,
      xp: 32,
    },
    skwarrior: {
      armor: 3,
      attackDamageType: "physical",
      attackKind: "melee",
      attackRange: 2.2,
      attackSpeed: 0.8,
      attackType: "melee",
      bounty: 55,
      damage: 34,
      hp: 340,
      model: "Skeleton_Warrior",
      moveSpeed: 5,
      projectileSpeed: 0,
      radius: 0.6,
      xp: 50,
    },
  } satisfies Record<string, CreepStat>),
);

const mustGetCreep = (id: string): CreepStat => {
  const stat = CREEP_STATS.get(id);
  if (!stat) {
    throw new Error(`unknown creep: ${id}`);
  }
  return stat;
};

// Fallback for unknown creep types.
const DEFAULT_CREEP = mustGetCreep("skwarrior");

export const spawnCreep = (
  w: World,
  type: string,
  x: number,
  y: number,
  camp: { id: string; x: number; y: number },
): void => {
  const s = CREEP_STATS.get(type) ?? DEFAULT_CREEP;
  const u: Unit = {
    ...blankCombatant(nextId(w, "c"), "creep", NEUTRAL_TEAM, "neutral", type, s.name ?? "Skeleton"),
    armor: s.armor,
    attackDamageType: s.attackDamageType,
    attackKind: s.attackKind,
    attackRange: s.attackRange,
    attackSpeed: s.attackSpeed,
    attackType: s.attackType,
    baseDamage: s.damage,
    campId: camp.id,
    homeX: camp.x,
    homeY: camp.y,
    hp: s.hp,
    hpRegen: s.hpRegen ?? 6,
    magicResist: 0.1,
    maxHp: s.hp,
    moveSpeed: s.moveSpeed,
    projectileSpeed: s.projectileSpeed,
    radius: s.radius,
    x,
    y,
  };
  w.units.set(u.id, u);
};

/** Look up a creep's bounty/xp for the economy on kill. */
export const creepReward = (type: string) => {
  const s = CREEP_STATS.get(type) ?? DEFAULT_CREEP;
  return { bounty: s.bounty, xp: s.xp };
};

// Themed lineups per camp (camp0 = Armory runs warrior-heavy, camp3 = Cellar
// runs a minion swarm); the default pack is a balanced mix.
const CAMP_PACKS = new Map<string, string[]>([
  ["camp0", ["skwarrior", "skwarrior", "skmage", "skminion"]],
  ["camp3", ["skwarrior", "skmage", "skminion", "skminion"]],
]);
const DEFAULT_PACK = ["skwarrior", "skmage", "skminion", "skminion"];

const spawnCampPack = (w: World, camp: CampSpec): void => {
  const pack = camp.pack ?? CAMP_PACKS.get(camp.id) ?? DEFAULT_PACK;
  const [lone] = pack;
  if (pack.length === 1 && lone) {
    // a lone elite (the Frost Golem) holds the center of its lair
    spawnCreep(w, lone, camp.x, camp.y, camp);
    return;
  }
  for (const [i, type] of pack.entries()) {
    const a = (i / pack.length) * Math.PI * 2;
    spawnCreep(w, type, camp.x + Math.cos(a) * 2.2, camp.y + Math.sin(a) * 2.2, camp);
  }
};

const tickCamps = (w: World): void => {
  for (const camp of CAMPS) {
    let alive = 0;
    for (const u of w.units.values()) {
      if (u.kind === "creep" && u.alive && u.campId === camp.id) {
        alive += 1;
      }
    }
    if (alive > 0) {
      continue;
    }
    const at = w.campRespawnAt[camp.id] ?? 0;
    if (at === POPULATED) {
      // just cleared → schedule
      w.campRespawnAt[camp.id] = w.gameTime + (camp.respawnSec ?? CAMP_RESPAWN_SEC);
    } else if (w.gameTime >= at) {
      spawnCampPack(w, camp);
      w.campRespawnAt[camp.id] = POPULATED;
    }
  }
};

const cleanupDeadCreeps = (w: World): void => {
  for (const [id, u] of w.units) {
    if (u.kind === "creep" && !u.alive && w.now >= u.respawnAt) {
      w.units.delete(id);
    }
  }
};

const slotOf = (u: Unit): number => u.slot;

/** Is this unit standing in its own base (shop usable / fountain heals)? */
export const inOwnBase = (u: Unit): boolean => {
  const sp = mustGetSpawn(slotOf(u));
  return (u.x - sp.x) ** 2 + (u.y - sp.y) ** 2 <= SHOP_RADIUS * SHOP_RADIUS;
};

/** Host-side purchase. Returns true on success. */
export const buyItem = (w: World, u: Unit, itemId: string): boolean => {
  const it = ITEM_BY_ID[itemId];
  if (!it || !u.alive) {
    return false;
  }
  if (!inOwnBase(u)) {
    return false;
  }
  if (u.items.length >= MAX_ITEMS) {
    return false;
  }
  if (u.gold < it.cost) {
    return false;
  }
  u.gold -= it.cost;
  u.items.push(itemId);
  recomputeStats(u);
  return true;
};

/** Fill the arena up to ARENA_BOT_FILL combatants with bots (host-side). */
export const ensureBots = (w: World): void => {
  const humans = [...w.units.values()].filter((u) => u.kind === "hero" && !u.isBot).length;
  const bots = [...w.units.values()].filter((u) => u.kind === "hero" && u.isBot);
  const want = Math.max(0, ARENA_BOT_FILL - humans);
  // remove surplus bots
  for (const bot of bots.slice(want)) {
    w.units.delete(bot.id);
  }
  // add missing bots in free slots
  const usedSlots = new Set(
    [...w.units.values()].filter((u) => u.kind === "hero").map((u) => slotOf(u)),
  );
  let added = bots.length;
  for (let s = 0; s < SPAWNS.length && added < want; s += 1) {
    if (usedSlots.has(s)) {
      continue;
    }
    const idx = added;
    spawnHero(w, {
      champId: BOT_CHAMPS[idx % BOT_CHAMPS.length] ?? DEFAULT_CHAMP,
      id: `bot:${s}`,
      isBot: true,
      name: botName(w, s + 1),
      ownerId: `bot:${s}`,
      slot: s,
      team: `bot:${s}`,
    });
    usedSlots.add(s);
    added += 1;
  }
};

// ── Input ────────────────────────────────────────────────────────────────────
export const setHeroInput = (
  u: Unit,
  moveX: number,
  moveY: number,
  aimX: number,
  aimY: number,
  attackHeld: boolean,
): void => {
  u.moveX = moveX;
  u.moveY = moveY;
  if (aimX !== 0 || aimY !== 0) {
    u.aimX = aimX;
    u.aimY = aimY;
  }
  u.attackHeld = attackHeld;
};

export const respawn = (w: World, u: Unit): void => {
  const sp = mustGetSpawn(slotOf(u));
  u.alive = true;
  u.respawnAt = 0;
  u.x = sp.x;
  u.y = sp.y;
  u.vx = 0;
  u.vy = 0;
  u.facing = sp.facing;
  u.statuses = [];
  u.pendingAttack = null;
  u.dashUntil = 0;
  u.kbUntil = 0;
  u.jumpUntil = 0;
  u.queuedCast = null;
  u.ambush = false;
  u.steerVx = 0;
  u.steerVy = 0;
  recomputeStats(u);
  u.hp = u.maxHp;
};

const tickHeroLifecycle = (w: World, u: Unit, _dt: number): void => {
  if (!u.alive && u.respawnAt > 0 && w.now >= u.respawnAt) {
    respawn(w, u);
  }
};

/** Retry queued casts (input buffer). Runs after bot intent, before movement,
 *  so a buffered press lands the first tick it becomes legal. */
const drainInputBuffers = (w: World): void => {
  for (const u of w.units.values()) {
    if (u.kind !== "hero" || !u.alive) {
      continue;
    }
    const qc = u.queuedCast;
    if (qc) {
      if (w.now > qc.until) {
        u.queuedCast = null;
      } else if (
        castAbility(w, u, qc.key, { dir: { x: qc.ax, y: qc.ay }, point: { x: qc.px, y: qc.py } })
      ) {
        u.queuedCast = null;
      }
    }
  }
};

// ── Jump (Space) ─────────────────────────────────────────────────────────────
/** Start an evasive hop. Host-authoritative; jumpUntil rides the snapshot so
 *  guests see the same arc. Blocked while stunned/rooted or already airborne.
 *  (JUMP_MS/JUMP_RECOVER live in data/config to avoid a world↔abilities cycle.) */
export const tryJump = (w: World, u: Unit): void => {
  if (!u.alive || isDisabled(u) || isRooted(u)) {
    return;
  }
  if (w.now < u.jumpUntil + JUMP_RECOVER) {
    return;
    // mid-hop or still recovering
  }
  u.jumpUntil = w.now + JUMP_MS;
};

const regen = (u: Unit, dt: number): void => {
  if (u.hp < u.maxHp) {
    u.hp = Math.min(u.maxHp, u.hp + u.hpRegen * dt);
  }
};

const pruneAssist = (u: Unit, now: number): void => {
  u.recentDamageFrom = Object.fromEntries(
    Object.entries(u.recentDamageFrom).filter(([, at]) => now - at <= 6500),
  );
};

// Steering accel/decel (units/s of blend rate): starts ramp over ~3 ticks,
// stops snap in ~1-2 — stop-faster-than-start reads planted, not slippery.
const MOVE_ACCEL = 16;
const MOVE_DECEL = 26;

/** Travelling under an ability dash RIGHT NOW. A dash window with no velocity is
 *  a HOVER (an aerial ability holding you in the air): it still overrides
 *  steering, so you're committed, but it isn't going anywhere for you to face.
 *  (dashVx/dashVy are not cleared when a dash ends, so the time window is half
 *  the test — without it, facing would never follow aim again after one dash.) */
const isDashing = (w: World, u: Unit): boolean =>
  w.now < u.dashUntil && Math.hypot(u.dashVx, u.dashVy) > 0.01;

const moveUnit = (w: World, u: Unit, dt: number): void => {
  if (w.now < u.dashUntil) {
    // dash overrides steering (writes it directly — dashes stay instant)
    u.steerVx = u.dashVx;
    u.steerVy = u.dashVy;
    // a dash faces its travel direction — but a ZERO-speed dash is a HOVER (an
    // aerial ability pinning you in the air) and has no travel to face, so it
    // falls through to the aim-follow below instead of snapping to atan2(0, 0)
    if (isDashing(w, u)) {
      u.facing = Math.atan2(u.dashVy, u.dashVx);
    }
  } else {
    // target velocity from intent, then smooth steer toward it
    let tx = 0;
    let ty = 0;
    if (!isRooted(u)) {
      const jumping = w.now < u.jumpUntil;
      // hops cover ground
      const ms = effectiveMoveSpeed(u) * (jumping ? 1.25 : 1);
      let mx = u.moveX;
      let my = u.moveY;
      let mag = Math.hypot(mx, my);
      // a standing hop still bounds forward along your facing (reads as a leap)
      if (jumping && mag < 0.01) {
        mx = Math.cos(u.facing);
        my = Math.sin(u.facing);
        mag = 1;
      }
      if (mag > 0.01) {
        tx = (mx / mag) * ms;
        ty = (my / mag) * ms;
      }
    }
    const rate = tx !== 0 || ty !== 0 ? MOVE_ACCEL : MOVE_DECEL;
    const a = Math.min(1, rate * dt);
    u.steerVx += (tx - u.steerVx) * a;
    u.steerVy += (ty - u.steerVy) * a;
  }

  let vx = u.steerVx;
  let vy = u.steerVy;

  // knockback impulse (decays linearly to kbUntil) stacks on top of steering
  if (w.now < u.kbUntil) {
    const frac = (u.kbUntil - w.now) / 1000;
    vx += u.kbx * frac;
    vy += u.kby * frac;
  }

  u.vx = vx;
  u.vy = vy;

  let nx = u.x + vx * dt;
  let ny = u.y + vy * dt;
  const r = resolveObstacles(nx, ny, u.radius);
  nx = r.x;
  ny = r.y;
  const c = clampToArena(nx, ny, u.radius);
  // gate the throne plateau: can't cross its edge except at the stair gaps
  const e = resolveElevation(u.x, u.y, c.x, c.y, u.radius);
  u.x = e.x;
  u.y = e.y;

  // facing follows aim when not in an ability-dash (a dash faces its travel; a
  // hover isn't going anywhere, so you keep aiming through it)
  if (!isDashing(w, u) && (u.aimX !== 0 || u.aimY !== 0)) {
    u.facing = Math.atan2(u.aimY, u.aimX);
  }
};

/** Boid push-apart so heroes don't stack on the throne. Destructible props are
 *  immovable — they shove the other body the full distance instead of moving.
 *  The push respects the plateau edge: a shove is a move like any other, so it
 *  can't post a body through the cliff (that used to teleport a unit a level up
 *  or down and left it standing inside the wall). */
const separation = (w: World): void => {
  const units = [...w.units.values()].filter((u) => u.alive && u.kind !== "boss");
  const before = units.map((u) => ({ x: u.x, y: u.y }));
  for (let i = 0; i < units.length; i += 1) {
    for (let j = i + 1; j < units.length; j += 1) {
      const a = units[i];
      const b = units[j];
      if (!a || !b) {
        continue;
      }
      const aProp = a.kind === "prop";
      const bProp = b.kind === "prop";
      if (aProp && bProp) {
        continue;
        // pre-placed, never overlap
      }
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const min = a.radius + b.radius;
      const d2 = dx * dx + dy * dy;
      if (d2 < min * min && d2 > 1e-6) {
        const d = Math.sqrt(d2);
        const push = (min - d) / d / 2;
        if (aProp) {
          b.x += dx * push * 2;
          b.y += dy * push * 2;
        } else if (bProp) {
          a.x -= dx * push * 2;
          a.y -= dy * push * 2;
        } else {
          a.x -= dx * push;
          a.y -= dy * push;
          b.x += dx * push;
          b.y += dy * push;
        }
      }
    }
  }
  for (let i = 0; i < units.length; i += 1) {
    const u = units[i];
    const p = before[i];
    if (!u || !p || u.kind === "prop") {
      continue;
    }
    const e = resolveElevation(p.x, p.y, u.x, u.y, u.radius);
    u.x = e.x;
    u.y = e.y;
  }
};

/** Home fountains heal their owner fast; enemy bases knock back + burn intruders
 *  (anti spawn-camp). */
const fountains = (w: World, dt: number): void => {
  for (const u of w.units.values()) {
    if (u.kind !== "hero" || !u.alive) {
      continue;
    }
    const mySlot = slotOf(u);
    for (const sp of SPAWNS) {
      const d2 = (u.x - sp.x) ** 2 + (u.y - sp.y) ** 2;
      if (sp.slot === mySlot) {
        if (d2 <= SHOP_RADIUS * SHOP_RADIUS && u.hp < u.maxHp) {
          u.hp = Math.min(u.maxHp, u.hp + u.maxHp * FOUNTAIN_HEAL_PER_SEC * dt);
        }
      } else if (d2 <= SPAWN_GUARD_RADIUS * SPAWN_GUARD_RADIUS) {
        dealDamage(w, null, u, SPAWN_GUARD_DPS * dt, "pure", { silentFx: true });
        applyKnockback(u, sp.x, sp.y, 10, w);
      }
    }
  }
};

const clampAll = (w: World): void => {
  for (const u of w.units.values()) {
    const r = resolveObstacles(u.x, u.y, u.radius);
    const c = clampToArena(r.x, r.y, u.radius);
    u.x = c.x;
    u.y = c.y;
  }
};

const endMatch = (w: World, winner: string, name: string): void => {
  w.phase = "ended";
  w.winner = winner;
  w.fx.push({ kind: "matchend", t: "notify", text: `${name} WINS` });
};

const checkWin = (w: World): void => {
  if (w.phase !== "playing") {
    return;
  }
  const heroes = [...w.units.values()].filter((u) => u.kind === "hero");
  // kill goal
  for (const u of heroes) {
    if (u.kills >= w.killGoal) {
      endMatch(w, u.team, u.name);
      return;
    }
  }
  // timer
  if (w.gameTime >= w.matchTime) {
    const sorted = [...heroes].toSorted((a, b) => b.kills - a.kills);
    const [top, second] = sorted;
    if (!top) {
      return;
    }
    if (!second || top.kills > second.kills) {
      endMatch(w, top.team, top.name);
    } else {
      // tie → first to pull ahead wins (checked above via kill goal logic)
      w.suddenDeath = true;
      // raise an effective goal: leader+1
      w.killGoal = top.kills + 1;
    }
  }
};

// ── The tick ─────────────────────────────────────────────────────────────────
export const step = (w: World, dt: number = SIM_DT): void => {
  if (w.phase === "ended") {
    stepProjectiles(w, dt);
    return;
  }
  w.now += dt * 1000;
  w.gameTime += dt;

  for (const u of w.units.values()) {
    expireStatuses(u, w.now);
    if (u.kind === "hero") {
      tickHeroLifecycle(w, u, dt);
    }
    if (u.kind === "prop" && !u.alive && u.respawnAt > 0 && w.now >= u.respawnAt) {
      u.alive = true;
      u.hp = u.maxHp;
      u.respawnAt = 0;
      u.statuses = [];
    }
    if (u.alive) {
      regen(u, dt);
    }
    pruneAssist(u, w.now);
  }

  // (re)populate skeleton camps
  tickCamps(w);
  // bots + skeletons decide intent before movement resolves
  tickBots(w);
  // buffered casts fire the moment they're legal
  drainInputBuffers(w);

  for (const u of w.units.values()) {
    if (!u.alive || u.kind === "boss" || u.kind === "dummy" || u.kind === "prop") {
      continue;
    }
    moveUnit(w, u, dt);
  }

  separation(w);
  resolveAttacks(w);
  stepProjectiles(w, dt);
  tickAbilities(w, dt);
  tickEconomy(w, dt);
  fountains(w, dt);
  clampAll(w);
  cleanupDeadCreeps(w);
  updateLeader(w);
  checkWin(w);
};

export { abilityRankCap, syncAbilityRanks } from "./ranks";
export { ABILITY_KEYS } from "./types";
export { champStatAt } from "../data/champions";
export { NEUTRAL_TEAM } from "../data/config";
