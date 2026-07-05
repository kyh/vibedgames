// The authoritative host loop. step(world, dt) advances one fixed tick. Pure
// data in/out — no engine, no Math.random. Guests never call this; they render
// snapshots. createWorld is deterministic given (seed).
import { CHAMP_BY_ID, champStatAt } from "../data/champions";
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
import { BOSS_POS, CAMPS, SPAWNS, clampToArena, resolveObstacles, type CampSpec } from "../data/map";
import { PROP_RESPAWN_MS, destructibleProps } from "../data/props";
import { resolveElevation } from "./elevation";
import { ABILITY_KEYS, type Unit, type World, nextId } from "./types";
import { effectiveMoveSpeed, expireStatuses, isDisabled, isRooted, recomputeStats } from "./stats";
import { applyKnockback, dealDamage, resolveAttacks, stepProjectiles } from "./combat";
import { castAbility, tickAbilities } from "./abilities";
import { tickEconomy, updateLeader } from "./economy";
import { tickBots } from "./ai";

const BOT_NAMES = ["Ru{}", "Vex", "Kato", "Mire", "Brak", "Nyx", "Orin", "Pyra"];
const BOT_CHAMPS = ["knight", "ranger", "mage", "rogue", "blackknight", "witch"];

export function createWorld(seed: number, opts: { soloMercy?: boolean } = {}): World {
  const boss = { x: BOSS_POS.x, y: BOSS_POS.y, hp: 4000, maxHp: 4000, alive: true };
  const w: World = {
    now: 0,
    gameTime: 0,
    phase: "playing",
    soloMercy: opts.soloMercy ?? false,
    winner: null,
    killGoal: KILL_GOAL_FFA,
    matchTime: MATCH_TIME,
    suddenDeath: false,
    units: new Map(),
    projectiles: new Map(),
    grounds: [],
    strikes: [],
    coins: [],
    deliveries: [],
    boss,
    leaderId: null,
    nextCoinAt: 8,
    nextDeliveryAt: 15,
    campRespawnAt: {},
    fx: [],
    seq: 0,
    rngState: seed >>> 0 || 1,
  };
  spawnProps(w);
  return w;
}

/** Spawn the destructible props (host-side; guests receive them in snapshots).
 *  unit.slot = the spec index so the renderer can look the placement back up. */
function spawnProps(w: World): void {
  destructibleProps().forEach((spec, i) => {
    const u: Unit = {
      ...blankCombatant(nextId(w, "prop"), "prop", NEUTRAL_TEAM, "neutral", spec.model, spec.model),
      slot: i,
      x: spec.x,
      y: spec.y,
      radius: spec.radius,
      hp: spec.hp,
      maxHp: spec.hp,
    };
    w.units.set(u.id, u);
  });
}

export type SpawnArgs = {
  id: string;
  ownerId: string;
  team: string;
  champId: string;
  name: string;
  isBot: boolean;
  slot: number;
};

/** A fully-zeroed Unit skeleton — the ONE place the 60-field literal lives.
 *  Spawners spread real stats over it. */
