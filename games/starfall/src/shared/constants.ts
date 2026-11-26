import { now as simNow } from "./clock";
import { rand } from "./rng";

export const WORLD_W = 7680;
export const WORLD_H = 4320;

/** 1-player play size (the arena felt right at this for solo). */
export const BASE_WORLD_W = 3840;
export const BASE_WORLD_H = 2160;

/** How far past the world edge the starfield scatters and the void fades — the
 *  single knob for the bleed ring (starfield + masks reference it). Keeps the
 *  arena from looking hard-cut at the boundary. */
export const WORLD_BLEED_PX = 1200;

/** Play-area linear scale from player count: 1.0 at 1p → 2.0 at 32p (so the
 *  play box grows from BASE_WORLD to the full WORLD max). sqrt so each added
 *  player widens the arena less than the last. Both dims scale equally, so the
 *  16:9 aspect (and the minimap) is preserved. */
export const worldScaleForPlayers = (playerCount: number) => {
  const n = Math.max(1, playerCount);

  return Math.min(2, 1 + (Math.sqrt(n) - 1) / (Math.sqrt(32) - 1));
};

export const playWidthForPlayers = (playerCount: number) =>
  Math.min(WORLD_W, Math.round(BASE_WORLD_W * worldScaleForPlayers(playerCount)));

export const playHeightForPlayers = (playerCount: number) =>
  Math.min(WORLD_H, Math.round(BASE_WORLD_H * worldScaleForPlayers(playerCount)));

export const SHIP_RADIUS = 8;

/** Thrust toward the cursor, px/s². */
export const SHIP_ACCEL = 540;

/** Exponential drag while flying: v *= exp(-DRAG·dt). 1/s. */
export const SHIP_DRAG = 1.8;

/** Heavier drag inside the dead zone — stopping faster than starting. 1/s. */
export const SHIP_BRAKE_DRAG = 4;

/** = ACCEL/DRAG; also hard-clamps |v|. */
export const SHIP_MAX_SPEED = 300;

/** No thrust inside this cursor distance (3× SHIP_RADIUS). */
export const SHIP_DEAD_ZONE = 24;

/** Thrust scales 0→1 over DEAD_ZONE..DEAD_ZONE+RAMP px for fine control. */
export const SHIP_THRUST_RAMP = 96;

/** Dart hull: 4 points at these angles, radius SHIP_RADIUS except the notched
 *  180° point at half radius. */
export const SHIP_HULL_DEG = [0, 140, 180, 220] as const;

/** Drag distance from the anchor that maps to full thrust. */
export const JOYSTICK_RADIUS = 64;

/** No thrust / no re-aim within this drag of the anchor (a held still finger
 *  parks the ship instead of jittering its heading). */
export const JOYSTICK_DEAD_ZONE = 8;

/** Knob (inner puck) radius for the joystick UI. */
export const JOYSTICK_KNOB_RADIUS = 26;

export const RESPAWN_DELAY_MS = 2500;
export const INVULNERABLE_MS = 2000;

/** Invulnerability blink: alpha alternates 0.3/0.9 on this period. */
export const INVULN_BLINK_MS = 200;

/** Respawn keeps this far from the world edges. */
export const RESPAWN_EDGE_MARGIN = 300;

/** First spawn lands in the central region (this fraction inset per side) so
 *  the opening camera never shows past the world border. */
export const INITIAL_SPAWN_CENTER_FRAC = 1 / 3;

/** Respawn re-rolls until this far from every enemy + big asteroid. */
export const RESPAWN_CLEARANCE = 700;
export const RESPAWN_ATTEMPTS = 8;

/** Asteroids smaller than this don't block a respawn point. */
export const RESPAWN_ASTEROID_MIN_R = 30;

/** 90s build→peak→breather wave on a slow ramp; all clients agree given the
 *  shared arenaEpoch. Troughs at t=0,90,…; peaks at t=45,135,… */
export const arenaIntensity = (tSec: number) => {
  const raw = (1 + tSec / 180) * (0.7 + 0.5 * Math.sin((2 * Math.PI * (tSec - 22.5)) / 90));

  return Math.min(2.6, Math.max(0.2, raw));
};

/** Asymptote of the multiplayer pressure curve (reached well past 32p). */
export const PRESSURE_MAX = 6;

/** Multiplayer pressure scale P(N). Sub-linear (sqrt) so each added player's
 *  marginal swarm contribution shrinks — host CPU + readability stay sane while
 *  a busy 32p room still swarms a 4× map. P(1)=1.0, P(4)≈2.2, P(8)≈2.5,
 *  P(16)≈3.5, P(32)≈5.0, asymptote PRESSURE_MAX. */
export const playerPressure = (playerCount: number) =>
  Math.min(PRESSURE_MAX, Math.max(1, 0.6 + 0.78 * Math.sqrt(Math.max(1, playerCount))));

export const WAVE_PERIOD_S = 45;
export const WAVE_PEAK_MULT = 1.35;
export const WAVE_TROUGH_MULT = 0.7;

/** Cap multiplier oscillating WAVE_TROUGH_MULT (trough) → WAVE_PEAK_MULT (peak). */
export const wavePulse = (tSec: number) => {
  const s = 0.5 - 0.5 * Math.cos((2 * Math.PI * tSec) / WAVE_PERIOD_S);

  return WAVE_TROUGH_MULT + (WAVE_PEAK_MULT - WAVE_TROUGH_MULT) * s;
};

/** Hard ceilings, lifted from the ≤4p era so 32p actually swarms a 4× map. */
export const ASTEROID_CAP_MAX = 110;
export const ENEMY_CAP_MAX = 80;

export const asteroidCap = (intensity: number, pressure: number, wave = 1) =>
  Math.min(ASTEROID_CAP_MAX, Math.round((6 + 11 * intensity) * pressure * wave));

export const asteroidSpawnIntervalMs = (intensity: number) =>
  Math.min(4000, Math.max(300, 1500 / intensity));

export const enemyCap = (intensity: number, pressure: number, wave = 1) =>
  Math.min(ENEMY_CAP_MAX, Math.round((2 + 6.5 * intensity) * pressure * wave));

export const enemySpawnIntervalMs = (intensity: number) =>
  Math.min(8000, Math.max(700, 2100 / intensity));

/** Host seeds this many asteroids at arena start (don't wait for the interval). */
export const ASTEROID_SEED_COUNT = 7;

export const ASTEROID_MAX_RADIUS = 80;
export const ASTEROID_MIN_RADIUS = 5;
export const ASTEROID_VERTEX_COUNT = 12;
export const ASTEROID_ROT_SPEED = 0.3;

/** Removed once this far past the world edge. */
export const ASTEROID_CULL_MARGIN = ASTEROID_MAX_RADIUS + 20;

/** Size-inverse speed retune: 36 px/s (r=80) … 171 px/s (r=5). */
export const asteroidSpeed = (radius: number) =>
  ((1 - radius / ASTEROID_MAX_RADIUS) * 1.6 + 0.4) * 90;

/** Does one hit of `power` shrink the rock below the minimum (= destroys it)?
 *  The shared damage formula — shooters predict with it, the host applies it. */
export const asteroidDestroyedBy = (radius: number, power: number) =>
  radius - ASTEROID_MAX_RADIUS * Math.min(power, 1) < ASTEROID_MIN_RADIUS;

export const UFO_SPEED = 120;

/** Spawn probability per second (gated on no weapon items in flight). */
export const UFO_SPAWN_RATE = 0.21;
export const UFO_RADIUS = 15;
export const UFO_HP = 100;

/** Damage flicker duration (legacy 40 ticks). */
export const UFO_BLINK_MS = 667;

export const ITEM_SPEED = 30;
export const ITEM_LIFETIME_MS = 30_000;
export const ITEM_PICKUP_RADIUS = 15;
export const ITEM_DRAW_RADIUS = 10;
export const SPECIAL_WEAPON_DURATION_MS = 20_000;

/** v3 stacking: picking up the SAME item you already hold EXTENDS its timer
 *  (weapon +20s, shield mod +20s, booster +its duration) instead of
 *  replacing; the extended expiry never reaches past now + this cap. */
export const ITEM_STACK_CAP_MS = 60_000;

export const SHARD_LIFETIME_MS = 8000;

/** Generous pickup radius (items are 15): shards are hoover candy. */
export const SHARD_PICKUP_RADIUS = 40;
export const SHARD_DRIFT_SPEED = 18;

/** Host cap; oldest culled past it (one swarm wipe can't flood the wire). */
export const SHARDS_MAX_LIVE = 48;
export const SHARD_TINT = 0x9f_fc_e8;

