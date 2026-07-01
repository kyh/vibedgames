// The authoritative World and every entity in it. Plain serializable data
// (Maps + plain objects + an int rngState) so encodeWorld is just Map→record.
// No engine imports — the sim is engine-agnostic and testable headless.
import type { DamageType, Team } from "../data/config";

export type AbilityKey = "Q" | "W" | "E" | "R";
export const ABILITY_KEYS: AbilityKey[] = ["Q", "W", "E", "R"];

export type GamePhase = "lobby" | "playing" | "ended";
export type UnitKind = "hero" | "boss" | "dummy" | "creep";

export type AbilitySlot = { rank: number; readyAt: number }; // readyAt in ms

// ── Status effects ───────────────────────────────────────────────────────────
// Flat per-unit list; each has an `until` (ms). `id` dedupes refreshable sources
// (re-applying the same (kind,id) refreshes rather than stacks).
export type Status =
  | { kind: "stun"; until: number; id?: string }
  | { kind: "root"; until: number; id?: string }
  | { kind: "silence"; until: number; id?: string }
  | { kind: "slow"; until: number; pct: number; id?: string }
  | { kind: "speed"; until: number; pct: number; id?: string }
  | { kind: "dot"; until: number; nextTick: number; dps: number; dtype: DamageType; sourceId: string; id?: string }
  | { kind: "heal"; until: number; nextTick: number; hps: number; id?: string }
  | { kind: "shield"; until: number; amount: number; id?: string }
  | { kind: "stealth"; until: number; id?: string }
  | { kind: "untargetable"; until: number; id?: string }
  | { kind: "unstoppable"; until: number; id?: string }
  | { kind: "armor"; until: number; amount: number; id?: string }
  | { kind: "attackSpeed"; until: number; amount: number; id?: string } // +pct points
  | { kind: "damageAmp"; until: number; pct: number; id?: string }
  | { kind: "taunt"; until: number; sourceId: string; id?: string }
  // polymorph (witch R): can't attack or cast, move-slowed by pct. Cleansable.
  | { kind: "hex"; until: number; pct: number; id?: string };

// ── Unit ─────────────────────────────────────────────────────────────────────
export type Unit = {
  id: string;
  kind: UnitKind;
  team: Team; // playerId in FFA; "neutral" for the boss
  ownerId: string; // connection id for a human hero, "bot:N" for a bot, "neutral" for boss
  champId: string;
  isBot: boolean;
  name: string;
  slot: number; // base/spawn slot (stable; survives movement)
  // neutral creep (skeleton camp) leashing — undefined for heroes
  campId?: string;
  homeX?: number;
  homeY?: number;

  x: number;
  y: number;
  vx: number;
  vy: number;
  facing: number; // radians, look/aim direction
  radius: number;
  alive: boolean;

  hp: number;
  maxHp: number;
  hpRegen: number;

  // derived combat stats (recomputed on level/item change in stats.ts)
  baseDamage: number;
  armor: number;
  magicResist: number; // fraction 0..1
  attackType: "melee" | "ranged";
  attackKind: string; // projectile visual for ranged; "melee" for melee
  attackDamageType: DamageType;
  attackRange: number;
  attackSpeed: number; // attacks/sec
  moveSpeed: number; // units/sec
  projectileSpeed: number;
  abilityPower: number; // additive fraction to ability damage (from items)
  lifesteal: number; // additive fraction (from items)
  attr: { str: number; agi: number; int: number };

  // progression
  level: number;
  xp: number;
  gold: number;
  abilities: Record<AbilityKey, AbilitySlot>;
  items: string[];
  itemReadyAt: Record<string, number>; // active-item cooldowns (ms)

  // combat runtime
  lastAttackAt: number;
  lastCastAt: number; // ms of last successful ability cast (drives the cast anim)
  lastCastKey: AbilityKey | ""; // which ability fired last (picks the cast clip)
  lastHitAt: number; // ms this unit last took damage (drives the hit flash)
  lastHitDx: number; // normalized hit direction (attacker→victim) — render recoil
  lastHitDy: number;
  pendingAttack: { resolveAt: number } | null; // a swing/shot in its wind-up
  statuses: Status[];
  recentDamageFrom: Record<string, number>; // attackerId -> ms (assist credit)

  // input buffering — a cast/dodge pressed slightly too early fires the moment
  // it becomes legal (drained in step() each tick; plain data → rides snapshots)
  queuedCast: { key: AbilityKey; px: number; py: number; ax: number; ay: number; until: number } | null;
  queuedDodge: { mx: number; my: number; until: number } | null;

  // steering velocity with accel/decel smoothing (movement reads/writes this;
  // dashes write it directly, knockback stacks on top)
  steerVx: number;
  steerVy: number;

  // input intent (host writes from intents each frame)
  moveX: number;
  moveY: number;
  aimX: number;
  aimY: number;
  attackHeld: boolean;

  // knockback impulse (decays to 0 by kbUntil)
  kbx: number;
  kby: number;
  kbUntil: number;

  // dash (movement-overriding burst)
  dashUntil: number;
  dashVx: number;
  dashVy: number;
  empowerNext: number; // flat bonus damage on the next basic attack (Rogue W)

  // jump/hop (Space) — a brief evasive bound; mostly visual, slight speed boost
  jumpUntil: number;

  // dodge-roll (Shift) — rolls via the dash channel but keeps aim-facing; grants
  // brief i-frames (untargetable). dodgeUntil marks the roll, lastDodgeAt drives
  // the render clip, dodgeReadyAt is the cooldown gate.
  dodgeUntil: number;
  dodgeReadyAt: number;
  lastDodgeAt: number;

  // death / respawn
  respawnAt: number; // ms; 0 while alive

  // scoring
  kills: number;
  deaths: number;
  assists: number;
  killStreak: number;

  // hidden solo mercy (0–3): bot→human damage softens while a kill-less human
  // keeps dying (only active when World.soloMercy; never announced)
  mercy: number;
};

