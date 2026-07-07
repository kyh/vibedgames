// Core simulation types. The World is the single authoritative game state the
// host advances each tick and (eventually) serialises to clients. Pure data —
// no Phaser, no DOM.

import type { Team, DamageType, CreepKind, StructTier } from "../data/config";
import type { LaneId } from "../data/map";
import type { AbilityKey } from "../data/heroes";
import type { Vec2 } from "./math";

export type { Team, DamageType } from "../data/config";

export type UnitKind = "hero" | "creep" | "structure";

// ---- statuses --------------------------------------------------------------
// A flat list per unit. Each has an `until` (ms host-clock) expiry.
export type Status =
  | { kind: "stun"; until: number; sourceId: string }
  | { kind: "silence"; until: number }
  | { kind: "root"; until: number }
  | { kind: "taunt"; until: number; targetId: string } // forced to attack targetId
  | { kind: "slow"; until: number; pct: number; id: string } // pct 0..1, id to dedupe sources
  | { kind: "speed"; until: number; pct: number; flat: number; id: string }
  | { kind: "attackSpeed"; until: number; amount: number; id: string } // +flat attacks*100
  | { kind: "armorBonus"; until: number; amount: number; id: string }
  | { kind: "shield"; until: number; amount: number; id: string }
  | {
      kind: "dot";
      until: number;
      nextTick: number;
      dps: number;
      dtype: DamageType;
      sourceId: string;
      id: string;
    }
  | { kind: "heal"; until: number; nextTick: number; hps: number; id: string }
  | { kind: "damageReduction"; until: number; pct: number; id: string }
  | { kind: "reflect"; until: number; pct: number; id: string }
  | { kind: "untargetable"; until: number }
  | { kind: "aegis"; until: number } // Roshan drop: revive once on death
  | { kind: "unstoppable"; until: number } // immune to disables + collision
  | { kind: "damageAmp"; until: number; pct: number; id: string } // target takes +pct
  | { kind: "lifesteal"; until: number; pct: number; id: string }
  | { kind: "empowerNextAttack"; until: number; bonus: number; id: string }
  | { kind: "splashAttacks"; until: number; left: number; radius: number; pct: number; id: string }
  | { kind: "spellAmp"; until: number; pct: number; id: string };

// ---- orders ----------------------------------------------------------------
export type Order =
  | { type: "idle" }
  | { type: "move"; to: Vec2 }
  | { type: "moveDir"; dx: number; dy: number } // keyboard steering: a held unit-vector
  | { type: "attackMove"; to: Vec2 } // move but auto-engage enemies en route
  | { type: "attackUnit"; targetId: string }
  | { type: "hold" }
  | { type: "lane" } // creeps: follow the lane waypoints
  | { type: "neutral" } // jungle camp: hold near home, leash back when pulled
  | { type: "fountain" }; // return to base to heal

// ---- hero / creep / structure detail --------------------------------------
export type AbilitySlot = {
  rank: number;
  readyAt: number; // ms host-clock when off cooldown
  // transient per-cast bookkeeping handled in abilities.ts
};

export type ChannelState = {
  effect: string;
  key: AbilityKey;
  rank: number;
  until: number;
  nextTick: number;
  point: Vec2;
};

export type HeroState = {
  defId: string;
  ownerId: string; // multiplayer connection id, or "bot:<n>"
  isBot: boolean;
  slot: number; // 0..4 within team (for spawn offsets / colors)
  level: number;
  xp: number;
  gold: number;
  reliableGoldSpent: number;
  abilityPoints: number;
  abilities: Record<AbilityKey, AbilitySlot>;
  items: string[]; // item ids
  itemActiveReadyAt: Record<string, number>;
  // death/respawn
  respawnAt: number; // ms; 0 if alive
  killStreak: number;
  deaths: number;
  kills: number;
  assists: number;
  lastHits: number;
  denies: number;
  // recent attackers for assist credit: id -> ms
  recentDamageFrom: Record<string, number>;
  channel: ChannelState | null;
  // universal dodge dash (keyboard "F")
  dashUntil: number; // ms host-clock; > now while dashing
  dashReadyAt: number; // ms host-clock cooldown
  dashX: number;
  dashY: number;
  // marks: stormcaller hunter's mark etc handled via status on victim
  // bot AI bookkeeping
  botLane: LaneId;
  botNextDecisionAt: number;
  botRetreating: boolean;
};

export type CreepState = {
  ckind: CreepKind;
  lane: LaneId;
  waypoints: Vec2[];
  wpIdx: number;
  spawnWave: number;
  // neutral camp bookkeeping (set only on jungle/boss creeps)
  camp?: string;
  goldOverride?: [number, number];
  xpOverride?: number;
  boss?: boolean; // Roshan-style: drops an Aegis to the killing team
};

export type StructureState = {
  tier: StructTier;
  lane: LaneId | "base";
  structId: string;
  // tower damage ramp on consecutive same-target hits
  rampTargetId: string | null;
  rampStacks: number;
  attackable: boolean; // gated by tier rules (t2 after t1, ancient after both t3, etc.)
};

