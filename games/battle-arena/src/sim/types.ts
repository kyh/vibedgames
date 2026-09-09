// The authoritative World and every entity in it. Plain serializable data
// (Maps + plain objects + an int rngState) so encodeWorld is just Map→record.
// No engine imports — the sim is engine-agnostic and testable headless.
import type { DamageType, Team } from "../data/config";

// Q/W/E = number-key skills 1/2/3, R = ultimate (4). DASH (Shift) + JUMP
// (Space+click leaping strike) are cooldown abilities too — they ride the same
// cast/cooldown/snapshot machinery but are FLAT (maxRank 1, not level-ranked).
export type AbilityKey = "Q" | "W" | "E" | "R" | "DASH" | "JUMP";
// The four LEVELLED slots: number input, rank sync, HUD rank pips, R-lock.
export const ABILITY_KEYS: AbilityKey[] = ["Q", "W", "E", "R"];
// All six slots: ability-Record init, HUD cooldown sweep, clip lookup, bot
// cast loop, net-intent key guard, touch buttons.
export const ALL_ABILITY_KEYS: AbilityKey[] = ["Q", "W", "E", "R", "DASH", "JUMP"];

export type GamePhase = "lobby" | "playing" | "ended";
// "prop" = a destructible fixture (barrel/crate/keg — data/props.ts): it rides
// the unit pipeline so every damage path can break it, but never moves, acts,
// or shows up to AI/economy/HUD (their filters are hero/creep opt-in).
export type UnitKind = "hero" | "boss" | "dummy" | "creep" | "prop";

// oxlint-disable-next-line typescript/consistent-type-definitions -- type alias keeps the implicit index signature JsonValue needs
export type AbilitySlot = {
  rank: number;
  readyAt: number;
  // readyAt in ms
};

// ── Status effects ───────────────────────────────────────────────────────────
// Flat per-unit list; each has an `until` (ms). `id` dedupes refreshable sources
// (re-applying the same (kind,id) refreshes rather than stacks).
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
  // +pct points
  | { kind: "attackSpeed"; until: number; amount: number; id?: string }
  | { kind: "damageAmp"; until: number; pct: number; id?: string }
  | { kind: "taunt"; until: number; sourceId: string; id?: string }
  // polymorph (witch R): can't attack or cast, move-slowed by pct. Cleansable.
  | { kind: "hex"; until: number; pct: number; id?: string };

