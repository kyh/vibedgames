import type { Team, DamageType, CreepKind, StructTier } from "../data/config";
import type { LaneId } from "../data/map";
import type { AbilityKey } from "../data/heroes";
import type { Vec2 } from "./math";

export type { Team, DamageType } from "../data/config";

export type UnitKind = "hero" | "creep" | "structure";

export type Status =
  | { kind: "stun"; until: number; sourceId: string }
  | { kind: "silence"; until: number }
  | { kind: "root"; until: number }
  | { kind: "taunt"; until: number; targetId: string }
  | { kind: "slow"; until: number; pct: number; id: string }
  | { kind: "speed"; until: number; pct: number; flat: number; id: string }
  | { kind: "attackSpeed"; until: number; amount: number; id: string }
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
  | { kind: "aegis"; until: number }
  | { kind: "unstoppable"; until: number }
  | { kind: "damageAmp"; until: number; pct: number; id: string }
  | { kind: "lifesteal"; until: number; pct: number; id: string }
  | { kind: "empowerNextAttack"; until: number; bonus: number; id: string }
  | { kind: "splashAttacks"; until: number; left: number; radius: number; pct: number; id: string }
  | { kind: "spellAmp"; until: number; pct: number; id: string };

export type Order =
  | { type: "idle" }
  | { type: "move"; to: Vec2 }
  | { type: "moveDir"; dx: number; dy: number }
  | { type: "attackMove"; to: Vec2 }
  | { type: "attackUnit"; targetId: string }
  | { type: "hold" }
  | { type: "lane" }
  | { type: "neutral" }
  | { type: "fountain" };

export type AbilitySlot = {
  rank: number;
  readyAt: number;
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
  ownerId: string;
  isBot: boolean;
  slot: number;
  level: number;
  xp: number;
  gold: number;
  reliableGoldSpent: number;
  abilityPoints: number;
  abilities: Record<AbilityKey, AbilitySlot>;
  items: string[];
  itemActiveReadyAt: Record<string, number>;
  respawnAt: number;
  killStreak: number;
  deaths: number;
  kills: number;
  assists: number;
  lastHits: number;
  denies: number;
  recentDamageFrom: Record<string, number>;
  channel: ChannelState | null;
  dashUntil: number;
  dashReadyAt: number;
  dashX: number;
  dashY: number;
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
  camp?: string;
  goldOverride?: [number, number];
  xpOverride?: number;
  boss?: boolean;
};

export type StructureState = {
  tier: StructTier;
  lane: LaneId | "base";
  structId: string;
  rampTargetId: string | null;
  rampStacks: number;
  attackable: boolean;
};

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
  neutral?: boolean;
  homeX?: number;
  homeY?: number;

  hp: number;
  maxHp: number;
  mp: number;
  maxMp: number;
  hpRegen: number;
  mpRegen: number;

  baseDamage: number;
  armor: number;
  attackRange: number;
  attackSpeedBase: number;
  projectileSpeed: number;
  moveSpeedBase: number;
  magicResist: number;
  bonusSpellAmp: number;
  bonusLifesteal: number;

  lastAttackAt: number;
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

export type Projectile = {
  id: string;
  ownerId: string;
  team: Team;
  x: number;
  y: number;
  speed: number;
  targetId: string | null;
  tx: number;
  ty: number;
  damage: number;
  dtype: DamageType;
  kind: "arrow" | "bolt" | "fireball" | "dynamite" | "tower";
  radius: number;
  onHit?: ProjectileHit;
};

export type ProjectileHit =
  | { tag: "none" }
  | { tag: "slow"; pct: number; duration: number }
  | { tag: "buildingBonus"; pct: number }
  | { tag: "burn"; dps: number; duration: number };

export type FxEvent =
  | {
      t: "hit";
      x: number;
      y: number;
      dtype: DamageType;
      amount: number;
      crit?: boolean;
      targetId: string;
      nx: number;
      ny: number;
      isAttack?: boolean;
      /** Source hero identity for cosmetic impact colour; absent for environment/creeps. */
      attackerHero?: string;
    }
  | { t: "death"; x: number; y: number; unitId: string; kind: UnitKind }
  | { t: "explosion"; x: number; y: number; radius: number; color: number }
  | {
      t: "cast";
      x: number;
      y: number;
      effect: string;
      team: Team;
      /** Atomic accepted-action provenance. Older peers omit it. */
      actor?: { unitId: string; at: number };
    }
  | { t: "blink"; x: number; y: number; x2: number; y2: number }
  | { t: "levelup"; x: number; y: number; unitId: string }
  | { t: "gold"; x: number; y: number; amount: number; heroId: string }
  | { t: "heal"; x: number; y: number; amount: number }
  | { t: "structureDown"; x: number; y: number; team: Team; tier: StructTier }
  | { t: "kill"; killer: string; victim: string; team: Team }
  | { t: "notify"; text: string; tone: "good" | "bad" | "neutral" }
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

export type GamePhase = "playing" | "ended";

export interface World {
  now: number;
  gameTime: number;
  phase: GamePhase;
  winner: Team | null;
  units: Map<string, Unit>;
  projectiles: Map<string, Projectile>;
  nextWaveAt: number;
  waveCount: number;
  mines: Map<string, Mine>;
  groundEffects: GroundEffect[];
  campRespawnAt: Record<string, number>;
  fx: FxEvent[];
  seq: number;
  rngState: number;
}

/** Advance the world RNG (mulberry32). Mutates rngState; returns [0,1). */
/* oxlint-disable no-bitwise, unicorn/prefer-math-trunc -- mulberry32 is int32 mixing; `| 0` wraps, it does not truncate */
export const rand = (w: World) => {
  let s = w.rngState | 0;
  s = (s + 0x6d_2b_79_f5) | 0;
  let t = Math.imul(s ^ (s >>> 15), 1 | s);
  t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
  w.rngState = s;

  return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
};
/* oxlint-enable no-bitwise, unicorn/prefer-math-trunc */

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
  effect: string;
  x: number;
  y: number;
  radius: number;
  until: number;
  nextTick: number;
  tickInterval: number;
  enemyDps?: number;
  dtype?: DamageType;
  slowPct?: number;
  allyHealPerTick?: number;
  allyManaPerTick?: number;
  cleanse?: boolean;
  burnDps?: number;
  burnDuration?: number;
  followOwner?: boolean;
  channel?: boolean;
  detonate?: { dmg: number; amp: number; burnDps: number; burnDur: number };
};

export const nextId = (w: World, prefix: string) => {
  w.seq += 1;

  return `${prefix}${w.seq}`;
};
