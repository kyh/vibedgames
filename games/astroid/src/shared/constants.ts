// ---- world -------------------------------------------------------------------

export const WORLD_W = 3840;
export const WORLD_H = 2160;

// All speeds are px/second (the legacy build used px/tick at 60Hz; ×60 here).

// ---- ship (drift model) ---------------------------------------------------------

export const SHIP_RADIUS = 8;
/** Thrust toward the cursor, px/s². */
export const SHIP_ACCEL = 540;
/** Exponential drag while flying: v *= exp(-DRAG·dt). 1/s. */
export const SHIP_DRAG = 1.8;
/** Heavier drag inside the dead zone — stopping faster than starting. 1/s. */
export const SHIP_BRAKE_DRAG = 4.0;
/** = ACCEL/DRAG; also hard-clamps |v|. */
export const SHIP_MAX_SPEED = 300;
/** No thrust inside this cursor distance (3× SHIP_RADIUS). */
export const SHIP_DEAD_ZONE = 24;
/** Thrust scales 0→1 over DEAD_ZONE..DEAD_ZONE+RAMP px for fine control. */
export const SHIP_THRUST_RAMP = 96;
/** Dart hull: 4 points at these angles, radius SHIP_RADIUS except the notched
 *  180° point at half radius. */
export const SHIP_HULL_DEG = [0, 140, 180, 220] as const;

export const RESPAWN_DELAY_MS = 2_500;
export const INVULNERABLE_MS = 2_000;
/** Invulnerability blink: alpha alternates 0.3/0.9 on this period. */
export const INVULN_BLINK_MS = 200;
/** Respawn keeps this far from the world edges. */
export const RESPAWN_EDGE_MARGIN = 300;
/** Respawn re-rolls until this far from every enemy + big asteroid. */
export const RESPAWN_CLEARANCE = 700;
export const RESPAWN_ATTEMPTS = 8;
/** Asteroids smaller than this don't block a respawn point. */
export const RESPAWN_ASTEROID_MIN_R = 30;

// ---- intensity director (§2) -----------------------------------------------------

/** 90s build→peak→breather wave on a slow ramp; all clients agree given the
 *  shared arenaEpoch. Troughs at t=0,90,…; peaks at t=45,135,… */
export function arenaIntensity(tSec: number): number {
  const raw = (1 + tSec / 180) * (0.7 + 0.5 * Math.sin((2 * Math.PI * (tSec - 22.5)) / 90));
  return Math.min(2.6, Math.max(0.2, raw));
}

/** Multiplayer pressure scale P(N). */
export function playerPressure(playerCount: number): number {
  return Math.min(1.75, Math.max(1.0, 0.75 + 0.25 * playerCount));
}

export function asteroidCap(intensity: number, pressure: number): number {
  return Math.min(32, Math.round((6 + 11 * intensity) * pressure));
}

export function asteroidSpawnIntervalMs(intensity: number): number {
  return Math.min(4000, Math.max(300, 1500 / intensity));
}

export function enemyCap(intensity: number, pressure: number): number {
  return Math.min(22, Math.round((2 + 6.5 * intensity) * pressure));
}

export function enemySpawnIntervalMs(intensity: number): number {
  return Math.min(8000, Math.max(700, 2100 / intensity));
}

/** Host seeds this many asteroids at arena start (don't wait for the interval). */
export const ASTEROID_SEED_COUNT = 7;

// ---- asteroids ----------------------------------------------------------------

export const ASTEROID_MAX_RADIUS = 80;
export const ASTEROID_MIN_RADIUS = 5;
export const ASTEROID_VERTEX_COUNT = 12;
export const ASTEROID_ROT_SPEED = 0.3; // rad/s
/** Removed once this far past the world edge. */
export const ASTEROID_CULL_MARGIN = ASTEROID_MAX_RADIUS + 20;

/** Size-inverse speed retune: 36 px/s (r=80) … 171 px/s (r=5). */
export function asteroidSpeed(radius: number): number {
  return ((1 - radius / ASTEROID_MAX_RADIUS) * 1.6 + 0.4) * 90;
}

// ---- UFO ----------------------------------------------------------------------

export const UFO_SPEED = 120;
/** Spawn probability per second (gated on no weapon items in flight). */
export const UFO_SPAWN_RATE = 0.21;
export const UFO_RADIUS = 15;
export const UFO_HP = 100;
/** Damage flicker duration (legacy 40 ticks). */
export const UFO_BLINK_MS = 667;

// ---- items --------------------------------------------------------------------

export const ITEM_SPEED = 30;
export const ITEM_LIFETIME_MS = 30_000;
export const ITEM_PICKUP_RADIUS = 15;
export const ITEM_DRAW_RADIUS = 10;
export const SPECIAL_WEAPON_DURATION_MS = 20_000;
/** v3 stacking: picking up the SAME item you already hold EXTENDS its timer
 *  (weapon +20s, shield mod +20s, booster +its duration) instead of
 *  replacing; the extended expiry never reaches past now + this cap. */
export const ITEM_STACK_CAP_MS = 60_000;

// ---- score shards (v3 universal drops) ---------------------------------------------

// Lightweight pickup: tiny wireframe crystal, +5 score, drifts slowly, dies
// in 8 sec. Lives in sharedState.shards, a SEPARATE capped array, so the
// item-in-flight cap (ITEMS_MAX_LIVE = 6) is unaffected.
export const SHARD_SCORE = 5;
export const SHARD_LIFETIME_MS = 8_000;
/** Generous pickup radius (items are 15): shards are hoover candy. */
export const SHARD_PICKUP_RADIUS = 40;
export const SHARD_DRIFT_SPEED = 18;
/** Host cap; oldest culled past it (one swarm wipe can't flood the wire). */
export const SHARDS_MAX_LIVE = 48;
export const SHARD_TINT = 0x9ffce8;
/** MAGNET pulls shards harder than items (140). */
export const SHARD_MAGNET_PULL_SPEED = 320;
/** Fodder kills always drop 1-2 shards. */
export const FODDER_SHARD_MIN = 1;
export const FODDER_SHARD_MAX = 2;

/** Asteroid destroys drop shards scaled by radius: ~radius/15, 1..5. */
export function asteroidShardCount(radius: number): number {
  return Math.max(1, Math.min(5, Math.round(radius / 15)));
}

// ---- scoring + combo (§8) -------------------------------------------------------

export const SCORE = {
  /** Flat per chip hit, never multiplied. */
  ASTEROID_CHIP: 5,
  ASTEROID_DESTROY: 30,
  DRONE: 25,
  WASP: 60,
  SPLITTER: 80,
  LANCER: 100,
  UFO_DESTROY: 300,
  PLAYER_KILL: 250,
} as const;

/** Kill-streak window; refreshed per kill, hard reset on expiry/death. */
export const COMBO_WINDOW_MS = 4_000;

export function comboMult(streak: number): number {
  return streak >= 15 ? 5 : streak >= 10 ? 4 : streak >= 6 ? 3 : streak >= 3 ? 2 : 1;
}

// ---- weapons (§4) ----------------------------------------------------------------

export type WeaponSfx =
  | "pulse"
  | "rapid"
  | "heavy"
  | "zap"
  | "boom"
  | "scatter"
  | "seek"
  | "arc"
  | "glaive"
  | "rail"
  | "mine"
  | "nova"
  | "drill"
  | "plasma"
  | "tesla"
  | "sentry"
  | "singularity";

