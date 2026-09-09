import { PhysicalGamepad, attachVirtualGamepad, safeAreaInset } from "@vibedgames/gamepad/phaser";
import type { Inset, PhaserGamepad } from "@vibedgames/gamepad/phaser";
import {
  createTouchControls,
  isOfflineRequested,
  notifyGameStarted,
  sealPointerEvents,
  setPauseHandlers,
  watchControlContext,
} from "@repo/embed";
import type { TouchControls } from "@repo/embed";
import { MultiplayerClient } from "@vibedgames/multiplayer";
import type { Player, PlayerMap } from "@vibedgames/multiplayer";
import type Phaser from "phaser";
import { BlendModes, Input, Math as PhaserMath, Scale, Scene, Scenes } from "phaser";

import { sfx } from "../audio/sfx";
import type { PlayOpts, SfxName } from "../audio/sfx";
import { WeaponMastery } from "../shared/weapon-mastery";
import type { MasteryShot } from "../shared/weapon-mastery";
import {
  buildControls,
  createStarfallPauseOverlay,
  ensureStyle as ensureControlsStyle,
} from "../pause-overlay";
import { AttractBattle } from "../fx/attract-battle";
import { FxPool, HITSPARK_SKIP_BUDGET, PARTICLE_SOFT_BUDGET } from "../render/fx-pool";
import { BattleBackdrop } from "../render/battle-backdrop";
import { BattleBeatDirector } from "../render/battle-beat";
import { REDUCED_MOTION } from "../render/battle-fx";
import { BossEncounters } from "../render/boss-encounters";
import { contactPoint, weaponLook } from "../render/combat-visuals";
import type { WeaponLook } from "../render/combat-visuals";
import type { FxImportance } from "../render/fx-pool";
import { enemyChargeDuration, enemyChargeProgress, usesLockedAim } from "../render/charge-progress";
import {
  asteroidToWire,
  beaconToWire,
  enemyShotToWire,
  enemyToWire,
  itemToWire,
  playerToWire,
  pullToWire,
  shardToWire,
  ufoToWire,
} from "../shared/wire";
import { fleetPose, hostileShotLook } from "../render/fleet-acting";
import { FlightHud } from "../render/flight-hud";
import { EdgePips } from "../render/edge-pips";
import type { PipTarget } from "../render/edge-pips";
import { EnergyBarrier } from "../render/energy-barrier";
import { Starfield } from "../render/starfield";
import { TraumaCamera } from "../render/trauma-camera";
import {
  OFFLINE_FALLBACK_MS,
  AEGIS_REGEN_DELAY_MS,
  AEGIS_REGEN_MULT,
  ARC_CAST_CONE_DEG,
  ARC_FIZZLE_LEN,
  ARC_RENDER_MS,
  arenaIntensity,
  ASTEROID_CULL_MARGIN,
  ASTEROID_DROP_CHANCE,
  ASTEROID_MAX_RADIUS,
  ASTEROID_MIN_RADIUS,
  ASTEROID_ROT_SPEED,
  ASTEROID_SEED_COUNT,
  asteroidCap,
  asteroidContactDamage,
  asteroidDestroyedBy,
  asteroidShardCount,
  asteroidSpawnIntervalMs,
  asteroidSpeed,
  asteroidUnitVerts,
  BASE_WORLD_H,
  BASE_WORLD_W,
  BEACON_ACTIVE_S,
  BEACON_CHARGE_S,
  BEACON_CONTEST_STROBE_HZ,
  BEACON_EDGE_MARGIN,
  BEACON_HOLD_BONUS_XP,
  BEACON_LURE_FRACTION,
  BEACON_LURE_RING_MAX,
  BEACON_LURE_RING_MIN,
  BEACON_MIN_INTERVAL_S,
  BEACON_MIN_T_S,
  BEACON_PLAYER_CLEARANCE,
  BEACON_RADIUS,
  BEACON_RETARGET_RANGE,
  BEACON_SPAWN_WINDOW_S,
  BEACON_TICK_MS,
  BEACON_TINT,
  BEACON_TROUGH_PERIOD_S,
  BEACON_XP_PER_TICK,
  SECTOR_BOSS_AT_S,
  SECTOR_LENGTH_S,
  SECTOR_PULSE_AT_S,
  SECTOR_PULSE_S,
  SECTOR_RECAP_SHOW_S,
  sectorIdx,
  sectorRelT,
  callsign,
  DEBUT_PIP_MAX,
  entityId,
  baseRegenMult,
  baseWeaponForLevel,
  scaleWeaponForLevel,
  playHeightForPlayers,
  playWidthForPlayers,
  BOOSTER_KINDS,
  BOOSTER_SPECS,
  BULWARK_CONE_DEG,
  BULWARK_FRONT_MULT,
  BOSS_BROOD_CAP,
  BOSS_CONTACT_DMG,
  BOSS_LANCE_SHOT_SPEED,
  BOSS_ORBIT_RADIUS,
  BOSS_P1_CYCLE_MS,
  BOSS_P1_SPREAD_COUNT,
  BOSS_P1_SPREAD_DEG,
  BOSS_P1_TELEGRAPH_MS,
  BOSS_P2_AIM_MS,
  BOSS_P2_CYCLE_MS,
  BOSS_P2_LANCES,
  BOSS_P3_CYCLE_MS,
  BOSS_P3_MITES,
  BOSS_P3_NOVA_COUNT,
  BOSS_P3_TELEGRAPH_MS,
  BOSS_REWARD_SHARDS,
  BOSS_PHASE_MIN_MS,
  BOSS_SHOT_SPEED,
  BOSS_SPAWN_COOLDOWN_MS,
  BOSS_SPAWN_INTENSITY,
  BOSS_SPAWN_MIN_PLAYERS,
  BOSS_SPEED,
  bossHp,
  bossPhase,
  ELITE_HP_BASE,
  eliteHp,
  eliteHpMult,
  enemyShotHit,
  MITE_GRACE_MS,
  SNIPER_AIM_MS,
  SNIPER_COOLDOWN_MS,
  SNIPER_FIRE_RANGE,
  SNIPER_KEEP_DIST,
  SNIPER_SHOT_SPEED,
  SNIPER_SPEED,
  SPAWNER_BROOD_CAP,
  SPAWNER_BROOD_PER_PULSE,
  SPAWNER_PULSE_MS,
  SPAWNER_SPEED,
  SPAWNER_TELEGRAPH_MS,
  WARDEN_COOLDOWN_MS,
  WARDEN_FIRE_RANGE,
  WARDEN_SHIELDED_DR,
  WARDEN_SHOT_SPEED,
  WARDEN_SPEED,
  WARDEN_TELEGRAPH_MS,
  WARDEN_TURN_DEG_PER_S,
  WARDEN_VENT_DR,
  WARDEN_VENT_MS,
  COMBO_WINDOW_MS,
  CONTACT_IFRAME_MS,
  DMG,
  comboMult,
  LEVEL_CAP,
  DRONE_COOLDOWN_MS,
  DRONE_FIRE_CONE_DEG,
  DRONE_SHOT_SPEED,
  DRONE_SPEED,
  DRONE_TELEGRAPH_MS,
  DRONE_TURN_DEG_PER_S,
  edgeSpawn,
  ENEMY_DEBUT_SUPPRESS_MS,
  ENEMY_DESPAWN_INTERVAL_MS,
  ENEMY_DESPAWN_MIN_DIST,
  ENEMY_DESPAWN_SLACK,
  ENEMY_FIRE_RANGE,
  ENEMY_KINDS,
  ENEMY_SHOT_LEN,
  ENEMY_SHOT_TINT,
  ENEMY_SHOT_TTL_MS,
  ENEMY_SHOT_WIDTH,
  ENEMY_SPAWN_CLEARANCE,
  ENEMY_SPECS,
  EARLY_FODDER_KINDS,
  EARLY_FODDER_SEED_COUNT,
  EARLY_SEED_RING_MAX,
  EARLY_SPAWN_INTERVAL_MS,
  EARLY_SPAWN_RING_MAX,
  EARLY_SPAWN_WINDOW_S,
  enemyCap,
  enemySpawnIntervalMs,
  enemySpawnWeight,
  FLAK_FRAG_WEAPON,
  FODDER_DROP_CHANCE,
  FODDER_SHARD_MAX,
  FODDER_SHARD_MIN,
  GLAIVE_DECEL_PX,
  HOMING_LOCK_CONE_DEG,
  INITIAL_SPAWN_CENTER_FRAC,
  INVULN_BLINK_MS,
  INVULNERABLE_MS,
  JOYSTICK_DEAD_ZONE,
  JOYSTICK_KNOB_RADIUS,
  JOYSTICK_RADIUS,
  ITEM_DRAW_RADIUS,
  ITEM_PICKUP_RADIUS,
  ITEM_SPEED,
  ITEM_STACK_CAP_MS,
  LANCER_CHARGE_HIT_RADIUS,
  LANCER_CHARGE_MS,
  LANCER_CHARGE_RANGE,
  LANCER_CHARGE_SPEED,
  LANCER_CRUISE_SPEED,
  LANCER_RECOVER_MS,
  LANCER_WINDUP_MS,
  LOOT_BOOSTER_WEIGHTS,
  LOOT_CLASSES,
  LOOT_PITY,
  LOOT_SHIELD_WEIGHTS,
  ITEMS_MAX_LIVE,
  MAGNET_PULL_SPEED,
  MAGNET_RANGE,
  MINE_ARM_MS,
  MINE_LIFETIME_MS,
  MINE_MAX_LIVE,
  MINE_TRIGGER_RADIUS,
  MINIMAP_H,
  MINIMAP_PAD,
  MINIMAP_W,
  NET_INTERVAL_MS,
  NITRO_ACCEL_MULT,
  NITRO_MAX_SPEED_MULT,
  OVERDRIVE_RATE_MULT,
  OVERSHIELD_BONUS,
  PHASE_COOLDOWN_MS,
  PHASE_COST,
  PHASE_DURATION_MS,
  PHASE_TRIGGER_HIT,
  playerPressure,
  PVP_DAMAGE_MULT,
  PVP_EXPLOSION_IFRAME_MS,
  PVP_HIT_IFRAME_MS,
  PVP_MAX_SINGLE_HIT,
  RAM_ARM_SPEED,
  RAM_ASTEROID_CHIP,
  RAM_ASTEROID_DESTROY_R,
  RAM_DAMAGE,
  RAM_IMMUNITY_MS,
  RAM_KNOCKBACK,
  RAM_LANCER_DRAIN,
  RAM_PVP_DRAIN,
  RAM_SELF_DRAIN,
  randomWorldPoint,
  ringSpawnPoint,
  REFLECT_BOUNCE_COST,
  REFLECT_MIN_SHIELD,
  RESPAWN_ASTEROID_MIN_R,
  RESPAWN_ATTEMPTS,
  RESPAWN_CLEARANCE,
  RESPAWN_DELAY_MS,
  RESPAWN_EDGE_MARGIN,
  rollLootClass,
  rollWeightedKey,
  SENTRY_FIRE_MS,
  SENTRY_LIFETIME_MS,
  SENTRY_RANGE,
  SHARD_DRIFT_SPEED,
  SHARD_MAGNET_PULL_SPEED,
  SHARD_PICKUP_RADIUS,
  SHARD_TINT,
  SHARDS_MAX_LIVE,
  SHIELD_HALO_RADIUS,
  SHIELD_LOW_FRACTION,
  SHIELD_MAX,
  SHIELD_MOD_DURATION_MS,
  SHIELD_MOD_KINDS,
  SHIELD_MOD_SPECS,
  SHIELD_REGEN_DELAY_MS,
  SHIELD_REGEN_FULL_MS,
  SHIELD_RING_RADIUS,
  SHIELD_RING_TINT,
  SIPHON_HEAL_ASTEROID,
  SIPHON_HEAL_ENEMY,
  SIPHON_HEAL_PLAYER,
  SINGULARITY_PULL_MS,
  GRAVITON_PULL_MS,
  LEECH_FIELD_HEAL,
  LEECH_FIELD_RANGE,
  SALVAGE_MULT,
  SINGULARITY_PULL_RANGE,
  SINGULARITY_PULL_SPEED,
  SIPHON_OVERHEAL_DECAY_PER_S,
  SIPHON_OVERHEAL_MAX,
  SHIP_ACCEL,
  SHIP_BRAKE_DRAG,
  SHIP_DEAD_ZONE,
  SHIP_DRAG,
  SHIP_HULL_DEG,
  SHIP_MAX_SPEED,
  SHIP_RADIUS,
  SHIP_THRUST_RAMP,
  SPECIAL_WEAPON_DURATION_MS,
  SPLITTER_CHILD_SPEED,
  SPLITTER_CHILDREN,
  SPLITTER_GRACE_MS,
  SPLITTER_SPEED,
  OPENING_ROCK_COUNT,
  spawnAsteroidState,
  spawnOpeningAsteroid,
  spawnEnemyState,
  spawnItemState,
  spawnShardState,
  spawnUfoState,
  spawnWeaponItemState,
  TWIN_ORBIT_DEG_PER_S,
  TWIN_ORBIT_RADIUS,
  TWIN_POWER_MULT,
  UFO_BLINK_MS,
  UFO_RADIUS,
  UFO_SPAWN_RATE,
  UFO_SPEED,
  WASP_BURST_COUNT,
  WASP_BURST_GAP_MS,
  WASP_COOLDOWN_MS,
  WASP_ORBIT_RADIUS,
  WASP_SHOT_SPEED,
  WASP_SPEED,
  WASP_TELEGRAPH_MS,
  WASP_WOBBLE_AMP,
  WASP_WOBBLE_HZ,
  wavePulse,
  WEAPON_DEFAULT,
  WEAPONS_SPECIAL,
  WORLD_BLEED_PX,
  WORLD_H,
  WORLD_W,
  XP,
  XP_DEATH_MAX_DELEVELS,
  XP_DEATH_PENALTY_FRAC,
  xpToNext,
} from "../shared/constants";
import type {
  EnemyState,
  AsteroidState,
  BoosterKind,
  BoostNetState,
  EnemyKind,
  BeaconState,
  EnemyShotState,
  ItemDrop,
  ItemState,
  LootClass,
  PlayerNetState,
  SerializedBeam,
  SharedState,
  ShieldModKind,
  ShieldModNetState,
  Vec,
  Weapon,
  WeaponSfx,
} from "../shared/constants";
import { now as simNow, pauseClock, resumeClock } from "../shared/clock";
import { diag, installTestHooks } from "../shared/diag";
import { rand } from "../shared/rng";
import type { TrailerStageApi, TrailerStaging } from "../trailer/trailer-staging";

/** What a HOMING beam (or ARC hop) is steering toward / hit. */
type TargetRef =
  | { kind: "enemy"; id: string }
  | { kind: "player"; id: string }
  | { kind: "ufo" }
  | { kind: "asteroid"; id: string };

/** A locally-simulated beam (only ever our own — remote beams arrive serialized). */
interface Beam {
  head: Vec;
  tail: Vec;
  angle: number;
  weapon: Weapon;
  released: boolean;
  exploding: boolean;
  explosionRadius: number;
  vanished: boolean;
  /** HOMING: live lock; null = fly straight. */
  target: TargetRef | null;
  /** Targets this beam already damaged — once per beam lifetime (per pass for
   *  GLAIVE: cleared at turnaround). Stops through-beams re-hitting every
   *  frame of overlap and explosions double-damaging. */
  hitIds: Set<string>;
  /** GLAIVE boomerang state. */
  glaive: { returning: boolean; traveled: number } | null;
  /** ARC: bolt anchor points (damage applied at cast; render-only afterwards). */
  chain: Vec[] | null;
  /** ARC fizzle bolt: render-only, never serialized (must not hit PvP victims). */
  fizzle: boolean;
  /** ARC render expiry / MINE lifetime expiry (0 = neither). */
  diesAt: number;
  /** MINE: arm timestamp (inert + blinking until then; explodes on trigger). */
  mine: { armAt: number } | null;
  /** RICOCHET: bounces remaining off asteroids/world edges. */
  bouncesLeft: number;
  /** SINGULARITY: collapse window end (0 = not collapsing). The orb is
   *  frozen while now < this; at expiry it pops (exploding). */
  collapseUntil: number;
  /** Distance flown since the muzzle (FLAK airburst trigger). */
  traveled: number;
  /** GLAIVE visual spin. */
  spin: number;
  /** HUD mastery tracking for the local RAILGUN/GLAIVE window; null otherwise. */
  mastery: MasteryShot | null;
}

interface ShipObjs {
  gfx: Phaser.GameObjects.Graphics;
  tint: number;
  /** Level the hull was last built for; rebuild on change (ships grow per level). */
  level: number;
  alive: boolean;
  /** False until the first state snapshot lands (remote ships snap, not glide). */
  seenState: boolean;
  /** Thruster trail emitter (null when over the remote-trail cap). */
  trail: Phaser.GameObjects.Particles.ParticleEmitter | null;
  /** Trail currently configured as the NITRO flame. */
  nitroTrail: boolean;
  /** Trail particle scale currently loaded into the emitter config. Only the
   *  trailer's hull-glow damping ever moves it off TRAIL_PARTICLE_SCALE, and
   *  it is tracked so the per-frame reconfigure is skipped when it has not. */
  trailScale: number;
  /** Last seen base shieldHp — a decrease between snapshots = hit flash.
   *  Base shield only: overHp zeroes on overshield expiry/replacement with
   *  no damage, so a combined total would phantom-flash. */
  lastShieldHp: number;
  /** Ring hit-flash window. */
  flashUntil: number;
  /** Ring regen visual window (an increase between snapshots opens it). */
  regenUntil: number;
}
interface AsteroidObjs {
  gfx: Phaser.GameObjects.Graphics;
  drawnRadius: number;
}
interface ItemObjs {
  gfx: Phaser.GameObjects.Graphics;
  tint: number;
}
interface EnemyObjs {
  gfx: Phaser.GameObjects.Graphics;
  kind: EnemyKind;
  /** Dedupe telegraph_warn: remember the last telegraph window we voiced. */
  lastTelegraphUntil: number;
  /** Authored duration captured once; phase changes cannot rewind a live warning. */
  telegraphDuration: number;
  /** Lancer close-pass trauma fires once per charge. */
  chargeTraumaDone: boolean;
  /** Lancer charge-trail cadence on the sim clock (0 = not charging). */
  nextTrailAt: number;
}

interface Splinter {
  originX: number;
  originY: number;
  angle: number;
  dist: number;
  speed: number;
  diesAt: number;
  x: number;
  y: number;
}

/** Transient muzzle flash strokes (1–2 frames), drawn additively. */
interface MuzzleFlash {
  x: number;
  y: number;
  angle: number;
  size: number;
  tint: number;
  diesAt: number;
  kind: "cross" | "line" | "ring";
}

/** Host-private per-enemy AI bookkeeping (lost on migration — acceptable). */
interface EnemySim {
  nextAttackAt: number;
  /** Telegraphed action lands at this time (0 = none pending). */
  fireAt: number;
  burstLeft: number;
  nextBurstShotAt: number;
  lancerPhase: "cruise" | "windup" | "charge" | "recover";
  phaseUntil: number;
  orbitDir: 1 | -1;
  wobblePhase: number;
  /** RAM/barrier knockback velocity. Steering rewrites e.vx/vy every tick, so
   *  impulses live here, decay, and ride on top (LANCER takes direct vx/vy). */
  kbVx: number;
  kbVy: number;
  /** SPAWNER/BOSS: live mites attributed to this parent (self-caps the brood). */
  broodCount: number;
  /** Mites: the spawner/boss they belong to (decrements broodCount on death). */
  broodParent: string | null;
  /** BOSS: last phase seen by the damage clamp (0 = none yet) + when the
   *  current phase's minimum-duration window ends. Host-local by design: a
   *  migrated host restarts the window from inherited HP, which can only
   *  lengthen the fight, never shorten or desync it (phase itself stays
   *  derived from HP). */
  bossPhaseSeen: 0 | 1 | 2 | 3;
  bossPhaseFloorUntil: number;
}

/** One enemy's steering frame: the chosen target and the vector to it. */
interface EnemyAim {
  target: Vec;
  dx: number;
  dy: number;
  dist: number;
  desired: number;
}

const MULTIPLAYER_HOST = import.meta.env.DEV
  ? "http://localhost:8787"
  : "https://vibedgames-party.kyh.workers.dev";

// Fresh room name per shared-state shape change (v6: asteroid verts left off
// the wire — derived per-client from the id — plus quantized coordinates and
// short entity ids, per the dir-002 bandwidth audit): old deployed clients
// can't pollute this build's world.
const ROOM_DEFAULT = "starfall-arena-v6";
/** DEV-only room override (?room=): the multiplayer e2e harness isolates each
 *  run in a fresh arena so a stale room's world can't leak into assertions. */
const ROOM =
  (import.meta.env.DEV && new URLSearchParams(location.search).get("room")) || ROOM_DEFAULT;
/** Per-arena cap. The party server clamps to its own hard ceiling and overflows
 *  player #33+ into a sibling arena (starfall-arena-v4~2, …) automatically. */
const STARFALL_MAX_PLAYERS = 32;

const DEG = Math.PI / 180;
/** Lancer charge-trail spark cadence (sim time). */
const LANCER_TRAIL_MS = 1000 / 60;
/** ARC per-hop falloff for victim-side chain drains. SerializedBeam carries
 *  no weapon ref, so read it from the ARC spec (TESLA also carries an arc
 *  spec, hence the !aura filter). */
const ARC_FALLOFF = WEAPONS_SPECIAL.find((w) => w.arc !== null && !w.aura)?.arc?.falloff ?? 0.7;
/** TESLA AURA spec for victim-side adjudication (the RAM pattern: power and
 *  range come from the shared table, not the wire). */
const TESLA_SPEC = WEAPONS_SPECIAL.find((w) => w.aura);
const TESLA_POWER = TESLA_SPEC?.power ?? 0.27;
const TESLA_RANGE = TESLA_SPEC?.arc?.castRange ?? 120;
const TESLA_TINT = TESLA_SPEC?.tint ?? 0x00_aa_ff;
/** SENTRY stat block: the turret keeps firing it even after the owner's
 *  weapon slot moves on (the turret outlives the trigger). */
const SENTRY_WEAPON = WEAPONS_SPECIAL.find((w) => w.sentry) ?? WEAPON_DEFAULT;
const SINGULARITY_TINT = WEAPONS_SPECIAL.find((w) => w.singularity)?.tint ?? 0x7c_3a_ed;
/** PLASMA CONE per-shot tint gradient endpoints (hot pink -> orange). */
const PLASMA_TINT_A = 0xff_2d_78;
const PLASMA_TINT_B = 0xff_9a_3d;
/** PHASE LANCE: the asteroid pass iterates this instead (skip, zero alloc). */
const NO_ASTEROIDS: readonly AsteroidState[] = [];
/** Trailer mode: the pip pass draws this (clears the layer, zero alloc). */
const NO_PIPS: readonly PipTarget[] = [];
/** Beams vanish this far outside the world. */
const BEAM_CULL_MARGIN = 200;
/** Black mask thickness past the world edge (covers any screen half-width). */
// Masks start OUTSIDE the bleed ring so they hide truly-off-world entities but
// not the fading bleed stars; still wide enough to cover any screen half-width.
const MASK_PAD = WORLD_BLEED_PX + 4000;
/** Reconcile snaps instead of blending past this offset. */
const SNAP_DIST = 80;
const SPLINTER_LIFE_MS = 7000;
const SPLINTER_PX = 2;
/** Host suppresses enemy spawns for the arena's first seconds (safe opening). */
const ARENA_SAFE_MS = 6000;
/** Coarse-pointer boot check: phones/tablets get the touch copy immediately
 *  instead of waiting for the first tap to flip `gamepad.isTouch`. */
const IS_COARSE_POINTER =
  window.matchMedia("(pointer: coarse)").matches || "ontouchstart" in window;
/** Physical-stick deflection (0–1) treated as noise; past it the pad owns the
 *  steer vector for the frame (mirrors the touch-joystick dead zone). */
const PAD_STICK_DEAD_ZONE = 0.15;
/** Narrow-viewport zoom-out (PvP reaction fairness): viewports narrower than
 *  REF render at width/REF zoom, floored at MIN — phones land at the floor and
 *  see more world. The off-world mask (MASK_PAD) covers any zoomed half-view.
 *  qa-011: floor raised 0.75 → 0.9 — at 0.75 a 390px phone rendered the ship
 *  ~12px and drones as 1-3px flecks; the extra world view was worthless when
 *  the threats it showed were invisible. Readability beats reaction range. */
const CAMERA_REF_WIDTH = 1100;
const CAMERA_MIN_ZOOM = 0.9;
/** qa-011 stroke weight: hull/telegraph strokes multiply by this so they hold
 *  >=~1.25px on-screen as the camera zooms out — and gain the same touch of
 *  weight at zoom 1, where 1px vector strokes read whisper-thin on 720p. */
const STROKE_BASE = 1.25;
const STROKE_MAX = 1.7;
/** Authored thruster-puff size (see GameScene.hullGlow for the one thing that
 *  ever scales it down). */
const TRAIL_PARTICLE_SCALE = 0.5;

// ---- module helpers (pure) ----------------------------------------------------------------

/** 1 → "1ST", 2 → "2ND", 3 → "3RD", 4 → "4TH"… (sector standings surfaces). */
const ordinal = (rank: number): string => {
  const mod100 = rank % 100;
  const mod10 = rank % 10;
  if (mod10 === 1 && mod100 !== 11) {
    return `${rank}ST`;
  }
  if (mod10 === 2 && mod100 !== 12) {
    return `${rank}ND`;
  }
  if (mod10 === 3 && mod100 !== 13) {
    return `${rank}RD`;
  }
  return `${rank}TH`;
};

/** Thousands-grouped points for the sector surfaces (1240 → "1,240"). */
const fmtPts = (pts: number): string => pts.toLocaleString("en-US");

/** Saucer outline relative to the UFO's reference point (half-width UFO_RADIUS). */
const UFO_OUTLINE: readonly { x: number; y: number }[] = [
  { x: -4.5, y: -5 },
  { x: 4.5, y: -5 },
  { x: 7, y: 0 },
  { x: UFO_RADIUS, y: 4.5 },
  { x: 7, y: 9 },
  { x: -7, y: 9 },
  { x: -UFO_RADIUS, y: 4.5 },
  { x: -7, y: 0 },
];

/** GLAIVE: open triangle, side 10 (circumradius 10/√3), 2px stroke. */
const GLAIVE_TRI: readonly Vec[] = [0, 1, 2].map((i) => {
  const a = (Math.PI * 2 * i) / 3;
  return { x: Math.cos(a) * 5.77, y: Math.sin(a) * 5.77 };
});

/** Counter-hints surfaced after 3 deaths to the same cause (≤8 words). */
const DEATH_HINTS: ReadonlyMap<string, string> = new Map([
  ["LANCER", "it can't turn while charging"],
  ["DRONE", "its shots are slow — sidestep"],
  ["WASP", "break the orbit before the burst"],
  ["SPLITTER", "back away when it dies"],
  ["ASTEROID", "small rocks move fastest"],
  ["UFO", "shoot it — never touch it"],
  ["PLAYER", "keep moving, use your drift"],
]);

interface WeaponSoundSpec {
  name: SfxName;
  gain: number;
  rate?: number;
}

const weaponSound = (kind: WeaponSfx): WeaponSoundSpec => {
  switch (kind) {
    case "pulse": {
      return { gain: 1, name: "fire_pulse" };
    }
    case "rapid": {
      return { gain: 0.6, name: "fire_pulse" };
    }
    case "heavy": {
      return { gain: 1, name: "fire_heavy" };
    }
    case "zap": {
      return { gain: 1, name: "fire_laser" };
    }
    case "boom": {
      return { gain: 0.7, name: "fire_heavy" };
    }
    case "scatter": {
      return { gain: 1, name: "fire_scatter" };
    }
    case "seek": {
      return { gain: 0.55, name: "fire_laser" };
    }
    case "arc": {
      return { gain: 1, name: "arc_zap" };
    }
    case "glaive": {
      return { gain: 0.8, name: "fire_heavy" };
    }
    case "rail": {
      return { gain: 1, name: "rail" };
    }
    case "mine": {
      return { gain: 0.5, name: "fire_pulse", rate: 0.7 };
    }
    case "nova": {
      // The design's "boom at 0.8 gain, −15% pitch".
      return { gain: 0.8, name: "fire_heavy", rate: 0.85 };
    }
    case "drill": {
      // Pitched reuse: the heavy thump dropped ~an octave reads as a grind.
      return { gain: 1.1, name: "fire_heavy", rate: 0.55 };
    }
    case "plasma": {
      // Quiet pitched-up blip at 70ms cadence reads as a hiss-stream.
      return { gain: 0.4, name: "fire_pulse", rate: 1.45 };
    }
    case "tesla": {
      // arc_zap pitched up: a shorter, snappier crackle than ARC's cast.
      return { gain: 0.7, name: "arc_zap", rate: 1.4 };
    }
    case "sentry": {
      // The own-bolt pew; the place clack is its own synth (sentry_place).
      return { gain: 0.7, name: "fire_pulse", rate: 1.1 };
    }
    case "singularity": {
      // Slow dark launch; the pop reuses fire_heavy pitched down (popSingularity).
      return { gain: 0.8, name: "fire_laser", rate: 0.6 };
    }
    default: {
      return kind satisfies never;
    }
  }
};

const hexagonPoints = (radius: number): Vec[] => {
  const pts: Vec[] = [];
  for (let i = 0; i < 6; i += 1) {
    const a = (Math.PI * 2 * i) / 6;
    pts.push({ x: Math.cos(a) * radius, y: Math.sin(a) * radius });
  }
  return pts;
};

/** Hull outline per enemy kind (§6.1 silhouettes), relative to center. */
const enemyHullPoints = (kind: EnemyKind): readonly Vec[] => {
  switch (kind) {
    case "drone": {
      // Equilateral triangle, side 12 → circumradius ≈ 6.93, nose at +x.
      return [0, 1, 2].map((i) => {
        const a = (Math.PI * 2 * i) / 3;
        return { x: Math.cos(a) * 6.93, y: Math.sin(a) * 6.93 };
      });
    }
    case "wasp": {
      // Chevron, 14 wide, two acute wings, nose at +x.
      return [
        { x: 6, y: 0 },
        { x: -6, y: -7 },
        { x: -2, y: 0 },
        { x: -6, y: 7 },
      ];
    }
    case "lancer": {
      // Narrow dart 20×5 (4:1).
      return [
        { x: 10, y: 0 },
        { x: -10, y: -2.5 },
        { x: -6, y: 0 },
        { x: -10, y: 2.5 },
      ];
    }
    case "splitter": {
      // Pentagon r=12 (pentagram drawn separately).
      return [0, 1, 2, 3, 4].map((i) => {
        const a = (Math.PI * 2 * i) / 5 - Math.PI / 2;
        return { x: Math.cos(a) * 12, y: Math.sin(a) * 12 };
      });
    }
    case "warden": {
      // Hex bunker, wide, flat-fronted (nose at +x).
      return hexagonPoints(16);
    }
    case "sniper": {
      // Long thin arrowhead, longer than the lancer, nose at +x.
      return [
        { x: 14, y: 0 },
        { x: -8, y: -5 },
        { x: -4, y: 0 },
        { x: -8, y: 5 },
      ];
    }
    case "spawner": {
      // Hexagonal hive.
      return hexagonPoints(14);
    }
    case "dreadnought": {
      // Capital ship: elongated heptagon, nose at +x, ~120 long.
      return [
        { x: 60, y: 0 },
        { x: 36, y: -22 },
        { x: -20, y: -30 },
        { x: -54, y: -16 },
        { x: -54, y: 16 },
        { x: -20, y: 30 },
        { x: 36, y: 22 },
      ];
    }
    default: {
      return kind satisfies never;
    }
  }
};

/** Visual ship scale by level (collision hitbox stays SHIP_RADIUS — leveling
 *  makes you LOOK bigger/tougher, not easier to hit). L1 1.0 → L5 ~1.52. */
const shipScaleForLevel = (level: number): number => {
  const L = Math.max(1, Math.min(LEVEL_CAP, Math.round(level)));
  // L1 1.0 → L3 1.4 (a clear size jump each level)
  return 1 + (L - 1) * 0.2;
};

const shipHullPoints = (level = 1): { x: number; y: number }[] => {
  const s = shipScaleForLevel(level);
  return SHIP_HULL_DEG.map((deg) => {
    const r = (deg === 180 ? SHIP_RADIUS / 2 : SHIP_RADIUS) * s;
    return { x: Math.cos(deg * DEG) * r, y: Math.sin(deg * DEG) * r };
  });
};

const strokeClosed = (
  g: Phaser.GameObjects.Graphics,
  pts: readonly { x: number; y: number }[],
): void => {
  const [first] = pts;
  if (!first) {
    return;
  }
  g.beginPath();
  g.moveTo(first.x, first.y);
  for (let i = 1; i < pts.length; i += 1) {
    const p = pts[i];
    if (p) {
      g.lineTo(p.x, p.y);
    }
  }
  g.closePath();
  g.strokePath();
};

/** Stroke a closed polygon translated/rotated into world space. */
const strokeTransformed = (
  g: Phaser.GameObjects.Graphics,
  pts: readonly Vec[],
  x: number,
  y: number,
  rot: number,
): void => {
  const cos = Math.cos(rot);
  const sin = Math.sin(rot);
  const [first] = pts;
  if (!first) {
    return;
  }
  g.beginPath();
  g.moveTo(x + first.x * cos - first.y * sin, y + first.x * sin + first.y * cos);
  for (let i = 1; i < pts.length; i += 1) {
    const p = pts[i];
    if (p) {
      g.lineTo(x + p.x * cos - p.y * sin, y + p.x * sin + p.y * cos);
    }
  }
  g.closePath();
  g.strokePath();
};

const strokeRegularPolygon = (
  g: Phaser.GameObjects.Graphics,
  x: number,
  y: number,
  radius: number,
  sides: number,
  rot: number,
): void => {
  g.beginPath();
  for (let i = 0; i <= sides; i += 1) {
    const a = rot + (Math.PI * 2 * i) / sides;
    const px = x + Math.cos(a) * radius;
    const py = y + Math.sin(a) * radius;
    if (i === 0) {
      g.moveTo(px, py);
    } else {
      g.lineTo(px, py);
    }
  }
  g.strokePath();
};

const dashedLine = (
  g: Phaser.GameObjects.Graphics,
  x: number,
  y: number,
  angle: number,
  length: number,
  dash: number,
  gap: number,
): void => {
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  for (let d = 0; d < length; d += dash + gap) {
    const end = Math.min(d + dash, length);
    g.lineBetween(x + cos * d, y + sin * d, x + cos * end, y + sin * end);
  }
};

/** WARDEN armor ring: closed while shielded; open arcs (visible gaps)
 *  throughout the punish window. */
const drawWardenArmor = (
  g: Phaser.GameObjects.Graphics,
  e: EnemyState,
  radius: number,
  sw: number,
): void => {
  g.lineStyle(2 * sw, e.shielded ? ENEMY_SPECS.warden.tint : 0xff_ff_ff, e.shielded ? 0.9 : 0.5);
  if (e.shielded) {
    g.strokeCircle(e.x, e.y, radius);
    return;
  }
  for (let i = 0; i < 4; i += 1) {
    const angle = (i * Math.PI) / 2 + 0.2;
    g.beginPath();
    g.arc(e.x, e.y, radius, angle, angle + 1.1);
    g.strokePath();
  }
};

/** Per-kind anticipation cue on top of the shared charge ring: nose glow,
 *  hull brighten (+ charge lane), locked-aim sights, spawner pulse, boss maw. */
const drawTelegraphAccent = (
  g: Phaser.GameObjects.Graphics,
  e: EnemyState,
  progress: number,
  sw: number,
): void => {
  const spec = ENEMY_SPECS[e.kind];
  if (e.kind === "drone" || e.kind === "warden") {
    const nose = e.kind === "drone" ? 8 : spec.hitRadius;
    g.fillStyle(spec.tint, 0.85);
    g.fillCircle(e.x + Math.cos(e.angle) * nose, e.y + Math.sin(e.angle) * nose, 1 + 3 * progress);
  } else if (e.kind === "wasp" || e.kind === "lancer") {
    g.lineStyle(sw, 0xff_ff_ff, 0.25 + 0.5 * progress);
    strokeTransformed(g, enemyHullPoints(e.kind), e.x, e.y, e.angle);
    if (e.kind === "lancer") {
      g.lineStyle(sw, spec.tint, 0.55 + 0.25 * progress);
      dashedLine(g, e.x, e.y, e.angle, LANCER_CHARGE_RANGE, 8, 6);
    }
  } else if (usesLockedAim(e)) {
    for (const aim of e.lances) {
      g.lineStyle(sw, spec.tint, 0.5 + 0.3 * progress);
      g.lineBetween(e.x, e.y, aim.x, aim.y);
      const targetRadius = (e.kind === "sniper" ? 5 : 7) + 3 * (1 - progress);
      g.strokeCircle(aim.x, aim.y, targetRadius);
      g.lineBetween(aim.x - targetRadius - 3, aim.y, aim.x - targetRadius + 1, aim.y);
      g.lineBetween(aim.x + targetRadius - 1, aim.y, aim.x + targetRadius + 3, aim.y);
      g.lineBetween(aim.x, aim.y - targetRadius - 3, aim.x, aim.y - targetRadius + 1);
      g.lineBetween(aim.x, aim.y + targetRadius - 1, aim.x, aim.y + targetRadius + 3);
    }
  } else if (e.kind === "spawner") {
    g.lineStyle(sw, spec.tint, 0.75);
    g.strokeCircle(e.x, e.y, spec.hitRadius + 4 + 14 * progress);
  } else if (e.kind === "dreadnought") {
    // Each boss phase keeps its own authored charge duration.
    g.fillStyle(spec.tint, 0.45);
    g.fillCircle(e.x + Math.cos(e.angle) * 40, e.y + Math.sin(e.angle) * 40, 4 + 6 * progress);
  }
};

/** ARC bolt: 3 jittered sub-segments per hop, re-rolled every frame. */
const drawJitteredChain = (
  g: Phaser.GameObjects.Graphics,
  chain: readonly Vec[],
  tint: number,
  now: number,
): void => {
  g.lineStyle(1.6, tint, 0.95);
  for (let i = 0; i < chain.length - 1; i += 1) {
    const a = chain[i];
    const b = chain[i + 1];
    if (!a || !b) {
      continue;
    }
    let px = a.x;
    let py = a.y;
    for (let s = 1; s <= 3; s += 1) {
      const t = s / 3;
      const jitter = s < 3 ? 6 : 0;
      const nx = a.x + (b.x - a.x) * t + Math.sin(now * 0.035 + i * 2.7 + s * 1.9) * jitter;
      const ny = a.y + (b.y - a.y) * t + Math.cos(now * 0.035 + i * 1.9 + s * 2.7) * jitter;
      g.lineBetween(px, py, nx, ny);
      px = nx;
      py = ny;
    }
  }
};

const drawPoly = (g: Phaser.GameObjects.Graphics, verts: readonly { x: number; y: number }[]) => {
  g.clear();
  g.lineStyle(1, 0xff_ff_ff, 1);
  strokeClosed(g, verts);
};

const serializeBeam = (b: Beam): SerializedBeam => {
  if (b.chain && b.chain.length >= 2) {
    const [first] = b.chain;
    const last = b.chain.at(-1);
    return {
      chain: b.chain,
      exploding: false,
      explosionRadius: 0,
      hx: last?.x ?? b.head.x,
      hy: last?.y ?? b.head.y,
      power: b.weapon.power,
      tint: b.weapon.tint,
      tx: first?.x ?? b.tail.x,
      ty: first?.y ?? b.tail.y,
      width: b.weapon.width,
    };
  }
  const sb: SerializedBeam = {
    exploding: b.exploding,
    explosionRadius: b.explosionRadius,
    hx: b.head.x,
    hy: b.head.y,
    power: b.weapon.power,
    tint: b.weapon.tint,
    tx: b.tail.x,
    ty: b.tail.y,
    width: b.weapon.width,
  };
  if (b.glaive) {
    sb.glaive = true;
  }
  if (b.mine) {
    sb.mine = true;
  }
  if (b.weapon.singularity && !b.exploding) {
    sb.orb = true;
  }
  return sb;
};

/** One entry of a peer's wire-state record — the multiplayer owner contract
 *  leaves entries undecoded; the wire* helpers below parse them into domain
 *  values. Wire traffic is JSON, so plain records, arrays and primitives are
 *  the whole vocabulary. */
type WireValue = NonNullable<Player["state"]>[string];
/** A JSON record off the wire, entries not yet decoded. */
type WireRecord = Record<string, WireValue>;

const isWireRecord = (v: WireValue | undefined): v is WireRecord => v instanceof Object;

const asWireRecord = (v: WireValue | undefined): WireRecord | null => (isWireRecord(v) ? v : null);

/** Decode a wire number. NaN never appears in legal traffic, and `n === v`
 *  rejects it along with every non-number, so the copy-compare is exact. */
const wireNum = (v: WireValue | undefined): number | null => {
  const n = Number(v);
  return n === v ? n : null;
};

const wireStr = (v: WireValue | undefined): string | null => {
  const s = String(v);
  return s === v ? s : null;
};

/** Decode one serialized beam off the wire; null when a required field is missing. */
const readWireBeam = (entry: WireValue): SerializedBeam | null => {
  const b = asWireRecord(entry);
  if (!b) {
    return null;
  }
  const hx = wireNum(b["hx"]);
  const hy = wireNum(b["hy"]);
  const tx = wireNum(b["tx"]);
  const ty = wireNum(b["ty"]);
  const tint = wireNum(b["tint"]);
  const width = wireNum(b["width"]);
  if (hx === null || hy === null || tx === null || ty === null || tint === null || width === null) {
    return null;
  }
  const beam: SerializedBeam = {
    exploding: b["exploding"] === true,
    explosionRadius: wireNum(b["explosionRadius"]) ?? 0,
    hx,
    hy,
    tint,
    tx,
    ty,
    width,
  };
  const chainRaw = b["chain"];
  if (Array.isArray(chainRaw)) {
    const pts: Vec[] = [];
    for (const pt of chainRaw) {
      const r = asWireRecord(pt);
      if (!r) {
        continue;
      }
      const px = wireNum(r["x"]);
      const py = wireNum(r["y"]);
      if (px !== null && py !== null) {
        pts.push({ x: px, y: py });
      }
    }
    if (pts.length >= 2) {
      beam.chain = pts;
    }
  }
  if (b["glaive"] === true) {
    beam.glaive = true;
  }
  if (b["mine"] === true) {
    beam.mine = true;
  }
  if (b["orb"] === true) {
    beam.orb = true;
  }
  const power = wireNum(b["power"]);
  if (power !== null) {
    beam.power = power;
  }
  return beam;
};

const readWireBeams = (raw: WireValue | undefined): SerializedBeam[] => {
  const beams: SerializedBeam[] = [];
  if (Array.isArray(raw)) {
    for (const entry of raw) {
      const beam = readWireBeam(entry);
      if (beam) {
        beams.push(beam);
      }
    }
  }
  return beams;
};

const readWireShieldMod = (raw: WireValue | undefined): ShieldModNetState | null => {
  const modRaw = asWireRecord(raw);
  if (!modRaw) {
    return null;
  }
  const kind = SHIELD_MOD_KINDS.find((k) => k === modRaw["kind"]);
  if (!kind) {
    return null;
  }
  return {
    active: modRaw["active"] === true,
    kind,
    phased: modRaw["phased"] === true,
    until: wireNum(modRaw["until"]) ?? 0,
  };
};

const readWireBoosts = (raw: WireValue | undefined): BoostNetState[] => {
  const boosts: BoostNetState[] = [];
  if (Array.isArray(raw)) {
    for (const entry of raw) {
      const r = asWireRecord(entry);
      if (!r) {
        continue;
      }
      const kind = BOOSTER_KINDS.find((k) => k === r["kind"]);
      const until = wireNum(r["until"]);
      if (kind && until !== null) {
        boosts.push({ kind, until });
      }
    }
  }
  return boosts;
};

const readWireSentry = (raw: WireValue | undefined): PlayerNetState["sentry"] => {
  const sentryRaw = asWireRecord(raw);
  if (!sentryRaw) {
    return null;
  }
  const sx = wireNum(sentryRaw["x"]);
  const sy = wireNum(sentryRaw["y"]);
  const sUntil = wireNum(sentryRaw["until"]);
  if (sx === null || sy === null || sUntil === null) {
    return null;
  }
  return { until: sUntil, x: sx, y: sy };
};

const readNetState = (player: Player | undefined): PlayerNetState | null => {
  const s = player?.state;
  if (!s) {
    return null;
  }
  const x = wireNum(s["x"]);
  const y = wireNum(s["y"]);
  const angle = wireNum(s["angle"]);
  if (x === null || y === null || angle === null) {
    return null;
  }
  return {
    alive: s["alive"] !== false,
    angle,
    beams: readWireBeams(s["beams"]),
    boosts: readWireBoosts(s["boosts"]),
    invuln: s["invuln"] === true,
    level: wireNum(s["level"]) ?? 1,
    overHp: wireNum(s["overHp"]) ?? 0,
    present: s["present"] !== false,
    sectorScore: wireNum(s["sectorScore"]) ?? 0,
    sentry: readWireSentry(s["sentry"]),
    shieldHp: wireNum(s["shieldHp"]) ?? SHIELD_MAX,
    shieldMod: readWireShieldMod(s["shieldMod"]),
    streak: wireNum(s["streak"]) ?? 0,
    tesla: s["tesla"] === true,
    vx: wireNum(s["vx"]) ?? 0,
    vy: wireNum(s["vy"]) ?? 0,
    weaponName: wireStr(s["weaponName"]) ?? "",
    windup: wireNum(s["windup"]) ?? 0,
    x,
    xp: wireNum(s["xp"]) ?? 0,
    y,
  };
};

/** Position of a raw string in a kind table (-1 when it names no kind). */
const kindIndex = (kinds: readonly string[], name: string): number => kinds.indexOf(name);

/** Index an entity array by id (reconcile does many find-by-id lookups). */
const indexById = <T extends { id: string }>(list: readonly T[]): Map<string, T> => {
  const map = new Map<string, T>();
  for (const e of list) {
    map.set(e.id, e);
  }
  return map;
};

const cloneAsteroid = (a: AsteroidState): AsteroidState => ({ ...a });

/** Soft-correct a dead-reckoned position toward the authoritative one. */
const blendPos = (target: { x: number; y: number }, ax: number, ay: number): void => {
  const dx = ax - target.x;
  const dy = ay - target.y;
  if (dx * dx + dy * dy > SNAP_DIST * SNAP_DIST) {
    target.x = ax;
    target.y = ay;
  } else {
    target.x += dx * 0.3;
    target.y += dy * 0.3;
  }
};

/** Reconcile a host-owned drifting entity list (items, shards, enemy shots)
 *  toward the snapshot: adopt arrivals, blend survivors, drop departures —
 *  except entries this client already claimed locally (host lagging). */
const reconcileDrifters = <
  T extends { id: string; x: number; y: number; vx: number; vy: number; diesAt: number },
>(
  local: T[],
  remote: readonly T[],
  claimed: ReadonlyMap<string, number>,
): T[] => {
  const byId = indexById(local);
  const ids = new Set<string>();
  for (const r of remote) {
    ids.add(r.id);
    if (claimed.has(r.id)) {
      continue;
    }
    const cur = byId.get(r.id);
    if (!cur) {
      local.push({ ...r });
      continue;
    }
    cur.vx = r.vx;
    cur.vy = r.vy;
    cur.diesAt = r.diesAt;
    blendPos(cur, r.x, r.y);
  }
  return local.filter((x) => ids.has(x.id) && !claimed.has(x.id));
};

const blinkAlpha = (now: number): number =>
  Math.floor(now / INVULN_BLINK_MS) % 2 === 0 ? 0.9 : 0.3;

const inWorld = (x: number, y: number, margin: number, w = WORLD_W, h = WORLD_H): boolean =>
  x >= -margin && x <= w + margin && y >= -margin && y <= h + margin;

const dist2 = (ax: number, ay: number, bx: number, by: number): number => {
  const dx = ax - bx;
  const dy = ay - by;
  return dx * dx + dy * dy;
};

/** Closest-point distance from segment (x1,y1)→(x2,y2) to a circle. */
const segHitsCircle = (
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  cx: number,
  cy: number,
  r: number,
): boolean => {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  const t = len2 > 0 ? PhaserMath.Clamp(((cx - x1) * dx + (cy - y1) * dy) / len2, 0, 1) : 0;
  return dist2(x1 + dx * t, y1 + dy * t, cx, cy) <= r * r;
};

/** Does a beam touch a circle: the blast disc while exploding, else the
 *  tail→head segment. Width is half-padded into the segment test so wide
 *  beams (DRILL 8px) hit what they visually cover, not just their axis. */
const beamHitsCircle = (b: Beam, cx: number, cy: number, r: number): boolean => {
  if (b.exploding) {
    return dist2(b.head.x, b.head.y, cx, cy) <= b.explosionRadius * b.explosionRadius;
  }
  return segHitsCircle(b.tail.x, b.tail.y, b.head.x, b.head.y, cx, cy, r + b.weapon.width / 2);
};

/** One shooter's same-frame PvP drains against me, summed before the clamp. */
interface Volley {
  beamDrain: number;
  aoeDrain: number;
  anyExploding: boolean;
  anyGlaive: boolean;
  maxPower: number;
  impact: Vec | null;
  reflectAngle: number;
}

/** Which part of a serialized beam touches the ship at (x,y): the index of
 *  the ARC chain segment that hit (0 for plain beams and blasts), or null
 *  for a miss. Width is render-real: padded by half so wide beams hit
 *  their cover. */
const serializedBeamHitSeg = (sb: SerializedBeam, x: number, y: number): number | null => {
  const pad = SHIP_RADIUS + sb.width / 2;
  if (sb.chain && sb.chain.length >= 2) {
    for (let i = 0; i < sb.chain.length - 1; i += 1) {
      const p0 = sb.chain[i];
      const p1 = sb.chain[i + 1];
      if (p0 && p1 && segHitsCircle(p0.x, p0.y, p1.x, p1.y, x, y, pad)) {
        return i;
      }
    }
    return null;
  }
  if (sb.exploding) {
    return dist2(sb.hx, sb.hy, x, y) <= sb.explosionRadius * sb.explosionRadius ? 0 : null;
  }
  return segHitsCircle(sb.tx, sb.ty, sb.hx, sb.hy, x, y, pad) ? 0 : null;
};

/** Wrap an angle difference into [-π, π]. */
const wrapAngle = (a: number): number => Math.atan2(Math.sin(a), Math.cos(a));

/** Rotate `from` toward `to` by at most `maxStep` radians. */
const rotateToward = (from: number, to: number, maxStep: number): number => {
  const diff = wrapAngle(to - from);
  return from + PhaserMath.Clamp(diff, -maxStep, maxStep);
};

const nearestOf = (points: readonly Vec[], x: number, y: number): Vec | null => {
  let best: Vec | null = null;
  let bestD = Infinity;
  for (const p of points) {
    const d = dist2(p.x, p.y, x, y);
    if (d < bestD) {
      bestD = d;
      best = p;
    }
  }
  return best;
};

/** Steer a drifting pickup toward its nearest magnet holder at pullSpeed
 *  while in range; once out of range settle it back to driftSpeed. */
const magnetPull = (
  it: { x: number; y: number; vx: number; vy: number },
  holders: readonly Vec[],
  pullSpeed: number,
  driftSpeed: number,
): void => {
  const h = nearestOf(holders, it.x, it.y);
  if (!h) {
    return;
  }
  const d = Math.hypot(h.x - it.x, h.y - it.y);
  if (d <= MAGNET_RANGE && d > 1) {
    it.vx = ((h.x - it.x) / d) * pullSpeed;
    it.vy = ((h.y - it.y) / d) * pullSpeed;
    return;
  }
  const sp = Math.hypot(it.vx, it.vy);
  if (sp > driftSpeed + 1) {
    // Left the magnet's range: settle back to drift speed.
    it.vx = (it.vx / sp) * driftSpeed;
    it.vy = (it.vy / sp) * driftSpeed;
  }
};

/** The `count` players nearest to `from` (repeated-min select; no sort). */
const nearestPlayers = (players: readonly Vec[], from: Vec, count: number): Vec[] => {
  const cands = players.map((p) => ({ d: dist2(p.x, p.y, from.x, from.y), x: p.x, y: p.y }));
  const picks: Vec[] = [];
  for (let k = 0; k < count && cands.length > 0; k += 1) {
    let bi = 0;
    for (let i = 1; i < cands.length; i += 1) {
      if ((cands[i]?.d ?? Infinity) < (cands[bi]?.d ?? Infinity)) {
        bi = i;
      }
    }
    const best = cands[bi];
    if (best) {
      picks.push({ x: best.x, y: best.y });
    }
    cands.splice(bi, 1);
  }
  return picks;
};

const weightedEnemyRoll = (kinds: readonly EnemyKind[], intensity: number): EnemyKind | null => {
  let total = 0;
  for (const k of kinds) {
    total += enemySpawnWeight(k, intensity);
  }
  if (total <= 0) {
    return null;
  }
  let roll = rand() * total;
  for (const k of kinds) {
    roll -= enemySpawnWeight(k, intensity);
    if (roll <= 0) {
      return k;
    }
  }
  return kinds.at(-1) ?? null;
};

const targetKey = (ref: TargetRef): string =>
  ref.kind === "ufo" ? "ufo" : `${ref.kind}:${ref.id}`;

const itemTint = (it: ItemState): number => {
  if (it.kind === "weapon") {
    return WEAPONS_SPECIAL[it.weaponIdx]?.tint ?? 0xff_ff_ff;
  }
  if (it.kind === "booster") {
    return BOOSTER_SPECS[BOOSTER_KINDS[it.boosterIdx] ?? "repair"].tint;
  }
  return SHIELD_MOD_SPECS[SHIELD_MOD_KINDS[it.shieldIdx] ?? "overshield"].tint;
};

/** Minimap box origin + the live play-area → box scale. */
interface MinimapFrame {
  x0: number;
  y0: number;
  sx: number;
  sy: number;
  pw: number;
  ph: number;
}

/** Host-owned world on the minimap: rocks, enemies (boss = hollow square),
 *  the blinking UFO marker and the pulsing BEACON diamond. Graphics has no
 *  auto-clip, so everything is bounds-checked against the play area. */
const drawMinimapWorld = (
  g: Phaser.GameObjects.Graphics,
  w: SharedState,
  m: MinimapFrame,
  now: number,
): void => {
  for (const a of w.asteroids) {
    if (!inWorld(a.x, a.y, 0, m.pw, m.ph)) {
      continue;
    }
    g.fillStyle(0xff_ff_ff, 0.3);
    g.fillCircle(m.x0 + a.x * m.sx, m.y0 + a.y * m.sy, Math.max(1, a.radius * m.sx * 0.3));
  }
  for (const e of w.enemies) {
    if (!inWorld(e.x, e.y, 0, m.pw, m.ph)) {
      continue;
    }
    if (e.kind === "dreadnought") {
      // qa-010: the boss is not fodder — a hollow 4×4 square, not a fleck.
      g.lineStyle(1, ENEMY_SHOT_TINT, 1);
      g.strokeRect(m.x0 + e.x * m.sx - 2, m.y0 + e.y * m.sy - 2, 4, 4);
    } else {
      g.fillStyle(ENEMY_SHOT_TINT, 1);
      g.fillRect(m.x0 + e.x * m.sx - 1, m.y0 + e.y * m.sy - 1, 2, 2);
    }
  }
  // qa-010: the UFO piñata is findable — blinking white saucer marker.
  const { ufo } = w;
  if (ufo && inWorld(ufo.x, ufo.y, 0, m.pw, m.ph) && Math.floor(now / 250) % 2 === 0) {
    g.lineStyle(1, 0xff_ff_ff, 1);
    g.strokeCircle(m.x0 + ufo.x * m.sx, m.y0 + ufo.y * m.sy, 2.5);
  }
  const { beacon } = w;
  if (beacon && now < beacon.diesAt) {
    const r = 3 + Math.sin((now / 1000) * Math.PI * 2) * 1.2;
    const bx = m.x0 + beacon.x * m.sx;
    const by = m.y0 + beacon.y * m.sy;
    g.lineStyle(1, BEACON_TINT, 1);
    g.beginPath();
    g.moveTo(bx, by - r);
    g.lineTo(bx + r * 0.7, by);
    g.lineTo(bx, by + r);
    g.lineTo(bx - r * 0.7, by);
    g.closePath();
    g.strokePath();
  }
};

/** Item dot in its tint; boosters are 2px diamonds so the third shell shape
 *  reads on the minimap too. */
const drawMinimapItem = (g: Phaser.GameObjects.Graphics, it: ItemState, m: MinimapFrame): void => {
  g.fillStyle(itemTint(it), 1);
  const px = m.x0 + it.x * m.sx;
  const py = m.y0 + it.y * m.sy;
  if (it.kind === "booster") {
    g.beginPath();
    g.moveTo(px, py - 2);
    g.lineTo(px + 2, py);
    g.lineTo(px, py + 2);
    g.lineTo(px - 2, py);
    g.closePath();
    g.fillPath();
  } else {
    g.fillCircle(px, py, 1.5);
  }
};

/** Remote windup glow tint from the shooter's weaponName (white fallback). */
const weaponTint = (name: string): number =>
  WEAPONS_SPECIAL.find((w) => w.name === name)?.tint ?? 0xff_ff_ff;

/** Random lerp between two 0xRRGGBB tints (PLASMA's per-shot gradient). */
/* oxlint-disable no-bitwise -- unpacks and repacks 8-bit channels */
const lerpTint = (a: number, b: number): number => {
  const t = Math.random();
  const ch = (shift: number): number => {
    const ca = (a >> shift) & 0xff;
    const cb = (b >> shift) & 0xff;
    return Math.round(ca + (cb - ca) * t) << shift;
  };
  return ch(16) | ch(8) | ch(0);
};
/* oxlint-enable no-bitwise */

/** 4-point open diamond, 1px stroke (mine + booster shells). */
const strokeDiamond = (g: Phaser.GameObjects.Graphics, x: number, y: number, r: number): void => {
  g.beginPath();
  g.moveTo(x, y - r);
  g.lineTo(x + r, y);
  g.lineTo(x, y + r);
  g.lineTo(x - r, y);
  g.closePath();
  g.strokePath();
};

const hexCss = (tint: number): string => `#${tint.toString(16).padStart(6, "0")}`;

const setText = (el: HTMLElement | null, text: string): void => {
  if (el && el.textContent !== text) {
    el.textContent = text;
  }
};

/** Changed-only attributes keep progress semantics without live announcements. */
const setAttribute = (el: HTMLElement | null, name: string, value: string): void => {
  if (el && el.getAttribute(name) !== value) {
    el.setAttribute(name, value);
  }
};

/* oxlint-disable no-bitwise -- packs 8-bit channels into 0xRRGGBB */
const hslToInt = (h: number, s: number, l: number): number => {
  const a = s * Math.min(l, 1 - l);
  const f = (n: number): number => {
    const k = (n + h / 30) % 12;
    return l - a * Math.max(-1, Math.min(k - 3, Math.min(9 - k, 1)));
  };
  return (Math.round(f(0) * 255) << 16) | (Math.round(f(8) * 255) << 8) | Math.round(f(4) * 255);
};

/** Server player colors are `hsl(h, s%, l%)` strings; Graphics wants ints. */
const cssToInt = (css: string | undefined): number => {
  if (!css) {
    return 0xff_ff_ff;
  }
  const hsl = /hsl\(\s*(?<h>[\d.]+)\s*,\s*(?<s>[\d.]+)%\s*,\s*(?<l>[\d.]+)%\s*\)/u.exec(
    css,
  )?.groups;
  if (hsl) {
    return hslToInt(
      Number(hsl["h"] ?? 0),
      Number(hsl["s"] ?? 0) / 100,
      Number(hsl["l"] ?? 100) / 100,
    );
  }
  const rgb = /rgb\(\s*(?<r>\d+)\s*,\s*(?<g>\d+)\s*,\s*(?<b>\d+)\s*\)/u.exec(css)?.groups;
  if (rgb) {
    return (
      (Number(rgb["r"] ?? 255) << 16) | (Number(rgb["g"] ?? 255) << 8) | Number(rgb["b"] ?? 255)
    );
  }
  const hex = /^#(?<hex>[0-9a-f]{6})$/iu.exec(css)?.groups;
  if (hex) {
    return Number.parseInt(hex["hex"] ?? "ffffff", 16);
  }
  return 0xff_ff_ff;
};
/* oxlint-enable no-bitwise */

/** TWIN orbit phase — derived from the wall clock with the exact formula
 *  remotes use, so the owner's drone and every remote render agree. */
const twinAngle = (): number => (simNow() / 1000) * TWIN_ORBIT_DEG_PER_S * DEG;

/** Initial-spawn clearance from the world edge along one axis: at least the
 *  central region, inset further when the viewport would reach the border. */
const initialSpawnInset = (dim: number, halfView: number): number =>
  Math.min(Math.max(dim * INITIAL_SPAWN_CENTER_FRAC, halfView + RESPAWN_EDGE_MARGIN), dim / 2);

/** Thruster emitter cadence (ms): NITRO doubles the rate; throttled halves it. */
const trailFrequency = (nitro: boolean, throttled: boolean): number => {
  if (nitro) {
    return throttled ? 24 : 12;
  }
  return throttled ? 50 : 25;
};

/** Trail = thruster puffs, or the NITRO flame (others must see it). */
const configureTrail = (rec: ShipObjs, nitro: boolean, throttled: boolean, glow = 1): void => {
  if (!rec.trail) {
    return;
  }
  const scale = TRAIL_PARTICLE_SCALE * glow;
  if (rec.nitroTrail !== nitro || rec.trailScale !== scale) {
    rec.nitroTrail = nitro;
    rec.trailScale = scale;
    rec.trail.updateConfig({
      lifespan: nitro ? 450 : 300,
      scale: { end: 0, start: scale },
      tint: nitro ? BOOSTER_SPECS.nitro.tint : rec.tint,
    });
  }
  const freq = trailFrequency(nitro, throttled);
  if (rec.trail.frequency !== freq) {
    rec.trail.setFrequency(freq);
  }
};

/** Neon hex ring (the beacon's whole silhouette — a huge static hexagon
 *  reads nothing like a ship). dashFrac < 1 draws each edge as dashes. */
const strokeHexRing = (
  g: Phaser.GameObjects.Graphics,
  x: number,
  y: number,
  r: number,
  rot: number,
  dashFrac: number,
): void => {
  let px = x + Math.cos(rot) * r;
  let py = y + Math.sin(rot) * r;
  for (let i = 1; i <= 6; i += 1) {
    const a = rot + (i * Math.PI) / 3;
    const nx = x + Math.cos(a) * r;
    const ny = y + Math.sin(a) * r;
    if (dashFrac >= 1) {
      g.lineBetween(px, py, nx, ny);
    } else {
      const dashes = 4;
      for (let d = 0; d < dashes; d += 1) {
        const t0 = d / dashes;
        const t1 = t0 + dashFrac / dashes;
        g.lineBetween(
          px + (nx - px) * t0,
          py + (ny - py) * t0,
          px + (nx - px) * t1,
          py + (ny - py) * t1,
        );
      }
    }
    px = nx;
    py = ny;
  }
};

/** Muzzle burst radius per weapon family (§9). */
const muzzleBurstSize = (look: WeaponLook): number => {
  if (look === "rail") {
    return 36;
  }
  if (look === "heavy" || look === "scatter") {
    return 25;
  }
  if (look === "rapid" || look === "plasma") {
    return 13;
  }
  return 19;
};

/** SIPHON heal per kill kind. */
const SIPHON_HEAL = {
  asteroid: SIPHON_HEAL_ASTEROID,
  enemy: SIPHON_HEAL_ENEMY,
  player: SIPHON_HEAL_PLAYER,
  ufo: SIPHON_HEAL_ENEMY,
} as const;

/** Hull-contact damage by enemy kind (a charging LANCER is handled by the caller). */
const hullContactDamage = (kind: EnemyKind): number => {
  if (kind === "lancer") {
    return DMG.LANCER_HULL;
  }
  if (kind === "dreadnought") {
    return BOSS_CONTACT_DMG;
  }
  return DMG.ENEMY_HULL;
};

/** Lowest HP a hit may leave the boss at. While the phase floor is `held`
 *  the current phase's lower boundary holds; afterwards one hit may only
 *  reach the TOP of the next phase. +1 keeps hp strictly above the
 *  bossPhase() f > 0.66/0.33 cut. */
const bossHpFloor = (phase: 1 | 2 | 3, held: boolean, maxHp: number): number => {
  if (held) {
    if (phase === 1) {
      return 0.66 * maxHp + 1;
    }
    return phase === 2 ? 0.33 * maxHp + 1 : 1;
  }
  if (phase === 1) {
    return 0.33 * maxHp + 1;
  }
  return phase === 2 ? 1 : 0;
};

/** Hull alpha: PHASE ghosts at 0.25, spawn invulnerability blinks, else solid. */
const shipAlpha = (phased: boolean, invuln: boolean, now: number): number => {
  if (phased) {
    return 0.25;
  }
  return invuln ? blinkAlpha(now) : 1;
};

/** Spawn-grace hull alpha: a steady dim under reduced motion, else a pulse. */
const graceAlpha = (reduced: boolean, now: number): number =>
  reduced ? 0.6 : 0.4 + 0.2 * Math.sin(now / 80);

const deathBurstSize = (boss: boolean, big: boolean): number => {
  if (boss) {
    return 270;
  }
  return big ? 95 : 48;
};

const deathTrauma = (boss: boolean, big: boolean): number => {
  if (boss) {
    return 0.5;
  }
  return big ? 0.18 : 0.1;
};

/** Enemy shot render family from the shooter's weapon look. */
const enemyShotBeamLook = (
  look: ReturnType<typeof hostileShotLook>,
): "rail" | "plasma" | "rapid" => {
  if (look === "lance" || look === "rail") {
    return "rail";
  }
  return look === "plasma" ? "plasma" : "rapid";
};

const enemyStrokeWeight = (kind: EnemyKind): number => {
  if (kind === "dreadnought") {
    return 3;
  }
  return kind === "warden" ? 2 : 1;
};

const emptyShared = (): SharedState =>
  // Every resettable field MUST be present — patches shallow-merge, so an
  // omitted key carries over.
  ({
    arenaEpoch: simNow(),
    asteroids: [],
    beacon: null,
    enemies: [],
    enemyShots: [],
    items: [],
    playH: BASE_WORLD_H,
    playW: BASE_WORLD_W,
    pulls: [],
    sectorBossIdx: -1,
    shards: [],
    ufo: null,
  });

const isShared = (v: MultiplayerClient["sharedState"]): v is SharedState =>
  Array.isArray(v["asteroids"]);

/** A SharedState as a shallow-merge patch object — field by field, no cast.
 *  Quantized at this boundary (shared/wire.ts): the working copy keeps full
 *  precision; only the serialized snapshot is rounded. */
const sharedToPatch = (s: SharedState) => ({
  arenaEpoch: Math.round(s.arenaEpoch),
  asteroids: s.asteroids.map(asteroidToWire),
  beacon: s.beacon ? beaconToWire(s.beacon) : null,
  enemies: s.enemies.map(enemyToWire),
  enemyShots: s.enemyShots.map(enemyShotToWire),
  items: s.items.map(itemToWire),
  playH: s.playH,
  playW: s.playW,
  pulls: s.pulls.map(pullToWire),
  sectorBossIdx: s.sectorBossIdx,
  shards: s.shards.map(shardToWire),
  ufo: s.ufo ? ufoToWire(s.ufo) : null,
});

/** Offline stand-in for `client.players`: the synthesized self entry (see the
 *  `peers` getter). Read-only in practice, so one shared object is safe. */
const SOLO_PEERS: PlayerMap = { solo: { id: "solo" } };

export class GameScene extends Scene {
  private client!: MultiplayerClient;
  private starfield!: Starfield;
  private barrier!: EnergyBarrier;
  private fx!: FxPool;
  private trauma = new TraumaCamera();

  /**
   * Local working copy of the shared world. The host owns it (events mutate
   * it, hostTick broadcasts it); guests dead-reckon it every frame and
   * reconcile toward the host's 20Hz snapshots — that's what keeps asteroid
   * motion smooth at 60fps despite the 20Hz wire rate.
   */
  private world: SharedState = emptyShared();
  private lastSharedRef: MultiplayerClient["sharedState"] | null = null;
  /** True only after this connected host has adopted the accepted room world. */
  private hostSnapshotReady = false;

  // my ship + weapon
  private spawned = false;
  private readonly mastery = new WeaponMastery();
  private readonly flightHud = new FlightHud();
  private shipX = 0;
  private shipY = 0;
  private shipVX = 0;
  private shipVY = 0;
  private shipAngle = 0;
  private thrust = 0;
  private alive = true;
  private respawnAt = 0;
  private invulnUntil = 0;
  // Boot at the real L1 base loadout so the HUD never shows a name the level
  // system would immediately rewrite (qa-004: WEAPON_DEFAULT is the template,
  // baseWeaponForLevel is the loadout).
  private weapon: Weapon = baseWeaponForLevel(1);
  private weaponUntil = 0;
  /** Unscaled base of the held special (null on base weapon) — re-scaled per
   *  level so specials grow with you without compounding. */
  private specialBase: Weapon | null = null;
  private shootCooldown = 0;
  /** Levelling: you level by destroying things; XP is into the current level. */
  private level = 1;
  private xp = 0;
  /** Monotonic cumulative XP earned this run — feeds diag.score. Unlike
   *  `xp` (into-level progress) it never drops on level-up or death tax. */
  private runXp = 0;
  /** dir-006 sector chase: pts this sector. Accrues wherever runXp does
   *  (pre-cap-discard, one sink), owner-resets to 0 at each sector boundary,
   *  and deaths cost exactly 0 — monotonic within a sector. Pure scoreboard. */
  private sectorScore = 0;
  /** Session-local best completed-sector score (solo recap/pulse comparison;
   *  no persistence this cycle). */
  private sectorBest = 0;
  /** Last sectorIdx observed; -1 until the first live tick so a mid-sector
   *  joiner adopts the current sector without firing a recap. */
  private lastSectorIdx = -1;
  /** Recap banner hide deadline (sim-clock ms; 0 = hidden). */
  private recapUntil = 0;
  /** Shield-regen speed multiplier from the current level (baseRegenMult). */
  private regenMult = 1;
  private beams: Beam[] = [];
  /** Phaser's activePointer sits at (0,0) until the first real pointer event —
   *  steering before then would yank the ship to the screen corner. */
  private pointerSeen = false;
  /** Held SPACE = held mouse button (qa-005). */
  private fireKey: Phaser.Input.Keyboard.Key | null = null;
  /** qa-013 one-shot: opening rocks placed after the first ship spawn. */
  private openingRocksSeeded = false;
  /** The mobile controller: a floating move-joystick that also fires while
   *  it's held (see isFiring), plus a "rest" button so a second finger fires
   *  too. Desktop keeps the mouse model (aim+thrust at the cursor); the
   *  gamepad only activates on first touch. */
  private gamepad!: PhaserGamepad;
  /** Physical controller: left stick = aim + thrust (same heading+magnitude
   *  model as the touch joystick), RT or A held = fire. */
  private readonly pad = new PhysicalGamepad({ stickDeadZone: PAD_STICK_DEAD_ZONE });
  /** Re-renders the start-screen copy on pad connect/disconnect while the
   *  overlay is up; unsubscribed the moment play begins. */
  private unwatchControls: (() => void) | null = null;
  /** Touch-only mute/pause cluster (M and Escape are keyboard-only). */
  private touchControls!: TouchControls;
  /** Items we picked up locally, awaiting host confirmation (id → time). */
  private recentPickups = new Map<string, number>();
  /** Shards we collected locally, awaiting host removal (id -> time), the
   *  same claimer-guard pattern as items. */
  private recentShardPickups = new Map<string, number>();
  /** Enemy shots we consumed locally (shield/death), awaiting host removal
   *  (id → time) — stops stale snapshots resurrecting them into the shield. */
  private recentConsumedShots = new Map<string, number>();

  // Solo fallback: if the party server can't be reached, this client becomes
  // its own host over the same code paths (events loop back, the local world
  // is authoritative, network writes no-op).
  private offline = false;
  private offlineSeeded = false;
  /** Stamped on the FIRST update() tick (not create()): heavy boots must not
   *  eat into the grace window before the socket gets a chance to connect. */
  private bootedAt = 0;
  /** True once we've ever reached a room — after that, drops reconnect. */
  private everConnected = false;
  /** Last tick's connection state, for the readmission edge. */
  private linkUp = false;
  /** Each peer's net state, parsed ONCE per frame (see update()) — identity
   *  only changes on a ~20Hz patch, and the hot paths read it many times. */
  private peerStates = new Map<string, PlayerNetState | null>();

  /** In the arena — connected, or reconnecting after a drop — or running the
   *  solo offline fallback. A drop keeps the local world ticking on prediction
   *  (nobody stares at a frozen arena); readmission reconciles it. */
  private get live(): boolean {
    return this.offline || this.connected || this.everConnected;
  }

  /** The SDK keeps hostId across a drop, so a host rides through its own blip
   *  as host: the world it authored stays authoritative and resumes streaming
   *  on readmission instead of rewinding to the server's last snapshot. If the
   *  server migrated host meanwhile, `sync` flips isHost and prepareHost
   *  demotes us — a former host never re-adopts its own stale snapshot. */
  private get amHost(): boolean {
    return this.offline || (this.live && this.client.isHost);
  }

  private get connected(): boolean {
    return this.client.connectionStatus === "connected";
  }

  private get myId(): string | null {
    return this.offline ? "solo" : this.client.playerId;
  }

  private get peers(): typeof this.client.players {
    // Offline: synthesize the self entry so every `id === myId` render path
    // (ship gfx, shield ring, impact arcs, twin drone, windup glow, nitro
    // trail, minimap own-dot) still runs solo. cssToInt(undefined) → white.
    // Trailer scenes may swap in a fake peer map (staged local "remotes").
    return this.offline ? (this.trailer?.peers ?? SOLO_PEERS) : this.client.players;
  }

  /** Events loop straight back into the local host when offline. Nothing is
   *  sent while dropped: the socket would queue every message unbounded and
   *  replay the backlog on reconnect. */
  private netSendEvent(event: string, payload: WireRecord): void {
    if (this.offline) {
      this.handleEvent(event, payload, "solo");
    } else if (this.connected) {
      this.client.sendEvent(event, payload);
    }
  }

  /** Give up on the party server after the grace window and go solo. Called
   *  every update() tick until the fallback triggers (or forever, online). */
  private maybeGoOffline(): void {
    // Start the grace window on the first tick, not at create(): counting
    // asset-load time would wrongly drop a slow-booting client to solo.
    // Real wall clock, NOT the pausable sim clock — connection deadlines must
    // keep counting through a pause (same contract as the clock module doc).
    if (this.bootedAt === 0) {
      this.bootedAt = Date.now();
    }
    if (this.connected) {
      // Readmitted as the continuing host: patches sent into the drop were
      // discarded, so the next share carries the whole world.
      if (this.everConnected && !this.linkUp && this.hostSnapshotReady) {
        this.markWorldDirty();
      }
      this.linkUp = true;
      this.everConnected = true;
      return;
    }
    this.linkUp = false;
    // Once we've been in the arena, a drop is transient — let the socket
    // reconnect instead of stranding a real player in a solo world.
    if (this.everConnected) {
      return;
    }
    // Pre-connect errors/closes are NOT instant failures: the socket retries
    // by itself, and a single refused handshake (cold server, wifi blip) must
    // not force a whole solo session. The deadline is the only trigger.
    if (Date.now() - this.bootedAt < OFFLINE_FALLBACK_MS) {
      return;
    }
    this.offline = true;
    // stop reconnect attempts; refresh to go online
    this.client.destroy();
    this.ensureSeeded();
  }

  /** Targets whose destroy bonus I already self-awarded, awaiting host removal
   *  (id → time). Dedupes the bonus for beams that survive hits (LASER pierces
   *  and re-intersects every frame until the host's echo lands). */
  private predictedKills = new Map<string, number>();

  // base shield + mod (victim-side adjudication; mirrored into net state)
  private shieldHp = SHIELD_MAX;
  private overHp = 0;
  private lastDamageAt = 0;
  private regenActive = false;
  private lastShieldLowAt = 0;
  private shieldMod: ShieldModKind | null = null;
  private shieldModUntil = 0;
  private phasedUntil = 0;
  private phaseReadyAt = 0;
  /** Post-contact-drain immunity vs ALL contact sources (rock = one hit). */
  private contactIframeUntil = 0;
  /** PvP beams persist across render frames between 20Hz snapshots: brief
   *  per-SHOOTER i-frames after each volley drain (§A.2). */
  private pvpIframeUntil = new Map<string, number>();
  /** RAM: per-target contact immunity after a hit (id → until). */
  private ramImmunity = new Map<string, number>();
  private haloFlashUntil = 0;
  private siphonPulseUntil = 0;
  /** REPAIR pickup: brief regen-sweep visual on the ring. */
  private repairSweepUntil = 0;
  /** 60° white impact arcs at the incoming-damage angle (150ms each). */
  private impactArcs: { angle: number; diesAt: number }[] = [];

  // boosters (timed, stack across kinds; mirrored into net state)
  private boosts = new Map<BoosterKind, number>();
  /** RAILGUN charge accumulator, ms (resets on release). */
  private windupAcc = 0;
  /** SENTRY turret (owner-simulated; pos+until mirrored into net state). */
  private sentry: { x: number; y: number; until: number; nextFireAt: number } | null = null;

  // combo (purely local; streak mirrored for nameplates/minimap)
  private streak = 0;
  private comboExpiresAt = 0;
  private comboTier = 1;

  // boss (host-private; recomputed from the world each tick so migration adopts it)
  private bossAlive = false;
  private lastBossKilledAt = 0;
  /** Set when host grows the play bounds — flushed into the next shared patch. */
  private playBoundsDirty = false;

  // death bookkeeping (overlay cause + adaptive hints)
  private deathCause = "";
  private deathHint = "";
  private deathCounts = new Map<string, number>();

  // networking cadence
  private netAcc = 0;
  private shareAcc = 0;
  private dirty = {
    asteroids: false,
    beacon: false,
    enemies: false,
    enemyShots: false,
    items: false,
    pulls: false,
    shards: false,
    ufo: false,
  };
  private lastAsteroidSpawnAt = 0;

  // host-only director state (lost on migration — acceptable per design)
  private enemySim = new Map<string, EnemySim>();
  private lastEnemySpawnAt = 0;
  /** False until our first hostTick — promotion stamps the spawn clocks. */
  private wasHost = false;
  private lastBreatherDespawnAt = 0;
  private debuted = new Set<EnemyKind>();
  private debutSuppressUntil = 0;
  /** Per-class pity counters (host-local, lost on migration — acceptable). */
  private lootPity = { booster: 0, shield: 0, weapon: 0 } satisfies Record<LootClass, number>;
  /** BEACON cadence clock (host-local): last beacon START. A promoted host
   *  re-derives it from a live beacon's timestamps, or stamps `now` when none
   *  is live (worst case one trough of extra delay after a migration). */
  private lastBeaconStartedAt = 0;

  // BEACON client-side bookkeeping (every client, owner-simulated awards)
  /** Last non-null beacon snapshot — expiry payout + fx trigger off it. */
  private lastBeacon: BeaconState | null = null;
  /** Highest trickle tick index already granted/skipped for this instance. */
  private beaconTickIdx = 0;
  /** Charge blips played (rising pitch, one per second of CHARGE). */
  private beaconBlipIdx = -1;
  /** True once the CHARGE→ACTIVE flash+chime fired for this instance. */
  private beaconArmedFxDone = false;
  private beaconLastClashAt = 0;

  // camera recoil (directional kick; omni shake comes from TraumaCamera)
  private kickX = 0;
  private kickY = 0;

  // display caches
  private ships = new Map<string, ShipObjs>();
  private asteroidObjs = new Map<string, AsteroidObjs>();
  private itemObjs = new Map<string, ItemObjs>();
  private enemyObjs = new Map<string, EnemyObjs>();
  private battleBackdrop!: BattleBackdrop;
  private ufoGfx: Phaser.GameObjects.Graphics | null = null;
  private ufoId = "";
  private beamGfx!: Phaser.GameObjects.Graphics;
  private shardGfx!: Phaser.GameObjects.Graphics;
  private enemyShotGfx!: Phaser.GameObjects.Graphics;
  private telegraphGfx!: Phaser.GameObjects.Graphics;
  private beaconGfx!: Phaser.GameObjects.Graphics;
  private edgePips!: EdgePips;
  private haloGfx!: Phaser.GameObjects.Graphics;
  private muzzleGfx!: Phaser.GameObjects.Graphics;
  private splinterGfx!: Phaser.GameObjects.Graphics;
  private minimapGfx!: Phaser.GameObjects.Graphics;
  private flashRect!: Phaser.GameObjects.Rectangle;
  /** Device safe-area insets (home indicator/notch), re-read on resize; keeps
   *  the canvas-drawn minimap off the home indicator. */
  private safeInset: Inset = { bottom: 0, left: 0, right: 0, top: 0 };
  /** Current trauma roll in degrees (what setAngle was last given) — Phaser 4
   *  types expose no camera `rotation` getter, so syncScreenUi reads this. */
  private camRollDeg = 0;
  /** Scratch vector for screen→world cursor mapping (zero-alloc steering). */
  private readonly pointerWorld = new PhaserMath.Vector2();
  private splinters: Splinter[] = [];
  private muzzleFlashes: MuzzleFlash[] = [];
  private remoteTrailCount = 0;

  // HUD (DOM, owned by index.html)
  private bossBarEl: HTMLElement | null = null;
  private bossHpEl: HTMLElement | null = null;
  private bossLabelEl: HTMLElement | null = null;
  private readonly bossEncounters = new BossEncounters();
  private readonly battleBeat = new BattleBeatDirector();
  private weaponEl: HTMLElement | null = null;
  private weaponBarEl: HTMLElement | null = null;
  private shieldEl: HTMLElement | null = null;
  private shieldFillEl: HTMLElement | null = null;
  private shieldOsEl: HTMLElement | null = null;
  private shieldModEl: HTMLElement | null = null;
  private shieldModBarEl: HTMLElement | null = null;
  private boostsEl: HTMLElement | null = null;
  private lastBoostsHtml = "";
  private comboEl: HTMLElement | null = null;
  private comboValEl: HTMLElement | null = null;
  private comboBarEl: HTMLElement | null = null;
  private playersEl: HTMLElement | null = null;
  private overlayEl: HTMLElement | null = null;
  private causeEl: HTMLElement | null = null;
  private hintEl: HTMLElement | null = null;
  private countdownEl: HTMLElement | null = null;
  private recoveryProgressEl: HTMLElement | null = null;
  private recoveryFillEl: HTMLElement | null = null;
  private recoveryLoadoutEl: HTMLElement | null = null;
  // dir-006 sector surfaces (DOM like the bossbar; zero input capture)
  private sectorEl: HTMLElement | null = null;
  private recapEl: HTMLElement | null = null;
  private pulseEl: HTMLElement | null = null;
  private lastSectorLine = "";
  private lastPulseText = "";
  private startEl: HTMLElement | null = null;
  /** False until the player dismisses the start screen. Gates spawning so the
   *  ship isn't dropped into a live arena while the controls are still up. */
  private started = false;
  /** Paused-as-spectator: the wrapper asked for its chrome back, so my ship is
   *  cleanly docked out of the arena (no death penalty). Gates spawn/respawn so
   *  the ship isn't re-dropped, and my net state advertises absence (present:
   *  false) so remotes silently drop me with no death FX. */
  private paused = false;
  /** Cosmetic start-screen dogfight backdrop. Non-null only until play begins. */
  private attract: AttractBattle | null = null;
  /** Trailer-mode staging overrides (src/trailer/). Null outside ?trailer=1,
   *  so every trailer guard below is dead code in normal play. */
  private trailer: TrailerStaging | null = null;

  constructor() {
    super("Game");
  }

  create(): void {
    // Bot-playtest diagnostics contract (shared/diag.ts): telemetry + the
    // active-play hook. Single-start scene, so once per page load by design.
    // setPaused rides the same offline-only freeze as the wrapper pause.
    installTestHooks({
      activePlay: () => this.forceOfflineSolo(),
      setPaused: (paused) => (paused ? this.freezeSim() : this.unfreezeSim()),
    });
    this.bossBarEl = document.querySelector("#bossbar");
    this.bossHpEl = document.querySelector("#bosshp");
    this.bossLabelEl = document.querySelector("#bosslabel");
    this.weaponEl = document.querySelector("#weapon");
    this.weaponBarEl = document.querySelector("#weaponbar");
    this.shieldEl = document.querySelector("#shield");
    this.shieldFillEl = document.querySelector("#shieldfill");
    this.shieldOsEl = document.querySelector("#shieldos");
    this.shieldModEl = document.querySelector("#shieldmod");
    this.shieldModBarEl = document.querySelector("#shieldmodbar");
    this.boostsEl = document.querySelector("#boosts");
    this.comboEl = document.querySelector("#combo");
    this.comboValEl = document.querySelector("#comboval");
    this.comboBarEl = document.querySelector("#combobar");
    this.playersEl = document.querySelector("#players");
    this.overlayEl = document.querySelector("#overlay");
    this.causeEl = document.querySelector("#cause");
    this.hintEl = document.querySelector("#hint");
    this.countdownEl = document.querySelector("#countdown");
    this.recoveryProgressEl = document.querySelector("#recovery-progress");
    this.recoveryFillEl = document.querySelector("#recovery-fill");
    this.recoveryLoadoutEl = document.querySelector("#recovery-loadout");
    this.sectorEl = document.querySelector("#sector");
    this.recapEl = document.querySelector("#recap");
    this.pulseEl = document.querySelector("#pulse");

    this.battleBackdrop = new BattleBackdrop(this);
    this.starfield = new Starfield(this);
    this.fx = new FxPool(this);

    // scene-reuse safety: drop a prior instance's Graphics
    this.barrier?.destroy();
    this.barrier = new EnergyBarrier(this);

    // Black mask past the bleed ring: entities legitimately exist beyond the
    // edge (spawning asteroids, escaping beams) but must not be visible there.
    // Inset by WORLD_BLEED_PX so the fading bleed starfield stays visible.
    const edges: readonly (readonly [number, number, number, number])[] = [
      [-MASK_PAD, -MASK_PAD, WORLD_W + MASK_PAD * 2, MASK_PAD - WORLD_BLEED_PX],
      [-MASK_PAD, WORLD_H + WORLD_BLEED_PX, WORLD_W + MASK_PAD * 2, MASK_PAD - WORLD_BLEED_PX],
      [-MASK_PAD, -WORLD_BLEED_PX, MASK_PAD - WORLD_BLEED_PX, WORLD_H + WORLD_BLEED_PX * 2],
      [
        WORLD_W + WORLD_BLEED_PX,
        -WORLD_BLEED_PX,
        MASK_PAD - WORLD_BLEED_PX,
        WORLD_H + WORLD_BLEED_PX * 2,
      ],
    ];
    for (const [x, y, w, h] of edges) {
      this.add.rectangle(x, y, w, h, 0x02_06_17).setOrigin(0).setDepth(50);
    }

    this.beamGfx = this.add.graphics().setDepth(12);
    // Shards: one pooled Graphics redrawn per frame (zero per-shard objects).
    this.shardGfx = this.add.graphics().setDepth(4).setBlendMode(BlendModes.ADD);
    this.enemyShotGfx = this.add.graphics().setDepth(12);
    this.telegraphGfx = this.add.graphics().setDepth(13).setBlendMode(BlendModes.ADD);
    // Beacon ring under ships (a zone on the floor), pips above everything
    // world-space (they're viewport furniture, still below the DOM HUD).
    this.beaconGfx = this.add.graphics().setDepth(5).setBlendMode(BlendModes.ADD);
    this.edgePips = new EdgePips(this, 40);
    this.haloGfx = this.add.graphics().setDepth(11).setBlendMode(BlendModes.ADD);
    this.muzzleGfx = this.add.graphics().setDepth(19).setBlendMode(BlendModes.ADD);
    this.splinterGfx = this.add.graphics().setDepth(15);
    this.minimapGfx = this.add.graphics().setScrollFactor(0).setDepth(100);
    this.flashRect = this.add
      .rectangle(0, 0, 4, 4, 0xff_ff_ff)
      .setOrigin(0)
      .setScrollFactor(0)
      .setDepth(90)
      .setAlpha(0);
    // Explicit offline boot (?offline=1): never dial the party server. A
    // failed WebSocket handshake logs a browser console error the page cannot
    // suppress, so an offline-by-intent run (bot playtest, deliberate solo)
    // must skip the socket entirely rather than lean on the failure fallback
    // (maybeGoOffline). Every `this.client` access is guarded by
    // `this.offline`, so the client simply never exists on this path.
    // Trailer mode (?trailer=1) is always a fully offline session: the
    // director stages "multiplayer" with local fake peers, never the network.
    if (isOfflineRequested() || new URLSearchParams(location.search).has("trailer")) {
      this.offline = true;
      this.ensureSeeded();
    } else {
      // No `initialState`: the package re-applies it whenever a client becomes
      // host, which would wipe the live world on host migration. The first host
      // seeds explicitly (see `ensureSeeded`).
      this.client = new MultiplayerClient({
        host: MULTIPLAYER_HOST,
        maxPlayers: STARFALL_MAX_PLAYERS,
        onEvent: (event, payload, from) => this.handleEvent(event, payload, from),
        party: "vg-server",
        room: ROOM,
      });
      this.client.subscribe(() => this.onUpdate());
    }

    // Desktop steers from the cursor (activePointer); the gamepad below owns
    // the touch path. These two listeners only track that a pointer exists and
    // unlock audio on the first gesture. A touch must NOT arm cursor-steer:
    // it has no resting position, so the ship would fly at wherever the finger
    // last was for the rest of the session.
    this.input.on(Input.Events.POINTER_MOVE, (p: Phaser.Input.Pointer) => {
      if (!p.wasTouch) {
        this.pointerSeen = true;
      }
    });
    this.input.on(Input.Events.POINTER_DOWN, (p: Phaser.Input.Pointer) => {
      if (!p.wasTouch) {
        this.pointerSeen = true;
      }
      // WebAudio needs a user gesture
      sfx.unlock();
    });

    // Sound is opt-in: muted by default, M toggles, choice persists (see
    // sfx). The gesture itself unlocks audio.
    // M and Escape are keyboard-only, so without this cluster a phone player
    // gets a permanently silent run they cannot pause.
    this.touchControls = createTouchControls({
      mute: { get: () => sfx.muted, set: (next) => sfx.setMuted(next) },
    });
    this.input.keyboard?.on("keydown-M", () => {
      sfx.toggleMute();
      // a device can have both a keyboard and a screen
      this.touchControls.sync();
    });

    // qa-005: held SPACE autofires exactly like a held mouse button (spec
    // Controls: "hold mouse/space to fire"). addKey captures the keystroke so
    // the page never scrolls.
    this.fireKey = this.input.keyboard?.addKey(Input.Keyboard.KeyCodes.SPACE) ?? null;

    // Mobile controller: a floating move-joystick (first finger) plus a "rest"
    // fire button — any finger that isn't the stick fires.
    // (Firing itself is one-thumbed, see isFiring.)
    this.gamepad = attachVirtualGamepad(this, {
      buttons: [{ id: "fire" }],
      onFirstTouch: () => this.enterTouchMode(),
      stick: {
        deadZone: JOYSTICK_DEAD_ZONE,
        knobRadius: JOYSTICK_KNOB_RADIUS,
        radius: JOYSTICK_RADIUS,
      },
    });
    // touch copy from boot, not first tap
    if (IS_COARSE_POINTER) {
      this.enterTouchMode();
    }
    // After the gamepad exists: writeStartCopy() reads its touch flag.
    this.buildStartScreen();

    // Cosmetic hero-vs-swarm backdrop behind the start overlay, mimicking real
    // play. Purely visual — never written to the net session (see module).
    this.attract = new AttractBattle(this, {
      enemyHull: (kind) => enemyHullPoints(kind),
      fx: this.fx,
      hullPoints: (level) => shipHullPoints(level),
      makeEnemy: (kind) => this.makeEnemyGfx(kind).setDepth(9),
      makeShip: (tint, level) => this.makeShipGfx(tint, level),
    });

    // Pause = the wrapper wants its chrome back. Online, freezing the shared
    // world would stall the other players, so we pause AS A SPECTATOR: dock my
    // ship out of the arena, then re-enter through the respawn flow. Offline
    // (solo world, no one else to stall) we truly FREEZE: the pausable sim
    // clock (shared/clock.ts) holds every stored deadline, so a boost with 3s
    // left before the pause still has 3s after resume.
    const pauseOverlay = createStarfallPauseOverlay();
    setPauseHandlers({
      onPause: () => {
        pauseOverlay.show();
        if (this.offline) {
          this.freezeSim();
        } else {
          this.pauseToSpectator();
        }
      },
      onResume: () => {
        pauseOverlay.hide();
        if (this.frozen) {
          this.unfreezeSim();
        } else {
          this.resumeFromSpectator();
        }
      },
    });

    this.scale.on(Scale.Events.RESIZE, this.onViewportChange, this);
    this.onViewportChange();
    // Start-screen framing: pre-spawn the camera sits at scroll (0,0) — the
    // world's top-left corner. At zoom 1 (desktop) the world border lands
    // exactly on the screen edge and reads as a clean frame, but phone zoom
    // (< 1) widens the worldView AROUND the viewport centre, pushing it past
    // the border into the void. Park on the world centre instead — the map
    // dwarfs every viewport, so no edge can show at any zoom. ensureSpawned
    // re-centres on the ship the moment the run starts.
    this.cameras.main.centerOn(this.world.playW / 2, this.world.playH / 2);

    // Single-start assumption: this scene is started once per page load and
    // never restarted, so create()-initialized fields are never stale. `once`
    // keeps the shutdown hook from stacking if that ever changes.
    this.events.once(Scenes.Events.SHUTDOWN, () => {
      this.scale.off(Scale.Events.RESIZE, this.onViewportChange, this);
      this.gamepad.destroy();
      this.touchControls.destroy();
      // offline already destroyed it
      if (!this.offline) {
        this.client.destroy();
      }
    });

    this.installDevHooks();
  }

  override update(time: number, delta: number): void {
    // clamp tab-switch spikes
    const dt = Math.min(delta, 100) / 1000;
    // poll the physical controller once per frame
    this.pad.update();
    // Any pad face button doubles as "press any key" on the start screen.
    if (!this.started && ["a", "b", "x", "y", "start"].some((b) => this.pad.justPressed(b))) {
      this.beginPlay();
    }
    this.starfield.update(dt, time);
    this.barrier.update(time, this.world.playW, this.world.playH);
    if (!this.offline) {
      this.maybeGoOffline();
    }
    // Start screen up: run the cosmetic dogfight backdrop behind the overlay.
    // It's purely additive — the live path below still runs (so the host keeps
    // the shared world ticking and real remote players still render/mix in).
    if (!this.started) {
      this.attract?.update(dt, this.time.now);
    }
    if (!this.live) {
      this.updateBattlePresentation(simNow());
      // Connecting (pre-live): no world to tick, but still flush attract's fx.
      this.fx.update(dt, this.time.now);
      // camera is static here; keep the vignette pinned
      this.syncScreenUi();
      // after this frame's work, so bots never read stale state
      this.publishDiag();
      return;
    }
    const now = simNow();
    // Parse every peer's net state once for this frame; readers below (aim,
    // mines, PvP, host sim, render, minimap) all pull from the map.
    this.peerStates.clear();
    // A peer mid-drop (seat held in the reconnect grace) is absent, not a
    // frozen ghost for enemies and beams to target.
    for (const [id, player] of Object.entries(this.peers)) {
      this.peerStates.set(id, player.connected === false ? null : readNetState(player));
    }

    this.ensureSpawned();
    this.seedOpeningRocks();
    this.tickRespawn(now);
    // The knob wears the local player's colour, which is only known once the
    // ship exists — so it is pushed per frame rather than fixed at attach.
    this.gamepad.setTint(this.myTint());
    this.gamepad.update();
    this.steerShip(dt);
    this.handleShooting(delta, now);
    this.updateBeams(dt, now);
    this.tickMines(now);
    this.tickSentry(now);
    this.advanceWorld(dt);
    if (this.amHost) {
      this.hostTick(now, dt, delta);
      // Never baseline the constructor's empty pre-connection world. Guests
      // instead observe accepted shared snapshots, not predicted removals.
      if (this.shared() && (!this.offline || this.offlineSeeded)) {
        this.observeBossEncounters(this.world);
      }
    }
    this.detectMyHits(now);
    this.detectIncomingDamage(now, dt);
    this.pickupItems(now);
    this.collectShards(now);
    this.tickBeaconClient(now);
    this.tickShield(now, dt);
    // Special expired → revert to the CURRENT level's base weapon, not L1.
    if (this.weaponUntil !== 0 && now >= this.weaponUntil) {
      this.specialBase = null;
      this.weapon = baseWeaponForLevel(this.level);
      this.weaponUntil = 0;
    }
    this.mastery.advance(now, this.alive, this.weapon.name);
    if (this.streak > 0 && now >= this.comboExpiresAt) {
      this.streak = 0;
      this.comboTier = 1;
    }
    // Before netSend, so a boundary's score reset reaches the wire same tick.
    this.tickSector(now);
    this.netSend(delta, now);

    this.syncShips(now, dt);
    this.syncAsteroids(now);
    this.syncUfo(now);
    this.syncItems();
    this.drawShards(now);
    this.syncEnemies(now);
    this.drawEnemyTelegraphs(now);
    this.drawPulls(now);
    this.drawBeacon(now);
    this.drawEdgePips(now);
    this.fx.battle.beginWeapons();
    this.drawEnemyShots();
    this.drawBeams(now);
    this.updateSplinters(dt, now);
    this.fx.update(dt, this.time.now);
    this.drawMinimap(now);
    // Scene choreography in phase with the pose about to be drawn, so a
    // camPos override centres on where the ship IS (see TrailerStaging.frame).
    this.trailer?.frame?.();
    this.updateCamera(dt, time);
    this.syncScreenUi();
    this.updateBattlePresentation(now);
    this.updateHud(now);
    // after this frame's work, so bots never read stale state
    this.publishDiag();
  }

  /** Resize/rotation: re-read the safe-area insets and re-derive camera zoom. */
  private onViewportChange(): void {
    this.safeInset = safeAreaInset();
    // trailer scenes own zoom (per-shot framing)
    if (this.trailer) {
      return;
    }
    const zoom = PhaserMath.Clamp(this.scale.width / CAMERA_REF_WIDTH, CAMERA_MIN_ZOOM, 1);
    this.cameras.main.setZoom(zoom);
  }

  // ---- input + my ship -------------------------------------------------------

  /** First connect: drop the ship at a clear spot and snap the camera. */
  /** The one place controls are taught. Dismissed on the first key/pointer
   *  RELEASE, not press: the fire handlers stay live behind the overlay, so
   *  starting on a press would let the same click also shoot. */
  private buildStartScreen(): void {
    this.startEl = document.querySelector("#start");
    this.writeStartCopy();
    // Plugging in a pad while the start screen is up adds its rows.
    this.unwatchControls?.();
    this.unwatchControls = watchControlContext(() => {
      if (!this.started) {
        this.writeStartCopy();
      }
    });
    this.input.keyboard?.once("keyup", () => this.beginPlay());
    // The overlay covers the canvas, so listen on the element itself — and seal
    // it, because covering the canvas is NOT enough on touch: the tap's own
    // events bubble to Phaser's window listeners, and its compatibility mouse
    // burst re-targets to the canvas the instant the overlay stops hit-testing.
    if (this.startEl) {
      sealPointerEvents(this.startEl);
      this.startEl.addEventListener("pointerup", () => this.beginPlay(), { once: true });
    }
  }

  /** Start-screen copy, re-run when the touch scheme is detected or a pad
   *  connects. Renders the same grouped keycap card the pause overlay shows
   *  (../pause-overlay buildControls); `coarse` is forced from live touch
   *  detection so a finger on a fine-pointer device still flips the copy
   *  (enterTouchMode), and pad rows appear from live detection. */
  private writeStartCopy(): void {
    const touch = IS_COARSE_POINTER || this.gamepad.isTouch;
    const controls = document.querySelector("#start-controls");
    const go = document.querySelector("#start-go");
    if (controls) {
      ensureControlsStyle();
      const card = buildControls(touch);
      controls.replaceChildren(...(card ? [card] : []));
    }
    if (go) {
      go.textContent = touch ? "tap to start" : "press any key to start";
    }
    // Reveals the overlay on the first write — see #start in index.html.
    this.startEl?.classList.add("ready");
  }

  private beginPlay(): void {
    if (this.started) {
      return;
    }
    this.started = true;
    // The sealed start overlay keeps its tap off the canvas, so this gesture is
    // the one that has to unlock WebAudio.
    sfx.unlock();
    // qa-020, offline solo ONLY: the sector clock (and the intensity curve)
    // starts at first input, not at boot — overlay-idle time was pure sector
    // loss, and a long idle met the rel-405 forced dreadnought at Lv1. Online
    // rooms keep the shared epoch untouched: the room clock predates you.
    if (this.offline) {
      this.world.arenaEpoch = simNow();
    }
    this.unwatchControls?.();
    this.unwatchControls = null;
    notifyGameStarted();
    // Tear the cosmetic battle down the instant real play begins.
    this.attract?.destroy();
    this.attract = null;
    this.startEl?.classList.add("hide");
    // Drop it only after the fade, so it can't swallow taps on the way out.
    this.time.delayedCall(320, () => this.startEl?.remove());
  }

  private recordMasteryContact(beam: Beam, enemyId: string, now: number): void {
    if (beam.mastery) {
      this.mastery.contact(beam.mastery, enemyId, beam.glaive?.returning ?? false, now);
    }
  }

  /** Test hook (shared/diag.ts): jump straight into an offline solo run —
   *  force the fallback that maybeGoOffline would reach after the 4s grace,
   *  then dismiss the start overlay. Never called during real play. */
  private forceOfflineSolo(): void {
    if (!this.offline) {
      this.offline = true;
      this.client.destroy();
      this.ensureSeeded();
    }
    this.beginPlay();
  }

  /** Per-frame diagnostics for bot playtests (shared/diag.ts). One object
   *  mutated in place; primitives only. */
  private publishDiag(): void {
    diag.frame += 1;
    diag.score = this.runXp;
    diag.player.x = this.shipX;
    diag.player.y = this.shipY;
    diag.player.speed = Math.hypot(this.shipVX, this.shipVY);
    diag.entities = this.world.enemies.length + this.world.asteroids.length;
    diag.beams = this.beams.length;
    const b = this.world.beacon;
    const bnow = simNow();
    diag.beacon =
      b && bnow < b.diesAt
        ? {
            contested: b.contested,
            controllerId: b.controllerId,
            phase: bnow < b.activeAt ? "charge" : "active",
            x: b.x,
            y: b.y,
          }
        : null;
  }

  /** Offline-only REAL freeze: stop the sim clock (every stored deadline
   *  holds), sleep the render loop, suspend audio. Never online — the shared
   *  world would stall for the other players (they get the spectator path). */
  private frozen = false;

  private freezeSim(): void {
    if (this.frozen || !this.offline) {
      return;
    }
    this.frozen = true;
    pauseClock();
    sfx.setSuspended(true);
    // stops update() until wake()
    this.game.loop.sleep();
  }

  private unfreezeSim(): void {
    if (!this.frozen) {
      return;
    }
    this.frozen = false;
    resumeClock();
    sfx.setSuspended(false);
    this.game.loop.wake();
  }

  /** Wrapper pause (online) → dock my ship out of the arena as a spectator. No
   *  death penalty, no XP loss, no death explosion: my net state simply
   *  advertises absence (present: false) so remotes drop me the way a
   *  disconnect would. Freezing the shared online world is forbidden, so the
   *  arena keeps running behind the wrapper overlay. */
  private pauseToSpectator(): void {
    if (this.paused) {
      return;
    }
    this.paused = true;
    // Clean despawn. Leaving alive=false + respawnAt=0 means tickRespawn can't
    // fire, and spawned=false hides my ship + gates every my-ship code path.
    this.spawned = false;
    this.alive = false;
    this.respawnAt = 0;
    this.beams = [];
    this.sentry = null;
    this.impactArcs = [];
    this.streak = 0;
    this.comboTier = 1;
    // Immediate, so remotes drop my ship without a snapshot of lag.
    if (this.started && this.myId) {
      this.pushMyState(simNow());
    }
    sfx.setSuspended(true);
  }

  /** Wrapper resume → re-enter through the normal respawn flow (invuln + full
   *  shield + the level's base loadout via pickRespawnPoint), online or solo. */
  private resumeFromSpectator(): void {
    if (!this.paused) {
      return;
    }
    this.paused = false;
    sfx.setSuspended(false);
    // paused before play began: nothing to re-enter
    if (!this.started) {
      return;
    }
    // Route re-entry through tickRespawn: mark spawned (so ensureSpawned won't
    // also fire) but dead with an elapsed respawn timer. Next update() re-spawns
    // me once, with invuln — never a double ship.
    this.spawned = true;
    this.alive = false;
    this.respawnAt = simNow();
  }

  private ensureSpawned(): void {
    if (!this.started || this.paused || this.spawned || !this.myId) {
      return;
    }
    // Same clearance as respawn, but confined to the map's central region —
    // an edge start opens with the void past the world border on screen. At
    // least the central third per axis, inset further when a big/zoomed-out
    // viewport would still reach the border from there.
    const cam = this.cameras.main;
    const { playW, playH } = this.world;
    const pos = this.pickRespawnPoint(
      initialSpawnInset(playW, cam.width / 2 / cam.zoom),
      initialSpawnInset(playH, cam.height / 2 / cam.zoom),
    );
    this.shipX = pos.x;
    this.shipY = pos.y;
    this.spawned = true;
    this.cameras.main.centerOn(pos.x, pos.y);
    this.spawnInFx(pos.x, pos.y);
    this.pushMyState(simNow());
  }

  /** qa-013: the 6s safe opening spawns no enemies and the seed field
   *  scatters arena-wide, so the literal first playable second was ship +
   *  dots. Park a few one-shot rocks inside the opening viewport. Host/solo
   *  only (a guest joins an already-populated arena), once per session, and
   *  never before ensureSeeded ran — a fresh world object would drop them. */
  private seedOpeningRocks(): void {
    if (this.openingRocksSeeded || !this.spawned) {
      return;
    }
    if (!this.offline && !this.amHost) {
      this.openingRocksSeeded = true;
      return;
    }
    // world not seeded yet
    if (this.world.asteroids.length === 0) {
      return;
    }
    const cam = this.cameras.main;
    const maxDist = PhaserMath.Clamp(Math.min(cam.width, cam.height) / 2 / cam.zoom - 60, 160, 320);
    const base = rand() * Math.PI * 2;
    for (let i = 0; i < OPENING_ROCK_COUNT; i += 1) {
      // Evenly fanned with jitter — always spread around the ship, never a clump.
      const ang = base + (i * Math.PI * 2) / OPENING_ROCK_COUNT + (rand() - 0.5) * 0.6;
      const dist = 140 + rand() * Math.max(20, maxDist - 140);
      const x = PhaserMath.Clamp(this.shipX + Math.cos(ang) * dist, 40, this.world.playW - 40);
      const y = PhaserMath.Clamp(this.shipY + Math.sin(ang) * dist, 40, this.world.playH - 40);
      this.world.asteroids.push(spawnOpeningAsteroid(x, y));
    }
    this.openingRocksSeeded = true;
    this.dirty.asteroids = true;
  }

  private tickRespawn(now: number): void {
    if (this.alive || this.respawnAt === 0 || now < this.respawnAt) {
      return;
    }
    const pos = this.pickRespawnPoint();
    this.shipX = pos.x;
    this.shipY = pos.y;
    this.shipVX = 0;
    this.shipVY = 0;
    this.alive = true;
    this.respawnAt = 0;
    this.invulnUntil = now + INVULNERABLE_MS;
    // respawn at full (§A.1)
    this.shieldHp = SHIELD_MAX;
    this.overHp = 0;
    this.lastDamageAt = 0;
    this.regenActive = false;
    this.weaponUntil = 0;
    // revive at the level's base weapon + regen
    this.applyBaseLoadout(now);
    this.kickX = 0;
    this.kickY = 0;
    this.cameras.main.centerOn(pos.x, pos.y);
    this.spawnInFx(pos.x, pos.y);
    sfx.play("respawn");
    this.pushMyState(now);
  }

  /** Re-roll until clear of enemies + big asteroids; ≤8 attempts, take best. */
  private pickRespawnPoint(marginX = RESPAWN_EDGE_MARGIN, marginY = marginX): Vec {
    // respawn within the LIVE (scaled) play area
    const { playW, playH } = this.world;
    let best = randomWorldPoint(marginX, marginY, playW, playH);
    let bestClearance = -1;
    for (let i = 0; i < RESPAWN_ATTEMPTS; i += 1) {
      const p = randomWorldPoint(marginX, marginY, playW, playH);
      let minD = Infinity;
      for (const e of this.world.enemies) {
        minD = Math.min(minD, Math.hypot(e.x - p.x, e.y - p.y));
      }
      for (const a of this.world.asteroids) {
        if (a.radius >= RESPAWN_ASTEROID_MIN_R) {
          minD = Math.min(minD, Math.hypot(a.x - p.x, a.y - p.y));
        }
      }
      if (minD >= RESPAWN_CLEARANCE) {
        return p;
      }
      if (minD > bestClearance) {
        bestClearance = minD;
        best = p;
      }
    }
    return best;
  }

  /** Anticipation → ring → the hull pops in (alpha handled by invuln blink). */
  private spawnInFx(x: number, y: number): void {
    const tint = this.myTint();
    this.fx.converge(x, y, 12, 60, 300, tint, "important");
    this.time.delayedCall(300, () => this.fx.ring(x, y, 6, 30, 200, tint, 0.7, "important"));
  }

  /**
   * The control identity, now with drift: the nose points along the steer
   * direction (instant), thrust accelerates that way scaled by how far it's
   * pushed, and exponential drag makes you glide. Stopping (dead zone) brakes
   * harder than flying — responsive stop, drifty start.
   *
   * Desktop reads the steer vector from ship→cursor. Touch reads it from the
   * floating move-joystick (drag from the anchor): same model, different
   * source — `steerVector` unifies them.
   */
  private steerShip(dt: number): void {
    if (!this.alive || !this.spawned) {
      return;
    }
    // NITRO deliberately breaks the "every projectile outruns the ship" floor.
    const nitro = this.boosts.has("nitro");
    const accel = SHIP_ACCEL * (nitro ? NITRO_ACCEL_MULT : 1);
    const maxSpeed = SHIP_MAX_SPEED * (nitro ? NITRO_MAX_SPEED_MULT : 1);
    let drag = SHIP_BRAKE_DRAG;
    this.thrust = 0;
    const steer = this.steerVector();
    if (steer) {
      if (steer.aim) {
        this.shipAngle = steer.angle;
      }
      this.thrust = steer.thrust;
      if (this.thrust > 0) {
        this.shipVX += Math.cos(steer.angle) * accel * this.thrust * dt;
        this.shipVY += Math.sin(steer.angle) * accel * this.thrust * dt;
      }
      drag = steer.dist > steer.deadZone ? SHIP_DRAG : SHIP_BRAKE_DRAG;
    }
    const decay = Math.exp(-drag * dt);
    this.shipVX *= decay;
    this.shipVY *= decay;
    const speed = Math.hypot(this.shipVX, this.shipVY);
    if (speed > maxSpeed) {
      const k = maxSpeed / speed;
      this.shipVX *= k;
      this.shipVY *= k;
    }
    this.shipX += this.shipVX * dt;
    this.shipY += this.shipVY * dt;
    // Wall clamp kills the perpendicular component: slide along edges.
    if (this.shipX < 0 || this.shipX > this.world.playW) {
      this.shipX = PhaserMath.Clamp(this.shipX, 0, this.world.playW);
      this.shipVX = 0;
    }
    if (this.shipY < 0 || this.shipY > this.world.playH) {
      this.shipY = PhaserMath.Clamp(this.shipY, 0, this.world.playH);
      this.shipVY = 0;
    }
  }

  /** The unified steering input: heading, 0–1 thrust, the dead-zone test (so
   *  steerShip can pick drift vs brake drag), and `aim` (whether to re-point
   *  the nose this frame). Null = no live input.
   *
   *  `aim` differs by source on purpose: the desktop nose tracks the cursor
   *  even inside the dead zone (the cursor-aim identity — you keep aiming while
   *  braking), but the touch nose holds steady when the finger sits near the
   *  joystick anchor (no jitter from a parked thumb). */
  private steerVector(): {
    angle: number;
    thrust: number;
    dist: number;
    deadZone: number;
    aim: boolean;
  } | null {
    // Trailer mode: the director owns steering outright — real input sources
    // are never read, so a stray cursor can't steal the ship mid-take.
    const { trailer } = this;
    if (trailer) {
      const s = trailer.steer;
      if (!s) {
        return null;
      }
      return {
        aim: true,
        angle: s.angle,
        deadZone: SHIP_DEAD_ZONE,
        dist: s.thrust > 0 ? SHIP_DEAD_ZONE + SHIP_THRUST_RAMP * s.thrust : 0,
        thrust: s.thrust,
      };
    }
    // Physical stick past its dead zone owns the frame (same heading+magnitude
    // model as the touch joystick, and the same override rule touch applies to
    // the mouse); inside the dead zone it yields, so an idle pad never fights
    // the cursor and the nose holds when nothing else is steering.
    if (this.pad.connected) {
      const stick = this.pad.getStick();
      if (!stick.inDeadZone) {
        return {
          aim: true,
          angle: stick.angle,
          deadZone: PAD_STICK_DEAD_ZONE,
          dist: stick.distance,
          thrust: stick.magnitude,
        };
      }
    }
    if (this.gamepad.isTouch) {
      const stick = this.gamepad.getStick();
      if (!stick.active) {
        return null;
      }
      return {
        aim: !stick.inDeadZone,
        angle: stick.angle,
        deadZone: JOYSTICK_DEAD_ZONE,
        dist: stick.distance,
        thrust: stick.magnitude,
      };
    }
    if (!this.pointerSeen) {
      return null;
    }
    const p = this.input.activePointer;
    // Screen→world through the camera: scrollX alone mis-aims under zoom < 1.
    const cursor = this.cameras.main.getWorldPoint(p.x, p.y, this.pointerWorld);
    const dx = cursor.x - this.shipX;
    const dy = cursor.y - this.shipY;
    const dist = Math.hypot(dx, dy);
    const thrust = Math.min(1, Math.max(0, (dist - SHIP_DEAD_ZONE) / SHIP_THRUST_RAMP));
    return { aim: dist > 0.001, angle: Math.atan2(dy, dx), deadZone: SHIP_DEAD_ZONE, dist, thrust };
  }

  /** Rewrite the start-screen copy for the touch control scheme. Fired at boot
   *  on coarse-pointer devices, else the first time a finger lands. */
  private enterTouchMode(): void {
    this.writeStartCopy();
  }

  /** Holding fire: any finger on touch, the mouse button or held SPACE on
   *  desktop, or RT / A held on a physical controller (merged, never
   *  exclusive).
   *
   *  Touch mirrors the desktop model — there the pointer that steers is the
   *  same one that fires, so the joystick finger fires too. A second finger
   *  (the "rest" fire button) also fires, but it is a bonus: the phone is
   *  playable one-thumbed, exactly as the start screen's HOLD → SHOOT
   *  promises. */
  private isFiring(): boolean {
    // trailer: scripted trigger only
    if (this.trailer) {
      return this.trailer.fire;
    }
    if (this.pad.connected && (this.pad.isButtonDown("rt") || this.pad.isButtonDown("a"))) {
      return true;
    }
    if (this.fireKey?.isDown) {
      return true;
    }
    return this.gamepad.isTouch
      ? this.gamepad.getStick().active || this.gamepad.isButtonDown("fire")
      : this.input.activePointer.isDown;
  }

  private handleShooting(delta: number, now: number): void {
    if (!this.alive || !this.spawned) {
      return;
    }
    // The cooldown runs into (bounded) deficit and each shot pays intervalMs
    // back, so the leftover carries between shots — true average cadence on
    // any refresh rate instead of rounding up to whole frames. OVERDRIVE
    // multiplies intervalMs and windupMs at fire time (+50% rate).
    const rateMult = this.boosts.has("overdrive") ? OVERDRIVE_RATE_MULT : 1;
    const interval = this.weapon.intervalMs * rateMult;
    this.shootCooldown = Math.max(-interval, this.shootCooldown - delta);
    if (!this.alive || !this.spawned || now < this.phasedUntil) {
      this.windupAcc = 0;
      return;
    }
    if (!this.isFiring()) {
      // releasing mid-windup cancels
      this.windupAcc = 0;
      return;
    }
    const windupMs = this.weapon.windupMs * rateMult;
    if (windupMs > 0) {
      // Charge runs inside the interval (cycle = max(interval, windup)) and
      // auto-repeats while held — the one-button identity holds.
      this.windupAcc = Math.min(windupMs, this.windupAcc + delta);
      if (this.windupAcc < windupMs || this.shootCooldown > 0) {
        return;
      }
      this.windupAcc = 0;
    } else {
      this.windupAcc = 0;
      if (this.shootCooldown > 0) {
        return;
      }
    }
    this.shootCooldown += interval;
    this.fireWeapon(now);
  }

  /** 0–1 charge fraction of a windup weapon (0 for everything else). */
  private windupFrac(): number {
    const rateMult = this.boosts.has("overdrive") ? OVERDRIVE_RATE_MULT : 1;
    const windupMs = this.weapon.windupMs * rateMult;
    return windupMs > 0 ? Math.min(1, this.windupAcc / windupMs) : 0;
  }

  /** One volley of the current weapon (pellets / arc cast / mine / nova). */
  private fireWeapon(now: number): void {
    const nose = {
      x: this.shipX + Math.cos(this.shipAngle) * SHIP_RADIUS,
      y: this.shipY + Math.sin(this.shipAngle) * SHIP_RADIUS,
    };
    const w = this.weapon;
    const { arc } = w;
    let gainScale = 1;
    if (arc && w.aura) {
      // TESLA AURA: nothing in range = a silent tick (no sound, no muzzle).
      if (!this.fireAuraZap(now, arc)) {
        return;
      }
    } else if (arc) {
      // fizzle: quieter zap
      if (this.fireArc(now, nose, arc)) {
        gainScale = 0.5;
      }
    } else if (w.mine) {
      this.dropMine(now);
    } else if (w.cluster) {
      this.fireClusterVolley(w);
    } else if (w.explosion && w.speed === 0) {
      // NOVA: radial shockwave centered on the ship — serialized as an
      // exploding beam (existing fields), so victims/remotes need zero new code.
      const b = this.makeBeam({ x: this.shipX, y: this.shipY }, this.shipAngle, w, now);
      b.released = true;
      b.exploding = true;
      this.beams.push(b);
      this.fx.battle.burst(
        this.shipX,
        this.shipY,
        Math.min(260, w.explosion.range * 0.85),
        w.tint,
        "detonation",
        0,
        "important",
      );
    } else {
      // SENTRY: the trigger also places/moves the turret (sound gated there).
      if (w.sentry) {
        this.placeSentry(now);
      }
      // PLASMA: per-shot tint lerps the hot pink->orange gradient.
      const vw = w.sfx === "plasma" ? { ...w, tint: lerpTint(PLASMA_TINT_A, PLASMA_TINT_B) } : w;
      this.firePellets(nose, this.shipAngle, vw, now);
      if (vw.mirror) {
        // MIRROR: the 180-deg copy launches from the tail.
        const back = {
          x: this.shipX - Math.cos(this.shipAngle) * SHIP_RADIUS,
          y: this.shipY - Math.sin(this.shipAngle) * SHIP_RADIUS,
        };
        this.firePellets(back, this.shipAngle + Math.PI, vw, now);
      }
      // TWIN mirrors beams only (mines/nova excluded above by branch).
      const twin = this.twinPos();
      if (twin) {
        const tw = { ...vw, power: vw.power * TWIN_POWER_MULT };
        this.firePellets(twin, this.shipAngle, tw, now);
        if (tw.mirror) {
          this.firePellets(twin, this.shipAngle + Math.PI, tw, now);
        }
      }
    }
    this.muzzleFx(nose, now, gainScale);
  }

  /** TESLA AURA: zap the nearest non-player target within castRange of the
   *  SHIP (omnidirectional, no cone) — a single-hop ARC chain. Players are
   *  excluded on purpose: PvP runs victim-side off the serialized `tesla`
   *  flag (RAM pattern), so a chain hit-test would double-dip. Returns
   *  false when nothing was in range (the caller stays silent). */
  private fireAuraZap(now: number, spec: NonNullable<Weapon["arc"]>): boolean {
    const r2 = spec.castRange * spec.castRange;
    let best: { ref: TargetRef; x: number; y: number } | null = null;
    let bestD = Infinity;
    for (const e of this.world.enemies) {
      const d = dist2(e.x, e.y, this.shipX, this.shipY);
      if (d <= r2 && d < bestD) {
        bestD = d;
        best = { ref: { id: e.id, kind: "enemy" }, x: e.x, y: e.y };
      }
    }
    const u = this.world.ufo;
    if (u) {
      const d = dist2(u.x, u.y, this.shipX, this.shipY);
      if (d <= r2 && d < bestD) {
        bestD = d;
        best = { ref: { kind: "ufo" }, x: u.x, y: u.y };
      }
    }
    for (const a of this.world.asteroids) {
      const d = dist2(a.x, a.y, this.shipX, this.shipY);
      if (d <= r2 && d < bestD) {
        bestD = d;
        best = { ref: { id: a.id, kind: "asteroid" }, x: a.x, y: a.y };
      }
    }
    if (!best) {
      return false;
    }
    const origin = { x: this.shipX, y: this.shipY };
    const chain: Vec[] = [origin, { x: best.x, y: best.y }];
    this.applyArcDamage(best.ref, best.x, best.y, this.weapon.power * 100, now);
    this.beams.push({
      ...this.makeBeam(
        origin,
        Math.atan2(best.y - this.shipY, best.x - this.shipX),
        this.weapon,
        now,
      ),
      chain,
      diesAt: now + ARC_RENDER_MS,
    });
    return true;
  }

  /** SENTRY: place (or move) the one turret at the ship; re-placing
   *  refreshes its 12s life. The clack only plays on a real move so
   *  drag-firing doesn't machine-gun the sound. */
  private placeSentry(now: number): void {
    const prev = this.sentry;
    const moved = !prev || dist2(prev.x, prev.y, this.shipX, this.shipY) > 100 * 100;
    this.sentry = {
      nextFireAt: prev?.nextFireAt ?? 0,
      until: now + SENTRY_LIFETIME_MS,
      x: this.shipX,
      y: this.shipY,
    };
    if (moved) {
      sfx.play("sentry_place", { priority: "local" });
      this.fx.ring(this.shipX, this.shipY, 4, 18, 200, SENTRY_WEAPON.tint, 0.6);
    }
  }

  /** SENTRY turret sim: every SENTRY_FIRE_MS fire a bolt (ordinary owner
   *  beam — hits, score and serialization all ride the normal pipelines)
   *  at the nearest enemy, else the nearest asteroid, within range. */
  private tickSentry(now: number): void {
    const s = this.sentry;
    if (!s) {
      return;
    }
    if (!this.alive || now >= s.until) {
      this.sentry = null;
      return;
    }
    if (now < s.nextFireAt) {
      return;
    }
    const r2 = SENTRY_RANGE * SENTRY_RANGE;
    let best: Vec | null = null;
    let bestD = Infinity;
    for (const e of this.world.enemies) {
      const d = dist2(e.x, e.y, s.x, s.y);
      if (d <= r2 && d < bestD) {
        bestD = d;
        best = { x: e.x, y: e.y };
      }
    }
    if (!best) {
      for (const a of this.world.asteroids) {
        const d = dist2(a.x, a.y, s.x, s.y);
        if (d <= r2 && d < bestD) {
          bestD = d;
          best = { x: a.x, y: a.y };
        }
      }
    }
    // nothing in range: rescan next frame, no cooldown
    if (!best) {
      return;
    }
    const ang = Math.atan2(best.y - s.y, best.x - s.x);
    this.beams.push(this.makeBeam({ x: s.x, y: s.y }, ang, SENTRY_WEAPON, now));
    s.nextFireAt = now + SENTRY_FIRE_MS;
    this.fx.battle.burst(s.x, s.y, 18, SENTRY_WEAPON.tint, "muzzle", ang);
    this.fx.sparks(s.x, s.y, 2, SENTRY_WEAPON.tint, { lifeMax: 140, lifeMin: 80, scale: 0.4 });
    if (this.onScreen(s.x, s.y)) {
      sfx.play("fire_pulse", { gain: 0.35, rate: 1.15 });
    }
  }

  /** TESLA AURA live = weapon held and able to fire (mirrored to the wire). */
  private teslaActive(now: number): boolean {
    return (
      this.weapon.aura && this.alive && this.spawned && this.isFiring() && now >= this.phasedUntil
    );
  }

  /** The pellet/spread loop, parameterized by origin (ship nose or TWIN drone). */
  private firePellets(origin: Vec, aimAngle: number, weapon: Weapon, now: number): void {
    const n = weapon.pellets;
    for (let i = 0; i < n; i += 1) {
      const spread = n > 1 ? -weapon.spreadDeg / 2 + (weapon.spreadDeg * i) / (n - 1) : 0;
      const jitter = (rand() * 2 - 1) * weapon.jitterDeg;
      const angle = aimAngle + (spread + jitter) * DEG;
      this.beams.push(this.makeBeam(origin, angle, weapon, now));
    }
  }

  /** TWIN drone position while the booster is live, else null. */
  private twinPos(): Vec | null {
    if (!this.boosts.has("twin")) {
      return null;
    }
    const a = twinAngle();
    return {
      x: this.shipX + Math.cos(a) * TWIN_ORBIT_RADIUS,
      y: this.shipY + Math.sin(a) * TWIN_ORBIT_RADIUS,
    };
  }

  /** CLUSTER: launch `missiles` staggered homing missiles. Each missile
   *  re-runs the nose position + HOMING lock at its own launch instant, so
   *  the stagger fans locks across a crowd. TWIN mirrors every missile
   *  (cluster missiles are ordinary beams). */
  private fireClusterVolley(w: Weapon): void {
    const spec = w.cluster;
    if (!spec) {
      return;
    }
    const launch = (): void => {
      if (!this.alive || !this.spawned) {
        return;
      }
      const t = simNow();
      const nose = {
        x: this.shipX + Math.cos(this.shipAngle) * SHIP_RADIUS,
        y: this.shipY + Math.sin(this.shipAngle) * SHIP_RADIUS,
      };
      this.firePellets(nose, this.shipAngle, w, t);
      const twin = this.twinPos();
      if (twin) {
        this.firePellets(twin, this.shipAngle, { ...w, power: w.power * TWIN_POWER_MULT }, t);
      }
    };
    launch();
    for (let i = 1; i < spec.missiles; i += 1) {
      this.time.delayedCall(spec.staggerMs * i, launch);
    }
  }

  /** Drop a proximity mine at the ship's tail (owner-simulated, in beams[]). */
  private dropMine(now: number): void {
    const live = this.beams.filter((b) => b.mine && !b.exploding && !b.vanished);
    if (live.length >= MINE_MAX_LIVE) {
      const [oldest] = live;
      if (oldest) {
        // Over the cap: the oldest detonates harmlessly at 30% scale.
        oldest.vanished = true;
        const range = oldest.weapon.explosion?.range ?? 90;
        this.fx.ring(oldest.head.x, oldest.head.y, 4, range * 0.3, 200, oldest.weapon.tint, 0.4);
      }
    }
    const tail = {
      x: this.shipX - Math.cos(this.shipAngle) * (SHIP_RADIUS + 4),
      y: this.shipY - Math.sin(this.shipAngle) * (SHIP_RADIUS + 4),
    };
    const b = this.makeBeam(tail, this.shipAngle, this.weapon, now);
    b.released = true;
    b.mine = { armAt: now + MINE_ARM_MS };
    b.diesAt = now + MINE_LIFETIME_MS;
    this.beams.push(b);
  }

  private makeBeam(nose: Vec, angle: number, weapon: Weapon, now: number): Beam {
    const b: Beam = {
      angle,
      bouncesLeft: weapon.ricochet?.bounces ?? 0,
      chain: null,
      collapseUntil: 0,
      // Range-limited beams (PLASMA stream, SINGULARITY flight) expire after
      // range px of travel; everything else rides 0 (callers may override).
      diesAt: weapon.range > 0 && weapon.speed > 0 ? now + (weapon.range / weapon.speed) * 1000 : 0,
      exploding: false,
      explosionRadius: 0,
      fizzle: false,
      glaive: weapon.boomerang ? { returning: false, traveled: 0 } : null,
      head: { ...nose },
      hitIds: new Set(),
      mastery: this.trailer ? null : this.mastery.shot(weapon.name, now),
      mine: null,
      released: false,
      // desync glaive spin phases a little
      spin: now % 1000,
      tail: { ...nose },
      target: weapon.homing ? this.acquireHomingTarget(nose, weapon.homing.acquireRange) : null,
      traveled: 0,
      vanished: false,
      weapon,
    };
    if (weapon.windupMs > 0 && weapon.length > 0) {
      // RAILGUN: near-hitscan — the full lance renders (and hits) immediately.
      b.head.x += Math.cos(angle) * weapon.length;
      b.head.y += Math.sin(angle) * weapon.length;
      b.released = true;
    }
    return b;
  }

  /** Muzzle flash + camera kick + fire sfx, per weapon family (§9). */
  private muzzleFx(nose: Vec, now: number, gainScale = 1): void {
    const w = this.weapon;
    const sound = weaponSound(w.sfx);
    const playOpts: PlayOpts = { gain: sound.gain * gainScale, priority: "local" };
    if (sound.rate !== undefined) {
      playOpts.rate = sound.rate;
    }
    sfx.play(sound.name, playOpts);
    // Every burst below sits ON the pilot's nose, so all of it damps together
    // in trailer mode (1 everywhere else — see hullGlow).
    const glow = this.hullGlow();
    const look = weaponLook(w);
    if (look !== "nova") {
      const size = muzzleBurstSize(look);
      this.fx.battle.burst(
        nose.x,
        nose.y,
        size * glow,
        w.tint,
        "muzzle",
        this.shipAngle,
        "important",
      );
    }
    // OVERDRIVE: muzzle flashes gain a gold outer spark.
    if (this.boosts.has("overdrive")) {
      this.fx.sparks(nose.x, nose.y, 2, 0xfa_cc_15, {
        lifeMax: 180,
        lifeMin: 100,
        scale: 0.5 * glow,
        speedMax: 320,
        speedMin: 150,
      });
    }
    const aimDeg = this.shipAngle / DEG;
    switch (w.sfx) {
      case "mine": {
        // Drop, not a shot: tiny puff, no kick.
        this.fx.sparks(nose.x, nose.y, 2, w.tint, {
          lifeMax: 160,
          lifeMin: 100,
          scale: 0.4 * glow,
        });
        break;
      }
      case "nova": {
        // The expanding ring IS the effect; no muzzle, no kick.
        break;
      }
      case "rail": {
        // Heavy release (§C): kick 5px, trauma +0.08.
        this.fx.sparks(nose.x, nose.y, 5, w.tint, {
          angleMax: aimDeg + 12,
          angleMin: aimDeg - 12,
          lifeMax: 200,
          lifeMin: 120,
          scale: 0.5 * glow,
          speedMax: 450,
          speedMin: 250,
        });
        this.muzzleFlashes.push({
          angle: this.shipAngle,
          diesAt: now + 50,
          kind: "cross",
          size: 12,
          tint: w.tint,
          x: nose.x,
          y: nose.y,
        });
        this.trauma.add(0.08);
        this.kick(5);
        break;
      }
      case "tesla": {
        // The zap chain is the whole show — no muzzle, no kick.
        break;
      }
      case "heavy":
      case "glaive":
      case "drill":
      case "singularity": {
        this.fx.sparks(nose.x, nose.y, 5, w.tint, {
          angleMax: aimDeg + 15,
          angleMin: aimDeg - 15,
          lifeMax: 200,
          lifeMin: 120,
          scale: 0.5 * glow,
          speedMax: 400,
          speedMin: 200,
        });
        this.muzzleFlashes.push({
          angle: this.shipAngle,
          diesAt: now + 50,
          kind: "cross",
          size: 10,
          tint: w.tint,
          x: nose.x,
          y: nose.y,
        });
        this.trauma.add(0.06);
        this.kick(4);
        break;
      }
      case "zap": {
        this.muzzleFlashes.push({
          angle: this.shipAngle,
          diesAt: now + 60,
          kind: "line",
          size: 14,
          tint: w.tint,
          x: nose.x,
          y: nose.y,
        });
        this.kick(3);
        break;
      }
      case "arc":
      case "seek": {
        this.fx.sparks(nose.x, nose.y, 4, w.tint, {
          lifeMax: 160,
          lifeMin: 100,
          scale: 0.5 * glow,
          speedMax: 250,
          speedMin: 100,
        });
        this.muzzleFlashes.push({
          angle: 0,
          diesAt: now + 30,
          kind: "ring",
          size: 8,
          tint: w.tint,
          x: nose.x,
          y: nose.y,
        });
        this.kick(2);
        break;
      }
      default: {
        // pulse family (NORMAL, TINY, SCATTER, EXPLOSION)
        this.fx.sparks(nose.x, nose.y, 3, w.tint, {
          angleMax: aimDeg + 15,
          angleMin: aimDeg - 15,
          lifeMax: 180,
          lifeMin: 100,
          scale: 0.5 * glow,
          speedMax: 400,
          speedMin: 200,
        });
        this.muzzleFlashes.push({
          angle: this.shipAngle,
          diesAt: now + 30,
          kind: "cross",
          size: 6,
          tint: w.tint,
          x: nose.x,
          y: nose.y,
        });
        this.kick(2);
        break;
      }
    }
  }

  /** Directional camera recoil opposite the shot. */
  private kick(px: number): void {
    this.kickX -= Math.cos(this.shipAngle) * px;
    this.kickY -= Math.sin(this.shipAngle) * px;
  }

  /** HOMING lock: nearest target in a front cone, enemies > players > UFO > asteroids. */
  private acquireHomingTarget(nose: Vec, range: number): TargetRef | null {
    const half = (HOMING_LOCK_CONE_DEG / 2) * DEG;
    const inCone = (x: number, y: number): number | null => {
      const d = Math.hypot(x - nose.x, y - nose.y);
      if (d > range) {
        return null;
      }
      const ang = Math.atan2(y - nose.y, x - nose.x);
      return Math.abs(wrapAngle(ang - this.shipAngle)) <= half ? d : null;
    };
    let bestD = Infinity;
    let best: TargetRef | null = null;
    for (const e of this.world.enemies) {
      const d = inCone(e.x, e.y);
      if (d !== null && d < bestD) {
        bestD = d;
        best = { id: e.id, kind: "enemy" };
      }
    }
    if (best) {
      return best;
    }
    const { myId } = this;
    for (const [id, st] of this.peerStates) {
      if (id === myId) {
        continue;
      }
      if (!st || !st.alive || st.invuln || st.shieldMod?.phased) {
        continue;
      }
      const d = inCone(st.x, st.y);
      if (d !== null && d < bestD) {
        bestD = d;
        best = { id, kind: "player" };
      }
    }
    if (best) {
      return best;
    }
    const u = this.world.ufo;
    if (u && inCone(u.x, u.y) !== null) {
      return { kind: "ufo" };
    }
    for (const a of this.world.asteroids) {
      const d = inCone(a.x, a.y);
      if (d !== null && d < bestD) {
        bestD = d;
        best = { id: a.id, kind: "asteroid" };
      }
    }
    return best;
  }

  /** Current world position of a target ref, or null if it's gone. */
  private resolveTarget(ref: TargetRef): Vec | null {
    switch (ref.kind) {
      case "enemy": {
        const e = this.world.enemies.find((x) => x.id === ref.id);
        return e ? { x: e.x, y: e.y } : null;
      }
      case "player": {
        const st = this.peerStates.get(ref.id) ?? null;
        return st && st.alive ? { x: st.x, y: st.y } : null;
      }
      case "ufo": {
        const u = this.world.ufo;
        return u ? { x: u.x, y: u.y } : null;
      }
      case "asteroid": {
        const a = this.world.asteroids.find((x) => x.id === ref.id);
        return a ? { x: a.x, y: a.y } : null;
      }
      default: {
        return ref satisfies never;
      }
    }
  }

  /**
   * ARC: hitscan chain lightning. Damage applies at cast; the bolt then lives
   * ARC_RENDER_MS as a re-jittered polyline. The chain is serialized so
   * remotes render the exact geometry and PvP victims hit-test it — except
   * fizzles, which stay local. Returns true when the cast fizzled.
   */
  private fireArc(now: number, nose: Vec, spec: NonNullable<Weapon["arc"]>): boolean {
    const candidates = this.arcCandidates();
    const half = (ARC_CAST_CONE_DEG / 2) * DEG;
    let first: { ref: TargetRef; x: number; y: number } | null = null;
    let bestD = Infinity;
    for (const c of candidates) {
      const d = Math.hypot(c.x - nose.x, c.y - nose.y);
      if (d > spec.castRange || d >= bestD) {
        continue;
      }
      const ang = Math.atan2(c.y - nose.y, c.x - nose.x);
      if (Math.abs(wrapAngle(ang - this.shipAngle)) > half) {
        continue;
      }
      bestD = d;
      first = c;
    }
    if (!first) {
      // Fizzle: 80px jittered bolt, no damage, never serialized (a fizzle must
      // not hit-test against PvP victims); fireWeapon quiets the zap.
      const jang = this.shipAngle + (Math.random() * 2 - 1) * 10 * DEG;
      const chain: Vec[] = [
        { ...nose },
        {
          x: nose.x + Math.cos(jang) * ARC_FIZZLE_LEN,
          y: nose.y + Math.sin(jang) * ARC_FIZZLE_LEN,
        },
      ];
      this.beams.push({
        ...this.makeBeam(nose, this.shipAngle, this.weapon, now),
        chain,
        diesAt: now + ARC_RENDER_MS,
        fizzle: true,
      });
      return true;
    }
    const hitRefs: { ref: TargetRef; x: number; y: number }[] = [first];
    const used = new Set<string>([targetKey(first.ref)]);
    let cur = first;
    for (let hop = 0; hop < spec.jumps; hop += 1) {
      let next: { ref: TargetRef; x: number; y: number } | null = null;
      let nd = Infinity;
      for (const c of candidates) {
        if (used.has(targetKey(c.ref))) {
          continue;
        }
        const d = Math.hypot(c.x - cur.x, c.y - cur.y);
        if (d <= spec.hopRange && d < nd) {
          nd = d;
          next = c;
        }
      }
      if (!next) {
        break;
      }
      used.add(targetKey(next.ref));
      hitRefs.push(next);
      cur = next;
    }
    const chain: Vec[] = [{ ...nose }];
    let dmg = this.weapon.power * 100;
    for (const t of hitRefs) {
      chain.push({ x: t.x, y: t.y });
      this.applyArcDamage(t.ref, t.x, t.y, dmg, now);
      dmg *= spec.falloff;
    }
    this.beams.push({
      ...this.makeBeam(nose, this.shipAngle, this.weapon, now),
      chain,
      diesAt: now + ARC_RENDER_MS,
    });
    return false;
  }

  private arcCandidates(): { ref: TargetRef; x: number; y: number }[] {
    const out: { ref: TargetRef; x: number; y: number }[] = [];
    for (const e of this.world.enemies) {
      out.push({ ref: { id: e.id, kind: "enemy" }, x: e.x, y: e.y });
    }
    const { myId } = this;
    for (const [id, st] of this.peerStates) {
      if (id === myId) {
        continue;
      }
      if (st && st.alive && !st.invuln && !st.shieldMod?.phased) {
        out.push({ ref: { id, kind: "player" }, x: st.x, y: st.y });
      }
    }
    const u = this.world.ufo;
    if (u) {
      out.push({ ref: { kind: "ufo" }, x: u.x, y: u.y });
    }
    for (const a of this.world.asteroids) {
      out.push({ ref: { id: a.id, kind: "asteroid" }, x: a.x, y: a.y });
    }
    return out;
  }

  private applyArcDamage(ref: TargetRef, x: number, y: number, dmgHp: number, now: number): void {
    this.fx.battle.burst(
      x,
      y,
      22,
      this.weapon.tint,
      "impact",
      Math.atan2(y - this.shipY, x - this.shipX),
    );
    this.fx.sparks(x, y, 9, this.weapon.tint, { lifeMax: 300, lifeMin: 150 });
    sfx.play("hit_spark", { gain: 0.4 });
    switch (ref.kind) {
      case "enemy": {
        const e = this.world.enemies.find((en) => en.id === ref.id);
        if (!e) {
          return;
        }
        e.blinkUntil = now + 150;
        if (e.hp - dmgHp <= 0) {
          this.predictKill(e.id, this.enemyKillXp(e.kind), "enemy", e.x, e.y, now);
        }
        this.netSendEvent("enemy_hit", { damage: dmgHp, enemyId: e.id });
        return;
      }
      case "asteroid": {
        const a = this.world.asteroids.find((as) => as.id === ref.id);
        if (!a) {
          return;
        }
        const power = dmgHp / 100;
        const predicted =
          asteroidDestroyedBy(a.radius, power) &&
          this.predictKill(a.id, XP.ASTEROID_DESTROY, "asteroid", a.x, a.y, now);
        if (!predicted) {
          this.gainXp(XP.ASTEROID_CHIP, now);
        }
        this.netSendEvent("asteroid_hit", { asteroidId: a.id, damage: power });
        return;
      }
      case "ufo": {
        const u = this.world.ufo;
        if (!u) {
          return;
        }
        if (u.hp - dmgHp <= 0) {
          this.predictKill(u.id, XP.UFO_DESTROY, "ufo", u.x, u.y, now);
        }
        this.netSendEvent("ufo_hit", { damage: dmgHp / 100 });
        break;
      }
      case "player": {
        // The victim hit-tests the serialized chain and adjudicates its own
        // shield — nothing to send from the shooter side.
        break;
      }
      default: {
        ref satisfies never;
      }
    }
  }

  private updateBeams(dt: number, now: number): void {
    this.beams = this.beams.filter((b) => !b.vanished);
    for (const b of this.beams) {
      if (this.updateStationaryBeam(b, dt, now)) {
        continue;
      }
      // Range-limited plain beams (FLAK fragments, PLASMA): expire at diesAt.
      if (b.diesAt > 0 && now >= b.diesAt) {
        b.vanished = true;
        continue;
      }
      const gl = b.glaive;
      const { boomerang } = b.weapon;
      if (gl && boomerang) {
        this.updateGlaive(b, gl, boomerang, dt);
        continue;
      }
      this.updateFlyingBeam(b, dt, now);
    }
  }

  /** Beams that don't fly this frame: mines, ARC bolts, explosions and the
   *  SINGULARITY collapse. Returns true when the beam was handled. */
  private updateStationaryBeam(b: Beam, dt: number, now: number): boolean {
    // Mine: stationary until triggered; lifetime expiry detonates it.
    if (b.mine && !b.exploding) {
      if (now >= b.diesAt) {
        this.detonateMine(b);
      }
      return true;
    }
    // ARC bolt: static geometry, render-only lifetime.
    if (b.chain) {
      if (now >= b.diesAt) {
        b.vanished = true;
      }
      return true;
    }
    if (b.exploding) {
      const { explosion } = b.weapon;
      if (!explosion) {
        b.vanished = true;
        return true;
      }
      b.explosionRadius += explosion.growth * dt;
      if (b.explosionRadius >= explosion.range) {
        b.vanished = true;
      }
      return true;
    }
    // SINGULARITY: freeze through the collapse, pop at its end; the
    // flight leg collapses at diesAt instead of vanishing.
    if (b.weapon.singularity) {
      if (b.collapseUntil > 0) {
        if (now >= b.collapseUntil) {
          this.popSingularity(b);
        }
        return true;
      }
      if (b.diesAt > 0 && now >= b.diesAt) {
        this.startCollapse(b, now);
        return true;
      }
    }
    return false;
  }

  /** GLAIVE: out, decelerate, boomerang home, catch. */
  private updateGlaive(
    b: Beam,
    gl: NonNullable<Beam["glaive"]>,
    boomerang: NonNullable<Weapon["boomerang"]>,
    dt: number,
  ): void {
    b.spin += 12 * dt;
    let step: number;
    if (gl.returning) {
      const dx = this.shipX - b.head.x;
      const dy = this.shipY - b.head.y;
      const dist = Math.hypot(dx, dy);
      if (!this.alive || dist < SHIP_RADIUS + 6) {
        b.vanished = true;
        return;
      }
      b.angle = Math.atan2(dy, dx);
      step = boomerang.returnSpeed * dt;
    } else {
      const remaining = Math.max(0, boomerang.outRange - gl.traveled);
      const speed = Math.max(30, b.weapon.speed * Math.min(1, remaining / GLAIVE_DECEL_PX));
      step = speed * dt;
      gl.traveled += step;
      if (gl.traveled >= boomerang.outRange - 2) {
        gl.returning = true;
        // second pass re-arms against everything
        b.hitIds.clear();
      }
    }
    b.head.x += Math.cos(b.angle) * step;
    b.head.y += Math.sin(b.angle) * step;
    b.tail.x = b.head.x - Math.cos(b.angle) * b.weapon.length;
    b.tail.y = b.head.y - Math.sin(b.angle) * b.weapon.length;
    if (!inWorld(b.head.x, b.head.y, BEAM_CULL_MARGIN, this.world.playW, this.world.playH)) {
      b.vanished = true;
    }
  }

  /** Straight / homing / ricochet flight: advance the head, then the tail. */
  private updateFlyingBeam(b: Beam, dt: number, now: number): void {
    // HOMING: steer toward the live lock, capped turn rate.
    const { homing } = b.weapon;
    if (homing && b.target) {
      const pos = this.resolveTarget(b.target);
      if (pos) {
        const desired = Math.atan2(pos.y - b.head.y, pos.x - b.head.x);
        b.angle = rotateToward(b.angle, desired, homing.turnDegPerSec * DEG * dt);
      } else {
        // lock died → fly straight
        b.target = null;
      }
    }
    const step = b.weapon.speed * dt;
    const sx = Math.cos(b.angle) * step;
    const sy = Math.sin(b.angle) * step;
    b.head.x += sx;
    b.head.y += sy;
    b.traveled += step;
    // FLAK: airburst at burstDist traveled (first-hit burst in onBeamHit).
    if (b.weapon.flak && b.traveled >= b.weapon.flak.burstDist) {
      this.burstFlak(b, now);
      return;
    }
    // RICOCHET: bounce off the world edge while bounces remain.
    if (b.bouncesLeft > 0 && !inWorld(b.head.x, b.head.y, 0, this.world.playW, this.world.playH)) {
      this.ricochetEdgeBounce(b);
    }
    if (!inWorld(b.head.x, b.head.y, BEAM_CULL_MARGIN, this.world.playW, this.world.playH)) {
      b.vanished = true;
      return;
    }
    if (b.released) {
      if (homing) {
        // Curved path: keep the tail glued behind the head.
        b.tail.x = b.head.x - Math.cos(b.angle) * b.weapon.length;
        b.tail.y = b.head.y - Math.sin(b.angle) * b.weapon.length;
      } else {
        b.tail.x += sx;
        b.tail.y += sy;
      }
    } else if (Math.hypot(b.head.x - b.tail.x, b.head.y - b.tail.y) > b.weapon.length) {
      // The tail stays at the barrel until the beam reaches full length.
      b.released = true;
      b.tail.x = b.head.x - Math.cos(b.angle) * b.weapon.length;
      b.tail.y = b.head.y - Math.sin(b.angle) * b.weapon.length;
    }
  }

  /** Armed mines trigger on enemy / remote player / UFO proximity (§C). */
  private tickMines(now: number): void {
    for (const b of this.beams) {
      if (!b.mine || b.exploding || b.vanished || now < b.mine.armAt) {
        continue;
      }
      if (this.mineTriggered(b.head.x, b.head.y)) {
        this.detonateMine(b);
      }
    }
  }

  /** Anything hostile inside the trigger radius: enemies, the UFO, or a
   *  targetable remote player (alive, not invulnerable, not phased). */
  private mineTriggered(x: number, y: number): boolean {
    const r2 = MINE_TRIGGER_RADIUS * MINE_TRIGGER_RADIUS;
    for (const e of this.world.enemies) {
      if (dist2(e.x, e.y, x, y) <= r2) {
        return true;
      }
    }
    const u = this.world.ufo;
    if (u && dist2(u.x, u.y, x, y) <= r2) {
      return true;
    }
    const { myId } = this;
    for (const [id, st] of this.peerStates) {
      if (id === myId) {
        continue;
      }
      if (!st || !st.alive || st.invuln || st.shieldMod?.phased) {
        continue;
      }
      if (dist2(st.x, st.y, x, y) <= r2) {
        return true;
      }
    }
    return false;
  }

  /** Standard explosion through the existing exploding/explosionRadius path. */
  private detonateMine(b: Beam): void {
    this.fx.battle.burst(b.head.x, b.head.y, 70, b.weapon.tint, "detonation");
    b.exploding = true;
    b.explosionRadius = 0;
    if (this.onScreen(b.head.x, b.head.y)) {
      sfx.play("fire_heavy", { gain: 0.8, rate: 0.85 });
      this.trauma.add(0.06);
    }
  }

  /** Beam reaction to a hit: explode, airburst, pass through, or vanish. */
  private onBeamHit(b: Beam, now: number): void {
    // expanding AoE keeps going; updateBeams expires it at range
    if (b.exploding) {
      return;
    }
    if (b.weapon.flak) {
      // first hit pops the shell early
      this.burstFlak(b, now);
      return;
    }
    if (b.weapon.explosion) {
      this.fx.battle.burst(
        b.head.x,
        b.head.y,
        b.weapon.explosion.range * 0.75,
        b.weapon.tint,
        "detonation",
      );
      b.exploding = true;
      b.explosionRadius = 0;
      return;
    }
    if (!b.weapon.through) {
      b.vanished = true;
    }
  }

  /** FLAK airburst: the shell vanishes into `fragments` radial beams, each
   *  an ordinary beam with its own hit dedup, range-limited via diesAt.
   *  Fragments inherit the shell's hitIds so a direct-hit victim eats the
   *  shell once, not shell + 8 point-blank fragments. */
  private burstFlak(b: Beam, now: number): void {
    const spec = b.weapon.flak;
    if (!spec || b.vanished) {
      return;
    }
    b.vanished = true;
    const ttlMs = (spec.fragRange / FLAK_FRAG_WEAPON.speed) * 1000;
    for (let i = 0; i < spec.fragments; i += 1) {
      const ang = (Math.PI * 2 * i) / spec.fragments;
      const fb = this.makeBeam({ x: b.head.x, y: b.head.y }, ang, FLAK_FRAG_WEAPON, now);
      fb.released = true;
      fb.diesAt = now + ttlMs;
      fb.hitIds = new Set(b.hitIds);
      this.beams.push(fb);
    }
    this.fx.battle.burst(
      b.head.x,
      b.head.y,
      spec.fragments > 8 ? 95 : 65,
      b.weapon.tint,
      "detonation",
    );
    this.fx.ring(b.head.x, b.head.y, 4, 36, 200, b.weapon.tint, 0.7);
    if (this.onScreen(b.head.x, b.head.y)) {
      sfx.play("fire_scatter", { gain: 0.7, rate: 0.9 });
      this.trauma.add(0.04);
    }
  }

  /** SINGULARITY collapse start (flight range reached or first contact):
   *  freeze the orb, emit ONE shared pull event — the HOST applies the drag
   *  to its simulated enemies/asteroids so all clients see the same motion
   *  (offline: the event loops straight back into the local host). */
  private startCollapse(b: Beam, now: number): void {
    if (b.collapseUntil > 0 || b.exploding || b.vanished) {
      return;
    }
    // GRAVITON WELL herds far longer than SINGULARITY; the pull duration rides
    // the shared `until` so guests/host agree without a wire shape change.
    const pullMs = b.weapon.name === "GRAVITON WELL" ? GRAVITON_PULL_MS : SINGULARITY_PULL_MS;
    b.collapseUntil = now + pullMs;
    b.diesAt = 0;
    b.tail = { ...b.head };
    this.netSendEvent("singularity", { until: b.collapseUntil, x: b.head.x, y: b.head.y });
    if (this.onScreen(b.head.x, b.head.y)) {
      sfx.play("fire_laser", { gain: 0.6, rate: 0.5 });
    }
  }

  /** SINGULARITY pop: the standard exploding-beam path. hitIds is cleared so
   *  a flight-contact target isn't deduped out of its own pop. */
  private popSingularity(b: Beam): void {
    b.collapseUntil = 0;
    b.exploding = true;
    b.explosionRadius = 0;
    b.hitIds.clear();
    this.fx.battle.burst(b.head.x, b.head.y, 125, b.weapon.tint, "detonation");
    this.fx.ring(b.head.x, b.head.y, 6, 90, 250, b.weapon.tint, 0.8);
    if (this.onScreen(b.head.x, b.head.y)) {
      // The boom, dropped well below the EXPLOSION family's pitch.
      sfx.play("fire_heavy", { gain: 1.2, rate: 0.55 });
      this.trauma.add(0.12);
    }
  }

  /** RICOCHET world-edge bounce: clamp inside, reflect off the edge normal. */
  private ricochetEdgeBounce(b: Beam): void {
    let nx = 0;
    let ny = 0;
    if (b.head.x < 0) {
      nx = 1;
    } else if (b.head.x > this.world.playW) {
      nx = -1;
    }
    if (b.head.y < 0) {
      ny = 1;
    } else if (b.head.y > this.world.playH) {
      ny = -1;
    }
    b.head.x = PhaserMath.Clamp(b.head.x, 0, this.world.playW);
    b.head.y = PhaserMath.Clamp(b.head.y, 0, this.world.playH);
    const len = Math.hypot(nx, ny) || 1;
    this.ricochetBounce(b, nx / len, ny / len);
  }

  /** RICOCHET bounce: reflect off the surface normal, then re-aim at the
   *  nearest un-hit enemy/asteroid in range (the re-aim IS the weapon; the
   *  reflection is the fallback). The tail re-grows from the kink so the
   *  segment visibly bends; remotes see it via per-snapshot beams. */
  private ricochetBounce(b: Beam, nx: number, ny: number): void {
    b.bouncesLeft -= 1;
    const dx = Math.cos(b.angle);
    const dy = Math.sin(b.angle);
    const dot = dx * nx + dy * ny;
    b.angle = Math.atan2(dy - 2 * dot * ny, dx - 2 * dot * nx);
    this.retargetRicochet(b);
    b.tail = { ...b.head };
    b.released = false;
    this.fx.battle.burst(b.head.x, b.head.y, 20, b.weapon.tint, "impact", b.angle);
    this.fx.sparks(b.head.x, b.head.y, 3, b.weapon.tint, {
      lifeMax: 180,
      lifeMin: 100,
      scale: 0.4,
    });
  }

  /** Aim at the nearest enemy (preferred) or asteroid within retargetRange
   *  that this beam hasn't already damaged. */
  private retargetRicochet(b: Beam): void {
    const range = b.weapon.ricochet?.retargetRange ?? 0;
    if (range <= 0) {
      return;
    }
    const r2 = range * range;
    let best: Vec | null = null;
    let bestD = Infinity;
    for (const e of this.world.enemies) {
      if (b.hitIds.has(e.id)) {
        continue;
      }
      const d = dist2(e.x, e.y, b.head.x, b.head.y);
      if (d <= r2 && d < bestD) {
        bestD = d;
        best = { x: e.x, y: e.y };
      }
    }
    if (!best) {
      for (const a of this.world.asteroids) {
        if (b.hitIds.has(a.id)) {
          continue;
        }
        const d = dist2(a.x, a.y, b.head.x, b.head.y);
        if (d <= r2 && d < bestD) {
          bestD = d;
          best = { x: a.x, y: a.y };
        }
      }
    }
    if (best) {
      b.angle = Math.atan2(best.y - b.head.y, best.x - b.head.x);
    }
  }

  // ---- hits, kills + combo ------------------------------------------------------

  /** A kill: bump the streak, award table value × multiplier, milestone FX.
   *  SIPHON hooks here, so predicted kills heal — consistent with the
   *  self-award scoring grammar. */
  private registerKill(
    base: number,
    now: number,
    kind: "enemy" | "asteroid" | "ufo" | "player",
    x = this.shipX,
    y = this.shipY,
  ): void {
    if (this.shieldMod === "siphon" && this.alive) {
      const heal = SIPHON_HEAL[kind];
      this.shieldHp = Math.min(SIPHON_OVERHEAL_MAX, this.shieldHp + heal);
      this.siphonPulseUntil = now + 250;
      const d = Math.hypot(x - this.shipX, y - this.shipY);
      this.fx.converge(
        this.shipX,
        this.shipY,
        4,
        Math.max(24, Math.min(300, d)),
        250,
        SHIELD_MOD_SPECS.siphon.tint,
      );
    }
    // LEECH FIELD: enemy kills within range heal you (own kills only — simple,
    // no overheal bank, capped at base shield).
    if (
      this.shieldMod === "leech" &&
      this.alive &&
      kind === "enemy" &&
      dist2(x, y, this.shipX, this.shipY) <= LEECH_FIELD_RANGE * LEECH_FIELD_RANGE
    ) {
      this.shieldHp = Math.min(SHIELD_MAX, this.shieldHp + LEECH_FIELD_HEAL);
      this.fx.sparks(this.shipX, this.shipY, 3, SHIELD_MOD_SPECS.leech.tint, {
        lifeMax: 200,
        lifeMin: 120,
      });
    }
    this.streak += 1;
    this.comboExpiresAt = now + COMBO_WINDOW_MS;
    const mult = comboMult(this.streak);
    this.gainXp(base * mult, now);
    if (mult > this.comboTier && mult >= 2) {
      // Tier-up: the one allowed long effect (§9) + rising sfx + pill pop.
      sfx.play("combo_up", { priority: "local", rate: 2 ** ((2 * (mult - 2)) / 12) });
      this.trauma.add(0.1);
      this.fx.ring(this.shipX, this.shipY, 6, 75, 350, 0xff_ff_ff, 0.8);
      this.fx.converge(this.shipX, this.shipY, 12, 40, 300, 0xff_ff_ff);
      this.time.delayedCall(300, () => {
        if (this.alive) {
          this.fx.sparks(this.shipX, this.shipY, 12, 0xff_ff_ff, {
            lifeMax: 350,
            lifeMin: 200,
            speedMax: 250,
            speedMin: 100,
          });
        }
      });
      if (this.comboEl) {
        this.comboEl.classList.remove("pop");
        // restart the CSS animation
        void this.comboEl.offsetWidth;
        this.comboEl.classList.add("pop");
      }
    }
    this.comboTier = mult;
  }

  /** The single XP sink: add XP, roll up levels, fire the level-up feedback.
   *  Kills route here combo-multiplied (via registerKill); orbs + asteroid
   *  chips call this directly (flat). */
  private gainXp(amount: number, now: number): void {
    if (amount <= 0 || !this.alive) {
      return;
    }
    this.runXp += amount;
    // dir-006: sector pts ride the same sink BEFORE the level-cap discard —
    // at cap the XP stream still lands on the sector scoreboard.
    this.sectorScore += amount;
    this.xp += amount;
    let leveled = false;
    while (this.level < LEVEL_CAP && this.xp >= xpToNext(this.level)) {
      this.xp -= xpToNext(this.level);
      this.level += 1;
      leveled = true;
    }
    // at cap the bar empties — no hoard
    if (this.level >= LEVEL_CAP) {
      this.xp = 0;
    }
    if (leveled) {
      this.onLevelUp(now);
    }
  }

  /** Apply the new base loadout + the one allowed long FX (ring + converge +
   *  sparks, reusing the combo-tier vocabulary) + a pitched cue + HUD pop. */
  private onLevelUp(now: number): void {
    this.applyBaseLoadout(now);
    sfx.play("combo_up", { priority: "local", rate: 1.5 });
    this.trauma.add(0.12);
    const tint = this.myTint();
    this.fx.hullUpgrade(
      this.shipX,
      this.shipY,
      shipHullPoints(this.level),
      this.shipAngle,
      this.level,
    );
    this.fx.ring(this.shipX, this.shipY, 8, 110, 450, tint, 0.75, "important");
    this.fx.converge(this.shipX, this.shipY, 16, 60, 320, 0xff_ff_ff, "important");
    this.fx.sparks(this.shipX, this.shipY, 16, tint, {
      importance: "important",
      lifeMax: 450,
      lifeMin: 250,
      speedMax: 280,
      speedMin: 120,
    });
  }

  /** Apply the level's regen + weapon. A held special is re-scaled for the new
   *  level (from its unscaled base, so it never compounds); otherwise the level
   *  base weapon. Called on level-up, respawn, and special expiry. */
  private applyBaseLoadout(now: number): void {
    this.regenMult = baseRegenMult(this.level);
    if (this.weaponUntil > now && this.specialBase) {
      this.weapon = scaleWeaponForLevel(this.specialBase, this.level);
    } else {
      this.specialBase = null;
      this.weapon = baseWeaponForLevel(this.level);
    }
  }

  /** Death tax: lose XP_DEATH_PENALTY_FRAC of progress into the current level;
   *  de-level at most XP_DEATH_MAX_DELEVELS, never below the level floor. The
   *  leader pays the most absolute XP (anti-snowball); a fresh player barely
   *  notices (cheap early levels). */
  private applyDeathXpPenalty(): void {
    this.xp -= Math.round(xpToNext(this.level) * XP_DEATH_PENALTY_FRAC);
    let delevels = 0;
    while (this.xp < 0 && this.level > 1 && delevels < XP_DEATH_MAX_DELEVELS) {
      this.level -= 1;
      this.xp += xpToNext(this.level);
      delevels += 1;
    }
    if (this.xp < 0) {
      this.xp = 0;
    }
  }

  /** Self-award a predicted destroy bonus once per target (the host's echo
   *  later prunes the entry). Returns false when already predicted. */
  private predictKill(
    id: string,
    xp: number,
    kind: "enemy" | "asteroid" | "ufo",
    x: number,
    y: number,
    now: number,
  ): boolean {
    if (this.predictedKills.has(id)) {
      return false;
    }
    this.predictedKills.set(id, now);
    this.registerKill(xp, now, kind, x, y);
    return true;
  }

  /**
   * Shooter-side hit detection: I detect my own beams hitting host-owned
   * targets and report damage events; the host applies them. Score is awarded
   * locally, with the destroy bonus predicted from the same damage formula
   * the host runs.
   */
  private detectMyHits(now: number): void {
    if (!this.spawned) {
      return;
    }
    // Crowd-scale FX budget: skip non-kill hit-spark spawns over the cap
    // (the victim's white flash stays — it's the readability signal).
    const sparksOk = this.fx.aliveParticles() <= HITSPARK_SKIP_BUDGET;
    for (const b of this.beams) {
      // ARC damage applied at cast
      if (b.vanished || b.chain) {
        continue;
      }
      // inert until triggered
      if (b.mine && !b.exploding) {
        continue;
      }
      this.hitAsteroids(b, sparksOk, now);
      if (b.vanished) {
        continue;
      }
      this.hitEnemies(b, sparksOk, now);
      if (b.vanished) {
        continue;
      }
      this.hitUfo(b, sparksOk, now);
    }
    for (const [id, t] of this.predictedKills) {
      if (now - t > 5000) {
        this.predictedKills.delete(id);
      }
    }
  }

  /** Impact burst + sparks at the contact point, in the beam's tint. */
  private hitSparks(b: Beam, contact: Vec, impactAngle: number): void {
    this.fx.battle.burst(
      contact.x,
      contact.y,
      Math.min(32, 12 + b.weapon.power * 12),
      b.weapon.tint,
      "impact",
      impactAngle,
    );
    this.fx.sparks(contact.x, contact.y, 9, b.weapon.tint, {
      angleMax: impactAngle / DEG + 65,
      angleMin: impactAngle / DEG - 65,
      lifeMax: 300,
      lifeMin: 150,
    });
  }

  private hitAsteroids(b: Beam, sparksOk: boolean, now: number): void {
    // PHASE LANCE: no asteroid hit-test at all — rocks aren't cover.
    const rocks = b.weapon.phasesRock ? NO_ASTEROIDS : this.world.asteroids;
    for (const a of rocks) {
      if (!beamHitsCircle(b, a.x, a.y, a.radius)) {
        continue;
      }
      if (b.weapon.singularity && !b.exploding) {
        // Flight contact collapses the orb; damage comes from the pop.
        this.startCollapse(b, now);
        break;
      }
      if (b.hitIds.has(a.id)) {
        continue;
      }
      b.hitIds.add(a.id);
      const contact = contactPoint(b.tail, b.head, a, a.radius, b.exploding);
      const impactAngle = b.angle;
      if (b.weapon.ricochet && b.bouncesLeft > 0 && !b.exploding) {
        // RICOCHET: damage lands below, but the bolt bounces instead of dying.
        const nx = b.head.x - a.x;
        const ny = b.head.y - a.y;
        const nl = Math.hypot(nx, ny) || 1;
        this.ricochetBounce(b, nx / nl, ny / nl);
      } else {
        this.onBeamHit(b, now);
      }
      const destroyed = asteroidDestroyedBy(a.radius, b.weapon.power);
      const predicted =
        destroyed && this.predictKill(a.id, XP.ASTEROID_DESTROY, "asteroid", a.x, a.y, now);
      // flat, never multiplied
      if (!predicted) {
        this.gainXp(XP.ASTEROID_CHIP, now);
      }
      if (sparksOk || destroyed) {
        this.hitSparks(b, contact, impactAngle);
      }
      sfx.play("hit_spark", { gain: 0.4 });
      this.netSendEvent("asteroid_hit", { asteroidId: a.id, damage: b.weapon.power });
      // AoE circle keeps testing every target
      if (!b.exploding) {
        break;
      }
    }
  }

  private hitEnemies(b: Beam, sparksOk: boolean, now: number): void {
    for (const e of this.world.enemies) {
      const r = e.chargeUntil > now ? LANCER_CHARGE_HIT_RADIUS : ENEMY_SPECS[e.kind].hitRadius;
      if (!beamHitsCircle(b, e.x, e.y, r)) {
        continue;
      }
      if (b.weapon.singularity && !b.exploding) {
        this.startCollapse(b, now);
        break;
      }
      if (b.hitIds.has(e.id)) {
        continue;
      }
      b.hitIds.add(e.id);
      this.recordMasteryContact(b, e.id, now);
      const contact = contactPoint(b.tail, b.head, e, r, b.exploding);
      const impactAngle = b.angle;
      this.onBeamHit(b, now);
      const dmg = b.weapon.power * 100;
      const killed = e.hp - dmg <= 0;
      if (killed) {
        this.predictKill(e.id, this.enemyKillXp(e.kind), "enemy", e.x, e.y, now);
      }
      // immediate local feedback; host echoes
      e.blinkUntil = now + 150;
      if (sparksOk || killed) {
        this.hitSparks(b, contact, impactAngle);
      }
      sfx.play("hit_spark", { gain: 0.4 });
      this.netSendEvent("enemy_hit", { damage: dmg, enemyId: e.id });
      // AoE circle keeps testing every target
      if (!b.exploding) {
        break;
      }
    }
  }

  private hitUfo(b: Beam, sparksOk: boolean, now: number): void {
    const u = this.world.ufo;
    if (!u) {
      return;
    }
    const hit = beamHitsCircle(b, u.x, u.y, UFO_RADIUS);
    if (hit && b.weapon.singularity && !b.exploding) {
      this.startCollapse(b, now);
      return;
    }
    if (!hit || b.hitIds.has(u.id)) {
      return;
    }
    b.hitIds.add(u.id);
    const contact = contactPoint(b.tail, b.head, u, UFO_RADIUS, b.exploding);
    const impactAngle = b.angle;
    this.onBeamHit(b, now);
    const killed = u.hp - b.weapon.power * 100 <= 0;
    if (killed) {
      this.predictKill(u.id, XP.UFO_DESTROY, "ufo", u.x, u.y, now);
    }
    if (sparksOk || killed) {
      this.hitSparks(b, contact, impactAngle);
    }
    sfx.play("hit_spark", { gain: 0.4 });
    this.netSendEvent("ufo_hit", { damage: b.weapon.power });
  }

  // ---- shields + death (victim-side adjudication, v2 §A/§B) -------------------------

  private ramArmed(): boolean {
    return this.shieldMod === "ram" && Math.hypot(this.shipVX, this.shipVY) > RAM_ARM_SPEED;
  }

  /** REFLECT bounces only while the base shield is above the gate. */
  private reflectArmed(): boolean {
    return this.shieldMod === "reflect" && this.shieldHp > REFLECT_MIN_SHIELD;
  }

  /** Reflect my velocity off the obstacle at (cx,cy), scaled, plus a nudge out. */
  private bounceOff(cx: number, cy: number, scale: number): void {
    let nx = this.shipX - cx;
    let ny = this.shipY - cy;
    const len = Math.hypot(nx, ny) || 1;
    nx /= len;
    ny /= len;
    const dot = this.shipVX * nx + this.shipVY * ny;
    if (dot < 0) {
      this.shipVX = (this.shipVX - 2 * dot * nx) * scale;
      this.shipVY = (this.shipVY - 2 * dot * ny) * scale;
    } else {
      this.shipVX *= scale;
      this.shipVY *= scale;
    }
    this.shipX += nx * 2;
    this.shipY += ny * 2;
  }

  /** Ring flash + 60° impact arc + sparks + retuned trauma + pitched ping. */
  private shieldHitFx(now: number, impactX: number, impactY: number, amount: number): void {
    this.haloFlashUntil = now + 80;
    const ang = Math.atan2(impactY - this.shipY, impactX - this.shipX);
    this.impactArcs.push({ angle: ang, diesAt: now + 150 });
    this.fx.battle.burst(
      this.shipX + Math.cos(ang) * SHIELD_RING_RADIUS,
      this.shipY + Math.sin(ang) * SHIELD_RING_RADIUS,
      27,
      SHIELD_RING_TINT,
      "impact",
      ang,
      "important",
    );
    this.fx.sparks(impactX, impactY, 8, SHIELD_RING_TINT, {
      angleMax: ang / DEG + 22.5,
      angleMin: ang / DEG - 22.5,
      importance: "important",
      lifeMax: 250,
      lifeMin: 150,
      // Hull-local, and the reel's crowd shots take one of these every few
      // frames — the single biggest contributor to the white splat.
      scale: 0.6 * this.hullGlow(),
    });
    // Hits sound lower as you get closer to death (§A.5).
    const fraction = Math.max(0, Math.min(1, this.shieldHp / SHIELD_MAX));
    sfx.play("shield_hit", { rate: 0.85 + 0.3 * fraction });
    this.trauma.add(amount >= 40 ? 0.25 : 0.12);
  }

  /** Halo break flash (PHASE blinks; death layers shield_break in die()). */
  private shieldBreakFx(now: number): void {
    this.haloFlashUntil = now + 80;
    this.fx.ring(
      this.shipX,
      this.shipY,
      SHIELD_RING_RADIUS,
      40,
      300,
      SHIELD_RING_TINT,
      0.7,
      "important",
    );
    this.trauma.add(0.3);
  }

  /**
   * The one drain pipeline (§A): every damage source lands here. Runs the
   * PHASE auto-blink, drains the OVERSHIELD bonus first, stamps the regen
   * clock, drives ring FX + low-shield trauma, and dies at ≤0 — the killing
   * blow's cause is what the overlay names.
   */
  private applyDamage(
    amount: number,
    fromX: number,
    fromY: number,
    cause: string,
    killerId: string | null,
    now: number,
  ): "phased" | "dead" | "drained" {
    if (!this.alive) {
      return "dead";
    }
    // PHASE auto-blink: negate haymakers (≥40) and killing blows entirely.
    if (
      this.shieldMod === "phase" &&
      now >= this.phaseReadyAt &&
      (amount >= PHASE_TRIGGER_HIT || amount >= this.shieldHp + this.overHp)
    ) {
      this.phasedUntil = now + PHASE_DURATION_MS;
      this.phaseReadyAt = now + PHASE_COOLDOWN_MS;
      // Blink cost — phasing itself can never kill you.
      this.shieldHp -= Math.min(PHASE_COST, Math.max(0, this.shieldHp - 1));
      this.lastDamageAt = now;
      this.regenActive = false;
      this.shieldBreakFx(now);
      sfx.play("shield_break", { gain: 0.6, rate: 1.25 });
      return "phased";
    }
    // BULWARK: hits landing inside the frontal cone are mitigated; the rear is
    // exposed. fromX/fromY is the hit source, so no extra wire data is needed.
    let mitigated = amount;
    if (this.shieldMod === "bulwark" && now < this.shieldModUntil) {
      let rel = Math.atan2(fromY - this.shipY, fromX - this.shipX) - this.shipAngle;
      // wrap to [-π, π]
      rel = Math.atan2(Math.sin(rel), Math.cos(rel));
      if (Math.abs(rel) <= ((BULWARK_CONE_DEG / 2) * Math.PI) / 180) {
        mitigated *= BULWARK_FRONT_MULT;
      }
    }
    const wasLow = this.shieldHp < SHIELD_MAX * SHIELD_LOW_FRACTION;
    let rest = mitigated;
    if (this.overHp > 0) {
      const fromOver = Math.min(this.overHp, rest);
      this.overHp -= fromOver;
      rest -= fromOver;
    }
    this.shieldHp -= rest;
    this.lastDamageAt = now;
    this.regenActive = false;
    // Trailer: the hit is real — drain, arcs, flash, sfx — but a staged scene
    // with no death beat cannot lose its pilot. Enemy shots skip contact
    // i-frames and several resolve inside one sim step, so a between-frames
    // top-up always races them; the guarantee has to live at the kill itself.
    if (this.shieldHp <= 0 && this.trailer?.deathless === true) {
      this.shieldHp = 1;
    }
    if (this.shieldHp <= 0) {
      this.die(now, killerId, cause);
      return "dead";
    }
    this.shieldHitFx(now, fromX, fromY, amount);
    if (!wasLow && this.shieldHp < SHIELD_MAX * SHIELD_LOW_FRACTION) {
      this.trauma.add(0.15);
    }
    return "drained";
  }

  /** Base regen (Halo grammar) + overheal decay + mod/booster expiry. */
  private tickShield(now: number, dt: number): void {
    if (this.shieldMod && now >= this.shieldModUntil) {
      this.shieldMod = null;
      // remaining OVERSHIELD bonus vanishes with the mod
      this.overHp = 0;
    }
    for (const [kind, until] of this.boosts) {
      if (now >= until) {
        this.boosts.delete(kind);
      }
    }
    if (!this.alive) {
      return;
    }
    // SIPHON overheal above 100 bleeds off and never regens.
    if (this.shieldHp > SHIELD_MAX) {
      this.shieldHp = Math.max(SHIELD_MAX, this.shieldHp - SIPHON_OVERHEAL_DECAY_PER_S * dt);
    }
    const delay = this.shieldMod === "aegis" ? AEGIS_REGEN_DELAY_MS : SHIELD_REGEN_DELAY_MS;
    if (this.shieldHp < SHIELD_MAX && now - this.lastDamageAt >= delay) {
      if (!this.regenActive) {
        this.regenActive = true;
        // once, when regen starts after a drain
        sfx.play("shield_regen");
      }
      const rate =
        (SHIELD_MAX / (SHIELD_REGEN_FULL_MS / 1000)) *
        // levelling: faster recovery, not more max HP
        this.regenMult *
        (this.shieldMod === "aegis" ? AEGIS_REGEN_MULT : 1);
      this.shieldHp = Math.min(SHIELD_MAX, this.shieldHp + rate * dt);
      if (this.shieldHp >= SHIELD_MAX) {
        this.regenActive = false;
      }
    } else if (this.shieldHp >= SHIELD_MAX) {
      this.regenActive = false;
    }
    // Low-shield warning tone: while low and not regenerating, 1.2s gate.
    if (
      this.shieldHp > 0 &&
      this.shieldHp < SHIELD_MAX * SHIELD_LOW_FRACTION &&
      !this.regenActive &&
      now - this.lastShieldLowAt >= 1200
    ) {
      this.lastShieldLowAt = now;
      sfx.play("shield_low");
    }
  }

  /** Locally remove an enemy shot + tell the host (it owns the array). */
  private consumeShot(shot: EnemyShotState): void {
    const idx = this.world.enemyShots.findIndex((s) => s.id === shot.id);
    if (idx !== -1) {
      this.world.enemyShots.splice(idx, 1);
    }
    this.recentConsumedShots.set(shot.id, simNow());
    if (this.amHost) {
      this.dirty.enemyShots = true;
    }
    this.netSendEvent("proj_consumed", { shotId: shot.id });
  }

  /** REFLECT return shot: NORMAL-stat beam along the reversed incoming vector. */
  private fireReflectBeam(angle: number, now: number): void {
    const weapon: Weapon = { ...WEAPON_DEFAULT, tint: SHIELD_MOD_SPECS.reflect.tint };
    this.beams.push(this.makeBeam({ x: this.shipX, y: this.shipY }, angle, weapon, now));
  }

  /**
   * Victim-side drain detection (§A.2/§B.2): asteroids and hulls drain on
   * contact with the ship CENTER (generous); shots/beams drain within the
   * ship radius. Every source computes a drain and runs the one applyDamage
   * pipeline; the victim reports its own killer and adjudicates its own mods.
   */
  private detectIncomingDamage(now: number, dt: number): void {
    if (!this.alive || !this.spawned) {
      return;
    }
    // intangible: no collisions either way
    if (now < this.phasedUntil) {
      return;
    }
    // respawn invuln: zero shield interaction
    if (now < this.invulnUntil) {
      return;
    }
    // Each source returns false once a drain ended the frame (death / phase
    // blink); the alive re-check covers drains that killed without saying so.
    if (!this.asteroidContactDamage(now) || !this.alive) {
      return;
    }
    if (!this.enemyContactDamage(now) || !this.alive) {
      return;
    }
    if (!this.enemyShotDamage(now, dt) || !this.alive) {
      return;
    }
    if (!this.ufoContactDamage(now) || !this.alive) {
      return;
    }
    this.playerDamage(now);
  }

  /** Asteroid contact: one drain per CONTACT_IFRAME window. */
  private asteroidContactDamage(now: number): boolean {
    for (const a of this.world.asteroids) {
      if (dist2(a.x, a.y, this.shipX, this.shipY) > a.radius * a.radius) {
        continue;
      }
      if (this.ramArmed()) {
        // RAM stops matter: small rocks die free, big rocks chip + 10 drain.
        const imm = this.ramImmunity.get(a.id);
        if (imm !== undefined && now < imm) {
          continue;
        }
        this.ramImmunity.set(a.id, now + RAM_IMMUNITY_MS);
        if (a.radius <= RAM_ASTEROID_DESTROY_R) {
          this.predictKill(a.id, XP.ASTEROID_DESTROY, "asteroid", a.x, a.y, now);
          this.netSendEvent("asteroid_hit", { asteroidId: a.id, damage: 1 });
          this.fx.sparks(a.x, a.y, 8, SHIELD_MOD_SPECS.ram.tint, { lifeMax: 250, lifeMin: 150 });
          sfx.play("hit_spark");
          this.trauma.add(0.1);
          continue;
        }
        this.gainXp(XP.ASTEROID_CHIP, now);
        this.netSendEvent("asteroid_hit", { asteroidId: a.id, damage: RAM_ASTEROID_CHIP });
        this.bounceOff(a.x, a.y, 0.6);
        if (this.applyDamage(RAM_SELF_DRAIN, a.x, a.y, "ASTEROID", null, now) !== "drained") {
          return false;
        }
        continue;
      }
      if (now < this.contactIframeUntil) {
        continue;
      }
      const res = this.applyDamage(
        asteroidContactDamage(a.radius),
        a.x,
        a.y,
        "ASTEROID",
        null,
        now,
      );
      if (res !== "drained") {
        return false;
      }
      this.bounceOff(a.x, a.y, 0.5);
      this.contactIframeUntil = now + CONTACT_IFRAME_MS;
      break;
    }
    return true;
  }

  /** Enemy hull contact + LANCER charge. */
  private enemyContactDamage(now: number): boolean {
    for (const e of this.world.enemies) {
      // flashing in: harmless
      if (e.graceUntil > now) {
        continue;
      }
      const charging = e.kind === "lancer" && e.chargeUntil > now;
      const r = charging ? LANCER_CHARGE_HIT_RADIUS : ENEMY_SPECS[e.kind].hitRadius;
      if (dist2(e.x, e.y, this.shipX, this.shipY) > r * r) {
        continue;
      }
      let nx = e.x - this.shipX;
      let ny = e.y - this.shipY;
      const nlen = Math.hypot(nx, ny) || 1;
      nx /= nlen;
      ny /= nlen;
      if (this.ramArmed()) {
        // The shield becomes a weapon: enemy takes 60, I pay 10 (25 vs a
        // mid-charge lancer, with the bounce + trauma).
        const imm = this.ramImmunity.get(e.id);
        if (imm !== undefined && now < imm) {
          continue;
        }
        this.ramImmunity.set(e.id, now + RAM_IMMUNITY_MS);
        if (e.hp - RAM_DAMAGE <= 0) {
          this.predictKill(e.id, this.enemyKillXp(e.kind), "enemy", e.x, e.y, now);
        }
        this.netSendEvent("enemy_hit", {
          damage: RAM_DAMAGE,
          enemyId: e.id,
          kx: nx * RAM_KNOCKBACK,
          ky: ny * RAM_KNOCKBACK,
        });
        e.blinkUntil = now + 150;
        if (charging) {
          this.bounceOff(e.x, e.y, 0.6);
          this.trauma.add(0.3);
        }
        const drain = charging ? RAM_LANCER_DRAIN : RAM_SELF_DRAIN;
        if (this.applyDamage(drain, e.x, e.y, ENEMY_SPECS[e.kind].name, null, now) !== "drained") {
          return false;
        }
        continue;
      }
      if (now < this.contactIframeUntil) {
        continue;
      }
      const amount = charging ? DMG.LANCER_CHARGE : hullContactDamage(e.kind);
      const res = this.applyDamage(amount, e.x, e.y, ENEMY_SPECS[e.kind].name, null, now);
      if (res !== "drained") {
        return false;
      }
      this.bounceOff(e.x, e.y, 0.5);
      // knock both back (kept from v1)
      this.netSendEvent("enemy_hit", {
        damage: 0,
        enemyId: e.id,
        kx: nx * RAM_KNOCKBACK * 0.5,
        ky: ny * RAM_KNOCKBACK * 0.5,
      });
      this.contactIframeUntil = now + CONTACT_IFRAME_MS;
      break;
    }
    return true;
  }

  /** Enemy projectiles (host-owned; I detect my own hit, mirror of PvP
   *  beams). Shots ignore contact i-frames and are always consumed. */
  private enemyShotDamage(now: number, dt: number): boolean {
    // Reverse index loop: consumeShot splices mid-iteration.
    for (let i = this.world.enemyShots.length - 1; i >= 0; i -= 1) {
      const s = this.world.enemyShots[i];
      // consumed; host echo pending
      if (!s || this.recentConsumedShots.has(s.id)) {
        continue;
      }
      const hit = segHitsCircle(
        s.x - s.vx * dt,
        s.y - s.vy * dt,
        s.x,
        s.y,
        this.shipX,
        this.shipY,
        SHIP_RADIUS,
      );
      if (!hit) {
        continue;
      }
      // Shots aren't source-attributed on the wire; speed identifies the kind
      // (drone/warden/boss-plasma → DRONE, wasp → WASP, sniper/boss-lance → SNIPER).
      const { cause, dmg } = enemyShotHit(Math.hypot(s.vx, s.vy));
      // every shot that hits is consumed — same event
      this.consumeShot(s);
      if (this.reflectArmed()) {
        // Bounce: pay 12 shield instead of the damage, return the bolt.
        this.fireReflectBeam(Math.atan2(-s.vy, -s.vx), now);
        if (this.applyDamage(REFLECT_BOUNCE_COST, s.x, s.y, cause, null, now) !== "drained") {
          return false;
        }
        continue;
      }
      const res = this.applyDamage(dmg, s.x, s.y, cause, null, now);
      if (res !== "drained") {
        return false;
      }
    }
    return true;
  }

  /** UFO contact (treated as a hull). */
  private ufoContactDamage(now: number): boolean {
    const u = this.world.ufo;
    if (!u || dist2(u.x, u.y, this.shipX, this.shipY) > UFO_RADIUS * UFO_RADIUS) {
      return true;
    }
    if (this.ramArmed()) {
      const imm = this.ramImmunity.get(u.id);
      if (imm === undefined || now >= imm) {
        this.ramImmunity.set(u.id, now + RAM_IMMUNITY_MS);
        if (u.hp - RAM_DAMAGE <= 0) {
          this.predictKill(u.id, XP.UFO_DESTROY, "ufo", u.x, u.y, now);
        }
        this.netSendEvent("ufo_hit", { damage: RAM_DAMAGE / 100 });
        if (this.applyDamage(RAM_SELF_DRAIN, u.x, u.y, "UFO", null, now) !== "drained") {
          return false;
        }
      }
    } else if (now >= this.contactIframeUntil) {
      const res = this.applyDamage(DMG.UFO_HULL, u.x, u.y, "UFO", null, now);
      if (res !== "drained") {
        return false;
      }
      this.bounceOff(u.x, u.y, 0.5);
      this.contactIframeUntil = now + CONTACT_IFRAME_MS;
    }
    return true;
  }

  /** Other players: armed-RAM hull contact + the beam volley rule (§A.2). */
  private playerDamage(now: number): void {
    const { myId } = this;
    for (const [id, st] of this.peerStates) {
      if (id === myId) {
        continue;
      }
      if (!st || !st.alive) {
        continue;
      }
      if (!this.playerRamDamage(id, st, now)) {
        return;
      }
      if (!this.playerVolleyDamage(id, st, now)) {
        return;
      }
    }
  }

  /** Hull contact with a remote ship: their armed RAM drains me 35 (victim
   *  adjudicates); my own armed RAM costs me 10 (they take their 35). */
  private playerRamDamage(id: string, st: PlayerNetState, now: number): boolean {
    const contact2 = SHIP_RADIUS * 2 * (SHIP_RADIUS * 2);
    const touching = dist2(st.x, st.y, this.shipX, this.shipY) <= contact2;
    if (
      touching &&
      st.shieldMod?.kind === "ram" &&
      st.shieldMod.active &&
      !st.invuln &&
      now >= this.contactIframeUntil
    ) {
      const res = this.applyDamage(RAM_PVP_DRAIN, st.x, st.y, "PLAYER", id, now);
      if (res !== "drained") {
        return false;
      }
      this.bounceOff(st.x, st.y, 0.5);
      this.contactIframeUntil = now + CONTACT_IFRAME_MS;
    }
    if (touching && this.ramArmed()) {
      const imm = this.ramImmunity.get(id);
      if (imm === undefined || now >= imm) {
        this.ramImmunity.set(id, now + RAM_IMMUNITY_MS);
        if (this.applyDamage(RAM_SELF_DRAIN, st.x, st.y, "PLAYER", id, now) !== "drained") {
          return false;
        }
      }
    }
    return true;
  }

  /**
   * Volley rule: test ALL of one shooter's beams this frame, sum the
   * drains, clamp, apply once, then i-frame that shooter — this is what
   * makes SCATTER one 48-drain volley instead of an instakill, and stops
   * a persistent beam snapshot draining 60×/s between 20Hz updates.
   */
  private playerVolleyDamage(id: string, st: PlayerNetState, now: number): boolean {
    const iframeUntil = this.pvpIframeUntil.get(id) ?? 0;
    if (now < iframeUntil) {
      return true;
    }
    const volley = this.collectVolley(st);
    if (!volley.impact) {
      return true;
    }
    // Heavy beams (RAILGUN, power ≥ 0.9) get the 300ms tier: a 320px lance
    // covers the victim across ≥2 serialized snapshots (~150ms at 20Hz), so
    // the 120ms i-frame would let one shot drain twice — 180 from full,
    // breaking PVP_MAX_SINGLE_HIT's no-volley-kills-from-full invariant.
    // No intended-TTK change: BLASTER (450ms) and RAILGUN (1100ms) both
    // refire slower than 300ms. GLAIVE shares the tier: the blade stalls at
    // its apex (GLAIVE_DECEL_PX), so a parked snapshot would otherwise
    // re-drain 35 every 120ms — apex camping beats the intended ~per-pass hit.
    const heavy = volley.anyExploding || volley.anyGlaive || volley.maxPower >= 0.9;
    this.pvpIframeUntil.set(id, now + (heavy ? PVP_EXPLOSION_IFRAME_MS : PVP_HIT_IFRAME_MS));
    let { beamDrain } = volley;
    if (beamDrain > 0 && this.reflectArmed()) {
      // One bounce covers the entire same-frame volley; AoE is never
      // reflected and drains normally on top.
      this.fireReflectBeam(volley.reflectAngle, now);
      beamDrain = REFLECT_BOUNCE_COST;
    }
    const total = Math.min(PVP_MAX_SINGLE_HIT, beamDrain + volley.aoeDrain);
    const res = this.applyDamage(total, volley.impact.x, volley.impact.y, "PLAYER", id, now);
    return res === "drained";
  }

  /** Sum one shooter's beams (and TESLA aura) that touch my hull this frame. */
  private collectVolley(st: PlayerNetState): Volley {
    const v: Volley = {
      anyExploding: false,
      anyGlaive: false,
      aoeDrain: 0,
      beamDrain: 0,
      impact: null,
      maxPower: 0,
      reflectAngle: 0,
    };
    // TESLA AURA (RAM pattern): the shooter's serialized flag + MY
    // proximity adjudicate the zap. It joins the same volley sum, so the
    // aura and any stray beam clamp + i-frame together.
    if (st.tesla && dist2(st.x, st.y, this.shipX, this.shipY) <= TESLA_RANGE * TESLA_RANGE) {
      v.beamDrain += TESLA_POWER * 100 * PVP_DAMAGE_MULT;
      v.maxPower = Math.max(v.maxPower, TESLA_POWER);
      v.impact = { x: st.x, y: st.y };
      v.reflectAngle = Math.atan2(st.y - this.shipY, st.x - this.shipX);
    }
    for (const sb of st.beams) {
      // inert mines never hit-test
      if (sb.mine && !sb.exploding) {
        continue;
      }
      // SINGULARITY orb: only the pop damages
      if (sb.orb) {
        continue;
      }
      // TESLA chains are render-only for PvP — the flag above is the drain.
      if (st.tesla && sb.chain) {
        continue;
      }
      const chainSeg = serializedBeamHitSeg(sb, this.shipX, this.shipY);
      if (chainSeg === null) {
        continue;
      }
      const power = sb.power ?? WEAPON_DEFAULT.power;
      v.maxPower = Math.max(v.maxPower, power);
      // ARC hops decay like the owner-side cast: segment i ends at hop i+1,
      // so segment 0 (muzzle→first target) is full power and each later
      // segment falls off once per hop — matching the PvE falloff exactly.
      const hopMult = sb.chain ? ARC_FALLOFF ** chainSeg : 1;
      const drain = power * 100 * PVP_DAMAGE_MULT * hopMult;
      if (sb.exploding) {
        v.aoeDrain += drain;
        v.anyExploding = true;
      } else {
        if (sb.glaive === true) {
          v.anyGlaive = true;
        }
        v.beamDrain += drain;
        v.reflectAngle = Math.atan2(sb.ty - sb.hy, sb.tx - sb.hx);
      }
      v.impact ??= { x: sb.hx, y: sb.hy };
    }
    return v;
  }

  private die(now: number, killerId: string | null, cause: string): void {
    this.fx.battle.burst(
      this.shipX,
      this.shipY,
      110,
      this.myTint(),
      "death",
      this.shipAngle,
      "important",
    );
    this.splinterBurst(this.shipX, this.shipY, 50, 30, now);
    this.fx.shatter(
      this.shipX,
      this.shipY,
      shipHullPoints(),
      this.shipAngle,
      this.myTint(),
      "important",
    );
    this.fx.ring(this.shipX, this.shipY, 10, 90, 400, 0xff_ff_ff, 0.7, "important");
    this.screenFlash();
    this.trauma.add(0.55);
    // break = death, layered under the boom (§A.4)
    sfx.play("shield_break");
    sfx.play("player_death");
    this.alive = false;
    this.respawnAt = now + RESPAWN_DELAY_MS;
    this.invulnUntil = 0;
    // mines included — they ride in beams[]
    this.beams = [];
    // the turret dies with its owner
    this.sentry = null;
    // Death tax: lose XP (and maybe one level), then revert to the new level's
    // base weapon. Mod + boosters lost, combo resets.
    this.applyDeathXpPenalty();
    this.specialBase = null;
    this.weapon = baseWeaponForLevel(this.level);
    this.weaponUntil = 0;
    this.regenMult = baseRegenMult(this.level);
    this.shieldHp = 0;
    this.overHp = 0;
    this.shieldMod = null;
    this.shieldModUntil = 0;
    this.boosts.clear();
    this.windupAcc = 0;
    this.regenActive = false;
    this.impactArcs = [];
    this.phasedUntil = 0;
    this.streak = 0;
    this.comboTier = 1;
    this.deathCause = cause;
    const count = (this.deathCounts.get(cause) ?? 0) + 1;
    this.deathCounts.set(cause, count);
    this.deathHint = count >= 3 ? (DEATH_HINTS.get(cause) ?? "") : "";
    const { myId } = this;
    if (killerId && myId) {
      this.netSendEvent("player_killed", { cause, killerId, victimId: myId });
    }
    // immediate, so remote ships hide without 50ms lag
    this.pushMyState(now);
  }

  /** 50ms full-screen white at 0.25, fading 200ms (§9 player death). */
  private screenFlash(): void {
    this.flashRect.setSize(this.scale.width + 8, this.scale.height + 8);
    this.flashRect.setAlpha(REDUCED_MOTION.matches ? 0 : 0.25);
    this.tweens.killTweensOf(this.flashRect);
    this.tweens.add({ alpha: 0, delay: 50, duration: 200, targets: this.flashRect });
  }

  private myTint(): number {
    const { myId } = this;
    return (myId ? this.ships.get(myId)?.tint : undefined) ?? 0xff_ff_ff;
  }

  private pickupItems(now: number): void {
    if (!this.alive || !this.spawned || now < this.phasedUntil) {
      return;
    }
    const { items } = this.world;
    for (let i = items.length - 1; i >= 0; i -= 1) {
      const it = items[i];
      if (!it || this.recentPickups.has(it.id)) {
        continue;
      }
      if (dist2(it.x, it.y, this.shipX, this.shipY) > ITEM_PICKUP_RADIUS * ITEM_PICKUP_RADIUS) {
        continue;
      }
      if (it.kind === "weapon") {
        this.pickupWeapon(it.weaponIdx, now);
      } else if (it.kind === "shield") {
        this.pickupShieldMod(it.shieldIdx, now);
      } else {
        this.pickupBooster(it.boosterIdx, now);
      }
      this.recentPickups.set(it.id, now);
      this.netSendEvent("item_pickup", { itemId: it.id });
      // Remove locally right away; the host event (or the next reconcile,
      // guarded by recentPickups) makes it stick.
      items.splice(i, 1);
      if (this.amHost) {
        this.dirty.items = true;
      }
    }
    this.expireClaims(now);
  }

  private pickupSparks(tint: number): void {
    this.fx.sparks(this.shipX, this.shipY, 14, tint, {
      lifeMax: 420,
      lifeMin: 200,
      speedMax: 140,
      speedMin: 30,
    });
  }

  private pickupWeapon(weaponIdx: number, now: number): void {
    const weapon = WEAPONS_SPECIAL[weaponIdx] ?? WEAPON_DEFAULT;
    if (weapon.name === this.weapon.name && now < this.weaponUntil) {
      // v3 stacking: same weapon EXTENDS the timer (+full duration,
      // capped at ITEM_STACK_CAP_MS out from now).
      this.weaponUntil = Math.min(
        this.weaponUntil + SPECIAL_WEAPON_DURATION_MS,
        now + ITEM_STACK_CAP_MS,
      );
    } else {
      // Keep the unscaled base so a later level-up re-scales it (no compounding).
      this.specialBase = weapon;
      this.weapon = scaleWeaponForLevel(weapon, this.level);
      // replace resets the timer
      this.weaponUntil = now + SPECIAL_WEAPON_DURATION_MS;
      this.windupAcc = 0;
    }
    if (!this.trailer) {
      this.mastery.pickup(this.weapon.name, now, this.weaponUntil);
    }
    this.pickupSparks(weapon.tint);
    sfx.play("pickup", { priority: "local" });
  }

  /** Timed shield MODIFIER on the base shield (one held; same kind extends
   *  +20s capped at 60s out AND refreshes its resource; different kind
   *  replaces). */
  private pickupShieldMod(shieldIdx: number, now: number): void {
    const kind = SHIELD_MOD_KINDS[shieldIdx] ?? "overshield";
    if (kind === this.shieldMod && now < this.shieldModUntil) {
      this.shieldModUntil = Math.min(
        this.shieldModUntil + SHIELD_MOD_DURATION_MS,
        now + ITEM_STACK_CAP_MS,
      );
      // bonus refill
      if (kind === "overshield") {
        this.overHp = OVERSHIELD_BONUS;
      }
      // blink ready again
      if (kind === "phase") {
        this.phaseReadyAt = 0;
      }
    } else {
      this.shieldMod = kind;
      this.shieldModUntil = now + SHIELD_MOD_DURATION_MS;
      this.overHp = kind === "overshield" ? OVERSHIELD_BONUS : 0;
      this.phaseReadyAt = 0;
    }
    this.haloFlashUntil = now + 200;
    this.pickupSparks(SHIELD_MOD_SPECS[kind].tint);
    sfx.play("pickup_shield", { priority: "local" });
  }

  private pickupBooster(boosterIdx: number, now: number): void {
    const kind = BOOSTER_KINDS[boosterIdx] ?? "repair";
    if (kind === "repair") {
      // Instant: base only — never fills the OVERSHIELD bonus.
      this.shieldHp = Math.max(this.shieldHp, SHIELD_MAX);
      this.lastDamageAt = 0;
      this.repairSweepUntil = now + 200;
      sfx.play("shield_regen");
    } else {
      // Different kinds stack freely; the SAME kind extends its timer
      // (+its duration, capped at ITEM_STACK_CAP_MS out from now).
      const cur = this.boosts.get(kind);
      const dur = BOOSTER_SPECS[kind].durationMs;
      this.boosts.set(
        kind,
        cur !== undefined && cur > now ? Math.min(cur + dur, now + ITEM_STACK_CAP_MS) : now + dur,
      );
    }
    this.pickupSparks(BOOSTER_SPECS[kind].tint);
    sfx.play("pickup_booster", { priority: "local" });
  }

  /** Age out the local claim guards (pickups, consumed shots, RAM and PvP i-frames). */
  private expireClaims(now: number): void {
    for (const [id, t] of this.recentPickups) {
      if (now - t > 5000) {
        this.recentPickups.delete(id);
      }
    }
    for (const [id, t] of this.recentConsumedShots) {
      if (now - t > 5000) {
        this.recentConsumedShots.delete(id);
      }
    }
    for (const [id, t] of this.ramImmunity) {
      if (now > t) {
        this.ramImmunity.delete(id);
      }
    }
    for (const [id, t] of this.pvpIframeUntil) {
      if (now > t) {
        this.pvpIframeUntil.delete(id);
      }
    }
  }

  /** XP orbs (former score shards): generous-radius hoover, +XP.ORB each (flat,
   *  never combo-multiplied; SALVAGE doubles it). Same claimer pattern as items:
   *  collect locally, tell the host, guard reconciles. */
  private collectShards(now: number): void {
    if (!this.alive || !this.spawned || now < this.phasedUntil) {
      return;
    }
    const r2 = SHARD_PICKUP_RADIUS * SHARD_PICKUP_RADIUS;
    const { shards } = this.world;
    const orbXp = (this.boosts.get("salvage") ?? 0) > now ? XP.ORB * SALVAGE_MULT : XP.ORB;
    for (let i = shards.length - 1; i >= 0; i -= 1) {
      const s = shards[i];
      if (!s || this.recentShardPickups.has(s.id)) {
        continue;
      }
      if (dist2(s.x, s.y, this.shipX, this.shipY) > r2) {
        continue;
      }
      this.gainXp(orbXp, now);
      this.recentShardPickups.set(s.id, now);
      this.netSendEvent("shard_pickup", { shardId: s.id });
      shards.splice(i, 1);
      if (this.amHost) {
        this.dirty.shards = true;
      }
      // Pooled sparkle + soft collect blip (pickup chirp, low gain, pitched up).
      this.fx.sparks(s.x, s.y, 3, SHARD_TINT, {
        lifeMax: 220,
        lifeMin: 120,
        scale: 0.4,
        speedMax: 90,
        speedMin: 20,
      });
      sfx.play("pickup", { gain: 0.25, rate: 1.6 });
    }
    for (const [id, t] of this.recentShardPickups) {
      if (now - t > 5000) {
        this.recentShardPickups.delete(id);
      }
    }
  }

  /** Tiny wireframe crystals, one pooled Graphics pass (additive layer):
   *  4-point diamond + vertical facet, gentle pulse, fade in the last 1.5s. */
  private drawShards(now: number): void {
    const g = this.shardGfx;
    g.clear();
    for (const s of this.world.shards) {
      const left = s.diesAt - now;
      if (left <= 0) {
        continue;
      }
      const alpha = 0.9 * Math.min(1, left / 1500);
      const r = 2.5 + 0.7 * Math.sin(now / 180 + s.x * 0.05);
      g.lineStyle(1, SHARD_TINT, alpha);
      strokeDiamond(g, s.x, s.y, r);
      g.lineBetween(s.x, s.y - r, s.x, s.y + r);
    }
  }

  private netSend(delta: number, now: number): void {
    this.netAcc += delta;
    if (this.netAcc < NET_INTERVAL_MS) {
      return;
    }
    this.netAcc = 0;
    this.pushMyState(now);
  }

  /** Wire shape of my shield mod: `active` = ram-armed / reflect->40 / phase-ready. */
  private shieldModNetState(now: number): ShieldModNetState | null {
    const mod = this.shieldMod;
    if (!mod) {
      return null;
    }
    return {
      active: this.shieldModArmed(mod, now),
      kind: mod,
      phased: now < this.phasedUntil,
      until: this.shieldModUntil,
    };
  }

  private shieldModArmed(mod: ShieldModKind, now: number): boolean {
    if (mod === "ram") {
      return this.ramArmed();
    }
    if (mod === "reflect") {
      return this.reflectArmed();
    }
    if (mod === "phase") {
      return now >= this.phaseReadyAt;
    }
    return true;
  }

  private boostsNetState(): BoostNetState[] {
    const out: BoostNetState[] = [];
    for (const [kind, until] of this.boosts) {
      out.push({ kind, until });
    }
    return out;
  }

  private pushMyState(now: number): void {
    if (!this.myId) {
      return;
    }
    const state: PlayerNetState = {
      alive: this.alive,
      angle: this.shipAngle,
      beams: this.beams.filter((b) => !b.vanished && !b.fizzle).map(serializeBeam),
      boosts: this.boostsNetState(),
      invuln: now < this.invulnUntil,
      level: this.level,
      overHp: Math.max(0, Math.round(this.overHp)),
      // present tracks "in the arena": spawned covers pre-spawn AND the paused
      // despawn (which clears spawned) in one flag.
      present: this.spawned,
      sectorScore: Math.round(this.sectorScore),
      sentry:
        this.sentry && now < this.sentry.until
          ? { until: this.sentry.until, x: this.sentry.x, y: this.sentry.y }
          : null,
      shieldHp: Math.max(0, Math.round(this.shieldHp)),
      shieldMod: this.shieldModNetState(now),
      streak: this.streak,
      tesla: this.teslaActive(now),
      vx: this.shipVX,
      vy: this.shipVY,
      weaponName: this.weapon.name,
      windup: this.windupFrac(),
      x: this.shipX,
      xp: this.xp,
      y: this.shipY,
    };
    if (!this.offline && this.connected) {
      this.client.updateMyState(playerToWire(state));
    }
  }

  // ---- connection callbacks ----------------------------------------------------

  private handleEvent(event: string, payload: WireValue, _from: string): void {
    const p = asWireRecord(payload);
    if (event === "player_killed") {
      // The killer awards itself: every client hears the victim's report.
      if (p && p["killerId"] === this.myId) {
        this.registerKill(XP.PLAYER_KILL, simNow(), "player");
      }
      return;
    }
    if (!this.prepareHost() || !p) {
      return;
    }
    if (event === "asteroid_hit" || event === "ufo_hit" || event === "enemy_hit") {
      this.hostHandleHit(event, p);
      return;
    }
    if (event === "proj_consumed") {
      this.hostRemoveById(this.world.enemyShots, wireStr(p["shotId"]), "enemyShots");
    } else if (event === "item_pickup") {
      this.hostRemoveById(this.world.items, wireStr(p["itemId"]), "items");
    } else if (event === "shard_pickup") {
      this.hostRemoveById(this.world.shards, wireStr(p["shardId"]), "shards");
    } else if (event === "singularity") {
      // SINGULARITY collapse: one shared pull entry; hostApplyPulls drags
      // enemies/asteroids until it expires (pruned in hostTick).
      const x = wireNum(p["x"]);
      const y = wireNum(p["y"]);
      const until = wireNum(p["until"]);
      if (x !== null && y !== null && until !== null) {
        this.world.pulls.push({ id: entityId(), until, x, y });
        this.dirty.pulls = true;
      }
    }
  }

  /** Host: apply a client's reported hit to the shared entity. */
  private hostHandleHit(event: "asteroid_hit" | "ufo_hit" | "enemy_hit", p: WireRecord): void {
    const damage = wireNum(p["damage"]);
    if (damage === null) {
      return;
    }
    if (event === "ufo_hit") {
      this.hostDamageUfo(damage);
      return;
    }
    if (event === "asteroid_hit") {
      const id = wireStr(p["asteroidId"]);
      if (id !== null) {
        this.hostDamageAsteroid(id, damage);
      }
      return;
    }
    const id = wireStr(p["enemyId"]);
    if (id !== null) {
      const kx = wireNum(p["kx"]) ?? 0;
      const ky = wireNum(p["ky"]) ?? 0;
      this.hostDamageEnemy(id, damage, kx, ky);
    }
  }

  /** Host: a client claimed (consumed / picked up) a shared entity — drop it. */
  private hostRemoveById<T extends { id: string }>(
    list: T[],
    id: string | null,
    field: keyof GameScene["dirty"],
  ): void {
    if (id === null) {
      return;
    }
    const idx = list.findIndex((e) => e.id === id);
    if (idx !== -1) {
      list.splice(idx, 1);
      this.dirty[field] = true;
    }
  }

  private onUpdate(): void {
    this.ensureSeeded();
    if (this.prepareHost()) {
      return;
    }
    // Reconcile only when the shared object identity changed (i.e. a real
    // state patch) — notify() also fires for player-state traffic, and
    // re-blending toward a stale snapshot would drag entities backwards.
    if (this.live && this.client.sharedState !== this.lastSharedRef) {
      this.lastSharedRef = this.client.sharedState;
      this.reconcileFromShared();
    }
  }

  private shared(): SharedState | null {
    // local world is authoritative solo
    if (this.offline) {
      return this.world;
    }
    return isShared(this.client.sharedState) ? this.client.sharedState : null;
  }

  /** Server election alone is not adoption. A reconnect may admit us as host
   * with a newer sync while our old working copy still contains dead entities.
   * Adopt once before host commands/ticks; never alias the SDK's shallow cache.
   * Local ship, rewards and pending pickup guards remain owner-controlled. */
  private prepareHost(): boolean {
    if (this.offline) {
      return true;
    }
    if (!this.amHost) {
      this.hostSnapshotReady = false;
      return false;
    }
    if (this.hostSnapshotReady) {
      return true;
    }
    const shared = this.shared();
    if (!shared) {
      return false;
    }
    const accepted = structuredClone(shared);
    this.world = {
      ...accepted,
      arenaEpoch: Number.isFinite(accepted.arenaEpoch)
        ? accepted.arenaEpoch
        : this.world.arenaEpoch,
      beacon: accepted.beacon ?? null,
      enemies: accepted.enemies ?? [],
      enemyShots: accepted.enemyShots ?? [],
      items: accepted.items ?? [],
      playH: Number.isFinite(accepted.playH)
        ? PhaserMath.Clamp(accepted.playH, BASE_WORLD_H, WORLD_H)
        : this.world.playH,
      playW: Number.isFinite(accepted.playW)
        ? PhaserMath.Clamp(accepted.playW, BASE_WORLD_W, WORLD_W)
        : this.world.playW,
      pulls: accepted.pulls ?? [],
      sectorBossIdx: Number.isFinite(accepted.sectorBossIdx)
        ? accepted.sectorBossIdx
        : this.world.sectorBossIdx,
      shards: accepted.shards ?? [],
      ufo: accepted.ufo ?? null,
    };
    this.hostSnapshotReady = true;
    this.lastSharedRef = this.client.sharedState;
    // Existing migration policy: host-local AI is reconstructed, and the first
    // host tick rearms spawn/beacon cadence instead of bursting overdue spawns.
    this.enemySim.clear();
    this.wasHost = false;
    // Admission is a baseline, not evidence that a missed encounter just
    // happened. Fresh events on the admitted world still announce normally.
    this.bossEncounters.reset();
    this.battleBeat.reset();
    this.observeBossEncounters(this.world);
    return true;
  }

  /**
   * The first host to connect seeds the world (arenaEpoch = now + the opening
   * asteroid field). Guests adopt the host's existing state; a guest promoted
   * to host after a migration keeps the live world — and the epoch — instead
   * of resetting it.
   */
  private ensureSeeded(): void {
    // Seed the opening asteroid field within the play bounds for the current
    // player count (so a multi-player arena opens fully populated, not just the
    // base 1-player box).
    const seedField = (s: SharedState): void => {
      const pc = Math.max(1, Object.keys(this.peers).length);
      s.playW = playWidthForPlayers(pc);
      s.playH = playHeightForPlayers(pc);
      for (let i = 0; i < ASTEROID_SEED_COUNT; i += 1) {
        s.asteroids.push(spawnAsteroidState(s.playW, s.playH));
      }
    };
    if (this.offline) {
      // Solo arena: seed the local world directly, nothing to broadcast.
      if (!this.offlineSeeded) {
        this.offlineSeeded = true;
        const seeded = emptyShared();
        seedField(seeded);
        this.world = seeded;
      }
      return;
    }
    if (this.amHost && this.connected && !this.shared()) {
      const seeded = emptyShared();
      seedField(seeded);
      this.world = seeded;
      // We authored this empty-room seed at full precision. A synchronous SDK
      // notification must not replace it with its quantized outgoing copy.
      this.hostSnapshotReady = true;
      this.client.updateSharedState(sharedToPatch(seeded));
    }
  }

  /** Guest-side: adopt the host's 20Hz snapshot into the local working copy. */
  private reconcileFromShared(): void {
    const s = this.shared();
    if (!s) {
      return;
    }
    this.observeBossEncounters(s);
    this.reconcileArena(s);
    this.reconcileAsteroids(s);
    this.reconcileUfo(s);
    const w = this.world;
    w.items = reconcileDrifters(w.items, s.items ?? [], this.recentPickups);
    this.reconcileEnemies(s);
    w.shards = reconcileDrifters(w.shards, s.shards ?? [], this.recentShardPickups);
    w.enemyShots = reconcileDrifters(w.enemyShots, s.enemyShots ?? [], this.recentConsumedShots);
    // Pulls are static entries — adopt wholesale (the vortex renders from
    // them; the host moves the affected bodies).
    w.pulls = (s.pulls ?? []).map((p) => ({ id: p.id, until: p.until, x: p.x, y: p.y }));
    // Beacon: one static host-written entry — adopt wholesale. Phases and
    // countdowns derive from its timestamps locally (tickBeaconClient).
    w.beacon = s.beacon ? { ...s.beacon } : null;
  }

  private reconcileArena(s: SharedState): void {
    const w = this.world;
    if (Number.isFinite(s.arenaEpoch)) {
      w.arenaEpoch = s.arenaEpoch;
    }
    // Boss-guarantee marker (dir-006): adopt like the epoch so a promoted
    // host never double-guarantees. Legacy snapshots omit it → keep local.
    if (Number.isFinite(s.sectorBossIdx)) {
      w.sectorBossIdx = s.sectorBossIdx;
    }
    // Clamp to valid bounds — never trust an out-of-range value from the host.
    if (Number.isFinite(s.playW)) {
      w.playW = PhaserMath.Clamp(s.playW, BASE_WORLD_W, WORLD_W);
    }
    if (Number.isFinite(s.playH)) {
      w.playH = PhaserMath.Clamp(s.playH, BASE_WORLD_H, WORLD_H);
    }
  }

  private reconcileAsteroids(s: SharedState): void {
    const w = this.world;
    const localAsteroids = indexById(w.asteroids);
    const asteroidIds = new Set<string>();
    for (const a of s.asteroids) {
      asteroidIds.add(a.id);
      const local = localAsteroids.get(a.id);
      if (!local) {
        w.asteroids.push(cloneAsteroid(a));
        continue;
      }
      local.radius = a.radius;
      local.vx = a.vx;
      local.vy = a.vy;
      blendPos(local, a.x, a.y);
    }
    // Departed asteroids (destroyed or culled) — display sweep handles the FX.
    w.asteroids = w.asteroids.filter((x) => asteroidIds.has(x.id));
  }

  private reconcileUfo(s: SharedState): void {
    const w = this.world;
    if (!s.ufo) {
      w.ufo = null;
    } else if (!w.ufo || w.ufo.id !== s.ufo.id) {
      w.ufo = { ...s.ufo };
    } else {
      const u = w.ufo;
      u.hp = s.ufo.hp;
      u.blinkUntil = s.ufo.blinkUntil;
      u.destX = s.ufo.destX;
      u.destY = s.ufo.destY;
      blendPos(u, s.ufo.x, s.ufo.y);
    }
  }

  private reconcileEnemies(s: SharedState): void {
    const w = this.world;
    const localEnemies = indexById(w.enemies);
    const enemyIds = new Set<string>();
    for (const e of s.enemies ?? []) {
      enemyIds.add(e.id);
      const local = localEnemies.get(e.id);
      if (!local) {
        w.enemies.push({ ...e });
        continue;
      }
      local.vx = e.vx;
      local.vy = e.vy;
      local.angle = e.angle;
      local.hp = e.hp;
      local.telegraphUntil = e.telegraphUntil;
      local.chargeUntil = e.chargeUntil;
      local.attackAt = e.attackAt;
      // Keep the most pessimistic blink (local prediction may be ahead).
      local.blinkUntil = Math.max(local.blinkUntil, e.blinkUntil);
      local.graceUntil = e.graceUntil;
      local.maxHp = e.maxHp;
      // sniper/boss laser sights
      local.lances = e.lances;
      // warden shield state
      local.shielded = e.shielded;
      blendPos(local, e.x, e.y);
    }
    w.enemies = w.enemies.filter((x) => enemyIds.has(x.id));
  }

  // ---- world simulation ----------------------------------------------------------

  /** Movement integration — runs on every client for 60fps-smooth motion. */
  private advanceWorld(dt: number): void {
    for (const a of this.world.asteroids) {
      a.x += a.vx * dt;
      a.y += a.vy * dt;
      a.rot += ASTEROID_ROT_SPEED * dt;
    }
    const u = this.world.ufo;
    if (u) {
      const dx = u.destX - u.x;
      const dy = u.destY - u.y;
      const dist = Math.hypot(dx, dy);
      const step = UFO_SPEED * dt;
      if (dist > step) {
        u.x += (dx / dist) * step;
        u.y += (dy / dist) * step;
      } else {
        // Park at the destination; only the host picks the next one.
        u.x = u.destX;
        u.y = u.destY;
      }
    }
    for (const it of this.world.items) {
      it.x += it.vx * dt;
      it.y += it.vy * dt;
    }
    for (const s of this.world.shards) {
      s.x += s.vx * dt;
      s.y += s.vy * dt;
    }
    for (const e of this.world.enemies) {
      e.x = PhaserMath.Clamp(e.x + e.vx * dt, -40, this.world.playW + 40);
      e.y = PhaserMath.Clamp(e.y + e.vy * dt, -40, this.world.playH + 40);
    }
    for (const s of this.world.enemyShots) {
      s.x += s.vx * dt;
      s.y += s.vy * dt;
    }
  }

  // ---- host-only logic -------------------------------------------------------------

  private hostTick(now: number, dt: number, delta: number): void {
    if (!this.prepareHost()) {
      return;
    }
    if (!this.wasHost) {
      this.hostAdoptClocks(now);
    }
    const w = this.world;
    const d = this.dirty;
    const tSec = Math.max(0, (now - w.arenaEpoch) / 1000);
    const intensity = arenaIntensity(tSec);
    const pc = Math.max(1, Object.keys(this.peers).length);
    const pressure = playerPressure(pc);
    const wave = wavePulse(tSec);
    // Grow the play area with player count (grow-only within an arena, so it
    // never yanks ships inward; resets to BASE on a fresh arena). Broadcast on
    // change so every client clamps/spawns/culls to the same bounds.
    const wantW = playWidthForPlayers(pc);
    if (wantW > w.playW) {
      w.playW = wantW;
      w.playH = playHeightForPlayers(pc);
      this.playBoundsDirty = true;
    }
    this.hostTickAsteroids(now, intensity, pressure, wave);
    this.hostTickUfo(now, dt);
    this.hostTickPickups(now);

    // One living-players snapshot for the whole tick (spawn/boss/sim/breather).
    const players = this.livingPlayers();
    this.hostTickBeacon(now, tSec, players);
    this.hostSpawnEnemies(now, tSec, intensity, pressure, wave, players);
    this.hostMaybeSpawnBoss(now, intensity, players);
    this.hostSimEnemies(now, dt, players);
    // After the sim: the pull overrides steering for dragged enemies.
    this.hostApplyPulls(now);
    const livePulls = w.pulls.filter((p) => p.until > now);
    if (livePulls.length !== w.pulls.length) {
      w.pulls = livePulls;
      d.pulls = true;
    }
    // Trailer: staged crowds are deliberately far over the cap and the wide
    // zooms put the despawn line on camera — never cull them mid-shot.
    if (!this.trailer) {
      this.hostDespawnBreather(now, intensity, pressure, wave, players);
    }

    const liveShots = w.enemyShots.filter(
      (s) => s.diesAt > now && inWorld(s.x, s.y, 60, w.playW, w.playH),
    );
    if (liveShots.length !== w.enemyShots.length) {
      w.enemyShots = liveShots;
      d.enemyShots = true;
    }
    this.hostMarkMotionDirty();

    this.shareAcc += delta;
    if (this.shareAcc < NET_INTERVAL_MS) {
      return;
    }
    this.shareAcc = 0;
    this.hostShareWorld();
  }

  /** First tick after promotion (or first-ever host): zeroed spawn stamps
   *  would read as long-overdue and burst-spawn. Start intervals from now. */
  private hostAdoptClocks(now: number): void {
    this.wasHost = true;
    this.lastAsteroidSpawnAt = now;
    this.lastEnemySpawnAt = now;
    // Recover the beacon cadence clock: a live beacon carries its own start
    // (activeAt − CHARGE); with none live, a mid-run promotion stamps `now`
    // (worst case one trough of extra delay) while a fresh arena keeps 0 so
    // the first beacon still lands at t≈90.
    const b = this.world.beacon;
    if (b) {
      this.lastBeaconStartedAt = b.activeAt - BEACON_CHARGE_S * 1000;
    } else if ((now - this.world.arenaEpoch) / 1000 >= BEACON_MIN_T_S) {
      this.lastBeaconStartedAt = now;
    }
  }

  private hostTickAsteroids(now: number, intensity: number, pressure: number, wave: number): void {
    const w = this.world;
    if (
      w.asteroids.length < asteroidCap(intensity, pressure, wave) &&
      now - this.lastAsteroidSpawnAt > asteroidSpawnIntervalMs(intensity)
    ) {
      w.asteroids.push(spawnAsteroidState(w.playW, w.playH));
      this.lastAsteroidSpawnAt = now;
      this.dirty.asteroids = true;
    }
    const kept = w.asteroids.filter((a) =>
      inWorld(a.x, a.y, ASTEROID_CULL_MARGIN, w.playW, w.playH),
    );
    if (kept.length !== w.asteroids.length) {
      w.asteroids = kept;
      this.dirty.asteroids = true;
    }
  }

  /** UFO is the weapon piñata; the v2 gate relaxes to < 2 weapon items live.
   *  Trailer mode: never — a wandering piñata (and its weapon drop landing
   *  in the player's pickup radius) would derail a staged shot. */
  private hostTickUfo(now: number, dt: number): void {
    const w = this.world;
    const weaponItemsInFlight = w.items.filter((it) => it.kind === "weapon").length;
    if (!w.ufo && !this.trailer && weaponItemsInFlight < 2 && rand() < UFO_SPAWN_RATE * dt) {
      w.ufo = spawnUfoState(w.playW, w.playH);
      this.dirty.ufo = true;
    }
    if (w.ufo && w.ufo.x === w.ufo.destX && w.ufo.y === w.ufo.destY) {
      w.ufo.destX = rand() * w.playW;
      w.ufo.destY = rand() * w.playH;
      this.dirty.ufo = true;
    }
  }

  /** Expire items + shards, then run the magnet pass. */
  private hostTickPickups(now: number): void {
    const w = this.world;
    const liveItems = w.items.filter((it) => it.diesAt > now);
    if (liveItems.length !== w.items.length) {
      w.items = liveItems;
      this.dirty.items = true;
    }
    const liveShards = w.shards.filter((s) => s.diesAt > now);
    if (liveShards.length !== w.shards.length) {
      w.shards = liveShards;
      this.dirty.shards = true;
    }
    this.hostMagnetItems(now);
  }

  /** Continuous motion dirties whatever is actually moving. */
  private hostMarkMotionDirty(): void {
    const w = this.world;
    const d = this.dirty;
    if (w.asteroids.length > 0) {
      d.asteroids = true;
    }
    if (w.ufo) {
      d.ufo = true;
    }
    if (w.items.length > 0) {
      d.items = true;
    }
    if (w.shards.length > 0) {
      d.shards = true;
    }
    if (w.enemies.length > 0) {
      d.enemies = true;
    }
    if (w.enemyShots.length > 0) {
      d.enemyShots = true;
    }
  }

  /** Send the dirty fields as one shallow-merge patch, then clear the flags. */
  private hostShareWorld(): void {
    const w = this.world;
    const d = this.dirty;
    // Quantize at the serialization boundary (shared/wire.ts) — the working
    // arrays keep full precision, only the outgoing snapshot is rounded.
    const patch: Partial<ReturnType<typeof sharedToPatch>> = {};
    if (d.asteroids) {
      patch["asteroids"] = w.asteroids.map(asteroidToWire);
    }
    if (d.ufo) {
      patch["ufo"] = w.ufo ? ufoToWire(w.ufo) : null;
    }
    if (d.items) {
      patch["items"] = w.items.map(itemToWire);
    }
    if (d.shards) {
      patch["shards"] = w.shards.map(shardToWire);
    }
    if (d.enemies) {
      patch["enemies"] = w.enemies.map(enemyToWire);
    }
    if (d.enemyShots) {
      patch["enemyShots"] = w.enemyShots.map(enemyShotToWire);
    }
    if (d.pulls) {
      patch["pulls"] = w.pulls.map(pullToWire);
    }
    if (d.beacon) {
      patch["beacon"] = w.beacon ? beaconToWire(w.beacon) : null;
    }
    // Piggyback play bounds on ANY outgoing patch (cheap — 2 ints) so guests and
    // a freshly-promoted host stay in sync; force a send if ONLY bounds changed.
    if (this.playBoundsDirty || Object.keys(patch).length > 0) {
      patch["playW"] = w.playW;
      patch["playH"] = w.playH;
      // Boss-guarantee marker rides along too (1 int): any spawn dirties
      // enemies, so the marker always reaches guests within the same patch.
      patch["sectorBossIdx"] = w.sectorBossIdx;
    }
    this.playBoundsDirty = false;
    if (!this.offline && this.connected && Object.keys(patch).length > 0) {
      this.client.updateSharedState(patch);
    }
    this.dirty = {
      asteroids: false,
      beacon: false,
      enemies: false,
      enemyShots: false,
      items: false,
      pulls: false,
      shards: false,
      ufo: false,
    };
  }

  /** Next share sends the whole world (bounds and boss marker included). */
  private markWorldDirty(): void {
    this.dirty = {
      asteroids: true,
      beacon: true,
      enemies: true,
      enemyShots: true,
      items: true,
      pulls: true,
      shards: true,
      ufo: true,
    };
    this.playBoundsDirty = true;
  }

  // ---- BEACON arena event (dir-004): host-side trigger/control/payout -----------------

  /** Alive+present players with ids — the beacon control census. Phased ships
   *  still count (they are IN the arena; only enemy targeting ignores them). */
  private beaconOccupants(cx: number, cy: number): string[] {
    const out: string[] = [];
    const { myId } = this;
    if (
      myId &&
      this.alive &&
      this.spawned &&
      Math.hypot(this.shipX - cx, this.shipY - cy) <= BEACON_RADIUS
    ) {
      out.push(myId);
    }
    for (const [id, st] of this.peerStates) {
      if (id === myId || !st || !st.alive || !st.present) {
        continue;
      }
      if (Math.hypot(st.x - cx, st.y - cy) <= BEACON_RADIUS) {
        out.push(id);
      }
    }
    return out;
  }

  /** Spawn eligibility + placement + the per-tick control read + the expiry
   *  payout. Phases themselves are DERIVED from the shared timestamps (never
   *  stored), so a promoted host resumes mid-phase from the snapshot alone. */
  private hostTickBeacon(now: number, tSec: number, players: Vec[]): void {
    const w = this.world;
    const b = w.beacon;
    if (b) {
      if (now >= b.diesAt) {
        // Expiry. Sole controller at the moment of death → the hold payout
        // crystal (guaranteed, pity-fed like an elite kill, cap-bypassed like
        // a UFO drop so it can never be silently skipped). The 40 XP bonus is
        // owner-simulated client-side off this same final snapshot; the gold
        // shockwave fx is drawn by every client in tickBeaconClient.
        if (b.controllerId !== null && !b.contested) {
          this.hostRollLoot(b.x, b.y, 1, true, true);
        }
        w.beacon = null;
        this.dirty.beacon = true;
        return;
      }
      if (now >= b.activeAt) {
        // ACTIVE: 0 inside → uncontrolled; 1 → controls; 2+ → contested.
        const occ = this.beaconOccupants(b.x, b.y);
        const controllerId = occ.length === 1 ? (occ[0] ?? null) : null;
        const contested = occ.length >= 2;
        if (controllerId !== b.controllerId || contested !== b.contested) {
          b.controllerId = controllerId;
          b.contested = contested;
          this.dirty.beacon = true;
        }
      }
      return;
    }
    // No beacon live: eligible only in the trough window of the intensity
    // director's macro wave, never in the opening 90s, and ≥180s start-to-
    // start (the spec's twice-stated t≈90/270/450 cadence — every other
    // trough; measured start-to-start, end-to-next-start comes to ~132s).
    // dir-006: the old global t>=90 gate generalizes to sector-relative time —
    // identical in sector 1; in later sectors it keeps the recap beat and the
    // fresh-start breath beacon-free. (540 = 6x90, so the trough window below
    // stays phase-locked to the same sector-relative times every sector.)
    if (sectorRelT(tSec) < BEACON_MIN_T_S) {
      return;
    }
    // dir-006: one "be HERE now" at a time — no NEW beacon while a dreadnought
    // is alive. A beacon already live completes normally (block above); the
    // deferred slot is not queued — the next eligible trough after boss death
    // picks the cadence back up through these same gates.
    if (w.enemies.some((e) => e.kind === "dreadnought")) {
      return;
    }
    if (tSec % BEACON_TROUGH_PERIOD_S > BEACON_SPAWN_WINDOW_S) {
      return;
    }
    if (
      this.lastBeaconStartedAt > 0 &&
      now - this.lastBeaconStartedAt < BEACON_MIN_INTERVAL_S * 1000
    ) {
      return;
    }
    // Placement: ≥600px inside the barrier, ≥900px from every present player
    // (fair approach run); crowded arenas take the candidate farthest from
    // the nearest player.
    let best: Vec | null = null;
    let bestClearance = -1;
    for (let i = 0; i < 12; i += 1) {
      const c = randomWorldPoint(BEACON_EDGE_MARGIN, BEACON_EDGE_MARGIN, w.playW, w.playH);
      let nearest = Infinity;
      for (const p of players) {
        nearest = Math.min(nearest, Math.hypot(p.x - c.x, p.y - c.y));
      }
      if (nearest > bestClearance) {
        bestClearance = nearest;
        best = c;
      }
      if (nearest >= BEACON_PLAYER_CLEARANCE) {
        break;
      }
    }
    if (!best) {
      return;
    }
    this.hostSpawnBeacon(best.x, best.y, now);
  }

  /** Create the shared beacon entry (also the dev-hook entrypoint; custom
   *  charge/active lengths are for compressed-timer e2e probes only). */
  private hostSpawnBeacon(
    x: number,
    y: number,
    now: number,
    chargeS = BEACON_CHARGE_S,
    activeS = BEACON_ACTIVE_S,
  ): void {
    this.world.beacon = {
      activeAt: now + chargeS * 1000,
      contested: false,
      controllerId: null,
      diesAt: now + (chargeS + activeS) * 1000,
      x,
      y,
    };
    this.lastBeaconStartedAt = now;
    this.dirty.beacon = true;
  }

  /** Position of a player by id (me from the live ship, remotes from their
   *  net state). Null when unknown/absent. */
  private playerPos(id: string): Vec | null {
    if (id === this.myId) {
      return this.spawned && this.alive ? { x: this.shipX, y: this.shipY } : null;
    }
    const st = this.peerStates.get(id);
    return st && st.alive ? { x: st.x, y: st.y } : null;
  }

  /** BEACON client side (every client, host included): the owner-simulated XP
   *  trickle + hold bonus, and the charge/arm/clash audio. Awards key off the
   *  HOST-written controllerId/contested — the same snapshot everywhere — so
   *  each client granting itself XP stays consistent (existing XP model). */
  private tickBeaconClient(now: number): void {
    const raw = this.world.beacon;
    // A locally-elapsed beacon is already gone (guests see expiry up to one
    // snapshot before the host's null patch arrives).
    const b = raw && now < raw.diesAt ? raw : null;
    const prev = this.lastBeacon;

    // Previous instance ended: fire the expiry payout exactly once, off the
    // host's last written control state. Only a NATURAL expiry pays — a
    // beacon that vanished early (fresh arena adoption) just disappears.
    const ended = prev && (!b || b.activeAt !== prev.activeAt) && now >= prev.diesAt - 100;
    if (ended && prev.controllerId !== null && !prev.contested) {
      this.beaconPayoutFx(prev, now);
    }
    if (!b) {
      // Gone (naturally paid out above, or vanished early → no payout ever).
      this.lastBeacon = null;
      return;
    }
    if (!prev || prev.activeAt !== b.activeAt) {
      // New instance: reset the per-instance bookkeeping.
      this.beaconTickIdx = 0;
      this.beaconBlipIdx = -1;
      this.beaconArmedFxDone = false;
    }
    if (now < b.activeAt) {
      this.tickBeaconCharge(b, now);
    } else {
      this.tickBeaconActive(b, now);
    }
    this.lastBeacon = { ...b };
  }

  /** Beacon audio falls off with distance from my ship. */
  private beaconGain(x: number, y: number): number {
    const d = Math.hypot(x - this.shipX, y - this.shipY);
    return PhaserMath.Clamp(1 - d / 3500, 0.2, 1);
  }

  /** Gold shockwave — fx only, no damage; every client draws it. The
   *  controller alone banks the hold bonus. */
  private beaconPayoutFx(prev: BeaconState, now: number): void {
    this.fx.ring(prev.x, prev.y, 40, BEACON_RADIUS, 650, BEACON_TINT, 0.9);
    this.fx.sparks(prev.x, prev.y, 14, BEACON_TINT, {
      lifeMax: 500,
      lifeMin: 250,
      speedMax: 260,
      speedMin: 80,
    });
    if (prev.controllerId === this.myId) {
      this.gainXp(BEACON_HOLD_BONUS_XP, now);
      this.trauma.add(0.08);
      sfx.play("beacon_active", { rate: 1.4 });
    }
  }

  /** CHARGE: one blip per second, pitch ratcheting up (distance-attenuated). */
  private tickBeaconCharge(b: BeaconState, now: number): void {
    const idx = Math.floor((now - (b.activeAt - BEACON_CHARGE_S * 1000)) / 1000);
    if (idx > this.beaconBlipIdx && idx >= 0) {
      this.beaconBlipIdx = idx;
      sfx.play("beacon_charge", { gain: this.beaconGain(b.x, b.y), rate: 1 + idx * 0.09 });
    }
  }

  private tickBeaconActive(b: BeaconState, now: number): void {
    if (!this.beaconArmedFxDone) {
      // CHARGE → ACTIVE: arena-audible chime + full-ring flash.
      this.beaconArmedFxDone = true;
      sfx.play("beacon_active");
      this.fx.ring(b.x, b.y, BEACON_RADIUS * 0.6, BEACON_RADIUS * 1.2, 500, BEACON_TINT, 0.9);
    }
    if (b.contested && now - this.beaconLastClashAt > 700) {
      this.beaconLastClashAt = now;
      sfx.play("beacon_clash", { gain: this.beaconGain(b.x, b.y) });
    }
    // Trickle: 3 XP per elapsed 1s tick while the host names me sole
    // controller. Tick indices derive from activeAt, so every client counts
    // the same boundaries; capped at 2 per frame-batch (a hidden tab can't
    // claim a backlog it may not have controlled through).
    const tickIdx = Math.floor((now - b.activeAt) / BEACON_TICK_MS);
    if (tickIdx > this.beaconTickIdx) {
      const elapsed = Math.min(tickIdx - this.beaconTickIdx, 2);
      this.beaconTickIdx = tickIdx;
      if (b.controllerId === this.myId && !b.contested && this.alive) {
        this.gainXp(BEACON_XP_PER_TICK * elapsed, now);
        this.fx.converge(this.shipX, this.shipY, 3, 60, 320, BEACON_TINT);
      }
    }
  }

  /**
   * SINGULARITY drag (host-only): for every live pull, point asteroid and
   * enemy velocities at the center. Speed scales down near the center
   * (d/100 clamp) so bodies gather at the point instead of slingshotting
   * through; the dragged velocities ride the normal snapshots, so guests
   * dead-reckon the same motion.
   */
  private hostApplyPulls(now: number): void {
    for (const p of this.world.pulls) {
      if (p.until <= now) {
        continue;
      }
      for (const a of this.world.asteroids) {
        const d = Math.hypot(p.x - a.x, p.y - a.y);
        if (d > SINGULARITY_PULL_RANGE || d < 1) {
          continue;
        }
        const sp = SINGULARITY_PULL_SPEED * Math.min(1, Math.max(0.15, d / 100));
        a.vx = ((p.x - a.x) / d) * sp;
        a.vy = ((p.y - a.y) / d) * sp;
      }
      for (const e of this.world.enemies) {
        const d = Math.hypot(p.x - e.x, p.y - e.y);
        if (d > SINGULARITY_PULL_RANGE || d < 1) {
          continue;
        }
        const sp = SINGULARITY_PULL_SPEED * Math.min(1, Math.max(0.15, d / 100));
        e.vx = ((p.x - e.x) / d) * sp;
        e.vy = ((p.y - e.y) / d) * sp;
      }
    }
  }

  /**
   * MAGNET (host-side: items + shards are host-owned): steer any item within
   * range of a magnet holder toward them at 140 px/s; shards get pulled
   * harder (SHARD_MAGNET_PULL_SPEED); back to drift speed outside.
   * Holders are read from per-player `boosts` state (mine locally).
   */
  private hostMagnetItems(now: number): void {
    const w = this.world;
    if (w.items.length === 0 && w.shards.length === 0) {
      return;
    }
    const holders = this.magnetHolders(now);
    if (holders.length === 0) {
      return;
    }
    for (const it of w.items) {
      magnetPull(it, holders, MAGNET_PULL_SPEED, ITEM_SPEED);
    }
    this.dirty.items = true;
    for (const sd of w.shards) {
      magnetPull(sd, holders, SHARD_MAGNET_PULL_SPEED, SHARD_DRIFT_SPEED);
    }
    this.dirty.shards = true;
  }

  /** Positions of every living ship with a live MAGNET booster. */
  private magnetHolders(now: number): Vec[] {
    const holders: Vec[] = [];
    const mine = this.boosts.get("magnet");
    if (mine !== undefined && mine > now && this.alive && this.spawned) {
      holders.push({ x: this.shipX, y: this.shipY });
    }
    const { myId } = this;
    for (const [id, st] of this.peerStates) {
      if (id === myId) {
        continue;
      }
      if (!st || !st.alive) {
        continue;
      }
      if (st.boosts.some((b) => b.kind === "magnet" && b.until > now)) {
        holders.push({ x: st.x, y: st.y });
      }
    }
    return holders;
  }

  /** Highest level among present players in the local view (default 1 when
   *  unknowable). Drives elite HP stamping at spawn (host) and elite kill XP
   *  (shooter) — qa-018: the same multiplier moves cost and reward together. */
  private maxPresentLevel(): number {
    let max = this.spawned ? this.level : 1;
    const { myId } = this;
    for (const [id, st] of this.peerStates) {
      if (id === myId || !st || !st.present) {
        continue;
      }
      if (st.level > max) {
        max = st.level;
      }
    }
    return Math.max(1, max);
  }

  /** Kill XP for an enemy kind, computed at kill time. Elites pay
   *  round(base × eliteHpMult) so pts-per-second survives the durability
   *  retune; everything else (fodder, sniper, boss) pays the flat spec value.
   *  A Lv1 room pays exactly the pre-retune numbers by construction. */
  private enemyKillXp(kind: EnemyKind): number {
    const base = ENEMY_SPECS[kind].xp;
    if (!ELITE_HP_BASE.has(kind)) {
      return base;
    }
    return Math.round(base * eliteHpMult(this.maxPresentLevel()));
  }

  /** Living player positions (mine locally + remotes from net state). */
  private livingPlayers(): Vec[] {
    const out: Vec[] = [];
    if (this.alive && this.spawned && simNow() >= this.phasedUntil) {
      out.push({ x: this.shipX, y: this.shipY });
    }
    const { myId } = this;
    for (const [id, st] of this.peerStates) {
      if (id === myId) {
        continue;
      }
      if (st && st.alive && !st.shieldMod?.phased) {
        out.push({ x: st.x, y: st.y });
      }
    }
    return out;
  }

  private hostSpawnEnemies(
    now: number,
    tSec: number,
    intensity: number,
    pressure: number,
    wave: number,
    players: Vec[],
  ): void {
    // safe opening
    if (tSec * 1000 < ARENA_SAFE_MS) {
      return;
    }
    if (now < this.debutSuppressUntil) {
      return;
    }
    const w = this.world;
    const early = tSec < EARLY_SPAWN_WINDOW_S;
    if (early && !this.debuted.has("drone") && w.enemies.length === 0 && players.length > 0) {
      this.hostSeedDebutWave(now, players);
      return;
    }
    if (w.enemies.length >= enemyCap(intensity, pressure, wave)) {
      return;
    }
    const interval = early
      ? Math.min(enemySpawnIntervalMs(intensity), EARLY_SPAWN_INTERVAL_MS)
      : enemySpawnIntervalMs(intensity);
    if (now - this.lastEnemySpawnAt < interval) {
      return;
    }
    const pick = this.pickSpawnKind(intensity);
    if (!pick) {
      return;
    }
    const { kind, isDebut } = pick;
    const placed = this.placeEnemySpawn(kind, early, players);
    // skip this tick
    if (!placed) {
      return;
    }
    const e = spawnEnemyState(kind, placed.x, placed.y);
    e.angle = placed.ang;
    // qa-018: elites are stamped to the room's beam-DPS ceiling at spawn (the
    // exact bossHp pattern). Stamped ONCE — leveling never retro-buffs a live
    // elite. Fodder, sniper and the boss keep their spec hp.
    if (ELITE_HP_BASE.has(kind)) {
      e.hp = eliteHp(kind, this.maxPresentLevel());
      e.maxHp = e.hp;
    }
    w.enemies.push(e);
    this.lastEnemySpawnAt = now;
    this.dirty.enemies = true;
    if (isDebut) {
      this.debuted.add(kind);
      this.debutSuppressUntil = now + ENEMY_DEBUT_SUPPRESS_MS;
    }
  }

  /** Early debut wave: the moment the safe opening ends, seed a few drones in
   *  the convergence ring at once so the arena's first threats are already
   *  visibly inbound. This IS the drone debut (suppression follows as usual). */
  private hostSeedDebutWave(now: number, players: Vec[]): void {
    const w = this.world;
    for (let i = 0; i < EARLY_FODDER_SEED_COUNT; i += 1) {
      const placed = this.ringPlacementNear(players, EARLY_SEED_RING_MAX);
      if (!placed) {
        break;
      }
      const e = spawnEnemyState("drone", placed.x, placed.y);
      e.angle = placed.ang;
      w.enemies.push(e);
    }
    this.debuted.add("drone");
    this.debutSuppressUntil = now + ENEMY_DEBUT_SUPPRESS_MS;
    this.lastEnemySpawnAt = now;
    this.dirty.enemies = true;
  }

  /** Debut rule: a type's first appearance is solo + suppresses other spawns;
   *  otherwise a weighted roll over the kinds live at this intensity. */
  private pickSpawnKind(intensity: number): { kind: EnemyKind; isDebut: boolean } | null {
    const avail = ENEMY_KINDS.filter((k) => enemySpawnWeight(k, intensity) > 0);
    if (avail.length === 0) {
      return null;
    }
    const debut = avail.find((k) => !this.debuted.has(k));
    if (debut) {
      return { isDebut: true, kind: debut };
    }
    const kind = weightedEnemyRoll(avail, intensity);
    return kind ? { isDebut: false, kind } : null;
  }

  /** Where a fresh spawn lands: early-window fodder converges via the ring
   *  outside a player's viewport; a live BEACON lures half of spawns onto a
   *  ring around it (bias only — caps, weights and intervals are untouched);
   *  everything else takes the far edge entrance. */
  private placeEnemySpawn(
    kind: EnemyKind,
    early: boolean,
    players: Vec[],
  ): { x: number; y: number; ang: number } | null {
    const w = this.world;
    let placed: { x: number; y: number; ang: number } | null = null;
    if (early && EARLY_FODDER_KINDS.includes(kind) && players.length > 0) {
      placed = this.ringPlacementNear(players);
    }
    const { beacon } = w;
    if (!placed && beacon && rand() < BEACON_LURE_FRACTION) {
      const ang = rand() * Math.PI * 2;
      const r = BEACON_LURE_RING_MIN + rand() * (BEACON_LURE_RING_MAX - BEACON_LURE_RING_MIN);
      const x = PhaserMath.Clamp(beacon.x + Math.cos(ang) * r, 30, w.playW - 30);
      const y = PhaserMath.Clamp(beacon.y + Math.sin(ang) * r, 30, w.playH - 30);
      const clear = players.every((p) => Math.hypot(p.x - x, p.y - y) >= ENEMY_SPAWN_CLEARANCE);
      if (clear) {
        placed = { ang: Math.atan2(beacon.y - y, beacon.x - x), x, y };
      }
    }
    for (let i = 0; i < 5 && !placed; i += 1) {
      const c = edgeSpawn(30, w.playW, w.playH);
      const clear = players.every((p) => Math.hypot(p.x - c.x, p.y - c.y) >= ENEMY_SPAWN_CLEARANCE);
      if (clear) {
        placed = c;
      }
    }
    return placed;
  }

  /** A clear point in the early-onslaught ring [ENEMY_SPAWN_CLEARANCE ..
   *  maxR] around a random living player, aimed at them.
   *  Null when clamping keeps violating clearance (caller falls back / skips). */
  private ringPlacementNear(
    players: Vec[],
    maxR = EARLY_SPAWN_RING_MAX,
  ): { x: number; y: number; ang: number } | null {
    for (let i = 0; i < 8; i += 1) {
      const anchor = players[Math.floor(rand() * players.length)];
      if (!anchor) {
        return null;
      }
      const c = ringSpawnPoint(
        anchor.x,
        anchor.y,
        ENEMY_SPAWN_CLEARANCE,
        maxR,
        this.world.playW,
        this.world.playH,
      );
      const clear = players.every((p) => Math.hypot(p.x - c.x, p.y - c.y) >= ENEMY_SPAWN_CLEARANCE);
      if (clear) {
        return c;
      }
    }
    return null;
  }

  private simFor(id: string): EnemySim {
    let sim = this.enemySim.get(id);
    if (!sim) {
      sim = {
        bossPhaseFloorUntil: 0,
        bossPhaseSeen: 0,
        broodCount: 0,
        broodParent: null,
        burstLeft: 0,
        fireAt: 0,
        kbVx: 0,
        kbVy: 0,
        lancerPhase: "cruise",
        nextAttackAt: 0,
        nextBurstShotAt: 0,
        orbitDir: rand() < 0.5 ? 1 : -1,
        phaseUntil: 0,
        wobblePhase: rand() * Math.PI * 2,
      };
      this.enemySim.set(id, sim);
    }
    return sim;
  }

  private hostSpawnShot(enemy: EnemyState, angle: number, speed: number, now: number): void {
    enemy.attackAt = now;
    this.dirty.enemies = true;
    this.world.enemyShots.push({
      diesAt: now + ENEMY_SHOT_TTL_MS,
      id: entityId(),
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      x: enemy.x,
      y: enemy.y,
    });
    this.dirty.enemyShots = true;
  }

  /** Host AI: steering, telegraphs and firing for every enemy (§6.1). */
  private hostSimEnemies(now: number, dt: number, players: Vec[]): void {
    for (const e of this.world.enemies) {
      const sim = this.simFor(e.id);
      // Knockback decays independently of steering (≈ gone in a second).
      const kbDecay = Math.exp(-4 * dt);
      sim.kbVx *= kbDecay;
      sim.kbVy *= kbDecay;
      const target = this.enemyTarget(e, players);
      if (!target) {
        e.vx *= Math.exp(-1 * dt);
        e.vy *= Math.exp(-1 * dt);
        continue;
      }
      const dx = target.x - e.x;
      const dy = target.y - e.y;
      const dist = Math.hypot(dx, dy) || 1;
      const aim: EnemyAim = { desired: Math.atan2(dy, dx), dist, dx, dy, target };
      this.simEnemyKind(e, sim, aim, players, now, dt);
      // Steering set vx/vy absolutely — ride the decaying knockback on top.
      // LANCER (mid-charge) and the BOSS own their velocity directly.
      if (e.kind !== "lancer" && e.kind !== "dreadnought") {
        e.vx += sim.kbVx;
        e.vy += sim.kbVy;
      }
    }
    // Garbage-collect sims for enemies that no longer exist.
    if (this.enemySim.size > this.world.enemies.length + 8) {
      const live = new Set(this.world.enemies.map((e) => e.id));
      for (const id of this.enemySim.keys()) {
        if (!live.has(id)) {
          this.enemySim.delete(id);
        }
      }
    }
  }

  /** Nearest living player — except fodder near a BEACON, which steers for
   *  the zone's center instead (nearest-of semantics, so a player inside the
   *  zone is closer and wins). */
  private enemyTarget(e: EnemyState, players: Vec[]): Vec | null {
    const target = nearestOf(players, e.x, e.y);
    const { beacon } = this.world;
    if (beacon && (e.kind === "drone" || e.kind === "wasp")) {
      const bd = Math.hypot(beacon.x - e.x, beacon.y - e.y);
      if (
        bd < BEACON_RETARGET_RANGE &&
        (!target || bd < Math.hypot(target.x - e.x, target.y - e.y))
      ) {
        return { x: beacon.x, y: beacon.y };
      }
    }
    return target;
  }

  private simEnemyKind(
    e: EnemyState,
    sim: EnemySim,
    aim: EnemyAim,
    players: Vec[],
    now: number,
    dt: number,
  ): void {
    switch (e.kind) {
      case "drone": {
        this.simDrone(e, sim, aim, now, dt);
        break;
      }
      case "wasp": {
        this.simWasp(e, sim, aim, now);
        break;
      }
      case "lancer": {
        this.simLancer(e, sim, aim, now, dt);
        break;
      }
      case "splitter": {
        e.angle = rotateToward(e.angle, aim.desired, 60 * DEG * dt);
        e.vx = Math.cos(e.angle) * SPLITTER_SPEED;
        e.vy = Math.sin(e.angle) * SPLITTER_SPEED;
        break;
      }
      case "warden": {
        this.simWarden(e, sim, aim, now, dt);
        break;
      }
      case "sniper": {
        this.simSniper(e, sim, aim, now);
        break;
      }
      case "spawner": {
        this.simSpawner(e, sim, aim, now, dt);
        break;
      }
      case "dreadnought": {
        this.hostSimBoss(e, sim, players, aim.desired, now, dt);
        break;
      }
      default: {
        e.kind satisfies never;
      }
    }
  }

  private simDrone(e: EnemyState, sim: EnemySim, aim: EnemyAim, now: number, dt: number): void {
    const { desired, dist } = aim;
    e.angle = rotateToward(e.angle, desired, DRONE_TURN_DEG_PER_S * DEG * dt);
    e.vx = Math.cos(e.angle) * DRONE_SPEED;
    e.vy = Math.sin(e.angle) * DRONE_SPEED;
    if (sim.fireAt > 0) {
      if (now >= sim.fireAt) {
        sim.fireAt = 0;
        sim.nextAttackAt = now + DRONE_COOLDOWN_MS;
        if (dist < ENEMY_FIRE_RANGE) {
          this.hostSpawnShot(e, desired, DRONE_SHOT_SPEED, now);
        }
      }
    } else if (
      now >= sim.nextAttackAt &&
      e.graceUntil <= now &&
      dist < ENEMY_FIRE_RANGE &&
      Math.abs(wrapAngle(desired - e.angle)) < DRONE_FIRE_CONE_DEG * DEG
    ) {
      e.telegraphUntil = now + DRONE_TELEGRAPH_MS;
      sim.fireAt = e.telegraphUntil;
    }
  }

  private simWasp(e: EnemyState, sim: EnemySim, aim: EnemyAim, now: number): void {
    const { desired, dist, dx, dy } = aim;
    e.angle = desired;
    if (dist > WASP_ORBIT_RADIUS + 80) {
      e.vx = (dx / dist) * WASP_SPEED;
      e.vy = (dy / dist) * WASP_SPEED;
    } else {
      // Perpendicular strafe around the orbit ring + sin wobble.
      const wobble =
        Math.sin((now / 1000) * WASP_WOBBLE_HZ * Math.PI * 2 + sim.wobblePhase) * WASP_WOBBLE_AMP;
      const radialErr = dist - (WASP_ORBIT_RADIUS + wobble);
      const inX = dx / dist;
      const inY = dy / dist;
      let mx = -inY * sim.orbitDir + inX * PhaserMath.Clamp(radialErr / 80, -1, 1);
      let my = inX * sim.orbitDir + inY * PhaserMath.Clamp(radialErr / 80, -1, 1);
      const mlen = Math.hypot(mx, my) || 1;
      mx /= mlen;
      my /= mlen;
      e.vx = mx * WASP_SPEED;
      e.vy = my * WASP_SPEED;
    }
    if (sim.burstLeft > 0) {
      if (now >= sim.nextBurstShotAt) {
        this.hostSpawnShot(e, desired, WASP_SHOT_SPEED, now);
        sim.burstLeft -= 1;
        sim.nextBurstShotAt = now + WASP_BURST_GAP_MS;
        if (sim.burstLeft === 0) {
          sim.nextAttackAt = now + WASP_COOLDOWN_MS;
        }
      }
    } else if (sim.fireAt > 0) {
      if (now >= sim.fireAt) {
        sim.fireAt = 0;
        sim.burstLeft = WASP_BURST_COUNT;
        sim.nextBurstShotAt = now;
      }
    } else if (now >= sim.nextAttackAt && dist < ENEMY_FIRE_RANGE) {
      e.telegraphUntil = now + WASP_TELEGRAPH_MS;
      sim.fireAt = e.telegraphUntil;
    }
  }

  private simLancer(e: EnemyState, sim: EnemySim, aim: EnemyAim, now: number, dt: number): void {
    const { desired, dist } = aim;
    switch (sim.lancerPhase) {
      case "cruise": {
        e.angle = rotateToward(e.angle, desired, 120 * DEG * dt);
        e.vx = Math.cos(e.angle) * LANCER_CRUISE_SPEED;
        e.vy = Math.sin(e.angle) * LANCER_CRUISE_SPEED;
        if (dist < LANCER_CHARGE_RANGE + 80 && now >= sim.nextAttackAt) {
          sim.lancerPhase = "windup";
          sim.phaseUntil = now + LANCER_WINDUP_MS;
          e.telegraphUntil = sim.phaseUntil;
          // the locked charge vector
          e.angle = desired;
          e.vx = 0;
          e.vy = 0;
        }
        break;
      }
      case "windup": {
        if (now >= sim.phaseUntil) {
          sim.lancerPhase = "charge";
          sim.phaseUntil = now + LANCER_CHARGE_MS;
          e.chargeUntil = sim.phaseUntil;
          e.vx = Math.cos(e.angle) * LANCER_CHARGE_SPEED;
          e.vy = Math.sin(e.angle) * LANCER_CHARGE_SPEED;
        }
        break;
      }
      case "charge": {
        // Locked vector — it can't turn while charging.
        if (
          now >= sim.phaseUntil ||
          e.x <= 0 ||
          e.x >= this.world.playW ||
          e.y <= 0 ||
          e.y >= this.world.playH
        ) {
          sim.lancerPhase = "recover";
          sim.phaseUntil = now + LANCER_RECOVER_MS;
          e.chargeUntil = 0;
        }
        break;
      }
      case "recover": {
        const decay = Math.exp(-3 * dt);
        e.vx *= decay;
        e.vy *= decay;
        if (now >= sim.phaseUntil) {
          sim.lancerPhase = "cruise";
          // recovery IS the cooldown
          sim.nextAttackAt = now;
        }
        break;
      }
      default: {
        sim.lancerPhase satisfies never;
      }
    }
  }

  /** Slow advance. Shield up except during the post-mortar vent window. */
  private simWarden(e: EnemyState, sim: EnemySim, aim: EnemyAim, now: number, dt: number): void {
    const { desired, dist } = aim;
    e.angle = rotateToward(e.angle, desired, WARDEN_TURN_DEG_PER_S * DEG * dt);
    e.vx = Math.cos(e.angle) * WARDEN_SPEED;
    e.vy = Math.sin(e.angle) * WARDEN_SPEED;
    if (sim.fireAt > 0) {
      if (now >= sim.fireAt) {
        sim.fireAt = 0;
        // vent: shield down
        sim.nextBurstShotAt = now + WARDEN_VENT_MS;
        sim.nextAttackAt = now + WARDEN_COOLDOWN_MS;
        e.shielded = false;
        if (dist < WARDEN_FIRE_RANGE) {
          this.hostSpawnShot(e, desired, WARDEN_SHOT_SPEED, now);
        }
      }
    } else if (now < sim.nextBurstShotAt) {
      // venting
      e.shielded = false;
    } else if (now >= sim.nextAttackAt && dist < WARDEN_FIRE_RANGE) {
      e.telegraphUntil = now + WARDEN_TELEGRAPH_MS;
      sim.fireAt = e.telegraphUntil;
      // shield up through the windup
      e.shielded = true;
    } else {
      e.shielded = true;
    }
  }

  /** Kite to keep distance; charge a laser sight; fire one fast bolt. */
  private simSniper(e: EnemyState, sim: EnemySim, aim: EnemyAim, now: number): void {
    const { desired, dist, dx, dy, target } = aim;
    e.angle = desired;
    const err = dist - SNIPER_KEEP_DIST;
    if (Math.abs(err) > 40) {
      // in if too far, out if too close
      const sgn = err > 0 ? 1 : -1;
      e.vx = (dx / dist) * SNIPER_SPEED * sgn;
      e.vy = (dy / dist) * SNIPER_SPEED * sgn;
    } else {
      // strafe at range
      e.vx = -(dy / dist) * SNIPER_SPEED * sim.orbitDir;
      e.vy = (dx / dist) * SNIPER_SPEED * sim.orbitDir;
    }
    if (sim.fireAt > 0) {
      if (now >= sim.fireAt) {
        sim.fireAt = 0;
        sim.nextAttackAt = now + SNIPER_COOLDOWN_MS;
        const [lance] = e.lances;
        e.lances = [];
        if (lance && dist < SNIPER_FIRE_RANGE) {
          this.hostSpawnShot(e, Math.atan2(lance.y - e.y, lance.x - e.x), SNIPER_SHOT_SPEED, now);
        }
      } else {
        // plant while aiming
        e.vx *= 0.2;
        e.vy *= 0.2;
      }
    } else if (now >= sim.nextAttackAt && dist < SNIPER_FIRE_RANGE) {
      e.telegraphUntil = now + SNIPER_AIM_MS;
      sim.fireAt = e.telegraphUntil;
      // lock current pos (no lead)
      e.lances = [{ x: target.x, y: target.y }];
    }
  }

  /** Drift slowly; birth a brood on a telegraphed pulse, self-capped. */
  private simSpawner(e: EnemyState, sim: EnemySim, aim: EnemyAim, now: number, dt: number): void {
    e.angle = rotateToward(e.angle, aim.desired, 30 * DEG * dt);
    e.vx = Math.cos(e.angle) * SPAWNER_SPEED;
    e.vy = Math.sin(e.angle) * SPAWNER_SPEED;
    if (sim.fireAt > 0) {
      if (now >= sim.fireAt) {
        sim.fireAt = 0;
        sim.nextAttackAt = now + SPAWNER_PULSE_MS;
        this.hostBirthMites(e, SPAWNER_BROOD_PER_PULSE, now);
      }
    } else if (now >= sim.nextAttackAt && sim.broodCount < SPAWNER_BROOD_CAP) {
      e.telegraphUntil = now + SPAWNER_TELEGRAPH_MS;
      sim.fireAt = e.telegraphUntil;
    }
  }

  /**
   * Breather rule: when the live count runs past the (intensity-trough) cap by
   * more than the slack — splitter children bypass the cap — quietly despawn
   * the enemy farthest from all living players: no loot, no score, only if
   * it's beyond ENEMY_DESPAWN_MIN_DIST from everyone, max one per interval.
   */
  private hostDespawnBreather(
    now: number,
    intensity: number,
    pressure: number,
    wave: number,
    players: Vec[],
  ): void {
    const w = this.world;
    if (w.enemies.length <= enemyCap(intensity, pressure, wave) + ENEMY_DESPAWN_SLACK) {
      return;
    }
    if (now - this.lastBreatherDespawnAt < ENEMY_DESPAWN_INTERVAL_MS) {
      return;
    }
    let farIdx = -1;
    let farDist = -1;
    for (let i = 0; i < w.enemies.length; i += 1) {
      const e = w.enemies[i];
      if (!e) {
        continue;
      }
      // the boss is never auto-despawned
      if (e.kind === "dreadnought") {
        continue;
      }
      let minD = Infinity;
      for (const p of players) {
        minD = Math.min(minD, Math.hypot(e.x - p.x, e.y - p.y));
      }
      if (minD > farDist) {
        farDist = minD;
        farIdx = i;
      }
    }
    if (farIdx === -1 || farDist <= ENEMY_DESPAWN_MIN_DIST) {
      return;
    }
    const e = w.enemies[farIdx];
    if (!e) {
      return;
    }
    w.enemies.splice(farIdx, 1);
    this.enemySim.delete(e.id);
    this.lastBreatherDespawnAt = now;
    this.dirty.enemies = true;
  }

  private hostDamageAsteroid(id: string, damage: number): void {
    const w = this.world;
    const idx = w.asteroids.findIndex((a) => a.id === id);
    if (idx === -1) {
      return;
    }
    const a = w.asteroids[idx];
    if (!a) {
      return;
    }
    if (asteroidDestroyedBy(a.radius, damage)) {
      // display sweep bursts it
      w.asteroids.splice(idx, 1);
      // v3: rocks shed shards scaled by size (~r/15, 1..5) + an 11% item roll
      // (pure chance: asteroid rolls never feed or force pity).
      this.hostSpawnShards(a.x, a.y, asteroidShardCount(a.radius));
      this.hostRollLoot(a.x, a.y, ASTEROID_DROP_CHANCE, false);
    } else {
      // Radius shrink scales the drawn outline automatically (unit verts are
      // derived from the id and multiplied by radius) — no shape pop.
      const newRadius = a.radius - ASTEROID_MAX_RADIUS * Math.min(damage, 1);
      a.radius = newRadius;
      const ang = Math.atan2(a.vy, a.vx) + (rand() * 60 - 30) * DEG;
      const speed = asteroidSpeed(newRadius);
      a.vx = Math.cos(ang) * speed;
      a.vy = Math.sin(ang) * speed;
    }
    this.dirty.asteroids = true;
  }

  private hostDamageUfo(damage: number): void {
    const u = this.world.ufo;
    if (!u) {
      return;
    }
    u.hp -= damage * 100;
    u.blinkUntil = simNow() + UFO_BLINK_MS;
    if (u.hp <= 0) {
      this.world.items.push(spawnWeaponItemState(u.x, u.y));
      this.world.ufo = null;
      this.dirty.items = true;
    }
    this.dirty.ufo = true;
  }

  /** DREADNOUGHT boss AI: HP-derived 3-phase pattern. Owns its own velocity. */
  private hostSimBoss(
    e: EnemyState,
    sim: EnemySim,
    players: Vec[],
    desired: number,
    now: number,
    dt: number,
  ): void {
    const phase = bossPhase(e.hp, e.maxHp);
    // turret faces nearest
    e.angle = rotateToward(e.angle, desired, 60 * DEG * dt);
    // Centroid of the living crowd (the boss orbits the group, not one ship).
    let cx = 0;
    let cy = 0;
    for (const p of players) {
      cx += p.x;
      cy += p.y;
    }
    if (players.length > 0) {
      cx /= players.length;
      cy /= players.length;
    }
    const dC = Math.hypot(cx - e.x, cy - e.y) || 1;
    const inX = (cx - e.x) / dC;
    const inY = (cy - e.y) / dC;
    if (phase === 1) {
      this.simBossPhase1(e, sim, desired, dC, inX, inY, now);
    } else if (phase === 2) {
      this.simBossPhase2(e, sim, players, inX, inY, now);
    } else {
      this.simBossPhase3(e, sim, now, dt);
    }
  }

  /** Phase 1: orbit at BOSS_ORBIT_RADIUS, broadside a spread fan. */
  private simBossPhase1(
    e: EnemyState,
    sim: EnemySim,
    desired: number,
    dC: number,
    inX: number,
    inY: number,
    now: number,
  ): void {
    const radial = PhaserMath.Clamp((dC - BOSS_ORBIT_RADIUS) / 200, -1, 1);
    const mx = -inY * sim.orbitDir + inX * radial;
    const my = inX * sim.orbitDir + inY * radial;
    const ml = Math.hypot(mx, my) || 1;
    e.vx = (mx / ml) * BOSS_SPEED;
    e.vy = (my / ml) * BOSS_SPEED;
    if (sim.fireAt > 0) {
      if (now >= sim.fireAt) {
        sim.fireAt = 0;
        sim.nextAttackAt = now + BOSS_P1_CYCLE_MS;
        const base = desired - (BOSS_P1_SPREAD_DEG * DEG) / 2;
        const step = (BOSS_P1_SPREAD_DEG * DEG) / (BOSS_P1_SPREAD_COUNT - 1);
        for (let i = 0; i < BOSS_P1_SPREAD_COUNT; i += 1) {
          this.hostSpawnShot(e, base + step * i, BOSS_SHOT_SPEED, now);
        }
      }
    } else if (now >= sim.nextAttackAt) {
      e.telegraphUntil = now + BOSS_P1_TELEGRAPH_MS;
      sim.fireAt = e.telegraphUntil;
    }
  }

  /** Phase 2: strafe faster; lock + fire triple sniper-speed lances at the
   *  nearest players. */
  private simBossPhase2(
    e: EnemyState,
    sim: EnemySim,
    players: Vec[],
    inX: number,
    inY: number,
    now: number,
  ): void {
    e.vx = -inY * BOSS_SPEED * 1.4 * sim.orbitDir;
    e.vy = inX * BOSS_SPEED * 1.4 * sim.orbitDir;
    if (sim.fireAt > 0) {
      if (now >= sim.fireAt) {
        sim.fireAt = 0;
        sim.nextAttackAt = now + BOSS_P2_CYCLE_MS;
        for (const aim of e.lances) {
          this.hostSpawnShot(
            e,
            Math.atan2(aim.y - e.y, aim.x - e.x),
            // distinct speed → BOSS_LANCE damage (70), not sniper 55
            BOSS_LANCE_SHOT_SPEED,
            now,
          );
        }
        e.lances = [];
      }
    } else if (now >= sim.nextAttackAt) {
      e.lances = nearestPlayers(players, e, BOSS_P2_LANCES);
      e.telegraphUntil = now + BOSS_P2_AIM_MS;
      sim.fireAt = e.telegraphUntil;
    }
  }

  /** Phase 3 enrage: plant, vent a radial nova + birth a mite wave. */
  private simBossPhase3(e: EnemyState, sim: EnemySim, now: number, dt: number): void {
    e.vx *= Math.exp(-3 * dt);
    e.vy *= Math.exp(-3 * dt);
    if (sim.fireAt > 0) {
      if (now >= sim.fireAt) {
        sim.fireAt = 0;
        sim.nextAttackAt = now + BOSS_P3_CYCLE_MS;
        for (let i = 0; i < BOSS_P3_NOVA_COUNT; i += 1) {
          this.hostSpawnShot(e, (Math.PI * 2 * i) / BOSS_P3_NOVA_COUNT, BOSS_SHOT_SPEED, now);
        }
        // Cap the brood so a long phase-3 can't balloon enemies[] unbounded.
        if (sim.broodCount < BOSS_BROOD_CAP) {
          this.hostBirthMites(e, BOSS_P3_MITES, now);
        }
      }
    } else if (now >= sim.nextAttackAt) {
      e.telegraphUntil = now + BOSS_P3_TELEGRAPH_MS;
      sim.fireAt = e.telegraphUntil;
    }
  }

  /** SPAWNER / BOSS: birth `n` mites (grace'd drones) around the parent. They
   *  bypass enemyCap like splitter children; broodCount self-caps the spawner. */
  private hostBirthMites(parent: EnemyState, n: number, now: number): void {
    const w = this.world;
    const psim = this.simFor(parent.id);
    if (n > 0) {
      parent.attackAt = now;
    }
    for (let i = 0; i < n; i += 1) {
      const ang = parent.angle + (Math.PI * 2 * i) / Math.max(1, n) + rand() * 0.4;
      const m = spawnEnemyState(
        "drone",
        parent.x + Math.cos(ang) * 18,
        parent.y + Math.sin(ang) * 18,
      );
      m.angle = ang;
      m.vx = Math.cos(ang) * SPLITTER_CHILD_SPEED;
      m.vy = Math.sin(ang) * SPLITTER_CHILD_SPEED;
      m.graceUntil = now + MITE_GRACE_MS;
      const msim = this.simFor(m.id);
      msim.nextAttackAt = m.graceUntil + 400;
      msim.broodParent = parent.id;
      w.enemies.push(m);
      psim.broodCount += 1;
    }
    this.dirty.enemies = true;
  }

  /** Boss spawn trigger: near a wave peak, in a busy room (or after the cooldown
   *  in a quiet one). One boss arena-wide. Called each host tick. */
  private hostMaybeSpawnBoss(now: number, intensity: number, players: Vec[]): void {
    const w = this.world;
    // Recompute from the world so a migrated host adopts the flag.
    this.bossAlive = w.enemies.some((e) => e.kind === "dreadnought");
    if (this.bossAlive) {
      return;
    }
    // dir-006 guaranteed sector boss: at sector-relative 405s a sector with no
    // dreadnought spawn yet force-spawns one — bypassing the intensity/
    // cooldown/busy gates but keeping edge placement + spawn clearance.
    // ADDITIVE: the organic gates below are byte-identical to a0c0272.
    // w.sectorBossIdx (host-written, on the wire) marks the satisfied sector,
    // so a migrated host never double-guarantees; a boss spilling across a
    // boundary keeps the NEW sector's guarantee waived via the bossAlive
    // early-return above — once it dies, this rel-405 check applies normally.
    const tSec = Math.max(0, (now - w.arenaEpoch) / 1000);
    const sIdx = sectorIdx(tSec);
    if (sectorRelT(tSec) >= SECTOR_BOSS_AT_S && w.sectorBossIdx < sIdx && players.length > 0) {
      if (this.hostForceSpawnBoss(players)) {
        w.sectorBossIdx = sIdx;
      }
      // placement failure retries next tick; organic gates don't apply
      return;
    }
    if (intensity < BOSS_SPAWN_INTENSITY) {
      return;
    }
    if (this.lastBossKilledAt !== 0 && now - this.lastBossKilledAt < BOSS_SPAWN_COOLDOWN_MS) {
      return;
    }
    // never spawn a boss with nobody to fight it
    if (players.length === 0) {
      return;
    }
    const busy = Object.keys(this.peers).length >= BOSS_SPAWN_MIN_PLAYERS;
    // Quiet rooms only get one once the cooldown has fully elapsed since the last.
    if (!busy && this.lastBossKilledAt === 0 && now < BOSS_SPAWN_COOLDOWN_MS) {
      return;
    }
    let placed: { x: number; y: number; ang: number } | null = null;
    for (let i = 0; i < 8 && !placed; i += 1) {
      const c = edgeSpawn(30, this.world.playW, this.world.playH);
      if (players.every((p) => Math.hypot(p.x - c.x, p.y - c.y) >= ENEMY_SPAWN_CLEARANCE)) {
        placed = c;
      }
    }
    if (!placed) {
      return;
    }
    const e = spawnEnemyState("dreadnought", placed.x, placed.y);
    e.angle = placed.ang;
    e.hp = bossHp(Math.max(1, Object.keys(this.peers).length));
    e.maxHp = e.hp;
    w.enemies.push(e);
    this.bossAlive = true;
    this.dirty.enemies = true;
    // dir-006: ANY dreadnought spawn (organic or forced) satisfies the
    // sector's guarantee — an organic rel-214 boss means rel-405 no-ops.
    w.sectorBossIdx = sIdx;
  }

  /** dir-006: edge-place + spawn the guaranteed sector dreadnought. Same
   *  placement + stat block as the organic path above — deliberately
   *  duplicated (not extracted) so the organic block stays byte-identical
   *  for diff inspection (spec criterion 6). */
  private hostForceSpawnBoss(players: Vec[]): boolean {
    const w = this.world;
    let placed: { x: number; y: number; ang: number } | null = null;
    for (let i = 0; i < 8 && !placed; i += 1) {
      const c = edgeSpawn(30, w.playW, w.playH);
      if (players.every((p) => Math.hypot(p.x - c.x, p.y - c.y) >= ENEMY_SPAWN_CLEARANCE)) {
        placed = c;
      }
    }
    if (!placed) {
      return false;
    }
    const e = spawnEnemyState("dreadnought", placed.x, placed.y);
    e.angle = placed.ang;
    e.hp = bossHp(Math.max(1, Object.keys(this.peers).length));
    e.maxHp = e.hp;
    w.enemies.push(e);
    this.bossAlive = true;
    this.dirty.enemies = true;
    return true;
  }

  /** Apply reported damage + knockback; kill (split, loot) at ≤0 HP. */
  private hostDamageEnemy(id: string, damageHp: number, kx: number, ky: number): void {
    const w = this.world;
    const idx = w.enemies.findIndex((e) => e.id === id);
    if (idx === -1) {
      return;
    }
    const e = w.enemies[idx];
    if (!e) {
      return;
    }
    // WARDEN: heavy damage reduction while shielded; extra during the vent window.
    let dmg = damageHp;
    if (e.kind === "warden") {
      dmg *= e.shielded ? WARDEN_SHIELDED_DR : WARDEN_VENT_DR;
    }
    if (e.kind === "dreadnought") {
      // qa-009 per-phase duration floor: while the current phase is younger
      // than BOSS_PHASE_MIN_MS, damage can't cross its lower HP boundary
      // (phase 3's boundary = death). Once the window has run, one hit can
      // still only reach the TOP of the next phase — so no phase is ever
      // skipped outright, even by stacked specials in a full room.
      const sim = this.simFor(e.id);
      const now = simNow();
      const phase = bossPhase(e.hp, e.maxHp);
      if (sim.bossPhaseSeen !== phase) {
        sim.bossPhaseSeen = phase;
        sim.bossPhaseFloorUntil = now + BOSS_PHASE_MIN_MS;
      }
      const held = now < sim.bossPhaseFloorUntil;
      e.hp -= dmg;
      const floorHp = bossHpFloor(phase, held, e.maxHp);
      if (e.hp < floorHp) {
        e.hp = floorHp;
      }
      // qa-017: anchor the next phase's window AT the crossing hit. Without
      // this, the window only starts when a later hit's pre-damage read
      // observes the new phase — so a boss left at 1 HP mid-burst would
      // shrug the killing blow for a fresh 8s from whenever fire resumes.
      const phaseAfter = bossPhase(e.hp, e.maxHp);
      if (sim.bossPhaseSeen !== phaseAfter) {
        sim.bossPhaseSeen = phaseAfter;
        sim.bossPhaseFloorUntil = now + BOSS_PHASE_MIN_MS;
      }
    } else {
      e.hp -= dmg;
    }
    // LANCER's phases persist vx/vy, so direct knockback works; the others get
    // steering-overwritten every sim tick, so the impulse lives in the sim.
    // The boss owns its velocity too — don't let beams shove it off its orbit.
    if (e.kind === "lancer") {
      e.vx += kx;
      e.vy += ky;
    } else if (e.kind === "dreadnought") {
      // no knockback
    } else {
      const sim = this.simFor(e.id);
      sim.kbVx += kx;
      sim.kbVy += ky;
    }
    e.blinkUntil = simNow() + UFO_BLINK_MS;
    if (e.hp <= 0) {
      this.hostKillEnemy(idx);
    }
    this.dirty.enemies = true;
  }

  private hostKillEnemy(idx: number): void {
    const w = this.world;
    const e = w.enemies[idx];
    if (!e) {
      return;
    }
    // A dying mite frees a slot in its parent's brood cap.
    const broodParent = this.enemySim.get(e.id)?.broodParent;
    if (broodParent) {
      const psim = this.enemySim.get(broodParent);
      if (psim) {
        psim.broodCount = Math.max(0, psim.broodCount - 1);
      }
    }
    w.enemies.splice(idx, 1);
    this.enemySim.delete(e.id);
    const now = simNow();
    if (e.kind === "dreadnought") {
      // Marquee reward: an XP fountain (past SHARDS_MAX_LIVE the oldest
      // shards on the field splice out — hostSpawnShards — so the burst
      // itself always lands whole) + two guaranteed drops. Free the
      // arena-wide slot + arm the cooldown.
      this.hostSpawnShards(e.x, e.y, BOSS_REWARD_SHARDS);
      this.hostRollLoot(e.x, e.y, 1, true);
      this.hostRollLoot(e.x, e.y, 1, true);
      this.bossAlive = false;
      this.lastBossKilledAt = now;
      this.dirty.enemies = true;
      return;
    }
    if (e.kind === "splitter") {
      // Death is the attack: 3 drones pop outward, briefly harmless.
      for (let i = 0; i < SPLITTER_CHILDREN; i += 1) {
        const ang = e.angle + (Math.PI * 2 * i) / SPLITTER_CHILDREN;
        const child = spawnEnemyState("drone", e.x + Math.cos(ang) * 10, e.y + Math.sin(ang) * 10);
        child.angle = ang;
        child.vx = Math.cos(ang) * SPLITTER_CHILD_SPEED;
        child.vy = Math.sin(ang) * SPLITTER_CHILD_SPEED;
        child.graceUntil = now + SPLITTER_GRACE_MS;
        const sim = this.simFor(child.id);
        sim.nextAttackAt = child.graceUntil + 400;
        // children bypass the cap
        w.enemies.push(child);
      }
    }
    // v3 universal drops: fodder always sheds 1-2 score shards + a 18% item
    // roll; elites (lancer/splitter) drop a guaranteed item. UFO stays the
    // guaranteed-weapon pinata in hostDamageUfo.
    if (e.kind === "drone" || e.kind === "wasp") {
      this.hostSpawnShards(
        e.x,
        e.y,
        FODDER_SHARD_MIN + Math.floor(rand() * (FODDER_SHARD_MAX - FODDER_SHARD_MIN + 1)),
      );
      this.hostRollLoot(e.x, e.y, FODDER_DROP_CHANCE, true);
    } else {
      this.hostRollLoot(e.x, e.y, 1, true);
    }
    this.dirty.enemies = true;
  }

  /** Spawn `count` score shards at (x,y); oldest culled past the hard cap so
   *  a swarm wipe can't flood the wire (separate array; ITEMS_MAX_LIVE
   *  untouched). */
  private hostSpawnShards(x: number, y: number, count: number): void {
    const w = this.world;
    for (let i = 0; i < count; i += 1) {
      w.shards.push(spawnShardState(x, y));
    }
    if (w.shards.length > SHARDS_MAX_LIVE) {
      w.shards.splice(0, w.shards.length - SHARDS_MAX_LIVE);
    }
    this.dirty.shards = true;
  }

  /**
   * Hierarchical loot roll, v3: a per-source `chance` gates the drop (fodder
   * 18%, elites 1.0, asteroids 11%), then the class split (with per-class
   * pity when `feedPity`: enemy kills only, asteroid rolls never feed or
   * force pity) -> child table. Skipped past ITEMS_MAX_LIVE (the dry streak
   * still accrues pity); UFO drops bypass the cap.
   */
  /** `bypassCap` (UFO-drop precedent): a GUARANTEED payout — the beacon hold
   *  crystal — must never be silently skipped by the in-flight item cap. */
  private hostRollLoot(
    x: number,
    y: number,
    chance: number,
    feedPity: boolean,
    bypassCap = false,
  ): void {
    const w = this.world;
    const bumpAll = (): void => {
      if (!feedPity) {
        return;
      }
      for (const c of LOOT_CLASSES) {
        this.lootPity[c] += 1;
      }
    };
    if (!bypassCap && w.items.length >= ITEMS_MAX_LIVE) {
      bumpAll();
      return;
    }
    let cls: LootClass | null = null;
    if (feedPity) {
      // Ripe pity forces the drop regardless of the chance gate.
      if (this.lootPity.shield >= LOOT_PITY.shield) {
        cls = "shield";
      } else if (this.lootPity.booster >= LOOT_PITY.booster) {
        cls = "booster";
      } else if (this.lootPity.weapon >= LOOT_PITY.weapon) {
        cls = "weapon";
      }
    }
    if (!cls && rand() >= chance) {
      bumpAll();
      return;
    }
    if (!cls) {
      cls = rollLootClass();
    }
    if (feedPity) {
      for (const c of LOOT_CLASSES) {
        if (c === cls) {
          this.lootPity[c] = 0;
        } else {
          this.lootPity[c] += 1;
        }
      }
    }
    let drop: ItemDrop;
    if (cls === "shield") {
      drop = {
        kind: "shield",
        shieldIdx: SHIELD_MOD_KINDS.indexOf(rollWeightedKey(LOOT_SHIELD_WEIGHTS)),
      };
    } else if (cls === "booster") {
      drop = {
        boosterIdx: BOOSTER_KINDS.indexOf(rollWeightedKey(LOOT_BOOSTER_WEIGHTS)),
        kind: "booster",
      };
    } else {
      drop = { kind: "weapon", weaponIdx: Math.floor(rand() * WEAPONS_SPECIAL.length) };
    }
    w.items.push(spawnItemState(x, y, drop));
    this.dirty.items = true;
  }

  // ---- shared-state rendering ---------------------------------------------------------

  private onScreen(x: number, y: number): boolean {
    const v = this.cameras.main.worldView;
    return x >= v.x - 100 && x <= v.right + 100 && y >= v.y - 100 && y <= v.bottom + 100;
  }

  private makeTrailEmitter(tint: number): Phaser.GameObjects.Particles.ParticleEmitter {
    const e = this.add.particles(0, 0, "spark", {
      alpha: { end: 0, start: 0.7 },
      blendMode: BlendModes.ADD,
      emitting: false,
      frequency: 25,
      lifespan: 300,
      scale: { end: 0, start: TRAIL_PARTICLE_SCALE },
      speed: { max: 20, min: 0 },
      tint,
    });
    e.setDepth(9);
    return e;
  }

  /**
   * TRAILER ONLY: how much of its authored size the pilot's own additive glow
   * keeps at this shot's zoom.
   *
   * The hull is a 1px vector stroke ~16 world px across; the glow around it —
   * thruster puffs, muzzle sparks, the shield-impact burst — is the 32px soft
   * "spark" dot on ADD. Both are world-space, so both scale with the camera,
   * but only one of them GROWS: a stroked outline gains no ink when it is
   * magnified, while a soft additive dot gains area (and therefore saturates)
   * as the square of the zoom. At the reel's 1.9-2.5 zooms that inverted the
   * shot — measured on the last capture, the player read as a formless white
   * splat in calm-open, elite-behaviours, chain-reactor and pvp-duel while the
   * ENEMIES, which are pure stroke, read cleanly. The hero was the least
   * legible object in its own tight shots.
   *
   * So inside ?trailer=1 the glow is pinned to the SCREEN size it has at zoom
   * 1 (the framing the game itself ships) and the hull is the only thing the
   * tightening magnifies. Clamped at 1 so it can only ever damp — a shot below
   * zoom 1 would be wider than normal play, which the framing contract forbids
   * anyway. Outside trailer mode this is a constant 1 and every call site is
   * unchanged arithmetic.
   */
  private hullGlow(): number {
    if (!this.trailer) {
      return 1;
    }
    // Quantised: three scenes lerp their zoom, and the trail's scale lives in
    // the emitter CONFIG — re-parsing it every frame to chase a continuous
    // ramp buys nothing the eye can see.
    return Math.min(1, Math.round(20 / this.cameras.main.zoom) / 20);
  }

  private syncShips(now: number, dt: number): void {
    // Time-based smoothing (~0.35/frame at 60fps) so remote-ship glide speed
    // is refresh-rate independent.
    const blend = 1 - Math.exp(-25 * dt);
    // Over the soft particle budget: trails throttle ×2 (vfx skill rule).
    const throttled = this.fx.aliveParticles() > PARTICLE_SOFT_BUDGET;
    const seen = new Set<string>();
    const { myId } = this;
    this.haloGfx.clear();
    for (const [id, player] of Object.entries(this.peers)) {
      seen.add(id);
      const rec = this.shipRec(id, player.color);
      if (id === myId) {
        this.syncMyShip(rec, throttled, now);
      } else {
        this.syncRemoteShip(id, rec, blend, throttled, now);
      }
    }
    for (const [id, rec] of this.ships) {
      if (!seen.has(id)) {
        rec.gfx.destroy();
        if (rec.trail) {
          rec.trail.destroy();
          if (id !== myId) {
            this.remoteTrailCount = Math.max(0, this.remoteTrailCount - 1);
          }
        }
        this.ships.delete(id);
      }
    }
  }

  /** The render record for a ship, built on first sight (remote trails are
   *  capped; the pilot always gets one). */
  private shipRec(id: string, color: string | undefined): ShipObjs {
    const existing = this.ships.get(id);
    if (existing) {
      return existing;
    }
    const tint = cssToInt(color);
    let trail: Phaser.GameObjects.Particles.ParticleEmitter | null = null;
    if (id === this.myId) {
      trail = this.makeTrailEmitter(tint);
    } else if (this.remoteTrailCount < 8) {
      trail = this.makeTrailEmitter(tint);
      this.remoteTrailCount += 1;
    }
    const lvl0 = id === this.myId ? this.level : 1;
    const rec: ShipObjs = {
      alive: true,
      flashUntil: 0,
      gfx: this.makeShipGfx(tint, lvl0),
      lastShieldHp: SHIELD_MAX,
      level: lvl0,
      nitroTrail: false,
      regenUntil: 0,
      seenState: false,
      tint,
      trail,
      trailScale: TRAIL_PARTICLE_SCALE,
    };
    this.ships.set(id, rec);
    return rec;
  }

  private syncMyShip(rec: ShipObjs, throttled: boolean, now: number): void {
    this.ensureShipLevel(rec, this.level);
    // Only the PILOT's glow is damped: the reel's tight shots need the
    // contrast between a hull that grew and a glow that did not, and the
    // enemies (pure stroke) never had the problem in the first place.
    configureTrail(rec, this.boosts.has("nitro"), throttled, this.hullGlow());
    rec.gfx.setPosition(this.shipX, this.shipY).setRotation(this.shipAngle);
    rec.gfx.setVisible(this.spawned && this.alive);
    const phased = now < this.phasedUntil;
    rec.gfx.setAlpha(shipAlpha(phased, now < this.invulnUntil, now));
    rec.alive = this.alive;
    if (rec.trail) {
      rec.trail.emitting = this.alive && this.spawned && this.thrust > 0.3;
      rec.trail.setPosition(
        this.shipX - Math.cos(this.shipAngle) * 10,
        this.shipY - Math.sin(this.shipAngle) * 10,
      );
    }
    if (this.alive && this.spawned) {
      this.drawMyShipDecor(now);
    }
    if (this.sentry && now < this.sentry.until) {
      this.drawSentry(this.sentry.x, this.sentry.y, this.sentry.until, now);
    }
  }

  /** Shield stack, impact arcs, spawn-protection arc, TWIN drone, windup
   *  glow and TESLA aura around the pilot's hull. */
  private drawMyShipDecor(now: number): void {
    this.drawShield(
      this.shipX,
      this.shipY,
      this.shipAngle,
      this.shieldHp,
      this.overHp,
      this.shieldModNetState(now),
      now,
      {
        flash: now < this.haloFlashUntil,
        regen: this.regenActive || now < this.repairSweepUntil,
        siphonPulse: now < this.siphonPulseUntil,
      },
    );
    this.drawImpactArcs(now);
    if (now < this.invulnUntil && !this.trailer) {
      // The existing two-second protection, drawn outside the shield.
      const remaining = PhaserMath.Clamp((this.invulnUntil - now) / INVULNERABLE_MS, 0, 1);
      this.haloGfx.lineStyle(1.5, 0x7d_d3_fc, 0.8).beginPath();
      this.haloGfx.arc(
        this.shipX,
        this.shipY,
        SHIELD_RING_RADIUS + 6,
        -Math.PI / 2,
        -Math.PI / 2 + Math.PI * 2 * remaining,
      );
      this.haloGfx.strokePath();
    }
    if (this.boosts.has("twin")) {
      this.drawTwinDrone(this.shipX, this.shipY, twinAngle());
    }
    this.drawWindupGlow(
      this.shipX,
      this.shipY,
      this.shipAngle,
      this.windupFrac(),
      this.weapon.tint,
    );
    if (this.teslaActive(now)) {
      this.drawTeslaAura(this.shipX, this.shipY, now);
    }
  }

  private syncRemoteShip(
    id: string,
    rec: ShipObjs,
    blend: number,
    throttled: boolean,
    now: number,
  ): void {
    const st = this.peerStates.get(id) ?? null;
    if (!st) {
      rec.gfx.setVisible(false);
      if (rec.trail) {
        rec.trail.emitting = false;
      }
      return;
    }
    if (!st.present) {
      // Cleanly docked out (paused-as-spectator): hide with NO death FX, and
      // clear rec.alive so re-entry snaps in fresh rather than gliding from a
      // stale spot or firing a spurious death burst.
      rec.gfx.setVisible(false);
      if (rec.trail) {
        rec.trail.emitting = false;
      }
      rec.alive = false;
      return;
    }
    // remotes grow with their level too
    this.ensureShipLevel(rec, st.level);
    if (!rec.seenState) {
      // First snapshot: snap into place (no glide from the origin) and adopt
      // alive as-is (no death FX for players who were already dead).
      rec.seenState = true;
      rec.alive = st.alive;
      rec.gfx.setPosition(st.x, st.y);
      rec.lastShieldHp = st.shieldHp;
    }
    if (rec.alive && !st.alive) {
      this.fx.battle.burst(rec.gfx.x, rec.gfx.y, 95, rec.tint, "death", st.angle);
      this.splinterBurst(rec.gfx.x, rec.gfx.y, 50, 30, now);
      this.fx.shatter(rec.gfx.x, rec.gfx.y, shipHullPoints(), st.angle, rec.tint);
      this.fx.ring(rec.gfx.x, rec.gfx.y, 10, 90, 400, 0xff_ff_ff, 0.7);
      if (this.onScreen(rec.gfx.x, rec.gfx.y)) {
        this.trauma.add(0.2);
      }
    }
    // respawn: snap, don't glide
    if (!rec.alive && st.alive) {
      rec.gfx.setPosition(st.x, st.y);
    }
    rec.alive = st.alive;
    rec.gfx.setVisible(st.alive);
    if (st.alive) {
      rec.gfx.setPosition(
        PhaserMath.Linear(rec.gfx.x, st.x, blend),
        PhaserMath.Linear(rec.gfx.y, st.y, blend),
      );
      rec.gfx.setRotation(st.angle);
      // networked invuln/phase
      rec.gfx.setAlpha(shipAlpha(st.shieldMod?.phased === true, st.invuln, now));
      this.drawRemoteShipDecor(rec, st, now);
    }
    const nitro = st.alive && st.boosts.some((b) => b.kind === "nitro" && b.until > now);
    configureTrail(rec, nitro, throttled);
    if (rec.trail) {
      // Remote thrust isn't on the wire — speed from vx,vy is the proxy.
      rec.trail.emitting = st.alive && Math.hypot(st.vx, st.vy) > 100;
      rec.trail.setPosition(
        rec.gfx.x - Math.cos(st.angle) * 10,
        rec.gfx.y - Math.sin(st.angle) * 10,
      );
    }
  }

  /** Shield stack (with drain flash / regen inferred between snapshots),
   *  TWIN drone, windup glow, TESLA aura and sentry for a living remote. */
  private drawRemoteShipDecor(rec: ShipObjs, st: PlayerNetState, now: number): void {
    // Drains are visible as shieldHp drops between snapshots: flash + sparks.
    if (st.shieldHp < rec.lastShieldHp) {
      rec.flashUntil = now + 80;
      this.fx.sparks(rec.gfx.x, rec.gfx.y, 6, SHIELD_RING_TINT, { lifeMax: 250, lifeMin: 150 });
    } else if (st.shieldHp > rec.lastShieldHp) {
      // infer regen from increases
      rec.regenUntil = now + 250;
    }
    rec.lastShieldHp = st.shieldHp;
    this.drawShield(rec.gfx.x, rec.gfx.y, st.angle, st.shieldHp, st.overHp, st.shieldMod, now, {
      flash: now < rec.flashUntil,
      regen: now < rec.regenUntil,
      siphonPulse: false,
    });
    if (st.boosts.some((b) => b.kind === "twin" && b.until > now)) {
      this.drawTwinDrone(rec.gfx.x, rec.gfx.y, (now / 1000) * TWIN_ORBIT_DEG_PER_S * DEG);
    }
    this.drawWindupGlow(rec.gfx.x, rec.gfx.y, st.angle, st.windup, weaponTint(st.weaponName));
    if (st.tesla) {
      this.drawTeslaAura(rec.gfx.x, rec.gfx.y, now);
    }
    if (st.sentry && now < st.sentry.until) {
      this.drawSentry(st.sentry.x, st.sentry.y, st.sentry.until, now);
    }
  }

  /** Base ring: completeness = shield fraction; the gap in the arc IS the
   *  health bar. Low shield pulses, flashes go white, regen rides bright
   *  head dots on the re-closing tips. */
  private drawShieldRing(
    x: number,
    y: number,
    angle: number,
    shieldHp: number,
    frac: number,
    now: number,
    opts: { flash: boolean; regen: boolean },
  ): void {
    const g = this.haloGfx;
    let alpha = 0.15 + 0.45 * frac + (opts.regen ? 0.15 : 0);
    if (frac < SHIELD_LOW_FRACTION) {
      // Low shield: pulse 0.2↔0.7 at 6Hz.
      alpha = 0.45 + 0.25 * Math.sin((now / 1000) * Math.PI * 2 * 6);
    }
    // SIPHON overheal banked above 100: the closed ring glows brighter.
    if (shieldHp > SHIELD_MAX) {
      alpha += 0.1;
    }
    if (opts.flash) {
      alpha = 1;
    }
    g.lineStyle(1, SHIELD_RING_TINT, Math.min(1, alpha));
    const sweep = Math.PI * 2 * frac;
    g.beginPath();
    g.arc(x, y, SHIELD_RING_RADIUS, angle - sweep / 2, angle + sweep / 2);
    g.strokePath();
    if (opts.regen && frac < 1) {
      g.fillStyle(0xff_ff_ff, 0.95);
      g.fillCircle(
        x + Math.cos(angle - sweep / 2) * SHIELD_RING_RADIUS,
        y + Math.sin(angle - sweep / 2) * SHIELD_RING_RADIUS,
        1.5,
      );
      g.fillCircle(
        x + Math.cos(angle + sweep / 2) * SHIELD_RING_RADIUS,
        y + Math.sin(angle + sweep / 2) * SHIELD_RING_RADIUS,
        1.5,
      );
    }
  }

  /**
   * The v2 shield stack on the additive layer (1px strokes): base ring at
   * r=12 whose ARC SWEEP is the health bar, the OVERSHIELD hex, then the mod
   * halo at r=15.
   */
  private drawShield(
    x: number,
    y: number,
    angle: number,
    shieldHp: number,
    overHp: number,
    mod: ShieldModNetState | null,
    now: number,
    opts: { flash: boolean; regen: boolean; siphonPulse: boolean },
  ): void {
    const g = this.haloGfx;
    const frac = Math.max(0, Math.min(1, shieldHp / SHIELD_MAX));
    if (frac > 0) {
      this.drawShieldRing(x, y, angle, shieldHp, frac, now, opts);
    }
    // OVERSHIELD bonus layer: Halo hexagon, fading with the remaining bonus.
    if (overHp > 0) {
      g.lineStyle(
        1,
        SHIELD_MOD_SPECS.overshield.tint,
        0.8 * Math.min(1, overHp / OVERSHIELD_BONUS),
      );
      strokeRegularPolygon(g, x, y, SHIELD_HALO_RADIUS, 6, 0);
    }
    if (!mod) {
      return;
    }
    const { tint } = SHIELD_MOD_SPECS[mod.kind];
    switch (mod.kind) {
      case "overshield": {
        // the hexagon above IS the halo
        return;
      }
      case "reflect": {
        // dim = arm down (≤40)
        g.lineStyle(1, tint, mod.active ? 0.85 : 0.25);
        strokeRegularPolygon(
          g,
          x,
          y,
          SHIELD_HALO_RADIUS,
          3,
          ((now / 1000) * 90 * DEG) % (Math.PI * 2),
        );
        return;
      }
      case "ram": {
        // bright when armed
        g.lineStyle(1, tint, mod.active ? 0.9 : 0.35);
        g.beginPath();
        g.arc(x, y, SHIELD_HALO_RADIUS, angle - Math.PI / 4, angle + Math.PI / 4);
        g.strokePath();
        return;
      }
      case "phase": {
        let alpha = 0.2;
        if (mod.phased) {
          alpha = 0.25;
        } else if (mod.active) {
          alpha = 0.7;
        }
        g.lineStyle(1, tint, alpha);
        const rot = (now / 1000) * 45 * DEG;
        for (let i = 0; i < 8; i += 1) {
          const a0 = rot + (Math.PI * 2 * i) / 8;
          g.beginPath();
          g.arc(x, y, SHIELD_HALO_RADIUS, a0, a0 + ((Math.PI * 2) / 8) * 0.55);
          g.strokePath();
        }
        return;
      }
      case "siphon": {
        const alpha = opts.siphonPulse ? 0.95 : 0.5;
        g.lineStyle(1, tint, alpha);
        g.strokeCircle(x, y, SHIELD_HALO_RADIUS);
        g.strokeCircle(x, y, SHIELD_HALO_RADIUS + 2);
        return;
      }
      case "aegis": {
        g.lineStyle(1, tint, 0.5);
        g.strokeCircle(x, y, SHIELD_HALO_RADIUS);
        // 4 orbiting dots; spin ×3 + brighten while regen is running.
        const spin = (now / 1000) * TWIN_ORBIT_DEG_PER_S * DEG * (opts.regen ? 3 : 1);
        g.fillStyle(tint, opts.regen ? 1 : 0.7);
        for (let i = 0; i < 4; i += 1) {
          const a0 = spin + (Math.PI * 2 * i) / 4;
          g.fillCircle(
            x + Math.cos(a0) * SHIELD_HALO_RADIUS,
            y + Math.sin(a0) * SHIELD_HALO_RADIUS,
            1,
          );
        }
        break;
      }
      default: {
        // bulwark / leech: no halo beyond the hexagon.
        break;
      }
    }
  }

  /** 60° white impact arcs at the incoming-damage angle, alpha 1→0 / 150ms. */
  private drawImpactArcs(now: number): void {
    this.impactArcs = this.impactArcs.filter((ia) => now < ia.diesAt);
    const g = this.haloGfx;
    for (const ia of this.impactArcs) {
      const alpha = Math.max(0, (ia.diesAt - now) / 150);
      g.lineStyle(2, 0xff_ff_ff, alpha);
      g.beginPath();
      g.arc(this.shipX, this.shipY, SHIELD_RING_RADIUS, ia.angle - 30 * DEG, ia.angle + 30 * DEG);
      g.strokePath();
    }
  }

  /** TWIN: 3px wireframe drone orbiting at r=28 (remotes drive it from boosts). */
  private drawTwinDrone(cx: number, cy: number, orbitAngle: number): void {
    const g = this.haloGfx;
    const x = cx + Math.cos(orbitAngle) * TWIN_ORBIT_RADIUS;
    const y = cy + Math.sin(orbitAngle) * TWIN_ORBIT_RADIUS;
    g.lineStyle(1, BOOSTER_SPECS.twin.tint, 0.9);
    strokeRegularPolygon(g, x, y, 3, 3, orbitAngle);
  }

  /** RAILGUN charge: nose glow scales 0→6px with the windup fraction. It is a
   *  filled disc rather than a stroke, so it damps with the rest of the pilot's
   *  glow in trailer mode (hullGlow() is 1 everywhere else). */
  private drawWindupGlow(x: number, y: number, angle: number, frac: number, tint: number): void {
    if (frac <= 0.02) {
      return;
    }
    const g = this.haloGfx;
    g.fillStyle(tint, 0.35 + 0.45 * frac);
    g.fillCircle(
      x + Math.cos(angle) * (SHIP_RADIUS + 2),
      y + Math.sin(angle) * (SHIP_RADIUS + 2),
      6 * frac * this.hullGlow(),
    );
  }

  /** TESLA AURA: crackling broken ring (per-frame random arc phases = the
   *  electric flicker), driven locally for the owner and by the serialized
   *  flag for remotes. */
  private drawTeslaAura(x: number, y: number, now: number): void {
    const g = this.haloGfx;
    g.lineStyle(1, TESLA_TINT, 0.7);
    const base = (now / 1000) * 240 * DEG;
    for (let i = 0; i < 5; i += 1) {
      const a0 = base + (Math.PI * 2 * i) / 5 + Math.random() * 0.5;
      const r = SHIELD_HALO_RADIUS + 3 + Math.random() * 2;
      g.beginPath();
      g.arc(x, y, r, a0, a0 + 0.7);
      g.strokePath();
    }
  }

  /** SENTRY turret: amber wireframe triangle-on-post; the head spins slowly
   *  and the whole glyph fades over its last 2s. */
  private drawSentry(x: number, y: number, until: number, now: number): void {
    const left = until - now;
    if (left <= 0) {
      return;
    }
    const g = this.haloGfx;
    const alpha = 0.9 * Math.min(1, left / 2000);
    g.lineStyle(1, SENTRY_WEAPON.tint, alpha);
    // base
    g.lineBetween(x - 4, y + 8, x + 4, y + 8);
    // post
    g.lineBetween(x, y + 8, x, y + 2);
    strokeRegularPolygon(g, x, y - 2, 4.5, 3, (now / 1000) * 60 * DEG);
  }

  private syncAsteroids(now: number): void {
    const seen = new Set<string>();
    for (const a of this.world.asteroids) {
      seen.add(a.id);
      let rec = this.asteroidObjs.get(a.id);
      if (!rec) {
        rec = { drawnRadius: 0, gfx: this.add.graphics().setDepth(5) };
        this.asteroidObjs.set(a.id, rec);
      }
      if (rec.drawnRadius !== a.radius) {
        drawPoly(
          rec.gfx,
          asteroidUnitVerts(a.id).map((v) => ({ x: v.x * a.radius, y: v.y * a.radius })),
        );
        if (rec.drawnRadius > a.radius) {
          // Took a hit: brief scale pop + matter debris + energy sparks.
          rec.gfx.setScale(1.15);
          this.tweens.add({ duration: 120, ease: "Quad.Out", scale: 1, targets: rec.gfx });
          this.fx.debris(a.x, a.y, 4, 0xff_ff_ff, {
            lifeMax: 500,
            lifeMin: 300,
            speedMax: 160,
            speedMin: 60,
          });
          this.fx.sparks(a.x, a.y, 4, 0xff_ff_ff, { lifeMax: 250, lifeMin: 150 });
        }
        rec.drawnRadius = a.radius;
      }
      rec.gfx.setPosition(a.x, a.y).setRotation(a.rot);
    }
    for (const [id, rec] of this.asteroidObjs) {
      if (seen.has(id)) {
        continue;
      }
      // Destroyed (visible burst) or culled off-world (burst hidden by mask).
      this.fx.battle.burst(
        rec.gfx.x,
        rec.gfx.y,
        Math.min(115, rec.drawnRadius * 1.4),
        0xae_c6_dd,
        "fracture",
      );
      this.splinterBurst(rec.gfx.x, rec.gfx.y, rec.drawnRadius, 20, now);
      this.fx.sparks(rec.gfx.x, rec.gfx.y, 6, 0xff_ff_ff, { lifeMax: 250, lifeMin: 150 });
      if (dist2(rec.gfx.x, rec.gfx.y, this.shipX, this.shipY) < 400 * 400) {
        this.trauma.add(0.05);
      }
      this.tweens.killTweensOf(rec.gfx);
      rec.gfx.destroy();
      this.asteroidObjs.delete(id);
    }
  }

  private syncUfo(now: number): void {
    const u = this.world.ufo;
    if (!u) {
      if (this.ufoGfx) {
        this.fx.battle.burst(this.ufoGfx.x, this.ufoGfx.y, 85, 0x83_d6_f5, "death");
        this.splinterBurst(this.ufoGfx.x, this.ufoGfx.y, 25, 20, now);
        this.fx.sparks(this.ufoGfx.x, this.ufoGfx.y, 8, 0xff_ff_ff, { lifeMax: 350, lifeMin: 200 });
        this.ufoGfx.destroy();
        this.ufoGfx = null;
      }
      return;
    }
    if (!this.ufoGfx || this.ufoId !== u.id) {
      this.ufoGfx?.destroy();
      this.ufoGfx = this.makeUfoGfx();
      this.ufoId = u.id;
    }
    this.ufoGfx.setPosition(u.x, u.y);
    // Damage flicker: hidden every 4th 66ms slot (legacy: every 4th tick of 40).
    const hidden = now < u.blinkUntil && Math.floor(now / 66) % 4 === 0;
    this.ufoGfx.setVisible(!hidden);
  }

  private syncItems(): void {
    const seen = new Set<string>();
    for (const it of this.world.items) {
      seen.add(it.id);
      let rec = this.itemObjs.get(it.id);
      if (!rec) {
        rec = { gfx: this.makeItemGfx(it), tint: itemTint(it) };
        this.itemObjs.set(it.id, rec);
        this.tweens.add({
          duration: 600,
          ease: "Sine.InOut",
          repeat: -1,
          scale: { from: 0.92, to: 1.1 },
          targets: rec.gfx,
          yoyo: true,
        });
      }
      rec.gfx.setPosition(it.x, it.y);
    }
    for (const [id, rec] of this.itemObjs) {
      if (seen.has(id)) {
        continue;
      }
      this.fx.sparks(rec.gfx.x, rec.gfx.y, 10, rec.tint, {
        lifeMax: 420,
        lifeMin: 200,
        speedMax: 140,
        speedMin: 30,
      });
      this.tweens.killTweensOf(rec.gfx);
      rec.gfx.destroy();
      this.itemObjs.delete(id);
    }
  }

  private syncEnemies(now: number): void {
    const seen = new Set<string>();
    const reduced = REDUCED_MOTION.matches;
    for (const e of this.world.enemies) {
      seen.add(e.id);
      const rec = this.enemyRec(e);
      // A hit accents the hull without hiding the threat.
      rec.gfx.setVisible(true);
      rec.gfx.setAlpha(e.graceUntil > now ? graceAlpha(reduced, now) : 1);
      this.voiceTelegraph(e, rec, now);
      const pose = fleetPose(e, now, rec.telegraphDuration, reduced);
      rec.gfx
        .setPosition(e.x - Math.cos(e.angle) * pose.recoil, e.y - Math.sin(e.angle) * pose.recoil)
        .setRotation(e.angle)
        .setScale(pose.scaleX, pose.scaleY);
      if (e.kind === "lancer") {
        this.syncLancerCharge(e, rec, reduced, now);
      }
    }
    // Ordinary enemies can also despawn far away. Only dreadnought removal
    // warrants a victory cue; trailer cuts clear the display cache silently.
    for (const [id, rec] of this.enemyObjs) {
      if (seen.has(id)) {
        continue;
      }
      this.enemyDeathFx(rec);
      rec.gfx.destroy();
      this.enemyObjs.delete(id);
    }
  }

  private enemyRec(e: EnemyState): EnemyObjs {
    const existing = this.enemyObjs.get(e.id);
    if (existing) {
      return existing;
    }
    const rec: EnemyObjs = {
      chargeTraumaDone: false,
      gfx: this.makeEnemyGfx(e.kind),
      kind: e.kind,
      lastTelegraphUntil: 0,
      nextTrailAt: 0,
      telegraphDuration: 0,
    };
    this.enemyObjs.set(e.id, rec);
    return rec;
  }

  /** Telegraph audio: LANCER windup + WASP burst, on-screen only (§6.1). */
  private voiceTelegraph(e: EnemyState, rec: EnemyObjs, now: number): void {
    if (e.telegraphUntil <= now || rec.lastTelegraphUntil === e.telegraphUntil) {
      return;
    }
    rec.lastTelegraphUntil = e.telegraphUntil;
    rec.telegraphDuration = enemyChargeDuration(e);
    if (
      (e.kind === "lancer" ||
        e.kind === "wasp" ||
        e.kind === "warden" ||
        e.kind === "sniper" ||
        e.kind === "dreadnought") &&
      this.onScreen(e.x, e.y)
    ) {
      sfx.play("telegraph_warn");
    }
  }

  private syncLancerCharge(e: EnemyState, rec: EnemyObjs, reduced: boolean, now: number): void {
    if (e.chargeUntil <= now) {
      rec.chargeTraumaDone = false;
      rec.nextTrailAt = 0;
      return;
    }
    // Charge trail (ADD, hull tint) at 60/s of SIM time so density is
    // frame-rate independent; a long gap emits at most 3, not a backlog.
    if (rec.nextTrailAt === 0) {
      rec.nextTrailAt = now;
    }
    const due = Math.max(0, Math.floor((now - rec.nextTrailAt) / LANCER_TRAIL_MS) + 1);
    rec.nextTrailAt += due * LANCER_TRAIL_MS;
    if (due > 0 && !reduced) {
      this.fx.sparks(e.x, e.y, Math.min(3, due), ENEMY_SPECS.lancer.tint, {
        lifeMax: 250,
        lifeMin: 250,
        scale: 0.5,
        speedMax: 20,
        speedMin: 0,
      });
    }
    if (
      !rec.chargeTraumaDone &&
      this.alive &&
      dist2(e.x, e.y, this.shipX, this.shipY) < 100 * 100
    ) {
      rec.chargeTraumaDone = true;
      this.trauma.add(0.15);
    }
  }

  private enemyDeathFx(rec: EnemyObjs): void {
    const spec = ENEMY_SPECS[rec.kind];
    const { x } = rec.gfx;
    const { y } = rec.gfx;
    const big = spec.hp >= 80;
    const boss = rec.kind === "dreadnought";
    const importance = boss ? "important" : "common";
    this.fx.battle.burst(
      x,
      y,
      deathBurstSize(boss, big),
      spec.tint,
      boss ? "boss" : "death",
      rec.gfx.rotation,
      importance,
    );
    this.fx.shatter(x, y, enemyHullPoints(rec.kind), rec.gfx.rotation, spec.tint, importance);
    this.fx.sparks(x, y, 8, spec.tint, { importance, lifeMax: 350, lifeMin: 200 });
    if (rec.kind === "lancer" || rec.kind === "splitter" || boss) {
      this.fx.ring(
        x,
        y,
        boss ? 16 : 6,
        boss ? 240 : 60,
        boss ? 700 : 350,
        spec.tint,
        0.85,
        importance,
      );
    }
    if (boss) {
      // Big multi-ring death blast for the marquee kill.
      this.fx.bossDefeat(x, y, spec.tint);
      this.fx.ring(x, y, 10, 140, 500, 0xff_ff_ff, 0.65, "important");
      this.fx.sparks(x, y, 40, spec.tint, {
        importance: "important",
        lifeMax: 600,
        lifeMin: 300,
        speedMax: 360,
        speedMin: 120,
      });
    }
    if (this.onScreen(x, y)) {
      // The accepted encounter edge owns the single boss resolve cue.
      if (!boss) {
        sfx.play("enemy_death", big ? { gain: 1.3, rate: 0.8 } : {});
      }
      this.trauma.add(deathTrauma(boss, big));
    }
  }

  /** Stable warnings live outside decorative budgets. Charge reads the host's
   * sim-clock deadline; no sight is re-aimed or hidden on a blink frame. */
  private drawEnemyTelegraphs(now: number): void {
    const g = this.telegraphGfx;
    const sw = this.strokeScale();
    g.clear();
    for (const e of this.world.enemies) {
      const spec = ENEMY_SPECS[e.kind];
      if (e.kind === "warden") {
        drawWardenArmor(g, e, spec.hitRadius + 6, sw);
      }
      // Retain the existing damage response independently of anticipation.
      if (e.blinkUntil > now && (REDUCED_MOTION.matches || Math.floor(now / 66) % 4 === 0)) {
        g.lineStyle(2 * sw, 0xff_ff_ff, 0.9);
        strokeTransformed(g, enemyHullPoints(e.kind), e.x, e.y, e.angle);
      }
      if (e.telegraphUntil <= now) {
        continue;
      }
      const duration = this.enemyObjs.get(e.id)?.telegraphDuration ?? enemyChargeDuration(e);
      const progress = enemyChargeProgress(e.telegraphUntil, now, duration);
      const radius = spec.hitRadius + (e.kind === "warden" ? 12 : 7);
      g.lineStyle(sw, spec.tint, 0.25);
      g.strokeCircle(e.x, e.y, radius);
      if (progress > 0) {
        g.lineStyle(1.5 * sw, spec.tint, 0.85);
        g.beginPath();
        g.arc(e.x, e.y, radius, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * progress);
        g.strokePath();
      }
      drawTelegraphAccent(g, e, progress, sw);
    }
  }

  /** SINGULARITY vortices, from the shared pulls entries (every client
   *  agrees). Appends to telegraphGfx, which drawEnemyTelegraphs cleared
   *  this frame. The inward particle ring reuses the pooled converge FX. */
  private drawPulls(now: number): void {
    const g = this.telegraphGfx;
    for (const p of this.world.pulls) {
      if (p.until <= now) {
        continue;
      }
      // 1 -> 0
      const frac = Math.max(0, Math.min(1, (p.until - now) / SINGULARITY_PULL_MS));
      // Event horizon shrinks as the collapse completes.
      g.lineStyle(1, SINGULARITY_TINT, 0.3);
      g.strokeCircle(p.x, p.y, 30 + (SINGULARITY_PULL_RANGE - 30) * frac);
      // Three inward-spiraling arc shards.
      const spin = (now / 1000) * 540 * DEG;
      g.lineStyle(1, SINGULARITY_TINT, 0.85);
      for (let i = 0; i < 3; i += 1) {
        const a0 = spin + (Math.PI * 2 * i) / 3;
        g.beginPath();
        g.arc(p.x, p.y, 12 + 70 * frac, a0, a0 + Math.PI / 3);
        g.strokePath();
      }
      if (Math.random() < 0.3) {
        this.fx.converge(p.x, p.y, 2, 150, 200, SINGULARITY_TINT);
      }
    }
  }

  /** BEACON zone (dir-004). CHARGE: dashed hex shrinking 1.5×→1× radius,
   *  dashes rotating. ACTIVE: solid slow-spinning hex + a depleting countdown
   *  arc; CONTESTED strobes gold↔white at 4Hz; controlled drifts gold motes
   *  toward the controller. Gold stays off enemy and player kit. */
  private drawBeacon(now: number): void {
    const g = this.beaconGfx;
    g.clear();
    const b = this.world.beacon;
    if (!b || now >= b.diesAt) {
      return;
    }
    if (now < b.activeAt) {
      const p = PhaserMath.Clamp(1 - (b.activeAt - now) / (BEACON_CHARGE_S * 1000), 0, 1);
      const r = BEACON_RADIUS * (1.5 - 0.5 * p);
      g.lineStyle(2, BEACON_TINT, 0.3 + 0.5 * p);
      strokeHexRing(g, b.x, b.y, r, (now / 1000) * 0.6, 0.55);
      g.fillStyle(0xff_ff_ff, 0.4 + 0.5 * p);
      g.fillCircle(b.x, b.y, 3 + 4 * p);
      // qa-014: point-blank the 1.5x ring exceeds the viewport and the dashes
      // read as stray gold segments — a pulsing gold center diamond (the
      // beacon's minimap glyph, writ large) gives close witnesses a focus.
      const pulse = 1 + 0.2 * Math.sin((now / 1000) * Math.PI * 3);
      const dr = (10 + 8 * p) * pulse;
      g.lineStyle(2, BEACON_TINT, 0.45 + 0.45 * p);
      g.beginPath();
      g.moveTo(b.x, b.y - dr);
      g.lineTo(b.x + dr * 0.7, b.y);
      g.lineTo(b.x, b.y + dr);
      g.lineTo(b.x - dr * 0.7, b.y);
      g.closePath();
      g.strokePath();
      return;
    }
    const strobeWhite =
      b.contested && Math.floor((now * BEACON_CONTEST_STROBE_HZ * 2) / 1000) % 2 === 1;
    const tint = strobeWhite ? 0xff_ff_ff : BEACON_TINT;
    g.lineStyle(3, tint, b.contested ? 0.95 : 0.75);
    strokeHexRing(g, b.x, b.y, BEACON_RADIUS, (now / 1000) * 0.12, 1);
    // Countdown arc depletes across ACTIVE — the "hold it to the end" read.
    const frac = PhaserMath.Clamp((b.diesAt - now) / Math.max(1, b.diesAt - b.activeAt), 0, 1);
    g.lineStyle(1, tint, 0.5);
    g.beginPath();
    g.arc(b.x, b.y, BEACON_RADIUS - 26, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * frac);
    g.strokePath();
    g.fillStyle(0xff_ff_ff, 0.85);
    g.fillCircle(b.x, b.y, 5);
    if (b.controllerId && !b.contested && Math.random() < 0.3) {
      const c = this.playerPos(b.controllerId);
      if (c) {
        this.fx.converge(c.x, c.y, 1, BEACON_RADIUS, 500, BEACON_TINT);
      }
    }
  }

  /** The ONE viewport-edge pip pass (dir-004 mandate, shared component):
   *  beacon gold diamond, UFO blinking circle (qa-010), and — while the arena
   *  is young and the screen shows no hostiles — red triangles at the nearest
   *  inbound enemies (qa-007: an empty screen still telegraphs the action). */
  private drawEdgePips(now: number): void {
    if (this.trailer) {
      // HUD policy: no pips
      this.edgePips.draw(this.cameras.main, NO_PIPS, now);
      return;
    }
    const targets: PipTarget[] = [];
    const b = this.world.beacon;
    if (b && now < b.diesAt) {
      targets.push({ glyph: "diamond", tint: BEACON_TINT, x: b.x, y: b.y });
    }
    const u = this.world.ufo;
    if (u) {
      targets.push({ blink: true, glyph: "circle", tint: 0xff_ff_ff, x: u.x, y: u.y });
    }
    const tSec = Math.max(0, (now - this.world.arenaEpoch) / 1000);
    if (tSec < EARLY_SPAWN_WINDOW_S && this.world.enemies.length > 0) {
      const view = this.cameras.main.worldView;
      const anyVisible = this.world.enemies.some(
        (e) => e.x >= view.x && e.x <= view.right && e.y >= view.y && e.y <= view.bottom,
      );
      if (!anyVisible) {
        const byDist = this.world.enemies.toSorted(
          (a, z) =>
            Math.hypot(a.x - this.shipX, a.y - this.shipY) -
            Math.hypot(z.x - this.shipX, z.y - this.shipY),
        );
        for (const e of byDist.slice(0, DEBUT_PIP_MAX)) {
          targets.push({ glyph: "triangle", tint: ENEMY_SHOT_TINT, x: e.x, y: e.y });
        }
      }
    }
    this.edgePips.draw(this.cameras.main, targets, now);
  }

  /** Enemy projectiles: red is reserved — nothing friendly is ever red. */
  private drawEnemyShots(): void {
    const g = this.enemyShotGfx;
    g.clear();
    if (this.world.enemyShots.length === 0) {
      return;
    }
    g.lineStyle(ENEMY_SHOT_WIDTH, ENEMY_SHOT_TINT, 1);
    for (const s of this.world.enemyShots) {
      const len = Math.hypot(s.vx, s.vy) || 1;
      const ux = s.vx / len;
      const uy = s.vy / len;
      const look = hostileShotLook(len);
      this.fx.battle.beam(
        s.x - ux * ENEMY_SHOT_LEN,
        s.y - uy * ENEMY_SHOT_LEN,
        s.x,
        s.y,
        ENEMY_SHOT_WIDTH,
        ENEMY_SHOT_TINT,
        enemyShotBeamLook(look),
        this.time.now,
      );
      // Original red collision stroke stays exact. Nose marks describe speed
      // bands; every mark travels with its accepted projectile, never an aim.
      g.lineStyle(ENEMY_SHOT_WIDTH, ENEMY_SHOT_TINT, 1);
      g.lineBetween(s.x - ux * ENEMY_SHOT_LEN, s.y - uy * ENEMY_SHOT_LEN, s.x, s.y);
      if (look === "plasma") {
        g.fillStyle(ENEMY_SHOT_TINT, 0.9).fillCircle(s.x, s.y, 2.6);
      } else if (look === "lance" || look === "rail") {
        g.lineStyle(1, 0xff_b4_ba, 0.9);
        g.lineBetween(s.x - ux * 8, s.y - uy * 8, s.x, s.y);
        if (look === "lance") {
          g.lineStyle(1, ENEMY_SHOT_TINT, 0.9);
          g.lineBetween(s.x - ux * 5 - uy * 3, s.y - uy * 5 + ux * 3, s.x, s.y);
          g.lineBetween(s.x - ux * 5 + uy * 3, s.y - uy * 5 - ux * 3, s.x, s.y);
        }
      } else {
        g.lineStyle(1, ENEMY_SHOT_TINT, 0.8);
        g.lineBetween(
          s.x - ux * 4 - uy * 2,
          s.y - uy * 4 + ux * 2,
          s.x - ux * 4 + uy * 2,
          s.y - uy * 4 - ux * 2,
        );
      }
    }
  }

  /** All beams — mine simulated, everyone else's raw from their snapshots. */
  private drawBeams(now: number): void {
    const g = this.beamGfx;
    g.clear();
    const { myId } = this;
    const draw = (
      sb: SerializedBeam,
      look: WeaponLook = "bolt",
      importance: FxImportance = "common",
    ): void => {
      if (sb.mine && !sb.exploding) {
        this.fx.battle.orbit(sb.hx, sb.hy, 9, sb.tint, 0, true, importance);
        // Remote mine: open diamond at the armed 1Hz blink (arm state isn't
        // on the wire; owners render the 4Hz arming blink locally).
        if (Math.floor(now / 500) % 2 === 0) {
          g.lineStyle(1, sb.tint, 1);
          strokeDiamond(g, sb.hx, sb.hy, 6);
        }
        return;
      }
      if (sb.chain && sb.chain.length >= 2) {
        for (let i = 1; i < sb.chain.length; i += 1) {
          const a = sb.chain[i - 1];
          const b = sb.chain[i];
          if (a && b) {
            this.fx.battle.beam(a.x, a.y, b.x, b.y, 2, sb.tint, "arc", now, importance);
          }
        }
        drawJitteredChain(g, sb.chain, sb.tint, REDUCED_MOTION.matches ? 0 : now);
        return;
      }
      if (sb.glaive) {
        this.fx.battle.orbit(sb.hx, sb.hy, 13, sb.tint, now * 0.012, false, importance);
        // Remote glaive: same spinning triangle the owner sees (clock-driven
        // spin at the local 12 rad/s rate; phase doesn't need to match).
        g.lineStyle(2, sb.tint, 1);
        strokeTransformed(g, GLAIVE_TRI, sb.hx, sb.hy, (now / 1000) * 12);
        return;
      }
      if (sb.orb) {
        // SINGULARITY orb: pulsing filled core + ring (flight and collapse;
        // the collapse vortex itself renders from the shared pulls entry).
        const r = 4 + Math.sin(now / 60) * 1.2;
        this.fx.battle.orbit(sb.hx, sb.hy, r + 7, sb.tint, now * 0.006, false, importance);
        g.fillStyle(sb.tint, 0.55).fillCircle(sb.hx, sb.hy, r * 0.6);
        g.lineStyle(1, sb.tint, 0.95).strokeCircle(sb.hx, sb.hy, r + 2);
        return;
      }
      if (sb.exploding) {
        this.fx.battle.orbit(sb.hx, sb.hy, sb.explosionRadius, sb.tint, 0, true, importance);
        g.lineStyle(1, sb.tint, 1).strokeCircle(sb.hx, sb.hy, sb.explosionRadius);
      } else {
        this.fx.battle.beam(sb.tx, sb.ty, sb.hx, sb.hy, sb.width, sb.tint, look, now, importance);
        g.lineStyle(sb.width, sb.tint, 1).lineBetween(sb.tx, sb.ty, sb.hx, sb.hy);
        g.lineStyle(Math.max(0.65, sb.width * 0.45), 0xff_f9_eb, 0.92).lineBetween(
          sb.tx,
          sb.ty,
          sb.hx,
          sb.hy,
        );
      }
    };
    for (const b of this.beams) {
      if (b.vanished) {
        continue;
      }
      if (b.mine && !b.exploding) {
        this.fx.battle.orbit(b.head.x, b.head.y, 9, b.weapon.tint, 0, true, "important");
        // Blink 4Hz while arming, 1Hz once armed (zero particles, §C).
        const armed = now >= b.mine.armAt;
        const on = armed ? Math.floor(now / 500) % 2 === 0 : Math.floor(now / 125) % 2 === 0;
        if (on) {
          g.lineStyle(1, b.weapon.tint, 1);
          strokeDiamond(g, b.head.x, b.head.y, 6);
        }
        continue;
      }
      if (b.glaive) {
        this.fx.battle.orbit(b.head.x, b.head.y, 13, b.weapon.tint, b.spin, false, "important");
        // Spinning open triangle (remotes draw it via the serialized flag).
        g.lineStyle(2, b.weapon.tint, 1);
        strokeTransformed(g, GLAIVE_TRI, b.head.x, b.head.y, b.spin);
        continue;
      }
      draw(serializeBeam(b), weaponLook(b.weapon), "important");
    }
    for (const [id, st] of this.peerStates) {
      if (id === myId) {
        continue;
      }
      if (!st || !st.alive) {
        continue;
      }
      for (const sb of st.beams) {
        draw(sb);
      }
    }
    // Transient muzzle strokes (1–2 frames, additive layer).
    const mg = this.muzzleGfx;
    mg.clear();
    this.muzzleFlashes = this.muzzleFlashes.filter((f) => now < f.diesAt);
    for (const f of this.muzzleFlashes) {
      if (f.kind === "ring") {
        mg.lineStyle(1, f.tint, 0.9).strokeCircle(f.x, f.y, f.size);
      } else if (f.kind === "line") {
        const cos = Math.cos(f.angle);
        const sin = Math.sin(f.angle);
        mg.lineStyle(3, f.tint, 0.9).lineBetween(f.x, f.y, f.x + cos * f.size, f.y + sin * f.size);
      } else {
        const cos = Math.cos(f.angle);
        const sin = Math.sin(f.angle);
        const h = f.size / 2;
        mg.lineStyle(1, f.tint, 0.95);
        mg.lineBetween(f.x - cos * h, f.y - sin * h, f.x + cos * h, f.y + sin * h);
        mg.lineBetween(f.x + sin * h, f.y - cos * h, f.x - sin * h, f.y + cos * h);
      }
    }
  }

  // ---- visual effects ----------------------------------------------------------------

  /** Classic vector death debris: white pixel squares radiating outward. */
  private splinterBurst(x: number, y: number, radius: number, count: number, now: number): void {
    for (let i = 0; i < count; i += 1) {
      this.splinters.push({
        angle: Math.random() * Math.PI * 2,
        diesAt: now + SPLINTER_LIFE_MS,
        dist: Math.random() * radius,
        originX: x,
        originY: y,
        // legacy 0..1 px/tick
        speed: Math.random() * 60,
        x,
        y,
      });
    }
  }

  private updateSplinters(dt: number, now: number): void {
    this.splinters = this.splinters.filter((s) => {
      s.dist += s.speed * dt;
      s.x = s.originX + Math.cos(s.angle) * s.dist;
      s.y = s.originY + Math.sin(s.angle) * s.dist;
      return now < s.diesAt && inWorld(s.x, s.y, 10);
    });
    const g = this.splinterGfx;
    g.clear();
    g.fillStyle(0xff_ff_ff, 1);
    for (const s of this.splinters) {
      g.fillRect(s.x, s.y, SPLINTER_PX, SPLINTER_PX);
    }
  }

  /**
   * Hard-centered on the ship plus directional recoil kick plus trauma shake
   * (offset AND a touch of roll — trauma², layered sin noise). Unzoomed, so
   * no bounds clamping.
   */
  private updateCamera(dt: number, timeMs: number): void {
    // Trailer camera override: fixed/panned shots still ride the trauma shake
    // (real recoil/impacts keep selling), only the follow target changes.
    const lock = this.trailer?.camPos ?? null;
    if (!this.spawned && !lock) {
      return;
    }
    if (REDUCED_MOTION.matches) {
      this.kickX = 0;
      this.kickY = 0;
      this.trauma.reset();
      this.tweens.killTweensOf(this.flashRect);
      this.flashRect.setAlpha(0);
      this.cameras.main.centerOn(lock ? lock.x : this.shipX, lock ? lock.y : this.shipY);
      this.cameras.main.setAngle(0);
      this.camRollDeg = 0;
      return;
    }
    const decay = Math.exp(-8 * dt);
    this.kickX *= decay;
    this.kickY *= decay;
    const s = this.trauma.update(dt, timeMs / 1000);
    const cx = lock ? lock.x : this.shipX + this.kickX;
    const cy = lock ? lock.y : this.shipY + this.kickY;
    this.cameras.main.centerOn(cx + s.ox, cy + s.oy);
    this.cameras.main.setAngle(s.rot);
    // syncScreenUi counters this roll on the HUD layer
    this.camRollDeg = s.rot;
  }

  /**
   * Screen-fixed objects (scrollFactor 0) still inherit the main camera's zoom
   * and trauma roll — Phaser transforms them about the viewport centre. Counter
   * both every frame so their local coordinates read as plain CSS pixels
   * anchored at the screen's top-left (minimap corner-pinned, flash
   * full-screen). The gamepad overlay counters the same transform itself.
   */
  private syncScreenUi(): void {
    const { zoom } = this.cameras.main;
    const rot = PhaserMath.DegToRad(this.camRollDeg);
    const cx = this.scale.width / 2;
    const cy = this.scale.height / 2;
    const cos = Math.cos(rot);
    const sin = Math.sin(rot);
    // Anchor = centre + R(−rot)·(0 − centre)/zoom → local (0,0) lands on
    // screen (0,0). Uniform zoom commutes with the rotation, so one matrix
    // order covers Phaser's camera transform.
    const x = cx - (cx * cos + cy * sin) / zoom;
    const y = cy + (cx * sin - cy * cos) / zoom;
    for (const obj of [this.minimapGfx, this.flashRect, this.barrier.vignette]) {
      obj
        .setPosition(x, y)
        .setRotation(-rot)
        .setScale(1 / zoom);
    }
  }

  // ---- display-object factories ---------------------------------------------------------

  /** Hull grows + gains detail per level (1..3): L2 adds swept wings + a
   *  cockpit; L3 adds an inner frame, a nose spike + wingtip nodes. */
  /** Entity stroke width multiplier (qa-011). Zoom is static per viewport, so
   *  hulls built before a resize keep the old weight — the drift is <0.2px
   *  and enemies are short-lived; not worth a rebuild pass. */
  private strokeScale(): number {
    return PhaserMath.Clamp(STROKE_BASE / this.cameras.main.zoom, STROKE_BASE, STROKE_MAX);
  }

  private makeShipGfx(tint: number, level = 1): Phaser.GameObjects.Graphics {
    const g = this.add.graphics().setDepth(10);
    const L = Math.max(1, Math.min(LEVEL_CAP, Math.round(level)));
    const s = shipScaleForLevel(L);
    const sw = this.strokeScale();
    const hull = shipHullPoints(L);
    g.fillStyle(0x05_0c_17, 0.94).fillPoints(
      hull.map((p) => new PhaserMath.Vector2(p.x, p.y)),
      true,
    );
    g.lineStyle(sw * 3, 0x05_0c_17, 0.9);
    strokeClosed(g, hull);
    g.lineStyle(sw, tint, 1);
    strokeClosed(g, hull);
    if (L >= 2) {
      // swept wings
      g.lineBetween(-2 * s, -3 * s, -9 * s, -7 * s);
      g.lineBetween(-2 * s, 3 * s, -9 * s, 7 * s);
      // cockpit
      g.fillStyle(tint, 0.9).fillCircle(2 * s, 0, 1.4 * s);
    }
    if (L >= 3) {
      // inner frame
      g.lineStyle(sw, tint, 0.4);
      strokeClosed(
        g,
        shipHullPoints(L).map((p) => ({ x: p.x * 0.55, y: p.y * 0.55 })),
      );
      g.lineStyle(sw, tint, 1);
      // nose spike
      g.lineBetween(SHIP_RADIUS * s, 0, (SHIP_RADIUS + 4) * s, 0);
      g.fillStyle(0xff_ff_ff, 0.9);
      // wingtip nodes
      g.fillCircle(-9 * s, -7 * s, 1.2 * s);
      g.fillCircle(-9 * s, 7 * s, 1.2 * s);
    }
    return g;
  }

  /** Rebuild a ship's hull when its level changes (preserve transform/visibility). */
  private ensureShipLevel(rec: ShipObjs, level: number): void {
    if (rec.level === level) {
      return;
    }
    rec.level = level;
    const { x, y, rotation, alpha, visible } = rec.gfx;
    rec.gfx.destroy();
    rec.gfx = this.makeShipGfx(rec.tint, level);
    rec.gfx.setPosition(x, y).setRotation(rotation).setAlpha(alpha).setVisible(visible);
  }

  private makeUfoGfx(): Phaser.GameObjects.Graphics {
    const g = this.add.graphics().setDepth(6);
    g.lineStyle(this.strokeScale(), 0xff_ff_ff, 1);
    strokeClosed(g, UFO_OUTLINE);
    const { 2: p2, 3: p3, 6: p6, 7: p7 } = UFO_OUTLINE;
    if (p2 && p3 && p6 && p7) {
      g.lineBetween(p2.x, p2.y, p7.x, p7.y);
      g.lineBetween(p3.x, p3.y, p6.x, p6.y);
    }
    return g;
  }

  private makeEnemyGfx(kind: EnemyKind): Phaser.GameObjects.Graphics {
    const g = this.add.graphics().setDepth(kind === "dreadnought" ? 8 : 7);
    const sw = this.strokeScale();
    g.lineStyle(enemyStrokeWeight(kind) * sw, ENEMY_SPECS[kind].tint, 1);
    const pts = enemyHullPoints(kind);
    g.fillStyle(0x05_0c_17, 0.9).fillPoints(
      pts.map((p) => new PhaserMath.Vector2(p.x, p.y)),
      true,
    );
    g.fillStyle(ENEMY_SPECS[kind].tint, 0.1).fillPoints(
      pts.map((p) => new PhaserMath.Vector2(p.x, p.y)),
      true,
    );
    strokeClosed(g, pts);
    if (kind === "dreadnought") {
      // Bridge dot + cross-struts so the capital ship reads as a boss.
      g.fillStyle(0xff_ff_ff, 0.9).fillCircle(10, 0, 5);
      g.lineStyle(sw, ENEMY_SPECS.dreadnought.tint, 0.7);
      g.lineBetween(-54, 0, 36, 0);
    }
    if (kind === "splitter") {
      // Inner pentagram: connect every other vertex.
      for (let i = 0; i < 5; i += 1) {
        const a = pts[i];
        const b = pts[(i + 2) % 5];
        if (a && b) {
          g.lineBetween(a.x, a.y, b.x, b.y);
        }
      }
    }
    return g;
  }

  /** Self-describing shells: weapon = hexagon + spokes; shield = double
   *  hexagon + its halo glyph; booster = diamond + its effect glyph. */
  private makeItemGfx(it: ItemState): Phaser.GameObjects.Graphics {
    const g = this.add.graphics().setDepth(4);
    const tint = itemTint(it);
    g.lineStyle(1, tint, 1);
    if (it.kind === "booster") {
      strokeDiamond(g, 0, 0, 9);
      const kind = BOOSTER_KINDS[it.boosterIdx] ?? "repair";
      if (kind === "overdrive") {
        // 3 stacked chevrons.
        for (let i = 0; i < 3; i += 1) {
          const y0 = -3 + i * 3;
          g.beginPath();
          g.moveTo(-3, y0 + 2);
          g.lineTo(0, y0 - 1);
          g.lineTo(3, y0 + 2);
          g.strokePath();
        }
      } else if (kind === "nitro") {
        // Flame triangle.
        g.beginPath();
        g.moveTo(0, -4.5);
        g.lineTo(3, 3);
        g.lineTo(-3, 3);
        g.closePath();
        g.strokePath();
      } else if (kind === "repair") {
        // Plus.
        g.lineBetween(-3, 0, 3, 0);
        g.lineBetween(0, -3, 0, 3);
      } else if (kind === "twin") {
        // Two dots.
        g.fillStyle(tint, 1);
        g.fillCircle(-2.5, 0, 1.2);
        g.fillCircle(2.5, 0, 1.2);
      } else {
        // MAGNET: a U.
        g.beginPath();
        g.arc(0, 0.5, 3, 0, Math.PI);
        g.strokePath();
        g.lineBetween(-3, 0.5, -3, -3.5);
        g.lineBetween(3, 0.5, 3, -3.5);
      }
      return g;
    }
    const outer = hexagonPoints(ITEM_DRAW_RADIUS);
    strokeClosed(g, outer);
    if (it.kind === "weapon") {
      for (let i = 0; i < 3; i += 1) {
        const a = outer[i];
        const b = outer[i + 3];
        if (a && b) {
          g.lineBetween(a.x, a.y, b.x, b.y);
        }
      }
      return g;
    }
    strokeClosed(g, hexagonPoints(6));
    const kind = SHIELD_MOD_KINDS[it.shieldIdx] ?? "overshield";
    // Self-describing glyph: the halo shape the pickup grants.
    if (kind === "overshield") {
      strokeRegularPolygon(g, 0, 0, 3, 6, 0);
    } else if (kind === "reflect") {
      strokeRegularPolygon(g, 0, 0, 3, 3, -Math.PI / 2);
    } else if (kind === "ram") {
      g.beginPath();
      g.arc(0, 0, 3, -Math.PI / 4, Math.PI / 4);
      g.strokePath();
    } else if (kind === "phase") {
      for (let i = 0; i < 4; i += 1) {
        const a0 = (Math.PI * 2 * i) / 4;
        g.beginPath();
        g.arc(0, 0, 3, a0, a0 + ((Math.PI * 2) / 4) * 0.55);
        g.strokePath();
      }
    } else if (kind === "siphon") {
      // Double-ring dot.
      g.strokeCircle(0, 0, 3);
      g.fillStyle(tint, 1);
      g.fillCircle(0, 0, 1);
    } else {
      // AEGIS: 4-dot ring.
      g.fillStyle(tint, 1);
      for (let i = 0; i < 4; i += 1) {
        const a0 = (Math.PI * 2 * i) / 4;
        g.fillCircle(Math.cos(a0) * 3, Math.sin(a0) * 3, 0.9);
      }
    }
    return g;
  }

  // ---- minimap + HUD ---------------------------------------------------------------------

  private drawMinimap(now: number): void {
    const g = this.minimapGfx;
    g.clear();
    // trailer HUD policy: no minimap
    if (this.trailer) {
      return;
    }
    // Safe-area insets keep the corner box off the home indicator/notch.
    const x0 = this.scale.width - MINIMAP_W - MINIMAP_PAD - this.safeInset.right;
    const y0 = this.scale.height - MINIMAP_H - MINIMAP_PAD - this.safeInset.bottom;
    g.fillStyle(0x00_00_00, 0.6).fillRoundedRect(x0, y0, MINIMAP_W, MINIMAP_H, 4);
    g.lineStyle(1, 0xff_ff_ff, 0.15).strokeRoundedRect(x0, y0, MINIMAP_W, MINIMAP_H, 4);
    // Map the live PLAY area (not the fixed max) onto the minimap box.
    const map: MinimapFrame = {
      ph: this.world.playH,
      pw: this.world.playW,
      sx: MINIMAP_W / this.world.playW,
      sy: MINIMAP_H / this.world.playH,
      x0,
      y0,
    };
    drawMinimapWorld(g, this.world, map, now);
    for (const it of this.world.items) {
      if (inWorld(it.x, it.y, 0, map.pw, map.ph)) {
        drawMinimapItem(g, it, map);
      }
    }
    const { myId } = this;
    for (const [id, st] of this.peerStates) {
      const isMe = id === myId;
      const tint = this.ships.get(id)?.tint ?? 0xff_ff_ff;
      let px: number;
      let py: number;
      if (isMe) {
        if (!this.spawned || !this.alive) {
          continue;
        }
        px = this.shipX;
        py = this.shipY;
      } else {
        // each dot filtered by ITS player's alive state
        if (!st || !st.alive) {
          continue;
        }
        px = st.x;
        py = st.y;
      }
      g.fillStyle(tint, 1).fillCircle(map.x0 + px * map.sx, map.y0 + py * map.sy, isMe ? 3 : 2);
    }
  }

  // ---- sector cycle (dir-006) ---------------------------------------------------

  /** Sector standings this instant: self live-local, every present remote from
   *  its last wire value. Best-first; id tiebreak so the order converges
   *  identically on every client. */
  private sectorStandings(): { id: string; pts: number }[] {
    const me = this.myId;
    const rows: { id: string; pts: number }[] = [];
    if (me !== null) {
      rows.push({ id: me, pts: Math.round(this.sectorScore) });
    }
    for (const [id, ns] of this.peerStates) {
      if (id === me || !ns || !ns.present) {
        continue;
      }
      rows.push({ id, pts: Math.round(ns.sectorScore) });
    }
    rows.sort((a, b) => b.pts - a.pts || (a.id < b.id ? -1 : 1));
    return rows;
  }

  /** Per-frame sector clock: boundary detection (recap + owner score reset),
   *  the persistent HUD line, the rel-180/360 standings pulses, and recap
   *  expiry. Every write is DOM — the sim is untouched except the owner-side
   *  reset, so the room never stops for any of it. */
  private tickSector(now: number): void {
    const tSec = Math.max(0, (now - this.world.arenaEpoch) / 1000);
    const idx = sectorIdx(tSec);
    const rel = sectorRelT(tSec);
    // First live tick (or a mid-sector joiner): adopt the room's sector
    // silently — no recap for sectors we weren't part of.
    if (this.lastSectorIdx === -1) {
      this.lastSectorIdx = idx;
    }
    if (idx !== this.lastSectorIdx) {
      // Snapshot standings BEFORE the reset — the recap wants final scores.
      // A backwards jump (dev epoch rewind) resyncs without a recap.
      if (idx > this.lastSectorIdx) {
        const rows = this.sectorStandings();
        this.sectorBest = Math.max(this.sectorBest, Math.round(this.sectorScore));
        this.showRecap(this.lastSectorIdx + 1, rows, now);
      }
      // Owner-reset: the boundary is the ONLY thing that zeroes sector pts
      // (deaths cost 0 by construction — nothing else writes this field).
      this.sectorScore = 0;
      this.lastSectorIdx = idx;
    }
    if (this.recapEl) {
      this.recapEl.style.opacity = now < this.recapUntil ? "1" : "0";
    }

    // Persistent line: SECTOR 3 · 4:12 · 1,240 PTS · 2ND (solo: rank omitted).
    const rows = this.sectorStandings();
    const myRank = rows.findIndex((r) => r.id === this.myId) + 1;
    const remS = Math.max(0, Math.ceil(SECTOR_LENGTH_S - rel));
    let line =
      `SECTOR ${idx + 1} · ${Math.floor(remS / 60)}:${String(remS % 60).padStart(2, "0")}` +
      ` · ${fmtPts(Math.round(this.sectorScore))} PTS`;
    if (rows.length > 1 && myRank > 0) {
      line += ` · ${ordinal(myRank)}`;
    }
    if (line !== this.lastSectorLine) {
      this.lastSectorLine = line;
      setText(this.sectorEl, line);
    }

    // Standings pulse fills the two beacon-free troughs; never stacked on top
    // of a boss fight or the recap (they own the player's attention).
    const bossLive = this.world.enemies.some((e) => e.kind === "dreadnought");
    const inPulse = SECTOR_PULSE_AT_S.some((at) => rel >= at && rel < at + SECTOR_PULSE_S);
    const showPulse = inPulse && !bossLive && now >= this.recapUntil;
    if (this.pulseEl) {
      this.pulseEl.style.opacity = showPulse ? "1" : "0";
    }
    if (showPulse) {
      const text = this.pulseText(rows, myRank);
      if (text !== this.lastPulseText) {
        this.lastPulseText = text;
        setText(this.pulseEl, text);
      }
    }
  }

  /** Standings pulse copy: my gap to the leader in a room, else my points
   *  (+ session best) solo. */
  private pulseText(rows: { id: string; pts: number }[], myRank: number): string {
    const [leader] = rows;
    if (rows.length > 1 && myRank > 0 && leader) {
      if (myRank === 1) {
        return `1ST · ${fmtPts(leader.pts - (rows[1]?.pts ?? 0))} AHEAD`;
      }
      const gap = leader.pts - Math.round(this.sectorScore);
      return `${ordinal(myRank)} · ${fmtPts(gap)} BEHIND ${callsign(leader.id)}`;
    }
    const best = this.sectorBest > 0 ? ` · SESSION BEST ${fmtPts(this.sectorBest)}` : "";
    return `${fmtPts(Math.round(this.sectorScore))} PTS${best}`;
  }

  /** Boundary recap: standings snapshot into #recap for SECTOR_RECAP_SHOW_S.
   *  Non-blocking DOM (pointer-events: none) — sim, input and firing continue
   *  behind it; tickSector fades it out on schedule. */
  private showRecap(completedNum: number, rows: { id: string; pts: number }[], now: number): void {
    this.recapUntil = now + SECTOR_RECAP_SHOW_S * 1000;
    // One chime from the gold shared-event family (beacon vocabulary, no new synth).
    sfx.play("beacon_active", { gain: 0.6, rate: 1.3 });
    const el = this.recapEl;
    if (!el) {
      return;
    }
    let html = `<h2>SECTOR ${completedNum} COMPLETE</h2>`;
    if (rows.length <= 1) {
      html += `<div class="row">${fmtPts(rows[0]?.pts ?? 0)} PTS</div>`;
      html += `<div class="recap-best">SESSION BEST ${fmtPts(this.sectorBest)}</div>`;
    } else {
      const entries = rows.map((r, i) => ({
        name: r.id === this.myId ? "YOU" : callsign(r.id),
        pts: r.pts,
        rank: i + 1,
      }));
      const shown = entries.slice(0, 3);
      const mine = entries.find((e) => e.name === "YOU");
      if (mine && mine.rank > 3) {
        shown.push(mine);
      }
      html += shown
        .map((e) => {
          const gold = e.rank === 1 ? ` style="color:${hexCss(BEACON_TINT)}"` : "";
          return `<div class="row"${gold}>${ordinal(e.rank)} · ${e.name} · ${fmtPts(e.pts)}</div>`;
        })
        .join("");
    }
    const currentSector = sectorIdx(Math.max(0, (now - this.world.arenaEpoch) / 1000)) + 1;
    html += `<div class="recap-handoff">SECTOR ${currentSector} · FLIGHT CONTINUES</div>`;
    el.innerHTML = html;
    // dir-009 presence pass: restart the 300ms scale-in alongside the fade,
    // then one winner-row pop ~150ms after the banner lands. DOM-only — the
    // banner stays non-blocking (pointer-events: none, no shake, no input).
    el.classList.remove("in");
    // reflow so back-to-back recaps re-run the animation
    void el.offsetWidth;
    el.classList.add("in");
    // The row accent is CSS-owned; replacing the recap cannot leave a stale timer.
  }

  private updateHud(now: number): void {
    const presentation = this.started && !this.trailer;
    this.flightHud.update({
      active: presentation && this.spawned && this.alive && !this.paused && !this.frozen,
      level: this.level,
      mastery: this.mastery.state,
      now,
      weaponUntil: this.weaponUntil,
      xp: this.xp,
    });
    const boss = this.world.enemies.find(
      (e) => e.kind === "dreadnought" && e.hp > 0 && e.maxHp > 0,
    );
    this.updateBossBar(boss ?? null, presentation);
    const inFlight = presentation && this.spawned && this.alive && !this.paused;
    if (inFlight) {
      sfx.setMusicMode(boss ? "boss" : "flight");
    } else {
      sfx.setMusicMode("silent");
    }
    this.updateWeaponHud(now);
    this.updateShieldHud(now);
    this.updateBoostsHud(now);
    this.updateComboHud(now);
    const n = Object.keys(this.peers).length;
    setText(this.playersEl, this.playersLabel(n));
    this.updateRecovery(now, presentation);
  }

  private updateBossBar(boss: EnemyState | null, presentation: boolean): void {
    if (!this.bossBarEl || !this.bossHpEl) {
      return;
    }
    this.bossBarEl.hidden = !presentation || !boss;
    this.bossBarEl.style.opacity = boss ? "1" : "0";
    if (boss) {
      const percent = PhaserMath.Clamp((boss.hp / boss.maxHp) * 100, 0, 100);
      this.bossHpEl.style.width = `${percent.toFixed(1)}%`;
      setText(this.bossLabelEl, `DREADNOUGHT · PHASE ${bossPhase(boss.hp, boss.maxHp)}`);
      setAttribute(this.bossBarEl, "aria-valuenow", String(Math.round(percent)));
    }
  }

  private updateWeaponHud(now: number): void {
    setText(this.weaponEl, this.weapon.name);
    if (!this.weaponBarEl) {
      return;
    }
    // A special is active iff weaponUntil is in the future; base weapons show
    // no bar. Stacked pickups can push the timer past one base duration: clamp
    // the bar full; the adjacent seconds retain the complete accepted time.
    const frac =
      this.weaponUntil <= now
        ? 0
        : Math.min(1, Math.max(0, (this.weaponUntil - now) / SPECIAL_WEAPON_DURATION_MS));
    this.weaponBarEl.style.width = `${(frac * 100).toFixed(1)}%`;
    this.weaponBarEl.style.background = hexCss(this.weapon.tint);
  }

  private updateShieldHud(now: number): void {
    if (!this.shieldEl) {
      return;
    }
    if (!this.alive || !this.spawned) {
      this.shieldEl.style.display = "none";
      return;
    }
    this.shieldEl.style.display = "block";
    // SIPHON overheal: the fill runs past the base 40px track (≤1.3×,
    // SIPHON_OVERHEAL_MAX) and tints green while banked above 100.
    const overhealCap = SIPHON_OVERHEAL_MAX / SHIELD_MAX;
    const frac = Math.max(0, Math.min(overhealCap, this.shieldHp / SHIELD_MAX));
    if (this.shieldFillEl) {
      this.shieldFillEl.style.width = `${(frac * 40).toFixed(1)}px`;
      this.shieldFillEl.style.background =
        this.shieldHp > SHIELD_MAX ? hexCss(SHIELD_MOD_SPECS.siphon.tint) : "";
    }
    if (this.shieldOsEl) {
      this.shieldOsEl.style.width = `${((Math.max(0, this.overHp) / OVERSHIELD_BONUS) * 30).toFixed(1)}px`;
    }
    this.shieldEl.classList.toggle("low", this.shieldHp < SHIELD_MAX * SHIELD_LOW_FRACTION);
    this.updateShieldModHud(now);
  }

  private updateShieldModHud(now: number): void {
    const mod = this.shieldMod;
    if (this.shieldModEl) {
      this.shieldModEl.style.display = mod ? "block" : "none";
      if (mod) {
        this.shieldModEl.style.color = hexCss(SHIELD_MOD_SPECS[mod].tint);
        setText(this.shieldModEl, SHIELD_MOD_SPECS[mod].name);
      }
    }
    if (this.shieldModBarEl) {
      const mfrac = mod
        ? Math.min(1, Math.max(0, (this.shieldModUntil - now) / SHIELD_MOD_DURATION_MS))
        : 0;
      this.shieldModBarEl.style.width = `${(mfrac * 100).toFixed(1)}%`;
      if (mod) {
        this.shieldModBarEl.style.background = hexCss(SHIELD_MOD_SPECS[mod].tint);
      }
    }
  }

  private updateBoostsHud(now: number): void {
    if (!this.boostsEl) {
      return;
    }
    const parts: string[] = [];
    if (this.alive) {
      for (const [kind, until] of this.boosts) {
        const secs = Math.max(0, Math.ceil((until - now) / 1000));
        const spec = BOOSTER_SPECS[kind];
        parts.push(`<span style="color:${hexCss(spec.tint)}">${spec.name} ${secs}</span>`);
      }
    }
    const html = parts.join(" &middot; ");
    if (html !== this.lastBoostsHtml) {
      this.lastBoostsHtml = html;
      this.boostsEl.innerHTML = html;
    }
  }

  private updateComboHud(now: number): void {
    if (!this.comboEl) {
      return;
    }
    const mult = comboMult(this.streak);
    const show = mult >= 2 && this.alive;
    this.comboEl.style.opacity = show ? "1" : "0";
    if (show) {
      setText(this.comboValEl, `×${mult} · ${this.streak}`);
      if (this.comboBarEl) {
        const frac = Math.max(0, (this.comboExpiresAt - now) / COMBO_WINDOW_MS);
        this.comboBarEl.style.width = `${(frac * 100).toFixed(1)}%`;
      }
    }
  }

  private playersLabel(n: number): string {
    if (this.offline) {
      return "solo · offline";
    }
    if (this.connected) {
      return `${n} player${n === 1 ? "" : "s"}`;
    }
    return "reconnecting…";
  }

  /** Encounter edges are tracked even while the cues are silent (start screen,
   * trailer), so starting never replays history. */
  private observeBossEncounters(world: SharedState): void {
    const cues = this.bossEncounters.observe(world.arenaEpoch, world.enemies);
    if (!this.started || this.trailer) {
      return;
    }
    for (const cue of cues) {
      if (cue.kind === "arrival") {
        sfx.play("boss_arrival");
      } else if (cue.kind === "phase") {
        sfx.play("boss_phase");
      } else {
        sfx.play("boss_defeat");
        this.battleBeat.bossDefeated(simNow(), world.arenaEpoch);
      }
    }
  }

  private updateBattlePresentation(now: number): void {
    const beat = this.battleBeat.update({
      bossAlive: this.world.enemies.some((enemy) => enemy.kind === "dreadnought" && enemy.hp > 0),
      epoch: this.world.arenaEpoch,
      now,
      presenting:
        this.live &&
        this.started &&
        this.spawned &&
        this.alive &&
        !this.paused &&
        !this.frozen &&
        !this.trailer,
    });
    this.battleBackdrop.update(beat);
    sfx.setBattleBeat(beat);
  }

  private updateRecovery(now: number, presentation: boolean): void {
    const recovering = presentation && this.spawned && !this.alive && this.respawnAt > 0;
    if (this.overlayEl) {
      this.overlayEl.hidden = !recovering;
      this.overlayEl.style.opacity = recovering ? "1" : "0";
    }
    // Hiding for recovery never changes the original recap expiry.
    if (this.recapEl) {
      this.recapEl.hidden = !presentation || recovering || now >= this.recapUntil;
    }
    if (this.pulseEl) {
      this.pulseEl.hidden = !presentation || recovering;
    }
    if (!recovering) {
      return;
    }
    const remaining = PhaserMath.Clamp(this.respawnAt - now, 0, RESPAWN_DELAY_MS);
    const progress = 1 - remaining / RESPAWN_DELAY_MS;
    setText(this.causeEl, this.deathCause ? `— ${this.deathCause}` : "");
    setText(this.hintEl, this.deathHint);
    setText(this.countdownEl, `Re-entry in ${(remaining / 1000).toFixed(1)}s`);
    setText(
      this.recoveryLoadoutEl,
      `RETURN WITH LEVEL ${this.level} ${baseWeaponForLevel(this.level).name} + FULL SHIELD`,
    );
    if (this.recoveryFillEl) {
      this.recoveryFillEl.style.transform = `scaleX(${progress})`;
    }
    setAttribute(this.recoveryProgressEl, "aria-valuenow", String(Math.round(progress * 100)));
  }

  // ---- trailer staging (src/trailer/trailer-director.ts) -----------------------------------

  /** Install the trailer staging overrides and return the scripted-staging
   *  surface. Only ever called by the trailer director under ?trailer=1 (the
   *  same query flag that forced this session offline in create()), so none
   *  of this runs in normal play. Every lever routes through the same code
   *  paths gameplay uses — spawn factories, hostDamageEnemy, gainXp, die —
   *  so staged shots are real gameplay. */
  trailerStage(): TrailerStageApi {
    const staging: TrailerStaging = {
      camPos: null,
      deathless: true,
      fire: false,
      frame: null,
      peers: null,
      steer: null,
    };
    this.trailer = staging;
    return {
      clearAsteroids: (): void => {
        // Silent: the display sweep in syncAsteroids bursts any rock whose
        // state vanished, and 14 of those would play on the next reveal.
        this.world.asteroids = [];
        for (const [, rec] of this.asteroidObjs) {
          this.tweens.killTweensOf(rec.gfx);
          rec.gfx.destroy();
        }
        this.asteroidObjs.clear();
        this.dirty.asteroids = true;
      },
      clearWorld: (): void => {
        sfx.stopAll();
        this.bossEncounters.reset();
        this.battleBeat.reset();
        this.fx.reset();
        const w = this.world;
        w.enemies = [];
        w.enemyShots = [];
        w.items = [];
        w.shards = [];
        w.pulls = [];
        w.beacon = null;
        w.ufo = null;
        // Re-stage from "arena just opened": keeps the organic director (safe
        // opening, spawn intervals, beacon cadence, boss guarantee) asleep for
        // the whole shot — everything on screen is placed by the director.
        w.arenaEpoch = simNow();
        this.enemySim.clear();
        this.lastEnemySpawnAt = simNow();
        this.lastAsteroidSpawnAt = simNow();
        this.lastBeacon = null;
        this.beams = [];
        this.sentry = null;
        this.splinters = [];
        this.muzzleFlashes = [];
        this.predictedKills.clear();
        this.recentPickups.clear();
        this.recentShardPickups.clear();
        this.recentConsumedShots.clear();
        // Silent display cleanup — bypass the death-FX removal sweeps so a
        // cleared crowd doesn't explode into 40 shatters on the next cut.
        this.ufoGfx?.destroy();
        this.ufoGfx = null;
        this.ufoId = "";
        for (const [, rec] of this.enemyObjs) {
          rec.gfx.destroy();
        }
        this.enemyObjs.clear();
        for (const [, rec] of this.itemObjs) {
          this.tweens.killTweensOf(rec.gfx);
          rec.gfx.destroy();
        }
        this.itemObjs.clear();
        // Pilot combat state back to a clean baseline.
        this.streak = 0;
        this.comboTier = 1;
        this.comboExpiresAt = 0;
        this.windupAcc = 0;
        this.shootCooldown = 0;
        this.shieldHp = SHIELD_MAX;
        this.overHp = 0;
        this.shieldMod = null;
        this.shieldModUntil = 0;
        this.boosts.clear();
        this.invulnUntil = 0;
        this.phasedUntil = 0;
        this.contactIframeUntil = 0;
        this.impactArcs = [];
        this.kickX = 0;
        this.kickY = 0;
      },
      damageEnemy: (id, amount): void => this.hostDamageEnemy(id, amount, 0, 0),
      enemies: (): readonly Readonly<EnemyState>[] => this.world.enemies,
      forceStart: (): void => this.forceOfflineSolo(),
      grantBooster: (kind): void => {
        if (kind === "repair") {
          this.shieldHp = Math.max(this.shieldHp, SHIELD_MAX);
          this.lastDamageAt = 0;
        } else {
          this.boosts.set(kind, simNow() + BOOSTER_SPECS[kind].durationMs);
        }
      },
      grantShieldMod: (kind): void => {
        const now = simNow();
        this.shieldMod = kind;
        this.shieldModUntil = now + SHIELD_MOD_DURATION_MS;
        this.overHp = kind === "overshield" ? OVERSHIELD_BONUS : 0;
        // blink armed from frame one
        this.phaseReadyAt = 0;
      },
      grantWeapon: (name): void => {
        const weapon = WEAPONS_SPECIAL.find((w) => w.name === name);
        if (!weapon) {
          return;
        }
        this.specialBase = weapon;
        this.weapon = scaleWeaponForLevel(weapon, this.level);
        this.weaponUntil = simNow() + SPECIAL_WEAPON_DURATION_MS;
        this.windupAcc = 0;
        // A staged swap starts its cadence now. Left alone, the outgoing
        // weapon's residual cooldown carries over, so a mid-shot swap to a
        // fast weapon can sit silent for most of a second — long enough to
        // push the beat it was granted for past the cut.
        this.shootCooldown = 0;
      },
      grantXp: (amount): void => this.gainXp(amount, simNow()),
      killEnemy: (id): void => {
        const idx = this.world.enemies.findIndex((en) => en.id === id);
        if (idx !== -1) {
          this.hostKillEnemy(idx);
        }
      },
      killPlayer: (cause): void => {
        if (!this.alive) {
          return;
        }
        this.shieldHp = 0;
        this.overHp = 0;
        this.die(simNow(), null, cause);
      },
      player: () => ({
        alive: this.alive,
        angle: this.shipAngle,
        level: this.level,
        shieldHp: this.shieldHp,
        vx: this.shipVX,
        vy: this.shipVY,
        weapon: this.weapon.name,
        x: this.shipX,
        y: this.shipY,
      }),
      setEnemyHp: (id, hp): void => {
        const e = this.world.enemies.find((en) => en.id === id);
        if (e) {
          e.hp = Math.max(1, hp);
        }
      },
      setLevel: (level, xpIntoLevel = 0): void => {
        this.level = Math.max(1, Math.min(LEVEL_CAP, Math.round(level)));
        this.xp = Math.max(0, xpIntoLevel);
        this.specialBase = null;
        this.weaponUntil = 0;
        this.applyBaseLoadout(simNow());
      },
      setPlayerPose: (pose): void => {
        this.spawned = true;
        this.alive = true;
        this.paused = false;
        this.respawnAt = 0;
        // no spawn blink on camera
        this.invulnUntil = 0;
        this.shipX = pose.x;
        this.shipY = pose.y;
        if (pose.angle !== undefined) {
          this.shipAngle = pose.angle;
        }
        this.shipVX = pose.vx ?? 0;
        this.shipVY = pose.vy ?? 0;
        // Rocks deliberately survive clearWorld() (they are the arena's only
        // ambience), which means one staged for an earlier shot can be sitting
        // exactly where a later shot puts the ship — and asteroidContactDamage
        // then opens the scene by taking most of the shield. Clear the landing
        // zone. Silently: the display sweep bursts any asteroid whose state
        // vanished, and that burst would play on the reveal.
        for (let i = this.world.asteroids.length - 1; i >= 0; i -= 1) {
          const a = this.world.asteroids[i];
          if (!a) {
            continue;
          }
          const clear = a.radius + 70;
          if (dist2(a.x, a.y, pose.x, pose.y) > clear * clear) {
            continue;
          }
          this.world.asteroids.splice(i, 1);
          const rec = this.asteroidObjs.get(a.id);
          if (rec) {
            this.tweens.killTweensOf(rec.gfx);
            rec.gfx.destroy();
            this.asteroidObjs.delete(a.id);
          }
          this.dirty.asteroids = true;
        }
        this.cameras.main.centerOn(pose.x, pose.y);
      },
      setShieldHp: (hp): void => {
        this.shieldHp = Math.max(0, Math.min(SIPHON_OVERHEAL_MAX, hp));
      },
      setXp: (xpIntoLevel): void => {
        this.xp = Math.max(0, xpIntoLevel);
      },
      spawnAsteroid: (x, y, radius): void => {
        const a = spawnOpeningAsteroid(x, y);
        a.radius = PhaserMath.Clamp(radius, ASTEROID_MIN_RADIUS, ASTEROID_MAX_RADIUS);
        // Same reason as spawnItem, plus one more: rocks survive clearWorld(),
        // so a drifting staged rock wanders into later shots it was never
        // composed for.
        a.vx = 0;
        a.vy = 0;
        this.world.asteroids.push(a);
        this.dirty.asteroids = true;
      },
      spawnBeacon: (x, y, chargeS, activeS): void =>
        this.hostSpawnBeacon(x, y, simNow(), chargeS, activeS),
      spawnEnemy: (kind, x, y, aimAt): string => {
        const e = spawnEnemyState(kind, x, y);
        if (aimAt) {
          e.angle = Math.atan2(aimAt.y - y, aimAt.x - x);
        }
        if (kind === "dreadnought") {
          e.hp = bossHp(Math.max(1, Object.keys(this.peers).length));
          e.maxHp = e.hp;
        } else if (ELITE_HP_BASE.has(kind)) {
          e.hp = eliteHp(kind, this.maxPresentLevel());
          e.maxHp = e.hp;
        }
        this.world.enemies.push(e);
        this.dirty.enemies = true;
        return e.id;
      },
      spawnItem: (cls, name, x, y): void => {
        let drop: ItemDrop | null = null;
        if (cls === "weapon") {
          const i = WEAPONS_SPECIAL.findIndex((w) => w.name === name);
          if (i !== -1) {
            drop = { kind: "weapon", weaponIdx: i };
          }
        } else if (cls === "shield") {
          const i = kindIndex(SHIELD_MOD_KINDS, name);
          if (i !== -1) {
            drop = { kind: "shield", shieldIdx: i };
          }
        } else {
          const i = kindIndex(BOOSTER_KINDS, name);
          if (i !== -1) {
            drop = { boosterIdx: i, kind: "booster" };
          }
        }
        if (!drop) {
          return;
        }
        const item = spawnItemState(x, y, drop);
        // Park it: the factory's 30 px/s scatter is drawn from the seeded
        // gameplay RNG, and over a ~0.7s approach it walks the crystal clear
        // of the 15px pickup radius the shot was composed around.
        item.vx = 0;
        item.vy = 0;
        this.world.items.push(item);
        this.dirty.items = true;
      },
      spawnShards: (count, x, y): void => this.hostSpawnShards(x, y, count),
      staging,
      worldSize: () => ({ h: this.world.playH, w: this.world.playW }),
    };
  }

  // ---- dev hooks (headless driving for reviewers) ------------------------------------------

  private installDevHooks(): void {
    if (!import.meta.env.DEV) {
      return;
    }
    window.__starfall = {
      client: this.client,
      /** Run a drain through the real applyDamage pipeline. */
      damage: (amount: number): string =>
        this.applyDamage(amount, this.shipX + 12, this.shipY, "DEV", null, simNow()),
      /** Host only: run damage through the real hostDamageEnemy pipeline
       *  (warden DR, boss phase floors, kill/loot). Returns the enemy's
       *  post-damage hp, or null if it died/never existed. */
      damageEnemy: (id: string, amount: number): number | null => {
        if (!this.amHost) {
          return null;
        }
        this.hostDamageEnemy(id, amount, 0, 0);
        return this.world.enemies.find((e) => e.id === id)?.hp ?? null;
      },
      /** Host only: shed score shards near the ship. */
      dropShards: (count: number, x?: number, y?: number): void => {
        if (!this.amHost) {
          return;
        }
        this.hostSpawnShards(x ?? this.shipX + 120, y ?? this.shipY, count);
      },
      /** Fire one volley of the current weapon, no pointer needed. */
      fire: (): void => {
        this.fireWeapon(simNow());
      },
      /** Grant a booster by kind name (repair applies instantly). */
      grantBooster: (raw: string): void => {
        const kind = BOOSTER_KINDS.find((k) => k === raw.toLowerCase());
        if (!kind) {
          return;
        }
        if (kind === "repair") {
          this.shieldHp = Math.max(this.shieldHp, SHIELD_MAX);
          this.lastDamageAt = 0;
        } else {
          this.boosts.set(kind, simNow() + BOOSTER_SPECS[kind].durationMs);
        }
      },
      /** Grant a shield MOD by kind name (validated — bad kinds are ignored). */
      grantShield: (raw: string): void => {
        const lowered = raw.toLowerCase();
        const kind = SHIELD_MOD_KINDS.find((k) => k === lowered);
        if (!kind) {
          return;
        }
        const now = simNow();
        this.shieldMod = kind;
        this.shieldModUntil = now + SHIELD_MOD_DURATION_MS;
        this.overHp = kind === "overshield" ? OVERSHIELD_BONUS : 0;
        this.phaseReadyAt = 0;
      },
      grantWeapon: (ref: number | string): void => {
        // One pass covers both call shapes: a number ref matches its index
        // (never a name), a string ref matches its name (never an index).
        const weapon = WEAPONS_SPECIAL.find((w, i) => w.name === ref || i === ref);
        if (!weapon) {
          return;
        }
        this.specialBase = weapon;
        this.weapon = scaleWeaponForLevel(weapon, this.level);
        this.weaponUntil = simNow() + SPECIAL_WEAPON_DURATION_MS;
        this.windupAcc = 0;
      },
      intensity: (): number =>
        arenaIntensity(Math.max(0, (simNow() - this.world.arenaEpoch) / 1000)),
      scene: this,
      /** Host only: rewind/forward the intensity director. */
      setArenaEpoch: (epochMs: number): void => {
        if (!this.amHost) {
          return;
        }
        this.world.arenaEpoch = epochMs;
        if (!this.offline) {
          this.client.updateSharedState({ arenaEpoch: epochMs });
        }
      },
      /** Set the base shield directly; stamps the damage clock so regen
       *  behaves as after a real drain. 0 = death (via the real pipeline). */
      setShield: (hp: number): void => {
        const now = simNow();
        this.shieldHp = Math.min(SIPHON_OVERHEAL_MAX, hp);
        this.lastDamageAt = now;
        this.regenActive = false;
        if (this.shieldHp <= 0 && this.alive) {
          this.die(now, null, "DEV");
        }
      },
      /** Host only: force-spawn a BEACON at (x,y) (defaults near the ship).
       *  Custom charge/active seconds exist for compressed-timer e2e probes;
       *  the real cadence gates are deliberately bypassed. */
      spawnBeacon: (x?: number, y?: number, chargeS?: number, activeS?: number): boolean => {
        if (!this.amHost) {
          return false;
        }
        this.hostSpawnBeacon(x ?? this.shipX + 200, y ?? this.shipY, simNow(), chargeS, activeS);
        return true;
      },
      /** Host only: spawn an enemy near (or at) the given point. Elites get
       *  the same qa-018 level-scaled HP stamp as the organic spawn path, so
       *  probes measure shipping durability. */
      spawnEnemy: (kind: EnemyKind, x?: number, y?: number): string | null => {
        if (!this.amHost) {
          return null;
        }
        const e = spawnEnemyState(kind, x ?? this.shipX + 320, y ?? this.shipY);
        if (ELITE_HP_BASE.has(kind)) {
          e.hp = eliteHp(kind, this.maxPresentLevel());
          e.maxHp = e.hp;
        }
        this.world.enemies.push(e);
        this.dirty.enemies = true;
        return e.id;
      },
      /** Host only: drop a live item at (x,y) (defaults to the ship, so it gets
       *  picked up next frame, which is how stacking is exercised). */
      spawnItem: (cls: "weapon" | "shield" | "booster", name: string, x?: number, y?: number) => {
        if (!this.amHost) {
          return;
        }
        let drop: ItemDrop | null = null;
        if (cls === "weapon") {
          const i = WEAPONS_SPECIAL.findIndex((w) => w.name === name.toUpperCase());
          if (i !== -1) {
            drop = { kind: "weapon", weaponIdx: i };
          }
        } else if (cls === "shield") {
          const i = kindIndex(SHIELD_MOD_KINDS, name.toLowerCase());
          if (i !== -1) {
            drop = { kind: "shield", shieldIdx: i };
          }
        } else {
          const i = kindIndex(BOOSTER_KINDS, name.toLowerCase());
          if (i !== -1) {
            drop = { boosterIdx: i, kind: "booster" };
          }
        }
        if (!drop) {
          return;
        }
        this.world.items.push(spawnItemState(x ?? this.shipX, y ?? this.shipY, drop));
        this.dirty.items = true;
      },
      summary: (): StarfallSummary => ({
        alive: this.alive,
        asteroids: this.world.asteroids.length,
        beams: this.beams.length,
        boosts: this.boostsNetState(),
        enemies: this.world.enemies.map((e) => e.kind),
        enemyShots: this.world.enemyShots.length,
        intensity: arenaIntensity(Math.max(0, (simNow() - this.world.arenaEpoch) / 1000)),
        isHost: this.amHost,
        items: this.world.items.map((it) => it.kind),
        level: this.level,
        mines: this.beams.filter((b) => b.mine && !b.exploding && !b.vanished).length,
        mod: this.shieldMod ? { kind: this.shieldMod, until: this.shieldModUntil } : null,
        now: simNow(),
        overHp: this.overHp,
        pulls: this.world.pulls.length,
        recovery: {
          protectionMs: this.alive ? Math.max(0, this.invulnUntil - simNow()) : 0,
          recapUntil: this.recapUntil,
          remainingMs: this.spawned && !this.alive ? Math.max(0, this.respawnAt - simNow()) : 0,
        },
        regen: this.regenActive,
        runXp: this.runXp,
        sector: {
          best: this.sectorBest,
          bossIdx: this.world.sectorBossIdx,
          idx: sectorIdx(Math.max(0, (simNow() - this.world.arenaEpoch) / 1000)),
          rel: sectorRelT(Math.max(0, (simNow() - this.world.arenaEpoch) / 1000)),
          score: Math.round(this.sectorScore),
        },
        sentry: this.sentry ? { x: this.sentry.x, y: this.sentry.y } : null,
        shards: this.world.shards.length,
        shieldHp: Math.round(this.shieldHp * 10) / 10,
        streak: this.streak,
        weapon: this.weapon.name,
        weaponUntil: this.weaponUntil,
        windup: this.windupFrac(),
        xp: this.xp,
        xpToNext: xpToNext(this.level),
      }),
    };
  }
}

/** Diag snapshot surfaced to headless reviewers via `__starfall.summary()`. */
interface StarfallSummary {
  alive: boolean;
  level: number;
  xp: number;
  runXp: number;
  xpToNext: number;
  streak: number;
  weapon: string;
  weaponUntil: number;
  windup: number;
  shieldHp: number;
  overHp: number;
  regen: boolean;
  mod: { kind: ShieldModKind; until: number } | null;
  boosts: BoostNetState[];
  mines: number;
  sentry: { x: number; y: number } | null;
  pulls: number;
  enemies: EnemyKind[];
  enemyShots: number;
  asteroids: number;
  items: ItemState["kind"][];
  shards: number;
  beams: number;
  isHost: boolean;
  intensity: number;
  now: number;
  recovery: { remainingMs: number; protectionMs: number; recapUntil: number };
  sector: { idx: number; rel: number; score: number; best: number; bossIdx: number };
}

/** The dev-only driving hooks installed on `window.__starfall` (DEV builds
 *  only — headless reviewers poke the game through these). */
interface StarfallDevHooks {
  scene: GameScene;
  client: MultiplayerClient;
  spawnEnemy: (kind: EnemyKind, x?: number, y?: number) => string | null;
  damageEnemy: (id: string, amount: number) => number | null;
  grantShield: (raw: string) => void;
  grantBooster: (raw: string) => void;
  setShield: (hp: number) => void;
  damage: (amount: number) => string;
  grantWeapon: (ref: number | string) => void;
  spawnItem: (cls: "weapon" | "shield" | "booster", name: string, x?: number, y?: number) => void;
  dropShards: (count: number, x?: number, y?: number) => void;
  fire: () => void;
  spawnBeacon: (x?: number, y?: number, chargeS?: number, activeS?: number) => boolean;
  setArenaEpoch: (epochMs: number) => void;
  intensity: () => number;
  summary: () => StarfallSummary;
}

declare global {
  interface Window {
    __starfall?: StarfallDevHooks;
  }
}