/** MAGNET pulls shards harder than items (140). */
export const SHARD_MAGNET_PULL_SPEED = 320;

/** Fodder kills always drop 1-2 shards. */
export const FODDER_SHARD_MIN = 1;
export const FODDER_SHARD_MAX = 2;

/** Asteroid destroys drop shards scaled by radius: ~radius/15, 1..5. */
export const asteroidShardCount = (radius: number) =>
  Math.max(1, Math.min(5, Math.round(radius / 15)));

/** Non-enemy XP awards. Enemy per-kill XP lives in ENEMY_SPECS[kind].xp. */
export const XP = {
  /** Flat per asteroid chip hit, never combo-multiplied. */
  ASTEROID_CHIP: 1,
  ASTEROID_DESTROY: 6,
  /** The boss: a marquee XP event without one-shotting you to the cap. */
  BOSS_DESTROY: 600,
  /** Orb (former score shard) pickup. Flat, never combo-multiplied. */
  ORB: 4,
  PLAYER_KILL: 45,
  UFO_DESTROY: 60,
} as const;

/** Bounded so the base loadout stays a notch below specials — caps the
 *  snowball. Short (3) so each level is a big, visible step: the ship hull
 *  upgrades AND every weapon (base + picked-up specials) scales each level. */
export const LEVEL_CAP = 3;
export const XP_BASE = 70;
export const XP_GROWTH = 1.6;

/** XP needed to go from `level` → `level+1`. Super-linear: L1→2 = 70,
 *  L2→3 = 112 — 182 total to cap. */
export const xpToNext = (level: number) =>
  Math.round(XP_BASE * XP_GROWTH ** (Math.max(1, level) - 1));

/** On death: lose this fraction of progress INTO the current level. Absolute
 *  loss scales with level cost, so the leader pays the most (anti-snowball);
 *  floor-protected to drop at most XP_DEATH_MAX_DELEVELS. */
export const XP_DEATH_PENALTY_FRAC = 0.35;
export const XP_DEATH_MAX_DELEVELS = 1;

/** Kill-streak window; refreshed per kill, hard reset on expiry/death. */
export const COMBO_WINDOW_MS = 4000;

/** Combo multiplier — now multiplies XP gain on kills (not orbs/chips). */
export const comboMult = (streak: number) => {
  if (streak >= 15) {
    return 5;
  }

  if (streak >= 10) {
    return 4;
  }

  if (streak >= 6) {
    return 3;
  }

  if (streak >= 3) {
    return 2;
  }

  return 1;
};

/** Shield-regen speed multiplier for a given level. Gentle (1.0 → 1.4 at cap):
 *  levelling makes your shield recover faster between fights without raising max
 *  HP, so the PvP eHP gap to a fresh player stays narrow. */
export const baseRegenMult = (level: number) => {
  const L = Math.max(1, Math.min(LEVEL_CAP, Math.round(level)));

  return 1 + 0.15 * (L - 1);
};

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

export interface Weapon {
  name: string;
  /** Damage fraction: asteroids chip min(power,1)×80 px radius; HP targets
   *  (UFO, enemies, players) take power×100 HP. */
  power: number;
  speed: number;
  length: number;
  width: number;
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
}

export const WEAPON_DEFAULT: Weapon = {
  arc: null,
  aura: false,
  boomerang: null,
  cluster: null,
  explosion: null,
  flak: null,
  homing: null,
  intervalMs: 250,
  jitterDeg: 1,
  length: 12,
  mine: false,
  mirror: false,
  name: "BEAM",
  pellets: 1,
  phasesRock: false,
  power: 0.25,
  range: 0,
  ricochet: null,
  sentry: false,
  sfx: "pulse",
  singularity: false,
  speed: 520,
  spreadDeg: 0,
  through: false,
  tint: 0xff_ff_ff,
  width: 1,
  windupMs: 0,
};

const baseWeaponTint = (L: number) => {
  if (L >= 3) {
    return 0xff_f1_a8;
  }

  if (L >= 2) {
    return 0xea_f6_ff;
  }

  return 0xff_ff_ff;
};

export const baseWeaponForLevel: (level: number) => Weapon = (level) => {
  const L = Math.max(1, Math.min(LEVEL_CAP, Math.round(level)));
  const power = 0.25 + 0.075 * (L - 1);
  const intervalMs = Math.round(250 - 26 * (L - 1));
  const tint = baseWeaponTint(L);

  return {
    ...WEAPON_DEFAULT,
    intervalMs,
    jitterDeg: L >= 3 ? 2 : 1,
    mirror: false,
    name: L <= 1 ? "BEAM" : `BEAM Lv${L}`,
    pellets: L,
    power,
    sfx: "pulse",
    spreadDeg: (L - 1) * 7,
    tint,
    width: L >= 3 ? 2 : 1,
  };
};

/** Per-level multiplier applied to a PICKED-UP special weapon, so specials get
 *  stronger as you level too (the base weapon scales via baseWeaponForLevel). */
export const weaponLevelMult = (level: number) => {
  const L = Math.max(1, Math.min(LEVEL_CAP, Math.round(level)));

  return 1 + (L - 1) * 0.18;
};

/** Return a level-scaled clone of a special weapon (more power + a bit faster).
 *  Same `name`, so HUD + pickup-stacking still match. L1 returns the input ref. */
export const scaleWeaponForLevel = (w: Weapon, level: number) => {
  const L = Math.max(1, Math.min(LEVEL_CAP, Math.round(level)));

  if (L <= 1) {
    return w;
  }

  const fireMult = 1 + (L - 1) * 0.07;

  return {
    ...w,
    intervalMs: Math.max(40, Math.round(w.intervalMs / fireMult)),
    power: w.power * weaponLevelMult(L),
  };
};

const defineWeapon = (
  w: Partial<Weapon> & Pick<Weapon, "name" | "power" | "tint" | "intervalMs" | "sfx">,
) => ({ ...WEAPON_DEFAULT, ...w });