export type Weapon = {
  name: string;
  /** Damage fraction: asteroids chip min(power,1)×80 px radius; HP targets
   *  (UFO, enemies, players) take power×100 HP. */
  power: number;
  speed: number; // px/s (0 = hitscan, see `arc`)
  length: number; // px
  width: number; // px
  tint: number;
  intervalMs: number;
  /** Laser-style: beam survives hits and passes through targets. */
  through: boolean;
  /** On hit, becomes an expanding circle (growth px/s up to range px). */
  explosion: { range: number; growth: number } | null;
  /** Pellets per trigger pull, spread evenly across spreadDeg. */
  pellets: number;
  /** Total cone for pellets, degrees. */
  spreadDeg: number;
  /** Per-shot aim jitter, ± degrees. */
  jitterDeg: number;
  homing: { turnDegPerSec: number; acquireRange: number } | null;
  arc: { castRange: number; hopRange: number; jumps: number; falloff: number } | null;
  boomerang: { outRange: number; returnSpeed: number } | null;
  /** >0: holding fire charges; the shot releases at windup end; releasing
   *  mid-windup cancels. Auto-repeats while held (one-button identity). */
  windupMs: number;
  /** MINES: each trigger drops a stationary proximity mine at the tail. */
  mine: boolean;
  /** RICOCHET: bolt bounces off asteroids + world edges up to `bounces`
   *  times; each bounce re-aims at the nearest enemy/asteroid within
   *  retargetRange px (reflects off the surface when nothing is in range). */
  ricochet: { bounces: number; retargetRange: number } | null;
  /** FLAK: shell airbursts at burstDist px traveled (or on first hit) into
   *  `fragments` radial FLAK_FRAG_WEAPON beams that live fragRange px. */
  flak: { burstDist: number; fragments: number; fragRange: number } | null;
  /** CLUSTER: one trigger-pull launches `missiles` homing missiles (the
   *  weapon's own `homing` spec), staggered staggerMs apart. */
  cluster: { missiles: number; staggerMs: number } | null;
  /** Beam expires after traveling this many px (0 = unlimited). PLASMA's
   *  short stream and SINGULARITY's flight leg run on this. */
  range: number;
  /** PHASE LANCE: skip the asteroid hit-test entirely (ignores cover). */
  phasesRock: boolean;
  /** MIRROR: every volley also fires a copy backward (180 deg). */
  mirror: boolean;
  /** TESLA AURA: the arc cast is omnidirectional from the ship and silent
   *  when nothing is in castRange (no fizzle bolt). PvP runs victim-side
   *  off the serialized `tesla` flag (RAM pattern), never off the chain. */
  aura: boolean;
  /** SENTRY: each trigger places/moves the one turret and fires an owner
   *  bolt; the turret fires this same stat block every SENTRY_FIRE_MS. */
  sentry: boolean;
  /** SINGULARITY: at `range` (or first contact) the orb freezes, emits the
   *  shared pull for SINGULARITY_PULL_MS, then pops its `explosion`. */
  singularity: boolean;
  sfx: WeaponSfx;
};

export const WEAPON_DEFAULT: Weapon = {
  name: "NORMAL BEAM",
  power: 0.25,
  speed: 520,
  length: 12,
  width: 1,
  tint: 0xffffff,
  intervalMs: 250,
  through: false,
  explosion: null,
  pellets: 1,
  spreadDeg: 0,
  jitterDeg: 1,
  homing: null,
  arc: null,
  boomerang: null,
  windupMs: 0,
  mine: false,
  ricochet: null,
  flak: null,
  cluster: null,
  range: 0,
  phasesRock: false,
  mirror: false,
  aura: false,
  sentry: false,
  singularity: false,
  sfx: "pulse",
};