function blankCombatant(id: string, kind: Unit["kind"], team: string, ownerId: string, champId: string, name: string): Unit {
  return {
    id,
    kind,
    team,
    ownerId,
    champId,
    isBot: true,
    name,
    slot: 0,
    x: 0,
    y: 0,
    vx: 0,
    vy: 0,
    facing: 0,
    radius: 0.6,
    alive: true,
    hp: 1,
    maxHp: 1,
    hpRegen: 0,
    baseDamage: 0,
    armor: 0,
    magicResist: 0,
    attackType: "melee",
    attackKind: "melee",
    attackDamageType: "physical",
    attackRange: 0,
    attackSpeed: 1,
    moveSpeed: 0,
    projectileSpeed: 0,
    abilityPower: 0,
    lifesteal: 0,
    attr: { str: 0, agi: 0, int: 0 },
    level: 1,
    xp: 0,
    gold: 0,
    abilities: {
      Q: { rank: 0, readyAt: 0 },
      W: { rank: 0, readyAt: 0 },
      E: { rank: 0, readyAt: 0 },
      R: { rank: 0, readyAt: 0 },
      DASH: { rank: 0, readyAt: 0 },
      JUMP: { rank: 0, readyAt: 0 },
    },
    items: [],
    itemReadyAt: {},
    lastAttackAt: 0,
    swingCount: 0,
    lastCastAt: 0,
    lastCastKey: "",
    lastHitAt: 0,
    lastHitDx: 0,
    lastHitDy: 0,
    pendingAttack: null,
    statuses: [],
    recentDamageFrom: {},
    queuedCast: null,
    steerVx: 0,
    steerVy: 0,
    moveX: 0,
    moveY: 0,
    aimX: 0,
    aimY: 1,
    attackHeld: false,
    kbx: 0,
    kby: 0,
    kbUntil: 0,
    dashUntil: 0,
    dashVx: 0,
    dashVy: 0,
    empowerNext: 0,
    ambush: false,
    jumpUntil: 0,
    respawnAt: 0,
    kills: 0,
    deaths: 0,
    assists: 0,
    killStreak: 0,
    mercy: 0,
  };
}

/** Create a hero unit at its base spawn, fully statted and alive. */
export function spawnHero(w: World, args: SpawnArgs): Unit {
  const def = CHAMP_BY_ID[args.champId] ?? CHAMP_BY_ID["knight"]!;
  const sp = SPAWNS[args.slot % SPAWNS.length]!;
  const u: Unit = {
    ...blankCombatant(args.id, "hero", args.team, args.ownerId, def.id, args.name),
    isBot: args.isBot,
    slot: args.slot,
    x: sp.x,
    y: sp.y,
    facing: sp.facing,
    radius: def.radius ?? 0.62,
    attackType: def.attackType,
    attackKind: def.attackKind,
    attackDamageType: def.attackDamageType,
    moveSpeed: 6,
    attr: { ...def.attr },
    gold: STARTING_GOLD,
    abilities: {
      Q: { rank: 1, readyAt: 0 },
      W: { rank: 1, readyAt: 0 },
      E: { rank: 1, readyAt: 0 },
      R: { rank: 0, readyAt: 0 },
      DASH: { rank: 1, readyAt: 0 },
      JUMP: { rank: 1, readyAt: 0 },
    },
    aimX: Math.cos(sp.facing),
    aimY: Math.sin(sp.facing),
  };
  recomputeStats(u);
  u.hp = u.maxHp;
  w.units.set(u.id, u);
  return u;
}

export function botName(w: World, i: number): string {
  return BOT_NAMES[i % BOT_NAMES.length]!.replace("{}", String(i));
}

// ── Neutral skeleton camps (PvE) ─────────────────────────────────────────────
const CAMP_RESPAWN_SEC = 28;
const POPULATED = 1e9; // sentinel: camp is alive (JSON-safe, unlike Infinity)

type CreepStat = {
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
  name?: string; // display name (default "Skeleton")
  hpRegen?: number; // hp/s (default 6; the golem regens hard between fights)
};

const CREEP_STATS: Record<string, CreepStat> = {
  skwarrior: { model: "Skeleton_Warrior", attackType: "melee", attackDamageType: "physical", attackKind: "melee", hp: 340, damage: 34, armor: 3, attackRange: 2.2, attackSpeed: 0.8, moveSpeed: 5, projectileSpeed: 0, radius: 0.6, bounty: 55, xp: 50 },
  skmage: { model: "Skeleton_Mage", attackType: "ranged", attackDamageType: "magic", attackKind: "bolt", hp: 230, damage: 30, armor: 1, attackRange: 8, attackSpeed: 0.7, moveSpeed: 4.6, projectileSpeed: 16, radius: 0.55, bounty: 70, xp: 60 },
  skminion: { model: "Skeleton_Minion", attackType: "melee", attackDamageType: "physical", attackKind: "melee", hp: 200, damage: 24, armor: 1, attackRange: 2, attackSpeed: 0.95, moveSpeed: 5.4, projectileSpeed: 0, radius: 0.52, bounty: 35, xp: 32 },
  frostgolem: { model: "FrostGolem", attackType: "melee", attackDamageType: "physical", attackKind: "melee", hp: 2400, damage: 95, armor: 8, attackRange: 3.2, attackSpeed: 0.6, moveSpeed: 4.4, projectileSpeed: 0, radius: 1.25, bounty: 500, xp: 350, name: "Frost Golem", hpRegen: 20 },
};