export const WEAPONS_SPECIAL: Weapon[] = [
  defineWeapon({
    intervalMs: 70,
    jitterDeg: 3,
    length: 6,
    name: "TINY BEAM",
    power: 0.14,
    sfx: "rapid",
    speed: 700,
    tint: 0x83_e0_08,
  }),
  defineWeapon({
    intervalMs: 450,
    jitterDeg: 0,
    length: 16,
    name: "BLASTER",
    power: 0.9,
    sfx: "heavy",
    speed: 380,
    tint: 0xf4_00_7a,
    width: 3,
  }),
  defineWeapon({
    intervalMs: 380,
    jitterDeg: 0,
    length: 220,
    name: "LASER",
    power: 0.3,
    sfx: "zap",
    speed: 2400,
    through: true,
    tint: 0x8a_e3_fc,
    width: 2,
  }),
  defineWeapon({
    explosion: { growth: 700, range: 110 },
    intervalMs: 350,
    jitterDeg: 0,
    length: 10,
    name: "EXPLOSION BEAM",
    power: 0.22,
    sfx: "boom",
    speed: 900,
    tint: 0xff_99_00,
    width: 2,
  }),
  defineWeapon({
    intervalMs: 300,
    jitterDeg: 2,
    length: 7,
    name: "SCATTER",
    pellets: 6,
    power: 0.08,
    sfx: "scatter",
    speed: 480,
    spreadDeg: 36,
    tint: 0xff_d2_3e,
  }),
  defineWeapon({
    homing: { acquireRange: 420, turnDegPerSec: 220 },
    intervalMs: 550,
    jitterDeg: 0,
    length: 9,
    name: "HOMING",
    power: 0.6,
    sfx: "seek",
    speed: 380,
    tint: 0xc0_84_fc,
    width: 2,
  }),
  defineWeapon({
    arc: { castRange: 380, falloff: 0.7, hopRange: 240, jumps: 3 },
    intervalMs: 500,
    jitterDeg: 0,
    length: 0,
    name: "ARC",
    power: 0.28,
    sfx: "arc",
    speed: 0,
    tint: 0xff_f0_66,
  }),
  defineWeapon({
    boomerang: { outRange: 320, returnSpeed: 700 },
    intervalMs: 700,
    jitterDeg: 0,
    length: 14,
    name: "GLAIVE",
    power: 0.35,
    sfx: "glaive",
    speed: 540,
    through: true,
    tint: 0x2d_d4_bf,
    width: 2,
  }),
  defineWeapon({
    intervalMs: 1100,
    jitterDeg: 0,
    length: 320,
    name: "RAILGUN",
    power: 1.3,
    sfx: "rail",
    speed: 2800,
    through: true,
    tint: 0xd9_46_ef,
    width: 3,
    windupMs: 700,
  }),
  defineWeapon({
    explosion: { growth: 700, range: 90 },
    intervalMs: 700,
    jitterDeg: 0,
    length: 0,
    mine: true,
    name: "MINES",
    power: 0.7,
    sfx: "mine",
    speed: 0,
    tint: 0xf5_9e_0b,
  }),
  defineWeapon({
    explosion: { growth: 900, range: 140 },
    intervalMs: 900,
    jitterDeg: 0,
    length: 0,
    name: "NOVA",
    power: 0.38,
    sfx: "nova",
    speed: 0,
    tint: 0x60_a5_fa,
  }),
  defineWeapon({
    intervalMs: 420,
    length: 12,
    name: "RICOCHET",
    power: 0.35,
    ricochet: { bounces: 3, retargetRange: 400 },
    sfx: "pulse",
    speed: 560,
    tint: 0x00_ff_7f,
    width: 2,
  }),
  defineWeapon({
    flak: { burstDist: 280, fragRange: 160, fragments: 8 },
    intervalMs: 650,
    length: 12,
    name: "FLAK",
    power: 0.45,
    sfx: "boom",
    speed: 460,
    tint: 0xff_8c_00,
    width: 2,
  }),
  defineWeapon({
    cluster: { missiles: 3, staggerMs: 60 },
    homing: { acquireRange: 380, turnDegPerSec: 300 },
    intervalMs: 900,
    jitterDeg: 0,
    length: 8,
    name: "CLUSTER",
    power: 0.35,
    sfx: "seek",
    speed: 360,
    tint: 0xc4_b5_fd,
  }),
  defineWeapon({
    intervalMs: 900,
    jitterDeg: 0,
    length: 30,
    name: "DRILL",
    power: 1,
    sfx: "drill",
    speed: 240,
    through: true,
    tint: 0xb4_53_09,
    width: 8,
  }),
  defineWeapon({
    intervalMs: 70,
    jitterDeg: 7,
    length: 10,
    name: "PLASMA CONE",
    power: 0.11,
    range: 150,
    sfx: "plasma",
    speed: 520,
    tint: 0xff_5e_3a,
    width: 3,
  }),
  defineWeapon({
    intervalMs: 400,
    jitterDeg: 0,
    length: 240,
    name: "PHASE LANCE",
    phasesRock: true,
    power: 0.45,
    sfx: "zap",
    speed: 2200,
    through: true,
    tint: 0xdf_fb_ff,
  }),
  defineWeapon({
    intervalMs: 200,
    length: 10,
    mirror: true,
    name: "MIRROR",
    power: 0.18,
    sfx: "pulse",
    speed: 560,
    tint: 0xb8_c2_cc,
    width: 2,
  }),
  defineWeapon({
    arc: { castRange: 120, falloff: 1, hopRange: 0, jumps: 0 },
    aura: true,
    intervalMs: 180,
    jitterDeg: 0,
    length: 0,
    name: "TESLA AURA",
    power: 0.27,
    sfx: "tesla",
    speed: 0,
    tint: 0x00_aa_ff,
  }),
  defineWeapon({
    intervalMs: 280,
    length: 12,
    name: "SENTRY",
    power: 0.25,
    sentry: true,
    sfx: "sentry",
    speed: 520,
    tint: 0xfb_bf_24,
  }),
  defineWeapon({
    explosion: { growth: 600, range: 90 },
    intervalMs: 1500,
    jitterDeg: 0,
    length: 0,
    name: "SINGULARITY",
    power: 1,
    range: 216,
    sfx: "singularity",
    singularity: true,
    speed: 180,
    tint: 0x7c_3a_ed,
    width: 2,
  }),
  defineWeapon({
    explosion: { growth: 600, range: 120 },
    intervalMs: 2600,
    jitterDeg: 0,
    length: 0,
    name: "GRAVITON WELL",
    power: 0.6,
    range: 220,
    sfx: "singularity",
    singularity: true,
    speed: 200,
    tint: 0x43_38_ca,
    width: 2,
  }),
  defineWeapon({
    explosion: { growth: 1100, range: 360 },
    intervalMs: 2000,
    jitterDeg: 0,
    length: 0,
    name: "SUPERNOVA",
    power: 1,
    sfx: "nova",
    speed: 0,
    tint: 0xfd_e0_47,
    windupMs: 500,
  }),
  defineWeapon({
    cluster: { missiles: 6, staggerMs: 90 },
    homing: { acquireRange: 440, turnDegPerSec: 260 },
    intervalMs: 1400,
    jitterDeg: 0,
    length: 8,
    name: "SEEKER SWARM",
    power: 0.22,
    sfx: "seek",
    speed: 340,
    tint: 0xf4_72_b6,
    width: 2,
  }),
  defineWeapon({
    arc: { castRange: 460, falloff: 0.78, hopRange: 320, jumps: 6 },
    intervalMs: 650,
    jitterDeg: 0,
    length: 0,
    name: "CHAIN REACTOR",
    power: 0.3,
    sfx: "arc",
    speed: 0,
    tint: 0x22_d3_ee,
    width: 2,
  }),
  defineWeapon({
    flak: { burstDist: 110, fragRange: 150, fragments: 14 },
    intervalMs: 700,
    length: 12,
    name: "PLASMA STORM",
    power: 0.4,
    sfx: "boom",
    speed: 520,
    tint: 0xa3_e6_35,
    width: 2,
  }),
];

/** FLAK fragments: ordinary beams (own hitIds, serialized, PvP-live) spawned
 *  by the shell burst; never trigger-fired, so intervalMs is inert. */