export const WEAPONS_SPECIAL: Weapon[] = [
  {
    name: "TINY BEAM",
    power: 0.14,
    speed: 700,
    length: 6,
    width: 1,
    tint: 0x83e008,
    intervalMs: 70,
    through: false,
    explosion: null,
    pellets: 1,
    spreadDeg: 0,
    jitterDeg: 3,
    homing: null,
    arc: null,
    boomerang: null,
    windupMs: 0,
    mine: false,
    ricochet: null,
    flak: null,
    cluster: null,
    range: 0,
    phasesRock: false,
    mirror: false,
    aura: false,
    sentry: false,
    singularity: false,
    sfx: "rapid",
  },
  {
    name: "BLASTER",
    power: 0.9,
    speed: 380, // every projectile ≥360 px/s vs ship max 300 (design floor)
    length: 16,
    width: 3,
    tint: 0xf4007a,
    intervalMs: 450,
    through: false,
    explosion: null,
    pellets: 1,
    spreadDeg: 0,
    jitterDeg: 0,
    homing: null,
    arc: null,
    boomerang: null,
    windupMs: 0,
    mine: false,
    ricochet: null,
    flak: null,
    cluster: null,
    range: 0,
    phasesRock: false,
    mirror: false,
    aura: false,
    sentry: false,
    singularity: false,
    sfx: "heavy",
  },
  {
    name: "LASER",
    power: 0.3,
    speed: 2400,
    length: 220,
    width: 2,
    tint: 0x8ae3fc,
    intervalMs: 380,
    through: true,
    explosion: null,
    pellets: 1,
    spreadDeg: 0,
    jitterDeg: 0,
    homing: null,
    arc: null,
    boomerang: null,
    windupMs: 0,
    mine: false,
    ricochet: null,
    flak: null,
    cluster: null,
    range: 0,
    phasesRock: false,
    mirror: false,
    aura: false,
    sentry: false,
    singularity: false,
    sfx: "zap",
  },
  {
    name: "EXPLOSION BEAM",
    power: 0.22,
    speed: 900,
    length: 10,
    width: 2,
    tint: 0xff9900,
    intervalMs: 350,
    through: false,
    explosion: { range: 110, growth: 700 },
    pellets: 1,
    spreadDeg: 0,
    jitterDeg: 0,
    homing: null,
    arc: null,
    boomerang: null,
    windupMs: 0,
    mine: false,
    ricochet: null,
    flak: null,
    cluster: null,
    range: 0,
    phasesRock: false,
    mirror: false,
    aura: false,
    sentry: false,
    singularity: false,
    sfx: "boom",
  },
  {
    name: "SCATTER",
    power: 0.08,
    speed: 480,
    length: 7,
    width: 1,
    tint: 0xffd23e,
    intervalMs: 300,
    through: false,
    explosion: null,
    pellets: 6,
    spreadDeg: 36,
    jitterDeg: 2,
    homing: null,
    arc: null,
    boomerang: null,
    windupMs: 0,
    mine: false,
    ricochet: null,
    flak: null,
    cluster: null,
    range: 0,
    phasesRock: false,
    mirror: false,
    aura: false,
    sentry: false,
    singularity: false,
    sfx: "scatter",
  },
  {
    // v3.1 retune (power 0.45 -> 0.6): the single-target-burst niche.
    // effDPS: 60/0.55s = 109 raw x 0.95 reliability -> ~104 sustained, but
    // 60/hit one-shots fodder and two-cycles elites from the longest seeker
    // acquire range (420 vs CLUSTER's 380) - burst access, not sustain, is
    // the sell next to CLUSTER's crowd volley.
    name: "HOMING",
    power: 0.6,
    speed: 380,
    length: 9,
    width: 2,
    tint: 0xc084fc,
    intervalMs: 550,
    through: false,
    explosion: null,
    pellets: 1,
    spreadDeg: 0,
    jitterDeg: 0,
    homing: { turnDegPerSec: 220, acquireRange: 420 },
    arc: null,
    boomerang: null,
    windupMs: 0,
    mine: false,
    ricochet: null,
    flak: null,
    cluster: null,
    range: 0,
    phasesRock: false,
    mirror: false,
    aura: false,
    sentry: false,
    singularity: false,
    sfx: "seek",
  },
  {
    name: "ARC",
    power: 0.28,
    speed: 0, // hitscan
    length: 0,
    width: 1,
    tint: 0xfff066,
    intervalMs: 500,
    through: false,
    explosion: null,
    pellets: 1,
    spreadDeg: 0,
    jitterDeg: 0,
    homing: null,
    arc: { castRange: 380, hopRange: 240, jumps: 3, falloff: 0.7 },
    boomerang: null,
    windupMs: 0,
    mine: false,
    ricochet: null,
    flak: null,
    cluster: null,
    range: 0,
    phasesRock: false,
    mirror: false,
    aura: false,
    sentry: false,
    singularity: false,
    sfx: "arc",
  },
  {
    name: "GLAIVE",
    power: 0.35,
    speed: 540,
    length: 14,
    width: 2,
    tint: 0x2dd4bf,
    intervalMs: 700,
    through: true,
    explosion: null,
    pellets: 1,
    spreadDeg: 0,
    jitterDeg: 0,
    homing: null,
    arc: null,
    boomerang: { outRange: 320, returnSpeed: 700 },
    windupMs: 0,
    mine: false,
    ricochet: null,
    flak: null,
    cluster: null,
    range: 0,
    phasesRock: false,
    mirror: false,
    aura: false,
    sentry: false,
    singularity: false,
    sfx: "glaive",
  },
  {
    name: "RAILGUN",
    power: 1.3,
    speed: 2800,
    length: 320,
    width: 3,
    tint: 0xd946ef,
    intervalMs: 1100,
    through: true,
    explosion: null,
    pellets: 1,
    spreadDeg: 0,
    jitterDeg: 0,
    homing: null,
    arc: null,
    boomerang: null,
    windupMs: 700,
    mine: false,
    ricochet: null,
    flak: null,
    cluster: null,
    range: 0,
    phasesRock: false,
    mirror: false,
    aura: false,
    sentry: false,
    singularity: false,
    sfx: "rail",
  },
  {
    name: "MINES",
    power: 0.7,
    speed: 0,
    length: 0,
    width: 1,
    tint: 0xf59e0b,
    intervalMs: 700,
    through: false,
    explosion: { range: 90, growth: 700 },
    pellets: 1,
    spreadDeg: 0,
    jitterDeg: 0,
    homing: null,
    arc: null,
    boomerang: null,
    windupMs: 0,
    mine: true,
    ricochet: null,
    flak: null,
    cluster: null,
    range: 0,
    phasesRock: false,
    mirror: false,
    aura: false,
    sentry: false,
    singularity: false,
    sfx: "mine",
  },
  {
    name: "NOVA",
    power: 0.38,
    speed: 0,
    length: 0,
    width: 1,
    tint: 0x60a5fa,
    intervalMs: 900,
    through: false,
    explosion: { range: 140, growth: 900 },
    pellets: 1,
    spreadDeg: 0,
    jitterDeg: 0,
    homing: null,
    arc: null,
    boomerang: null,
    windupMs: 0,
    mine: false,
    ricochet: null,
    flak: null,
    cluster: null,
    range: 0,
    phasesRock: false,
    mirror: false,
    aura: false,
    sentry: false,
    singularity: false,
    sfx: "nova",
  },
  // ---- v3 weapons #12-15 (effDPS method per v1 4.3, target band ~135-165) ----
  {
    // RICOCHET: bounces off asteroids + world edges up to 3x; each bounce
    // re-aims at the nearest enemy/asteroid within 400px.
    // effDPS: raw 35/0.42s = 83 x avgTargets 1.8 (bounce chain) x 0.95
    // reliability (re-aim) -> ~142. Pays via indirection: the bolt spends
    // travel time between bounces and dies on any non-asteroid hit.
    name: "RICOCHET",
    power: 0.35,
    speed: 560,
    length: 12,
    width: 2,
    tint: 0x00ff7f, // spring green
    intervalMs: 420,
    through: false,
    explosion: null,
    pellets: 1,
    spreadDeg: 0,
    jitterDeg: 1,
    homing: null,
    arc: null,
    boomerang: null,
    windupMs: 0,
    mine: false,
    ricochet: { bounces: 3, retargetRange: 400 },
    flak: null,
    cluster: null,
    range: 0,
    phasesRock: false,
    mirror: false,
    aura: false,
    sentry: false,
    singularity: false,
    sfx: "pulse",
  },
  {
    // FLAK: shell airbursts at 280px traveled (or on first hit) into 8
    // radial fragments (FLAK_FRAG_WEAPON, 12 dmg, 160px range each).
    // effDPS: (45 shell + ~2.5 connecting frags x 12 = 75)/0.65s = 115 raw
    // x 1.3 avgTargets (radial frags rake crowds) -> ~150. Pays via the
    // fixed burst range: too close and frags overshoot, too far and the
    // shell pops early.
    name: "FLAK",
    power: 0.45,
    speed: 460,
    length: 12,
    width: 2,
    tint: 0xff8c00, // orange (EXPLOSION's 0xff9900 reads warmer + rounder)
    intervalMs: 650,
    through: false,
    explosion: null,
    pellets: 1,
    spreadDeg: 0,
    jitterDeg: 1,
    homing: null,
    arc: null,
    boomerang: null,
    windupMs: 0,
    mine: false,
    ricochet: null,
    flak: { burstDist: 280, fragments: 8, fragRange: 160 },
    cluster: null,
    range: 0,
    phasesRock: false,
    mirror: false,
    aura: false,
    sentry: false,
    singularity: false,
    sfx: "boom",
  },
  {
    // CLUSTER: one trigger-pull -> 3 mini homing missiles staggered 60ms
    // (HOMING seek code with its own faster turn rate).
    // v3.1 retune (intervalMs 700 -> 900): 3 x 35 = 105/volley / 0.9s = 117
    // raw x 0.9 reliability (staggered locks can overkill a dying target)
    // -> ~105 - pulled out of strict dominance over HOMING. CLUSTER fans
    // locks across a crowd; HOMING (0.6) bursts one target harder from
    // farther away.
    name: "CLUSTER",
    power: 0.35,
    speed: 360,
    length: 8,
    width: 1,
    tint: 0xc4b5fd, // pale violet
    intervalMs: 900,
    through: false,
    explosion: null,
    pellets: 1,
    spreadDeg: 0,
    jitterDeg: 0,
    homing: { turnDegPerSec: 300, acquireRange: 380 },
    arc: null,
    boomerang: null,
    windupMs: 0,
    mine: false,
    ricochet: null,
    flak: null,
    cluster: { missiles: 3, staggerMs: 60 },
    range: 0,
    phasesRock: false,
    mirror: false,
    aura: false,
    sentry: false,
    singularity: false,
    sfx: "seek",
  },
  {
    // DRILL: very slow, wide, long-lived through-beam that grinds the line.
    // effDPS: 100/0.9s = 111 raw x 1.6 avgTargets (pierce; slow bolt lets
    // enemies walk into it) x 0.85 reliability (240 px/s is outrun by
    // everything) -> ~151. power 1.0 -> heavy tier: PvP volleys auto-rate
    // at the 300ms i-frame (the persistent slow beam would re-drain at the
    // 120ms tier otherwise).
    name: "DRILL",
    power: 1.0,
    speed: 240,
    length: 30,
    width: 8,
    tint: 0xb45309, // copper - heavy + warm without touching the reserved enemy red family
    intervalMs: 900,
    through: true,
    explosion: null,
    pellets: 1,
    spreadDeg: 0,
    jitterDeg: 0,
    homing: null,
    arc: null,
    boomerang: null,
    windupMs: 0,
    mine: false,
    ricochet: null,
    flak: null,
    cluster: null,
    range: 0,
    phasesRock: false,
    mirror: false,
    aura: false,
    sentry: false,
    singularity: false,
    sfx: "drill",
  },
  // ---- v3.1 weapons #16-21 (same effDPS method, target band ~135-165) ----
  {
    // PLASMA CONE: flamethrower stream - 70ms cadence, bolts die at 150px
    // traveled (range -> diesAt in makeBeam). Per-shot tint lerps hot pink
    // to orange so the stream reads as a gradient.
    // effDPS: 11/0.07s = 157 raw x 1.0 targets x 0.9 reliability (jitter
    // spills past small hulls at the envelope edge) -> ~141. Pays via
    // range: you fight at hull-contact distance to keep the stream on.
    // Wire load: 150px/520px/s = ~290ms TTL x 70ms cadence = ~4-6 live
    // beams serialized (~7 under OVERDRIVE) - no beam cap needed.
    name: "PLASMA CONE",
    power: 0.11,
    speed: 520,
    length: 10,
    width: 3,
    tint: 0xff5e3a, // hot pink-orange midpoint (per-shot gradient at fire)
    intervalMs: 70,
    through: false,
    explosion: null,
    pellets: 1,
    spreadDeg: 0,
    jitterDeg: 7,
    homing: null,
    arc: null,
    boomerang: null,
    windupMs: 0,
    mine: false,
    ricochet: null,
    flak: null,
    cluster: null,
    range: 150,
    phasesRock: false,
    mirror: false,
    aura: false,
    sentry: false,
    singularity: false,
    sfx: "plasma",
  },
  {
    // PHASE LANCE: passes through asteroids harmlessly (the asteroid
    // hit-test is skipped outright) - the ignores-cover identity. Hits
    // enemies, players and the UFO only, and pierces them (through).
    // effDPS: 45/0.4s = 112 raw x 1.25 avgTargets (a pierce line that rocks
    // can't block rakes stacked enemies) x 1.0 reliability (near-hitscan)
    // -> ~141. Pays by never farming rocks: zero chip income, zero mining.
    name: "PHASE LANCE",
    power: 0.45,
    speed: 2200,
    length: 240,
    width: 1,
    tint: 0xdffbff, // cyan-white, thinner + paler than LASER's 0x8ae3fc
    intervalMs: 400,
    through: true,
    explosion: null,
    pellets: 1,
    spreadDeg: 0,
    jitterDeg: 0,
    homing: null,
    arc: null,
    boomerang: null,
    windupMs: 0,
    mine: false,
    ricochet: null,
    flak: null,
    cluster: null,
    range: 0,
    phasesRock: true,
    mirror: false,
    aura: false,
    sentry: false,
    singularity: false,
    sfx: "zap",
  },
  {
    // MIRROR: every trigger fires the bolt forward AND a copy backward
    // (180 deg, from the tail). ~0.7x NORMAL power each, fast cadence.
    // effDPS: fwd 18/0.2s = 90 + rear 90 x ~0.55 connect rate (something
    // must be chasing you) -> ~140. The fleeing weapon: full value only
    // under pursuit; kiting IS the aim mechanic.
    name: "MIRROR",
    power: 0.18,
    speed: 560,
    length: 10,
    width: 2,
    tint: 0xb8c2cc, // silver, dimmer than NORMAL's white
    intervalMs: 200,
    through: false,
    explosion: null,
    pellets: 1,
    spreadDeg: 0,
    jitterDeg: 1,
    homing: null,
    arc: null,
    boomerang: null,
    windupMs: 0,
    mine: false,
    ricochet: null,
    flak: null,
    cluster: null,
    range: 0,
    phasesRock: false,
    mirror: true,
    aura: false,
    sentry: false,
    singularity: false,
    sfx: "pulse",
  },
  {
    // TESLA AURA: melee field - while held, zaps the nearest target within
    // 120px every 180ms (omnidirectional auto-aim, single-hop ARC-chain
    // render; silent tick when nothing is in range).
    // effDPS: 27/0.18s = 150 raw x 1.0 x 0.95 reliability (you must orbit
    // inside 120px of things that hurt) -> ~142. PvP: victims adjudicate
    // via the serialized `tesla` flag + own proximity (RAM pattern) at the
    // standard 120ms i-frame tier.
    name: "TESLA AURA",
    power: 0.27,
    speed: 0,
    length: 0,
    width: 1,
    tint: 0x00aaff, // electric blue
    intervalMs: 180,
    through: false,
    explosion: null,
    pellets: 1,
    spreadDeg: 0,
    jitterDeg: 0,
    homing: null,
    arc: { castRange: 120, hopRange: 0, jumps: 0, falloff: 1 },
    boomerang: null,
    windupMs: 0,
    mine: false,
    ricochet: null,
    flak: null,
    cluster: null,
    range: 0,
    phasesRock: false,
    mirror: false,
    aura: true,
    sentry: false,
    singularity: false,
    sfx: "tesla",
  },
  {
    // SENTRY: each trigger places the one turret at the ship (max 1;
    // placing again moves it; 12s life, re-place refreshes) AND fires this
    // bolt from the ship. The turret fires this same NORMAL-power bolt at
    // the nearest enemy (else asteroid) within 480px every 500ms; turret +
    // bolts ride the owner's per-player state/beams.
    // effDPS: own 25/0.28s = 89 + turret 25/0.5s = 50 (target in range)
    // -> ~139. Pays via the split: half your output is parked wherever you
    // last left it.
    name: "SENTRY",
    power: 0.25,
    speed: 520,
    length: 12,
    width: 1,
    tint: 0xfbbf24, // amber
    intervalMs: 280,
    through: false,
    explosion: null,
    pellets: 1,
    spreadDeg: 0,
    jitterDeg: 1,
    homing: null,
    arc: null,
    boomerang: null,
    windupMs: 0,
    mine: false,
    ricochet: null,
    flak: null,
    cluster: null,
    range: 0,
    phasesRock: false,
    mirror: false,
    aura: false,
    sentry: true,
    singularity: false,
    sfx: "sentry",
  },
  {
    // SINGULARITY: slow orb (180 px/s), collapses at 216px traveled (1.2s)
    // or on first contact: 0.8s pull drags asteroids/enemies within 220px
    // toward the center (the HOST applies it via sharedState.pulls so all
    // clients see the same drag), then a 90px pop through the standard
    // exploding-beam path (hitIds cleared at pop = per-target dedup).
    // effDPS: 100/1.5s = 67 raw x 2.2 avgTargets (the pull packs the pop
    // radius) x 0.95 -> ~147. power 1.0 -> heavy tier: PvP rates at the
    // 300ms i-frame (exploding beams use it anyway).
    name: "SINGULARITY",
    power: 1.0,
    speed: 180,
    length: 0,
    width: 2,
    tint: 0x7c3aed, // deep purple
    intervalMs: 1500,
    through: false,
    explosion: { range: 90, growth: 600 },
    pellets: 1,
    spreadDeg: 0,
    jitterDeg: 0,
    homing: null,
    arc: null,
    boomerang: null,
    windupMs: 0,
    mine: false,
    ricochet: null,
    flak: null,
    cluster: null,
    range: 216,
    phasesRock: false,
    mirror: false,
    aura: false,
    sentry: false,
    singularity: true,
    sfx: "singularity",
  },
];