// ---- the unit --------------------------------------------------------------
export type Unit = {
  id: string;
  kind: UnitKind;
  team: Team;
  x: number;
  y: number;
  vx: number;
  vy: number;
  facing: 1 | -1;
  radius: number;
  alive: boolean;
  // neutral faction: enemy to BOTH teams, ally to other neutrals. `team` is kept
  // a valid Team for serialization but ignored for enmity when this is set.
  neutral?: boolean;
  homeX?: number; // leash anchor for neutral camps
  homeY?: number;

  hp: number;
  maxHp: number;
  mp: number;
  maxMp: number;
  hpRegen: number;
  mpRegen: number;

  baseDamage: number; // before buffs (current incl items)
  armor: number; // base incl items
  attackRange: number;
  attackSpeedBase: number; // attacks/sec incl items
  projectileSpeed: number;
  moveSpeedBase: number; // px/sec incl items
  magicResist: number;
  bonusSpellAmp: number; // fraction from items (0..1)
  bonusLifesteal: number; // fraction from items (0..1)

  lastAttackAt: number;
  // a wind-up attack in flight: damage resolves at `resolveAt`
  pendingAttack: {
    targetId: string;
    resolveAt: number;
  } | null;

  order: Order;
  path: Vec2[];
  pathIdx: number;
  repathAt: number;

  statuses: Status[];

  hero?: HeroState;
  creep?: CreepState;
  structure?: StructureState;
};

// ---- projectiles -----------------------------------------------------------
export type Projectile = {
  id: string;
  ownerId: string;
  team: Team;
  x: number;
  y: number;
  speed: number;
  targetId: string | null; // homing if set
  tx: number; // fallback target point (non-homing or last-known)
  ty: number;
  damage: number;
  dtype: DamageType;
  kind: "arrow" | "bolt" | "fireball" | "dynamite" | "tower"; // visual
  radius: number; // splash radius (0 = single target)
  onHit?: ProjectileHit; // extra effect tag applied on impact
};

export type ProjectileHit =
  | { tag: "none" }
  | { tag: "slow"; pct: number; duration: number }
  | { tag: "buildingBonus"; pct: number }
  | { tag: "burn"; dps: number; duration: number };

// ---- world events (one-shot, drained by the renderer each frame) -----------
export type FxEvent =
  | {
      t: "hit";
      x: number;
      y: number;
      dtype: DamageType;
      amount: number;
      crit?: boolean;
      targetId: string;
      // unit vector attacker->victim, for knockback recoil + spark spray
      nx: number;
      ny: number;
      isAttack?: boolean;
    }
  | { t: "death"; x: number; y: number; unitId: string; kind: UnitKind }
  | { t: "explosion"; x: number; y: number; radius: number; color: number }
  | { t: "cast"; x: number; y: number; effect: string; team: Team }
  | { t: "blink"; x: number; y: number; x2: number; y2: number }
  | { t: "levelup"; x: number; y: number; unitId: string }
  | { t: "gold"; x: number; y: number; amount: number; heroId: string }
  | { t: "heal"; x: number; y: number; amount: number }
  | { t: "structureDown"; x: number; y: number; team: Team; tier: StructTier }
  | { t: "kill"; killer: string; victim: string; team: Team } // hero kill, for the feed
  | { t: "notify"; text: string; tone: "good" | "bad" | "neutral" } // banner announce (Roshan, aegis…)
  | {
      t: "ability";
      effect: string;
      x: number;
      y: number;
      x2: number;
      y2: number;
      radius: number;
      team: Team;
    };

// ---- the world -------------------------------------------------------------
export type GamePhase = "playing" | "ended";

export type World = {
  now: number; // ms host clock (accumulated)
  gameTime: number; // seconds since match start
  phase: GamePhase;
  winner: Team | null;
  units: Map<string, Unit>;
  projectiles: Map<string, Projectile>;
  // wave bookkeeping
  nextWaveAt: number; // gameTime sec
  waveCount: number;
  // boomtinker mines etc (simple summons)
  mines: Map<string, Mine>;
  groundEffects: GroundEffect[]; // cinder trails, storm volleys, last call
  campRespawnAt: Record<string, number>; // neutral camp id -> gameTime sec to respawn
  fx: FxEvent[]; // drained by renderer
  seq: number; // id counter
  rngState: number; // mulberry32 state — a plain int so the World stays JSON-serializable
};

/** Advance the world RNG (mulberry32). Mutates rngState; returns [0,1). */
export function rand(w: World): number {
  let s = w.rngState | 0;
  s = (s + 0x6d2b79f5) | 0;
  let t = Math.imul(s ^ (s >>> 15), 1 | s);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  w.rngState = s;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

export type Mine = {
  id: string;
  ownerId: string;
  team: Team;
  x: number;
  y: number;
  armedAt: number;
  expireAt: number;
  damage: number;
  triggerRadius: number;
  slowPct: number;
};

export type GroundEffect = {
  id: string;
  ownerId: string;
  team: Team;
  effect: string; // for visuals
  x: number;
  y: number;
  radius: number;
  until: number;
  nextTick: number;
  tickInterval: number;
  // behavior bundle
  enemyDps?: number;
  dtype?: DamageType;
  slowPct?: number;
  allyHealPerTick?: number;
  allyManaPerTick?: number;
  cleanse?: boolean;
  burnDps?: number;
  burnDuration?: number;
  // behaviour flags
  followOwner?: boolean;
  channel?: boolean;
  detonate?: { dmg: number; amp: number; burnDps: number; burnDur: number };
};

export function nextId(w: World, prefix: string): string {
  w.seq += 1;
  return `${prefix}${w.seq}`;
}