export const FLAK_FRAG_WEAPON: Weapon = {
  arc: null,
  aura: false,
  boomerang: null,
  cluster: null,
  explosion: null,
  flak: null,
  homing: null,
  intervalMs: 9999,
  jitterDeg: 0,
  length: 6,
  mine: false,
  mirror: false,
  name: "FLAK FRAG",
  pellets: 1,
  phasesRock: false,
  power: 0.12,
  range: 0,
  ricochet: null,
  sentry: false,
  sfx: "boom",
  singularity: false,
  speed: 420,
  spreadDeg: 0,
  through: false,
  tint: 0xff_b0_66,
  width: 1,
  windupMs: 0,
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

export const MINE_ARM_MS = 450;
export const MINE_TRIGGER_RADIUS = 60;
export const MINE_LIFETIME_MS = 6000;

/** Oldest detonates harmlessly (30% ring, no damage) when exceeded. */
export const MINE_MAX_LIVE = 5;

export const SENTRY_LIFETIME_MS = 12_000;
export const SENTRY_FIRE_MS = 500;

/** Turret acquire range (nearest enemy preferred, else nearest asteroid). */
export const SENTRY_RANGE = 480;

export const SINGULARITY_PULL_MS = 800;
export const SINGULARITY_PULL_RANGE = 220;

/** Drag speed at the fringe; scaled down near the center (d/100 clamp) so
 *  targets gather at the point instead of slingshotting through it. */
export const SINGULARITY_PULL_SPEED = 260;

/** GRAVITON WELL holds far longer than SINGULARITY (0.8s) — it herds, not nukes. */
export const GRAVITON_PULL_MS = 2400;

export const SHIELD_MAX = 100;

/** No damage this long → regen starts (Halo grammar at ~60% timescale). */
export const SHIELD_REGEN_DELAY_MS = 2500;

/** 0→100 in this long once running (rate = 66.7 HP/s). */
export const SHIELD_REGEN_FULL_MS = 1500;

/** Below this fraction: warning pulse + `shield_low` tone. */
export const SHIELD_LOW_FRACTION = 0.3;

/** Drain per source, on the 100 scale. Every cell that zeroes shieldHp = death. */
export const DMG = {
  BOSS_LANCE: 70,
  DRONE_SHOT: 30,
  ENEMY_HULL: 35,
  LANCER_CHARGE: 80,
  LANCER_HULL: 45,
  SNIPER_BOLT: 55,
  UFO_HULL: 50,
  WARDEN_MORTAR: 40,
  WASP_SHOT: 25,
} as const;

/** Boss phase-2 lances ride a distinct (faster) speed than the SNIPER so the
 *  speed→damage classifier can give them their heavier BOSS_LANCE damage. */
export const BOSS_LANCE_SHOT_SPEED = 820;

/** Enemy shots aren't source-tagged on the wire — speed identifies the kind, so
 *  each kind's shot damage and death cause are recovered from its bolt speed.
 *  (Both host and victim run this on the same serialized vx/vy, so they agree.) */
export const enemyShotHit = (speed: number) => {
  if (speed >= 800) {
    return { cause: "DREADNOUGHT", dmg: DMG.BOSS_LANCE };
  }

  if (speed >= 600) {
    return { cause: "SNIPER", dmg: DMG.SNIPER_BOLT };
  }

  if (speed <= 270) {
    return { cause: "DRONE", dmg: DMG.DRONE_SHOT };
  }

  return { cause: "WASP", dmg: DMG.WASP_SHOT };
};

/** Asteroid contact scales with rock size: r=5→25 … r=50→50 … r=80→68. */
export const asteroidContactDamage = (r: number) =>
  Math.min(70, Math.max(25, Math.round(20 + 0.6 * r)));

export const PVP_DAMAGE_MULT = 1;
export const PVP_MAX_SINGLE_HIT = 90;
export const PVP_HIT_IFRAME_MS = 120;
export const PVP_EXPLOSION_IFRAME_MS = 300;

/** After any hull/asteroid/UFO drain: bounce + immunity vs ALL contact. */
export const CONTACT_IFRAME_MS = 500;

/** Pickups are timed modifiers on top of the base shield, one at a time. */
export const SHIELD_MOD_DURATION_MS = 20_000;

export type ShieldModKind =
  | "overshield"
  | "reflect"
  | "ram"
  | "phase"
  | "siphon"
  | "aegis"
  | "bulwark"
  | "leech";

/** Index order on the wire (`ItemState.shieldIdx`) — APPEND-ONLY. */
export const SHIELD_MOD_KINDS: readonly ShieldModKind[] = [
  "overshield",
  "reflect",
  "ram",
  "phase",
  "siphon",
  "aegis",
  "bulwark",
  "leech",
];

export interface ShieldModSpec {
  name: string;
  tint: number;
}

export const SHIELD_MOD_SPECS = {
  aegis: { name: "AEGIS", tint: 0xfa_cc_15 },
  bulwark: { name: "BULWARK", tint: 0x94_a3_b8 },
  leech: { name: "LEECH FIELD", tint: 0x4a_de_80 },
  overshield: { name: "OVERSHIELD", tint: 0x7d_d3_fc },
  phase: { name: "PHASE", tint: 0xe2_e8_f0 },
  ram: { name: "RAM", tint: 0xff_b4_54 },
  reflect: { name: "REFLECT", tint: 0xc0_84_fc },
  siphon: { name: "SIPHON", tint: 0x34_d3_99 },
} satisfies Record<ShieldModKind, ShieldModSpec>;

/** BULWARK: incoming hits inside a frontal cone take BULWARK_FRONT_MULT damage;
 *  the rear is exposed (positional play). */
export const BULWARK_CONE_DEG = 140;
export const BULWARK_FRONT_MULT = 0.35;

/** LEECH FIELD: each of YOUR enemy kills within range heals this much. */
export const LEECH_FIELD_RANGE = 240;
export const LEECH_FIELD_HEAL = 10;

/** Base shield ring radius (hull r=8; mod halos sit at r=15). */
export const SHIELD_RING_RADIUS = 12;
export const SHIELD_RING_TINT = 0xcf_e3_ff;
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
export const PHASE_DURATION_MS = 1000;
export const PHASE_COOLDOWN_MS = 8000;

export const SIPHON_HEAL_ENEMY = 18;
export const SIPHON_HEAL_ASTEROID = 6;
export const SIPHON_HEAL_PLAYER = 40;

/** Heals can bank above 100… */
export const SIPHON_OVERHEAL_MAX = 130;

/** …but the portion above 100 bleeds off and never regens. */
export const SIPHON_OVERHEAL_DECAY_PER_S = 8;

/** Replaces 2_500 while held. 1.4s (not 0.9s) so a lone WASP's 2.2s burst
 *  cycle still out-paces regen — design F.2: a wasp must still kill. */
export const AEGIS_REGEN_DELAY_MS = 1400;
export const AEGIS_REGEN_MULT = 1.6;

export type BoosterKind = "overdrive" | "nitro" | "repair" | "twin" | "magnet" | "salvage";

/** Index order on the wire (`ItemState.boosterIdx`) — APPEND-ONLY. */
export const BOOSTER_KINDS: readonly BoosterKind[] = [
  "overdrive",
  "nitro",
  "repair",
  "twin",
  "magnet",
  "salvage",
];

export interface BoosterSpec {
  name: string;
  tint: number;
  durationMs: number;
}

export const BOOSTER_SPECS = {
  magnet: { durationMs: 25_000, name: "MAGNET", tint: 0x38_bd_f8 },
  nitro: { durationMs: 15_000, name: "NITRO", tint: 0xf9_73_16 },
  overdrive: { durationMs: 15_000, name: "OVERDRIVE", tint: 0xfa_cc_15 },
  repair: { durationMs: 0, name: "REPAIR", tint: 0x4a_de_80 },
  salvage: { durationMs: 20_000, name: "SALVAGE", tint: 0xfb_bf_24 },
  twin: { durationMs: 20_000, name: "TWIN", tint: 0xa7_8b_fa },
} satisfies Record<BoosterKind, BoosterSpec>;

/** SALVAGE: XP-orb pickups are worth this multiple while held. */
export const SALVAGE_MULT = 2;

/** intervalMs & windupMs × this at fire time (+50% rate). */
export const OVERDRIVE_RATE_MULT = 0.667;
export const NITRO_ACCEL_MULT = 1.4;
export const NITRO_MAX_SPEED_MULT = 1.4;
export const TWIN_POWER_MULT = 0.6;
export const TWIN_ORBIT_RADIUS = 28;
export const TWIN_ORBIT_DEG_PER_S = 120;
export const MAGNET_RANGE = 260;
export const MAGNET_PULL_SPEED = 140;

export type LootClass = "shield" | "booster" | "weapon";

export const LOOT_CLASSES: readonly LootClass[] = ["shield", "booster", "weapon"];

/** Fodder (drone/wasp) kill item chance. */
export const FODDER_DROP_CHANCE = 0.18;

/** Asteroid destroy item chance. */
export const ASTEROID_DROP_CHANCE = 0.11;

/** Class split once a drop is happening (relative weights, v2 ratios kept). */
export const LOOT_CLASS_WEIGHTS: readonly { cls: LootClass; weight: number }[] = [
  { cls: "shield", weight: 18 },
  { cls: "booster", weight: 15 },
  { cls: "weapon", weight: 12 },
];

/** Child tables ([kind, integer weight] entries — every kind listed once).
 *  Weapon child roll: uniform over WEAPONS_SPECIAL. */
export const LOOT_SHIELD_WEIGHTS: readonly (readonly [ShieldModKind, number])[] = [
  ["overshield", 4],
  ["reflect", 3],
  ["ram", 3],
  ["phase", 3],
  ["siphon", 3],
  ["aegis", 2],
  ["bulwark", 3],
  ["leech", 2],
];

export const LOOT_BOOSTER_WEIGHTS: readonly (readonly [BoosterKind, number])[] = [
  ["overdrive", 4],
  ["nitro", 3],
  ["repair", 3],
  ["twin", 3],
  ["magnet", 2],
  ["salvage", 3],
];

/** Per-class pity: a kill that doesn't drop class X increments X's counter;
 *  at threshold the next roll forces it (ripe-priority shield > booster > weapon). */
export const LOOT_PITY = { booster: 9, shield: 8, weapon: 12 } satisfies Record<LootClass, number>;

/** Loot rolls that would exceed this many items in flight are skipped (UFO bypasses). */
export const ITEMS_MAX_LIVE = 6;

/** Roll the class split (always lands on a class; the chance gate is upstream). */
export const rollLootClass = () => {
  const total = LOOT_CLASS_WEIGHTS.reduce((sum, e) => sum + e.weight, 0);
  let roll = rand() * total;

  for (const e of LOOT_CLASS_WEIGHTS) {
    roll -= e.weight;

    if (roll <= 0) {
      return e.cls;
    }
  }

  return "weapon";
};

/** Roll a child table of [key, integer weight] entries. */
export const rollWeightedKey = <K extends string>(entries: readonly (readonly [K, number])[]) => {
  const total = entries.reduce((sum, [, w]) => sum + w, 0);
  let roll = rand() * total;

  for (const [key, w] of entries) {
    roll -= w;

    if (roll <= 0) {
      return key;
    }
  }

  const last = entries.at(-1);

  if (!last) {
    throw new Error("rollWeightedKey: empty table");
  }

  return last[0];
};

export type EnemyKind =
  | "drone"
  | "wasp"
  | "lancer"
  | "splitter"
  | "warden"
  | "sniper"
  | "spawner"
  | "dreadnought";

export interface EnemySpec {
  name: string;
  tint: number;
  hitRadius: number;
  hp: number;
  /** XP awarded on kill (combo-multiplied via registerKill). */
  xp: number;
}

/** v3 fodder rule: one NORMAL BEAM hit = power 0.25 x 100 = 25 HP, so
 *  fodder (drone, wasp) hp <= 25 and dies to a single default shot.
 *  Splitter children are drones -> also 1-shot. Elite hp entries are the
 *  Lv1-ROOM base (qa-018): the host overwrites e.hp = eliteHp(kind, maxLevel)
 *  at spawn so elite TTK stays level-invariant (see ELITE_HP_BASE below).
 *  The v2 F.2 invariant is untouched by hp tuning: a lone DRONE still can't
 *  kill a dodging full-shield player (30 dmg / 2.8s cooldown vs 2.5s regen
 *  delay). */
export const ENEMY_SPECS = {
  dreadnought: { hitRadius: 60, hp: 14_000, name: "DREADNOUGHT", tint: 0xff_2d_2d, xp: 600 },
  drone: { hitRadius: 7, hp: 20, name: "DRONE", tint: 0xff_7a_6b, xp: 5 },
  lancer: { hitRadius: 9, hp: 160, name: "LANCER", tint: 0xd9_04_29, xp: 20 },
  sniper: { hitRadius: 8, hp: 35, name: "SNIPER", tint: 0xff_5e_c7, xp: 14 },
  spawner: { hitRadius: 14, hp: 500, name: "HIVE", tint: 0xc7_7d_ff, xp: 24 },
  splitter: { hitRadius: 12, hp: 240, name: "SPLITTER", tint: 0xff_95_80, xp: 16 },
  warden: { hitRadius: 16, hp: 520, name: "WARDEN", tint: 0xff_b3_47, xp: 28 },
  wasp: { hitRadius: 8, hp: 25, name: "WASP", tint: 0xff_47_57, xp: 12 },
} satisfies Record<EnemyKind, EnemySpec>;

/** Point-blank sustained DPS of baseWeaponForLevel(L): L1 100, L2 ~290, L3 ~606. */
export const baseBeamDps = (level: number) => {
  const w = baseWeaponForLevel(level);

  return (w.pellets * w.power * 100) / (w.intervalMs / 1000);
};

/** L1 1.0, L2 ~2.90, L3 ~6.06 — elite TTK becomes level-invariant by construction. */
export const eliteHpMult = (maxLevel: number) => baseBeamDps(maxLevel) / baseBeamDps(1);

/** Lv1-room elite HP (mirrors ENEMY_SPECS hp for these kinds). Kinds absent
 *  here (fodder, sniper, dreadnought) never route through eliteHp(). */
export const ELITE_HP_BASE: ReadonlyMap<EnemyKind, number> = new Map([
  ["lancer", 160],
  ["splitter", 240],
  ["warden", 520],
  ["spawner", 500],
]);

/** HP the host stamps on an elite at spawn (the bossHp pattern): base × the
 *  room's beam-DPS multiplier. Stamped once — a mid-fight level-up never
 *  retro-buffs a live elite. Lv3 room: lancer 970 / splitter 1,455 /
 *  warden 3,152 / hive 3,030. */
export const eliteHp = (kind: EnemyKind, maxLevel: number) => {
  const base = ELITE_HP_BASE.get(kind) ?? ENEMY_SPECS[kind].hp;

  return Math.round(base * eliteHpMult(maxLevel));
};

/** Kill XP for an enemy. Elites pay round(base × the multiplier their HP was
 *  stamped with at spawn — maxHp over the Lv1 base), so pts-per-second
 *  survives the durability retune and cost and reward move together;
 *  everything else (fodder, sniper, boss) pays the flat spec value. Read off
 *  the enemy itself: the shooter predicting the kill needs no view of who
 *  else is in the room. A Lv1 room pays exactly the pre-retune numbers. */
export const enemyKillXp = (e: Pick<EnemyState, "kind" | "maxHp">) => {
  const { xp } = ENEMY_SPECS[e.kind];
  const base = ELITE_HP_BASE.get(e.kind);

  return base === undefined ? xp : Math.round((xp * e.maxHp) / base);
};

/** Enemies never fire unless their target is within this range (≈ on screen). */
export const ENEMY_FIRE_RANGE = 600;

/** Never spawn within this distance of a living player. */
export const ENEMY_SPAWN_CLEARANCE = 900;

/** Debut rule: a type's first spawn suppresses other enemy spawns this long. */
export const ENEMY_DEBUT_SUPPRESS_MS = 5000;

/** Ring bias, seed wave and interval clamp apply while the arena is younger than
 *  this (≈ up to the first wave crest at t=45). */
export const EARLY_SPAWN_WINDOW_S = 45;

/** Ring outer radius around the anchor player. The inner radius is
 *  ENEMY_SPAWN_CLEARANCE (900) — past a 1280×720 viewport's half-diagonal
 *  (~734px), so spawns still materialize off-screen, yet close enough that a
 *  drone (70 px/s) is a visible converging threat within seconds. */
export const EARLY_SPAWN_RING_MAX = 1600;

/** Only fodder converges via the ring; elites keep the far edge entrance so
 *  their debuts stay telegraphed, not ambushes. */
export const EARLY_FODDER_KINDS: readonly EnemyKind[] = ["drone", "wasp"];

/** One-time debut wave once the safe opening ends: this many drones seeded in
 *  the ring at once (stays under the early enemy cap ≈4). This IS the drone
 *  debut — the usual debut-suppression window follows it. */
export const EARLY_FODDER_SEED_COUNT = 3;

/** The seed wave uses a tighter outer radius than ongoing early spawns: a
 *  drone closes ~70 px/s, so from ≤1050 the whole wave is a visible on-screen
 *  threat within ~4s of the safe opening ending (from 1600 it would take 12s+
 *  and the opening still reads empty). */
export const EARLY_SEED_RING_MAX = 1050;

/** Spawn-interval clamp inside the window: at intensity 0.2 the base curve
 *  waits 8s between (and before the FIRST) spawn. The caps still bound the
 *  early population, so totals are unchanged — the field just fills promptly. */
export const EARLY_SPAWN_INTERVAL_MS = 2500;

/** Control zone radius (px). */
export const BEACON_RADIUS = 420;

/** CHARGE telegraph length — no trickle, can't be contested. */
export const BEACON_CHARGE_S = 8;

/** ACTIVE (contestable) length. Total on-screen life = CHARGE + ACTIVE = 48s. */
export const BEACON_ACTIVE_S = 40;

/** The intensity director's macro-wave period (arenaIntensity hardcodes 90s);
 *  beacons are only eligible in the trough window at the start of each wave. */
export const BEACON_TROUGH_PERIOD_S = 90;

/** Spawn window: tSec mod 90 ∈ [0, this]. */
export const BEACON_SPAWN_WINDOW_S = 5;

/** Never during the opening/onboarding minute-and-a-half. */
export const BEACON_MIN_T_S = 90;

/** Min seconds between beacon STARTS — every other trough, so the net cadence
 *  is t≈90/270/450 (one per ~3 min; the spec states this cadence twice, so the
 *  interval is measured start-to-start: end-to-next-start comes to ~132s). */
export const BEACON_MIN_INTERVAL_S = 180;

/** Trickle cadence + amount: 3 XP/s to the SOLE controller (owner-simulated,
 *  flat — no per-level scaling; at LEVEL_CAP it honestly pays run-score only). */
export const BEACON_TICK_MS = 1000;
export const BEACON_XP_PER_TICK = 3;

/** Controlled at expiry: bonus XP + ONE guaranteed pity-fed loot crystal at
 *  the beacon center (chance=1, ITEMS_MAX_LIVE bypassed like UFO drops). */
export const BEACON_HOLD_BONUS_XP = 40;

/** Event tint family: solar gold + white core. Distinct from warden amber by
 *  geometry (a huge static hex ring). Keep gold off enemy and player kit. */
export const BEACON_TINT = 0xff_d1_66;

/** Placement: ≥ this far inside the barrier... */
export const BEACON_EDGE_MARGIN = 600;

/** ...and ≥ this far from every present player (fair approach run). If no
 *  candidate satisfies it, the farthest-from-nearest-player candidate wins. */
export const BEACON_PLAYER_CLEARANCE = 900;

/** While CHARGE or ACTIVE: this fraction of new host enemy spawns lands on a
 *  ring around the beacon instead of the usual placement (bias only — the
 *  intensity director's caps/weights are untouched). */
export const BEACON_LURE_FRACTION = 0.5;

/** Lure-spawn ring around the beacon center (~1100px per spec). */
export const BEACON_LURE_RING_MIN = 1000;
export const BEACON_LURE_RING_MAX = 1200;

/** Existing drones/wasps within this range steer toward the beacon center
 *  (nearest-of semantics: a player inside the zone is closer and wins). */
export const BEACON_RETARGET_RANGE = 1600;

/** Contested ring strobe rate (gold↔white). */
export const BEACON_CONTEST_STROBE_HZ = 4;

/** BEACON shared entry — the ONE nullable SharedState field the event adds
 *  (~90B on the wire). Six scalars, host-written; clients derive phase +
 *  countdown locally: t < activeAt → CHARGE, else ACTIVE until diesAt. */
export type BeaconState = {
  x: number;
  y: number;
  /** Host-clock epoch-ms the zone arms (CHARGE ends). */
  activeAt: number;
  /** Host-clock epoch-ms the zone expires. */
  diesAt: number;
  /** Sole occupant during ACTIVE; null when empty or contested. */
  controllerId: string | null;
  contested: boolean;
};

export const SECTOR_LENGTH_S = 540;

/** Guaranteed DREADNOUGHT beat: at this sector-relative second a sector that
 *  has not seen a dreadnought spawn yet force-spawns one (host rule, additive
 *  to the organic gates — see hostMaybeSpawnBoss). */
export const SECTOR_BOSS_AT_S = 405;

/** Recap banner show length at each boundary (non-blocking DOM). */
export const SECTOR_RECAP_SHOW_S = 10;

/** Standings pulse length at each SECTOR_PULSE_AT_S beat. */
export const SECTOR_PULSE_S = 5;

/** Pulse beats: the two intensity troughs with no beacon (rel 90/270 host the
 *  beacon cadence; rel 450's slot normally belongs to the boss fight). */
export const SECTOR_PULSE_AT_S = [180, 360] as const;

export const sectorIdx = (tSec: number) => Math.floor(Math.max(0, tSec) / SECTOR_LENGTH_S);
export const sectorRelT = (tSec: number) => Math.max(0, tSec) % SECTOR_LENGTH_S;

const CALLSIGN_TABLE = [
  "KESTREL",
  "VECTOR",
  "NOMAD",
  "TALON",
  "ORION",
  "CIPHER",
  "HAVOC",
  "ZENITH",
  "QUASAR",
  "RAPTOR",
  "SABLE",
  "COMET",
  "VORTEX",
  "PHANTOM",
  "AURORA",
  "STRIKER",
] as const;

/* oxlint-disable no-bitwise -- FNV-1a hash over the peer id */
export const callsign = (peerId: string) => {
  let h = 0x81_1c_9d_c5;

  for (let i = 0; i < peerId.length; i += 1) {
    h ^= peerId.codePointAt(i) ?? 0;
    h = Math.imul(h, 0x01_00_01_93);
  }

  h >>>= 0;
  const name = CALLSIGN_TABLE[h % CALLSIGN_TABLE.length] ?? "NOMAD";
  const suffix = ((h >>> 8) & 0xff).toString(16).toUpperCase().padStart(2, "0");

  return `${name}-${suffix}`;
};
/* oxlint-enable no-bitwise */

/** Pip inset from the viewport edge, in SCREEN px (scaled by 1/zoom). */
export const PIP_EDGE_MARGIN = 30;

/** Pip glyph size in SCREEN px (scaled by 1/zoom). */
export const PIP_SIZE = 9;

/** Debut-wave pips (qa-007): while the arena is younger than the early
 *  window AND no hostile is on-viewport, point at the nearest few inbound
 *  enemies so an empty screen still telegraphs where the action is. */
export const DEBUT_PIP_MAX = 3;

export const DRONE_SPEED = 70;
export const DRONE_TURN_DEG_PER_S = 90;
export const DRONE_SHOT_SPEED = 200;
export const DRONE_FIRE_CONE_DEG = 20;
export const DRONE_COOLDOWN_MS = 2800;
export const DRONE_TELEGRAPH_MS = 400;

export const WASP_SPEED = 240;
export const WASP_ORBIT_RADIUS = 280;
export const WASP_WOBBLE_AMP = 40;
export const WASP_WOBBLE_HZ = 1.2;
export const WASP_BURST_COUNT = 3;
export const WASP_BURST_GAP_MS = 110;
export const WASP_SHOT_SPEED = 340;
export const WASP_COOLDOWN_MS = 2200;
export const WASP_TELEGRAPH_MS = 350;

export const LANCER_CRUISE_SPEED = 90;
export const LANCER_CHARGE_SPEED = 640;
export const LANCER_WINDUP_MS = 600;
export const LANCER_CHARGE_MS = 700;
export const LANCER_RECOVER_MS = 1200;
export const LANCER_CHARGE_HIT_RADIUS = 12;

/** Telegraph dashed line length = full charge travel (640 × 0.7). */
export const LANCER_CHARGE_RANGE = 448;

export const SPLITTER_SPEED = 50;
export const SPLITTER_CHILDREN = 3;
export const SPLITTER_CHILD_SPEED = 150;
export const SPLITTER_GRACE_MS = 600;

export const WARDEN_SPEED = 55;
export const WARDEN_TURN_DEG_PER_S = 45;
export const WARDEN_SHIELDED_DR = 0.2;
export const WARDEN_VENT_DR = 2;
export const WARDEN_VENT_MS = 1400;
export const WARDEN_COOLDOWN_MS = 3200;
export const WARDEN_TELEGRAPH_MS = 700;
export const WARDEN_SHOT_SPEED = 220;
export const WARDEN_FIRE_RANGE = 700;

export const SNIPER_SPEED = 130;
export const SNIPER_KEEP_DIST = 520;
export const SNIPER_AIM_MS = 900;
export const SNIPER_COOLDOWN_MS = 2600;
export const SNIPER_SHOT_SPEED = 720;
export const SNIPER_FIRE_RANGE = 1100;

export const SPAWNER_SPEED = 35;
export const SPAWNER_PULSE_MS = 4200;
export const SPAWNER_TELEGRAPH_MS = 650;
export const SPAWNER_BROOD_PER_PULSE = 2;
export const SPAWNER_BROOD_CAP = 6;
export const MITE_GRACE_MS = 500;

/** qa-009 durability retune: base BEAM Lv3 melts ~570 boss-HP/s point-blank
 *  (3 pellets x 40 HP / 198ms), so 4k HP died in ~7s on-target and phase 3
 *  lasted 2.2s. 14k = ~25s on-target solo -> a 45-60s real fight once dodging
 *  the P1 fans / P2 lances / P3 novas is factored in. Specials (2-3x beam) and
 *  full rooms melt faster — BOSS_PHASE_MIN_MS is the floor that protects the
 *  script, not this number. Lethality and payout deliberately untouched. */
export const BOSS_HP_BASE = 14_000;

/** Each extra player adds 25% of base HP: co-op fights are still faster per
 *  head (grouping is rewarded) but a 4p room no longer deletes the boss. */
export const BOSS_HP_PER_PLAYER = 3500;

/** Per-phase minimum duration (qa-009): damage cannot push HP across the next
 *  phase boundary (phase 3's boundary = death) until the current phase has
 *  run this long, so every phase's attack script always expresses — even
 *  against stacked specials in a full room. Host-side clamp in
 *  hostDamageEnemy; worst-case fight length vs infinite DPS = 3 x this. */
export const BOSS_PHASE_MIN_MS = 8000;
export const BOSS_SPEED = 70;
export const BOSS_ORBIT_RADIUS = 700;
export const BOSS_P1_CYCLE_MS = 2200;
export const BOSS_P1_TELEGRAPH_MS = 600;
export const BOSS_P1_SPREAD_COUNT = 7;
export const BOSS_P1_SPREAD_DEG = 60;
export const BOSS_P2_CYCLE_MS = 2600;
export const BOSS_P2_AIM_MS = 1100;
export const BOSS_P2_LANCES = 3;
export const BOSS_P3_CYCLE_MS = 1900;
export const BOSS_P3_TELEGRAPH_MS = 700;
export const BOSS_P3_NOVA_COUNT = 16;
export const BOSS_P3_MITES = 4;

/** Max live mites the boss can sustain (phase 3 births stop adding past this —
 *  prevents unbounded enemies[] growth over a long phase-3). */
export const BOSS_BROOD_CAP = 16;
export const BOSS_SHOT_SPEED = 260;
export const BOSS_CONTACT_DMG = 60;

/** Boss spawns only near a wave peak (max intensity 2.6) … */
export const BOSS_SPAWN_INTENSITY = 2.3;

/** … and only in a busy room; small rooms wait out the cooldown then get one. */
export const BOSS_SPAWN_MIN_PLAYERS = 4;
export const BOSS_SPAWN_COOLDOWN_MS = 150_000;
export const BOSS_REWARD_SHARDS = 30;

/** Boss HP scales with the room so a zerg can't delete it instantly. */
export const bossHp = (playerCount: number) =>
  BOSS_HP_BASE + Math.max(0, playerCount - 1) * BOSS_HP_PER_PLAYER;

/** Phase is DERIVED from HP, so a migrated host resumes the right phase free. */
export const bossPhase: (hp: number, maxHp: number) => 1 | 2 | 3 = (hp, maxHp) => {
  const f = maxHp > 0 ? hp / maxHp : 1;

  if (f > 0.66) {
    return 1;
  }

  if (f > 0.33) {
    return 2;
  }

  return 3;
};

export const ENEMY_SHOT_TINT = 0xff_3b_30;
export const ENEMY_SHOT_LEN = 8;
export const ENEMY_SHOT_WIDTH = 2;
export const ENEMY_SHOT_TTL_MS = 4000;

/** v3 swarm tuning: fodder weight ramps with intensity so peaks read as
 *  swarms of 1-shot units, not elite walls. At I=2.6: drone 24.4, wasp 25.2,
 *  lancer 11.9, splitter 7 -> fodder ~72% of spawns (was ~58%). Elites are
 *  still gated by the debut grammar (first appearance is solo). */
export const enemySpawnWeight = (kind: EnemyKind, intensity: number) => {
  switch (kind) {
    case "drone": {
      return 10 + 9 * Math.max(0, intensity - 1);
    }

    case "wasp": {
      return 12 * Math.max(0, intensity - 0.5);
    }

    case "lancer": {
      return 7 * Math.max(0, intensity - 0.9);
    }

    case "splitter": {
      return 5 * Math.max(0, intensity - 1.2);
    }

    case "sniper": {
      return 6 * Math.max(0, intensity - 1);
    }

    case "warden": {
      return 4 * Math.max(0, intensity - 1.4);
    }

    case "spawner": {
      return 3.5 * Math.max(0, intensity - 1.5);
    }

    case "dreadnought": {
      return 0;
    }

    default: {
      const unhandled: never = kind;
      throw new Error("unhandled case", { cause: unhandled });
    }
  }
};

/** The ROLLABLE enemy kinds (boss is excluded — it has a dedicated trigger). */
export const ENEMY_KINDS: readonly EnemyKind[] = [
  "drone",
  "wasp",
  "lancer",
  "splitter",
  "sniper",
  "warden",
  "spawner",
];

/** Breather rule: once the live count exceeds the cap by this slack (splitter
 *  children bypass the cap), the host quietly despawns the enemy farthest from
 *  all living players — no loot, no score. */
export const ENEMY_DESPAWN_SLACK = 2;

/** Only despawn an enemy farther than this from EVERY living player. */
export const ENEMY_DESPAWN_MIN_DIST = 1200;

/** At most one breather despawn per this interval (post-peak crowds must
 *  clear inside the breather window at the v2 caps). */
export const ENEMY_DESPAWN_INTERVAL_MS = 1500;

/** My pose, every client. The per-tick state is a handful of primitives (shots
 *  travel as `fire` events), but every pose fans out to up to 31 peers: at
 *  20 Hz a full room relays a third fewer messages than at 30, and the remote
 *  render delay still holds two updates. */
export const PLAYER_NET_HZ = 20;

/** Host world snapshots. Every enemy rides each one, so this stays at 20 Hz. */
export const WORLD_NET_HZ = 20;

/** The least a remote ship (and its shots) is drawn behind the moment its
 *  updates arrive (ms): two 20 Hz send intervals, enough to ride out arrival
 *  jitter on a good route. The relay itself is learnt per sender, and so is
 *  the jitter: the delay grows past this when the stream needs more
 *  (net/peer-roster.ts). */
export const REMOTE_RENDER_DELAY_MS = 100;

/** Interest radius (px, on the player-state `x`/`y`): two players farther
 *  apart stop receiving each other's state — the host still sees everyone.
 *  The widest view served, 3840×2160 at zoom 1, reaches 2203 px to its
 *  corner; the rest covers two NITRO ships closing (840 px/s) for the
 *  ~200 ms a reveal takes, so nobody pops in on screen. */
export const INTEREST_RADIUS = 2400;

/** The host's relay of every player's sector score (guests rank the players
 *  out of their interest range from it). */
export const STANDINGS_RELAY_HZ = 2;

export const MINIMAP_W = 140;
export const MINIMAP_H = Math.round(MINIMAP_W * (WORLD_H / WORLD_W));
export const MINIMAP_PAD = 12;

export type Vec = {
  x: number;
  y: number;
};

export type AsteroidState = {
  id: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  radius: number;
  /** Draw-only spin, local to each client. The jagged outline never rides the
   *  wire either: every client derives the same unit shape from the id
   *  (asteroidUnitVerts) and scales it by the live radius — which also keeps
   *  the scale-on-damage "no shape pop" behavior. */
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
  /** 0 = none. While now < this: wind-up visuals. */
  telegraphUntil: number;
  /** LANCER only: locked-vector charge window. */
  chargeUntil: number;
  /** Last shot/brood time (cosmetic recoil only). */
  attackAt: number;
  /** Damage flicker, as UFO. */
  blinkUntil: number;
  /** SPLITTER children: can't fire/kill while flashing in. */
  graceUntil: number;
  /** WARDEN/BOSS: max HP, for the HP-bar render + boss phase derivation. 0 = N/A. */
  maxHp: number;
  /** SNIPER/BOSS laser sights: locked target points during a telegraph; cleared
   *  after firing. Empty otherwise. */
  lances: Vec[];
  /** WARDEN: shield up (heavy DR) vs venting (extra damage). */
  shielded: boolean;
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
 * Host-owned world: the host's working copy, and each guest's dead-reckoned
 * copy of it. On the wire every entity is a row keyed by id that changes only
 * when the entity spawns, dies, turns or changes (net/world-wire.ts); host
 * deadlines in a guest's copy are already converted to the guest's own clock.
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
  /** v6 BEACON arena event (dir-004) — null between events. */
  beacon: BeaconState | null;
  /** Epoch-ms wall clock of arena start — the intensity director's t=0.
   *  Lives in sharedState so it survives host migration. */
  arenaEpoch: number;
  /** dir-006: last sectorIdx in which a dreadnought spawned (organic or
   *  forced) — the guaranteed-boss satisfied-marker. Host-written, -1 until
   *  the first spawn; lives here so a migrated host never double-guarantees.
   *  Absent on legacy snapshots → the local copy's value carries over. */
  sectorBossIdx: number;
  /** Play-area bounds (host-owned, grow-only with player count). All clients
   *  clamp/spawn/cull/render the barrier to these so they agree. The VISUAL
   *  extent (starfield + mask) stays the fixed WORLD_W/H max; the gap between
   *  the barrier and the max just reads as more star-bleed. */
  playW: number;
  playH: number;
};

export type ShieldModNetState = {
  kind: ShieldModKind;
  /** ram-armed / reflect->40 / phase-ready; other kinds always true. */
  active: boolean;
  /** PHASE intangibility window is live. */
  phased: boolean;
};

/** A live booster and its local expiry — the DEV summary's view of my boosts. */
export type BoostNetState = {
  kind: BoosterKind;
  until: number;
};

/**
 * A player's networked state, decoded (net/wire-read.ts). Each client writes
 * its own as flat primitives at PLAYER_NET_HZ, so a key that did not change
 * never rides the wire. Shots are not here: every volley is a `fire` event
 * that each client re-simulates (sys/volley.ts, sys/remote-fire.ts).
 */
export type PlayerNetState = {
  /** Server time (`client.serverNow()`) when this state left: the stamp
   *  remote ships are interpolated against (net/peer-roster.ts). */
  t: number;
  /** Pose. For a remote player these hold the pose INTERPOLATED for this
   *  frame, so every reader draws and hit-tests the ship where it is drawn. */
  x: number;
  y: number;
  angle: number;
  vx: number;
  vy: number;
  alive: boolean;
  /** In the arena. False = cleanly docked out (paused-as-spectator): remotes
   *  drop the ship with NO death FX, distinct from a real death (alive:false,
   *  present:true). */
  present: boolean;
  invuln: boolean;
  /** Current level (1..LEVEL_CAP). */
  level: number;
  /** XP into the current level. */
  xp: number;
  streak: number;
  /** dir-006 sector chase: pts this sector (accrues with runXp pre-cap-
   *  discard, owner-reset at each boundary). Pure scoreboard — confers zero
   *  power. */
  sectorScore: number;
  weaponName: string;
  /** Base shield 0–100; remotes render the ring straight from this. */
  shieldHp: number;
  /** OVERSHIELD bonus layer 0–75. */
  overHp: number;
  shieldMod: ShieldModNetState | null;
  /** The live boosters other clients act on: the NITRO flame and TWIN drone
   *  are drawn, a MAGNET holder pulls the host's pickups. */
  nitro: boolean;
  twin: boolean;
  magnet: boolean;
  /** 0–1 windup charge; remotes draw the charging nose glow. */
  windup: number;
  /** TESLA AURA is live (weapon held + firing): victims inside its range
   *  adjudicate their own drain from this, RAM-style. */
  tesla: boolean;
};

export const randomWorldPoint = (
  marginX = RESPAWN_EDGE_MARGIN,
  marginY = marginX,
  w = BASE_WORLD_W,
  h = BASE_WORLD_H,
) => ({
  x: marginX + rand() * (w - marginX * 2),
  y: marginY + rand() * (h - marginY * 2),
});

/** Deterministic per-id unit outline (fractions of radius). Outline jitter is
 *  draw-only (collision is radius-based); deriving it from the id keeps it off
 *  the 20Hz wire entirely while every client still draws the identical rock.
 *  Not the seeded gameplay stream: ids are identity, never gameplay. */
/* oxlint-disable no-bitwise -- FNV-1a + LCG over the id */
export const asteroidUnitVerts = (id: string) => {
  let h = 0x81_1c_9d_c5;

  for (let i = 0; i < id.length; i += 1) {
    h ^= id.codePointAt(i) ?? 0;
    h = Math.imul(h, 0x01_00_01_93);
  }

  let s = h >>> 0;

  const roll = () => {
    s = (Math.imul(s, 1_664_525) + 1_013_904_223) >>> 0;

    return s / 0x1_00_00_00_00;
  };

  const verts: Vec[] = [];

  for (let i = 0; i < ASTEROID_VERTEX_COUNT; i += 1) {
    const r = 0.5 + roll() * 0.5;
    const a = (Math.PI * 2 * i) / ASTEROID_VERTEX_COUNT;
    verts.push({ x: Math.cos(a) * r, y: Math.sin(a) * r });
  }

  return verts;
};
/* oxlint-enable no-bitwise */

/** Short wire id. Entity ids only need per-room uniqueness among a few hundred
 *  live entities; crypto.randomUUID's 36 chars cost ~15KB per worst-case 32p
 *  snapshot (dir-002 audit). 8 base36 chars = 2.8e12 space — collision odds
 *  over a room's lifetime are ~1e-5. Math.random on purpose: ids are identity,
 *  never gameplay, so they must not consume the seeded stream. */
export const entityId = () =>
  Math.floor(Math.random() * 36 ** 8)
    .toString(36)
    .padStart(8, "0");

/** Pick a point just past a random play-area edge, plus an inward heading. */
export const edgeSpawn = (margin: number, w = BASE_WORLD_W, h = BASE_WORLD_H) => {
  const side = Math.floor(rand() * 4);
  const spread = rand() * (Math.PI / 2);

  if (side <= 1) {
    const y = -margin + rand() * (h + margin * 2);
    const x = side === 0 ? -margin : w + margin;
    const ang = side === 0 ? spread - Math.PI * 0.25 : spread + Math.PI * 0.75;

    return { ang, x, y };
  }

  const x = -margin + rand() * (w + margin * 2);
  const y = side === 2 ? -margin : h + margin;
  const ang = side === 2 ? spread + Math.PI * 0.25 : spread - Math.PI * 0.75;

  return { ang, x, y };
};

/** Point in the ring [minR..maxR] around (px,py), clamped into the play bounds
 *  with `margin` inset; the heading aims back at the anchor. Clamping near a
 *  corner can pull the point under minR — callers re-check clearance and
 *  re-roll. Uniform radius (not area-uniform) slightly biases inward, which is
 *  the point: early threats err closer. */
export const ringSpawnPoint = (
  px: number,
  py: number,
  minR: number,
  maxR: number,
  w = BASE_WORLD_W,
  h = BASE_WORLD_H,
  margin = 40,
) => {
  const a = rand() * Math.PI * 2;
  const r = minR + rand() * (maxR - minR);
  const x = Math.min(w - margin, Math.max(margin, px + Math.cos(a) * r));
  const y = Math.min(h - margin, Math.max(margin, py + Math.sin(a) * r));

  return { ang: Math.atan2(py - y, px - x), x, y };
};

export const spawnAsteroidState = (w = BASE_WORLD_W, h = BASE_WORLD_H) => {
  const { x, y, ang } = edgeSpawn(ASTEROID_MAX_RADIUS, w, h);
  const radius = ASTEROID_MIN_RADIUS + rand() * (ASTEROID_MAX_RADIUS - ASTEROID_MIN_RADIUS);
  const speed = asteroidSpeed(radius);

  return {
    id: entityId(),
    radius,
    rot: 0,
    vx: Math.cos(ang) * speed,
    vy: Math.sin(ang) * speed,
    x,
    y,
  };
};

/** qa-013: rocks parked inside the opening viewport so the first playable
 *  second has something to shoot (the 6s safe opening spawns no enemies and
 *  the seed field scatters across the whole arena). Sized to one-shot with
 *  the L1 beam (asteroidDestroyedBy: r < 25 at power .25); drift kept slow
 *  so they stay on screen through the opening. */
export const OPENING_ROCK_COUNT = 3;
export const OPENING_ROCK_MIN_R = 12;
export const OPENING_ROCK_MAX_R = 22;
export const OPENING_ROCK_DRIFT = 30;

export const spawnOpeningAsteroid = (x: number, y: number) => {
  const radius = OPENING_ROCK_MIN_R + rand() * (OPENING_ROCK_MAX_R - OPENING_ROCK_MIN_R);
  const ang = rand() * Math.PI * 2;

  return {
    id: entityId(),
    radius,
    rot: 0,
    vx: Math.cos(ang) * OPENING_ROCK_DRIFT,
    vy: Math.sin(ang) * OPENING_ROCK_DRIFT,
    x,
    y,
  };
};

export const spawnUfoState = (w = BASE_WORLD_W, h = BASE_WORLD_H) => {
  const { x, y } = edgeSpawn(30, w, h);

  return {
    blinkUntil: 0,
    destX: rand() * w,
    destY: rand() * h,
    hp: UFO_HP,
    id: entityId(),
    x,
    y,
  };
};

/** Generic item factory — every drop class ships through here. */
export const spawnItemState = (x: number, y: number, drop: ItemDrop) => {
  const ang = rand() * Math.PI * 2;

  return {
    diesAt: simNow() + ITEM_LIFETIME_MS,
    id: entityId(),
    vx: Math.cos(ang) * ITEM_SPEED,
    vy: Math.sin(ang) * ITEM_SPEED,
    x,
    y,
    ...drop,
  };
};

/** Score shard at (x,y) with a small position scatter + slow random drift,
 *  so a multi-shard drop fans out instead of stacking into one sprite. */
export const spawnShardState = (x: number, y: number) => {
  const ang = rand() * Math.PI * 2;
  const scatter = rand() * 10;

  return {
    diesAt: simNow() + SHARD_LIFETIME_MS,
    id: entityId(),
    vx: Math.cos(ang) * SHARD_DRIFT_SPEED,
    vy: Math.sin(ang) * SHARD_DRIFT_SPEED,
    x: x + Math.cos(ang) * scatter,
    y: y + Math.sin(ang) * scatter,
  };
};

export const spawnWeaponItemState = (x: number, y: number) =>
  spawnItemState(x, y, {
    kind: "weapon",
    weaponIdx: Math.floor(rand() * WEAPONS_SPECIAL.length),
  });

export const spawnEnemyState = (kind: EnemyKind, x: number, y: number) => ({
  angle: 0,
  attackAt: 0,
  blinkUntil: 0,
  chargeUntil: 0,
  graceUntil: 0,
  hp: ENEMY_SPECS[kind].hp,
  id: entityId(),
  kind,
  lances: [],
  maxHp: ENEMY_SPECS[kind].hp,
  shielded: kind === "warden",
  telegraphUntil: 0,
  vx: 0,
  vy: 0,
  x,
  y,
});

/** How long the party server has to admit this client (rendered frames, the
 *  SDK's `fallbackMs`) before it goes offline into a solo arena. */
export const OFFLINE_FALLBACK_MS = 4000;