/** FLAK fragments: ordinary beams (own hitIds, serialized, PvP-live) spawned
 *  by the shell burst; never trigger-fired, so intervalMs is inert. */
export const FLAK_FRAG_WEAPON: Weapon = {
  name: "FLAK FRAG",
  power: 0.12,
  speed: 420,
  length: 6,
  width: 1,
  tint: 0xffb066,
  intervalMs: 9_999,
  through: false,
  explosion: null,
  pellets: 1,
  spreadDeg: 0,
  jitterDeg: 0,
  homing: null,
  arc: null,
  boomerang: null,
  windupMs: 0,
  mine: false,
  ricochet: null,
  flak: null,
  cluster: null,
  range: 0,
  phasesRock: false,
  mirror: false,
  aura: false,
  sentry: false,
  singularity: false,
  sfx: "boom",
};

/** ARC bolt lives this long on screen (re-jittered every frame). */
export const ARC_RENDER_MS = 90;
/** ARC fizzle (no first target): jittered bolt this long, no damage. */
export const ARC_FIZZLE_LEN = 80;
/** ARC first-target acquisition cone (total degrees around aim). */
export const ARC_CAST_CONE_DEG = 30;
/** HOMING lock cone at fire (total degrees around the nose). */
export const HOMING_LOCK_CONE_DEG = 60;
/** GLAIVE decelerates to 0 over the last N px of the outbound leg. */
export const GLAIVE_DECEL_PX = 80;

