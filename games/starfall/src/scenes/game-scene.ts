import { PhysicalGamepad, attachVirtualGamepad, safeAreaInset } from "@vibedgames/gamepad/phaser";
import type { Inset, PhaserGamepad } from "@vibedgames/gamepad/phaser";
import { notifyGameStarted, setPauseHandlers, watchControlContext } from "@repo/embed";
import { MultiplayerClient } from "@vibedgames/multiplayer";
import type { Player, PlayerMap } from "@vibedgames/multiplayer";
import Phaser from "phaser";

import { sfx } from "../audio/sfx";
import type { PlayOpts, SfxName } from "../audio/sfx";
import {
  buildControls,
  createStarfallPauseOverlay,
  ensureStyle as ensureControlsStyle,
} from "../pause-overlay";
import { AttractBattle } from "../fx/attract-battle";
import { FxPool, HITSPARK_SKIP_BUDGET, PARTICLE_SOFT_BUDGET } from "../render/fx-pool";
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
  type EnemyState,
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
  type AsteroidState,
  type BoosterKind,
  type BoostNetState,
  type EnemyKind,
  type BeaconState,
  type EnemyShotState,
  type ItemDrop,
  type ItemState,
  type LootClass,
  type PlayerNetState,
  type SerializedBeam,
  type SharedState,
  type ShieldModKind,
  type ShieldModNetState,
  type Vec,
  type Weapon,
  type WeaponSfx,
} from "../shared/constants";
import { now as simNow, pauseClock, resumeClock } from "../shared/clock";
import { diag, installTestHooks } from "../shared/diag";
import { rand } from "../shared/rng";

/** What a HOMING beam (or ARC hop) is steering toward / hit. */
type TargetRef =
  | { kind: "enemy"; id: string }
  | { kind: "player"; id: string }
  | { kind: "ufo" }
  | { kind: "asteroid"; id: string };

/** A locally-simulated beam (only ever our own — remote beams arrive serialized). */
type Beam = {
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
};

type ShipObjs = {
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
  /** Last seen base shieldHp — a decrease between snapshots = hit flash.
   *  Base shield only: overHp zeroes on overshield expiry/replacement with
   *  no damage, so a combined total would phantom-flash. */
  lastShieldHp: number;
  /** Ring hit-flash window. */
  flashUntil: number;
  /** Ring regen visual window (an increase between snapshots opens it). */
  regenUntil: number;
};
type AsteroidObjs = { gfx: Phaser.GameObjects.Graphics; drawnRadius: number };
type ItemObjs = { gfx: Phaser.GameObjects.Graphics; tint: number };
type EnemyObjs = {
  gfx: Phaser.GameObjects.Graphics;
  kind: EnemyKind;
  /** Dedupe telegraph_warn: remember the last telegraph window we voiced. */
  lastTelegraphUntil: number;
  /** Lancer close-pass trauma fires once per charge. */
  chargeTraumaDone: boolean;
};

type Splinter = {
  originX: number;
  originY: number;
  angle: number;
  dist: number;
  speed: number;
  diesAt: number;
  x: number;
  y: number;
};

/** Transient muzzle flash strokes (1–2 frames), drawn additively. */
type MuzzleFlash = {
  x: number;
  y: number;
  angle: number;
  size: number;
  tint: number;
  diesAt: number;
  kind: "cross" | "line" | "ring";
};

/** Host-private per-enemy AI bookkeeping (lost on migration — acceptable). */
type EnemySim = {
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
};

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
/** ARC per-hop falloff for victim-side chain drains. SerializedBeam carries
 *  no weapon ref, so read it from the ARC spec (TESLA also carries an arc
 *  spec, hence the !aura filter). */
const ARC_FALLOFF = WEAPONS_SPECIAL.find((w) => w.arc !== null && !w.aura)?.arc?.falloff ?? 0.7;
/** TESLA AURA spec for victim-side adjudication (the RAM pattern: power and
 *  range come from the shared table, not the wire). */
const TESLA_SPEC = WEAPONS_SPECIAL.find((w) => w.aura);
const TESLA_POWER = TESLA_SPEC?.power ?? 0.27;
const TESLA_RANGE = TESLA_SPEC?.arc?.castRange ?? 120;
const TESLA_TINT = TESLA_SPEC?.tint ?? 0x00aaff;
/** SENTRY stat block: the turret keeps firing it even after the owner's
 *  weapon slot moves on (the turret outlives the trigger). */
const SENTRY_WEAPON = WEAPONS_SPECIAL.find((w) => w.sentry) ?? WEAPON_DEFAULT;
const SINGULARITY_TINT = WEAPONS_SPECIAL.find((w) => w.singularity)?.tint ?? 0x7c3aed;
/** PLASMA CONE per-shot tint gradient endpoints (hot pink -> orange). */
const PLASMA_TINT_A = 0xff2d78;
const PLASMA_TINT_B = 0xff9a3d;
/** PHASE LANCE: the asteroid pass iterates this instead (skip, zero alloc). */
const NO_ASTEROIDS: ReadonlyArray<AsteroidState> = [];
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

function emptyShared(): SharedState {
  // Every resettable field MUST be present — patches shallow-merge, so an
  // omitted key carries over.
  return {
    asteroids: [],
    ufo: null,
    items: [],
    enemies: [],
    enemyShots: [],
    shards: [],
    pulls: [],
    beacon: null,
    arenaEpoch: simNow(),
    sectorBossIdx: -1,
    playW: BASE_WORLD_W,
    playH: BASE_WORLD_H,
  };
}

function isShared(v: unknown): v is SharedState {
  return (
    typeof v === "object" && v !== null && Array.isArray((v as { asteroids?: unknown }).asteroids)
  );
}

/** A SharedState as a shallow-merge patch object — field by field, no cast.
 *  Quantized at this boundary (shared/wire.ts): the working copy keeps full
 *  precision; only the serialized snapshot is rounded. */
function sharedToPatch(s: SharedState): Record<string, unknown> {
  return {
    asteroids: s.asteroids.map(asteroidToWire),
    ufo: s.ufo ? ufoToWire(s.ufo) : null,
    items: s.items.map(itemToWire),
    enemies: s.enemies.map(enemyToWire),
    enemyShots: s.enemyShots.map(enemyShotToWire),
    shards: s.shards.map(shardToWire),
    pulls: s.pulls.map(pullToWire),
    beacon: s.beacon ? beaconToWire(s.beacon) : null,
    arenaEpoch: Math.round(s.arenaEpoch),
    sectorBossIdx: s.sectorBossIdx,
    playW: s.playW,
    playH: s.playH,
  };
}

/** Offline stand-in for `client.players`: the synthesized self entry (see the
 *  `peers` getter). Read-only in practice, so one shared object is safe. */
const SOLO_PEERS: PlayerMap = { solo: { id: "solo" } };

export class GameScene extends Phaser.Scene {
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
  private lastSharedRef: unknown = null;

  // my ship + weapon
  private spawned = false;
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
  /** The mobile controller (floating move-joystick + a "rest" fire button:
   *  any finger that isn't the stick fires). Desktop keeps the mouse model
   *  (aim+thrust at the cursor); the gamepad only activates on first touch. */
  private gamepad!: PhaserGamepad;
  /** Physical controller: left stick = aim + thrust (same heading+magnitude
   *  model as the touch joystick), RT or A held = fire. */
  private readonly pad = new PhysicalGamepad({ stickDeadZone: PAD_STICK_DEAD_ZONE });
  /** Re-renders the start-screen copy on pad connect/disconnect while the
   *  overlay is up; unsubscribed the moment play begins. */
  private unwatchControls: (() => void) | null = null;
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
  /** Each peer's net state, parsed ONCE per frame (see update()) — identity
   *  only changes on a ~20Hz patch, and the hot paths read it many times. */
  private peerStates = new Map<string, PlayerNetState | null>();

  /** Connected to the arena, or running the solo offline fallback. */
  private get live(): boolean {
    return this.offline || this.client.connectionStatus === "connected";
  }

  private get amHost(): boolean {
    return this.offline || this.client.isHost;
  }

  private get myId(): string | null {
    return this.offline ? "solo" : this.client.playerId;
  }

  private get peers(): typeof this.client.players {
    // Offline: synthesize the self entry so every `id === myId` render path
    // (ship gfx, shield ring, impact arcs, twin drone, windup glow, nitro
    // trail, minimap own-dot) still runs solo. cssToInt(undefined) → white.
    return this.offline ? SOLO_PEERS : this.client.players;
  }

  /** Events loop straight back into the local host when offline. */
  private netSendEvent(event: string, payload: Record<string, unknown>): void {
    if (this.offline) this.handleEvent(event, payload, "solo");
    else this.client.sendEvent(event, payload);
  }

  /** Give up on the party server after the grace window and go solo. Called
   *  every update() tick until the fallback triggers (or forever, online). */
  private maybeGoOffline(): void {
    // Start the grace window on the first tick, not at create(): counting
    // asset-load time would wrongly drop a slow-booting client to solo.
    // Real wall clock, NOT the pausable sim clock — connection deadlines must
    // keep counting through a pause (same contract as the clock module doc).
    if (this.bootedAt === 0) this.bootedAt = Date.now();
    if (this.client.connectionStatus === "connected") {
      this.everConnected = true;
      return;
    }
    // Once we've been in the arena, a drop is transient — let the socket
    // reconnect instead of stranding a real player in a solo world.
    if (this.everConnected) return;
    // Pre-connect errors/closes are NOT instant failures: the socket retries
    // by itself, and a single refused handshake (cold server, wifi blip) must
    // not force a whole solo session. The deadline is the only trigger.
    if (Date.now() - this.bootedAt < OFFLINE_FALLBACK_MS) return;
    this.offline = true;
    this.client.destroy(); // stop reconnect attempts; refresh to go online
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
  private impactArcs: Array<{ angle: number; diesAt: number }> = [];

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
    ufo: false,
    items: false,
    enemies: false,
    enemyShots: false,
    shards: false,
    pulls: false,
    beacon: false,
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
  private lootPity: Record<LootClass, number> = { shield: 0, booster: 0, weapon: 0 };
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
  /** Joystick overlay, scene-drawn (adapter `render: false`) so syncScreenUi
   *  can counter the camera zoom — see drawPadOverlay. */
  private padGfx!: Phaser.GameObjects.Graphics;
  /** Device safe-area insets (home indicator/notch), re-read on resize; keeps
   *  the canvas-drawn minimap off the home indicator. */
  private safeInset: Inset = { top: 0, right: 0, bottom: 0, left: 0 };
  /** Current trauma roll in degrees (what setAngle was last given) — Phaser 4
   *  types expose no camera `rotation` getter, so syncScreenUi reads this. */
  private camRollDeg = 0;
  /** Scratch vector for screen→world cursor mapping (zero-alloc steering). */
  private readonly pointerWorld = new Phaser.Math.Vector2();
  private splinters: Splinter[] = [];
  private muzzleFlashes: MuzzleFlash[] = [];
  private remoteTrailCount = 0;

  // HUD (DOM, owned by index.html)
  private bossBarEl: HTMLElement | null = null;
  private bossHpEl: HTMLElement | null = null;
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
    this.bossBarEl = document.getElementById("bossbar");
    this.bossHpEl = document.getElementById("bosshp");
    this.weaponEl = document.getElementById("weapon");
    this.weaponBarEl = document.getElementById("weaponbar");
    this.shieldEl = document.getElementById("shield");
    this.shieldFillEl = document.getElementById("shieldfill");
    this.shieldOsEl = document.getElementById("shieldos");
    this.shieldModEl = document.getElementById("shieldmod");
    this.shieldModBarEl = document.getElementById("shieldmodbar");
    this.boostsEl = document.getElementById("boosts");
    this.comboEl = document.getElementById("combo");
    this.comboValEl = document.getElementById("comboval");
    this.comboBarEl = document.getElementById("combobar");
    this.playersEl = document.getElementById("players");
    this.overlayEl = document.getElementById("overlay");
    this.causeEl = document.getElementById("cause");
    this.hintEl = document.getElementById("hint");
    this.countdownEl = document.getElementById("countdown");
    this.sectorEl = document.getElementById("sector");
    this.recapEl = document.getElementById("recap");
    this.pulseEl = document.getElementById("pulse");

    this.starfield = new Starfield(this);
    this.fx = new FxPool(this);

    this.barrier?.destroy(); // scene-reuse safety: drop a prior instance's Graphics
    this.barrier = new EnergyBarrier(this);

    // Black mask past the bleed ring: entities legitimately exist beyond the
    // edge (spawning asteroids, escaping beams) but must not be visible there.
    // Inset by WORLD_BLEED_PX so the fading bleed starfield stays visible.
    const edges: ReadonlyArray<readonly [number, number, number, number]> = [
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
      this.add.rectangle(x, y, w, h, 0x020617).setOrigin(0).setDepth(50);
    }

    this.beamGfx = this.add.graphics().setDepth(12);
    // Shards: one pooled Graphics redrawn per frame (zero per-shard objects).
    this.shardGfx = this.add.graphics().setDepth(4).setBlendMode(Phaser.BlendModes.ADD);
    this.enemyShotGfx = this.add.graphics().setDepth(12);
    this.telegraphGfx = this.add.graphics().setDepth(13).setBlendMode(Phaser.BlendModes.ADD);
    // Beacon ring under ships (a zone on the floor), pips above everything
    // world-space (they're viewport furniture, still below the DOM HUD).
    this.beaconGfx = this.add.graphics().setDepth(5).setBlendMode(Phaser.BlendModes.ADD);
    this.edgePips = new EdgePips(this, 40);
    this.haloGfx = this.add.graphics().setDepth(11).setBlendMode(Phaser.BlendModes.ADD);
    this.muzzleGfx = this.add.graphics().setDepth(19).setBlendMode(Phaser.BlendModes.ADD);
    this.splinterGfx = this.add.graphics().setDepth(15);
    this.minimapGfx = this.add.graphics().setScrollFactor(0).setDepth(100);
    this.flashRect = this.add
      .rectangle(0, 0, 4, 4, 0xffffff)
      .setOrigin(0)
      .setScrollFactor(0)
      .setDepth(90)
      .setAlpha(0);
    // Same overlay style as the adapter's built-in renderer (depth 95: above
    // the world, below the DOM HUD; additive glow over the dark arena).
    this.padGfx = this.add
      .graphics()
      .setScrollFactor(0)
      .setDepth(95)
      .setBlendMode(Phaser.BlendModes.ADD);

    // Explicit offline boot (?offline=1): never dial the party server. A
    // failed WebSocket handshake logs a browser console error the page cannot
    // suppress, so an offline-by-intent run (bot playtest, deliberate solo)
    // must skip the socket entirely rather than lean on the failure fallback
    // (maybeGoOffline). Every `this.client` access is guarded by
    // `this.offline`, so the client simply never exists on this path.
    if (new URLSearchParams(location.search).get("offline") === "1") {
      this.offline = true;
      this.ensureSeeded();
    } else {
      // No `initialState`: the package re-applies it whenever a client becomes
      // host, which would wipe the live world on host migration. The first host
      // seeds explicitly (see `ensureSeeded`).
      this.client = new MultiplayerClient({
        host: MULTIPLAYER_HOST,
        party: "vg-server",
        room: ROOM,
        maxPlayers: STARFALL_MAX_PLAYERS,
        onEvent: (event, payload, from) => this.handleEvent(event, payload, from),
      });
      this.client.subscribe(() => this.onUpdate());
    }

    // Desktop steers from the cursor (activePointer); the gamepad below owns
    // the touch path. These two listeners only track that a pointer exists and
    // unlock audio on the first gesture.
    this.input.on(Phaser.Input.Events.POINTER_MOVE, () => {
      this.pointerSeen = true;
    });
    this.input.on(Phaser.Input.Events.POINTER_DOWN, () => {
      this.pointerSeen = true;
      sfx.unlock(); // WebAudio needs a user gesture
    });

    // Sound is opt-in: muted by default, M toggles, choice persists (see
    // sfx). The gesture itself unlocks audio.
    this.input.keyboard?.on("keydown-M", () => sfx.toggleMute());

    // qa-005: held SPACE autofires exactly like a held mouse button (spec
    // Controls: "hold mouse/space to fire"). addKey captures the keystroke so
    // the page never scrolls.
    this.fireKey = this.input.keyboard?.addKey(Phaser.Input.Keyboard.KeyCodes.SPACE) ?? null;

    // Mobile controller: a floating move-joystick (first finger) plus a "rest"
    // fire button — any finger that isn't the stick fires. `render: false`:
    // the scene draws the overlay itself (drawPadOverlay) because screen-fixed
    // objects inherit the main camera's zoom and must counter it.
    this.gamepad = attachVirtualGamepad(this, {
      stick: {
        radius: JOYSTICK_RADIUS,
        deadZone: JOYSTICK_DEAD_ZONE,
        knobRadius: JOYSTICK_KNOB_RADIUS,
      },
      buttons: [{ id: "fire" }],
      render: false,
      onFirstTouch: () => this.enterTouchMode(),
    });
    if (IS_COARSE_POINTER) this.enterTouchMode(); // touch copy from boot, not first tap
    // After the gamepad exists: writeStartCopy() reads its touch flag.
    this.buildStartScreen();

    // Cosmetic hero-vs-swarm backdrop behind the start overlay, mimicking real
    // play. Purely visual — never written to the net session (see module).
    this.attract = new AttractBattle(this, {
      fx: this.fx,
      makeShip: (tint, level) => this.makeShipGfx(tint, level),
      hullPoints: (level) => shipHullPoints(level),
      makeEnemy: (kind) => this.makeEnemyGfx(kind).setDepth(9),
      enemyHull: (kind) => enemyHullPoints(kind),
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
        if (this.offline) this.freezeSim();
        else this.pauseToSpectator();
      },
      onResume: () => {
        pauseOverlay.hide();
        if (this.frozen) this.unfreezeSim();
        else this.resumeFromSpectator();
      },
    });

