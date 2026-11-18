import type { DamageType, Team } from "../data/config";

export type AbilityKey = "Q" | "W" | "E" | "R" | "DASH" | "JUMP";

export const ABILITY_KEYS: AbilityKey[] = ["Q", "W", "E", "R"];
export const ALL_ABILITY_KEYS: AbilityKey[] = ["Q", "W", "E", "R", "DASH", "JUMP"];

export type GamePhase = "lobby" | "playing" | "ended";

export type UnitKind = "hero" | "boss" | "dummy" | "creep" | "prop";

export type AbilitySlot = {
  rank: number;
  readyAt: number;
};

export type Status =
  | { kind: "stun"; until: number; id?: string }
  | { kind: "root"; until: number; id?: string }
  | { kind: "silence"; until: number; id?: string }
  | { kind: "slow"; until: number; pct: number; id?: string }
  | { kind: "speed"; until: number; pct: number; id?: string }
  | {
      kind: "dot";
      until: number;
      nextTick: number;
      dps: number;
      dtype: DamageType;
      sourceId: string;
      id?: string;
    }
  | { kind: "heal"; until: number; nextTick: number; hps: number; id?: string }
  | { kind: "shield"; until: number; amount: number; id?: string }
  | { kind: "stealth"; until: number; id?: string }
  | { kind: "untargetable"; until: number; id?: string }
  | { kind: "unstoppable"; until: number; id?: string }
  | { kind: "armor"; until: number; amount: number; id?: string }
  | { kind: "attackSpeed"; until: number; amount: number; id?: string }
  | { kind: "damageAmp"; until: number; pct: number; id?: string }
  | { kind: "taunt"; until: number; sourceId: string; id?: string }
  | { kind: "hex"; until: number; pct: number; id?: string };

export type Unit = {
  id: string;
  kind: UnitKind;
  team: Team;
  ownerId: string;
  champId: string;
  isBot: boolean;
  name: string;
  slot: number;
  campId?: string;
  homeX?: number;
  homeY?: number;

  x: number;
  y: number;
  vx: number;
  vy: number;
  facing: number;
  radius: number;
  alive: boolean;

  hp: number;
  maxHp: number;
  hpRegen: number;

  baseDamage: number;
  armor: number;
  magicResist: number;
  attackType: "melee" | "ranged";
  attackKind: string;
  attackDamageType: DamageType;
  attackRange: number;
  attackSpeed: number;
  moveSpeed: number;
  projectileSpeed: number;
  abilityPower: number;
  lifesteal: number;
  attr: { str: number; agi: number; int: number };

  level: number;
  xp: number;
  gold: number;
  abilities: Record<AbilityKey, AbilitySlot>;
  items: string[];
  itemReadyAt: Record<string, number>;

  lastAttackAt: number;
  swingCount: number;
  lastCastAt: number;
  lastCastKey: AbilityKey | "";
  lastHitAt: number;
  lastHitDx: number;
  lastHitDy: number;
  pendingAttack: { resolveAt: number } | null;
  statuses: Status[];
  recentDamageFrom: Record<string, number>;

  queuedCast: {
    key: AbilityKey;
    px: number;
    py: number;
    ax: number;
    ay: number;
    until: number;
  } | null;

  steerVx: number;
  steerVy: number;

  moveX: number;
  moveY: number;
  aimX: number;
  aimY: number;
  attackHeld: boolean;

  kbx: number;
  kby: number;
  kbUntil: number;

  dashUntil: number;
  dashVx: number;
  dashVy: number;
  empowerNext: number;
  ambush: boolean;

  jumpUntil: number;

  respawnAt: number;

  kills: number;
  deaths: number;
  assists: number;
  killStreak: number;

  mercy: number;
};

export type ProjectileHit =
  | { tag: "none" }
  | { tag: "slow"; pct: number; duration: number }
  | { tag: "root"; duration: number }
  | { tag: "burn"; dps: number; duration: number };