// MINES (weapon #9): owner-simulated, ride in beams[] with `mine: true`.
export const MINE_ARM_MS = 450;
export const MINE_TRIGGER_RADIUS = 60;
export const MINE_LIFETIME_MS = 6_000;
/** Oldest detonates harmlessly (30% ring, no damage) when exceeded. */
export const MINE_MAX_LIVE = 5;

// SENTRY (weapon #20): one owner-simulated turret, networked via
// PlayerNetState.sentry; its bolts are ordinary owner beams.
export const SENTRY_LIFETIME_MS = 12_000;
export const SENTRY_FIRE_MS = 500;
/** Turret acquire range (nearest enemy preferred, else nearest asteroid). */
export const SENTRY_RANGE = 480;

// SINGULARITY (weapon #21): the collapse pull is HOST-applied (one shared
// pulls entry per orb) so every client sees consistent motion.
export const SINGULARITY_PULL_MS = 800;
export const SINGULARITY_PULL_RANGE = 220;
/** Drag speed at the fringe; scaled down near the center (d/100 clamp) so
 *  targets gather at the point instead of slingshotting through it. */
export const SINGULARITY_PULL_SPEED = 260;

// ---- base shield (v2 §A) ----------------------------------------------------------

export const SHIELD_MAX = 100; // every ship, always
/** No damage this long → regen starts (Halo grammar at ~60% timescale). */
export const SHIELD_REGEN_DELAY_MS = 2_500;
/** 0→100 in this long once running (rate = 66.7 HP/s). */
export const SHIELD_REGEN_FULL_MS = 1_500;
/** Below this fraction: warning pulse + `shield_low` tone. */
export const SHIELD_LOW_FRACTION = 0.3;

/** Drain per source, on the 100 scale. Every cell that zeroes shieldHp = death. */
export const DMG = {
  DRONE_SHOT: 30, // 4 consecutive hits kill
  WASP_SHOT: 25, // per bolt; a full 3-bolt burst = 75
  LANCER_CHARGE: 80, // the haymaker
  LANCER_HULL: 45, // touching a non-charging lancer
  ENEMY_HULL: 35, // drone/wasp/splitter hull contact
  UFO_HULL: 50,
} as const;

/** Asteroid contact scales with rock size: r=5→25 … r=50→50 … r=80→68. */
export function asteroidContactDamage(r: number): number {
  return Math.min(70, Math.max(25, Math.round(20 + 0.6 * r)));
}

// PvP: drain = weapon.power × 100 × PVP_DAMAGE_MULT, volley rule (§A.2).
export const PVP_DAMAGE_MULT = 1.0; // the tuning knob; ship at 1.0
export const PVP_MAX_SINGLE_HIT = 90; // no single volley kills from full
export const PVP_HIT_IFRAME_MS = 120; // per-shooter, after a volley drains
export const PVP_EXPLOSION_IFRAME_MS = 300; // exploding beams tick slower
/** After any hull/asteroid/UFO drain: bounce + immunity vs ALL contact. */
export const CONTACT_IFRAME_MS = 500;

// ---- shield modifiers (v2 §B) ------------------------------------------------------

/** Pickups are timed modifiers on top of the base shield, one at a time. */
export const SHIELD_MOD_DURATION_MS = 20_000;

export type ShieldModKind = "overshield" | "reflect" | "ram" | "phase" | "siphon" | "aegis";

/** Index order on the wire (`ItemState.shieldIdx`). */
export const SHIELD_MOD_KINDS: readonly ShieldModKind[] = [
  "overshield",
  "reflect",
  "ram",
  "phase",
  "siphon",
  "aegis",
];

export type ShieldModSpec = { name: string; tint: number };

export const SHIELD_MOD_SPECS: Record<ShieldModKind, ShieldModSpec> = {
  overshield: { name: "OVERSHIELD", tint: 0x7dd3fc },
  reflect: { name: "REFLECT", tint: 0xc084fc },
  ram: { name: "RAM", tint: 0xffb454 },
  phase: { name: "PHASE", tint: 0xe2e8f0 },
  siphon: { name: "SIPHON", tint: 0x34d399 },
  aegis: { name: "AEGIS", tint: 0xfacc15 },
};

/** Base shield ring radius (hull r=8; mod halos sit at r=15). */
export const SHIELD_RING_RADIUS = 12;
export const SHIELD_RING_TINT = 0xcfe3ff;
export const SHIELD_HALO_RADIUS = 15;

/** OVERSHIELD: instant bonus layer; drains first, never regenerates. */
export const OVERSHIELD_BONUS = 75;

/** REFLECT bounces only while shieldHp > this; below, the arm is down. */
export const REFLECT_MIN_SHIELD = 40;
/** Shield drain per bounce (replaces the incoming volley's damage). */
export const REFLECT_BOUNCE_COST = 12;