export function spawnCreep(w: World, type: string, x: number, y: number, camp: { id: string; x: number; y: number }): void {
  const s = CREEP_STATS[type] ?? CREEP_STATS["skwarrior"]!;
  const u: Unit = {
    ...blankCombatant(nextId(w, "c"), "creep", NEUTRAL_TEAM, "neutral", type, s.name ?? "Skeleton"),
    campId: camp.id,
    homeX: camp.x,
    homeY: camp.y,
    x,
    y,
    radius: s.radius,
    hp: s.hp,
    maxHp: s.hp,
    hpRegen: s.hpRegen ?? 6,
    baseDamage: s.damage,
    armor: s.armor,
    magicResist: 0.1,
    attackType: s.attackType,
    attackKind: s.attackKind,
    attackDamageType: s.attackDamageType,
    attackRange: s.attackRange,
    attackSpeed: s.attackSpeed,
    moveSpeed: s.moveSpeed,
    projectileSpeed: s.projectileSpeed,
  };
  w.units.set(u.id, u);
}

/** Look up a creep's bounty/xp for the economy on kill. */
export function creepReward(type: string): { bounty: number; xp: number } {
  const s = CREEP_STATS[type] ?? CREEP_STATS["skwarrior"]!;
  return { bounty: s.bounty, xp: s.xp };
}

// Themed lineups per camp (camp0 = Armory runs warrior-heavy, camp3 = Cellar
// runs a minion swarm); the default pack is a balanced mix.
const CAMP_PACKS: Record<string, string[]> = {
  camp0: ["skwarrior", "skwarrior", "skmage", "skminion"],
  camp3: ["skwarrior", "skmage", "skminion", "skminion"],
};
const DEFAULT_PACK = ["skwarrior", "skmage", "skminion", "skminion"];

function spawnCampPack(w: World, camp: CampSpec): void {
  const pack = camp.pack ?? CAMP_PACKS[camp.id] ?? DEFAULT_PACK;
  if (pack.length === 1) {
    // a lone elite (the Frost Golem) holds the center of its lair
    spawnCreep(w, pack[0]!, camp.x, camp.y, camp);
    return;
  }
  pack.forEach((type, i) => {
    const a = (i / pack.length) * Math.PI * 2;
    spawnCreep(w, type, camp.x + Math.cos(a) * 2.2, camp.y + Math.sin(a) * 2.2, camp);
  });
}

function tickCamps(w: World): void {
  for (const camp of CAMPS) {
    let alive = 0;
    for (const u of w.units.values()) {
      if (u.kind === "creep" && u.alive && u.campId === camp.id) alive++;
    }
    if (alive > 0) continue;
    const at = w.campRespawnAt[camp.id] ?? 0;
    if (at === POPULATED) {
      w.campRespawnAt[camp.id] = w.gameTime + (camp.respawnSec ?? CAMP_RESPAWN_SEC); // just cleared → schedule
    } else if (w.gameTime >= at) {
      spawnCampPack(w, camp);
      w.campRespawnAt[camp.id] = POPULATED;
    }
  }
}

function cleanupDeadCreeps(w: World): void {
  for (const [id, u] of w.units) {
    if (u.kind === "creep" && !u.alive && w.now >= u.respawnAt) w.units.delete(id);
  }
}

/** Is this unit standing in its own base (shop usable / fountain heals)? */
export function inOwnBase(u: Unit): boolean {
  const sp = SPAWNS[slotOf(u) % SPAWNS.length]!;
  return (u.x - sp.x) ** 2 + (u.y - sp.y) ** 2 <= SHOP_RADIUS * SHOP_RADIUS;
}