// ── Projectile ───────────────────────────────────────────────────────────────
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
  targetId: string | null; // homing if set
  damage: number;
  dtype: DamageType;
  radius: number; // splash radius (0 = single target)
  hitRadius: number; // collision radius
  pierce: boolean; // pass through enemies (multishot)
  isAttack: boolean; // basic attack → carries lifesteal/on-hit
  hitIds: string[]; // already-hit unit ids (for pierce)
  range: number;
  traveled: number;
  kind: string; // visual: "arrow" | "bolt" | "fireball" | ...
  onHit: ProjectileHit;
};

// ── Ground effects (AoE zones, telegraphs, delayed nukes) ────────────────────
export type GroundEffect = {
  id: string;
  ownerId: string;
  team: Team;
  effect: string; // logic/visual tag
  x: number;
  y: number;
  radius: number;
  until: number; // ms
  nextTick: number; // ms
  tickInterval: number; // ms
  enemyDps?: number;
  allyHps?: number; // heal/s for the owner's side inside the zone (consecrate)
  dtype?: DamageType;
  slowPct?: number;
  rootMs?: number;
  // delayed single nuke (meteor): fires once at detonateAt
  detonateAt?: number;
  detonateDmg?: number;
  detonateDtype?: DamageType;
  telegraph?: boolean; // ground marker only until detonate
};

// ── Signature-mechanic entities ──────────────────────────────────────────────
export type Coin = {
  id: string;
  x: number;
  y: number;
  fromX: number;
  fromY: number;
  gold: number;
  landAt: number; // ms; flying (telegraph arc) until then, claimable after
  expireAt: number; // ms
};

export type Delivery = {
  id: string;
  x: number;
  y: number;
  expireAt: number; // ms
};

export type BossState = {
  x: number;
  y: number;
  hp: number;
  maxHp: number;
  alive: boolean;
};

// ── One-shot FX pulses (host → renderer; also forwarded over the wire) ───────
export type FxEvent =
  | { t: "hit"; x: number; y: number; dx: number; dy: number; dtype: DamageType; by: string; to: string; crit?: boolean }
  | { t: "swing"; x: number; y: number; ang: number; r: number; melee: boolean; dtype: DamageType }
  | { t: "damage"; x: number; y: number; amount: number; dtype: DamageType; by: string; crit?: boolean }
  | { t: "cast"; x: number; y: number; dx: number; dy: number; champId: string; key: AbilityKey }
  | { t: "death"; x: number; y: number; team: Team; by: string }
  | { t: "itemUse"; x: number; y: number; item: string }
  | { t: "kill"; killer: string; victim: string; killerName: string; victimName: string; leader?: boolean }
  | { t: "coinGrab"; x: number; y: number; gold: number }
  | { t: "coinThrow"; x: number; y: number; tx: number; ty: number }
  | { t: "delivery"; x: number; y: number; tier: string; playerName: string }
  | { t: "levelup"; x: number; y: number }
  | { t: "explosion"; x: number; y: number; radius: number; kind: string }
  | { t: "blink"; x: number; y: number; tx: number; ty: number }
  | { t: "heal"; x: number; y: number; amount: number }
  | { t: "perfectDodge"; x: number; y: number; unit: string }
  | { t: "notify"; text: string; kind: string };

// ── The World ────────────────────────────────────────────────────────────────
export type World = {
  now: number; // ms host clock
  gameTime: number; // s since match start
  phase: GamePhase;
  winner: Team | null;
  killGoal: number;
  matchTime: number; // s
  suddenDeath: boolean;

  units: Map<string, Unit>;
  projectiles: Map<string, Projectile>;
  grounds: GroundEffect[];
  coins: Coin[];
  deliveries: Delivery[];
  boss: BossState;

  leaderId: Team | null; // current scoreboard leader (for bounty)
  nextCoinAt: number; // gameTime s
  nextDeliveryAt: number; // gameTime s
  campRespawnAt: Record<string, number>; // campId → gameTime to repopulate
  soloMercy?: boolean; // offline-only opt-in: enables the hidden mercy scaling

  fx: FxEvent[]; // drained by renderer each frame
  seq: number; // id counter
  rngState: number; // mulberry32 state
};

/** Monotonic id within a World. */
export function nextId(w: World, prefix: string): string {
  w.seq += 1;
  return `${prefix}${w.seq}`;
}