/** RAM is armed above this speed. */
export const RAM_ARM_SPEED = 220;
/** HP damage dealt to enemies on armed contact. */
export const RAM_DAMAGE = 60;
/** Knockback applied to the rammed enemy, px/s. */
export const RAM_KNOCKBACK = 320;
/** Contact immunity vs the rammed target after a hit (per target). */
export const RAM_IMMUNITY_MS = 400;
/** Asteroids at or under this radius are destroyed outright by an armed RAM. */
export const RAM_ASTEROID_DESTROY_R = 28;
/** Chip damage (power units) vs bigger asteroids. */
export const RAM_ASTEROID_CHIP = 0.35;
/** Shield cost per armed ram (enemy hull, UFO, big-asteroid chip). */
export const RAM_SELF_DRAIN = 10;
/** Armed ram vs a mid-charge lancer costs more. */
export const RAM_LANCER_DRAIN = 25;
/** Armed ram vs another player: they adjudicate this drain themselves. */
export const RAM_PVP_DRAIN = 35;

/** PHASE auto-blinks when a single drain is ≥ this or would kill. */
export const PHASE_TRIGGER_HIT = 40;
/** Shield cost per blink — capped at shieldHp−1, phasing can never kill. */
export const PHASE_COST = 25;
export const PHASE_DURATION_MS = 1_000;
export const PHASE_COOLDOWN_MS = 8_000;

// SIPHON: kills restore shield (predicted kills count).
export const SIPHON_HEAL_ENEMY = 18;
export const SIPHON_HEAL_ASTEROID = 6;
export const SIPHON_HEAL_PLAYER = 40;
/** Heals can bank above 100… */
export const SIPHON_OVERHEAL_MAX = 130;
/** …but the portion above 100 bleeds off and never regens. */
export const SIPHON_OVERHEAL_DECAY_PER_S = 8;

// AEGIS: pure regen tuner — the Halo "fast recharge" feel.
/** Replaces 2_500 while held. 1.4s (not 0.9s) so a lone WASP's 2.2s burst
 *  cycle still out-paces regen — design F.2: a wasp must still kill. */
export const AEGIS_REGEN_DELAY_MS = 1_400;
export const AEGIS_REGEN_MULT = 1.6; // 106.7 HP/s → full in ~0.94s

// ---- boosters (v2 §D — third drop class) --------------------------------------------

export type BoosterKind = "overdrive" | "nitro" | "repair" | "twin" | "magnet";

/** Index order on the wire (`ItemState.boosterIdx`). */
export const BOOSTER_KINDS: readonly BoosterKind[] = [
  "overdrive",
  "nitro",
  "repair",
  "twin",
  "magnet",
];

export type BoosterSpec = { name: string; tint: number; durationMs: number };

export const BOOSTER_SPECS: Record<BoosterKind, BoosterSpec> = {
  overdrive: { name: "OVERDRIVE", tint: 0xfacc15, durationMs: 15_000 },
  nitro: { name: "NITRO", tint: 0xf97316, durationMs: 15_000 },
  repair: { name: "REPAIR", tint: 0x4ade80, durationMs: 0 }, // instant
  twin: { name: "TWIN", tint: 0xa78bfa, durationMs: 20_000 },
  magnet: { name: "MAGNET", tint: 0x38bdf8, durationMs: 25_000 },
};

/** intervalMs & windupMs × this at fire time (+50% rate). */
export const OVERDRIVE_RATE_MULT = 0.667;
export const NITRO_ACCEL_MULT = 1.4; // 540 → 756 px/s²
export const NITRO_MAX_SPEED_MULT = 1.4; // 300 → 420 px/s
export const TWIN_POWER_MULT = 0.6; // mirror shots at 60% power
export const TWIN_ORBIT_RADIUS = 28;
export const TWIN_ORBIT_DEG_PER_S = 120;
export const MAGNET_RANGE = 260;
export const MAGNET_PULL_SPEED = 140; // px/s, overrides 30 px/s item drift

// ---- loot economy (v2 E.1, v3 universal drops) ---------------------------------------

export type LootClass = "shield" | "booster" | "weapon";
export const LOOT_CLASSES: readonly LootClass[] = ["shield", "booster", "weapon"];

// v3: the drop CHANCE moved out of the class table into per-source gates
// (the old parent-roll null row at weight 55 is gone). Class weights keep
// the v2 18/15/12 split; only WHO rolls changed:
//   fodder kill (drone/wasp)     18% item + always 1-2 shards
//   elite kill (lancer/splitter) 100% item (guaranteed)
//   UFO kill                     100% weapon item (pinata, bypasses cap)
//   asteroid destroy             11% item + shards scaled by radius
/** Fodder (drone/wasp) kill item chance. */
export const FODDER_DROP_CHANCE = 0.18;
/** Asteroid destroy item chance. */
export const ASTEROID_DROP_CHANCE = 0.11;

/** Class split once a drop is happening (relative weights, v2 ratios kept). */
export const LOOT_CLASS_WEIGHTS: ReadonlyArray<{ cls: LootClass; weight: number }> = [
  { cls: "shield", weight: 18 },
  { cls: "booster", weight: 15 },
  { cls: "weapon", weight: 12 },
];

/** Child tables (integer weights). Weapon child roll: uniform over WEAPONS_SPECIAL. */
export const LOOT_SHIELD_WEIGHTS: Record<ShieldModKind, number> = {
  overshield: 4,
  reflect: 3,
  ram: 3,
  phase: 3,
  siphon: 3,
  aegis: 2,
};
export const LOOT_BOOSTER_WEIGHTS: Record<BoosterKind, number> = {
  overdrive: 4,
  nitro: 3,
  repair: 3,
  twin: 3,
  magnet: 2,
};

/** Per-class pity: a kill that doesn't drop class X increments X's counter;
 *  at threshold the next roll forces it (ripe-priority shield > booster > weapon). */
export const LOOT_PITY: Record<LootClass, number> = { shield: 8, booster: 9, weapon: 12 };

/** Loot rolls that would exceed this many items in flight are skipped (UFO bypasses). */
export const ITEMS_MAX_LIVE = 6;

/** Roll the class split (always lands on a class; the chance gate is upstream). */
export function rollLootClass(): LootClass {
  const total = LOOT_CLASS_WEIGHTS.reduce((sum, e) => sum + e.weight, 0);
  let roll = Math.random() * total;
  for (const e of LOOT_CLASS_WEIGHTS) {
    roll -= e.weight;
    if (roll <= 0) return e.cls;
  }
  return "weapon";
}

/** Roll a child table of integer weights. */
export function rollWeightedKey<K extends string>(weights: Record<K, number>): K {
  const entries = Object.entries(weights) as Array<[K, number]>;
  const total = entries.reduce((sum, [, w]) => sum + w, 0);
  let roll = Math.random() * total;
  for (const [key, w] of entries) {
    roll -= w;
    if (roll <= 0) return key;
  }
  const last = entries[entries.length - 1];
  if (!last) throw new Error("rollWeightedKey: empty table");
  return last[0];
}

// ---- enemies (§6) -----------------------------------------------------------------

export type EnemyKind = "drone" | "wasp" | "lancer" | "splitter";

export type EnemySpec = {
  name: string;
  tint: number;
  hitRadius: number;
  hp: number;
  score: number;
};