export type Projectile = {
  id: string;
  ownerId: string;
  team: Team;
  x: number;
  y: number;
  vx: number;
  vy: number;
  speed: number;
  targetId: string | null;
  damage: number;
  dtype: DamageType;
  radius: number;
  hitRadius: number;
  pierce: boolean;
  isAttack: boolean;
  hitIds: string[];
  range: number;
  burstAtEnd?: boolean;
  traveled: number;
  kind: string;
  onHit: ProjectileHit;
  /** RENDER-ONLY extra launch height (world units above the normal projectile
   *  plane), 0 for everything fired from the ground. An aerial volley is loosed
   *  from the apex of a hop, so its shots must LEAVE from up there and fall to
   *  the plane — otherwise the arrows squirt out from under the airborne
   *  champion's feet. The sim stays flat: this never touches a hit test. */
  launchH: number;
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
  allyHps?: number;
  dtype?: DamageType;
  slowPct?: number;
  slowMs?: number;
  rootMs?: number;
  stunMs?: number;
  hexMs?: number;
  detonateAt?: number;
  detonateDmg?: number;
  detonateDtype?: DamageType;
  telegraph?: boolean;
};

export type PendingStrike = {
  at: number;
  casterId: string;
  key: AbilityKey;
  dx: number;
  dy: number;
  px: number;
  py: number;
  ox: number;
  oy: number;
  targetId?: string;
};

export type Coin = {
  id: string;
  x: number;
  y: number;
  fromX: number;
  fromY: number;
  gold: number;
  landAt: number;
  expireAt: number;
  loot?: boolean;
};

export type Delivery = {
  id: string;
  x: number;
  y: number;
  expireAt: number;
};

export type BossState = {
  x: number;
  y: number;
  hp: number;
  maxHp: number;
  alive: boolean;
};

export type FxEvent =
  | {
      t: "hit";
      x: number;
      y: number;
      dx: number;
      dy: number;
      dtype: DamageType;
      by: string;
      to: string;
      amount: number;
      crit?: boolean;
    }
  | { t: "swing"; x: number; y: number; ang: number; r: number; melee: boolean; dtype: DamageType }
  | { t: "strike"; tag: string; x: number; y: number; dx: number; dy: number; r: number }
  | {
      t: "cast";
      x: number;
      y: number;
      dx: number;
      dy: number;
      champId: string;
      key: AbilityKey;
      /** Accepted caster unit; absent in older FX snapshots. */
      unitId?: string;
    }
  | { t: "death"; x: number; y: number; team: Team; by: string }
  | { t: "propBreak"; x: number; y: number; model: string; explosive?: boolean }
  | { t: "itemUse"; x: number; y: number; item: string }
  | {
      t: "kill";
      killer: string;
      victim: string;
      killerName: string;
      victimName: string;
      leader?: boolean;
    }
  | { t: "coinGrab"; x: number; y: number; gold: number }
  | { t: "coinThrow"; x: number; y: number; tx: number; ty: number }
  | { t: "delivery"; x: number; y: number; tier: string; playerName: string }
  | { t: "levelup"; x: number; y: number }
  | { t: "explosion"; x: number; y: number; radius: number; kind: string }
  | { t: "fizzle"; x: number; y: number; kind: string }
  | { t: "blink"; x: number; y: number; tx: number; ty: number }
  | { t: "heal"; x: number; y: number; amount: number }
  | { t: "perfectDodge"; x: number; y: number; unit: string }
  | { t: "notify"; text: string; kind: string };

export interface World {
  now: number;
  gameTime: number;
  phase: GamePhase;
  winner: Team | null;
  killGoal: number;
  matchTime: number;
  suddenDeath: boolean;

  units: Map<string, Unit>;
  projectiles: Map<string, Projectile>;
  grounds: GroundEffect[];
  strikes: PendingStrike[];
  coins: Coin[];
  deliveries: Delivery[];
  boss: BossState;

  leaderId: Team | null;
  nextCoinAt: number;
  nextDeliveryAt: number;
  campRespawnAt: Record<string, number>;
  soloMercy?: boolean;

  fx: FxEvent[];
  seq: number;
  rngState: number;
}

/** Monotonic id within a World. */
export const nextId = (w: World, prefix: string) => {
  w.seq += 1;

  return `${prefix}${w.seq}`;
};