    this.scale.on(Phaser.Scale.Events.RESIZE, this.onViewportChange, this);
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
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      this.scale.off(Phaser.Scale.Events.RESIZE, this.onViewportChange, this);
      this.gamepad.destroy();
      if (!this.offline) this.client.destroy(); // offline already destroyed it
    });

    this.installDevHooks();
  }

  override update(time: number, delta: number): void {
    const dt = Math.min(delta, 100) / 1000; // clamp tab-switch spikes
    this.pad.update(); // poll the physical controller once per frame
    // Any pad face button doubles as "press any key" on the start screen.
    if (!this.started && ["a", "b", "x", "y", "start"].some((b) => this.pad.justPressed(b)))
      this.beginPlay();
    this.starfield.update(dt, time);
    this.barrier.update(time, this.world.playW, this.world.playH);
    if (!this.offline) this.maybeGoOffline();
    // Start screen up: run the cosmetic dogfight backdrop behind the overlay.
    // It's purely additive — the live path below still runs (so the host keeps
    // the shared world ticking and real remote players still render/mix in).
    if (!this.started) this.attract?.update(dt, this.time.now);
    if (!this.live) {
      // Connecting (pre-live): no world to tick, but still flush attract's fx.
      this.fx.update(dt, this.time.now);
      this.syncScreenUi(); // camera is static here; keep the vignette pinned
      this.publishDiag(); // after this frame's work, so bots never read stale state
      return;
    }
    const now = simNow();
    // Parse every peer's net state once for this frame; readers below (aim,
    // mines, PvP, host sim, render, minimap) all pull from the map.
    this.peerStates.clear();
    for (const [id, player] of Object.entries(this.peers)) {
      this.peerStates.set(id, readNetState(player));
    }

    this.ensureSpawned();
    this.seedOpeningRocks();
    this.tickRespawn(now);
    // Reconcile dropped touches + publish press edges; the overlay itself is
    // drawn by drawPadOverlay (adapter render: false).
    this.gamepad.update();
    this.steerShip(dt);
    this.handleShooting(delta, now);
    this.updateBeams(dt, now);
    this.tickMines(now);
    this.tickSentry(now);
    this.advanceWorld(dt);
    if (this.amHost) this.hostTick(now, dt, delta);
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
    this.drawEnemyShots();
    this.drawBeams(now);
    this.updateSplinters(dt, now);
    this.fx.update(dt, this.time.now);
    this.drawMinimap(now);
    this.updateCamera(dt, time);
    this.drawPadOverlay();
    this.syncScreenUi();
    this.updateHud(now);
    this.publishDiag(); // after this frame's work, so bots never read stale state
  }

  /** Resize/rotation: re-read the safe-area insets and re-derive camera zoom. */
  private onViewportChange(): void {
    this.safeInset = safeAreaInset();
    const zoom = Phaser.Math.Clamp(this.scale.width / CAMERA_REF_WIDTH, CAMERA_MIN_ZOOM, 1);
    this.cameras.main.setZoom(zoom);
  }

  // ---- input + my ship -------------------------------------------------------

  /** First connect: drop the ship at a clear spot and snap the camera. */
  /** The one place controls are taught. Dismissed on the first key/pointer
   *  RELEASE, not press: the fire handlers stay live behind the overlay, so
   *  starting on a press would let the same click also shoot. */
  private buildStartScreen(): void {
    this.startEl = document.getElementById("start");
    this.writeStartCopy();
    // Plugging in a pad while the start screen is up adds its rows.
    this.unwatchControls?.();
    this.unwatchControls = watchControlContext(() => {
      if (!this.started) this.writeStartCopy();
    });
    this.input.keyboard?.once("keyup", () => this.beginPlay());
    // The overlay covers the canvas, so Phaser's pointer input never sees the
    // tap — listen on the overlay element itself.
    this.startEl?.addEventListener("pointerup", () => this.beginPlay(), { once: true });
  }

  /** Start-screen copy, re-run when the touch scheme is detected or a pad
   *  connects. Renders the same grouped keycap card the pause overlay shows
   *  (../pause-overlay buildControls); `coarse` is forced from live touch
   *  detection so a finger on a fine-pointer device still flips the copy
   *  (enterTouchMode), and pad rows appear from live detection. */
  private writeStartCopy(): void {
    const touch = IS_COARSE_POINTER || this.gamepad.isTouch;
    const controls = document.getElementById("start-controls");
    const go = document.getElementById("start-go");
    if (controls) {
      ensureControlsStyle();
      const card = buildControls(touch);
      controls.replaceChildren(...(card ? [card] : []));
    }
    if (go) go.textContent = touch ? "tap to start" : "press any key to start";
  }

  private beginPlay(): void {
    if (this.started) return;
    this.started = true;
    // qa-020, offline solo ONLY: the sector clock (and the intensity curve)
    // starts at first input, not at boot — overlay-idle time was pure sector
    // loss, and a long idle met the rel-405 forced dreadnought at Lv1. Online
    // rooms keep the shared epoch untouched: the room clock predates you.
    if (this.offline) this.world.arenaEpoch = simNow();
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
            x: b.x,
            y: b.y,
            phase: bnow < b.activeAt ? "charge" : "active",
            controllerId: b.controllerId,
            contested: b.contested,
          }
        : null;
  }

  /** Offline-only REAL freeze: stop the sim clock (every stored deadline
   *  holds), sleep the render loop, suspend audio. Never online — the shared
   *  world would stall for the other players (they get the spectator path). */
  private frozen = false;

  private freezeSim(): void {
    if (this.frozen || !this.offline) return;
    this.frozen = true;
    pauseClock();
    sfx.setSuspended(true);
    this.game.loop.sleep(); // stops update() until wake()
  }

  private unfreezeSim(): void {
    if (!this.frozen) return;
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
    if (this.paused) return;
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
    if (this.started && this.myId) this.pushMyState(simNow());
    sfx.setSuspended(true);
  }

  /** Wrapper resume → re-enter through the normal respawn flow (invuln + full
   *  shield + the level's base loadout via pickRespawnPoint), online or solo. */
  private resumeFromSpectator(): void {
    if (!this.paused) return;
    this.paused = false;
    sfx.setSuspended(false);
    if (!this.started) return; // paused before play began: nothing to re-enter
    // Route re-entry through tickRespawn: mark spawned (so ensureSpawned won't
    // also fire) but dead with an elapsed respawn timer. Next update() re-spawns
    // me once, with invuln — never a double ship.
    this.spawned = true;
    this.alive = false;
    this.respawnAt = simNow();
  }

  private ensureSpawned(): void {
    if (!this.started || this.paused || this.spawned || !this.myId) return;
    // Same clearance as respawn, but confined to the map's central region —
    // an edge start opens with the void past the world border on screen. At
    // least the central third per axis, inset further when a big/zoomed-out
    // viewport would still reach the border from there.
    const cam = this.cameras.main;
    const { playW, playH } = this.world;
    const inset = (dim: number, halfView: number): number =>
      Math.min(Math.max(dim * INITIAL_SPAWN_CENTER_FRAC, halfView + RESPAWN_EDGE_MARGIN), dim / 2);
    const pos = this.pickRespawnPoint(
      inset(playW, cam.width / 2 / cam.zoom),
      inset(playH, cam.height / 2 / cam.zoom),
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
    if (this.openingRocksSeeded || !this.spawned) return;
    if (!this.offline && !this.amHost) {
      this.openingRocksSeeded = true;
      return;
    }
    if (this.world.asteroids.length === 0) return; // world not seeded yet
    const cam = this.cameras.main;
    const maxDist = Phaser.Math.Clamp(
      Math.min(cam.width, cam.height) / 2 / cam.zoom - 60,
      160,
      320,
    );
    const base = rand() * Math.PI * 2;
    for (let i = 0; i < OPENING_ROCK_COUNT; i++) {
      // Evenly fanned with jitter — always spread around the ship, never a clump.
      const ang = base + (i * Math.PI * 2) / OPENING_ROCK_COUNT + (rand() - 0.5) * 0.6;
      const dist = 140 + rand() * Math.max(20, maxDist - 140);
      const x = Phaser.Math.Clamp(this.shipX + Math.cos(ang) * dist, 40, this.world.playW - 40);
      const y = Phaser.Math.Clamp(this.shipY + Math.sin(ang) * dist, 40, this.world.playH - 40);
      this.world.asteroids.push(spawnOpeningAsteroid(x, y));
    }
    this.openingRocksSeeded = true;
    this.dirty.asteroids = true;
  }

  private tickRespawn(now: number): void {
    if (this.alive || this.respawnAt === 0 || now < this.respawnAt) return;
    const pos = this.pickRespawnPoint();
    this.shipX = pos.x;
    this.shipY = pos.y;
    this.shipVX = 0;
    this.shipVY = 0;
    this.alive = true;
    this.respawnAt = 0;
    this.invulnUntil = now + INVULNERABLE_MS;
    this.shieldHp = SHIELD_MAX; // respawn at full (§A.1)
    this.overHp = 0;
    this.lastDamageAt = 0;
    this.regenActive = false;
    this.weaponUntil = 0;
    this.applyBaseLoadout(now); // revive at the level's base weapon + regen
    this.kickX = 0;
    this.kickY = 0;
    this.cameras.main.centerOn(pos.x, pos.y);
    this.spawnInFx(pos.x, pos.y);
    sfx.play("respawn");
    this.pushMyState(now);
  }

  /** Re-roll until clear of enemies + big asteroids; ≤8 attempts, take best. */
  private pickRespawnPoint(marginX = RESPAWN_EDGE_MARGIN, marginY = marginX): Vec {
    const { playW, playH } = this.world; // respawn within the LIVE (scaled) play area
    let best = randomWorldPoint(marginX, marginY, playW, playH);
    let bestClearance = -1;
    for (let i = 0; i < RESPAWN_ATTEMPTS; i++) {
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
      if (minD >= RESPAWN_CLEARANCE) return p;
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
    this.fx.converge(x, y, 12, 60, 300, tint);
    this.time.delayedCall(300, () => this.fx.ring(x, y, 6, 30, 200, tint, 0.7));
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
    if (!this.alive || !this.spawned) return;
    // NITRO deliberately breaks the "every projectile outruns the ship" floor.
    const nitro = this.boosts.has("nitro");
    const accel = SHIP_ACCEL * (nitro ? NITRO_ACCEL_MULT : 1);
    const maxSpeed = SHIP_MAX_SPEED * (nitro ? NITRO_MAX_SPEED_MULT : 1);
    let drag = SHIP_BRAKE_DRAG;
    this.thrust = 0;
    const steer = this.steerVector();
    if (steer) {
      if (steer.aim) this.shipAngle = steer.angle;
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
      this.shipX = Phaser.Math.Clamp(this.shipX, 0, this.world.playW);
      this.shipVX = 0;
    }
    if (this.shipY < 0 || this.shipY > this.world.playH) {
      this.shipY = Phaser.Math.Clamp(this.shipY, 0, this.world.playH);
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
    // Physical stick past its dead zone owns the frame (same heading+magnitude
    // model as the touch joystick, and the same override rule touch applies to
    // the mouse); inside the dead zone it yields, so an idle pad never fights
    // the cursor and the nose holds when nothing else is steering.
    if (this.pad.connected) {
      const stick = this.pad.getStick();
      if (!stick.inDeadZone) {
        return {
          angle: stick.angle,
          thrust: stick.magnitude,
          dist: stick.distance,
          deadZone: PAD_STICK_DEAD_ZONE,
          aim: true,
        };
      }
    }
    if (this.gamepad.isTouch) {
      const stick = this.gamepad.getStick();
      if (!stick.active) return null;
      return {
        angle: stick.angle,
        thrust: stick.magnitude,
        dist: stick.distance,
        deadZone: JOYSTICK_DEAD_ZONE,
        aim: !stick.inDeadZone,
      };
    }
    if (!this.pointerSeen) return null;
    const p = this.input.activePointer;
    // Screen→world through the camera: scrollX alone mis-aims under zoom < 1.
    const cursor = this.cameras.main.getWorldPoint(p.x, p.y, this.pointerWorld);
    const dx = cursor.x - this.shipX;
    const dy = cursor.y - this.shipY;
    const dist = Math.hypot(dx, dy);
    const thrust = Math.min(1, Math.max(0, (dist - SHIP_DEAD_ZONE) / SHIP_THRUST_RAMP));
    return { angle: Math.atan2(dy, dx), thrust, dist, deadZone: SHIP_DEAD_ZONE, aim: dist > 0.001 };
  }

  /** Rewrite the start-screen copy for the touch control scheme. Fired at boot
   *  on coarse-pointer devices, else the first time a finger lands. */
  private enterTouchMode(): void {
    this.writeStartCopy();
  }

  /** Holding fire: any non-stick finger on touch, the mouse button or held
   *  SPACE on desktop, or RT / A held on a physical controller (merged,
   *  never exclusive). */
  private isFiring(): boolean {
    if (this.pad.connected && (this.pad.isButtonDown("rt") || this.pad.isButtonDown("a")))
      return true;
    if (this.fireKey?.isDown) return true;
    return this.gamepad.isTouch
      ? this.gamepad.isButtonDown("fire")
      : this.input.activePointer.isDown;
  }

  private handleShooting(delta: number, now: number): void {
    if (!this.alive || !this.spawned) return;
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
      this.windupAcc = 0; // releasing mid-windup cancels
      return;
    }
    const windupMs = this.weapon.windupMs * rateMult;
    if (windupMs > 0) {
      // Charge runs inside the interval (cycle = max(interval, windup)) and
      // auto-repeats while held — the one-button identity holds.
      this.windupAcc = Math.min(windupMs, this.windupAcc + delta);
      if (this.windupAcc < windupMs || this.shootCooldown > 0) return;
      this.windupAcc = 0;
    } else {
      this.windupAcc = 0;
      if (this.shootCooldown > 0) return;
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
    const arc = w.arc;
    let gainScale = 1;
    if (arc && w.aura) {
      // TESLA AURA: nothing in range = a silent tick (no sound, no muzzle).
      if (!this.fireAuraZap(now, arc)) return;
    } else if (arc) {
      if (this.fireArc(now, nose, arc)) gainScale = 0.5; // fizzle: quieter zap
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
    } else {
      // SENTRY: the trigger also places/moves the turret (sound gated there).
      if (w.sentry) this.placeSentry(now);
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
        if (tw.mirror) this.firePellets(twin, this.shipAngle + Math.PI, tw, now);
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
        best = { ref: { kind: "enemy", id: e.id }, x: e.x, y: e.y };
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
        best = { ref: { kind: "asteroid", id: a.id }, x: a.x, y: a.y };
      }
    }
    if (!best) return false;
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
      x: this.shipX,
      y: this.shipY,
      until: now + SENTRY_LIFETIME_MS,
      nextFireAt: prev?.nextFireAt ?? 0,
    };
    if (moved) {
      sfx.play("sentry_place");
      this.fx.ring(this.shipX, this.shipY, 4, 18, 200, SENTRY_WEAPON.tint, 0.6);
    }
  }

  /** SENTRY turret sim: every SENTRY_FIRE_MS fire a bolt (ordinary owner
   *  beam — hits, score and serialization all ride the normal pipelines)
   *  at the nearest enemy, else the nearest asteroid, within range. */
  private tickSentry(now: number): void {
    const s = this.sentry;
    if (!s) return;
    if (!this.alive || now >= s.until) {
      this.sentry = null;
      return;
    }
    if (now < s.nextFireAt) return;
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
    if (!best) return; // nothing in range: rescan next frame, no cooldown
    const ang = Math.atan2(best.y - s.y, best.x - s.x);
    this.beams.push(this.makeBeam({ x: s.x, y: s.y }, ang, SENTRY_WEAPON, now));
    s.nextFireAt = now + SENTRY_FIRE_MS;
    this.fx.sparks(s.x, s.y, 2, SENTRY_WEAPON.tint, { lifeMin: 80, lifeMax: 140, scale: 0.4 });
    if (this.onScreen(s.x, s.y)) sfx.play("fire_pulse", { gain: 0.35, rate: 1.15 });
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
    for (let i = 0; i < n; i++) {
      const spread = n > 1 ? -weapon.spreadDeg / 2 + (weapon.spreadDeg * i) / (n - 1) : 0;
      const jitter = (rand() * 2 - 1) * weapon.jitterDeg;
      const angle = aimAngle + (spread + jitter) * DEG;
      this.beams.push(this.makeBeam(origin, angle, weapon, now));
    }
  }

  /** TWIN orbit phase — derived from the wall clock with the exact formula
   *  remotes use, so the owner's drone and every remote render agree. */
  private twinAngle(): number {
    return (simNow() / 1000) * TWIN_ORBIT_DEG_PER_S * DEG;
  }

  /** TWIN drone position while the booster is live, else null. */
  private twinPos(): Vec | null {
    if (!this.boosts.has("twin")) return null;
    const a = this.twinAngle();
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
    if (!spec) return;
    const launch = (): void => {
      if (!this.alive || !this.spawned) return;
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
    for (let i = 1; i < spec.missiles; i++) this.time.delayedCall(spec.staggerMs * i, launch);
  }

  /** Drop a proximity mine at the ship's tail (owner-simulated, in beams[]). */
  private dropMine(now: number): void {
    const live = this.beams.filter((b) => b.mine && !b.exploding && !b.vanished);
    if (live.length >= MINE_MAX_LIVE) {
      const oldest = live[0];
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
      head: { ...nose },
      tail: { ...nose },
      angle,
      weapon,
      released: false,
      exploding: false,
      explosionRadius: 0,
      vanished: false,
      target: weapon.homing ? this.acquireHomingTarget(nose, weapon.homing.acquireRange) : null,
      hitIds: new Set(),
      glaive: weapon.boomerang ? { returning: false, traveled: 0 } : null,
      chain: null,
      fizzle: false,
      // Range-limited beams (PLASMA stream, SINGULARITY flight) expire after
      // range px of travel; everything else rides 0 (callers may override).
      diesAt: weapon.range > 0 && weapon.speed > 0 ? now + (weapon.range / weapon.speed) * 1000 : 0,
      mine: null,
      bouncesLeft: weapon.ricochet?.bounces ?? 0,
      collapseUntil: 0,
      traveled: 0,
      spin: now % 1000, // desync glaive spin phases a little
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
    const playOpts: PlayOpts = { gain: sound.gain * gainScale };
    if (sound.rate !== undefined) playOpts.rate = sound.rate;
    sfx.play(sound.name, playOpts);
    // OVERDRIVE: muzzle flashes gain a gold outer spark.
    if (this.boosts.has("overdrive")) {
      this.fx.sparks(nose.x, nose.y, 2, 0xfacc15, {
        speedMin: 150,
        speedMax: 320,
        lifeMin: 100,
        lifeMax: 180,
        scale: 0.5,
      });
    }
    const aimDeg = this.shipAngle / DEG;
    switch (w.sfx) {
      case "mine":
        // Drop, not a shot: tiny puff, no kick.
        this.fx.sparks(nose.x, nose.y, 2, w.tint, { lifeMin: 100, lifeMax: 160, scale: 0.4 });
        break;
      case "nova":
        // The expanding ring IS the effect; no muzzle, no kick.
        break;
      case "rail":
        // Heavy release (§C): kick 5px, trauma +0.08.
        this.fx.sparks(nose.x, nose.y, 5, w.tint, {
          angleMin: aimDeg - 12,
          angleMax: aimDeg + 12,
          speedMin: 250,
          speedMax: 450,
          lifeMin: 120,
          lifeMax: 200,
          scale: 0.5,
        });
        this.muzzleFlashes.push({
          x: nose.x,
          y: nose.y,
          angle: this.shipAngle,
          size: 12,
          tint: w.tint,
          diesAt: now + 50,
          kind: "cross",
        });
        this.trauma.add(0.08);
        this.kick(5);
        break;
      case "tesla":
        // The zap chain is the whole show — no muzzle, no kick.
        break;
      case "heavy":
      case "glaive":
      case "drill":
      case "singularity":
        this.fx.sparks(nose.x, nose.y, 5, w.tint, {
          angleMin: aimDeg - 15,
          angleMax: aimDeg + 15,
          speedMin: 200,
          speedMax: 400,
          lifeMin: 120,
          lifeMax: 200,
          scale: 0.5,
        });
        this.muzzleFlashes.push({
          x: nose.x,
          y: nose.y,
          angle: this.shipAngle,
          size: 10,
          tint: w.tint,
          diesAt: now + 50,
          kind: "cross",
        });
        this.trauma.add(0.06);
        this.kick(4);
        break;
      case "zap":
        this.muzzleFlashes.push({
          x: nose.x,
          y: nose.y,
          angle: this.shipAngle,
          size: 14,
          tint: w.tint,
          diesAt: now + 60,
          kind: "line",
        });
        this.kick(3);
        break;
      case "arc":
      case "seek":
        this.fx.sparks(nose.x, nose.y, 4, w.tint, {
          lifeMin: 100,
          lifeMax: 160,
          speedMin: 100,
          speedMax: 250,
          scale: 0.5,
        });
        this.muzzleFlashes.push({
          x: nose.x,
          y: nose.y,
          angle: 0,
          size: 8,
          tint: w.tint,
          diesAt: now + 30,
          kind: "ring",
        });
        this.kick(2);
        break;
      default:
        // pulse family (NORMAL, TINY, SCATTER, EXPLOSION)
        this.fx.sparks(nose.x, nose.y, 3, w.tint, {
          angleMin: aimDeg - 15,
          angleMax: aimDeg + 15,
          speedMin: 200,
          speedMax: 400,
          lifeMin: 100,
          lifeMax: 180,
          scale: 0.5,
        });
        this.muzzleFlashes.push({
          x: nose.x,
          y: nose.y,
          angle: this.shipAngle,
          size: 6,
          tint: w.tint,
          diesAt: now + 30,
          kind: "cross",
        });
        this.kick(2);
        break;
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
      if (d > range) return null;
      const ang = Math.atan2(y - nose.y, x - nose.x);
      return Math.abs(wrapAngle(ang - this.shipAngle)) <= half ? d : null;
    };
    let bestD = Infinity;
    let best: TargetRef | null = null;
    for (const e of this.world.enemies) {
      const d = inCone(e.x, e.y);
      if (d !== null && d < bestD) {
        bestD = d;
        best = { kind: "enemy", id: e.id };
      }
    }
    if (best) return best;
    const myId = this.myId;
    for (const [id, st] of this.peerStates) {
      if (id === myId) continue;
      if (!st || !st.alive || st.invuln || st.shieldMod?.phased) continue;
      const d = inCone(st.x, st.y);
      if (d !== null && d < bestD) {
        bestD = d;
        best = { kind: "player", id };
      }
    }
    if (best) return best;
    const u = this.world.ufo;
    if (u && inCone(u.x, u.y) !== null) return { kind: "ufo" };
    for (const a of this.world.asteroids) {
      const d = inCone(a.x, a.y);
      if (d !== null && d < bestD) {
        bestD = d;
        best = { kind: "asteroid", id: a.id };
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
      if (d > spec.castRange || d >= bestD) continue;
      const ang = Math.atan2(c.y - nose.y, c.x - nose.x);
      if (Math.abs(wrapAngle(ang - this.shipAngle)) > half) continue;
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
        fizzle: true,
        diesAt: now + ARC_RENDER_MS,
      });
      return true;
    }
    const hitRefs: Array<{ ref: TargetRef; x: number; y: number }> = [first];
    const used = new Set<string>([targetKey(first.ref)]);
    let cur = first;
    for (let hop = 0; hop < spec.jumps; hop++) {
      let next: { ref: TargetRef; x: number; y: number } | null = null;
      let nd = Infinity;
      for (const c of candidates) {
        if (used.has(targetKey(c.ref))) continue;
        const d = Math.hypot(c.x - cur.x, c.y - cur.y);
        if (d <= spec.hopRange && d < nd) {
          nd = d;
          next = c;
        }
      }
      if (!next) break;
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

  private arcCandidates(): Array<{ ref: TargetRef; x: number; y: number }> {
    const out: Array<{ ref: TargetRef; x: number; y: number }> = [];
    for (const e of this.world.enemies)
      out.push({ ref: { kind: "enemy", id: e.id }, x: e.x, y: e.y });
    const myId = this.myId;
    for (const [id, st] of this.peerStates) {
      if (id === myId) continue;
      if (st && st.alive && !st.invuln && !st.shieldMod?.phased) {
        out.push({ ref: { kind: "player", id }, x: st.x, y: st.y });
      }
    }
    const u = this.world.ufo;
    if (u) out.push({ ref: { kind: "ufo" }, x: u.x, y: u.y });
    for (const a of this.world.asteroids) {
      out.push({ ref: { kind: "asteroid", id: a.id }, x: a.x, y: a.y });
    }
    return out;
  }

  private applyArcDamage(ref: TargetRef, x: number, y: number, dmgHp: number, now: number): void {
    this.fx.sparks(x, y, 6, this.weapon.tint, { lifeMin: 150, lifeMax: 250 });
    sfx.play("hit_spark", { gain: 0.4 });
    switch (ref.kind) {
      case "enemy": {
        const e = this.world.enemies.find((en) => en.id === ref.id);
        if (!e) return;
        e.blinkUntil = now + 150;
        if (e.hp - dmgHp <= 0) {
          this.predictKill(e.id, this.enemyKillXp(e.kind), "enemy", e.x, e.y, now);
        }
        this.netSendEvent("enemy_hit", { enemyId: e.id, damage: dmgHp });
        return;
      }
      case "asteroid": {
        const a = this.world.asteroids.find((as) => as.id === ref.id);
        if (!a) return;
        const power = dmgHp / 100;
        const predicted =
          asteroidDestroyedBy(a.radius, power) &&
          this.predictKill(a.id, XP.ASTEROID_DESTROY, "asteroid", a.x, a.y, now);
        if (!predicted) this.gainXp(XP.ASTEROID_CHIP, now);
        this.netSendEvent("asteroid_hit", { asteroidId: a.id, damage: power });
        return;
      }
      case "ufo": {
        const u = this.world.ufo;
        if (!u) return;
        if (u.hp - dmgHp <= 0) {
          this.predictKill(u.id, XP.UFO_DESTROY, "ufo", u.x, u.y, now);
        }
        this.netSendEvent("ufo_hit", { damage: dmgHp / 100 });
        return;
      }
      case "player":
        // The victim hit-tests the serialized chain and adjudicates its own
        // shield — nothing to send from the shooter side.
        return;
    }
  }

  private updateBeams(dt: number, now: number): void {
    this.beams = this.beams.filter((b) => !b.vanished);
    for (const b of this.beams) {
      // Mine: stationary until triggered; lifetime expiry detonates it.
      if (b.mine && !b.exploding) {
        if (now >= b.diesAt) this.detonateMine(b);
        continue;
      }
      // ARC bolt: static geometry, render-only lifetime.
      if (b.chain) {
        if (now >= b.diesAt) b.vanished = true;
        continue;
      }
      if (b.exploding) {
        const explosion = b.weapon.explosion;
        if (!explosion) {
          b.vanished = true;
          continue;
        }
        b.explosionRadius += explosion.growth * dt;
        if (b.explosionRadius >= explosion.range) b.vanished = true;
        continue;
      }
      // SINGULARITY: freeze through the collapse, pop at its end; the
      // flight leg collapses at diesAt instead of vanishing.
      if (b.weapon.singularity) {
        if (b.collapseUntil > 0) {
          if (now >= b.collapseUntil) this.popSingularity(b);
          continue;
        }
        if (b.diesAt > 0 && now >= b.diesAt) {
          this.startCollapse(b, now);
          continue;
        }
      }
      // Range-limited plain beams (FLAK fragments, PLASMA): expire at diesAt.
      if (b.diesAt > 0 && now >= b.diesAt) {
        b.vanished = true;
        continue;
      }
      // GLAIVE: out, decelerate, boomerang home, catch.
      const gl = b.glaive;
      const boomerang = b.weapon.boomerang;
      if (gl && boomerang) {
        b.spin += 12 * dt;
        let step: number;
        if (!gl.returning) {
          const remaining = Math.max(0, boomerang.outRange - gl.traveled);
          const speed = Math.max(30, b.weapon.speed * Math.min(1, remaining / GLAIVE_DECEL_PX));
          step = speed * dt;
          gl.traveled += step;
          if (gl.traveled >= boomerang.outRange - 2) {
            gl.returning = true;
            b.hitIds.clear(); // second pass re-arms against everything
          }
        } else {
          const dx = this.shipX - b.head.x;
          const dy = this.shipY - b.head.y;
          const dist = Math.hypot(dx, dy);
          if (!this.alive || dist < SHIP_RADIUS + 6) {
            b.vanished = true;
            continue;
          }
          b.angle = Math.atan2(dy, dx);
          step = boomerang.returnSpeed * dt;
        }
        b.head.x += Math.cos(b.angle) * step;
        b.head.y += Math.sin(b.angle) * step;
        b.tail.x = b.head.x - Math.cos(b.angle) * b.weapon.length;
        b.tail.y = b.head.y - Math.sin(b.angle) * b.weapon.length;
        if (!inWorld(b.head.x, b.head.y, BEAM_CULL_MARGIN, this.world.playW, this.world.playH))
          b.vanished = true;
        continue;
      }
      // HOMING: steer toward the live lock, capped turn rate.
      const homing = b.weapon.homing;
      if (homing && b.target) {
        const pos = this.resolveTarget(b.target);
        if (!pos) {
          b.target = null; // lock died → fly straight
        } else {
          const desired = Math.atan2(pos.y - b.head.y, pos.x - b.head.x);
          b.angle = rotateToward(b.angle, desired, homing.turnDegPerSec * DEG * dt);
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
        continue;
      }
      // RICOCHET: bounce off the world edge while bounces remain.
      if (
        b.bouncesLeft > 0 &&
        !inWorld(b.head.x, b.head.y, 0, this.world.playW, this.world.playH)
      ) {
        this.ricochetEdgeBounce(b);
      }
      if (!inWorld(b.head.x, b.head.y, BEAM_CULL_MARGIN, this.world.playW, this.world.playH)) {
        b.vanished = true;
        continue;
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
  }

  /** Armed mines trigger on enemy / remote player / UFO proximity (§C). */
  private tickMines(now: number): void {
    const r2 = MINE_TRIGGER_RADIUS * MINE_TRIGGER_RADIUS;
    for (const b of this.beams) {
      if (!b.mine || b.exploding || b.vanished || now < b.mine.armAt) continue;
      const x = b.head.x;
      const y = b.head.y;
      let trigger = false;
      for (const e of this.world.enemies) {
        if (dist2(e.x, e.y, x, y) <= r2) {
          trigger = true;
          break;
        }
      }
      const u = this.world.ufo;
      if (!trigger && u && dist2(u.x, u.y, x, y) <= r2) trigger = true;
      if (!trigger) {
        const myId = this.myId;
        for (const [id, st] of this.peerStates) {
          if (id === myId) continue;
          if (!st || !st.alive || st.invuln || st.shieldMod?.phased) continue;
          if (dist2(st.x, st.y, x, y) <= r2) {
            trigger = true;
            break;
          }
        }
      }
      if (trigger) this.detonateMine(b);
    }
  }

  /** Standard explosion through the existing exploding/explosionRadius path. */
  private detonateMine(b: Beam): void {
    b.exploding = true;
    b.explosionRadius = 0;
    if (this.onScreen(b.head.x, b.head.y)) {
      sfx.play("fire_heavy", { gain: 0.8, rate: 0.85 });
      this.trauma.add(0.06);
    }
  }

  /** Beam reaction to a hit: explode, airburst, pass through, or vanish. */
  private onBeamHit(b: Beam, now: number): void {
    if (b.exploding) return; // expanding AoE keeps going; updateBeams expires it at range
    if (b.weapon.flak) {
      this.burstFlak(b, now); // first hit pops the shell early
      return;
    }
    if (b.weapon.explosion) {
      b.exploding = true;
      b.explosionRadius = 0;
      return;
    }
    if (!b.weapon.through) b.vanished = true;
  }

  /** FLAK airburst: the shell vanishes into `fragments` radial beams, each
   *  an ordinary beam with its own hit dedup, range-limited via diesAt.
   *  Fragments inherit the shell's hitIds so a direct-hit victim eats the
   *  shell once, not shell + 8 point-blank fragments. */
  private burstFlak(b: Beam, now: number): void {
    const spec = b.weapon.flak;
    if (!spec || b.vanished) return;
    b.vanished = true;
    const ttlMs = (spec.fragRange / FLAK_FRAG_WEAPON.speed) * 1000;
    for (let i = 0; i < spec.fragments; i++) {
      const ang = (Math.PI * 2 * i) / spec.fragments;
      const fb = this.makeBeam({ x: b.head.x, y: b.head.y }, ang, FLAK_FRAG_WEAPON, now);
      fb.released = true;
      fb.diesAt = now + ttlMs;
      fb.hitIds = new Set(b.hitIds);
      this.beams.push(fb);
    }
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
    if (b.collapseUntil > 0 || b.exploding || b.vanished) return;
    // GRAVITON WELL herds far longer than SINGULARITY; the pull duration rides
    // the shared `until` so guests/host agree without a wire shape change.
    const pullMs = b.weapon.name === "GRAVITON WELL" ? GRAVITON_PULL_MS : SINGULARITY_PULL_MS;
    b.collapseUntil = now + pullMs;
    b.diesAt = 0;
    b.tail = { ...b.head };
    this.netSendEvent("singularity", { x: b.head.x, y: b.head.y, until: b.collapseUntil });
    if (this.onScreen(b.head.x, b.head.y)) sfx.play("fire_laser", { gain: 0.6, rate: 0.5 });
  }

  /** SINGULARITY pop: the standard exploding-beam path. hitIds is cleared so
   *  a flight-contact target isn't deduped out of its own pop. */
  private popSingularity(b: Beam): void {
    b.collapseUntil = 0;
    b.exploding = true;
    b.explosionRadius = 0;
    b.hitIds.clear();
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
    if (b.head.x < 0) nx = 1;
    else if (b.head.x > this.world.playW) nx = -1;
    if (b.head.y < 0) ny = 1;
    else if (b.head.y > this.world.playH) ny = -1;
    b.head.x = Phaser.Math.Clamp(b.head.x, 0, this.world.playW);
    b.head.y = Phaser.Math.Clamp(b.head.y, 0, this.world.playH);
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
    this.fx.sparks(b.head.x, b.head.y, 3, b.weapon.tint, {
      lifeMin: 100,
      lifeMax: 180,
      scale: 0.4,
    });
  }

  /** Aim at the nearest enemy (preferred) or asteroid within retargetRange
   *  that this beam hasn't already damaged. */
  private retargetRicochet(b: Beam): void {
    const range = b.weapon.ricochet?.retargetRange ?? 0;
    if (range <= 0) return;
    const r2 = range * range;
    let best: Vec | null = null;
    let bestD = Infinity;
    for (const e of this.world.enemies) {
      if (b.hitIds.has(e.id)) continue;
      const d = dist2(e.x, e.y, b.head.x, b.head.y);
      if (d <= r2 && d < bestD) {
        bestD = d;
        best = { x: e.x, y: e.y };
      }
    }
    if (!best) {
      for (const a of this.world.asteroids) {
        if (b.hitIds.has(a.id)) continue;
        const d = dist2(a.x, a.y, b.head.x, b.head.y);
        if (d <= r2 && d < bestD) {
          bestD = d;
          best = { x: a.x, y: a.y };
        }
      }
    }
    if (best) b.angle = Math.atan2(best.y - b.head.y, best.x - b.head.x);
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
      const heal =
        kind === "asteroid"
          ? SIPHON_HEAL_ASTEROID
          : kind === "player"
            ? SIPHON_HEAL_PLAYER
            : SIPHON_HEAL_ENEMY;
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
        lifeMin: 120,
        lifeMax: 200,
      });
    }
    this.streak += 1;
    this.comboExpiresAt = now + COMBO_WINDOW_MS;
    const mult = comboMult(this.streak);
    this.gainXp(base * mult, now);
    if (mult > this.comboTier && mult >= 2) {
      // Tier-up: the one allowed long effect (§9) + rising sfx + pill pop.
      sfx.play("combo_up", { rate: Math.pow(2, (2 * (mult - 2)) / 12) });
      this.trauma.add(0.1);
      this.fx.ring(this.shipX, this.shipY, 6, 75, 350, 0xffffff, 0.8);
      this.fx.converge(this.shipX, this.shipY, 12, 40, 300, 0xffffff);
      this.time.delayedCall(300, () => {
        if (this.alive) {
          this.fx.sparks(this.shipX, this.shipY, 12, 0xffffff, {
            speedMin: 100,
            speedMax: 250,
            lifeMin: 200,
            lifeMax: 350,
          });
        }
      });
      if (this.comboEl) {
        this.comboEl.classList.remove("pop");
        void this.comboEl.offsetWidth; // restart the CSS animation
        this.comboEl.classList.add("pop");
      }
    }
    this.comboTier = mult;
  }

  /** The single XP sink: add XP, roll up levels, fire the level-up feedback.
   *  Kills route here combo-multiplied (via registerKill); orbs + asteroid
   *  chips call this directly (flat). */
  private gainXp(amount: number, now: number): void {
    if (amount <= 0 || !this.alive) return;
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
    if (this.level >= LEVEL_CAP) this.xp = 0; // at cap the bar empties — no hoard
    if (leveled) this.onLevelUp(now);
  }

  /** Apply the new base loadout + the one allowed long FX (ring + converge +
   *  sparks, reusing the combo-tier vocabulary) + a pitched cue + HUD pop. */
  private onLevelUp(now: number): void {
    this.applyBaseLoadout(now);
    sfx.play("combo_up", { rate: 1.5 });
    this.trauma.add(0.12);
    const tint = this.myTint();
    this.fx.ring(this.shipX, this.shipY, 8, 110, 450, tint, 0.9);
    this.fx.converge(this.shipX, this.shipY, 16, 60, 320, 0xffffff);
    this.fx.sparks(this.shipX, this.shipY, 16, tint, {
      speedMin: 120,
      speedMax: 280,
      lifeMin: 250,
      lifeMax: 450,
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
    if (this.xp < 0) this.xp = 0;
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
    if (this.predictedKills.has(id)) return false;
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
    if (!this.spawned) return;
    // Crowd-scale FX budget: skip non-kill hit-spark spawns over the cap
    // (the victim's white flash stays — it's the readability signal).
    const sparksOk = this.fx.aliveParticles() <= HITSPARK_SKIP_BUDGET;
    for (const b of this.beams) {
      if (b.vanished || b.chain) continue; // ARC damage applied at cast
      if (b.mine && !b.exploding) continue; // inert until triggered
      // Width is half-padded into every segment test below so wide beams
      // (DRILL 8px) hit what they visually cover, not just their axis.
      const pad = b.weapon.width / 2;
      // PHASE LANCE: no asteroid hit-test at all — rocks aren't cover.
      const rocks = b.weapon.phasesRock ? NO_ASTEROIDS : this.world.asteroids;
      for (const a of rocks) {
        const hit = b.exploding
          ? dist2(b.head.x, b.head.y, a.x, a.y) <= b.explosionRadius * b.explosionRadius
          : segHitsCircle(b.tail.x, b.tail.y, b.head.x, b.head.y, a.x, a.y, a.radius + pad);
        if (!hit) continue;
        if (b.weapon.singularity && !b.exploding) {
          // Flight contact collapses the orb; damage comes from the pop.
          this.startCollapse(b, now);
          break;
        }
        if (b.hitIds.has(a.id)) continue;
        b.hitIds.add(a.id);
        if (b.weapon.ricochet && b.bouncesLeft > 0 && !b.exploding) {
          // RICOCHET: damage lands below, but the bolt bounces instead of dying.
          let nx = b.head.x - a.x;
          let ny = b.head.y - a.y;
          const nl = Math.hypot(nx, ny) || 1;
          this.ricochetBounce(b, nx / nl, ny / nl);
        } else {
          this.onBeamHit(b, now);
        }
        const destroyed = asteroidDestroyedBy(a.radius, b.weapon.power);
        const predicted =
          destroyed && this.predictKill(a.id, XP.ASTEROID_DESTROY, "asteroid", a.x, a.y, now);
        if (!predicted) this.gainXp(XP.ASTEROID_CHIP, now); // flat, never multiplied
        if (sparksOk || destroyed) {
          this.fx.sparks(b.head.x, b.head.y, 6, b.weapon.tint, { lifeMin: 150, lifeMax: 250 });
        }
        sfx.play("hit_spark", { gain: 0.4 });
        this.netSendEvent("asteroid_hit", { asteroidId: a.id, damage: b.weapon.power });
        if (!b.exploding) break; // AoE circle keeps testing every target
      }
      if (b.vanished) continue;
      for (const e of this.world.enemies) {
        const r = e.chargeUntil > now ? LANCER_CHARGE_HIT_RADIUS : ENEMY_SPECS[e.kind].hitRadius;
        const hit = b.exploding
          ? dist2(b.head.x, b.head.y, e.x, e.y) <= b.explosionRadius * b.explosionRadius
          : segHitsCircle(b.tail.x, b.tail.y, b.head.x, b.head.y, e.x, e.y, r + pad);
        if (!hit) continue;
        if (b.weapon.singularity && !b.exploding) {
          this.startCollapse(b, now);
          break;
        }
        if (b.hitIds.has(e.id)) continue;
        b.hitIds.add(e.id);
        this.onBeamHit(b, now);
        const dmg = b.weapon.power * 100;
        const killed = e.hp - dmg <= 0;
        if (killed) this.predictKill(e.id, this.enemyKillXp(e.kind), "enemy", e.x, e.y, now);
        e.blinkUntil = now + 150; // immediate local feedback; host echoes
        if (sparksOk || killed) {
          this.fx.sparks(b.head.x, b.head.y, 6, b.weapon.tint, { lifeMin: 150, lifeMax: 250 });
        }
        sfx.play("hit_spark", { gain: 0.4 });
        this.netSendEvent("enemy_hit", { enemyId: e.id, damage: dmg });
        if (!b.exploding) break; // AoE circle keeps testing every target
      }
      if (b.vanished) continue;
      const u = this.world.ufo;
      if (u) {
        const hit = b.exploding
          ? dist2(b.head.x, b.head.y, u.x, u.y) <= b.explosionRadius * b.explosionRadius
          : segHitsCircle(b.tail.x, b.tail.y, b.head.x, b.head.y, u.x, u.y, UFO_RADIUS + pad);
        if (hit && b.weapon.singularity && !b.exploding) {
          this.startCollapse(b, now);
          continue;
        }
        if (hit && !b.hitIds.has(u.id)) {
          b.hitIds.add(u.id);
          this.onBeamHit(b, now);
          const killed = u.hp - b.weapon.power * 100 <= 0;
          if (killed) this.predictKill(u.id, XP.UFO_DESTROY, "ufo", u.x, u.y, now);
          if (sparksOk || killed) {
            this.fx.sparks(b.head.x, b.head.y, 6, b.weapon.tint, { lifeMin: 150, lifeMax: 250 });
          }
          sfx.play("hit_spark", { gain: 0.4 });
          this.netSendEvent("ufo_hit", { damage: b.weapon.power });
        }
      }
    }
    for (const [id, t] of this.predictedKills) {
      if (now - t > 5000) this.predictedKills.delete(id);
    }
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
    this.fx.sparks(impactX, impactY, 8, SHIELD_RING_TINT, {
      angleMin: ang / DEG - 22.5,
      angleMax: ang / DEG + 22.5,
      lifeMin: 150,
      lifeMax: 250,
    });
    // Hits sound lower as you get closer to death (§A.5).
    const fraction = Math.max(0, Math.min(1, this.shieldHp / SHIELD_MAX));
    sfx.play("shield_hit", { rate: 0.85 + 0.3 * fraction });
    this.trauma.add(amount >= 40 ? 0.25 : 0.12);
  }

  /** Halo break flash (PHASE blinks; death layers shield_break in die()). */
  private shieldBreakFx(now: number): void {
    this.haloFlashUntil = now + 80;
    this.fx.ring(this.shipX, this.shipY, SHIELD_RING_RADIUS, 40, 300, SHIELD_RING_TINT, 0.7);
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
    if (!this.alive) return "dead";
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
    if (this.shieldMod === "bulwark" && now < this.shieldModUntil) {
      let rel = Math.atan2(fromY - this.shipY, fromX - this.shipX) - this.shipAngle;
      rel = Math.atan2(Math.sin(rel), Math.cos(rel)); // wrap to [-π, π]
      if (Math.abs(rel) <= ((BULWARK_CONE_DEG / 2) * Math.PI) / 180) amount *= BULWARK_FRONT_MULT;
    }
    const wasLow = this.shieldHp < SHIELD_MAX * SHIELD_LOW_FRACTION;
    let rest = amount;
    if (this.overHp > 0) {
      const fromOver = Math.min(this.overHp, rest);
      this.overHp -= fromOver;
      rest -= fromOver;
    }
    this.shieldHp -= rest;
    this.lastDamageAt = now;
    this.regenActive = false;
    if (this.shieldHp <= 0) {
      this.die(now, killerId, cause);
      return "dead";
    }
    this.shieldHitFx(now, fromX, fromY, amount);
    if (!wasLow && this.shieldHp < SHIELD_MAX * SHIELD_LOW_FRACTION) this.trauma.add(0.15);
    return "drained";
  }

  /** Base regen (Halo grammar) + overheal decay + mod/booster expiry. */
  private tickShield(now: number, dt: number): void {
    if (this.shieldMod && now >= this.shieldModUntil) {
      this.shieldMod = null;
      this.overHp = 0; // remaining OVERSHIELD bonus vanishes with the mod
    }
    for (const [kind, until] of this.boosts) {
      if (now >= until) this.boosts.delete(kind);
    }
    if (!this.alive) return;
    // SIPHON overheal above 100 bleeds off and never regens.
    if (this.shieldHp > SHIELD_MAX) {
      this.shieldHp = Math.max(SHIELD_MAX, this.shieldHp - SIPHON_OVERHEAL_DECAY_PER_S * dt);
    }
    const delay = this.shieldMod === "aegis" ? AEGIS_REGEN_DELAY_MS : SHIELD_REGEN_DELAY_MS;
    if (this.shieldHp < SHIELD_MAX && now - this.lastDamageAt >= delay) {
      if (!this.regenActive) {
        this.regenActive = true;
        sfx.play("shield_regen"); // once, when regen starts after a drain
      }
      const rate =
        (SHIELD_MAX / (SHIELD_REGEN_FULL_MS / 1000)) *
        this.regenMult * // levelling: faster recovery, not more max HP
        (this.shieldMod === "aegis" ? AEGIS_REGEN_MULT : 1);
      this.shieldHp = Math.min(SHIELD_MAX, this.shieldHp + rate * dt);
      if (this.shieldHp >= SHIELD_MAX) this.regenActive = false;
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
    if (idx !== -1) this.world.enemyShots.splice(idx, 1);
    this.recentConsumedShots.set(shot.id, simNow());
    if (this.amHost) this.dirty.enemyShots = true;
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
    if (!this.alive || !this.spawned) return;
    if (now < this.phasedUntil) return; // intangible: no collisions either way
    if (now < this.invulnUntil) return; // respawn invuln: zero shield interaction

    // -- asteroid contact (one drain per CONTACT_IFRAME window)
    for (const a of this.world.asteroids) {
      if (dist2(a.x, a.y, this.shipX, this.shipY) > a.radius * a.radius) continue;
      if (this.ramArmed()) {
        // RAM stops matter: small rocks die free, big rocks chip + 10 drain.
        const imm = this.ramImmunity.get(a.id);
        if (imm !== undefined && now < imm) continue;
        this.ramImmunity.set(a.id, now + RAM_IMMUNITY_MS);
        if (a.radius <= RAM_ASTEROID_DESTROY_R) {
          this.predictKill(a.id, XP.ASTEROID_DESTROY, "asteroid", a.x, a.y, now);
          this.netSendEvent("asteroid_hit", { asteroidId: a.id, damage: 1 });
          this.fx.sparks(a.x, a.y, 8, SHIELD_MOD_SPECS.ram.tint, { lifeMin: 150, lifeMax: 250 });
          sfx.play("hit_spark");
          this.trauma.add(0.1);
          continue;
        }
        this.gainXp(XP.ASTEROID_CHIP, now);
        this.netSendEvent("asteroid_hit", { asteroidId: a.id, damage: RAM_ASTEROID_CHIP });
        this.bounceOff(a.x, a.y, 0.6);
        if (this.applyDamage(RAM_SELF_DRAIN, a.x, a.y, "ASTEROID", null, now) !== "drained") {
          return;
        }
        continue;
      }
      if (now < this.contactIframeUntil) continue;
      const res = this.applyDamage(
        asteroidContactDamage(a.radius),
        a.x,
        a.y,
        "ASTEROID",
        null,
        now,
      );
      if (res !== "drained") return;
      this.bounceOff(a.x, a.y, 0.5);
      this.contactIframeUntil = now + CONTACT_IFRAME_MS;
      break;
    }
    if (!this.alive) return;

    // -- enemy hull contact + LANCER charge
    for (const e of this.world.enemies) {
      if (e.graceUntil > now) continue; // flashing in: harmless
      const charging = e.kind === "lancer" && e.chargeUntil > now;
      const r = charging ? LANCER_CHARGE_HIT_RADIUS : ENEMY_SPECS[e.kind].hitRadius;
      if (dist2(e.x, e.y, this.shipX, this.shipY) > r * r) continue;
      let nx = e.x - this.shipX;
      let ny = e.y - this.shipY;
      const nlen = Math.hypot(nx, ny) || 1;
      nx /= nlen;
      ny /= nlen;
      if (this.ramArmed()) {
        // The shield becomes a weapon: enemy takes 60, I pay 10 (25 vs a
        // mid-charge lancer, with the bounce + trauma).
        const imm = this.ramImmunity.get(e.id);
        if (imm !== undefined && now < imm) continue;
        this.ramImmunity.set(e.id, now + RAM_IMMUNITY_MS);
        if (e.hp - RAM_DAMAGE <= 0) {
          this.predictKill(e.id, this.enemyKillXp(e.kind), "enemy", e.x, e.y, now);
        }
        this.netSendEvent("enemy_hit", {
          enemyId: e.id,
          damage: RAM_DAMAGE,
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
          return;
        }
        continue;
      }
      if (now < this.contactIframeUntil) continue;
      const amount = charging
        ? DMG.LANCER_CHARGE
        : e.kind === "lancer"
          ? DMG.LANCER_HULL
          : e.kind === "dreadnought"
            ? BOSS_CONTACT_DMG
            : DMG.ENEMY_HULL;
      const res = this.applyDamage(amount, e.x, e.y, ENEMY_SPECS[e.kind].name, null, now);
      if (res !== "drained") return;
      this.bounceOff(e.x, e.y, 0.5);
      // knock both back (kept from v1)
      this.netSendEvent("enemy_hit", {
        enemyId: e.id,
        damage: 0,
        kx: nx * RAM_KNOCKBACK * 0.5,
        ky: ny * RAM_KNOCKBACK * 0.5,
      });
      this.contactIframeUntil = now + CONTACT_IFRAME_MS;
      break;
    }
    if (!this.alive) return;

    // -- enemy projectiles (host-owned; I detect my own hit, mirror of PvP
    // beams). Shots ignore contact i-frames and are always consumed.
    // Reverse index loop: consumeShot splices mid-iteration.
    for (let i = this.world.enemyShots.length - 1; i >= 0; i--) {
      const s = this.world.enemyShots[i];
      if (!s || this.recentConsumedShots.has(s.id)) continue; // consumed; host echo pending
      const hit = segHitsCircle(
        s.x - s.vx * dt,
        s.y - s.vy * dt,
        s.x,
        s.y,
        this.shipX,
        this.shipY,
        SHIP_RADIUS,
      );
      if (!hit) continue;
      // Shots aren't source-attributed on the wire; speed identifies the kind
      // (drone/warden/boss-plasma → DRONE, wasp → WASP, sniper/boss-lance → SNIPER).
      const { cause, dmg } = enemyShotHit(Math.hypot(s.vx, s.vy));
      this.consumeShot(s); // every shot that hits is consumed — same event
      if (this.reflectArmed()) {
        // Bounce: pay 12 shield instead of the damage, return the bolt.
        this.fireReflectBeam(Math.atan2(-s.vy, -s.vx), now);
        if (this.applyDamage(REFLECT_BOUNCE_COST, s.x, s.y, cause, null, now) !== "drained") {
          return;
        }
        continue;
      }
      const res = this.applyDamage(dmg, s.x, s.y, cause, null, now);
      if (res !== "drained") return;
    }
    if (!this.alive) return;

    // -- UFO contact (treated as a hull)
    const u = this.world.ufo;
    if (u && dist2(u.x, u.y, this.shipX, this.shipY) <= UFO_RADIUS * UFO_RADIUS) {
      if (this.ramArmed()) {
        const imm = this.ramImmunity.get(u.id);
        if (imm === undefined || now >= imm) {
          this.ramImmunity.set(u.id, now + RAM_IMMUNITY_MS);
          if (u.hp - RAM_DAMAGE <= 0) {
            this.predictKill(u.id, XP.UFO_DESTROY, "ufo", u.x, u.y, now);
          }
          this.netSendEvent("ufo_hit", { damage: RAM_DAMAGE / 100 });
          if (this.applyDamage(RAM_SELF_DRAIN, u.x, u.y, "UFO", null, now) !== "drained") return;
        }
      } else if (now >= this.contactIframeUntil) {
        const res = this.applyDamage(DMG.UFO_HULL, u.x, u.y, "UFO", null, now);
        if (res !== "drained") return;
        this.bounceOff(u.x, u.y, 0.5);
        this.contactIframeUntil = now + CONTACT_IFRAME_MS;
      }
    }
    if (!this.alive) return;

    // -- other players: armed-RAM hull contact + the beam volley rule (§A.2)
    const myId = this.myId;
    for (const [id, st] of this.peerStates) {
      if (id === myId) continue;
      if (!st || !st.alive) continue;

      // Remote armed RAM: the victim adjudicates its own 35 drain.
      const contact2 = SHIP_RADIUS * 2 * (SHIP_RADIUS * 2);
      const touching = dist2(st.x, st.y, this.shipX, this.shipY) <= contact2;
      if (touching && st.shieldMod?.kind === "ram" && st.shieldMod.active && !st.invuln) {
        if (now >= this.contactIframeUntil) {
          const res = this.applyDamage(RAM_PVP_DRAIN, st.x, st.y, "PLAYER", id, now);
          if (res !== "drained") return;
          this.bounceOff(st.x, st.y, 0.5);
          this.contactIframeUntil = now + CONTACT_IFRAME_MS;
        }
      }
      // My own armed RAM against their hull: I pay my 10 (they take their 35).
      if (touching && this.ramArmed()) {
        const imm = this.ramImmunity.get(id);
        if (imm === undefined || now >= imm) {
          this.ramImmunity.set(id, now + RAM_IMMUNITY_MS);
          if (this.applyDamage(RAM_SELF_DRAIN, st.x, st.y, "PLAYER", id, now) !== "drained") {
            return;
          }
        }
      }

      // Volley rule: test ALL of one shooter's beams this frame, sum the
      // drains, clamp, apply once, then i-frame that shooter — this is what
      // makes SCATTER one 48-drain volley instead of an instakill, and stops
      // a persistent beam snapshot draining 60×/s between 20Hz updates.
      const iframeUntil = this.pvpIframeUntil.get(id) ?? 0;
      if (now < iframeUntil) continue;
      let beamDrain = 0;
      let aoeDrain = 0;
      let anyExploding = false;
      let anyGlaive = false;
      let maxPower = 0;
      let impact: Vec | null = null;
      let reflectAngle = 0;
      // TESLA AURA (RAM pattern): the shooter's serialized flag + MY
      // proximity adjudicate the zap. It joins the same volley sum, so the
      // aura and any stray beam clamp + i-frame together.
      if (st.tesla && dist2(st.x, st.y, this.shipX, this.shipY) <= TESLA_RANGE * TESLA_RANGE) {
        beamDrain += TESLA_POWER * 100 * PVP_DAMAGE_MULT;
        maxPower = Math.max(maxPower, TESLA_POWER);
        impact = { x: st.x, y: st.y };
        reflectAngle = Math.atan2(st.y - this.shipY, st.x - this.shipX);
      }
      for (const sb of st.beams) {
        if (sb.mine && !sb.exploding) continue; // inert mines never hit-test
        if (sb.orb) continue; // SINGULARITY orb: only the pop damages
        // TESLA chains are render-only for PvP — the flag above is the drain.
        if (st.tesla && sb.chain) continue;
        let hit = false;
        let chainSeg = 0;
        // Width is render-real: pad by half so wide beams hit their cover.
        const pad = SHIP_RADIUS + sb.width / 2;
        if (sb.chain && sb.chain.length >= 2) {
          for (let i = 0; i < sb.chain.length - 1 && !hit; i++) {
            const p0 = sb.chain[i];
            const p1 = sb.chain[i + 1];
            if (p0 && p1) {
              hit = segHitsCircle(p0.x, p0.y, p1.x, p1.y, this.shipX, this.shipY, pad);
              if (hit) chainSeg = i;
            }
          }
        } else if (sb.exploding) {
          hit =
            dist2(sb.hx, sb.hy, this.shipX, this.shipY) <= sb.explosionRadius * sb.explosionRadius;
        } else {
          hit = segHitsCircle(sb.tx, sb.ty, sb.hx, sb.hy, this.shipX, this.shipY, pad);
        }
        if (!hit) continue;
        const power = sb.power ?? WEAPON_DEFAULT.power;
        maxPower = Math.max(maxPower, power);
        // ARC hops decay like the owner-side cast: segment i ends at hop i+1,
        // so segment 0 (muzzle→first target) is full power and each later
        // segment falls off once per hop — matching the PvE falloff exactly.
        const hopMult = sb.chain ? ARC_FALLOFF ** chainSeg : 1;
        const drain = power * 100 * PVP_DAMAGE_MULT * hopMult;
        if (sb.exploding) {
          aoeDrain += drain;
          anyExploding = true;
        } else {
          if (sb.glaive === true) anyGlaive = true;
          beamDrain += drain;
          reflectAngle = Math.atan2(sb.ty - sb.hy, sb.tx - sb.hx);
        }
        impact = impact ?? { x: sb.hx, y: sb.hy };
      }
      if (!impact) continue;
      // Heavy beams (RAILGUN, power ≥ 0.9) get the 300ms tier: a 320px lance
      // covers the victim across ≥2 serialized snapshots (~150ms at 20Hz), so
      // the 120ms i-frame would let one shot drain twice — 180 from full,
      // breaking PVP_MAX_SINGLE_HIT's no-volley-kills-from-full invariant.
      // No intended-TTK change: BLASTER (450ms) and RAILGUN (1100ms) both
      // refire slower than 300ms. GLAIVE shares the tier: the blade stalls at
      // its apex (GLAIVE_DECEL_PX), so a parked snapshot would otherwise
      // re-drain 35 every 120ms — apex camping beats the intended ~per-pass hit.
      this.pvpIframeUntil.set(
        id,
        now +
          (anyExploding || anyGlaive || maxPower >= 0.9
            ? PVP_EXPLOSION_IFRAME_MS
            : PVP_HIT_IFRAME_MS),
      );
      if (beamDrain > 0 && this.reflectArmed()) {
        // One bounce covers the entire same-frame volley; AoE is never
        // reflected and drains normally on top.
        this.fireReflectBeam(reflectAngle, now);
        beamDrain = REFLECT_BOUNCE_COST;
      }
      const total = Math.min(PVP_MAX_SINGLE_HIT, beamDrain + aoeDrain);
      const res = this.applyDamage(total, impact.x, impact.y, "PLAYER", id, now);
      if (res !== "drained") return;
    }
  }

  private die(now: number, killerId: string | null, cause: string): void {
    this.splinterBurst(this.shipX, this.shipY, 50, 30, now);
    this.fx.shatter(this.shipX, this.shipY, shipHullPoints(), this.shipAngle, this.myTint());
    this.fx.ring(this.shipX, this.shipY, 10, 90, 400, 0xffffff, 0.7);
    this.screenFlash();
    this.trauma.add(0.55);
    sfx.play("shield_break"); // break = death, layered under the boom (§A.4)
    sfx.play("player_death");
    this.alive = false;
    this.respawnAt = now + RESPAWN_DELAY_MS;
    this.invulnUntil = 0;
    this.beams = []; // mines included — they ride in beams[]
    this.sentry = null; // the turret dies with its owner
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
    this.deathHint = count >= 3 ? (DEATH_HINTS[cause] ?? "") : "";
    const myId = this.myId;
    if (killerId && myId) {
      this.netSendEvent("player_killed", { killerId, victimId: myId, cause });
    }
    this.pushMyState(now); // immediate, so remote ships hide without 50ms lag
  }

  /** 50ms full-screen white at 0.25, fading 200ms (§9 player death). */
  private screenFlash(): void {
    this.flashRect.setSize(this.scale.width + 8, this.scale.height + 8);
    this.flashRect.setAlpha(0.25);
    this.tweens.killTweensOf(this.flashRect);
    this.tweens.add({ targets: this.flashRect, alpha: 0, delay: 50, duration: 200 });
  }

  private myTint(): number {
    const myId = this.myId;
    return (myId ? this.ships.get(myId)?.tint : undefined) ?? 0xffffff;
  }

  private pickupItems(now: number): void {
    if (!this.alive || !this.spawned || now < this.phasedUntil) return;
    const items = this.world.items;
    for (let i = items.length - 1; i >= 0; i--) {
      const it = items[i];
      if (!it || this.recentPickups.has(it.id)) continue;
      if (dist2(it.x, it.y, this.shipX, this.shipY) > ITEM_PICKUP_RADIUS * ITEM_PICKUP_RADIUS) {
        continue;
      }
      if (it.kind === "weapon") {
        const weapon = WEAPONS_SPECIAL[it.weaponIdx] ?? WEAPON_DEFAULT;
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
          this.weaponUntil = now + SPECIAL_WEAPON_DURATION_MS; // replace resets the timer
          this.windupAcc = 0;
        }
        this.fx.sparks(this.shipX, this.shipY, 14, weapon.tint, {
          speedMin: 30,
          speedMax: 140,
          lifeMin: 200,
          lifeMax: 420,
        });
        sfx.play("pickup");
      } else if (it.kind === "shield") {
        // Timed shield MODIFIER on the base shield (one held; same kind
        // extends +20s capped at 60s out AND refreshes its resource;
        // different kind replaces).
        const kind = SHIELD_MOD_KINDS[it.shieldIdx] ?? "overshield";
        if (kind === this.shieldMod && now < this.shieldModUntil) {
          this.shieldModUntil = Math.min(
            this.shieldModUntil + SHIELD_MOD_DURATION_MS,
            now + ITEM_STACK_CAP_MS,
          );
          if (kind === "overshield") this.overHp = OVERSHIELD_BONUS; // bonus refill
          if (kind === "phase") this.phaseReadyAt = 0; // blink ready again
        } else {
          this.shieldMod = kind;
          this.shieldModUntil = now + SHIELD_MOD_DURATION_MS;
          this.overHp = kind === "overshield" ? OVERSHIELD_BONUS : 0;
          this.phaseReadyAt = 0;
        }
        this.haloFlashUntil = now + 200;
        this.fx.sparks(this.shipX, this.shipY, 14, SHIELD_MOD_SPECS[kind].tint, {
          speedMin: 30,
          speedMax: 140,
          lifeMin: 200,
          lifeMax: 420,
        });
        sfx.play("pickup_shield");
      } else {
        const kind = BOOSTER_KINDS[it.boosterIdx] ?? "repair";
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
            cur !== undefined && cur > now
              ? Math.min(cur + dur, now + ITEM_STACK_CAP_MS)
              : now + dur,
          );
        }
        this.fx.sparks(this.shipX, this.shipY, 14, BOOSTER_SPECS[kind].tint, {
          speedMin: 30,
          speedMax: 140,
          lifeMin: 200,
          lifeMax: 420,
        });
        sfx.play("pickup_booster");
      }
      this.recentPickups.set(it.id, now);
      this.netSendEvent("item_pickup", { itemId: it.id });
      // Remove locally right away; the host event (or the next reconcile,
      // guarded by recentPickups) makes it stick.
      items.splice(i, 1);
      if (this.amHost) this.dirty.items = true;
    }
    for (const [id, t] of this.recentPickups) {
      if (now - t > 5000) this.recentPickups.delete(id);
    }
    for (const [id, t] of this.recentConsumedShots) {
      if (now - t > 5000) this.recentConsumedShots.delete(id);
    }
    for (const [id, t] of this.ramImmunity) {
      if (now > t) this.ramImmunity.delete(id);
    }
    for (const [id, t] of this.pvpIframeUntil) {
      if (now > t) this.pvpIframeUntil.delete(id);
    }
  }

  /** XP orbs (former score shards): generous-radius hoover, +XP.ORB each (flat,
   *  never combo-multiplied; SALVAGE doubles it). Same claimer pattern as items:
   *  collect locally, tell the host, guard reconciles. */
  private collectShards(now: number): void {
    if (!this.alive || !this.spawned || now < this.phasedUntil) return;
    const r2 = SHARD_PICKUP_RADIUS * SHARD_PICKUP_RADIUS;
    const shards = this.world.shards;
    const orbXp = (this.boosts.get("salvage") ?? 0) > now ? XP.ORB * SALVAGE_MULT : XP.ORB;
    for (let i = shards.length - 1; i >= 0; i--) {
      const s = shards[i];
      if (!s || this.recentShardPickups.has(s.id)) continue;
      if (dist2(s.x, s.y, this.shipX, this.shipY) > r2) continue;
      this.gainXp(orbXp, now);
      this.recentShardPickups.set(s.id, now);
      this.netSendEvent("shard_pickup", { shardId: s.id });
      shards.splice(i, 1);
      if (this.amHost) this.dirty.shards = true;
      // Pooled sparkle + soft collect blip (pickup chirp, low gain, pitched up).
      this.fx.sparks(s.x, s.y, 3, SHARD_TINT, {
        speedMin: 20,
        speedMax: 90,
        lifeMin: 120,
        lifeMax: 220,
        scale: 0.4,
      });
      sfx.play("pickup", { gain: 0.25, rate: 1.6 });
    }
    for (const [id, t] of this.recentShardPickups) {
      if (now - t > 5000) this.recentShardPickups.delete(id);
    }
  }

  /** Tiny wireframe crystals, one pooled Graphics pass (additive layer):
   *  4-point diamond + vertical facet, gentle pulse, fade in the last 1.5s. */
  private drawShards(now: number): void {
    const g = this.shardGfx;
    g.clear();
    for (const s of this.world.shards) {
      const left = s.diesAt - now;
      if (left <= 0) continue;
      const alpha = 0.9 * Math.min(1, left / 1500);
      const r = 2.5 + 0.7 * Math.sin(now / 180 + s.x * 0.05);
      g.lineStyle(1, SHARD_TINT, alpha);
      strokeDiamond(g, s.x, s.y, r);
      g.lineBetween(s.x, s.y - r, s.x, s.y + r);
    }
  }

  private netSend(delta: number, now: number): void {
    this.netAcc += delta;
    if (this.netAcc < NET_INTERVAL_MS) return;
    this.netAcc = 0;
    this.pushMyState(now);
  }

  /** Wire shape of my shield mod: `active` = ram-armed / reflect->40 / phase-ready. */
  private shieldModNetState(now: number): ShieldModNetState | null {
    const mod = this.shieldMod;
    if (!mod) return null;
    const active =
      mod === "ram"
        ? this.ramArmed()
        : mod === "reflect"
          ? this.reflectArmed()
          : mod === "phase"
            ? now >= this.phaseReadyAt
            : true;
    return { kind: mod, until: this.shieldModUntil, active, phased: now < this.phasedUntil };
  }

  private boostsNetState(): BoostNetState[] {
    const out: BoostNetState[] = [];
    for (const [kind, until] of this.boosts) out.push({ kind, until });
    return out;
  }

  private pushMyState(now: number): void {
    if (!this.myId) return;
    const state: PlayerNetState = {
      x: this.shipX,
      y: this.shipY,
      angle: this.shipAngle,
      vx: this.shipVX,
      vy: this.shipVY,
      alive: this.alive,
      // present tracks "in the arena": spawned covers pre-spawn AND the paused
      // despawn (which clears spawned) in one flag.
      present: this.spawned,
      invuln: now < this.invulnUntil,
      level: this.level,
      xp: this.xp,
      streak: this.streak,
      sectorScore: Math.round(this.sectorScore),
      weaponName: this.weapon.name,
      shieldHp: Math.max(0, Math.round(this.shieldHp)),
      overHp: Math.max(0, Math.round(this.overHp)),
      shieldMod: this.shieldModNetState(now),
      boosts: this.boostsNetState(),
      windup: this.windupFrac(),
      tesla: this.teslaActive(now),
      sentry:
        this.sentry && now < this.sentry.until
          ? { x: this.sentry.x, y: this.sentry.y, until: this.sentry.until }
          : null,
      beams: this.beams.filter((b) => !b.vanished && !b.fizzle).map(serializeBeam),
    };
    if (!this.offline) this.client.updateMyState(playerToWire(state));
  }

  // ---- connection callbacks ----------------------------------------------------

  private handleEvent(event: string, payload: unknown, _from: string): void {
    const p = asRecord(payload);
    if (event === "player_killed") {
      // The killer awards itself: every client hears the victim's report.
      if (p && p["killerId"] === this.myId) {
        this.registerKill(XP.PLAYER_KILL, simNow(), "player");
      }
      return;
    }
    if (!this.amHost || !p) return;
    if (event === "asteroid_hit") {
      const id = p["asteroidId"];
      const damage = p["damage"];
      if (typeof id === "string" && typeof damage === "number") {
        this.hostDamageAsteroid(id, damage);
      }
    } else if (event === "ufo_hit") {
      const damage = p["damage"];
      if (typeof damage === "number") this.hostDamageUfo(damage);
    } else if (event === "enemy_hit") {
      const id = p["enemyId"];
      const damage = p["damage"];
      if (typeof id === "string" && typeof damage === "number") {
        const kx = typeof p["kx"] === "number" ? p["kx"] : 0;
        const ky = typeof p["ky"] === "number" ? p["ky"] : 0;
        this.hostDamageEnemy(id, damage, kx, ky);
      }
    } else if (event === "proj_consumed") {
      const id = p["shotId"];
      if (typeof id !== "string") return;
      const idx = this.world.enemyShots.findIndex((s) => s.id === id);
      if (idx !== -1) {
        this.world.enemyShots.splice(idx, 1);
        this.dirty.enemyShots = true;
      }
    } else if (event === "item_pickup") {
      const id = p["itemId"];
      if (typeof id !== "string") return;
      const idx = this.world.items.findIndex((it) => it.id === id);
      if (idx !== -1) {
        this.world.items.splice(idx, 1);
        this.dirty.items = true;
      }
    } else if (event === "shard_pickup") {
      const id = p["shardId"];
      if (typeof id !== "string") return;
      const idx = this.world.shards.findIndex((s) => s.id === id);
      if (idx !== -1) {
        this.world.shards.splice(idx, 1);
        this.dirty.shards = true;
      }
    } else if (event === "singularity") {
      // SINGULARITY collapse: one shared pull entry; hostApplyPulls drags
      // enemies/asteroids until it expires (pruned in hostTick).
      const x = p["x"];
      const y = p["y"];
      const until = p["until"];
      if (typeof x === "number" && typeof y === "number" && typeof until === "number") {
        this.world.pulls.push({ id: entityId(), x, y, until });
        this.dirty.pulls = true;
      }
    }
  }

  private onUpdate(): void {
    this.ensureSeeded();
    // Reconcile only when the shared object identity changed (i.e. a real
    // state patch) — notify() also fires for player-state traffic, and
    // re-blending toward a stale snapshot would drag entities backwards.
    if (!this.amHost && this.client.sharedState !== this.lastSharedRef) {
      this.lastSharedRef = this.client.sharedState;
      this.reconcileFromShared();
    }
  }

  private shared(): SharedState | null {
    if (this.offline) return this.world; // local world is authoritative solo
    return isShared(this.client.sharedState) ? this.client.sharedState : null;
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
      for (let i = 0; i < ASTEROID_SEED_COUNT; i++) {
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
    if (this.amHost && this.client.connectionStatus === "connected" && !this.shared()) {
      const seeded = emptyShared();
      seedField(seeded);
      this.world = seeded;
      this.client.updateSharedState(sharedToPatch(seeded));
    }
  }

  /** Guest-side: adopt the host's 20Hz snapshot into the local working copy. */
  private reconcileFromShared(): void {
    const s = this.shared();
    if (!s) return;
    const w = this.world;
    if (typeof s.arenaEpoch === "number") w.arenaEpoch = s.arenaEpoch;
    // Boss-guarantee marker (dir-006): adopt like the epoch so a promoted
    // host never double-guarantees. Legacy snapshots omit it → keep local.
    if (typeof s.sectorBossIdx === "number") w.sectorBossIdx = s.sectorBossIdx;
    // Clamp to valid bounds — never trust an out-of-range value from the host.
    if (typeof s.playW === "number") w.playW = Phaser.Math.Clamp(s.playW, BASE_WORLD_W, WORLD_W);
    if (typeof s.playH === "number") w.playH = Phaser.Math.Clamp(s.playH, BASE_WORLD_H, WORLD_H);

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

    const localItems = indexById(w.items);
    const itemIds = new Set<string>();
    for (const it of s.items ?? []) {
      itemIds.add(it.id);
      if (this.recentPickups.has(it.id)) continue; // picked locally, host lagging
      const local = localItems.get(it.id);
      if (!local) {
        w.items.push({ ...it });
        continue;
      }
      local.vx = it.vx;
      local.vy = it.vy;
      local.diesAt = it.diesAt;
      blendPos(local, it.x, it.y);
    }
    w.items = w.items.filter((x) => itemIds.has(x.id) && !this.recentPickups.has(x.id));

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
      // Keep the most pessimistic blink (local prediction may be ahead).
      local.blinkUntil = Math.max(local.blinkUntil, e.blinkUntil);
      local.graceUntil = e.graceUntil;
      local.maxHp = e.maxHp;
      local.lances = e.lances; // sniper/boss laser sights
      local.shielded = e.shielded; // warden shield state
      blendPos(local, e.x, e.y);
    }
    w.enemies = w.enemies.filter((x) => enemyIds.has(x.id));

    const localShards = indexById(w.shards);
    const shardIds = new Set<string>();
    for (const sd of s.shards ?? []) {
      shardIds.add(sd.id);
      if (this.recentShardPickups.has(sd.id)) continue; // collected locally, host lagging
      const local = localShards.get(sd.id);
      if (!local) {
        w.shards.push({ ...sd });
        continue;
      }
      local.vx = sd.vx;
      local.vy = sd.vy;
      local.diesAt = sd.diesAt;
      blendPos(local, sd.x, sd.y);
    }
    w.shards = w.shards.filter((x) => shardIds.has(x.id) && !this.recentShardPickups.has(x.id));

    const localShots = indexById(w.enemyShots);
    const shotIds = new Set<string>();
    for (const sh of s.enemyShots ?? []) {
      shotIds.add(sh.id);
      if (this.recentConsumedShots.has(sh.id)) continue; // consumed locally, host lagging
      const local = localShots.get(sh.id);
      if (!local) {
        w.enemyShots.push({ ...sh });
        continue;
      }
      local.vx = sh.vx;
      local.vy = sh.vy;
      local.diesAt = sh.diesAt;
      blendPos(local, sh.x, sh.y);
    }
    w.enemyShots = w.enemyShots.filter(
      (x) => shotIds.has(x.id) && !this.recentConsumedShots.has(x.id),
    );

    // Pulls are static entries — adopt wholesale (the vortex renders from
    // them; the host moves the affected bodies).
    w.pulls = (s.pulls ?? []).map((p) => ({ id: p.id, x: p.x, y: p.y, until: p.until }));

    // Beacon: one static host-written entry — adopt wholesale. Phases and
    // countdowns derive from its timestamps locally (tickBeaconClient).
    w.beacon = s.beacon ? { ...s.beacon } : null;
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
      e.x = Phaser.Math.Clamp(e.x + e.vx * dt, -40, this.world.playW + 40);
      e.y = Phaser.Math.Clamp(e.y + e.vy * dt, -40, this.world.playH + 40);
    }
    for (const s of this.world.enemyShots) {
      s.x += s.vx * dt;
      s.y += s.vy * dt;
    }
  }

  // ---- host-only logic -------------------------------------------------------------

  private hostTick(now: number, dt: number, delta: number): void {
    if (!this.wasHost) {
      // First tick after promotion (or first-ever host): zeroed spawn stamps
      // would read as long-overdue and burst-spawn. Start intervals from now.
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

    if (
      w.asteroids.length < asteroidCap(intensity, pressure, wave) &&
      now - this.lastAsteroidSpawnAt > asteroidSpawnIntervalMs(intensity)
    ) {
      w.asteroids.push(spawnAsteroidState(w.playW, w.playH));
      this.lastAsteroidSpawnAt = now;
      d.asteroids = true;
    }

    const kept = w.asteroids.filter((a) =>
      inWorld(a.x, a.y, ASTEROID_CULL_MARGIN, w.playW, w.playH),
    );
    if (kept.length !== w.asteroids.length) {
      w.asteroids = kept;
      d.asteroids = true;
    }

    // UFO is the weapon piñata; the v2 gate relaxes to < 2 weapon items live.
    const weaponItemsInFlight = w.items.filter((it) => it.kind === "weapon").length;
    if (!w.ufo && weaponItemsInFlight < 2 && rand() < UFO_SPAWN_RATE * dt) {
      w.ufo = spawnUfoState(w.playW, w.playH);
      d.ufo = true;
    }
    if (w.ufo && w.ufo.x === w.ufo.destX && w.ufo.y === w.ufo.destY) {
      w.ufo.destX = rand() * w.playW;
      w.ufo.destY = rand() * w.playH;
      d.ufo = true;
    }

    const liveItems = w.items.filter((it) => it.diesAt > now);
    if (liveItems.length !== w.items.length) {
      w.items = liveItems;
      d.items = true;
    }
    const liveShards = w.shards.filter((s) => s.diesAt > now);
    if (liveShards.length !== w.shards.length) {
      w.shards = liveShards;
      d.shards = true;
    }
    this.hostMagnetItems(now);

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
    this.hostDespawnBreather(now, intensity, pressure, wave, players);

    const liveShots = w.enemyShots.filter(
      (s) => s.diesAt > now && inWorld(s.x, s.y, 60, w.playW, w.playH),
    );
    if (liveShots.length !== w.enemyShots.length) {
      w.enemyShots = liveShots;
      d.enemyShots = true;
    }

    // Continuous motion dirties whatever is actually moving.
    if (w.asteroids.length > 0) d.asteroids = true;
    if (w.ufo) d.ufo = true;
    if (w.items.length > 0) d.items = true;
    if (w.shards.length > 0) d.shards = true;
    if (w.enemies.length > 0) d.enemies = true;
    if (w.enemyShots.length > 0) d.enemyShots = true;

    this.shareAcc += delta;
    if (this.shareAcc < NET_INTERVAL_MS) return;
    this.shareAcc = 0;
    // Quantize at the serialization boundary (shared/wire.ts) — the working
    // arrays keep full precision, only the outgoing snapshot is rounded.
    const patch: Record<string, unknown> = {};
    if (d.asteroids) patch["asteroids"] = w.asteroids.map(asteroidToWire);
    if (d.ufo) patch["ufo"] = w.ufo ? ufoToWire(w.ufo) : null;
    if (d.items) patch["items"] = w.items.map(itemToWire);
    if (d.shards) patch["shards"] = w.shards.map(shardToWire);
    if (d.enemies) patch["enemies"] = w.enemies.map(enemyToWire);
    if (d.enemyShots) patch["enemyShots"] = w.enemyShots.map(enemyShotToWire);
    if (d.pulls) patch["pulls"] = w.pulls.map(pullToWire);
    if (d.beacon) patch["beacon"] = w.beacon ? beaconToWire(w.beacon) : null;
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
    if (!this.offline && Object.keys(patch).length > 0) this.client.updateSharedState(patch);
    this.dirty = {
      asteroids: false,
      ufo: false,
      items: false,
      enemies: false,
      enemyShots: false,
      shards: false,
      pulls: false,
      beacon: false,
    };
  }

  // ---- BEACON arena event (dir-004): host-side trigger/control/payout -----------------

  /** Alive+present players with ids — the beacon control census. Phased ships
   *  still count (they are IN the arena; only enemy targeting ignores them). */
  private beaconOccupants(cx: number, cy: number): string[] {
    const out: string[] = [];
    const myId = this.myId;
    if (
      myId &&
      this.alive &&
      this.spawned &&
      Math.hypot(this.shipX - cx, this.shipY - cy) <= BEACON_RADIUS
    ) {
      out.push(myId);
    }
    for (const [id, st] of this.peerStates) {
      if (id === myId || !st || !st.alive || !st.present) continue;
      if (Math.hypot(st.x - cx, st.y - cy) <= BEACON_RADIUS) out.push(id);
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
    if (sectorRelT(tSec) < BEACON_MIN_T_S) return;
    // dir-006: one "be HERE now" at a time — no NEW beacon while a dreadnought
    // is alive. A beacon already live completes normally (block above); the
    // deferred slot is not queued — the next eligible trough after boss death
    // picks the cadence back up through these same gates.
    if (w.enemies.some((e) => e.kind === "dreadnought")) return;
    if (tSec % BEACON_TROUGH_PERIOD_S > BEACON_SPAWN_WINDOW_S) return;
    if (
      this.lastBeaconStartedAt > 0 &&
      now - this.lastBeaconStartedAt < BEACON_MIN_INTERVAL_S * 1000
    )
      return;
    // Placement: ≥600px inside the barrier, ≥900px from every present player
    // (fair approach run); crowded arenas take the candidate farthest from
    // the nearest player.
    let best: Vec | null = null;
    let bestClearance = -1;
    for (let i = 0; i < 12; i++) {
      const c = randomWorldPoint(BEACON_EDGE_MARGIN, BEACON_EDGE_MARGIN, w.playW, w.playH);
      let nearest = Infinity;
      for (const p of players) nearest = Math.min(nearest, Math.hypot(p.x - c.x, p.y - c.y));
      if (nearest > bestClearance) {
        bestClearance = nearest;
        best = c;
      }
      if (nearest >= BEACON_PLAYER_CLEARANCE) break;
    }
    if (!best) return;
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
      x,
      y,
      activeAt: now + chargeS * 1000,
      diesAt: now + (chargeS + activeS) * 1000,
      controllerId: null,
      contested: false,
    };
    this.lastBeaconStartedAt = now;
    this.dirty.beacon = true;
  }

  /** Position of a player by id (me from the live ship, remotes from their
   *  net state). Null when unknown/absent. */
  private playerPos(id: string): Vec | null {
    if (id === this.myId)
      return this.spawned && this.alive ? { x: this.shipX, y: this.shipY } : null;
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
    if (prev && (!b || b.activeAt !== prev.activeAt) && now >= prev.diesAt - 100) {
      if (prev.controllerId !== null && !prev.contested) {
        // Gold shockwave — fx only, no damage; every client draws it.
        this.fx.ring(prev.x, prev.y, 40, BEACON_RADIUS, 650, BEACON_TINT, 0.9);
        this.fx.sparks(prev.x, prev.y, 14, BEACON_TINT, {
          speedMin: 80,
          speedMax: 260,
          lifeMin: 250,
          lifeMax: 500,
        });
        if (prev.controllerId === this.myId) {
          this.gainXp(BEACON_HOLD_BONUS_XP, now);
          this.trauma.add(0.08);
          sfx.play("beacon_active", { rate: 1.4 });
        }
      }
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
    const gainFor = (x: number, y: number): number => {
      const d = Math.hypot(x - this.shipX, y - this.shipY);
      return Phaser.Math.Clamp(1 - d / 3500, 0.2, 1);
    };
    if (now < b.activeAt) {
      // CHARGE: one blip per second, pitch ratcheting up (distance-attenuated).
      const idx = Math.floor((now - (b.activeAt - BEACON_CHARGE_S * 1000)) / 1000);
      if (idx > this.beaconBlipIdx && idx >= 0) {
        this.beaconBlipIdx = idx;
        sfx.play("beacon_charge", { rate: 1 + idx * 0.09, gain: gainFor(b.x, b.y) });
      }
    } else {
      if (!this.beaconArmedFxDone) {
        // CHARGE → ACTIVE: arena-audible chime + full-ring flash.
        this.beaconArmedFxDone = true;
        sfx.play("beacon_active");
        this.fx.ring(b.x, b.y, BEACON_RADIUS * 0.6, BEACON_RADIUS * 1.2, 500, BEACON_TINT, 0.9);
      }
      if (b.contested && now - this.beaconLastClashAt > 700) {
        this.beaconLastClashAt = now;
        sfx.play("beacon_clash", { gain: gainFor(b.x, b.y) });
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
    this.lastBeacon = { ...b };
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
      if (p.until <= now) continue;
      for (const a of this.world.asteroids) {
        const d = Math.hypot(p.x - a.x, p.y - a.y);
        if (d > SINGULARITY_PULL_RANGE || d < 1) continue;
        const sp = SINGULARITY_PULL_SPEED * Math.min(1, Math.max(0.15, d / 100));
        a.vx = ((p.x - a.x) / d) * sp;
        a.vy = ((p.y - a.y) / d) * sp;
      }
      for (const e of this.world.enemies) {
        const d = Math.hypot(p.x - e.x, p.y - e.y);
        if (d > SINGULARITY_PULL_RANGE || d < 1) continue;
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
    if (w.items.length === 0 && w.shards.length === 0) return;
    const holders: Vec[] = [];
    const mine = this.boosts.get("magnet");
    if (mine !== undefined && mine > now && this.alive && this.spawned) {
      holders.push({ x: this.shipX, y: this.shipY });
    }
    const myId = this.myId;
    for (const [id, st] of this.peerStates) {
      if (id === myId) continue;
      if (!st || !st.alive) continue;
      if (st.boosts.some((b) => b.kind === "magnet" && b.until > now)) {
        holders.push({ x: st.x, y: st.y });
      }
    }
    if (holders.length === 0) return;
    for (const it of w.items) {
      const h = nearestOf(holders, it.x, it.y);
      if (!h) continue;
      const d = Math.hypot(h.x - it.x, h.y - it.y);
      if (d <= MAGNET_RANGE && d > 1) {
        it.vx = ((h.x - it.x) / d) * MAGNET_PULL_SPEED;
        it.vy = ((h.y - it.y) / d) * MAGNET_PULL_SPEED;
      } else {
        const sp = Math.hypot(it.vx, it.vy);
        if (sp > ITEM_SPEED + 1) {
          // Left the magnet's range: settle back to drift speed.
          it.vx = (it.vx / sp) * ITEM_SPEED;
          it.vy = (it.vy / sp) * ITEM_SPEED;
        }
      }
    }
    this.dirty.items = true;
    for (const s of w.shards) {
      const h = nearestOf(holders, s.x, s.y);
      if (!h) continue;
      const d = Math.hypot(h.x - s.x, h.y - s.y);
      if (d <= MAGNET_RANGE && d > 1) {
        s.vx = ((h.x - s.x) / d) * SHARD_MAGNET_PULL_SPEED;
        s.vy = ((h.y - s.y) / d) * SHARD_MAGNET_PULL_SPEED;
      } else {
        const sp = Math.hypot(s.vx, s.vy);
        if (sp > SHARD_DRIFT_SPEED + 1) {
          s.vx = (s.vx / sp) * SHARD_DRIFT_SPEED;
          s.vy = (s.vy / sp) * SHARD_DRIFT_SPEED;
        }
      }
    }
    this.dirty.shards = true;
  }

  /** Highest level among present players in the local view (default 1 when
   *  unknowable). Drives elite HP stamping at spawn (host) and elite kill XP
   *  (shooter) — qa-018: the same multiplier moves cost and reward together. */
  private maxPresentLevel(): number {
    let max = this.spawned ? this.level : 1;
    const myId = this.myId;
    for (const [id, st] of this.peerStates) {
      if (id === myId || !st || !st.present) continue;
      if (st.level > max) max = st.level;
    }
    return Math.max(1, max);
  }

  /** Kill XP for an enemy kind, computed at kill time. Elites pay
   *  round(base × eliteHpMult) so pts-per-second survives the durability
   *  retune; everything else (fodder, sniper, boss) pays the flat spec value.
   *  A Lv1 room pays exactly the pre-retune numbers by construction. */
  private enemyKillXp(kind: EnemyKind): number {
    const base = ENEMY_SPECS[kind].xp;
    if (ELITE_HP_BASE[kind] === undefined) return base;
    return Math.round(base * eliteHpMult(this.maxPresentLevel()));
  }

  /** Living player positions (mine locally + remotes from net state). */
  private livingPlayers(): Vec[] {
    const out: Vec[] = [];
    if (this.alive && this.spawned && simNow() >= this.phasedUntil) {
      out.push({ x: this.shipX, y: this.shipY });
    }
    const myId = this.myId;
    for (const [id, st] of this.peerStates) {
      if (id === myId) continue;
      if (st && st.alive && !st.shieldMod?.phased) out.push({ x: st.x, y: st.y });
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
    if (tSec * 1000 < ARENA_SAFE_MS) return; // safe opening
    if (now < this.debutSuppressUntil) return;
    const w = this.world;
    const early = tSec < EARLY_SPAWN_WINDOW_S;
    // Early debut wave: the moment the safe opening ends, seed a few drones in
    // the convergence ring at once so the arena's first threats are already
    // visibly inbound. This IS the drone debut (suppression follows as usual).
    if (early && !this.debuted.has("drone") && w.enemies.length === 0 && players.length > 0) {
      for (let i = 0; i < EARLY_FODDER_SEED_COUNT; i++) {
        const placed = this.ringPlacementNear(players, EARLY_SEED_RING_MAX);
        if (!placed) break;
        const e = spawnEnemyState("drone", placed.x, placed.y);
        e.angle = placed.ang;
        w.enemies.push(e);
      }
      this.debuted.add("drone");
      this.debutSuppressUntil = now + ENEMY_DEBUT_SUPPRESS_MS;
      this.lastEnemySpawnAt = now;
      this.dirty.enemies = true;
      return;
    }
    if (w.enemies.length >= enemyCap(intensity, pressure, wave)) return;
    const interval = early
      ? Math.min(enemySpawnIntervalMs(intensity), EARLY_SPAWN_INTERVAL_MS)
      : enemySpawnIntervalMs(intensity);
    if (now - this.lastEnemySpawnAt < interval) return;
    const avail = ENEMY_KINDS.filter((k) => enemySpawnWeight(k, intensity) > 0);
    if (avail.length === 0) return;
    // Debut rule: a type's first appearance is solo + suppresses other spawns.
    let kind = avail.find((k) => !this.debuted.has(k)) ?? null;
    const isDebut = kind !== null;
    if (!kind) kind = weightedEnemyRoll(avail, intensity);
    if (!kind) return;
    // Early window: fodder converges via the ring outside a player's viewport;
    // elites (and everything after the window) keep the far edge entrance.
    let placed: { x: number; y: number; ang: number } | null = null;
    if (early && EARLY_FODDER_KINDS.includes(kind) && players.length > 0) {
      placed = this.ringPlacementNear(players);
    }
    // BEACON lure (solo stand-your-ground read): while a beacon is on the
    // field, half of new spawns land on a ring around it, aimed at the zone.
    // Bias only — caps, weights and intervals above are untouched.
    const beacon = w.beacon;
    if (!placed && beacon && rand() < BEACON_LURE_FRACTION) {
      const ang = rand() * Math.PI * 2;
      const r = BEACON_LURE_RING_MIN + rand() * (BEACON_LURE_RING_MAX - BEACON_LURE_RING_MIN);
      const x = Phaser.Math.Clamp(beacon.x + Math.cos(ang) * r, 30, w.playW - 30);
      const y = Phaser.Math.Clamp(beacon.y + Math.sin(ang) * r, 30, w.playH - 30);
      const clear = players.every((p) => Math.hypot(p.x - x, p.y - y) >= ENEMY_SPAWN_CLEARANCE);
      if (clear) placed = { x, y, ang: Math.atan2(beacon.y - y, beacon.x - x) };
    }
    for (let i = 0; i < 5 && !placed; i++) {
      const c = edgeSpawn(30, this.world.playW, this.world.playH);
      const clear = players.every((p) => Math.hypot(p.x - c.x, p.y - c.y) >= ENEMY_SPAWN_CLEARANCE);
      if (clear) placed = c;
    }
    if (!placed) return; // skip this tick
    const e = spawnEnemyState(kind, placed.x, placed.y);
    e.angle = placed.ang;
    // qa-018: elites are stamped to the room's beam-DPS ceiling at spawn (the
    // exact bossHp pattern). Stamped ONCE — leveling never retro-buffs a live
    // elite. Fodder, sniper and the boss keep their spec hp.
    if (ELITE_HP_BASE[kind] !== undefined) {
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

  /** A clear point in the early-onslaught ring [ENEMY_SPAWN_CLEARANCE ..
   *  maxR] around a random living player, aimed at them.
   *  Null when clamping keeps violating clearance (caller falls back / skips). */
  private ringPlacementNear(
    players: Vec[],
    maxR = EARLY_SPAWN_RING_MAX,
  ): { x: number; y: number; ang: number } | null {
    for (let i = 0; i < 8; i++) {
      const anchor = players[Math.floor(rand() * players.length)];
      if (!anchor) return null;
      const c = ringSpawnPoint(
        anchor.x,
        anchor.y,
        ENEMY_SPAWN_CLEARANCE,
        maxR,
        this.world.playW,
        this.world.playH,
      );
      const clear = players.every((p) => Math.hypot(p.x - c.x, p.y - c.y) >= ENEMY_SPAWN_CLEARANCE);
      if (clear) return c;
    }
    return null;
  }

  private simFor(id: string): EnemySim {
    let sim = this.enemySim.get(id);
    if (!sim) {
      sim = {
        nextAttackAt: 0,
        fireAt: 0,
        burstLeft: 0,
        nextBurstShotAt: 0,
        lancerPhase: "cruise",
        phaseUntil: 0,
        orbitDir: rand() < 0.5 ? 1 : -1,
        wobblePhase: rand() * Math.PI * 2,
        kbVx: 0,
        kbVy: 0,
        broodCount: 0,
        broodParent: null,
        bossPhaseSeen: 0,
        bossPhaseFloorUntil: 0,
      };
      this.enemySim.set(id, sim);
    }
    return sim;
  }

  private hostSpawnShot(x: number, y: number, angle: number, speed: number, now: number): void {
    this.world.enemyShots.push({
      id: entityId(),
      x,
      y,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      diesAt: now + ENEMY_SHOT_TTL_MS,
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
      let target = nearestOf(players, e.x, e.y);
      // BEACON lure: fodder near the zone steers for its center instead —
      // nearest-of semantics, so a player inside the zone is closer and wins.
      const beacon = this.world.beacon;
      if (beacon && (e.kind === "drone" || e.kind === "wasp")) {
        const bd = Math.hypot(beacon.x - e.x, beacon.y - e.y);
        if (
          bd < BEACON_RETARGET_RANGE &&
          (!target || bd < Math.hypot(target.x - e.x, target.y - e.y))
        ) {
          target = { x: beacon.x, y: beacon.y };
        }
      }
      if (!target) {
        e.vx *= Math.exp(-1 * dt);
        e.vy *= Math.exp(-1 * dt);
        continue;
      }
      const dx = target.x - e.x;
      const dy = target.y - e.y;
      const dist = Math.hypot(dx, dy) || 1;
      const desired = Math.atan2(dy, dx);
      switch (e.kind) {
        case "drone": {
          e.angle = rotateToward(e.angle, desired, DRONE_TURN_DEG_PER_S * DEG * dt);
          e.vx = Math.cos(e.angle) * DRONE_SPEED;
          e.vy = Math.sin(e.angle) * DRONE_SPEED;
          if (sim.fireAt > 0) {
            if (now >= sim.fireAt) {
              sim.fireAt = 0;
              sim.nextAttackAt = now + DRONE_COOLDOWN_MS;
              if (dist < ENEMY_FIRE_RANGE) {
                this.hostSpawnShot(e.x, e.y, desired, DRONE_SHOT_SPEED, now);
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
          break;
        }
        case "wasp": {
          e.angle = desired;
          if (dist > WASP_ORBIT_RADIUS + 80) {
            e.vx = (dx / dist) * WASP_SPEED;
            e.vy = (dy / dist) * WASP_SPEED;
          } else {
            // Perpendicular strafe around the orbit ring + sin wobble.
            const wobble =
              Math.sin((now / 1000) * WASP_WOBBLE_HZ * Math.PI * 2 + sim.wobblePhase) *
              WASP_WOBBLE_AMP;
            const radialErr = dist - (WASP_ORBIT_RADIUS + wobble);
            const inX = dx / dist;
            const inY = dy / dist;
            let mx = -inY * sim.orbitDir + inX * Phaser.Math.Clamp(radialErr / 80, -1, 1);
            let my = inX * sim.orbitDir + inY * Phaser.Math.Clamp(radialErr / 80, -1, 1);
            const mlen = Math.hypot(mx, my) || 1;
            mx /= mlen;
            my /= mlen;
            e.vx = mx * WASP_SPEED;
            e.vy = my * WASP_SPEED;
          }
          if (sim.burstLeft > 0) {
            if (now >= sim.nextBurstShotAt) {
              this.hostSpawnShot(e.x, e.y, desired, WASP_SHOT_SPEED, now);
              sim.burstLeft -= 1;
              sim.nextBurstShotAt = now + WASP_BURST_GAP_MS;
              if (sim.burstLeft === 0) sim.nextAttackAt = now + WASP_COOLDOWN_MS;
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
          break;
        }
        case "lancer": {
          switch (sim.lancerPhase) {
            case "cruise":
              e.angle = rotateToward(e.angle, desired, 120 * DEG * dt);
              e.vx = Math.cos(e.angle) * LANCER_CRUISE_SPEED;
              e.vy = Math.sin(e.angle) * LANCER_CRUISE_SPEED;
              if (dist < LANCER_CHARGE_RANGE + 80 && now >= sim.nextAttackAt) {
                sim.lancerPhase = "windup";
                sim.phaseUntil = now + LANCER_WINDUP_MS;
                e.telegraphUntil = sim.phaseUntil;
                e.angle = desired; // the locked charge vector
                e.vx = 0;
                e.vy = 0;
              }
              break;
            case "windup":
              if (now >= sim.phaseUntil) {
                sim.lancerPhase = "charge";
                sim.phaseUntil = now + LANCER_CHARGE_MS;
                e.chargeUntil = sim.phaseUntil;
                e.vx = Math.cos(e.angle) * LANCER_CHARGE_SPEED;
                e.vy = Math.sin(e.angle) * LANCER_CHARGE_SPEED;
              }
              break;
            case "charge":
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
            case "recover": {
              const decay = Math.exp(-3 * dt);
              e.vx *= decay;
              e.vy *= decay;
              if (now >= sim.phaseUntil) {
                sim.lancerPhase = "cruise";
                sim.nextAttackAt = now; // recovery IS the cooldown
              }
              break;
            }
          }
          break;
        }
        case "splitter": {
          e.angle = rotateToward(e.angle, desired, 60 * DEG * dt);
          e.vx = Math.cos(e.angle) * SPLITTER_SPEED;
          e.vy = Math.sin(e.angle) * SPLITTER_SPEED;
          break;
        }
        case "warden": {
          // Slow advance. Shield up except during the post-mortar vent window.
          e.angle = rotateToward(e.angle, desired, WARDEN_TURN_DEG_PER_S * DEG * dt);
          e.vx = Math.cos(e.angle) * WARDEN_SPEED;
          e.vy = Math.sin(e.angle) * WARDEN_SPEED;
          if (sim.fireAt > 0) {
            if (now >= sim.fireAt) {
              sim.fireAt = 0;
              sim.nextBurstShotAt = now + WARDEN_VENT_MS; // vent: shield down
              sim.nextAttackAt = now + WARDEN_COOLDOWN_MS;
              e.shielded = false;
              if (dist < WARDEN_FIRE_RANGE) {
                this.hostSpawnShot(e.x, e.y, desired, WARDEN_SHOT_SPEED, now);
              }
            }
          } else if (now < sim.nextBurstShotAt) {
            e.shielded = false; // venting
          } else if (now >= sim.nextAttackAt && dist < WARDEN_FIRE_RANGE) {
            e.telegraphUntil = now + WARDEN_TELEGRAPH_MS;
            sim.fireAt = e.telegraphUntil;
            e.shielded = true; // shield up through the windup
          } else {
            e.shielded = true;
          }
          break;
        }
        case "sniper": {
          // Kite to keep distance; charge a laser sight; fire one fast bolt.
          e.angle = desired;
          const err = dist - SNIPER_KEEP_DIST;
          if (Math.abs(err) > 40) {
            const sgn = err > 0 ? 1 : -1; // in if too far, out if too close
            e.vx = (dx / dist) * SNIPER_SPEED * sgn;
            e.vy = (dy / dist) * SNIPER_SPEED * sgn;
          } else {
            e.vx = -(dy / dist) * SNIPER_SPEED * sim.orbitDir; // strafe at range
            e.vy = (dx / dist) * SNIPER_SPEED * sim.orbitDir;
          }
          if (sim.fireAt > 0) {
            if (now >= sim.fireAt) {
              sim.fireAt = 0;
              sim.nextAttackAt = now + SNIPER_COOLDOWN_MS;
              const aim = e.lances[0];
              e.lances = [];
              if (aim && dist < SNIPER_FIRE_RANGE) {
                this.hostSpawnShot(
                  e.x,
                  e.y,
                  Math.atan2(aim.y - e.y, aim.x - e.x),
                  SNIPER_SHOT_SPEED,
                  now,
                );
              }
            } else {
              e.vx *= 0.2; // plant while aiming
              e.vy *= 0.2;
            }
          } else if (now >= sim.nextAttackAt && dist < SNIPER_FIRE_RANGE) {
            e.telegraphUntil = now + SNIPER_AIM_MS;
            sim.fireAt = e.telegraphUntil;
            e.lances = [{ x: target.x, y: target.y }]; // lock current pos (no lead)
          }
          break;
        }
        case "spawner": {
          // Drift slowly; birth a brood on a telegraphed pulse, self-capped.
          e.angle = rotateToward(e.angle, desired, 30 * DEG * dt);
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
          break;
        }
        case "dreadnought": {
          this.hostSimBoss(e, sim, players, desired, now, dt);
          break;
        }
      }
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
        if (!live.has(id)) this.enemySim.delete(id);
      }
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
    if (w.enemies.length <= enemyCap(intensity, pressure, wave) + ENEMY_DESPAWN_SLACK) return;
    if (now - this.lastBreatherDespawnAt < ENEMY_DESPAWN_INTERVAL_MS) return;
    let farIdx = -1;
    let farDist = -1;
    for (let i = 0; i < w.enemies.length; i++) {
      const e = w.enemies[i];
      if (!e) continue;
      if (e.kind === "dreadnought") continue; // the boss is never auto-despawned
      let minD = Infinity;
      for (const p of players) minD = Math.min(minD, Math.hypot(e.x - p.x, e.y - p.y));
      if (minD > farDist) {
        farDist = minD;
        farIdx = i;
      }
    }
    if (farIdx === -1 || farDist <= ENEMY_DESPAWN_MIN_DIST) return;
    const e = w.enemies[farIdx];
    if (!e) return;
    w.enemies.splice(farIdx, 1);
    this.enemySim.delete(e.id);
    this.lastBreatherDespawnAt = now;
    this.dirty.enemies = true;
  }

  private hostDamageAsteroid(id: string, damage: number): void {
    const w = this.world;
    const idx = w.asteroids.findIndex((a) => a.id === id);
    if (idx === -1) return;
    const a = w.asteroids[idx];
    if (!a) return;
    if (asteroidDestroyedBy(a.radius, damage)) {
      w.asteroids.splice(idx, 1); // display sweep bursts it
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
    if (!u) return;
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
    e.angle = rotateToward(e.angle, desired, 60 * DEG * dt); // turret faces nearest
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
      // Orbit at BOSS_ORBIT_RADIUS, broadside a spread fan.
      const radial = Phaser.Math.Clamp((dC - BOSS_ORBIT_RADIUS) / 200, -1, 1);
      let mx = -inY * sim.orbitDir + inX * radial;
      let my = inX * sim.orbitDir + inY * radial;
      const ml = Math.hypot(mx, my) || 1;
      e.vx = (mx / ml) * BOSS_SPEED;
      e.vy = (my / ml) * BOSS_SPEED;
      if (sim.fireAt > 0) {
        if (now >= sim.fireAt) {
          sim.fireAt = 0;
          sim.nextAttackAt = now + BOSS_P1_CYCLE_MS;
          const base = desired - (BOSS_P1_SPREAD_DEG * DEG) / 2;
          const step = (BOSS_P1_SPREAD_DEG * DEG) / (BOSS_P1_SPREAD_COUNT - 1);
          for (let i = 0; i < BOSS_P1_SPREAD_COUNT; i++) {
            this.hostSpawnShot(e.x, e.y, base + step * i, BOSS_SHOT_SPEED, now);
          }
        }
      } else if (now >= sim.nextAttackAt) {
        e.telegraphUntil = now + BOSS_P1_TELEGRAPH_MS;
        sim.fireAt = e.telegraphUntil;
      }
    } else if (phase === 2) {
      // Strafe faster; lock + fire triple sniper-speed lances at nearest players.
      e.vx = -inY * BOSS_SPEED * 1.4 * sim.orbitDir;
      e.vy = inX * BOSS_SPEED * 1.4 * sim.orbitDir;
      if (sim.fireAt > 0) {
        if (now >= sim.fireAt) {
          sim.fireAt = 0;
          sim.nextAttackAt = now + BOSS_P2_CYCLE_MS;
          for (const aim of e.lances) {
            this.hostSpawnShot(
              e.x,
              e.y,
              Math.atan2(aim.y - e.y, aim.x - e.x),
              BOSS_LANCE_SHOT_SPEED, // distinct speed → BOSS_LANCE damage (70), not sniper 55
              now,
            );
          }
          e.lances = [];
        }
      } else if (now >= sim.nextAttackAt) {
        // Lock the BOSS_P2_LANCES nearest players (repeated-min select; no sort).
        const cands = players.map((p) => ({ x: p.x, y: p.y, d: dist2(p.x, p.y, e.x, e.y) }));
        const picks: Vec[] = [];
        for (let k = 0; k < BOSS_P2_LANCES && cands.length > 0; k++) {
          let bi = 0;
          for (let i = 1; i < cands.length; i++) {
            if ((cands[i]?.d ?? Infinity) < (cands[bi]?.d ?? Infinity)) bi = i;
          }
          const best = cands[bi];
          if (best) picks.push({ x: best.x, y: best.y });
          cands.splice(bi, 1);
        }
        e.lances = picks;
        e.telegraphUntil = now + BOSS_P2_AIM_MS;
        sim.fireAt = e.telegraphUntil;
      }
    } else {
      // Phase 3 enrage: plant, vent a radial nova + birth a mite wave.
      e.vx *= Math.exp(-3 * dt);
      e.vy *= Math.exp(-3 * dt);
      if (sim.fireAt > 0) {
        if (now >= sim.fireAt) {
          sim.fireAt = 0;
          sim.nextAttackAt = now + BOSS_P3_CYCLE_MS;
          for (let i = 0; i < BOSS_P3_NOVA_COUNT; i++) {
            this.hostSpawnShot(
              e.x,
              e.y,
              (Math.PI * 2 * i) / BOSS_P3_NOVA_COUNT,
              BOSS_SHOT_SPEED,
              now,
            );
          }
          // Cap the brood so a long phase-3 can't balloon enemies[] unbounded.
          if (sim.broodCount < BOSS_BROOD_CAP) this.hostBirthMites(e, BOSS_P3_MITES, now);
        }
      } else if (now >= sim.nextAttackAt) {
        e.telegraphUntil = now + BOSS_P3_TELEGRAPH_MS;
        sim.fireAt = e.telegraphUntil;
      }
    }
  }

  /** SPAWNER / BOSS: birth `n` mites (grace'd drones) around the parent. They
   *  bypass enemyCap like splitter children; broodCount self-caps the spawner. */
  private hostBirthMites(parent: EnemyState, n: number, now: number): void {
    const w = this.world;
    const psim = this.simFor(parent.id);
    for (let i = 0; i < n; i++) {
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
    if (this.bossAlive) return;
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
      if (this.hostForceSpawnBoss(players)) w.sectorBossIdx = sIdx;
      return; // placement failure retries next tick; organic gates don't apply
    }
    if (intensity < BOSS_SPAWN_INTENSITY) return;
    if (this.lastBossKilledAt !== 0 && now - this.lastBossKilledAt < BOSS_SPAWN_COOLDOWN_MS) return;
    if (players.length === 0) return; // never spawn a boss with nobody to fight it
    const busy = Object.keys(this.peers).length >= BOSS_SPAWN_MIN_PLAYERS;
    // Quiet rooms only get one once the cooldown has fully elapsed since the last.
    if (!busy && this.lastBossKilledAt === 0 && now < BOSS_SPAWN_COOLDOWN_MS) return;
    let placed: { x: number; y: number; ang: number } | null = null;
    for (let i = 0; i < 8 && !placed; i++) {
      const c = edgeSpawn(30, this.world.playW, this.world.playH);
      if (players.every((p) => Math.hypot(p.x - c.x, p.y - c.y) >= ENEMY_SPAWN_CLEARANCE))
        placed = c;
    }
    if (!placed) return;
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
    for (let i = 0; i < 8 && !placed; i++) {
      const c = edgeSpawn(30, w.playW, w.playH);
      if (players.every((p) => Math.hypot(p.x - c.x, p.y - c.y) >= ENEMY_SPAWN_CLEARANCE))
        placed = c;
    }
    if (!placed) return false;
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
    if (idx === -1) return;
    const e = w.enemies[idx];
    if (!e) return;
    // WARDEN: heavy damage reduction while shielded; extra during the vent window.
    let dmg = damageHp;
    if (e.kind === "warden") dmg *= e.shielded ? WARDEN_SHIELDED_DR : WARDEN_VENT_DR;
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
      // +1 keeps hp strictly above the bossPhase() f > 0.66/0.33 cut.
      const floorHp = held
        ? phase === 1
          ? 0.66 * e.maxHp + 1
          : phase === 2
            ? 0.33 * e.maxHp + 1
            : 1
        : phase === 1
          ? 0.33 * e.maxHp + 1
          : phase === 2
            ? 1
            : 0;
      if (e.hp < floorHp) e.hp = floorHp;
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
    if (e.hp <= 0) this.hostKillEnemy(idx);
    this.dirty.enemies = true;
  }

  private hostKillEnemy(idx: number): void {
    const w = this.world;
    const e = w.enemies[idx];
    if (!e) return;
    // A dying mite frees a slot in its parent's brood cap.
    const broodParent = this.enemySim.get(e.id)?.broodParent;
    if (broodParent) {
      const psim = this.enemySim.get(broodParent);
      if (psim) psim.broodCount = Math.max(0, psim.broodCount - 1);
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
      for (let i = 0; i < SPLITTER_CHILDREN; i++) {
        const ang = e.angle + (Math.PI * 2 * i) / SPLITTER_CHILDREN;
        const child = spawnEnemyState("drone", e.x + Math.cos(ang) * 10, e.y + Math.sin(ang) * 10);
        child.angle = ang;
        child.vx = Math.cos(ang) * SPLITTER_CHILD_SPEED;
        child.vy = Math.sin(ang) * SPLITTER_CHILD_SPEED;
        child.graceUntil = now + SPLITTER_GRACE_MS;
        const sim = this.simFor(child.id);
        sim.nextAttackAt = child.graceUntil + 400;
        w.enemies.push(child); // children bypass the cap
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
    for (let i = 0; i < count; i++) w.shards.push(spawnShardState(x, y));
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
      if (!feedPity) return;
      for (const c of LOOT_CLASSES) this.lootPity[c] += 1;
    };
    if (!bypassCap && w.items.length >= ITEMS_MAX_LIVE) {
      bumpAll();
      return;
    }
    let cls: LootClass | null = null;
    if (feedPity) {
      // Ripe pity forces the drop regardless of the chance gate.
      if (this.lootPity.shield >= LOOT_PITY.shield) cls = "shield";
      else if (this.lootPity.booster >= LOOT_PITY.booster) cls = "booster";
      else if (this.lootPity.weapon >= LOOT_PITY.weapon) cls = "weapon";
    }
    if (!cls && rand() >= chance) {
      bumpAll();
      return;
    }
    if (!cls) cls = rollLootClass();
    if (feedPity) {
      for (const c of LOOT_CLASSES) {
        if (c === cls) this.lootPity[c] = 0;
        else this.lootPity[c] += 1;
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
        kind: "booster",
        boosterIdx: BOOSTER_KINDS.indexOf(rollWeightedKey(LOOT_BOOSTER_WEIGHTS)),
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
      frequency: 25,
      lifespan: 300,
      speed: { min: 0, max: 20 },
      scale: { start: 0.5, end: 0 },
      alpha: { start: 0.7, end: 0 },
      tint,
      blendMode: Phaser.BlendModes.ADD,
      emitting: false,
    });
    e.setDepth(9);
    return e;
  }

  private syncShips(now: number, dt: number): void {
    // Time-based smoothing (~0.35/frame at 60fps) so remote-ship glide speed
    // is refresh-rate independent.
    const blend = 1 - Math.exp(-25 * dt);
    // Over the soft particle budget: trails throttle ×2 (vfx skill rule).
    const throttled = this.fx.aliveParticles() > PARTICLE_SOFT_BUDGET;
    const seen = new Set<string>();
    const myId = this.myId;
    this.haloGfx.clear();
    for (const [id, player] of Object.entries(this.peers)) {
      seen.add(id);
      let rec = this.ships.get(id);
      if (!rec) {
        const tint = cssToInt(player.color);
        let trail: Phaser.GameObjects.Particles.ParticleEmitter | null = null;
        if (id === myId) {
          trail = this.makeTrailEmitter(tint);
        } else if (this.remoteTrailCount < 8) {
          trail = this.makeTrailEmitter(tint);
          this.remoteTrailCount += 1;
        }
        const lvl0 = id === myId ? this.level : 1;
        rec = {
          gfx: this.makeShipGfx(tint, lvl0),
          tint,
          level: lvl0,
          alive: true,
          seenState: false,
          trail,
          nitroTrail: false,
          lastShieldHp: SHIELD_MAX,
          flashUntil: 0,
          regenUntil: 0,
        };
        this.ships.set(id, rec);
      }
      if (id === myId) {
        this.ensureShipLevel(rec, this.level);
        this.configureTrail(rec, this.boosts.has("nitro"), throttled);
        rec.gfx.setPosition(this.shipX, this.shipY).setRotation(this.shipAngle);
        rec.gfx.setVisible(this.spawned && this.alive);
        const phased = now < this.phasedUntil;
        rec.gfx.setAlpha(phased ? 0.25 : now < this.invulnUntil ? blinkAlpha(now) : 1);
        rec.alive = this.alive;
        if (rec.trail) {
          rec.trail.emitting = this.alive && this.spawned && this.thrust > 0.3;
          rec.trail.setPosition(
            this.shipX - Math.cos(this.shipAngle) * 10,
            this.shipY - Math.sin(this.shipAngle) * 10,
          );
        }
        if (this.alive && this.spawned) {
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
          if (this.boosts.has("twin")) {
            this.drawTwinDrone(this.shipX, this.shipY, this.twinAngle());
          }
          this.drawWindupGlow(
            this.shipX,
            this.shipY,
            this.shipAngle,
            this.windupFrac(),
            this.weapon.tint,
          );
          if (this.teslaActive(now)) this.drawTeslaAura(this.shipX, this.shipY, now);
        }
        if (this.sentry && now < this.sentry.until) {
          this.drawSentry(this.sentry.x, this.sentry.y, this.sentry.until, now);
        }
        continue;
      }
      const st = this.peerStates.get(id) ?? null;
      if (!st) {
        rec.gfx.setVisible(false);
        if (rec.trail) rec.trail.emitting = false;
        continue;
      }
      if (!st.present) {
        // Cleanly docked out (paused-as-spectator): hide with NO death FX, and
        // clear rec.alive so re-entry snaps in fresh rather than gliding from a
        // stale spot or firing a spurious death burst.
        rec.gfx.setVisible(false);
        if (rec.trail) rec.trail.emitting = false;
        rec.alive = false;
        continue;
      }
      this.ensureShipLevel(rec, st.level); // remotes grow with their level too
      if (!rec.seenState) {
        // First snapshot: snap into place (no glide from the origin) and adopt
        // alive as-is (no death FX for players who were already dead).
        rec.seenState = true;
        rec.alive = st.alive;
        rec.gfx.setPosition(st.x, st.y);
        rec.lastShieldHp = st.shieldHp;
      }
      if (rec.alive && !st.alive) {
        this.splinterBurst(rec.gfx.x, rec.gfx.y, 50, 30, now);
        this.fx.shatter(rec.gfx.x, rec.gfx.y, shipHullPoints(), st.angle, rec.tint);
        this.fx.ring(rec.gfx.x, rec.gfx.y, 10, 90, 400, 0xffffff, 0.7);
        if (this.onScreen(rec.gfx.x, rec.gfx.y)) this.trauma.add(0.2);
      }
      if (!rec.alive && st.alive) rec.gfx.setPosition(st.x, st.y); // respawn: snap, don't glide
      rec.alive = st.alive;
      rec.gfx.setVisible(st.alive);
      if (st.alive) {
        rec.gfx.setPosition(
          Phaser.Math.Linear(rec.gfx.x, st.x, blend),
          Phaser.Math.Linear(rec.gfx.y, st.y, blend),
        );
        rec.gfx.setRotation(st.angle);
        rec.gfx.setAlpha(
          st.shieldMod?.phased ? 0.25 : st.invuln ? blinkAlpha(now) : 1, // networked invuln/phase
        );
        // Drains are visible as shieldHp drops between snapshots: flash + sparks.
        if (st.shieldHp < rec.lastShieldHp) {
          rec.flashUntil = now + 80;
          this.fx.sparks(rec.gfx.x, rec.gfx.y, 6, SHIELD_RING_TINT, { lifeMin: 150, lifeMax: 250 });
        } else if (st.shieldHp > rec.lastShieldHp) {
          rec.regenUntil = now + 250; // infer regen from increases
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
        if (st.tesla) this.drawTeslaAura(rec.gfx.x, rec.gfx.y, now);
        if (st.sentry && now < st.sentry.until) {
          this.drawSentry(st.sentry.x, st.sentry.y, st.sentry.until, now);
        }
      }
      const nitro = st.alive && st.boosts.some((b) => b.kind === "nitro" && b.until > now);
      this.configureTrail(rec, nitro, throttled);
      if (rec.trail) {
        // Remote thrust isn't on the wire — speed from vx,vy is the proxy.
        rec.trail.emitting = st.alive && Math.hypot(st.vx, st.vy) > 100;
        rec.trail.setPosition(
          rec.gfx.x - Math.cos(st.angle) * 10,
          rec.gfx.y - Math.sin(st.angle) * 10,
        );
      }
    }
    for (const [id, rec] of this.ships) {
      if (!seen.has(id)) {
        rec.gfx.destroy();
        if (rec.trail) {
          rec.trail.destroy();
          if (id !== myId) this.remoteTrailCount = Math.max(0, this.remoteTrailCount - 1);
        }
        this.ships.delete(id);
      }
    }
  }

  /** Trail = thruster puffs, or the NITRO flame (others must see it). */
  private configureTrail(rec: ShipObjs, nitro: boolean, throttled: boolean): void {
    if (!rec.trail) return;
    if (rec.nitroTrail !== nitro) {
      rec.nitroTrail = nitro;
      rec.trail.updateConfig({
        lifespan: nitro ? 450 : 300,
        tint: nitro ? BOOSTER_SPECS.nitro.tint : rec.tint,
      });
    }
    const freq = nitro ? (throttled ? 24 : 12) : throttled ? 50 : 25;
    if (rec.trail.frequency !== freq) rec.trail.setFrequency(freq);
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
      // Completeness = shield fraction; the gap in the arc IS the health bar.
      let alpha = 0.15 + 0.45 * frac + (opts.regen ? 0.15 : 0);
      if (frac < SHIELD_LOW_FRACTION) {
        // Low shield: pulse 0.2↔0.7 at 6Hz.
        alpha = 0.45 + 0.25 * Math.sin((now / 1000) * Math.PI * 2 * 6);
      }
      // SIPHON overheal banked above 100: the closed ring glows brighter.
      if (shieldHp > SHIELD_MAX) alpha += 0.1;
      if (opts.flash) alpha = 1;
      g.lineStyle(1, SHIELD_RING_TINT, Math.min(1, alpha));
      const sweep = Math.PI * 2 * frac;
      g.beginPath();
      g.arc(x, y, SHIELD_RING_RADIUS, angle - sweep / 2, angle + sweep / 2);
      g.strokePath();
      if (opts.regen && frac < 1) {
        // Bright head dots ride the arc tips as the ring re-closes.
        g.fillStyle(0xffffff, 0.95);
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
    // OVERSHIELD bonus layer: Halo hexagon, fading with the remaining bonus.
    if (overHp > 0) {
      g.lineStyle(
        1,
        SHIELD_MOD_SPECS.overshield.tint,
        0.8 * Math.min(1, overHp / OVERSHIELD_BONUS),
      );
      strokeRegularPolygon(g, x, y, SHIELD_HALO_RADIUS, 6, 0);
    }
    if (!mod) return;
    const tint = SHIELD_MOD_SPECS[mod.kind].tint;
    switch (mod.kind) {
      case "overshield":
        return; // the hexagon above IS the halo
      case "reflect": {
        g.lineStyle(1, tint, mod.active ? 0.85 : 0.25); // dim = arm down (≤40)
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
        g.lineStyle(1, tint, mod.active ? 0.9 : 0.35); // bright when armed
        g.beginPath();
        g.arc(x, y, SHIELD_HALO_RADIUS, angle - Math.PI / 4, angle + Math.PI / 4);
        g.strokePath();
        return;
      }
      case "phase": {
        const alpha = mod.phased ? 0.25 : mod.active ? 0.7 : 0.2;
        g.lineStyle(1, tint, alpha);
        const rot = (now / 1000) * 45 * DEG;
        for (let i = 0; i < 8; i++) {
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
        for (let i = 0; i < 4; i++) {
          const a0 = spin + (Math.PI * 2 * i) / 4;
          g.fillCircle(
            x + Math.cos(a0) * SHIELD_HALO_RADIUS,
            y + Math.sin(a0) * SHIELD_HALO_RADIUS,
            1,
          );
        }
        return;
      }
    }
  }

  /** 60° white impact arcs at the incoming-damage angle, alpha 1→0 / 150ms. */
  private drawImpactArcs(now: number): void {
    this.impactArcs = this.impactArcs.filter((ia) => now < ia.diesAt);
    const g = this.haloGfx;
    for (const ia of this.impactArcs) {
      const alpha = Math.max(0, (ia.diesAt - now) / 150);
      g.lineStyle(2, 0xffffff, alpha);
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

  /** RAILGUN charge: nose glow scales 0→6px with the windup fraction. */
  private drawWindupGlow(x: number, y: number, angle: number, frac: number, tint: number): void {
    if (frac <= 0.02) return;
    const g = this.haloGfx;
    g.fillStyle(tint, 0.35 + 0.45 * frac);
    g.fillCircle(
      x + Math.cos(angle) * (SHIP_RADIUS + 2),
      y + Math.sin(angle) * (SHIP_RADIUS + 2),
      6 * frac,
    );
  }

  /** TESLA AURA: crackling broken ring (per-frame random arc phases = the
   *  electric flicker), driven locally for the owner and by the serialized
   *  flag for remotes. */
  private drawTeslaAura(x: number, y: number, now: number): void {
    const g = this.haloGfx;
    g.lineStyle(1, TESLA_TINT, 0.7);
    const base = (now / 1000) * 240 * DEG;
    for (let i = 0; i < 5; i++) {
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
    if (left <= 0) return;
    const g = this.haloGfx;
    const alpha = 0.9 * Math.min(1, left / 2000);
    g.lineStyle(1, SENTRY_WEAPON.tint, alpha);
    g.lineBetween(x - 4, y + 8, x + 4, y + 8); // base
    g.lineBetween(x, y + 8, x, y + 2); // post
    strokeRegularPolygon(g, x, y - 2, 4.5, 3, (now / 1000) * 60 * DEG);
  }

  private syncAsteroids(now: number): void {
    const seen = new Set<string>();
    for (const a of this.world.asteroids) {
      seen.add(a.id);
      let rec = this.asteroidObjs.get(a.id);
      if (!rec) {
        rec = { gfx: this.add.graphics().setDepth(5), drawnRadius: 0 };
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
          this.tweens.add({ targets: rec.gfx, scale: 1, duration: 120, ease: "Quad.Out" });
          this.fx.debris(a.x, a.y, 4, 0xffffff, {
            lifeMin: 300,
            lifeMax: 500,
            speedMin: 60,
            speedMax: 160,
          });
          this.fx.sparks(a.x, a.y, 4, 0xffffff, { lifeMin: 150, lifeMax: 250 });
        }
        rec.drawnRadius = a.radius;
      }
      rec.gfx.setPosition(a.x, a.y).setRotation(a.rot);
    }
    for (const [id, rec] of this.asteroidObjs) {
      if (seen.has(id)) continue;
      // Destroyed (visible burst) or culled off-world (burst hidden by mask).
      this.splinterBurst(rec.gfx.x, rec.gfx.y, rec.drawnRadius, 20, now);
      this.fx.sparks(rec.gfx.x, rec.gfx.y, 6, 0xffffff, { lifeMin: 150, lifeMax: 250 });
      if (dist2(rec.gfx.x, rec.gfx.y, this.shipX, this.shipY) < 400 * 400) this.trauma.add(0.05);
      this.tweens.killTweensOf(rec.gfx);
      rec.gfx.destroy();
      this.asteroidObjs.delete(id);
    }
  }

  private syncUfo(now: number): void {
    const u = this.world.ufo;
    if (!u) {
      if (this.ufoGfx) {
        this.splinterBurst(this.ufoGfx.x, this.ufoGfx.y, 25, 20, now);
        this.fx.sparks(this.ufoGfx.x, this.ufoGfx.y, 8, 0xffffff, { lifeMin: 200, lifeMax: 350 });
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
          targets: rec.gfx,
          scale: { from: 0.92, to: 1.1 },
          duration: 600,
          ease: "Sine.InOut",
          yoyo: true,
          repeat: -1,
        });
      }
      rec.gfx.setPosition(it.x, it.y);
    }
    for (const [id, rec] of this.itemObjs) {
      if (seen.has(id)) continue;
      this.fx.sparks(rec.gfx.x, rec.gfx.y, 10, rec.tint, {
        speedMin: 30,
        speedMax: 140,
        lifeMin: 200,
        lifeMax: 420,
      });
      this.tweens.killTweensOf(rec.gfx);
      rec.gfx.destroy();
      this.itemObjs.delete(id);
    }
  }

  private syncEnemies(now: number): void {
    const seen = new Set<string>();
    for (const e of this.world.enemies) {
      seen.add(e.id);
      let rec = this.enemyObjs.get(e.id);
      if (!rec) {
        rec = {
          gfx: this.makeEnemyGfx(e.kind),
          kind: e.kind,
          lastTelegraphUntil: 0,
          chargeTraumaDone: false,
        };
        this.enemyObjs.set(e.id, rec);
      }
      rec.gfx.setPosition(e.x, e.y).setRotation(e.angle);
      // Damage flicker (UFO style) + grace flash-in for splitter children.
      // NOT the boss or the long-TTK elites (warden, hive): under sustained
      // point-blank fire blinkUntil is pinned refreshed, and a hide-strobe
      // would blank the hull for a quarter of the whole melt — those flash
      // WHITE instead (drawEnemyTelegraphs). Lancer/splitter fights are
      // sub-3s, so the cheap hide-blink stays readable there.
      const flashesWhite = e.kind === "dreadnought" || e.kind === "warden" || e.kind === "spawner";
      const hidden = !flashesWhite && now < e.blinkUntil && Math.floor(now / 66) % 4 === 0;
      rec.gfx.setVisible(!hidden);
      rec.gfx.setAlpha(e.graceUntil > now ? 0.25 + 0.45 * (Math.sin(now / 40) * 0.5 + 0.5) : 1);
      // Telegraph audio: LANCER windup + WASP burst, on-screen only (§6.1).
      if (e.telegraphUntil > now && rec.lastTelegraphUntil !== e.telegraphUntil) {
        rec.lastTelegraphUntil = e.telegraphUntil;
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
      if (e.kind === "lancer") {
        if (e.chargeUntil > now) {
          // Charge trail (ADD, hull tint) + close-pass trauma, once per charge.
          this.fx.sparks(e.x, e.y, 1, ENEMY_SPECS.lancer.tint, {
            speedMin: 0,
            speedMax: 20,
            lifeMin: 250,
            lifeMax: 250,
            scale: 0.5,
          });
          if (
            !rec.chargeTraumaDone &&
            this.alive &&
            dist2(e.x, e.y, this.shipX, this.shipY) < 100 * 100
          ) {
            rec.chargeTraumaDone = true;
            this.trauma.add(0.15);
          }
        } else {
          rec.chargeTraumaDone = false;
        }
      }
    }
    // Removal = death (enemies are never culled): stroke-shatter + sparks.
    for (const [id, rec] of this.enemyObjs) {
      if (seen.has(id)) continue;
      const spec = ENEMY_SPECS[rec.kind];
      const x = rec.gfx.x;
      const y = rec.gfx.y;
      this.fx.shatter(x, y, enemyHullPoints(rec.kind), rec.gfx.rotation, spec.tint);
      this.fx.sparks(x, y, 8, spec.tint, { lifeMin: 200, lifeMax: 350 });
      const big = spec.hp >= 80;
      const boss = rec.kind === "dreadnought";
      if (rec.kind === "lancer" || rec.kind === "splitter" || boss) {
        this.fx.ring(x, y, boss ? 16 : 6, boss ? 240 : 60, boss ? 700 : 350, spec.tint, 0.85);
      }
      if (boss) {
        // Big multi-ring death blast for the marquee kill.
        this.fx.ring(x, y, 10, 140, 500, 0xffffff, 0.9);
        this.fx.sparks(x, y, 40, spec.tint, {
          speedMin: 120,
          speedMax: 360,
          lifeMin: 300,
          lifeMax: 600,
        });
      }
      if (this.onScreen(x, y)) {
        sfx.play(
          "enemy_death",
          boss ? { gain: 1.5, rate: 0.6 } : big ? { gain: 1.3, rate: 0.8 } : {},
        );
        this.trauma.add(boss ? 0.5 : big ? 0.18 : 0.1);
      }
      rec.gfx.destroy();
      this.enemyObjs.delete(id);
    }
  }

  /** Per-frame telegraph overlays (additive layer, redrawn every frame). */
  private drawEnemyTelegraphs(now: number): void {
    const g = this.telegraphGfx;
    const sw = this.strokeScale(); // qa-011: warnings must survive phone zoom
    g.clear();
    for (const e of this.world.enemies) {
      // WARDEN shield arc is always visible (not just during a telegraph): solid
      // when up, strobing when venting — so players read the punish window.
      if (e.kind === "warden") {
        const venting = !e.shielded;
        if (!venting || Math.floor(now / 60) % 2 === 0) {
          g.lineStyle(2 * sw, venting ? 0xffffff : ENEMY_SPECS.warden.tint, venting ? 0.5 : 0.9);
          g.strokeCircle(e.x, e.y, ENEMY_SPECS.warden.hitRadius + 6);
        }
      }
      // Boss + long-TTK elite (warden, hive) damage feedback: white hull
      // overlay on the blink duty cycle — flash white, never blank (the hull
      // must stay readable while melting; qa-018 blink rider).
      if (
        (e.kind === "dreadnought" || e.kind === "warden" || e.kind === "spawner") &&
        e.blinkUntil > now &&
        Math.floor(now / 66) % 4 === 0
      ) {
        g.lineStyle(2 * sw, 0xffffff, 0.9);
        strokeTransformed(g, enemyHullPoints(e.kind), e.x, e.y, e.angle);
      }
      if (e.telegraphUntil <= now) continue;
      if (e.kind === "drone") {
        // Nose dot grows 1→4px across the windup.
        const p = 1 - (e.telegraphUntil - now) / DRONE_TELEGRAPH_MS;
        g.fillStyle(ENEMY_SPECS.drone.tint, 0.9);
        g.fillCircle(e.x + Math.cos(e.angle) * 8, e.y + Math.sin(e.angle) * 8, 1 + 3 * p);
      } else if (e.kind === "wasp") {
        // Wings flash white at 12Hz.
        if (Math.floor(now / 42) % 2 === 0) {
          g.lineStyle(sw, 0xffffff, 0.9);
          strokeTransformed(g, enemyHullPoints("wasp"), e.x, e.y, e.angle);
        }
      } else if (e.kind === "lancer") {
        // Hull strobes at 8Hz + dashed line along the LOCKED charge vector.
        if (Math.floor(now / 62) % 2 === 0) {
          g.lineStyle(sw, 0xffffff, 0.95);
          strokeTransformed(g, enemyHullPoints("lancer"), e.x, e.y, e.angle);
        }
        g.lineStyle(sw, ENEMY_SPECS.lancer.tint, 0.7);
        dashedLine(g, e.x, e.y, e.angle, LANCER_CHARGE_RANGE, 8, 6);
      } else if (e.kind === "sniper") {
        // Strobing laser sight to each locked point.
        if (Math.floor(now / 50) % 2 === 0) {
          for (const aim of e.lances) {
            g.lineStyle(sw, ENEMY_SPECS.sniper.tint, 0.9);
            g.lineBetween(e.x, e.y, aim.x, aim.y);
            g.fillStyle(ENEMY_SPECS.sniper.tint, 0.9).fillCircle(aim.x, aim.y, 4);
          }
        }
      } else if (e.kind === "spawner") {
        // Expanding pulse ring as the brood charges.
        const p = 1 - (e.telegraphUntil - now) / SPAWNER_TELEGRAPH_MS;
        g.lineStyle(sw, ENEMY_SPECS.spawner.tint, 0.8);
        g.strokeCircle(e.x, e.y, ENEMY_SPECS.spawner.hitRadius + 4 + 14 * p);
      } else if (e.kind === "dreadnought") {
        if (e.lances.length > 0) {
          // Phase-2 triple lances.
          if (Math.floor(now / 45) % 2 === 0) {
            for (const aim of e.lances) {
              g.lineStyle(2 * sw, 0xffffff, 0.85);
              g.lineBetween(e.x, e.y, aim.x, aim.y);
              g.fillStyle(ENEMY_SPECS.dreadnought.tint, 0.9).fillCircle(aim.x, aim.y, 6);
            }
          }
        } else {
          // Phase-1/3 muzzle bloom during the windup.
          const p = Math.min(1, (e.telegraphUntil - now) / 600);
          g.fillStyle(ENEMY_SPECS.dreadnought.tint, 0.5);
          g.fillCircle(
            e.x + Math.cos(e.angle) * 40,
            e.y + Math.sin(e.angle) * 40,
            4 + 10 * (1 - p),
          );
        }
      }
    }
  }

  /** SINGULARITY vortices, from the shared pulls entries (every client
   *  agrees). Appends to telegraphGfx, which drawEnemyTelegraphs cleared
   *  this frame. The inward particle ring reuses the pooled converge FX. */
  private drawPulls(now: number): void {
    const g = this.telegraphGfx;
    for (const p of this.world.pulls) {
      if (p.until <= now) continue;
      const frac = Math.max(0, Math.min(1, (p.until - now) / SINGULARITY_PULL_MS)); // 1 -> 0
      // Event horizon shrinks as the collapse completes.
      g.lineStyle(1, SINGULARITY_TINT, 0.3);
      g.strokeCircle(p.x, p.y, 30 + (SINGULARITY_PULL_RANGE - 30) * frac);
      // Three inward-spiraling arc shards.
      const spin = (now / 1000) * 540 * DEG;
      g.lineStyle(1, SINGULARITY_TINT, 0.85);
      for (let i = 0; i < 3; i++) {
        const a0 = spin + (Math.PI * 2 * i) / 3;
        g.beginPath();
        g.arc(p.x, p.y, 12 + 70 * frac, a0, a0 + Math.PI / 3);
        g.strokePath();
      }
      if (Math.random() < 0.3) this.fx.converge(p.x, p.y, 2, 150, 200, SINGULARITY_TINT);
    }
  }

  /** Neon hex ring (the beacon's whole silhouette — a huge static hexagon
   *  reads nothing like a ship). dashFrac < 1 draws each edge as dashes. */
  private strokeHexRing(
    g: Phaser.GameObjects.Graphics,
    x: number,
    y: number,
    r: number,
    rot: number,
    dashFrac: number,
  ): void {
    let px = x + Math.cos(rot) * r;
    let py = y + Math.sin(rot) * r;
    for (let i = 1; i <= 6; i++) {
      const a = rot + (i * Math.PI) / 3;
      const nx = x + Math.cos(a) * r;
      const ny = y + Math.sin(a) * r;
      if (dashFrac >= 1) {
        g.lineBetween(px, py, nx, ny);
      } else {
        const dashes = 4;
        for (let d = 0; d < dashes; d++) {
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
  }

  /** BEACON zone (dir-004). CHARGE: dashed hex shrinking 1.5×→1× radius,
   *  dashes rotating. ACTIVE: solid slow-spinning hex + a depleting countdown
   *  arc; CONTESTED strobes gold↔white at 4Hz; controlled drifts gold motes
   *  toward the controller. Gold stays off enemy and player kit. */
  private drawBeacon(now: number): void {
    const g = this.beaconGfx;
    g.clear();
    const b = this.world.beacon;
    if (!b || now >= b.diesAt) return;
    if (now < b.activeAt) {
      const p = Phaser.Math.Clamp(1 - (b.activeAt - now) / (BEACON_CHARGE_S * 1000), 0, 1);
      const r = BEACON_RADIUS * (1.5 - 0.5 * p);
      g.lineStyle(2, BEACON_TINT, 0.3 + 0.5 * p);
      this.strokeHexRing(g, b.x, b.y, r, (now / 1000) * 0.6, 0.55);
      g.fillStyle(0xffffff, 0.4 + 0.5 * p);
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
    const tint = strobeWhite ? 0xffffff : BEACON_TINT;
    g.lineStyle(3, tint, b.contested ? 0.95 : 0.75);
    this.strokeHexRing(g, b.x, b.y, BEACON_RADIUS, (now / 1000) * 0.12, 1);
    // Countdown arc depletes across ACTIVE — the "hold it to the end" read.
    const frac = Phaser.Math.Clamp((b.diesAt - now) / Math.max(1, b.diesAt - b.activeAt), 0, 1);
    g.lineStyle(1, tint, 0.5);
    g.beginPath();
    g.arc(b.x, b.y, BEACON_RADIUS - 26, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * frac);
    g.strokePath();
    g.fillStyle(0xffffff, 0.85);
    g.fillCircle(b.x, b.y, 5);
    if (b.controllerId && !b.contested && Math.random() < 0.3) {
      const c = this.playerPos(b.controllerId);
      if (c) this.fx.converge(c.x, c.y, 1, BEACON_RADIUS, 500, BEACON_TINT);
    }
  }

  /** The ONE viewport-edge pip pass (dir-004 mandate, shared component):
   *  beacon gold diamond, UFO blinking circle (qa-010), and — while the arena
   *  is young and the screen shows no hostiles — red triangles at the nearest
   *  inbound enemies (qa-007: an empty screen still telegraphs the action). */
  private drawEdgePips(now: number): void {
    const targets: PipTarget[] = [];
    const b = this.world.beacon;
    if (b && now < b.diesAt) targets.push({ x: b.x, y: b.y, tint: BEACON_TINT, shape: "diamond" });
    const u = this.world.ufo;
    if (u) targets.push({ x: u.x, y: u.y, tint: 0xffffff, shape: "circle", blink: true });
    const tSec = Math.max(0, (now - this.world.arenaEpoch) / 1000);
    if (tSec < EARLY_SPAWN_WINDOW_S && this.world.enemies.length > 0) {
      const view = this.cameras.main.worldView;
      const anyVisible = this.world.enemies.some(
        (e) => e.x >= view.x && e.x <= view.right && e.y >= view.y && e.y <= view.bottom,
      );
      if (!anyVisible) {
        const byDist = [...this.world.enemies].sort(
          (a, z) =>
            Math.hypot(a.x - this.shipX, a.y - this.shipY) -
            Math.hypot(z.x - this.shipX, z.y - this.shipY),
        );
        for (const e of byDist.slice(0, DEBUT_PIP_MAX)) {
          targets.push({ x: e.x, y: e.y, tint: ENEMY_SHOT_TINT, shape: "triangle" });
        }
      }
    }
    this.edgePips.draw(this.cameras.main, targets, now);
  }

  /** Enemy projectiles: red is reserved — nothing friendly is ever red. */
  private drawEnemyShots(): void {
    const g = this.enemyShotGfx;
    g.clear();
    if (this.world.enemyShots.length === 0) return;
    g.lineStyle(ENEMY_SHOT_WIDTH, ENEMY_SHOT_TINT, 1);
    for (const s of this.world.enemyShots) {
      const len = Math.hypot(s.vx, s.vy) || 1;
      const ux = s.vx / len;
      const uy = s.vy / len;
      g.lineBetween(s.x - ux * ENEMY_SHOT_LEN, s.y - uy * ENEMY_SHOT_LEN, s.x, s.y);
    }
  }

  /** All beams — mine simulated, everyone else's raw from their snapshots. */
  private drawBeams(now: number): void {
    const g = this.beamGfx;
    g.clear();
    const myId = this.myId;
    const draw = (sb: SerializedBeam): void => {
      if (sb.mine && !sb.exploding) {
        // Remote mine: open diamond at the armed 1Hz blink (arm state isn't
        // on the wire; owners render the 4Hz arming blink locally).
        if (Math.floor(now / 500) % 2 === 0) {
          g.lineStyle(1, sb.tint, 1);
          strokeDiamond(g, sb.hx, sb.hy, 6);
        }
        return;
      }
      if (sb.chain && sb.chain.length >= 2) {
        drawJitteredChain(g, sb.chain, sb.tint);
        return;
      }
      if (sb.glaive) {
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
        g.fillStyle(sb.tint, 0.55).fillCircle(sb.hx, sb.hy, r * 0.6);
        g.lineStyle(1, sb.tint, 0.95).strokeCircle(sb.hx, sb.hy, r + 2);
        return;
      }
      if (sb.exploding) {
        g.lineStyle(1, sb.tint, 1).strokeCircle(sb.hx, sb.hy, sb.explosionRadius);
      } else {
        g.lineStyle(sb.width, sb.tint, 1).lineBetween(sb.tx, sb.ty, sb.hx, sb.hy);
      }
    };
    for (const b of this.beams) {
      if (b.vanished) continue;
      if (b.mine && !b.exploding) {
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
        // Spinning open triangle (remotes draw it via the serialized flag).
        g.lineStyle(2, b.weapon.tint, 1);
        strokeTransformed(g, GLAIVE_TRI, b.head.x, b.head.y, b.spin);
        continue;
      }
      draw(serializeBeam(b));
    }
    for (const [id, st] of this.peerStates) {
      if (id === myId) continue;
      if (!st || !st.alive) continue;
      for (const sb of st.beams) draw(sb);
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
    for (let i = 0; i < count; i++) {
      this.splinters.push({
        originX: x,
        originY: y,
        angle: Math.random() * Math.PI * 2,
        dist: Math.random() * radius,
        speed: Math.random() * 60, // legacy 0..1 px/tick
        diesAt: now + SPLINTER_LIFE_MS,
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
    g.fillStyle(0xffffff, 1);
    for (const s of this.splinters) g.fillRect(s.x, s.y, SPLINTER_PX, SPLINTER_PX);
  }

  /**
   * Hard-centered on the ship plus directional recoil kick plus trauma shake
   * (offset AND a touch of roll — trauma², layered sin noise). Unzoomed, so
   * no bounds clamping.
   */
  private updateCamera(dt: number, timeMs: number): void {
    if (!this.spawned) return;
    const decay = Math.exp(-8 * dt);
    this.kickX *= decay;
    this.kickY *= decay;
    const s = this.trauma.update(dt, timeMs / 1000);
    this.cameras.main.centerOn(this.shipX + this.kickX + s.ox, this.shipY + this.kickY + s.oy);
    this.cameras.main.setAngle(s.rot);
    this.camRollDeg = s.rot; // syncScreenUi counters this roll on the HUD layer
  }

  /**
   * Screen-fixed objects (scrollFactor 0) still inherit the main camera's zoom
   * and trauma roll — Phaser transforms them about the viewport centre. Counter
   * both every frame so their local coordinates read as plain CSS pixels
   * anchored at the screen's top-left (minimap corner-pinned, flash
   * full-screen, joystick under the finger).
   */
  private syncScreenUi(): void {
    const zoom = this.cameras.main.zoom;
    const rot = Phaser.Math.DegToRad(this.camRollDeg);
    const cx = this.scale.width / 2;
    const cy = this.scale.height / 2;
    const cos = Math.cos(rot);
    const sin = Math.sin(rot);
    // Anchor = centre + R(−rot)·(0 − centre)/zoom → local (0,0) lands on
    // screen (0,0). Uniform zoom commutes with the rotation, so one matrix
    // order covers Phaser's camera transform.
    const x = cx - (cx * cos + cy * sin) / zoom;
    const y = cy + (cx * sin - cy * cos) / zoom;
    for (const obj of [this.minimapGfx, this.flashRect, this.padGfx, this.barrier.vignette]) {
      obj
        .setPosition(x, y)
        .setRotation(-rot)
        .setScale(1 / zoom);
    }
  }

  /** Draw the floating joystick into padGfx in screen-space CSS px (mapped 1:1
   *  by syncScreenUi). Replaces the adapter's renderer (`render: false`), which
   *  can't counter the camera zoom. The fire button is a "rest" button with no
   *  on-screen position, so the stick is all there is to draw. */
  private drawPadOverlay(): void {
    const g = this.padGfx;
    g.clear();
    const geom = this.gamepad.pad.getStickGeometry();
    const stick = this.gamepad.getStick();
    if (!geom || !stick.active) return;
    const tint = this.myTint();
    const ax = stick.anchorX;
    const ay = stick.anchorY;
    // Puck clamps to the ring edge so it never escapes the base.
    const clamped = Math.min(stick.distance, geom.radius);
    const kx = stick.distance > 0.001 ? ax + (stick.dx / stick.distance) * clamped : ax;
    const ky = stick.distance > 0.001 ? ay + (stick.dy / stick.distance) * clamped : ay;
    g.fillStyle(0xffffff, 0.05).fillCircle(ax, ay, geom.radius);
    g.lineStyle(2, 0xffffff, 0.2).strokeCircle(ax, ay, geom.radius);
    g.fillStyle(0xffffff, 0.12).fillCircle(ax, ay, geom.deadZone);
    g.fillStyle(tint, 0.22).fillCircle(kx, ky, geom.knobRadius);
    g.lineStyle(2, tint, 0.85).strokeCircle(kx, ky, geom.knobRadius);
  }

  // ---- display-object factories ---------------------------------------------------------

  /** Hull grows + gains detail per level (1..3): L2 adds swept wings + a
   *  cockpit; L3 adds an inner frame, a nose spike + wingtip nodes. */
  /** Entity stroke width multiplier (qa-011). Zoom is static per viewport, so
   *  hulls built before a resize keep the old weight — the drift is <0.2px
   *  and enemies are short-lived; not worth a rebuild pass. */
  private strokeScale(): number {
    return Phaser.Math.Clamp(STROKE_BASE / this.cameras.main.zoom, STROKE_BASE, STROKE_MAX);
  }

  private makeShipGfx(tint: number, level = 1): Phaser.GameObjects.Graphics {
    const g = this.add.graphics().setDepth(10);
    const L = Math.max(1, Math.min(LEVEL_CAP, Math.round(level)));
    const s = shipScaleForLevel(L);
    const sw = this.strokeScale();
    g.lineStyle(sw, tint, 1);
    strokeClosed(g, shipHullPoints(L));
    if (L >= 2) {
      g.lineBetween(-2 * s, -3 * s, -9 * s, -7 * s); // swept wings
      g.lineBetween(-2 * s, 3 * s, -9 * s, 7 * s);
      g.fillStyle(tint, 0.9).fillCircle(2 * s, 0, 1.4 * s); // cockpit
    }
    if (L >= 3) {
      g.lineStyle(sw, tint, 0.4); // inner frame
      strokeClosed(
        g,
        shipHullPoints(L).map((p) => ({ x: p.x * 0.55, y: p.y * 0.55 })),
      );
      g.lineStyle(sw, tint, 1);
      g.lineBetween(SHIP_RADIUS * s, 0, (SHIP_RADIUS + 4) * s, 0); // nose spike
      g.fillStyle(0xffffff, 0.9);
      g.fillCircle(-9 * s, -7 * s, 1.2 * s); // wingtip nodes
      g.fillCircle(-9 * s, 7 * s, 1.2 * s);
    }
    return g;
  }

  /** Rebuild a ship's hull when its level changes (preserve transform/visibility). */
  private ensureShipLevel(rec: ShipObjs, level: number): void {
    if (rec.level === level) return;
    rec.level = level;
    const { x, y, rotation, alpha, visible } = rec.gfx;
    rec.gfx.destroy();
    rec.gfx = this.makeShipGfx(rec.tint, level);
    rec.gfx.setPosition(x, y).setRotation(rotation).setAlpha(alpha).setVisible(visible);
  }

  private makeUfoGfx(): Phaser.GameObjects.Graphics {
    const g = this.add.graphics().setDepth(6);
    g.lineStyle(this.strokeScale(), 0xffffff, 1);
    strokeClosed(g, UFO_OUTLINE);
    const [, , p2, p3, , , p6, p7] = UFO_OUTLINE;
    if (p2 && p3 && p6 && p7) {
      g.lineBetween(p2.x, p2.y, p7.x, p7.y);
      g.lineBetween(p3.x, p3.y, p6.x, p6.y);
    }
    return g;
  }

  private makeEnemyGfx(kind: EnemyKind): Phaser.GameObjects.Graphics {
    const g = this.add.graphics().setDepth(kind === "dreadnought" ? 8 : 7);
    const sw = this.strokeScale();
    g.lineStyle(
      (kind === "dreadnought" ? 3 : kind === "warden" ? 2 : 1) * sw,
      ENEMY_SPECS[kind].tint,
      1,
    );
    const pts = enemyHullPoints(kind);
    strokeClosed(g, pts);
    if (kind === "dreadnought") {
      // Bridge dot + cross-struts so the capital ship reads as a boss.
      g.fillStyle(0xffffff, 0.9).fillCircle(10, 0, 5);
      g.lineStyle(sw, ENEMY_SPECS.dreadnought.tint, 0.7);
      g.lineBetween(-54, 0, 36, 0);
    }
    if (kind === "splitter") {
      // Inner pentagram: connect every other vertex.
      for (let i = 0; i < 5; i++) {
        const a = pts[i];
        const b = pts[(i + 2) % 5];
        if (a && b) g.lineBetween(a.x, a.y, b.x, b.y);
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
        for (let i = 0; i < 3; i++) {
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
      for (let i = 0; i < 3; i++) {
        const a = outer[i];
        const b = outer[i + 3];
        if (a && b) g.lineBetween(a.x, a.y, b.x, b.y);
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
      for (let i = 0; i < 4; i++) {
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
      for (let i = 0; i < 4; i++) {
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
    // Safe-area insets keep the corner box off the home indicator/notch.
    const x0 = this.scale.width - MINIMAP_W - MINIMAP_PAD - this.safeInset.right;
    const y0 = this.scale.height - MINIMAP_H - MINIMAP_PAD - this.safeInset.bottom;
    g.fillStyle(0x000000, 0.6).fillRoundedRect(x0, y0, MINIMAP_W, MINIMAP_H, 4);
    g.lineStyle(1, 0xffffff, 0.15).strokeRoundedRect(x0, y0, MINIMAP_W, MINIMAP_H, 4);
    // Map the live PLAY area (not the fixed max) onto the minimap box.
    const pw = this.world.playW;
    const ph = this.world.playH;
    const sx = MINIMAP_W / pw;
    const sy = MINIMAP_H / ph;

    for (const a of this.world.asteroids) {
      if (!inWorld(a.x, a.y, 0, pw, ph)) continue; // no auto-clip on Graphics
      g.fillStyle(0xffffff, 0.3);
      g.fillCircle(x0 + a.x * sx, y0 + a.y * sy, Math.max(1, a.radius * sx * 0.3));
    }
    for (const e of this.world.enemies) {
      if (!inWorld(e.x, e.y, 0, pw, ph)) continue;
      if (e.kind === "dreadnought") {
        // qa-010: the boss is not fodder — a hollow 4×4 square, not a fleck.
        g.lineStyle(1, ENEMY_SHOT_TINT, 1);
        g.strokeRect(x0 + e.x * sx - 2, y0 + e.y * sy - 2, 4, 4);
      } else {
        g.fillStyle(ENEMY_SHOT_TINT, 1);
        g.fillRect(x0 + e.x * sx - 1, y0 + e.y * sy - 1, 2, 2);
      }
    }
    // qa-010: the UFO piñata is findable — blinking white saucer marker.
    const ufo = this.world.ufo;
    if (ufo && inWorld(ufo.x, ufo.y, 0, pw, ph) && Math.floor(now / 250) % 2 === 0) {
      g.lineStyle(1, 0xffffff, 1);
      g.strokeCircle(x0 + ufo.x * sx, y0 + ufo.y * sy, 2.5);
    }
    // BEACON: pulsing hollow gold diamond from CHARGE start.
    const beacon = this.world.beacon;
    if (beacon && now < beacon.diesAt) {
      const r = 3 + Math.sin((now / 1000) * Math.PI * 2) * 1.2;
      const bx = x0 + beacon.x * sx;
      const by = y0 + beacon.y * sy;
      g.lineStyle(1, BEACON_TINT, 1);
      g.beginPath();
      g.moveTo(bx, by - r);
      g.lineTo(bx + r * 0.7, by);
      g.lineTo(bx, by + r);
      g.lineTo(bx - r * 0.7, by);
      g.closePath();
      g.strokePath();
    }
    for (const it of this.world.items) {
      if (!inWorld(it.x, it.y, 0, pw, ph)) continue;
      g.fillStyle(itemTint(it), 1);
      const px = x0 + it.x * sx;
      const py = y0 + it.y * sy;
      if (it.kind === "booster") {
        // 2px diamonds — the third shell shape reads on the minimap too.
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
    }

    const myId = this.myId;
    for (const [id, st] of this.peerStates) {
      const isMe = id === myId;
      const tint = this.ships.get(id)?.tint ?? 0xffffff;
      let px: number;
      let py: number;
      if (isMe) {
        if (!this.spawned || !this.alive) continue;
        px = this.shipX;
        py = this.shipY;
      } else {
        if (!st || !st.alive) continue; // each dot filtered by ITS player's alive state
        px = st.x;
        py = st.y;
      }
      g.fillStyle(tint, 1).fillCircle(x0 + px * sx, y0 + py * sy, isMe ? 3 : 2);
    }
  }

  // ---- sector cycle (dir-006) ---------------------------------------------------

  /** Sector standings this instant: self live-local, every present remote from
   *  its last wire value. Best-first; id tiebreak so the order converges
   *  identically on every client. */
  private sectorStandings(): Array<{ id: string; pts: number }> {
    const me = this.myId;
    const rows: Array<{ id: string; pts: number }> = [];
    if (me !== null) rows.push({ id: me, pts: Math.round(this.sectorScore) });
    for (const [id, ns] of this.peerStates) {
      if (id === me || !ns || !ns.present) continue;
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
    if (this.lastSectorIdx === -1) this.lastSectorIdx = idx;
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
    if (this.recapEl) this.recapEl.style.opacity = now < this.recapUntil ? "1" : "0";

    // Persistent line: SECTOR 3 · 4:12 · 1,240 PTS · 2ND (solo: rank omitted).
    const rows = this.sectorStandings();
    const myRank = rows.findIndex((r) => r.id === this.myId) + 1;
    const remS = Math.max(0, Math.ceil(SECTOR_LENGTH_S - rel));
    let line =
      `SECTOR ${idx + 1} · ${Math.floor(remS / 60)}:${String(remS % 60).padStart(2, "0")}` +
      ` · ${fmtPts(Math.round(this.sectorScore))} PTS`;
    if (rows.length > 1 && myRank > 0) line += ` · ${ordinal(myRank)}`;
    if (line !== this.lastSectorLine) {
      this.lastSectorLine = line;
      setText(this.sectorEl, line);
    }

    // Standings pulse fills the two beacon-free troughs; never stacked on top
    // of a boss fight or the recap (they own the player's attention).
    const bossLive = this.world.enemies.some((e) => e.kind === "dreadnought");
    const inPulse = SECTOR_PULSE_AT_S.some((at) => rel >= at && rel < at + SECTOR_PULSE_S);
    const showPulse = inPulse && !bossLive && now >= this.recapUntil;
    if (this.pulseEl) this.pulseEl.style.opacity = showPulse ? "1" : "0";
    if (showPulse) {
      let text: string;
      const leader = rows[0];
      if (rows.length > 1 && myRank > 0 && leader) {
        if (myRank === 1) {
          text = `1ST · ${fmtPts(leader.pts - (rows[1]?.pts ?? 0))} AHEAD`;
        } else {
          const gap = leader.pts - Math.round(this.sectorScore);
          text = `${ordinal(myRank)} · ${fmtPts(gap)} BEHIND ${callsign(leader.id)}`;
        }
      } else {
        text =
          `${fmtPts(Math.round(this.sectorScore))} PTS` +
          (this.sectorBest > 0 ? ` · BEST ${fmtPts(this.sectorBest)}` : "");
      }
      if (text !== this.lastPulseText) {
        this.lastPulseText = text;
        setText(this.pulseEl, text);
      }
    }
  }

  /** Boundary recap: standings snapshot into #recap for SECTOR_RECAP_SHOW_S.
   *  Non-blocking DOM (pointer-events: none) — sim, input and firing continue
   *  behind it; tickSector fades it out on schedule. */
  private showRecap(
    completedNum: number,
    rows: Array<{ id: string; pts: number }>,
    now: number,
  ): void {
    this.recapUntil = now + SECTOR_RECAP_SHOW_S * 1000;
    // One chime from the gold shared-event family (beacon vocabulary, no new synth).
    sfx.play("beacon_active", { rate: 1.3, gain: 0.6 });
    const el = this.recapEl;
    if (!el) return;
    let html = `<h2>SECTOR ${completedNum} COMPLETE</h2>`;
    if (rows.length <= 1) {
      html += `<div class="row">${fmtPts(rows[0]?.pts ?? 0)} PTS · BEST ${fmtPts(this.sectorBest)}</div>`;
    } else {
      const entries = rows.map((r, i) => ({
        rank: i + 1,
        name: r.id === this.myId ? "YOU" : callsign(r.id),
        pts: r.pts,
      }));
      const shown = entries.slice(0, 3);
      const mine = entries.find((e) => e.name === "YOU");
      if (mine && mine.rank > 3) shown.push(mine);
      html += shown
        .map((e) => {
          const gold = e.rank === 1 ? ` style="color:${hexCss(BEACON_TINT)}"` : "";
          return `<div class="row"${gold}>${ordinal(e.rank)} · ${e.name} · ${fmtPts(e.pts)}</div>`;
        })
        .join("");
    }
    el.innerHTML = html;
    // dir-009 presence pass: restart the 300ms scale-in alongside the fade,
    // then one winner-row pop ~150ms after the banner lands. DOM-only — the
    // banner stays non-blocking (pointer-events: none, no shake, no input).
    el.classList.remove("in");
    void el.offsetWidth; // reflow so back-to-back recaps re-run the animation
    el.classList.add("in");
    window.setTimeout(() => {
      el.querySelector(".row")?.classList.add("pop");
    }, 450);
  }

  private updateHud(now: number): void {
    // Boss HP bar: shown whenever a dreadnought is live in the arena.
    if (this.bossBarEl && this.bossHpEl) {
      const boss = this.world.enemies.find((e) => e.kind === "dreadnought");
      if (boss && boss.maxHp > 0) {
        this.bossBarEl.style.opacity = "1";
        this.bossHpEl.style.width = `${(Math.max(0, boss.hp / boss.maxHp) * 100).toFixed(1)}%`;
      } else {
        this.bossBarEl.style.opacity = "0";
      }
    }
    setText(this.weaponEl, this.weapon.name);
    if (this.weaponBarEl) {
      // A special is active iff weaponUntil is in the future; base weapons show
      // no bar. Stacked pickups can push the timer past one base duration: clamp
      // the bar full; the extra time drains invisibly until under 20s again.
      const frac =
        this.weaponUntil <= now
          ? 0
          : Math.min(1, Math.max(0, (this.weaponUntil - now) / SPECIAL_WEAPON_DURATION_MS));
      this.weaponBarEl.style.width = `${(frac * 100).toFixed(1)}%`;
      this.weaponBarEl.style.background = hexCss(this.weapon.tint);
    }
    if (this.shieldEl) {
      if (!this.alive || !this.spawned) {
        this.shieldEl.style.display = "none";
      } else {
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
          if (mod) this.shieldModBarEl.style.background = hexCss(SHIELD_MOD_SPECS[mod].tint);
        }
      }
    }
    if (this.boostsEl) {
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
    const mult = comboMult(this.streak);
    if (this.comboEl) {
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
    const n = Object.keys(this.peers).length;
    setText(this.playersEl, this.offline ? "solo · offline" : `${n} player${n === 1 ? "" : "s"}`);
    const dead = this.spawned && !this.alive;
    if (this.overlayEl) this.overlayEl.style.opacity = dead ? "1" : "0";
    if (dead) {
      setText(this.causeEl, this.deathCause ? `— ${this.deathCause}` : "");
      setText(this.hintEl, this.deathHint);
    }
    const secs = dead ? Math.max(0, Math.ceil((this.respawnAt - now) / 1000)) : 0;
    setText(this.countdownEl, secs > 0 ? `Respawning in ${secs}...` : "");
  }

  // ---- dev hooks (headless driving for reviewers) ------------------------------------------

  private installDevHooks(): void {
    if (!import.meta.env.DEV) return;
    window.__starfall = {
      scene: this,
      client: this.client,
      /** Host only: spawn an enemy near (or at) the given point. Elites get
       *  the same qa-018 level-scaled HP stamp as the organic spawn path, so
       *  probes measure shipping durability. */
      spawnEnemy: (kind: EnemyKind, x?: number, y?: number): string | null => {
        if (!this.amHost) return null;
        const e = spawnEnemyState(kind, x ?? this.shipX + 320, y ?? this.shipY);
        if (ELITE_HP_BASE[kind] !== undefined) {
          e.hp = eliteHp(kind, this.maxPresentLevel());
          e.maxHp = e.hp;
        }
        this.world.enemies.push(e);
        this.dirty.enemies = true;
        return e.id;
      },
      /** Host only: run damage through the real hostDamageEnemy pipeline
       *  (warden DR, boss phase floors, kill/loot). Returns the enemy's
       *  post-damage hp, or null if it died/never existed. */
      damageEnemy: (id: string, amount: number): number | null => {
        if (!this.amHost) return null;
        this.hostDamageEnemy(id, amount, 0, 0);
        return this.world.enemies.find((e) => e.id === id)?.hp ?? null;
      },
      /** Grant a shield MOD by kind name (validated — bad kinds are ignored). */
      grantShield: (raw: string): void => {
        const lowered = raw.toLowerCase();
        const kind = SHIELD_MOD_KINDS.find((k) => k === lowered);
        if (!kind) return;
        const now = simNow();
        this.shieldMod = kind;
        this.shieldModUntil = now + SHIELD_MOD_DURATION_MS;
        this.overHp = kind === "overshield" ? OVERSHIELD_BONUS : 0;
        this.phaseReadyAt = 0;
      },
      /** Grant a booster by kind name (repair applies instantly). */
      grantBooster: (raw: string): void => {
        const kind = BOOSTER_KINDS.find((k) => k === raw.toLowerCase());
        if (!kind) return;
        if (kind === "repair") {
          this.shieldHp = Math.max(this.shieldHp, SHIELD_MAX);
          this.lastDamageAt = 0;
        } else {
          this.boosts.set(kind, simNow() + BOOSTER_SPECS[kind].durationMs);
        }
      },
      /** Set the base shield directly; stamps the damage clock so regen
       *  behaves as after a real drain. 0 = death (via the real pipeline). */
      setShield: (hp: number): void => {
        const now = simNow();
        this.shieldHp = Math.min(SIPHON_OVERHEAL_MAX, hp);
        this.lastDamageAt = now;
        this.regenActive = false;
        if (this.shieldHp <= 0 && this.alive) this.die(now, null, "DEV");
      },
      /** Run a drain through the real applyDamage pipeline. */
      damage: (amount: number): string =>
        this.applyDamage(amount, this.shipX + 12, this.shipY, "DEV", null, simNow()),
      grantWeapon: (ref: number | string): void => {
        const weapon =
          typeof ref === "number"
            ? WEAPONS_SPECIAL[ref]
            : WEAPONS_SPECIAL.find((w) => w.name === ref);
        if (!weapon) return;
        this.specialBase = weapon;
        this.weapon = scaleWeaponForLevel(weapon, this.level);
        this.weaponUntil = simNow() + SPECIAL_WEAPON_DURATION_MS;
        this.windupAcc = 0;
      },
      /** Host only: drop a live item at (x,y) (defaults to the ship, so it gets
       *  picked up next frame, which is how stacking is exercised). */
      spawnItem: (cls: "weapon" | "shield" | "booster", name: string, x?: number, y?: number) => {
        if (!this.amHost) return;
        let drop: ItemDrop | null = null;
        if (cls === "weapon") {
          const i = WEAPONS_SPECIAL.findIndex((w) => w.name === name.toUpperCase());
          if (i !== -1) drop = { kind: "weapon", weaponIdx: i };
        } else if (cls === "shield") {
          const i = SHIELD_MOD_KINDS.findIndex((k) => k === name.toLowerCase());
          if (i !== -1) drop = { kind: "shield", shieldIdx: i };
        } else {
          const i = BOOSTER_KINDS.findIndex((k) => k === name.toLowerCase());
          if (i !== -1) drop = { kind: "booster", boosterIdx: i };
        }
        if (!drop) return;
        this.world.items.push(spawnItemState(x ?? this.shipX, y ?? this.shipY, drop));
        this.dirty.items = true;
      },
      /** Host only: shed score shards near the ship. */
      dropShards: (count: number, x?: number, y?: number): void => {
        if (!this.amHost) return;
        this.hostSpawnShards(x ?? this.shipX + 120, y ?? this.shipY, count);
      },
      /** Fire one volley of the current weapon, no pointer needed. */
      fire: (): void => {
        this.fireWeapon(simNow());
      },
      /** Host only: force-spawn a BEACON at (x,y) (defaults near the ship).
       *  Custom charge/active seconds exist for compressed-timer e2e probes;
       *  the real cadence gates are deliberately bypassed. */
      spawnBeacon: (x?: number, y?: number, chargeS?: number, activeS?: number): boolean => {
        if (!this.amHost) return false;
        this.hostSpawnBeacon(x ?? this.shipX + 200, y ?? this.shipY, simNow(), chargeS, activeS);
        return true;
      },
      /** Host only: rewind/forward the intensity director. */
      setArenaEpoch: (epochMs: number): void => {
        if (!this.amHost) return;
        this.world.arenaEpoch = epochMs;
        if (!this.offline) this.client.updateSharedState({ arenaEpoch: epochMs });
      },
      intensity: (): number =>
        arenaIntensity(Math.max(0, (simNow() - this.world.arenaEpoch) / 1000)),
      summary: (): Record<string, unknown> => ({
        alive: this.alive,
        level: this.level,
        xp: this.xp,
        runXp: this.runXp,
        xpToNext: xpToNext(this.level),
        streak: this.streak,
        weapon: this.weapon.name,
        weaponUntil: this.weaponUntil,
        windup: this.windupFrac(),
        shieldHp: Math.round(this.shieldHp * 10) / 10,
        overHp: this.overHp,
        regen: this.regenActive,
        mod: this.shieldMod ? { kind: this.shieldMod, until: this.shieldModUntil } : null,
        boosts: this.boostsNetState(),
        mines: this.beams.filter((b) => b.mine && !b.exploding && !b.vanished).length,
        sentry: this.sentry ? { x: this.sentry.x, y: this.sentry.y } : null,
        pulls: this.world.pulls.length,
        enemies: this.world.enemies.map((e) => e.kind),
        enemyShots: this.world.enemyShots.length,
        asteroids: this.world.asteroids.length,
        items: this.world.items.map((it) => it.kind),
        shards: this.world.shards.length,
        beams: this.beams.length,
        isHost: this.amHost,
        intensity: arenaIntensity(Math.max(0, (simNow() - this.world.arenaEpoch) / 1000)),
        now: simNow(),
        sector: {
          idx: sectorIdx(Math.max(0, (simNow() - this.world.arenaEpoch) / 1000)),
          rel: sectorRelT(Math.max(0, (simNow() - this.world.arenaEpoch) / 1000)),
          score: Math.round(this.sectorScore),
          best: this.sectorBest,
          bossIdx: this.world.sectorBossIdx,
        },
      }),
    };
  }
}

/** The dev-only driving hooks installed on `window.__starfall` (DEV builds
 *  only — headless reviewers poke the game through these). */
type StarfallDevHooks = {
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
  summary: () => Record<string, unknown>;
};

declare global {
  interface Window {
    __starfall?: StarfallDevHooks;
  }
}

// ---- module helpers (pure) ----------------------------------------------------------------

/** 1 → "1ST", 2 → "2ND", 3 → "3RD", 4 → "4TH"… (sector standings surfaces). */
function ordinal(rank: number): string {
  const mod100 = rank % 100;
  const mod10 = rank % 10;
  if (mod10 === 1 && mod100 !== 11) return `${rank}ST`;
  if (mod10 === 2 && mod100 !== 12) return `${rank}ND`;
  if (mod10 === 3 && mod100 !== 13) return `${rank}RD`;
  return `${rank}TH`;
}

/** Thousands-grouped points for the sector surfaces (1240 → "1,240"). */
function fmtPts(pts: number): string {
  return pts.toLocaleString("en-US");
}

/** Saucer outline relative to the UFO's reference point (half-width UFO_RADIUS). */
const UFO_OUTLINE: ReadonlyArray<{ x: number; y: number }> = [
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
const GLAIVE_TRI: ReadonlyArray<Vec> = [0, 1, 2].map((i) => {
  const a = (Math.PI * 2 * i) / 3;
  return { x: Math.cos(a) * 5.77, y: Math.sin(a) * 5.77 };
});

/** Counter-hints surfaced after 3 deaths to the same cause (≤8 words). */
const DEATH_HINTS: Record<string, string> = {
  LANCER: "it can't turn while charging",
  DRONE: "its shots are slow — sidestep",
  WASP: "break the orbit before the burst",
  SPLITTER: "back away when it dies",
  ASTEROID: "small rocks move fastest",
  UFO: "shoot it — never touch it",
  PLAYER: "keep moving, use your drift",
};

function weaponSound(kind: WeaponSfx): { name: SfxName; gain: number; rate?: number } {
  switch (kind) {
    case "pulse":
      return { name: "fire_pulse", gain: 1 };
    case "rapid":
      return { name: "fire_pulse", gain: 0.6 };
    case "heavy":
      return { name: "fire_heavy", gain: 1 };
    case "zap":
      return { name: "fire_laser", gain: 1 };
    case "boom":
      return { name: "fire_heavy", gain: 0.7 };
    case "scatter":
      return { name: "fire_scatter", gain: 1 };
    case "seek":
      return { name: "fire_laser", gain: 0.55 };
    case "arc":
      return { name: "arc_zap", gain: 1 };
    case "glaive":
      return { name: "fire_heavy", gain: 0.8 };
    case "rail":
      return { name: "rail", gain: 1 };
    case "mine":
      return { name: "fire_pulse", gain: 0.5, rate: 0.7 };
    case "nova":
      // The design's "boom at 0.8 gain, −15% pitch".
      return { name: "fire_heavy", gain: 0.8, rate: 0.85 };
    case "drill":
      // Pitched reuse: the heavy thump dropped ~an octave reads as a grind.
      return { name: "fire_heavy", gain: 1.1, rate: 0.55 };
    case "plasma":
      // Quiet pitched-up blip at 70ms cadence reads as a hiss-stream.
      return { name: "fire_pulse", gain: 0.4, rate: 1.45 };
    case "tesla":
      // arc_zap pitched up: a shorter, snappier crackle than ARC's cast.
      return { name: "arc_zap", gain: 0.7, rate: 1.4 };
    case "sentry":
      // The own-bolt pew; the place clack is its own synth (sentry_place).
      return { name: "fire_pulse", gain: 0.7, rate: 1.1 };
    case "singularity":
      // Slow dark launch; the pop reuses fire_heavy pitched down (popSingularity).
      return { name: "fire_laser", gain: 0.8, rate: 0.6 };
  }
}

/** Hull outline per enemy kind (§6.1 silhouettes), relative to center. */
function enemyHullPoints(kind: EnemyKind): ReadonlyArray<Vec> {
  switch (kind) {
    case "drone": {
      // Equilateral triangle, side 12 → circumradius ≈ 6.93, nose at +x.
      return [0, 1, 2].map((i) => {
        const a = (Math.PI * 2 * i) / 3;
        return { x: Math.cos(a) * 6.93, y: Math.sin(a) * 6.93 };
      });
    }
    case "wasp":
      // Chevron, 14 wide, two acute wings, nose at +x.
      return [
        { x: 6, y: 0 },
        { x: -6, y: -7 },
        { x: -2, y: 0 },
        { x: -6, y: 7 },
      ];
    case "lancer":
      // Narrow dart 20×5 (4:1).
      return [
        { x: 10, y: 0 },
        { x: -10, y: -2.5 },
        { x: -6, y: 0 },
        { x: -10, y: 2.5 },
      ];
    case "splitter": {
      // Pentagon r=12 (pentagram drawn separately).
      return [0, 1, 2, 3, 4].map((i) => {
        const a = (Math.PI * 2 * i) / 5 - Math.PI / 2;
        return { x: Math.cos(a) * 12, y: Math.sin(a) * 12 };
      });
    }
    case "warden":
      // Hex bunker, wide, flat-fronted (nose at +x).
      return hexagonPoints(16);
    case "sniper":
      // Long thin arrowhead, longer than the lancer, nose at +x.
      return [
        { x: 14, y: 0 },
        { x: -8, y: -5 },
        { x: -4, y: 0 },
        { x: -8, y: 5 },
      ];
    case "spawner":
      // Hexagonal hive.
      return hexagonPoints(14);
    case "dreadnought":
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
}

function hexagonPoints(radius: number): Vec[] {
  const pts: Vec[] = [];
  for (let i = 0; i < 6; i++) {
    const a = (Math.PI * 2 * i) / 6;
    pts.push({ x: Math.cos(a) * radius, y: Math.sin(a) * radius });
  }
  return pts;
}

/** Visual ship scale by level (collision hitbox stays SHIP_RADIUS — leveling
 *  makes you LOOK bigger/tougher, not easier to hit). L1 1.0 → L5 ~1.52. */
function shipScaleForLevel(level: number): number {
  const L = Math.max(1, Math.min(LEVEL_CAP, Math.round(level)));
  return 1 + (L - 1) * 0.2; // L1 1.0 → L3 1.4 (a clear size jump each level)
}

function shipHullPoints(level = 1): Array<{ x: number; y: number }> {
  const s = shipScaleForLevel(level);
  return SHIP_HULL_DEG.map((deg) => {
    const r = (deg === 180 ? SHIP_RADIUS / 2 : SHIP_RADIUS) * s;
    return { x: Math.cos(deg * DEG) * r, y: Math.sin(deg * DEG) * r };
  });
}

function strokeClosed(
  g: Phaser.GameObjects.Graphics,
  pts: ReadonlyArray<{ x: number; y: number }>,
): void {
  const first = pts[0];
  if (!first) return;
  g.beginPath();
  g.moveTo(first.x, first.y);
  for (let i = 1; i < pts.length; i++) {
    const p = pts[i];
    if (p) g.lineTo(p.x, p.y);
  }
  g.closePath();
  g.strokePath();
}

/** Stroke a closed polygon translated/rotated into world space. */
function strokeTransformed(
  g: Phaser.GameObjects.Graphics,
  pts: ReadonlyArray<Vec>,
  x: number,
  y: number,
  rot: number,
): void {
  const cos = Math.cos(rot);
  const sin = Math.sin(rot);
  const first = pts[0];
  if (!first) return;
  g.beginPath();
  g.moveTo(x + first.x * cos - first.y * sin, y + first.x * sin + first.y * cos);
  for (let i = 1; i < pts.length; i++) {
    const p = pts[i];
    if (p) g.lineTo(x + p.x * cos - p.y * sin, y + p.x * sin + p.y * cos);
  }
  g.closePath();
  g.strokePath();
}

function strokeRegularPolygon(
  g: Phaser.GameObjects.Graphics,
  x: number,
  y: number,
  radius: number,
  sides: number,
  rot: number,
): void {
  g.beginPath();
  for (let i = 0; i <= sides; i++) {
    const a = rot + (Math.PI * 2 * i) / sides;
    const px = x + Math.cos(a) * radius;
    const py = y + Math.sin(a) * radius;
    if (i === 0) g.moveTo(px, py);
    else g.lineTo(px, py);
  }
  g.strokePath();
}

function dashedLine(
  g: Phaser.GameObjects.Graphics,
  x: number,
  y: number,
  angle: number,
  length: number,
  dash: number,
  gap: number,
): void {
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  for (let d = 0; d < length; d += dash + gap) {
    const end = Math.min(d + dash, length);
    g.lineBetween(x + cos * d, y + sin * d, x + cos * end, y + sin * end);
  }
}

/** ARC bolt: 3 jittered sub-segments per hop, re-rolled every frame. */
function drawJitteredChain(
  g: Phaser.GameObjects.Graphics,
  chain: ReadonlyArray<Vec>,
  tint: number,
): void {
  g.lineStyle(1, tint, 0.95);
  for (let i = 0; i < chain.length - 1; i++) {
    const a = chain[i];
    const b = chain[i + 1];
    if (!a || !b) continue;
    let px = a.x;
    let py = a.y;
    for (let s = 1; s <= 3; s++) {
      const t = s / 3;
      const jitter = s < 3 ? 6 : 0;
      const nx = a.x + (b.x - a.x) * t + (Math.random() * 2 - 1) * jitter;
      const ny = a.y + (b.y - a.y) * t + (Math.random() * 2 - 1) * jitter;
      g.lineBetween(px, py, nx, ny);
      px = nx;
      py = ny;
    }
  }
}

function drawPoly(g: Phaser.GameObjects.Graphics, verts: ReadonlyArray<{ x: number; y: number }>) {
  g.clear();
  g.lineStyle(1, 0xffffff, 1);
  strokeClosed(g, verts);
}

function serializeBeam(b: Beam): SerializedBeam {
  if (b.chain && b.chain.length >= 2) {
    const first = b.chain[0];
    const last = b.chain[b.chain.length - 1];
    return {
      hx: last?.x ?? b.head.x,
      hy: last?.y ?? b.head.y,
      tx: first?.x ?? b.tail.x,
      ty: first?.y ?? b.tail.y,
      tint: b.weapon.tint,
      width: b.weapon.width,
      exploding: false,
      explosionRadius: 0,
      chain: b.chain,
      power: b.weapon.power,
    };
  }
  const sb: SerializedBeam = {
    hx: b.head.x,
    hy: b.head.y,
    tx: b.tail.x,
    ty: b.tail.y,
    tint: b.weapon.tint,
    width: b.weapon.width,
    exploding: b.exploding,
    explosionRadius: b.explosionRadius,
    power: b.weapon.power,
  };
  if (b.glaive) sb.glaive = true;
  if (b.mine) sb.mine = true;
  if (b.weapon.singularity && !b.exploding) sb.orb = true;
  return sb;
}

function readNetState(player: Player | undefined): PlayerNetState | null {
  const s = player?.state;
  if (!s) return null;
  const x = s["x"];
  const y = s["y"];
  const angle = s["angle"];
  if (typeof x !== "number" || typeof y !== "number" || typeof angle !== "number") return null;
  const beams: SerializedBeam[] = [];
  const raw = s["beams"];
  if (Array.isArray(raw)) {
    for (const entry of raw) {
      const b = asRecord(entry);
      if (!b) continue;
      const hx = b["hx"];
      const hy = b["hy"];
      const tx = b["tx"];
      const ty = b["ty"];
      const tint = b["tint"];
      const width = b["width"];
      if (
        typeof hx !== "number" ||
        typeof hy !== "number" ||
        typeof tx !== "number" ||
        typeof ty !== "number" ||
        typeof tint !== "number" ||
        typeof width !== "number"
      ) {
        continue;
      }
      const er = b["explosionRadius"];
      const beam: SerializedBeam = {
        hx,
        hy,
        tx,
        ty,
        tint,
        width,
        exploding: b["exploding"] === true,
        explosionRadius: typeof er === "number" ? er : 0,
      };
      const chainRaw = b["chain"];
      if (Array.isArray(chainRaw)) {
        const pts: Vec[] = [];
        for (const pt of chainRaw) {
          const r = asRecord(pt);
          if (r && typeof r["x"] === "number" && typeof r["y"] === "number") {
            pts.push({ x: r["x"], y: r["y"] });
          }
        }
        if (pts.length >= 2) beam.chain = pts;
      }
      if (b["glaive"] === true) beam.glaive = true;
      if (b["mine"] === true) beam.mine = true;
      if (b["orb"] === true) beam.orb = true;
      if (typeof b["power"] === "number") beam.power = b["power"];
      beams.push(beam);
    }
  }
  const level = s["level"];
  const xp = s["xp"];
  const streak = s["streak"];
  const sectorScore = s["sectorScore"];
  const weaponName = s["weaponName"];
  const vx = s["vx"];
  const vy = s["vy"];
  let shieldMod: ShieldModNetState | null = null;
  const modRaw = asRecord(s["shieldMod"]);
  if (modRaw) {
    const kind = SHIELD_MOD_KINDS.find((k) => k === modRaw["kind"]);
    if (kind) {
      shieldMod = {
        kind,
        until: typeof modRaw["until"] === "number" ? modRaw["until"] : 0,
        active: modRaw["active"] === true,
        phased: modRaw["phased"] === true,
      };
    }
  }
  const boosts: BoostNetState[] = [];
  const boostsRaw = s["boosts"];
  if (Array.isArray(boostsRaw)) {
    for (const entry of boostsRaw) {
      const r = asRecord(entry);
      if (!r) continue;
      const kind = BOOSTER_KINDS.find((k) => k === r["kind"]);
      if (kind && typeof r["until"] === "number") boosts.push({ kind, until: r["until"] });
    }
  }
  const shieldHp = s["shieldHp"];
  const overHp = s["overHp"];
  const windup = s["windup"];
  let sentry: PlayerNetState["sentry"] = null;
  const sentryRaw = asRecord(s["sentry"]);
  if (
    sentryRaw &&
    typeof sentryRaw["x"] === "number" &&
    typeof sentryRaw["y"] === "number" &&
    typeof sentryRaw["until"] === "number"
  ) {
    sentry = { x: sentryRaw["x"], y: sentryRaw["y"], until: sentryRaw["until"] };
  }
  return {
    x,
    y,
    angle,
    vx: typeof vx === "number" ? vx : 0,
    vy: typeof vy === "number" ? vy : 0,
    alive: s["alive"] !== false,
    present: s["present"] !== false,
    invuln: s["invuln"] === true,
    level: typeof level === "number" ? level : 1,
    xp: typeof xp === "number" ? xp : 0,
    streak: typeof streak === "number" ? streak : 0,
    sectorScore: typeof sectorScore === "number" ? sectorScore : 0,
    weaponName: typeof weaponName === "string" ? weaponName : "",
    shieldHp: typeof shieldHp === "number" ? shieldHp : SHIELD_MAX,
    overHp: typeof overHp === "number" ? overHp : 0,
    shieldMod,
    boosts,
    windup: typeof windup === "number" ? windup : 0,
    tesla: s["tesla"] === true,
    sentry,
    beams,
  };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return isRecord(v) ? v : null;
}

/** Index an entity array by id (reconcile does many find-by-id lookups). */
function indexById<T extends { id: string }>(list: readonly T[]): Map<string, T> {
  const map = new Map<string, T>();
  for (const e of list) map.set(e.id, e);
  return map;
}

function cloneAsteroid(a: AsteroidState): AsteroidState {
  return { ...a };
}

/** Soft-correct a dead-reckoned position toward the authoritative one. */
function blendPos(target: { x: number; y: number }, ax: number, ay: number): void {
  const dx = ax - target.x;
  const dy = ay - target.y;
  if (dx * dx + dy * dy > SNAP_DIST * SNAP_DIST) {
    target.x = ax;
    target.y = ay;
  } else {
    target.x += dx * 0.3;
    target.y += dy * 0.3;
  }
}

function blinkAlpha(now: number): number {
  return Math.floor(now / INVULN_BLINK_MS) % 2 === 0 ? 0.9 : 0.3;
}

function inWorld(x: number, y: number, margin: number, w = WORLD_W, h = WORLD_H): boolean {
  return x >= -margin && x <= w + margin && y >= -margin && y <= h + margin;
}

function dist2(ax: number, ay: number, bx: number, by: number): number {
  const dx = ax - bx;
  const dy = ay - by;
  return dx * dx + dy * dy;
}

/** Closest-point distance from segment (x1,y1)→(x2,y2) to a circle. */
function segHitsCircle(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  cx: number,
  cy: number,
  r: number,
): boolean {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  const t = len2 > 0 ? Phaser.Math.Clamp(((cx - x1) * dx + (cy - y1) * dy) / len2, 0, 1) : 0;
  return dist2(x1 + dx * t, y1 + dy * t, cx, cy) <= r * r;
}

/** Wrap an angle difference into [-π, π]. */
function wrapAngle(a: number): number {
  return Math.atan2(Math.sin(a), Math.cos(a));
}

/** Rotate `from` toward `to` by at most `maxStep` radians. */
function rotateToward(from: number, to: number, maxStep: number): number {
  const diff = wrapAngle(to - from);
  return from + Phaser.Math.Clamp(diff, -maxStep, maxStep);
}

function nearestOf(points: ReadonlyArray<Vec>, x: number, y: number): Vec | null {
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
}

function weightedEnemyRoll(kinds: ReadonlyArray<EnemyKind>, intensity: number): EnemyKind | null {
  let total = 0;
  for (const k of kinds) total += enemySpawnWeight(k, intensity);
  if (total <= 0) return null;
  let roll = rand() * total;
  for (const k of kinds) {
    roll -= enemySpawnWeight(k, intensity);
    if (roll <= 0) return k;
  }
  return kinds[kinds.length - 1] ?? null;
}

function targetKey(ref: TargetRef): string {
  return ref.kind === "ufo" ? "ufo" : `${ref.kind}:${ref.id}`;
}

function itemTint(it: ItemState): number {
  if (it.kind === "weapon") return WEAPONS_SPECIAL[it.weaponIdx]?.tint ?? 0xffffff;
  if (it.kind === "booster") return BOOSTER_SPECS[BOOSTER_KINDS[it.boosterIdx] ?? "repair"].tint;
  return SHIELD_MOD_SPECS[SHIELD_MOD_KINDS[it.shieldIdx] ?? "overshield"].tint;
}

/** Remote windup glow tint from the shooter's weaponName (white fallback). */
function weaponTint(name: string): number {
  return WEAPONS_SPECIAL.find((w) => w.name === name)?.tint ?? 0xffffff;
}

/** Random lerp between two 0xRRGGBB tints (PLASMA's per-shot gradient). */
function lerpTint(a: number, b: number): number {
  const t = Math.random();
  const ch = (shift: number): number => {
    const ca = (a >> shift) & 0xff;
    const cb = (b >> shift) & 0xff;
    return Math.round(ca + (cb - ca) * t) << shift;
  };
  return ch(16) | ch(8) | ch(0);
}

/** 4-point open diamond, 1px stroke (mine + booster shells). */
function strokeDiamond(g: Phaser.GameObjects.Graphics, x: number, y: number, r: number): void {
  g.beginPath();
  g.moveTo(x, y - r);
  g.lineTo(x + r, y);
  g.lineTo(x, y + r);
  g.lineTo(x - r, y);
  g.closePath();
  g.strokePath();
}

function hexCss(tint: number): string {
  return `#${tint.toString(16).padStart(6, "0")}`;
}

function setText(el: HTMLElement | null, text: string): void {
  if (el && el.textContent !== text) el.textContent = text;
}

/** Server player colors are `hsl(h, s%, l%)` strings; Graphics wants ints. */
function cssToInt(css: string | undefined): number {
  if (!css) return 0xffffff;
  const hsl = /hsl\(\s*([\d.]+)\s*,\s*([\d.]+)%\s*,\s*([\d.]+)%\s*\)/.exec(css);
  if (hsl) {
    return hslToInt(Number(hsl[1] ?? 0), Number(hsl[2] ?? 0) / 100, Number(hsl[3] ?? 100) / 100);
  }
  const rgb = /rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)/.exec(css);
  if (rgb) {
    return (Number(rgb[1] ?? 255) << 16) | (Number(rgb[2] ?? 255) << 8) | Number(rgb[3] ?? 255);
  }
  const hex = /^#([0-9a-f]{6})$/i.exec(css);
  if (hex) return parseInt(hex[1] ?? "ffffff", 16);
  return 0xffffff;
}

function hslToInt(h: number, s: number, l: number): number {
  const a = s * Math.min(l, 1 - l);
  const f = (n: number): number => {
    const k = (n + h / 30) % 12;
    return l - a * Math.max(-1, Math.min(k - 3, Math.min(9 - k, 1)));
  };
  return (Math.round(f(0) * 255) << 16) | (Math.round(f(8) * 255) << 8) | Math.round(f(4) * 255);
}