/** v3 fodder rule: one NORMAL BEAM hit = power 0.25 x 100 = 25 HP, so
 *  fodder (drone, wasp) hp <= 25 and dies to a single default shot.
 *  Splitter children are drones -> also 1-shot. Elites keep the old ratios
 *  (lancer 80 = 4 NORMAL hits, splitter 120 = 5). The v2 F.2 invariant is
 *  untouched by hp tuning: a lone DRONE still can't kill a dodging
 *  full-shield player (30 dmg / 2.8s cooldown vs 2.5s regen delay). */
export const ENEMY_SPECS: Record<EnemyKind, EnemySpec> = {
  drone: { name: "DRONE", tint: 0xff7a6b, hitRadius: 7, hp: 20, score: SCORE.DRONE },
  wasp: { name: "WASP", tint: 0xff4757, hitRadius: 8, hp: 25, score: SCORE.WASP },
  lancer: { name: "LANCER", tint: 0xd90429, hitRadius: 9, hp: 80, score: SCORE.LANCER },
  splitter: { name: "SPLITTER", tint: 0xff9580, hitRadius: 12, hp: 120, score: SCORE.SPLITTER },
};

/** Enemies never fire unless their target is within this range (≈ on screen). */
export const ENEMY_FIRE_RANGE = 600;
/** Never spawn within this distance of a living player. */
export const ENEMY_SPAWN_CLEARANCE = 900;
/** Debut rule: a type's first spawn suppresses other enemy spawns this long. */
export const ENEMY_DEBUT_SUPPRESS_MS = 5_000;

export const DRONE_SPEED = 70;
export const DRONE_TURN_DEG_PER_S = 90;
export const DRONE_SHOT_SPEED = 200;
export const DRONE_FIRE_CONE_DEG = 20; // ± of nose
export const DRONE_COOLDOWN_MS = 2_800;
export const DRONE_TELEGRAPH_MS = 400;

export const WASP_SPEED = 240;
export const WASP_ORBIT_RADIUS = 280;
export const WASP_WOBBLE_AMP = 40;
export const WASP_WOBBLE_HZ = 1.2;
export const WASP_BURST_COUNT = 3;
export const WASP_BURST_GAP_MS = 110;
export const WASP_SHOT_SPEED = 340;
export const WASP_COOLDOWN_MS = 2_200;
export const WASP_TELEGRAPH_MS = 350;

export const LANCER_CRUISE_SPEED = 90;
export const LANCER_CHARGE_SPEED = 640;
export const LANCER_WINDUP_MS = 600;
export const LANCER_CHARGE_MS = 700;
export const LANCER_RECOVER_MS = 1_200;
export const LANCER_CHARGE_HIT_RADIUS = 12;
/** Telegraph dashed line length = full charge travel (640 × 0.7). */
export const LANCER_CHARGE_RANGE = 448;

export const SPLITTER_SPEED = 50;
export const SPLITTER_CHILDREN = 3;
export const SPLITTER_CHILD_SPEED = 150;
export const SPLITTER_GRACE_MS = 600;

export const ENEMY_SHOT_TINT = 0xff3b30; // red is reserved: nothing friendly is ever red
export const ENEMY_SHOT_LEN = 8;
export const ENEMY_SHOT_WIDTH = 2;
export const ENEMY_SHOT_TTL_MS = 4_000;

/** v3 swarm tuning: fodder weight ramps with intensity so peaks read as
 *  swarms of 1-shot units, not elite walls. At I=2.6: drone 24.4, wasp 25.2,
 *  lancer 11.9, splitter 7 -> fodder ~72% of spawns (was ~58%). Elites are
 *  still gated by the debut grammar (first appearance is solo). */
export function enemySpawnWeight(kind: EnemyKind, intensity: number): number {
  switch (kind) {
    case "drone":
      return 10 + 9 * Math.max(0, intensity - 1);
    case "wasp":
      return 12 * Math.max(0, intensity - 0.5);
    case "lancer":
      return 7 * Math.max(0, intensity - 0.9);
    case "splitter":
      return 5 * Math.max(0, intensity - 1.2);
  }
}

export const ENEMY_KINDS: readonly EnemyKind[] = ["drone", "wasp", "lancer", "splitter"];

/** Breather rule: once the live count exceeds the cap by this slack (splitter
 *  children bypass the cap), the host quietly despawns the enemy farthest from
 *  all living players — no loot, no score. */
export const ENEMY_DESPAWN_SLACK = 2;
/** Only despawn an enemy farther than this from EVERY living player. */
export const ENEMY_DESPAWN_MIN_DIST = 1200;
/** At most one breather despawn per this interval (post-peak crowds must
 *  clear inside the breather window at the v2 caps). */
export const ENEMY_DESPAWN_INTERVAL_MS = 1_500;

// ---- networking ---------------------------------------------------------------

export const NET_INTERVAL_MS = 50; // 20Hz for both my-state and host broadcasts

// ---- minimap ------------------------------------------------------------------

export const MINIMAP_W = 140;
export const MINIMAP_H = Math.round(MINIMAP_W * (WORLD_H / WORLD_W));
export const MINIMAP_PAD = 12;

// ---- shared/networked types ----------------------------------------------------

export type Vec = { x: number; y: number };

export type AsteroidState = {
  id: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  radius: number;
  /** 12 jagged outline points relative to center. Scaled (not re-rolled) on
   *  damage so the shape never pops. */
  verts: Vec[];
  rot: number;
};

export type UfoState = {
  id: string;
  x: number;
  y: number;
  destX: number;
  destY: number;
  hp: number;
  /** Host-clock timestamp; flicker the sprite while now < blinkUntil. */
  blinkUntil: number;
};

/** What an item grants — the discriminated payload of ItemState. */
export type ItemDrop =
  | { kind: "weapon"; weaponIdx: number }
  | { kind: "shield"; shieldIdx: number }
  | { kind: "booster"; boosterIdx: number };

export type ItemState = {
  id: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** Host-clock expiry timestamp. */
  diesAt: number;
} & ItemDrop;

export type EnemyState = {
  id: string;
  kind: EnemyKind;
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** Facing; for a winding-up/charging LANCER this is the locked charge vector. */
  angle: number;
  hp: number;
  // host-clock timestamps; clients render telegraphs/blinks from these
  /** 0 = none. While now < this: wind-up visuals. */
  telegraphUntil: number;
  /** LANCER only: locked-vector charge window. */
  chargeUntil: number;
  /** Damage flicker, as UFO. */
  blinkUntil: number;
  /** SPLITTER children: can't fire/kill while flashing in. */
  graceUntil: number;
};

export type EnemyShotState = {
  id: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  diesAt: number;
};

/** SINGULARITY pull: until `until` (epoch-ms) the HOST drags asteroids +
 *  enemies within SINGULARITY_PULL_RANGE of (x,y) toward it; every client
 *  renders the vortex from this entry. Pruned by the host on expiry. */
export type PullState = {
  id: string;
  x: number;
  y: number;
  until: number;
};

/** Score shard: host-owned, drifts, +SHARD_SCORE on touch, 8s lifetime. */
export type ShardState = {
  id: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** Host-clock expiry timestamp. */
  diesAt: number;
};

/**
 * Host-owned world. Patches shallow-merge (`{...prev, ...patch}`), so every
 * resettable key MUST be present in `emptyShared()` and the host rewrites each
 * top-level field wholesale.
 */