/** Host-side purchase. Returns true on success. */
export function buyItem(w: World, u: Unit, itemId: string): boolean {
  const it = ITEM_BY_ID[itemId];
  if (!it || !u.alive) return false;
  if (!inOwnBase(u)) return false;
  if (u.items.length >= MAX_ITEMS) return false;
  if (u.gold < it.cost) return false;
  u.gold -= it.cost;
  u.items.push(itemId);
  recomputeStats(u);
  return true;
}

/** Fill the arena up to ARENA_BOT_FILL combatants with bots (host-side). */
export function ensureBots(w: World): void {
  const humans = [...w.units.values()].filter((u) => u.kind === "hero" && !u.isBot).length;
  const bots = [...w.units.values()].filter((u) => u.kind === "hero" && u.isBot);
  const want = Math.max(0, ARENA_BOT_FILL - humans);
  // remove surplus bots
  for (let i = want; i < bots.length; i++) w.units.delete(bots[i]!.id);
  // add missing bots in free slots
  const usedSlots = new Set(
    [...w.units.values()].filter((u) => u.kind === "hero").map((u) => slotOf(u)),
  );
  let added = bots.length;
  for (let s = 0; s < SPAWNS.length && added < want; s++) {
    if (usedSlots.has(s)) continue;
    const idx = added;
    spawnHero(w, {
      id: `bot:${s}`,
      ownerId: `bot:${s}`,
      team: `bot:${s}`,
      champId: BOT_CHAMPS[idx % BOT_CHAMPS.length]!,
      name: botName(w, s + 1),
      isBot: true,
      slot: s,
    });
    usedSlots.add(s);
    added++;
  }
}

function slotOf(u: Unit): number {
  return u.slot;
}

// ── Input ────────────────────────────────────────────────────────────────────
export function setHeroInput(
  u: Unit,
  moveX: number,
  moveY: number,
  aimX: number,
  aimY: number,
  attackHeld: boolean,
): void {
  u.moveX = moveX;
  u.moveY = moveY;
  if (aimX !== 0 || aimY !== 0) {
    u.aimX = aimX;
    u.aimY = aimY;
  }
  u.attackHeld = attackHeld;
}