// ── Unit ─────────────────────────────────────────────────────────────────────
// oxlint-disable-next-line typescript/consistent-type-definitions -- type alias keeps the implicit index signature JsonValue needs
export type Unit = {
  id: string;
  kind: UnitKind;
  // playerId in FFA; "neutral" for the boss
  team: Team;
  // connection id for a human hero, "bot:N" for a bot, "neutral" for boss
  ownerId: string;
  champId: string;
  isBot: boolean;
  name: string;
  // base/spawn slot (stable; survives movement)
  slot: number;
  // neutral creep (skeleton camp) leashing — undefined for heroes
  campId?: string;
  homeX?: number;
  homeY?: number;

  x: number;
  y: number;
  vx: number;
  vy: number;
  // radians, look/aim direction
  facing: number;
  radius: number;
  alive: boolean;

  hp: number;
  maxHp: number;
  hpRegen: number;

  // derived combat stats (recomputed on level/item change in stats.ts)
  baseDamage: number;
  armor: number;
  // fraction 0..1
  magicResist: number;
  attackType: "melee" | "ranged";
  // projectile visual for ranged; "melee" for melee
  attackKind: string;
  attackDamageType: DamageType;
  attackRange: number;
  // attacks/sec
  attackSpeed: number;
  // units/sec
  moveSpeed: number;
  projectileSpeed: number;
  // additive fraction to ability damage (from items)
  abilityPower: number;
  // additive fraction (from items)
  lifesteal: number;
  attr: { str: number; agi: number; int: number };

  // progression
  level: number;
  xp: number;
  gold: number;
  abilities: Record<AbilityKey, AbilitySlot>;
  items: string[];
  // active-item cooldowns (ms)
  itemReadyAt: Record<string, number>;

  // combat runtime
  lastAttackAt: number;
  // total basic swings started (cycles the per-champ rhythm +
  swingCount: number;
  //                     picks the render swing clip; slow swings hit harder)
  // ms of last successful ability cast (drives the cast anim)
  lastCastAt: number;
  // which ability fired last (picks the cast clip)
  lastCastKey: AbilityKey | "";
  // ms this unit last took damage (drives the hit flash)
  lastHitAt: number;
  // normalized hit direction (attacker→victim) — render recoil
  lastHitDx: number;
  lastHitDy: number;
  // a swing/shot in its wind-up
  pendingAttack: { resolveAt: number } | null;
  statuses: Status[];
  // attackerId -> ms (assist credit)
  recentDamageFrom: Record<string, number>;

  // input buffering — a cast pressed slightly too early fires the moment it
  // becomes legal (drained in step() each tick; plain data → rides snapshots)
  queuedCast: {
    key: AbilityKey;
    px: number;
    py: number;
    ax: number;
    ay: number;
    until: number;
  } | null;

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
  // flat bonus damage on the next basic attack (Rogue W)
  empowerNext: number;
  // swing started FROM STEALTH → it crits for double (Rogue E)
  ambush: boolean;

  // jump/hop (Space) — a brief evasive bound; mostly visual, slight speed boost
  jumpUntil: number;

  // death / respawn
  // ms; 0 while alive
  respawnAt: number;

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

// oxlint-disable-next-line typescript/consistent-type-definitions -- type alias keeps the implicit index signature JsonValue needs
export type Projectile = {
  id: string;
  ownerId: string;
  team: Team;
  x: number;
  y: number;
  vx: number;
  vy: number;
  speed: number;
  // homing if set
  targetId: string | null;
  damage: number;
  dtype: DamageType;
  // splash radius (0 = single target)
  radius: number;
  // collision radius
  hitRadius: number;
  // pass through enemies (multishot, ranger basics)
  pierce: boolean;
  // basic attack → carries lifesteal/on-hit
  isAttack: boolean;
  // already-hit unit ids (for pierce)
  hitIds: string[];
  range: number;
  // splash projectile detonates at max range (aim-point casts)
  burstAtEnd?: boolean;
  traveled: number;
  // visual: "arrow" | "bolt" | "fireball" | ...
  kind: string;
  onHit: ProjectileHit;
  /** RENDER-ONLY extra launch height (world units above the normal projectile
   *  plane), 0 for everything fired from the ground. An aerial volley is loosed
   *  from the apex of a hop, so its shots must LEAVE from up there and fall to
   *  the plane — otherwise the arrows squirt out from under the airborne
   *  champion's feet. The sim stays flat: this never touches a hit test. */
  launchH: number;
};

// ── Ground effects (AoE zones, telegraphs, delayed nukes) ────────────────────
// oxlint-disable-next-line typescript/consistent-type-definitions -- type alias keeps the implicit index signature JsonValue needs
export type GroundEffect = {
  id: string;
  ownerId: string;
  team: Team;
  // logic/visual tag
  effect: string;
  x: number;
  y: number;
  radius: number;
  // ms
  until: number;
  // ms
  nextTick: number;
  // ms
  tickInterval: number;
  enemyDps?: number;
  // heal/s for the owner's side inside the zone (consecrate)
  allyHps?: number;
  dtype?: DamageType;
  slowPct?: number;
  // detonate rider: how long the slow lasts (default 1500)
  slowMs?: number;
  rootMs?: number;
  // detonate rider: stun everyone caught (smite)
  stunMs?: number;
  // detonate rider: polymorph everyone caught (grand hex)
  hexMs?: number;
  // delayed single nuke (meteor/smite/vines/nova): fires once at detonateAt
  detonateAt?: number;
  detonateDmg?: number;
  detonateDtype?: DamageType;
  // ground marker only until detonate
  telegraph?: boolean;
};

// ── Pending ability strikes ──────────────────────────────────────────────────
// Caster-relative ability damage scheduled for the moment the cast animation
// actually connects (or a jump-attack lands). Plain data — rides snapshots so
// a host migration can't drop a mid-swing strike. The hit shape re-tests at
// resolve time, so a scheduled strike is dodgeable.
// oxlint-disable-next-line typescript/consistent-type-definitions -- type alias keeps the implicit index signature JsonValue needs
export type PendingStrike = {
  // ms — when the blade/slam connects
  at: number;
  casterId: string;
  key: AbilityKey;
  // aim direction captured at cast (unit vector)
  dx: number;
  dy: number;
  // cast/landing point
  px: number;
  py: number;
  // caster position at cast — corridor/jump origin
  ox: number;
  oy: number;
  // single-target strikes (rogue R)
  targetId?: string;
};

// ── Signature-mechanic entities ──────────────────────────────────────────────
// oxlint-disable-next-line typescript/consistent-type-definitions -- type alias keeps the implicit index signature JsonValue needs
export type Coin = {
  id: string;
  x: number;
  y: number;
  fromX: number;
  fromY: number;
  gold: number;
  // ms; flying (telegraph arc) until then, claimable after
  landAt: number;
  // ms
  expireAt: number;
  // creep drop → renders as a weapon pickup (boss coins omit it)
  loot?: boolean;
};

// oxlint-disable-next-line typescript/consistent-type-definitions -- type alias keeps the implicit index signature JsonValue needs
export type Delivery = {
  id: string;
  x: number;
  y: number;
  // ms
  expireAt: number;
};

// oxlint-disable-next-line typescript/consistent-type-definitions -- type alias keeps the implicit index signature JsonValue needs
export type BossState = {
  x: number;
  y: number;
  hp: number;
  maxHp: number;
  alive: boolean;
};

// ── One-shot FX pulses (host → renderer; also forwarded over the wire) ───────
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
  // an ability's damage moment (tag = def.effect, or "spin" for the whirl
  // basic) — the impact layer fx, fired when the blade/slam actually connects
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
  // projectile died at max range, hit nothing
  | { t: "fizzle"; x: number; y: number; kind: string }
  | { t: "blink"; x: number; y: number; tx: number; ty: number }
  | { t: "heal"; x: number; y: number; amount: number }
  | { t: "perfectDodge"; x: number; y: number; unit: string }
  | { t: "notify"; text: string; kind: string };

// ── The World ────────────────────────────────────────────────────────────────
// oxlint-disable-next-line typescript/consistent-type-definitions -- type alias keeps the implicit index signature JsonValue needs
export type World = {
  // ms host clock
  now: number;
  // s since match start
  gameTime: number;
  phase: GamePhase;
  winner: Team | null;
  killGoal: number;
  // s
  matchTime: number;
  suddenDeath: boolean;

  units: Map<string, Unit>;
  projectiles: Map<string, Projectile>;
  grounds: GroundEffect[];
  strikes: PendingStrike[];
  coins: Coin[];
  deliveries: Delivery[];
  boss: BossState;

  // current scoreboard leader (for bounty)
  leaderId: Team | null;
  // gameTime s
  nextCoinAt: number;
  // gameTime s
  nextDeliveryAt: number;
  // campId → gameTime to repopulate
  campRespawnAt: Record<string, number>;
  // offline-only opt-in: enables the hidden mercy scaling
  soloMercy?: boolean;

  // drained by renderer each frame
  fx: FxEvent[];
  // id counter
  seq: number;
  // mulberry32 state
  rngState: number;
};

/** Monotonic id within a World. */
export const nextId = (w: World, prefix: string): string => {
  w.seq += 1;
  return `${prefix}${w.seq}`;
};