export type SharedState = {
  asteroids: AsteroidState[];
  ufo: UfoState | null;
  items: ItemState[];
  enemies: EnemyState[];
  enemyShots: EnemyShotState[];
  /** v3 score shards: separate capped array; never counts vs ITEMS_MAX_LIVE. */
  shards: ShardState[];
  /** v3.1 SINGULARITY pulls (host-applied; see PullState). */
  pulls: PullState[];
  /** Epoch-ms wall clock of arena start — the intensity director's t=0.
   *  Lives in sharedState so it survives host migration. */
  arenaEpoch: number;
};

/** Beam snapshot in another player's state — drawn raw, never simulated. */
export type SerializedBeam = {
  hx: number;
  hy: number;
  tx: number;
  ty: number;
  tint: number;
  width: number;
  exploding: boolean;
  explosionRadius: number;
  /** ARC only: bolt anchor points (render + victim-side PvP hit test). */
  chain?: Vec[];
  /** GLAIVE only: remotes render the spinning triangle instead of a segment. */
  glaive?: boolean;
  /** MINES: inert diamond until `exploding` — victims must not hit-test it. */
  mine?: boolean;
  /** SINGULARITY orb in flight/collapse: rendered as a small circle and,
   *  like an inert mine, never hit-tested (only the pop's exploding circle
   *  damages). */
  orb?: boolean;
  /** Damage fraction — victims compute their own drain from it (defaults to
   *  NORMAL's 0.25 when absent). */
  power?: number;
};

export type ShieldModNetState = {
  kind: ShieldModKind;
  /** Epoch-ms expiry of the 20s mod window. */
  until: number;
  /** ram-armed / reflect->40 / phase-ready; other kinds always true. */
  active: boolean;
  /** PHASE intangibility window is live. */
  phased: boolean;
};

export type BoostNetState = { kind: BoosterKind; until: number };

/** Per-player networked state (each client writes its own at 20Hz). */
export type PlayerNetState = {
  x: number;
  y: number;
  angle: number;
  vx: number;
  vy: number;
  alive: boolean;
  invuln: boolean;
  score: number;
  streak: number;
  weaponName: string;
  /** Base shield 0–100; remotes render the ring straight from this. */
  shieldHp: number;
  /** OVERSHIELD bonus layer 0–75. */
  overHp: number;
  shieldMod: ShieldModNetState | null;
  boosts: BoostNetState[];
  /** 0–1 windup charge; remotes draw the charging nose glow. */
  windup: number;
  /** TESLA AURA is live (weapon held + firing): victims inside its range
   *  adjudicate their own drain from this, RAM-style. */
  tesla: boolean;
  /** SENTRY turret (pos + epoch-ms expiry); remotes render it from here. */
  sentry: { x: number; y: number; until: number } | null;
  beams: SerializedBeam[];
};

// ---- pure world-gen helpers -----------------------------------------------------

export function randomWorldPoint(margin = RESPAWN_EDGE_MARGIN): Vec {
  return {
    x: margin + Math.random() * (WORLD_W - margin * 2),
    y: margin + Math.random() * (WORLD_H - margin * 2),
  };
}

export function makeAsteroidVerts(radius: number): Vec[] {
  const verts: Vec[] = [];
  for (let i = 0; i < ASTEROID_VERTEX_COUNT; i++) {
    const r = radius * (0.5 + Math.random() * 0.5);
    const a = (Math.PI * 2 * i) / ASTEROID_VERTEX_COUNT;
    verts.push({ x: Math.cos(a) * r, y: Math.sin(a) * r });
  }
  return verts;
}

/** Pick a point just past a random world edge, plus an inward heading. */
export function edgeSpawn(margin: number): { x: number; y: number; ang: number } {
  const side = Math.floor(Math.random() * 4);
  const spread = Math.random() * (Math.PI / 2); // 90° fan, aimed inward below
  if (side <= 1) {
    const y = -margin + Math.random() * (WORLD_H + margin * 2);
    const x = side === 0 ? -margin : WORLD_W + margin;
    const ang = side === 0 ? spread - Math.PI * 0.25 : spread + Math.PI * 0.75;
    return { x, y, ang };
  }
  const x = -margin + Math.random() * (WORLD_W + margin * 2);
  const y = side === 2 ? -margin : WORLD_H + margin;
  const ang = side === 2 ? spread + Math.PI * 0.25 : spread - Math.PI * 0.75;
  return { x, y, ang };
}

export function spawnAsteroidState(): AsteroidState {
  const { x, y, ang } = edgeSpawn(ASTEROID_MAX_RADIUS);
  const radius = ASTEROID_MIN_RADIUS + Math.random() * (ASTEROID_MAX_RADIUS - ASTEROID_MIN_RADIUS);
  const speed = asteroidSpeed(radius);
  return {
    id: crypto.randomUUID(),
    x,
    y,
    vx: Math.cos(ang) * speed,
    vy: Math.sin(ang) * speed,
    radius,
    verts: makeAsteroidVerts(radius),
    rot: 0,
  };
}

export function spawnUfoState(): UfoState {
  const { x, y } = edgeSpawn(30);
  return {
    id: crypto.randomUUID(),
    x,
    y,
    destX: Math.random() * WORLD_W,
    destY: Math.random() * WORLD_H,
    hp: UFO_HP,
    blinkUntil: 0,
  };
}

/** Generic item factory — every drop class ships through here. */
export function spawnItemState(x: number, y: number, drop: ItemDrop): ItemState {
  const ang = Math.random() * Math.PI * 2;
  return {
    id: crypto.randomUUID(),
    x,
    y,
    vx: Math.cos(ang) * ITEM_SPEED,
    vy: Math.sin(ang) * ITEM_SPEED,
    diesAt: Date.now() + ITEM_LIFETIME_MS,
    ...drop,
  };
}

/** Score shard at (x,y) with a small position scatter + slow random drift,
 *  so a multi-shard drop fans out instead of stacking into one sprite. */
export function spawnShardState(x: number, y: number): ShardState {
  const ang = Math.random() * Math.PI * 2;
  const scatter = Math.random() * 10;
  return {
    id: crypto.randomUUID(),
    x: x + Math.cos(ang) * scatter,
    y: y + Math.sin(ang) * scatter,
    vx: Math.cos(ang) * SHARD_DRIFT_SPEED,
    vy: Math.sin(ang) * SHARD_DRIFT_SPEED,
    diesAt: Date.now() + SHARD_LIFETIME_MS,
  };
}

export function spawnWeaponItemState(x: number, y: number): ItemState {
  return spawnItemState(x, y, {
    kind: "weapon",
    weaponIdx: Math.floor(Math.random() * WEAPONS_SPECIAL.length),
  });
}

export function spawnEnemyState(kind: EnemyKind, x: number, y: number): EnemyState {
  return {
    id: crypto.randomUUID(),
    kind,
    x,
    y,
    vx: 0,
    vy: 0,
    angle: 0,
    hp: ENEMY_SPECS[kind].hp,
    telegraphUntil: 0,
    chargeUntil: 0,
    blinkUntil: 0,
    graceUntil: 0,
  };
}

// ---- offline fallback ---------------------------------------------------------

/** How long to wait for the party server before starting a solo arena. */
export const OFFLINE_FALLBACK_MS = 4000;