// ── The tick ─────────────────────────────────────────────────────────────────
export function step(w: World, dt: number = SIM_DT): void {
  if (w.phase === "ended") {
    stepProjectiles(w, dt);
    return;
  }
  w.now += dt * 1000;
  w.gameTime += dt;

  for (const u of w.units.values()) {
    expireStatuses(u, w.now);
    if (u.kind === "hero") tickHeroLifecycle(w, u, dt);
    if (u.kind === "prop" && !u.alive && u.respawnAt > 0 && w.now >= u.respawnAt) {
      u.alive = true;
      u.hp = u.maxHp;
      u.respawnAt = 0;
      u.statuses = [];
    }
    if (u.alive) regen(u, dt);
    pruneAssist(u, w.now);
  }

  tickCamps(w); // (re)populate skeleton camps
  tickBots(w); // bots + skeletons decide intent before movement resolves
  drainInputBuffers(w); // buffered casts fire the moment they're legal

  for (const u of w.units.values()) {
    if (!u.alive || u.kind === "boss" || u.kind === "dummy" || u.kind === "prop") continue;
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
}

function tickHeroLifecycle(w: World, u: Unit, _dt: number): void {
  if (!u.alive && u.respawnAt > 0 && w.now >= u.respawnAt) {
    respawn(w, u);
  }
}

/** Retry queued casts (input buffer). Runs after bot intent, before movement,
 *  so a buffered press lands the first tick it becomes legal. */
function drainInputBuffers(w: World): void {
  for (const u of w.units.values()) {
    if (u.kind !== "hero" || !u.alive) continue;
    const qc = u.queuedCast;
    if (qc) {
      if (w.now > qc.until) u.queuedCast = null;
      else if (castAbility(w, u, qc.key, { point: { x: qc.px, y: qc.py }, dir: { x: qc.ax, y: qc.ay } })) u.queuedCast = null;
    }
  }
}

export function respawn(w: World, u: Unit): void {
  const sp = SPAWNS[slotOf(u) % SPAWNS.length]!;
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
}

// ── Jump (Space) ─────────────────────────────────────────────────────────────
/** Start an evasive hop. Host-authoritative; jumpUntil rides the snapshot so
 *  guests see the same arc. Blocked while stunned/rooted or already airborne.
 *  (JUMP_MS/JUMP_RECOVER live in data/config to avoid a world↔abilities cycle.) */
export function tryJump(w: World, u: Unit): void {
  if (!u.alive || isDisabled(u) || isRooted(u)) return;
  if (w.now < u.jumpUntil + JUMP_RECOVER) return; // mid-hop or still recovering
  u.jumpUntil = w.now + JUMP_MS;
}

function regen(u: Unit, dt: number): void {
  if (u.hp < u.maxHp) u.hp = Math.min(u.maxHp, u.hp + u.hpRegen * dt);
}

function pruneAssist(u: Unit, now: number): void {
  for (const k of Object.keys(u.recentDamageFrom)) {
    if (now - u.recentDamageFrom[k]! > 6500) delete u.recentDamageFrom[k];
  }
}

// Steering accel/decel (units/s of blend rate): starts ramp over ~3 ticks,
// stops snap in ~1-2 — stop-faster-than-start reads planted, not slippery.
const MOVE_ACCEL = 16;
const MOVE_DECEL = 26;

function moveUnit(w: World, u: Unit, dt: number): void {
  if (w.now < u.dashUntil) {
    // dash overrides steering (writes it directly — dashes stay instant)
    u.steerVx = u.dashVx;
    u.steerVy = u.dashVy;
    // a dash faces its travel direction
    u.facing = Math.atan2(u.dashVy, u.dashVx);
  } else {
    // target velocity from intent, then smooth steer toward it
    let tx = 0;
    let ty = 0;
    if (!isRooted(u)) {
      const jumping = w.now < u.jumpUntil;
      const ms = effectiveMoveSpeed(u) * (jumping ? 1.25 : 1); // hops cover ground
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

  // facing follows aim when not in an ability-dash (a dash faces its travel)
  if (w.now >= u.dashUntil && (u.aimX !== 0 || u.aimY !== 0)) {
    u.facing = Math.atan2(u.aimY, u.aimX);
  }
}

/** Boid push-apart so heroes don't stack on the throne. Destructible props are
 *  immovable — they shove the other body the full distance instead of moving. */
function separation(w: World): void {
  const units = [...w.units.values()].filter((u) => u.alive && u.kind !== "boss");
  for (let i = 0; i < units.length; i++) {
    for (let j = i + 1; j < units.length; j++) {
      const a = units[i]!;
      const b = units[j]!;
      const aProp = a.kind === "prop";
      const bProp = b.kind === "prop";
      if (aProp && bProp) continue; // pre-placed, never overlap
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
}

/** Home fountains heal their owner fast; enemy bases knock back + burn intruders
 *  (anti spawn-camp). */
function fountains(w: World, dt: number): void {
  for (const u of w.units.values()) {
    if (u.kind !== "hero" || !u.alive) continue;
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
}

function clampAll(w: World): void {
  for (const u of w.units.values()) {
    const r = resolveObstacles(u.x, u.y, u.radius);
    const c = clampToArena(r.x, r.y, u.radius);
    u.x = c.x;
    u.y = c.y;
  }
}

function endMatch(w: World, winner: string, name: string): void {
  w.phase = "ended";
  w.winner = winner;
  w.fx.push({ t: "notify", text: `${name} WINS`, kind: "matchend" });
}

function checkWin(w: World): void {
  if (w.phase !== "playing") return;
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
    const sorted = [...heroes].sort((a, b) => b.kills - a.kills);
    const top = sorted[0];
    const second = sorted[1];
    if (!top) return;
    if (!second || top.kills > second.kills) {
      endMatch(w, top.team, top.name);
    } else {
      w.suddenDeath = true; // tie → first to pull ahead wins (checked above via kill goal logic)
      // raise an effective goal: leader+1
      w.killGoal = top.kills + 1;
    }
  }
}

export { abilityRankCap, syncAbilityRanks } from "./ranks";
export { ABILITY_KEYS, champStatAt, NEUTRAL_TEAM };
