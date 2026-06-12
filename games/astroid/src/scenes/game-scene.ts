import { MultiplayerClient } from "@vibedgames/multiplayer";
import type { Player } from "@vibedgames/multiplayer";
import Phaser from "phaser";

import { sfx } from "../audio/sfx";
import type { SfxName } from "../audio/sfx";
import { FxPool, PARTICLE_SOFT_BUDGET } from "../render/fx-pool";
import { Starfield } from "../render/starfield";
import { TraumaCamera } from "../render/trauma-camera";
import {
  OFFLINE_FALLBACK_MS,
  ARC_CAST_CONE_DEG,
  ARC_FIZZLE_LEN,
  ARC_RENDER_MS,
  arenaIntensity,
  ASTEROID_CULL_MARGIN,
  ASTEROID_MAX_RADIUS,
  ASTEROID_MIN_RADIUS,
  ASTEROID_ROT_SPEED,
  ASTEROID_SEED_COUNT,
  asteroidCap,
  asteroidSpawnIntervalMs,
  asteroidSpeed,
  BARRIER_MAX_CHARGES,
  BARRIER_REGEN_DELAY_MS,
  BARRIER_REGEN_INTERVAL_MS,
  COMBO_WINDOW_MS,
  comboMult,
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
  enemyCap,
  enemySpawnIntervalMs,
  enemySpawnWeight,
  GLAIVE_DECEL_PX,
  HOMING_LOCK_CONE_DEG,
  INVULN_BLINK_MS,
  INVULNERABLE_MS,
  ITEM_DRAW_RADIUS,
  ITEM_PICKUP_RADIUS,
  LANCER_CHARGE_HIT_RADIUS,
  LANCER_CHARGE_MS,
  LANCER_CHARGE_RANGE,
  LANCER_CHARGE_SPEED,
  LANCER_CRUISE_SPEED,
  LANCER_RECOVER_MS,
  LANCER_WINDUP_MS,
  MINIMAP_H,
  MINIMAP_PAD,
  MINIMAP_W,
  NET_INTERVAL_MS,
  PHASE_COOLDOWN_MS,
  PHASE_DURATION_MS,
  playerPressure,
  RAM_ARM_SPEED,
  RAM_ASTEROID_CHIP,
  RAM_ASTEROID_DESTROY_R,
  RAM_DAMAGE,
  RAM_IMMUNITY_MS,
  RAM_KNOCKBACK,
  randomWorldPoint,
  REFLECT_COOLDOWN_MS,
  REFLECT_PVP_IFRAME_MS,
  RESPAWN_ASTEROID_MIN_R,
  RESPAWN_ATTEMPTS,
  RESPAWN_CLEARANCE,
  RESPAWN_DELAY_MS,
  rollShieldDrop,
  SCORE,
  SHIELD_HALO_RADIUS,
  SHIELD_KINDS,
  SHIELD_PITY_KILLS,
  SHIELD_SPECS,
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
  spawnAsteroidState,
  spawnEnemyState,
  spawnShieldItemState,
  spawnUfoState,
  spawnWeaponItemState,
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
  WEAPON_DEFAULT,
  WEAPONS_SPECIAL,
  WORLD_H,
  WORLD_W,
  type AsteroidState,
  type EnemyKind,
  type EnemyShotState,
  type ItemState,
  type PlayerNetState,
  type SerializedBeam,
  type SharedState,
  type ShieldKind,
  type ShieldNetState,
  type Vec,
  type Weapon,
  type WeaponSfx,
} from "../shared/constants";

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
  /** ARC render expiry (0 = not an arc bolt). */
  diesAt: number;
  /** GLAIVE visual spin. */
  spin: number;
};

type ShipObjs = {
  gfx: Phaser.GameObjects.Graphics;
  tint: number;
  alive: boolean;
  /** False until the first state snapshot lands (remote ships snap, not glide). */
  seenState: boolean;
  /** Thruster trail emitter (null when over the remote-trail cap). */
  trail: Phaser.GameObjects.Particles.ParticleEmitter | null;
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
};

const MULTIPLAYER_HOST = import.meta.env.DEV
  ? "http://localhost:8787"
  : "https://vibedgames-party.kyh.workers.dev";

// Fresh room name: old deployed clients on the legacy "home" room can't
// pollute this build's shared-state shape.
const ROOM = "astroid-arena";

const DEG = Math.PI / 180;
/** Beams vanish this far outside the world. */
const BEAM_CULL_MARGIN = 200;
/** Black mask thickness past the world edge (covers any screen half-width). */
const MASK_PAD = 4000;
/** Reconcile snaps instead of blending past this offset. */
const SNAP_DIST = 80;
const SPLINTER_LIFE_MS = 7000;
const SPLINTER_PX = 2;
/** Host suppresses enemy spawns for the arena's first seconds (safe opening). */
const ARENA_SAFE_MS = 6000;

function emptyShared(): SharedState {
  // Every resettable field MUST be present — patches shallow-merge, so an
  // omitted key carries over.
  return {
    asteroids: [],
    ufo: null,
    items: [],
    enemies: [],
    enemyShots: [],
    arenaEpoch: Date.now(),
  };
}

function isShared(v: unknown): v is SharedState {
  return (
    typeof v === "object" && v !== null && Array.isArray((v as { asteroids?: unknown }).asteroids)
  );
}

export class GameScene extends Phaser.Scene {
  private client!: MultiplayerClient;
  private starfield!: Starfield;
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
  private weapon: Weapon = WEAPON_DEFAULT;
  private weaponUntil = 0;
  private shootCooldown = 0;
  private score = 0;
  private beams: Beam[] = [];
  private firedOnce = false;
  /** Phaser's activePointer sits at (0,0) until the first real pointer event —
   *  steering before then would yank the ship to the screen corner. */
  private pointerSeen = false;
  /** Items we picked up locally, awaiting host confirmation (id → time). */
  private recentPickups = new Map<string, number>();
  /** Enemy shots we consumed locally (shield/death), awaiting host removal
   *  (id → time) — stops stale snapshots resurrecting them into the shield. */
  private recentConsumedShots = new Map<string, number>();

  // Solo fallback: if the party server can't be reached, this client becomes
  // its own host over the same code paths (events loop back, the local world
  // is authoritative, network writes no-op).
  private offline = false;
  private offlineSeeded = false;
  private bootedAt = 0;

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
    return this.offline ? {} : this.client.players;
  }

  /** Events loop straight back into the local host when offline. */
  private netSendEvent(event: string, payload: Record<string, unknown>): void {
    if (this.offline) this.handleEvent(event, payload, "solo");
    else this.client.sendEvent(event, payload);
  }

  /** Give up on the party server after the grace window and go solo. */
  private maybeGoOffline(now: number): void {
    const status = this.client.connectionStatus;
    const failed = status === "disconnected" || status === "error";
    if (!failed && now - this.bootedAt < OFFLINE_FALLBACK_MS) return;
    this.offline = true;
    this.client.destroy(); // stop reconnect attempts; refresh to go online
    this.ensureSeeded();
  }

  /** Targets whose destroy bonus I already self-awarded, awaiting host removal
   *  (id → time). Dedupes the bonus for beams that survive hits (LASER pierces
   *  and re-intersects every frame until the host's echo lands). */
  private predictedKills = new Map<string, number>();

  // shield (victim-side adjudication; mirrored into net state)
  private shield: { kind: ShieldKind; charges: number; phased: boolean } | null = null;
  private barrierNextRegenAt = 0;
  private reflectReadyAt = 0;
  private phasedUntil = 0;
  private phaseReadyAt = 0;
  /** Generic post-absorb contact immunity (barrier bounces). */
  private contactIframeUntil = 0;
  /** REFLECT/BARRIER vs PvP beams: the beam keeps rendering, so brief i-frames. */
  private pvpIframeUntil = 0;
  /** RAM: per-target contact immunity after a hit (id → until). */
  private ramImmunity = new Map<string, number>();
  private haloFlashUntil = 0;

  // combo (purely local; streak mirrored for nameplates/minimap)
  private streak = 0;
  private comboExpiresAt = 0;
  private comboTier = 1;
  private sessionBest = 0;

  // death bookkeeping (overlay cause + adaptive hints)
  private deathCause = "";
  private deathHint = "";
  private deathCounts = new Map<string, number>();

  // networking cadence
  private netAcc = 0;
  private shareAcc = 0;
  private dirty = { asteroids: false, ufo: false, items: false, enemies: false, enemyShots: false };
  private lastAsteroidSpawnAt = 0;

  // host-only director state (lost on migration — acceptable per design)
  private enemySim = new Map<string, EnemySim>();
  private lastEnemySpawnAt = 0;
  /** False until our first hostTick — promotion stamps the spawn clocks. */
  private wasHost = false;
  private lastBreatherDespawnAt = 0;
  private debuted = new Set<EnemyKind>();
  private debutSuppressUntil = 0;
  private shieldPity = 0;

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
  private enemyShotGfx!: Phaser.GameObjects.Graphics;
  private telegraphGfx!: Phaser.GameObjects.Graphics;
  private haloGfx!: Phaser.GameObjects.Graphics;
  private muzzleGfx!: Phaser.GameObjects.Graphics;
  private splinterGfx!: Phaser.GameObjects.Graphics;
  private minimapGfx!: Phaser.GameObjects.Graphics;
  private flashRect!: Phaser.GameObjects.Rectangle;
  private splinters: Splinter[] = [];
  private muzzleFlashes: MuzzleFlash[] = [];
  private remoteTrailCount = 0;

  // HUD (DOM, owned by index.html)
  private scoreEl: HTMLElement | null = null;
  private weaponEl: HTMLElement | null = null;
  private weaponBarEl: HTMLElement | null = null;
  private shieldEl: HTMLElement | null = null;
  private comboEl: HTMLElement | null = null;
  private comboValEl: HTMLElement | null = null;
  private comboBarEl: HTMLElement | null = null;
  private playersEl: HTMLElement | null = null;
  private overlayEl: HTMLElement | null = null;
  private causeEl: HTMLElement | null = null;
  private hintEl: HTMLElement | null = null;
  private replayEl: HTMLElement | null = null;
  private countdownEl: HTMLElement | null = null;
  private attractEl: HTMLElement | null = null;

  constructor() {
    super("Game");
  }

  create(): void {
    this.scoreEl = document.getElementById("score");
    this.weaponEl = document.getElementById("weapon");
    this.weaponBarEl = document.getElementById("weaponbar");
    this.shieldEl = document.getElementById("shield");
    this.comboEl = document.getElementById("combo");
    this.comboValEl = document.getElementById("comboval");
    this.comboBarEl = document.getElementById("combobar");
    this.playersEl = document.getElementById("players");
    this.overlayEl = document.getElementById("overlay");
    this.causeEl = document.getElementById("cause");
    this.hintEl = document.getElementById("hint");
    this.replayEl = document.getElementById("replay");
    this.countdownEl = document.getElementById("countdown");
    this.attractEl = document.getElementById("attract");

    this.starfield = new Starfield(this);
    this.fx = new FxPool(this);

    // Black mask outside the world: entities legitimately exist past the edge
    // (spawning asteroids, escaping beams) but must not be visible there.
    const edges: ReadonlyArray<readonly [number, number, number, number]> = [
      [-MASK_PAD, -MASK_PAD, WORLD_W + MASK_PAD * 2, MASK_PAD],
      [-MASK_PAD, WORLD_H, WORLD_W + MASK_PAD * 2, MASK_PAD],
      [-MASK_PAD, 0, MASK_PAD, WORLD_H],
      [WORLD_W, 0, MASK_PAD, WORLD_H],
    ];
    for (const [x, y, w, h] of edges) {
      this.add.rectangle(x, y, w, h, 0x020617).setOrigin(0).setDepth(50);
    }

    this.beamGfx = this.add.graphics().setDepth(12);
    this.enemyShotGfx = this.add.graphics().setDepth(12);
    this.telegraphGfx = this.add.graphics().setDepth(13).setBlendMode(Phaser.BlendModes.ADD);
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

    // No `initialState`: the package re-applies it whenever a client becomes
    // host, which would wipe the live world on host migration. The first host
    // seeds explicitly (see `ensureSeeded`).
    this.client = new MultiplayerClient({
      host: MULTIPLAYER_HOST,
      party: "vg-server",
      room: ROOM,
      onEvent: (event, payload, from) => this.handleEvent(event, payload, from),
    });
    this.client.subscribe(() => this.onUpdate());
    this.bootedAt = Date.now();

    this.input.on(Phaser.Input.Events.POINTER_MOVE, () => {
      this.pointerSeen = true;
    });
    this.input.on(Phaser.Input.Events.POINTER_DOWN, () => {
      this.pointerSeen = true;
      sfx.unlock(); // WebAudio needs a user gesture
    });

    // Single-start assumption: this scene is started once per page load and
    // never restarted, so create()-initialized fields are never stale. `once`
    // keeps the shutdown hook from stacking if that ever changes.
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      if (!this.offline) this.client.destroy(); // offline already destroyed it
    });

    this.installDevHooks();
  }

  override update(time: number, delta: number): void {
    const dt = Math.min(delta, 100) / 1000; // clamp tab-switch spikes
    this.starfield.update(dt, time);
    if (!this.live) {
      this.maybeGoOffline(Date.now());
      if (!this.live) return;
    }
    const now = Date.now();

    this.ensureSpawned();
    this.tickRespawn(now);
    this.steerShip(dt);
    this.handleShooting(delta, now);
    this.updateBeams(dt, now);
    this.advanceWorld(dt);
    if (this.amHost) this.hostTick(now, dt, delta);
    this.detectMyHits(now);
    this.detectMyDeath(now, dt);
    this.pickupItems(now);
    this.tickShield(now);
    if (this.weapon !== WEAPON_DEFAULT && now >= this.weaponUntil) this.weapon = WEAPON_DEFAULT;
    if (this.streak > 0 && now >= this.comboExpiresAt) {
      this.streak = 0;
      this.comboTier = 1;
    }
    this.netSend(delta, now);

    this.syncShips(now, dt);
    this.syncAsteroids(now);
    this.syncUfo(now);
    this.syncItems();
    this.syncEnemies(now);
    this.drawEnemyTelegraphs(now);
    this.drawEnemyShots();
    this.drawBeams(now);
    this.updateSplinters(dt, now);
    this.fx.update(dt, this.time.now);
    this.drawMinimap();
    this.updateCamera(dt, time);
    this.updateHud(now);
  }

  // ---- input + my ship -------------------------------------------------------

  /** First connect: drop the ship at a clear spot and snap the camera. */
  private ensureSpawned(): void {
    if (this.spawned || !this.myId) return;
    const pos = this.pickRespawnPoint(); // joining a live arena: same clearance as respawn
    this.shipX = pos.x;
    this.shipY = pos.y;
    this.spawned = true;
    this.cameras.main.centerOn(pos.x, pos.y);
    this.spawnInFx(pos.x, pos.y);
    this.pushMyState(Date.now());
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
    this.kickX = 0;
    this.kickY = 0;
    this.cameras.main.centerOn(pos.x, pos.y);
    this.spawnInFx(pos.x, pos.y);
    sfx.play("respawn");
    this.pushMyState(now);
  }

  /** Re-roll until clear of enemies + big asteroids; ≤8 attempts, take best. */
  private pickRespawnPoint(): Vec {
    let best = randomWorldPoint();
    let bestClearance = -1;
    for (let i = 0; i < RESPAWN_ATTEMPTS; i++) {
      const p = randomWorldPoint();
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
   * The control identity, now with drift: the nose always points at the
   * cursor (instant), thrust accelerates toward it scaled by distance, and
   * exponential drag makes you glide. Stopping (dead zone) brakes harder than
   * flying — responsive stop, drifty start. Touch works the same.
   */
  private steerShip(dt: number): void {
    if (!this.alive || !this.spawned) return;
    let drag = SHIP_BRAKE_DRAG;
    this.thrust = 0;
    if (this.pointerSeen) {
      const cam = this.cameras.main;
      const p = this.input.activePointer;
      const dx = p.x + cam.scrollX - this.shipX;
      const dy = p.y + cam.scrollY - this.shipY;
      const dist = Math.hypot(dx, dy);
      if (dist > 0.001) this.shipAngle = Math.atan2(dy, dx);
      this.thrust = Math.min(1, Math.max(0, (dist - SHIP_DEAD_ZONE) / SHIP_THRUST_RAMP));
      if (this.thrust > 0 && dist > 0.001) {
        this.shipVX += (dx / dist) * SHIP_ACCEL * this.thrust * dt;
        this.shipVY += (dy / dist) * SHIP_ACCEL * this.thrust * dt;
      }
      drag = dist > SHIP_DEAD_ZONE ? SHIP_DRAG : SHIP_BRAKE_DRAG;
    }
    const decay = Math.exp(-drag * dt);
    this.shipVX *= decay;
    this.shipVY *= decay;
    const speed = Math.hypot(this.shipVX, this.shipVY);
    if (speed > SHIP_MAX_SPEED) {
      const k = SHIP_MAX_SPEED / speed;
      this.shipVX *= k;
      this.shipVY *= k;
    }
    this.shipX += this.shipVX * dt;
    this.shipY += this.shipVY * dt;
    // Wall clamp kills the perpendicular component: slide along edges.
    if (this.shipX < 0 || this.shipX > WORLD_W) {
      this.shipX = Phaser.Math.Clamp(this.shipX, 0, WORLD_W);
      this.shipVX = 0;
    }
    if (this.shipY < 0 || this.shipY > WORLD_H) {
      this.shipY = Phaser.Math.Clamp(this.shipY, 0, WORLD_H);
      this.shipVY = 0;
    }
  }

  private handleShooting(delta: number, now: number): void {
    // The cooldown runs into (bounded) deficit and each shot pays intervalMs
    // back, so the leftover carries between shots — true average cadence on
    // any refresh rate instead of rounding up to whole frames.
    this.shootCooldown = Math.max(-this.weapon.intervalMs, this.shootCooldown - delta);
    if (!this.alive || !this.spawned || now < this.phasedUntil) return;
    if (!this.input.activePointer.isDown || this.shootCooldown > 0) return;
    this.shootCooldown += this.weapon.intervalMs;
    if (!this.firedOnce) {
      this.firedOnce = true;
      if (this.attractEl) this.attractEl.style.opacity = "0";
    }
    this.fireWeapon(now);
  }

  /** One volley of the current weapon (pellets / arc cast / single beam). */
  private fireWeapon(now: number): void {
    const nose = {
      x: this.shipX + Math.cos(this.shipAngle) * SHIP_RADIUS,
      y: this.shipY + Math.sin(this.shipAngle) * SHIP_RADIUS,
    };
    const arc = this.weapon.arc;
    let gainScale = 1;
    if (arc) {
      if (this.fireArc(now, nose, arc)) gainScale = 0.5; // fizzle: quieter zap
    } else {
      const n = this.weapon.pellets;
      for (let i = 0; i < n; i++) {
        const spread =
          n > 1 ? -this.weapon.spreadDeg / 2 + (this.weapon.spreadDeg * i) / (n - 1) : 0;
        const jitter = (Math.random() * 2 - 1) * this.weapon.jitterDeg;
        const angle = this.shipAngle + (spread + jitter) * DEG;
        this.beams.push(this.makeBeam(nose, angle, this.weapon, now));
      }
    }
    this.muzzleFx(nose, now, gainScale);
  }

  private makeBeam(nose: Vec, angle: number, weapon: Weapon, now: number): Beam {
    return {
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
      diesAt: 0,
      spin: now % 1000, // desync glaive spin phases a little
    };
  }

  /** Muzzle flash + camera kick + fire sfx, per weapon family (§9). */
  private muzzleFx(nose: Vec, now: number, gainScale = 1): void {
    const w = this.weapon;
    const sound = weaponSound(w.sfx);
    sfx.play(sound.name, { gain: sound.gain * gainScale });
    const aimDeg = this.shipAngle / DEG;
    switch (w.sfx) {
      case "heavy":
      case "glaive":
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
    for (const [id, player] of Object.entries(this.peers)) {
      if (id === myId) continue;
      const st = readNetState(player);
      if (!st || !st.alive || st.invuln || st.shield?.phased) continue;
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
        const st = readNetState(this.peers[ref.id]);
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
    for (const [id, player] of Object.entries(this.peers)) {
      if (id === myId) continue;
      const st = readNetState(player);
      if (st && st.alive && !st.invuln && !st.shield?.phased) {
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
        if (e.hp - dmgHp <= 0 && !this.predictedKills.has(e.id)) {
          this.predictedKills.set(e.id, now);
          this.registerKill(ENEMY_SPECS[e.kind].score, now);
        }
        this.netSendEvent("enemy_hit", { enemyId: e.id, damage: dmgHp });
        return;
      }
      case "asteroid": {
        const a = this.world.asteroids.find((as) => as.id === ref.id);
        if (!a) return;
        const power = dmgHp / 100;
        const destroyed = a.radius - ASTEROID_MAX_RADIUS * Math.min(power, 1) < ASTEROID_MIN_RADIUS;
        if (destroyed && !this.predictedKills.has(a.id)) {
          this.predictedKills.set(a.id, now);
          this.registerKill(SCORE.ASTEROID_DESTROY, now);
        } else {
          this.score += SCORE.ASTEROID_CHIP;
        }
        this.netSendEvent("asteroid_hit", { asteroidId: a.id, damage: power });
        return;
      }
      case "ufo": {
        const u = this.world.ufo;
        if (!u) return;
        if (u.hp - dmgHp <= 0 && !this.predictedKills.has(u.id)) {
          this.predictedKills.set(u.id, now);
          this.registerKill(SCORE.UFO_DESTROY, now);
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
        if (!inWorld(b.head.x, b.head.y, BEAM_CULL_MARGIN)) b.vanished = true;
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
      if (!inWorld(b.head.x, b.head.y, BEAM_CULL_MARGIN)) {
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

  /** Beam reaction to a hit: explode, pass through, or vanish. */
  private onBeamHit(b: Beam): void {
    if (b.exploding) return; // expanding AoE keeps going; updateBeams expires it at range
    if (b.weapon.explosion) {
      b.exploding = true;
      b.explosionRadius = 0;
      return;
    }
    if (!b.weapon.through) b.vanished = true;
  }

  // ---- hits, kills + combo ------------------------------------------------------

  /** A kill: bump the streak, award table value × multiplier, milestone FX. */
  private registerKill(base: number, now: number): void {
    this.streak += 1;
    this.comboExpiresAt = now + COMBO_WINDOW_MS;
    const mult = comboMult(this.streak);
    this.score += base * mult;
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

  /**
   * Shooter-side hit detection: I detect my own beams hitting host-owned
   * targets and report damage events; the host applies them. Score is awarded
   * locally, with the destroy bonus predicted from the same damage formula
   * the host runs.
   */
  private detectMyHits(now: number): void {
    if (!this.spawned) return;
    for (const b of this.beams) {
      if (b.vanished || b.chain) continue; // ARC damage applied at cast
      for (const a of this.world.asteroids) {
        const hit = b.exploding
          ? dist2(b.head.x, b.head.y, a.x, a.y) <= b.explosionRadius * b.explosionRadius
          : segHitsCircle(b.tail.x, b.tail.y, b.head.x, b.head.y, a.x, a.y, a.radius);
        if (!hit) continue;
        if (b.hitIds.has(a.id)) continue;
        b.hitIds.add(a.id);
        this.onBeamHit(b);
        const destroyed =
          a.radius - ASTEROID_MAX_RADIUS * Math.min(b.weapon.power, 1) < ASTEROID_MIN_RADIUS;
        if (destroyed && !this.predictedKills.has(a.id)) {
          this.predictedKills.set(a.id, now);
          this.registerKill(SCORE.ASTEROID_DESTROY, now);
        } else {
          this.score += SCORE.ASTEROID_CHIP; // flat, never multiplied
        }
        this.fx.sparks(b.head.x, b.head.y, 6, b.weapon.tint, { lifeMin: 150, lifeMax: 250 });
        sfx.play("hit_spark", { gain: 0.4 });
        this.netSendEvent("asteroid_hit", { asteroidId: a.id, damage: b.weapon.power });
        if (!b.exploding) break; // AoE circle keeps testing every target
      }
      if (b.vanished) continue;
      for (const e of this.world.enemies) {
        const r = e.chargeUntil > now ? LANCER_CHARGE_HIT_RADIUS : ENEMY_SPECS[e.kind].hitRadius;
        const hit = b.exploding
          ? dist2(b.head.x, b.head.y, e.x, e.y) <= b.explosionRadius * b.explosionRadius
          : segHitsCircle(b.tail.x, b.tail.y, b.head.x, b.head.y, e.x, e.y, r);
        if (!hit) continue;
        if (b.hitIds.has(e.id)) continue;
        b.hitIds.add(e.id);
        this.onBeamHit(b);
        const dmg = b.weapon.power * 100;
        if (e.hp - dmg <= 0 && !this.predictedKills.has(e.id)) {
          this.predictedKills.set(e.id, now);
          this.registerKill(ENEMY_SPECS[e.kind].score, now);
        }
        e.blinkUntil = now + 150; // immediate local feedback; host echoes
        this.fx.sparks(b.head.x, b.head.y, 6, b.weapon.tint, { lifeMin: 150, lifeMax: 250 });
        sfx.play("hit_spark", { gain: 0.4 });
        this.netSendEvent("enemy_hit", { enemyId: e.id, damage: dmg });
        if (!b.exploding) break; // AoE circle keeps testing every target
      }
      if (b.vanished) continue;
      const u = this.world.ufo;
      if (u) {
        const hit = b.exploding
          ? dist2(b.head.x, b.head.y, u.x, u.y) <= b.explosionRadius * b.explosionRadius
          : segHitsCircle(b.tail.x, b.tail.y, b.head.x, b.head.y, u.x, u.y, UFO_RADIUS);
        if (hit && !b.hitIds.has(u.id)) {
          b.hitIds.add(u.id);
          this.onBeamHit(b);
          if (u.hp - b.weapon.power * 100 <= 0 && !this.predictedKills.has(u.id)) {
            this.predictedKills.set(u.id, now);
            this.registerKill(SCORE.UFO_DESTROY, now);
          }
          this.fx.sparks(b.head.x, b.head.y, 6, b.weapon.tint, { lifeMin: 150, lifeMax: 250 });
          sfx.play("hit_spark", { gain: 0.4 });
          this.netSendEvent("ufo_hit", { damage: b.weapon.power });
        }
      }
    }
    for (const [id, t] of this.predictedKills) {
      if (now - t > 5000) this.predictedKills.delete(id);
    }
  }

  // ---- shields + death (victim-side adjudication, §5.2) -----------------------------

  private ramArmed(): boolean {
    return this.shield?.kind === "ram" && Math.hypot(this.shipVX, this.shipVY) > RAM_ARM_SPEED;
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

  private shieldHitFx(now: number, impactX: number, impactY: number): void {
    const sh = this.shield;
    if (!sh) return;
    this.haloFlashUntil = now + 80;
    const ang = Math.atan2(impactY - this.shipY, impactX - this.shipX) / DEG;
    this.fx.sparks(impactX, impactY, 8, SHIELD_SPECS[sh.kind].tint, {
      angleMin: ang - 22.5,
      angleMax: ang + 22.5,
      lifeMin: 150,
      lifeMax: 250,
    });
    sfx.play("shield_hit");
    this.trauma.add(0.25);
  }

  private shieldBreakFx(now: number): void {
    const sh = this.shield;
    if (!sh) return;
    this.haloFlashUntil = now + 80;
    this.fx.ring(
      this.shipX,
      this.shipY,
      SHIELD_HALO_RADIUS,
      40,
      300,
      SHIELD_SPECS[sh.kind].tint,
      0.7,
    );
    sfx.play("shield_break");
    this.trauma.add(0.3);
  }

  /** Consume BARRIER charges; assumes the caller verified them. */
  private consumeBarrier(now: number, hits: number, impactX: number, impactY: number): void {
    const sh = this.shield;
    if (!sh || sh.kind !== "barrier") return;
    sh.charges -= hits;
    this.barrierNextRegenAt = now + BARRIER_REGEN_DELAY_MS;
    this.shieldHitFx(now, impactX, impactY);
    if (sh.charges <= 0) this.shieldBreakFx(now);
  }

  /** PHASE: negate a lethal hit if ready. Returns true when it triggered. */
  private tryPhase(now: number): boolean {
    const sh = this.shield;
    if (!sh || sh.kind !== "phase" || now < this.phaseReadyAt) return false;
    sh.phased = true;
    this.phasedUntil = now + PHASE_DURATION_MS;
    this.phaseReadyAt = now + PHASE_COOLDOWN_MS;
    this.shieldBreakFx(now);
    return true;
  }

  /** BARRIER regen + PHASE intangibility expiry. */
  private tickShield(now: number): void {
    const sh = this.shield;
    if (!sh) return;
    if (
      sh.kind === "barrier" &&
      sh.charges < BARRIER_MAX_CHARGES &&
      now >= this.barrierNextRegenAt
    ) {
      sh.charges += 1;
      this.barrierNextRegenAt = now + BARRIER_REGEN_INTERVAL_MS;
      this.haloFlashUntil = now + 80;
    }
    if (sh.kind === "phase" && sh.phased && now >= this.phasedUntil) sh.phased = false;
  }

  /** Locally remove an enemy shot + tell the host (it owns the array). */
  private consumeShot(shot: EnemyShotState): void {
    const idx = this.world.enemyShots.findIndex((s) => s.id === shot.id);
    if (idx !== -1) this.world.enemyShots.splice(idx, 1);
    this.recentConsumedShots.set(shot.id, Date.now());
    if (this.amHost) this.dirty.enemyShots = true;
    this.netSendEvent("proj_consumed", { shotId: shot.id });
  }

  /** REFLECT return shot: NORMAL-stat beam along the reversed incoming vector. */
  private fireReflectBeam(angle: number, now: number): void {
    const weapon: Weapon = { ...WEAPON_DEFAULT, tint: SHIELD_SPECS.reflect.tint };
    this.beams.push(this.makeBeam({ x: this.shipX, y: this.shipY }, angle, weapon, now));
  }

  /**
   * Victim-side death detection with the shield interaction matrix (§5.2):
   * asteroids and hulls kill on contact with the ship CENTER (generous);
   * shots/beams kill within the ship radius. The victim reports its own killer
   * and adjudicates its own shield.
   */
  private detectMyDeath(now: number, dt: number): void {
    if (!this.alive || !this.spawned) return;
    if (now < this.phasedUntil) return; // intangible: no collisions either way
    if (now < this.invulnUntil) return;
    const sh = this.shield;

    // -- asteroid contact
    for (const a of this.world.asteroids) {
      if (dist2(a.x, a.y, this.shipX, this.shipY) > a.radius * a.radius) continue;
      const imm = this.ramImmunity.get(a.id);
      if (imm !== undefined && now < imm) continue;
      if (this.ramArmed()) {
        // RAM stops matter: small rocks die, big rocks chip + bounce.
        if (a.radius <= RAM_ASTEROID_DESTROY_R) {
          if (!this.predictedKills.has(a.id)) {
            this.predictedKills.set(a.id, now);
            this.registerKill(SCORE.ASTEROID_DESTROY, now);
          }
          this.netSendEvent("asteroid_hit", { asteroidId: a.id, damage: 1 });
          this.fx.sparks(a.x, a.y, 8, SHIELD_SPECS.ram.tint, { lifeMin: 150, lifeMax: 250 });
          sfx.play("hit_spark");
          this.trauma.add(0.1);
        } else {
          this.score += SCORE.ASTEROID_CHIP;
          this.netSendEvent("asteroid_hit", { asteroidId: a.id, damage: RAM_ASTEROID_CHIP });
          this.bounceOff(a.x, a.y, 0.6);
          this.shieldHitFx(now, a.x, a.y);
        }
        this.ramImmunity.set(a.id, now + RAM_IMMUNITY_MS);
        continue;
      }
      if (sh?.kind === "barrier") {
        if (now < this.contactIframeUntil) continue;
        if (sh.charges >= 1) {
          this.consumeBarrier(now, 1, a.x, a.y);
          this.bounceOff(a.x, a.y, 0.5);
          this.contactIframeUntil = now + 400;
          continue;
        }
      }
      if (this.tryPhase(now)) return;
      this.die(now, null, "ASTEROID");
      return;
    }
    if (!this.alive) return;

    // -- enemy hull contact + LANCER charge
    for (const e of this.world.enemies) {
      if (e.graceUntil > now) continue; // flashing in: can't kill
      const charging = e.kind === "lancer" && e.chargeUntil > now;
      const r = charging ? LANCER_CHARGE_HIT_RADIUS : ENEMY_SPECS[e.kind].hitRadius;
      if (dist2(e.x, e.y, this.shipX, this.shipY) > r * r) continue;
      const imm = this.ramImmunity.get(e.id);
      if (imm !== undefined && now < imm) continue;
      let nx = e.x - this.shipX;
      let ny = e.y - this.shipY;
      const nlen = Math.hypot(nx, ny) || 1;
      nx /= nlen;
      ny /= nlen;
      if (this.ramArmed()) {
        // Armed RAM beats hull contact AND a mid-charge lancer.
        if (e.hp - RAM_DAMAGE <= 0 && !this.predictedKills.has(e.id)) {
          this.predictedKills.set(e.id, now);
          this.registerKill(ENEMY_SPECS[e.kind].score, now);
        }
        this.netSendEvent("enemy_hit", {
          enemyId: e.id,
          damage: RAM_DAMAGE,
          kx: nx * RAM_KNOCKBACK,
          ky: ny * RAM_KNOCKBACK,
        });
        e.blinkUntil = now + 150;
        this.ramImmunity.set(e.id, now + RAM_IMMUNITY_MS);
        this.shieldHitFx(now, e.x, e.y);
        if (charging) {
          this.bounceOff(e.x, e.y, 0.6);
          this.trauma.add(0.3);
        }
        continue;
      }
      if (sh?.kind === "barrier") {
        if (now < this.contactIframeUntil) continue;
        const cost = charging ? 2 : 1; // a charge rips 2 charges (or kills at 1)
        if (sh.charges >= cost) {
          this.consumeBarrier(now, cost, e.x, e.y);
          this.bounceOff(e.x, e.y, 0.5);
          // knock both back
          this.netSendEvent("enemy_hit", {
            enemyId: e.id,
            damage: 0,
            kx: nx * RAM_KNOCKBACK * 0.5,
            ky: ny * RAM_KNOCKBACK * 0.5,
          });
          this.contactIframeUntil = now + 400;
          continue;
        }
      }
      if (this.tryPhase(now)) return;
      this.die(now, null, ENEMY_SPECS[e.kind].name);
      return;
    }
    if (!this.alive) return;

    // -- enemy projectiles (host-owned; I detect my own hit, mirror of PvP
    // beams). Reverse index loop: consumeShot splices mid-iteration.
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
      if (sh?.kind === "barrier" && sh.charges >= 1) {
        this.consumeBarrier(now, 1, s.x, s.y);
        this.consumeShot(s);
        continue;
      }
      if (sh?.kind === "reflect" && now >= this.reflectReadyAt) {
        this.reflectReadyAt = now + REFLECT_COOLDOWN_MS;
        this.fireReflectBeam(Math.atan2(-s.vy, -s.vx), now);
        this.shieldHitFx(now, s.x, s.y);
        this.consumeShot(s);
        continue;
      }
      if (this.tryPhase(now)) {
        this.consumeShot(s);
        return;
      }
      this.consumeShot(s); // a death also kills the shot — same event
      // Shots aren't source-attributed on the wire; speed identifies the kind.
      this.die(
        now,
        null,
        Math.hypot(s.vx, s.vy) <= (DRONE_SHOT_SPEED + WASP_SHOT_SPEED) / 2 ? "DRONE" : "WASP",
      );
      return;
    }
    if (!this.alive) return;

    // -- UFO contact (treated as a hull)
    const u = this.world.ufo;
    if (u && dist2(u.x, u.y, this.shipX, this.shipY) <= UFO_RADIUS * UFO_RADIUS) {
      const imm = this.ramImmunity.get(u.id);
      if (imm === undefined || now >= imm) {
        if (this.ramArmed()) {
          if (u.hp - RAM_DAMAGE <= 0 && !this.predictedKills.has(u.id)) {
            this.predictedKills.set(u.id, now);
            this.registerKill(SCORE.UFO_DESTROY, now);
          }
          this.netSendEvent("ufo_hit", { damage: RAM_DAMAGE / 100 });
          this.ramImmunity.set(u.id, now + RAM_IMMUNITY_MS);
          this.shieldHitFx(now, u.x, u.y);
        } else if (sh?.kind === "barrier" && now >= this.contactIframeUntil && sh.charges >= 1) {
          this.consumeBarrier(now, 1, u.x, u.y);
          this.bounceOff(u.x, u.y, 0.5);
          this.contactIframeUntil = now + 400;
        } else if (sh?.kind === "barrier" && now < this.contactIframeUntil) {
          // just bounced — skip
        } else if (this.tryPhase(now)) {
          return;
        } else {
          this.die(now, null, "UFO");
          return;
        }
      }
    }

    // -- other players' beams (incl. ARC chains + explosions)
    if (now < this.pvpIframeUntil) return;
    const myId = this.myId;
    for (const [id, player] of Object.entries(this.peers)) {
      if (id === myId) continue;
      const st = readNetState(player);
      if (!st || !st.alive) continue;
      for (const sb of st.beams) {
        let hit = false;
        if (sb.chain && sb.chain.length >= 2) {
          for (let i = 0; i < sb.chain.length - 1 && !hit; i++) {
            const p0 = sb.chain[i];
            const p1 = sb.chain[i + 1];
            if (p0 && p1) {
              hit = segHitsCircle(p0.x, p0.y, p1.x, p1.y, this.shipX, this.shipY, SHIP_RADIUS);
            }
          }
        } else if (sb.exploding) {
          hit =
            dist2(sb.hx, sb.hy, this.shipX, this.shipY) <= sb.explosionRadius * sb.explosionRadius;
        } else {
          hit = segHitsCircle(sb.tx, sb.ty, sb.hx, sb.hy, this.shipX, this.shipY, SHIP_RADIUS);
        }
        if (!hit) continue;
        if (sh?.kind === "barrier" && sh.charges >= 1) {
          // The incoming beam keeps rendering (can't mutate the shooter's
          // state) — i-frames stop it draining a second charge. Return: the
          // i-frames must also cover the REST of this frame's beams (a
          // SCATTER volley is 6 serialized beams in one snapshot).
          this.consumeBarrier(now, 1, sb.hx, sb.hy);
          this.pvpIframeUntil = now + REFLECT_PVP_IFRAME_MS;
          return;
        }
        if (sh?.kind === "reflect") {
          if (sb.exploding) {
            // Explosion AoE: consumed, no reflect.
            this.shieldHitFx(now, sb.hx, sb.hy);
            this.pvpIframeUntil = now + REFLECT_PVP_IFRAME_MS;
            return;
          }
          if (now >= this.reflectReadyAt) {
            this.reflectReadyAt = now + REFLECT_COOLDOWN_MS;
            this.pvpIframeUntil = now + REFLECT_PVP_IFRAME_MS;
            this.fireReflectBeam(Math.atan2(sb.ty - sb.hy, sb.tx - sb.hx), now);
            this.shieldHitFx(now, sb.hx, sb.hy);
            return;
          }
          // inside cooldown → falls through to death
        }
        if (this.tryPhase(now)) return;
        this.die(now, id, "PLAYER");
        return;
      }
    }
  }

  private die(now: number, killerId: string | null, cause: string): void {
    this.splinterBurst(this.shipX, this.shipY, 50, 30, now);
    this.fx.shatter(this.shipX, this.shipY, shipHullPoints(), this.shipAngle, this.myTint());
    this.fx.ring(this.shipX, this.shipY, 10, 90, 400, 0xffffff, 0.7);
    this.screenFlash();
    this.trauma.add(0.55);
    sfx.play("player_death");
    this.alive = false;
    this.respawnAt = now + RESPAWN_DELAY_MS;
    this.invulnUntil = 0;
    this.beams = [];
    // Death drops: weapon reverts, shield lost, combo resets, score kept.
    this.weapon = WEAPON_DEFAULT;
    this.weaponUntil = 0;
    this.shield = null;
    this.phasedUntil = 0;
    this.streak = 0;
    this.comboTier = 1;
    this.sessionBest = Math.max(this.sessionBest, this.score);
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
        this.weapon = weapon;
        this.weaponUntil = now + SPECIAL_WEAPON_DURATION_MS; // replace resets the timer
        this.fx.sparks(this.shipX, this.shipY, 14, weapon.tint, {
          speedMin: 30,
          speedMax: 140,
          lifeMin: 200,
          lifeMax: 420,
        });
        sfx.play("pickup");
      } else {
        const kind = SHIELD_KINDS[it.shieldIdx] ?? "barrier";
        this.shield = {
          kind,
          charges: kind === "barrier" ? BARRIER_MAX_CHARGES : 1,
          phased: false,
        };
        this.barrierNextRegenAt = 0;
        this.reflectReadyAt = 0;
        this.phaseReadyAt = 0;
        this.haloFlashUntil = now + 200;
        this.fx.sparks(this.shipX, this.shipY, 14, SHIELD_SPECS[kind].tint, {
          speedMin: 30,
          speedMax: 140,
          lifeMin: 200,
          lifeMax: 420,
        });
        sfx.play("pickup_shield");
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
  }

  private netSend(delta: number, now: number): void {
    this.netAcc += delta;
    if (this.netAcc < NET_INTERVAL_MS) return;
    this.netAcc = 0;
    this.pushMyState(now);
  }

  /** Wire shape of my shield: charges encode readiness for non-barrier kinds. */
  private shieldNetState(now: number): ShieldNetState | null {
    const sh = this.shield;
    if (!sh) return null;
    let charges = 1;
    if (sh.kind === "barrier") charges = sh.charges;
    else if (sh.kind === "reflect") charges = now >= this.reflectReadyAt ? 1 : 0;
    else if (sh.kind === "ram") charges = this.ramArmed() ? 1 : 0;
    else charges = now >= this.phaseReadyAt ? 1 : 0;
    return { kind: sh.kind, charges, phased: now < this.phasedUntil };
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
      invuln: now < this.invulnUntil,
      score: this.score,
      streak: this.streak,
      weaponName: this.weapon.name,
      shield: this.shieldNetState(now),
      beams: this.beams.filter((b) => !b.vanished && !b.fizzle).map(serializeBeam),
    };
    if (!this.offline) this.client.updateMyState(state);
  }

  // ---- connection callbacks ----------------------------------------------------

  private handleEvent(event: string, payload: unknown, _from: string): void {
    const p = asRecord(payload);
    if (event === "player_killed") {
      // The killer awards itself: every client hears the victim's report.
      if (p && p["killerId"] === this.myId) {
        this.registerKill(SCORE.PLAYER_KILL, Date.now());
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
    if (this.offline) {
      // Solo arena: seed the local world directly, nothing to broadcast.
      if (!this.offlineSeeded) {
        this.offlineSeeded = true;
        const seeded = emptyShared();
        for (let i = 0; i < ASTEROID_SEED_COUNT; i++) seeded.asteroids.push(spawnAsteroidState());
        this.world = seeded;
      }
      return;
    }
    if (this.amHost && this.client.connectionStatus === "connected" && !this.shared()) {
      const seeded = emptyShared();
      for (let i = 0; i < ASTEROID_SEED_COUNT; i++) seeded.asteroids.push(spawnAsteroidState());
      this.world = seeded;
      this.client.updateSharedState(seeded as unknown as Record<string, unknown>);
    }
  }

  /** Guest-side: adopt the host's 20Hz snapshot into the local working copy. */
  private reconcileFromShared(): void {
    const s = this.shared();
    if (!s) return;
    const w = this.world;
    if (typeof s.arenaEpoch === "number") w.arenaEpoch = s.arenaEpoch;

    const asteroidIds = new Set<string>();
    for (const a of s.asteroids) {
      asteroidIds.add(a.id);
      const local = w.asteroids.find((x) => x.id === a.id);
      if (!local) {
        w.asteroids.push(cloneAsteroid(a));
        continue;
      }
      local.radius = a.radius;
      local.verts = a.verts;
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

    const itemIds = new Set<string>();
    for (const it of s.items ?? []) {
      itemIds.add(it.id);
      if (this.recentPickups.has(it.id)) continue; // picked locally, host lagging
      const local = w.items.find((x) => x.id === it.id);
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

    const enemyIds = new Set<string>();
    for (const e of s.enemies ?? []) {
      enemyIds.add(e.id);
      const local = w.enemies.find((x) => x.id === e.id);
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
      blendPos(local, e.x, e.y);
    }
    w.enemies = w.enemies.filter((x) => enemyIds.has(x.id));

    const shotIds = new Set<string>();
    for (const sh of s.enemyShots ?? []) {
      shotIds.add(sh.id);
      if (this.recentConsumedShots.has(sh.id)) continue; // consumed locally, host lagging
      const local = w.enemyShots.find((x) => x.id === sh.id);
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
    for (const e of this.world.enemies) {
      e.x = Phaser.Math.Clamp(e.x + e.vx * dt, -40, WORLD_W + 40);
      e.y = Phaser.Math.Clamp(e.y + e.vy * dt, -40, WORLD_H + 40);
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
    }
    const w = this.world;
    const d = this.dirty;
    const tSec = Math.max(0, (now - w.arenaEpoch) / 1000);
    const intensity = arenaIntensity(tSec);
    const pressure = playerPressure(Math.max(1, Object.keys(this.peers).length));

    if (
      w.asteroids.length < asteroidCap(intensity, pressure) &&
      now - this.lastAsteroidSpawnAt > asteroidSpawnIntervalMs(intensity)
    ) {
      w.asteroids.push(spawnAsteroidState());
      this.lastAsteroidSpawnAt = now;
      d.asteroids = true;
    }

    const kept = w.asteroids.filter((a) => inWorld(a.x, a.y, ASTEROID_CULL_MARGIN));
    if (kept.length !== w.asteroids.length) {
      w.asteroids = kept;
      d.asteroids = true;
    }

    // UFO is the weapon piñata: only one weapon power-up in flight at a time.
    const weaponItemsInFlight = w.items.some((it) => it.kind === "weapon");
    if (!w.ufo && !weaponItemsInFlight && Math.random() < UFO_SPAWN_RATE * dt) {
      w.ufo = spawnUfoState();
      d.ufo = true;
    }
    if (w.ufo && w.ufo.x === w.ufo.destX && w.ufo.y === w.ufo.destY) {
      w.ufo.destX = Math.random() * WORLD_W;
      w.ufo.destY = Math.random() * WORLD_H;
      d.ufo = true;
    }

    const liveItems = w.items.filter((it) => it.diesAt > now);
    if (liveItems.length !== w.items.length) {
      w.items = liveItems;
      d.items = true;
    }

    this.hostSpawnEnemies(now, tSec, intensity, pressure);
    this.hostSimEnemies(now, dt);
    this.hostDespawnBreather(now, intensity, pressure);

    const liveShots = w.enemyShots.filter((s) => s.diesAt > now && inWorld(s.x, s.y, 60));
    if (liveShots.length !== w.enemyShots.length) {
      w.enemyShots = liveShots;
      d.enemyShots = true;
    }

    // Continuous motion dirties whatever is actually moving.
    if (w.asteroids.length > 0) d.asteroids = true;
    if (w.ufo) d.ufo = true;
    if (w.items.length > 0) d.items = true;
    if (w.enemies.length > 0) d.enemies = true;
    if (w.enemyShots.length > 0) d.enemyShots = true;

    this.shareAcc += delta;
    if (this.shareAcc < NET_INTERVAL_MS) return;
    this.shareAcc = 0;
    const patch: Record<string, unknown> = {};
    if (d.asteroids) patch["asteroids"] = w.asteroids;
    if (d.ufo) patch["ufo"] = w.ufo;
    if (d.items) patch["items"] = w.items;
    if (d.enemies) patch["enemies"] = w.enemies;
    if (d.enemyShots) patch["enemyShots"] = w.enemyShots;
    if (!this.offline && Object.keys(patch).length > 0) this.client.updateSharedState(patch);
    this.dirty = { asteroids: false, ufo: false, items: false, enemies: false, enemyShots: false };
  }

  /** Living player positions (mine locally + remotes from net state). */
  private livingPlayers(): Vec[] {
    const out: Vec[] = [];
    if (this.alive && this.spawned && Date.now() >= this.phasedUntil) {
      out.push({ x: this.shipX, y: this.shipY });
    }
    const myId = this.myId;
    for (const [id, player] of Object.entries(this.peers)) {
      if (id === myId) continue;
      const st = readNetState(player);
      if (st && st.alive && !st.shield?.phased) out.push({ x: st.x, y: st.y });
    }
    return out;
  }

  private hostSpawnEnemies(now: number, tSec: number, intensity: number, pressure: number): void {
    if (tSec * 1000 < ARENA_SAFE_MS) return; // safe opening
    if (now < this.debutSuppressUntil) return;
    const w = this.world;
    if (w.enemies.length >= enemyCap(intensity, pressure)) return;
    if (now - this.lastEnemySpawnAt < enemySpawnIntervalMs(intensity)) return;
    const avail = ENEMY_KINDS.filter((k) => enemySpawnWeight(k, intensity) > 0);
    if (avail.length === 0) return;
    // Debut rule: a type's first appearance is solo + suppresses other spawns.
    let kind = avail.find((k) => !this.debuted.has(k)) ?? null;
    const isDebut = kind !== null;
    if (!kind) kind = weightedEnemyRoll(avail, intensity);
    if (!kind) return;
    const players = this.livingPlayers();
    let placed: { x: number; y: number; ang: number } | null = null;
    for (let i = 0; i < 5 && !placed; i++) {
      const c = edgeSpawn(30);
      const clear = players.every((p) => Math.hypot(p.x - c.x, p.y - c.y) >= ENEMY_SPAWN_CLEARANCE);
      if (clear) placed = c;
    }
    if (!placed) return; // skip this tick
    const e = spawnEnemyState(kind, placed.x, placed.y);
    e.angle = placed.ang;
    w.enemies.push(e);
    this.lastEnemySpawnAt = now;
    this.dirty.enemies = true;
    if (isDebut) {
      this.debuted.add(kind);
      this.debutSuppressUntil = now + ENEMY_DEBUT_SUPPRESS_MS;
    }
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
        orbitDir: Math.random() < 0.5 ? 1 : -1,
        wobblePhase: Math.random() * Math.PI * 2,
        kbVx: 0,
        kbVy: 0,
      };
      this.enemySim.set(id, sim);
    }
    return sim;
  }

  private hostSpawnShot(x: number, y: number, angle: number, speed: number, now: number): void {
    this.world.enemyShots.push({
      id: crypto.randomUUID(),
      x,
      y,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      diesAt: now + ENEMY_SHOT_TTL_MS,
    });
    this.dirty.enemyShots = true;
  }

  /** Host AI: steering, telegraphs and firing for every enemy (§6.1). */
  private hostSimEnemies(now: number, dt: number): void {
    const players = this.livingPlayers();
    for (const e of this.world.enemies) {
      const sim = this.simFor(e.id);
      // Knockback decays independently of steering (≈ gone in a second).
      const kbDecay = Math.exp(-4 * dt);
      sim.kbVx *= kbDecay;
      sim.kbVy *= kbDecay;
      const target = nearestOf(players, e.x, e.y);
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
                e.x >= WORLD_W ||
                e.y <= 0 ||
                e.y >= WORLD_H
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
      }
      // Steering set vx/vy absolutely — ride the decaying knockback on top.
      if (e.kind !== "lancer") {
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
  private hostDespawnBreather(now: number, intensity: number, pressure: number): void {
    const w = this.world;
    if (w.enemies.length <= enemyCap(intensity, pressure) + ENEMY_DESPAWN_SLACK) return;
    if (now - this.lastBreatherDespawnAt < ENEMY_DESPAWN_INTERVAL_MS) return;
    const players = this.livingPlayers();
    let farIdx = -1;
    let farDist = -1;
    for (let i = 0; i < w.enemies.length; i++) {
      const e = w.enemies[i];
      if (!e) continue;
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
    const newRadius = a.radius - ASTEROID_MAX_RADIUS * Math.min(damage, 1);
    if (newRadius < ASTEROID_MIN_RADIUS) {
      w.asteroids.splice(idx, 1); // display sweep bursts it
    } else {
      // Scale the existing outline instead of re-rolling it — no shape pop.
      const ratio = newRadius / a.radius;
      a.verts = a.verts.map((v) => ({ x: v.x * ratio, y: v.y * ratio }));
      a.radius = newRadius;
      const ang = Math.atan2(a.vy, a.vx) + (Math.random() * 60 - 30) * DEG;
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
    u.blinkUntil = Date.now() + UFO_BLINK_MS;
    if (u.hp <= 0) {
      this.world.items.push(spawnWeaponItemState(u.x, u.y));
      this.world.ufo = null;
      this.dirty.items = true;
    }
    this.dirty.ufo = true;
  }

  /** Apply reported damage + knockback; kill (split, loot) at ≤0 HP. */
  private hostDamageEnemy(id: string, damageHp: number, kx: number, ky: number): void {
    const w = this.world;
    const idx = w.enemies.findIndex((e) => e.id === id);
    if (idx === -1) return;
    const e = w.enemies[idx];
    if (!e) return;
    e.hp -= damageHp;
    // LANCER's phases persist vx/vy, so direct knockback works; the others get
    // steering-overwritten every sim tick, so the impulse lives in the sim.
    if (e.kind === "lancer") {
      e.vx += kx;
      e.vy += ky;
    } else {
      const sim = this.simFor(e.id);
      sim.kbVx += kx;
      sim.kbVy += ky;
    }
    e.blinkUntil = Date.now() + UFO_BLINK_MS;
    if (e.hp <= 0) this.hostKillEnemy(idx);
    this.dirty.enemies = true;
  }

  private hostKillEnemy(idx: number): void {
    const w = this.world;
    const e = w.enemies[idx];
    if (!e) return;
    w.enemies.splice(idx, 1);
    this.enemySim.delete(e.id);
    const now = Date.now();
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
    if (e.kind !== "drone") {
      // WASP/LANCER/SPLITTER kills roll the shield table (+pity).
      this.shieldPity += 1;
      const drop = rollShieldDrop(this.shieldPity >= SHIELD_PITY_KILLS);
      if (drop) {
        this.shieldPity = 0;
        w.items.push(spawnShieldItemState(e.x, e.y, SHIELD_KINDS.indexOf(drop)));
        this.dirty.items = true;
      }
    }
    this.dirty.enemies = true;
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
    const trailFreq = this.fx.aliveParticles() > PARTICLE_SOFT_BUDGET ? 50 : 25;
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
        rec = { gfx: this.makeShipGfx(tint), tint, alive: true, seenState: false, trail };
        this.ships.set(id, rec);
      }
      if (rec.trail && rec.trail.frequency !== trailFreq) rec.trail.setFrequency(trailFreq);
      if (id === myId) {
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
        const sh = this.shieldNetState(now);
        if (sh && this.alive && this.spawned) {
          this.drawHalo(this.shipX, this.shipY, this.shipAngle, sh, now, now < this.haloFlashUntil);
        }
        continue;
      }
      const st = readNetState(player);
      if (!st) {
        rec.gfx.setVisible(false);
        if (rec.trail) rec.trail.emitting = false;
        continue;
      }
      if (!rec.seenState) {
        // First snapshot: snap into place (no glide from the origin) and adopt
        // alive as-is (no death FX for players who were already dead).
        rec.seenState = true;
        rec.alive = st.alive;
        rec.gfx.setPosition(st.x, st.y);
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
          st.shield?.phased ? 0.25 : st.invuln ? blinkAlpha(now) : 1, // networked invuln/phase
        );
        if (st.shield) this.drawHalo(rec.gfx.x, rec.gfx.y, st.angle, st.shield, now, false);
      }
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

  /** Wireframe shield halo (1px stroke on the additive layer). */
  private drawHalo(
    x: number,
    y: number,
    angle: number,
    sh: ShieldNetState,
    now: number,
    flash: boolean,
  ): void {
    const g = this.haloGfx;
    const tint = SHIELD_SPECS[sh.kind].tint;
    switch (sh.kind) {
      case "barrier": {
        if (sh.charges <= 0 && !flash) return;
        const alpha = flash ? 1 : sh.charges >= 2 ? 0.7 : 0.35;
        g.lineStyle(1, tint, alpha);
        strokeRegularPolygon(g, x, y, SHIELD_HALO_RADIUS, 6, 0);
        return;
      }
      case "reflect": {
        const alpha = flash ? 1 : sh.charges > 0 ? 0.7 : 0.3;
        g.lineStyle(1, tint, alpha);
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
        const alpha = flash ? 1 : sh.charges > 0 ? 0.9 : 0.35; // bright when armed
        g.lineStyle(1, tint, alpha);
        g.beginPath();
        g.arc(x, y, SHIELD_HALO_RADIUS, angle - Math.PI / 4, angle + Math.PI / 4);
        g.strokePath();
        return;
      }
      case "phase": {
        const alpha = sh.phased ? 0.25 : flash ? 1 : sh.charges > 0 ? 0.6 : 0.2;
        g.lineStyle(1, tint, alpha);
        const rot = (now / 1000) * 45 * DEG;
        for (let i = 0; i < 8; i++) {
          const a0 = rot + (Math.PI * 2 * i) / 8;
          g.beginPath();
          g.arc(x, y, 13, a0, a0 + ((Math.PI * 2) / 8) * 0.55);
          g.strokePath();
        }
        return;
      }
    }
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
        drawPoly(rec.gfx, a.verts);
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
      const hidden = now < e.blinkUntil && Math.floor(now / 66) % 4 === 0;
      rec.gfx.setVisible(!hidden);
      rec.gfx.setAlpha(e.graceUntil > now ? 0.25 + 0.45 * (Math.sin(now / 40) * 0.5 + 0.5) : 1);
      // Telegraph audio: LANCER windup + WASP burst, on-screen only (§6.1).
      if (e.telegraphUntil > now && rec.lastTelegraphUntil !== e.telegraphUntil) {
        rec.lastTelegraphUntil = e.telegraphUntil;
        if ((e.kind === "lancer" || e.kind === "wasp") && this.onScreen(e.x, e.y)) {
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
      if (rec.kind === "lancer" || rec.kind === "splitter") {
        this.fx.ring(x, y, 6, 60, 350, spec.tint, 0.8);
      }
      if (this.onScreen(x, y)) {
        sfx.play("enemy_death", big ? { gain: 1.3, rate: 0.8 } : {});
        this.trauma.add(big ? 0.18 : 0.1);
      }
      rec.gfx.destroy();
      this.enemyObjs.delete(id);
    }
  }

  /** Per-frame telegraph overlays (additive layer, redrawn every frame). */
  private drawEnemyTelegraphs(now: number): void {
    const g = this.telegraphGfx;
    g.clear();
    for (const e of this.world.enemies) {
      if (e.telegraphUntil <= now) continue;
      if (e.kind === "drone") {
        // Nose dot grows 1→4px across the windup.
        const p = 1 - (e.telegraphUntil - now) / DRONE_TELEGRAPH_MS;
        g.fillStyle(ENEMY_SPECS.drone.tint, 0.9);
        g.fillCircle(e.x + Math.cos(e.angle) * 8, e.y + Math.sin(e.angle) * 8, 1 + 3 * p);
      } else if (e.kind === "wasp") {
        // Wings flash white at 12Hz.
        if (Math.floor(now / 42) % 2 === 0) {
          g.lineStyle(1, 0xffffff, 0.9);
          strokeTransformed(g, enemyHullPoints("wasp"), e.x, e.y, e.angle);
        }
      } else if (e.kind === "lancer") {
        // Hull strobes at 8Hz + dashed line along the LOCKED charge vector.
        if (Math.floor(now / 62) % 2 === 0) {
          g.lineStyle(1, 0xffffff, 0.95);
          strokeTransformed(g, enemyHullPoints("lancer"), e.x, e.y, e.angle);
        }
        g.lineStyle(1, ENEMY_SPECS.lancer.tint, 0.7);
        dashedLine(g, e.x, e.y, e.angle, LANCER_CHARGE_RANGE, 8, 6);
      }
    }
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
      if (sb.exploding) {
        g.lineStyle(1, sb.tint, 1).strokeCircle(sb.hx, sb.hy, sb.explosionRadius);
      } else {
        g.lineStyle(sb.width, sb.tint, 1).lineBetween(sb.tx, sb.ty, sb.hx, sb.hy);
      }
    };
    for (const b of this.beams) {
      if (b.vanished) continue;
      if (b.glaive) {
        // Spinning open triangle (remotes draw it via the serialized flag).
        g.lineStyle(2, b.weapon.tint, 1);
        strokeTransformed(g, GLAIVE_TRI, b.head.x, b.head.y, b.spin);
        continue;
      }
      draw(serializeBeam(b));
    }
    for (const [id, player] of Object.entries(this.peers)) {
      if (id === myId) continue;
      const st = readNetState(player);
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
    this.cameras.main.setAngle(s.rotDeg);
  }

  // ---- display-object factories ---------------------------------------------------------

  private makeShipGfx(tint: number): Phaser.GameObjects.Graphics {
    const g = this.add.graphics().setDepth(10);
    g.lineStyle(1, tint, 1);
    strokeClosed(g, shipHullPoints());
    return g;
  }

  private makeUfoGfx(): Phaser.GameObjects.Graphics {
    const g = this.add.graphics().setDepth(6);
    g.lineStyle(1, 0xffffff, 1);
    strokeClosed(g, UFO_OUTLINE);
    const [, , p2, p3, , , p6, p7] = UFO_OUTLINE;
    if (p2 && p3 && p6 && p7) {
      g.lineBetween(p2.x, p2.y, p7.x, p7.y);
      g.lineBetween(p3.x, p3.y, p6.x, p6.y);
    }
    return g;
  }

  private makeEnemyGfx(kind: EnemyKind): Phaser.GameObjects.Graphics {
    const g = this.add.graphics().setDepth(7);
    g.lineStyle(1, ENEMY_SPECS[kind].tint, 1);
    const pts = enemyHullPoints(kind);
    strokeClosed(g, pts);
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

  /** Weapon = hexagon + spokes; shield = double hexagon + its halo glyph. */
  private makeItemGfx(it: ItemState): Phaser.GameObjects.Graphics {
    const g = this.add.graphics().setDepth(4);
    const tint = itemTint(it);
    g.lineStyle(1, tint, 1);
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
    const kind = SHIELD_KINDS[it.shieldIdx] ?? "barrier";
    // Self-describing glyph: the halo shape the pickup grants.
    if (kind === "barrier") {
      strokeRegularPolygon(g, 0, 0, 3, 6, 0);
    } else if (kind === "reflect") {
      strokeRegularPolygon(g, 0, 0, 3, 3, -Math.PI / 2);
    } else if (kind === "ram") {
      g.beginPath();
      g.arc(0, 0, 3, -Math.PI / 4, Math.PI / 4);
      g.strokePath();
    } else {
      for (let i = 0; i < 4; i++) {
        const a0 = (Math.PI * 2 * i) / 4;
        g.beginPath();
        g.arc(0, 0, 3, a0, a0 + ((Math.PI * 2) / 4) * 0.55);
        g.strokePath();
      }
    }
    return g;
  }

  // ---- minimap + HUD ---------------------------------------------------------------------

  private drawMinimap(): void {
    const g = this.minimapGfx;
    g.clear();
    const x0 = this.scale.width - MINIMAP_W - MINIMAP_PAD;
    const y0 = this.scale.height - MINIMAP_H - MINIMAP_PAD;
    g.fillStyle(0x000000, 0.6).fillRoundedRect(x0, y0, MINIMAP_W, MINIMAP_H, 4);
    g.lineStyle(1, 0xffffff, 0.15).strokeRoundedRect(x0, y0, MINIMAP_W, MINIMAP_H, 4);
    const sx = MINIMAP_W / WORLD_W;
    const sy = MINIMAP_H / WORLD_H;

    for (const a of this.world.asteroids) {
      if (!inWorld(a.x, a.y, 0)) continue; // no auto-clip on Graphics
      g.fillStyle(0xffffff, 0.3);
      g.fillCircle(x0 + a.x * sx, y0 + a.y * sy, Math.max(1, a.radius * sx * 0.3));
    }
    for (const e of this.world.enemies) {
      if (!inWorld(e.x, e.y, 0)) continue;
      g.fillStyle(ENEMY_SHOT_TINT, 1);
      g.fillRect(x0 + e.x * sx - 1, y0 + e.y * sy - 1, 2, 2);
    }
    for (const it of this.world.items) {
      if (!inWorld(it.x, it.y, 0)) continue;
      g.fillStyle(itemTint(it), 1);
      g.fillCircle(x0 + it.x * sx, y0 + it.y * sy, 1.5);
    }

    const myId = this.myId;
    for (const [id, player] of Object.entries(this.peers)) {
      const isMe = id === myId;
      const tint = this.ships.get(id)?.tint ?? 0xffffff;
      let px: number;
      let py: number;
      if (isMe) {
        if (!this.spawned || !this.alive) continue;
        px = this.shipX;
        py = this.shipY;
      } else {
        const st = readNetState(player);
        if (!st || !st.alive) continue; // each dot filtered by ITS player's alive state
        px = st.x;
        py = st.y;
      }
      g.fillStyle(tint, 1).fillCircle(x0 + px * sx, y0 + py * sy, isMe ? 3 : 2);
    }
  }

  private updateHud(now: number): void {
    setText(this.scoreEl, String(this.score));
    setText(this.weaponEl, this.weapon.name);
    if (this.weaponBarEl) {
      const frac =
        this.weapon === WEAPON_DEFAULT
          ? 0
          : Math.max(0, (this.weaponUntil - now) / SPECIAL_WEAPON_DURATION_MS);
      this.weaponBarEl.style.width = `${(frac * 100).toFixed(1)}%`;
      this.weaponBarEl.style.background = hexCss(this.weapon.tint);
    }
    if (this.shieldEl) {
      const sh = this.shield;
      if (!sh || !this.alive) {
        this.shieldEl.style.display = "none";
      } else {
        this.shieldEl.style.display = "block";
        this.shieldEl.style.color = hexCss(SHIELD_SPECS[sh.kind].tint);
        setText(this.shieldEl, shieldPillText(sh.kind, this.shieldNetState(now)));
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
      setText(this.replayEl, `BEST ${fmtScore(this.sessionBest)} — YOU ${fmtScore(this.score)}`);
    }
    const secs = dead ? Math.max(0, Math.ceil((this.respawnAt - now) / 1000)) : 0;
    setText(this.countdownEl, secs > 0 ? `Respawning in ${secs}...` : "");
  }

  // ---- dev hooks (headless driving for reviewers) ------------------------------------------

  private installDevHooks(): void {
    if (!import.meta.env.DEV) return;
    (window as unknown as { __astroid?: unknown }).__astroid = {
      scene: this,
      client: this.client,
      /** Host only: spawn an enemy near (or at) the given point. */
      spawnEnemy: (kind: EnemyKind, x?: number, y?: number): string | null => {
        if (!this.amHost) return null;
        const e = spawnEnemyState(kind, x ?? this.shipX + 320, y ?? this.shipY);
        this.world.enemies.push(e);
        this.dirty.enemies = true;
        return e.id;
      },
      grantShield: (raw: string): void => {
        // Normalize + validate: an invalid kind stored here would crash every
        // subsequent drawHalo frame.
        const lowered = raw.toLowerCase();
        const kind = (Object.keys(SHIELD_SPECS) as ShieldKind[]).find((k) => k === lowered);
        if (!kind) return;
        this.shield = {
          kind,
          charges: kind === "barrier" ? BARRIER_MAX_CHARGES : 1,
          phased: false,
        };
        this.barrierNextRegenAt = 0;
        this.reflectReadyAt = 0;
        this.phaseReadyAt = 0;
      },
      grantWeapon: (ref: number | string): void => {
        const weapon =
          typeof ref === "number"
            ? WEAPONS_SPECIAL[ref]
            : WEAPONS_SPECIAL.find((w) => w.name === ref);
        if (!weapon) return;
        this.weapon = weapon;
        this.weaponUntil = Date.now() + SPECIAL_WEAPON_DURATION_MS;
      },
      /** Fire one volley of the current weapon, no pointer needed. */
      fire: (): void => {
        this.fireWeapon(Date.now());
      },
      /** Host only: rewind/forward the intensity director. */
      setArenaEpoch: (epochMs: number): void => {
        if (!this.amHost) return;
        this.world.arenaEpoch = epochMs;
        this.client.updateSharedState({ arenaEpoch: epochMs });
      },
      intensity: (): number =>
        arenaIntensity(Math.max(0, (Date.now() - this.world.arenaEpoch) / 1000)),
      summary: (): Record<string, unknown> => ({
        alive: this.alive,
        score: this.score,
        streak: this.streak,
        weapon: this.weapon.name,
        shield: this.shield ? { ...this.shield } : null,
        enemies: this.world.enemies.map((e) => e.kind),
        enemyShots: this.world.enemyShots.length,
        asteroids: this.world.asteroids.length,
        items: this.world.items.length,
        beams: this.beams.length,
        isHost: this.amHost,
        intensity: arenaIntensity(Math.max(0, (Date.now() - this.world.arenaEpoch) / 1000)),
      }),
    };
  }
}

// ---- module helpers (pure) ----------------------------------------------------------------

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

function weaponSound(kind: WeaponSfx): { name: SfxName; gain: number } {
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

function shipHullPoints(): Array<{ x: number; y: number }> {
  return SHIP_HULL_DEG.map((deg) => {
    const r = deg === 180 ? SHIP_RADIUS / 2 : SHIP_RADIUS;
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
  };
  if (b.glaive) sb.glaive = true;
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
      beams.push(beam);
    }
  }
  const score = s["score"];
  const streak = s["streak"];
  const weaponName = s["weaponName"];
  const vx = s["vx"];
  const vy = s["vy"];
  let shield: ShieldNetState | null = null;
  const shRaw = asRecord(s["shield"]);
  if (shRaw) {
    const kind = shRaw["kind"];
    if (kind === "barrier" || kind === "reflect" || kind === "ram" || kind === "phase") {
      shield = {
        kind,
        charges: typeof shRaw["charges"] === "number" ? shRaw["charges"] : 0,
        phased: shRaw["phased"] === true,
      };
    }
  }
  return {
    x,
    y,
    angle,
    vx: typeof vx === "number" ? vx : 0,
    vy: typeof vy === "number" ? vy : 0,
    alive: s["alive"] !== false,
    invuln: s["invuln"] === true,
    score: typeof score === "number" ? score : 0,
    streak: typeof streak === "number" ? streak : 0,
    weaponName: typeof weaponName === "string" ? weaponName : "",
    shield,
    beams,
  };
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : null;
}

function cloneAsteroid(a: AsteroidState): AsteroidState {
  return { ...a, verts: a.verts.map((v) => ({ ...v })) };
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

function inWorld(x: number, y: number, margin: number): boolean {
  return x >= -margin && x <= WORLD_W + margin && y >= -margin && y <= WORLD_H + margin;
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
  let roll = Math.random() * total;
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
  return SHIELD_SPECS[SHIELD_KINDS[it.shieldIdx] ?? "barrier"].tint;
}

function hexCss(tint: number): string {
  return `#${tint.toString(16).padStart(6, "0")}`;
}

function fmtScore(v: number): string {
  return v.toLocaleString("en-US").replace(/,/g, " ");
}

function shieldPillText(kind: ShieldKind, net: ShieldNetState | null): string {
  const name = SHIELD_SPECS[kind].name;
  if (!net) return name;
  if (kind === "barrier") {
    const filled = Math.max(0, Math.min(BARRIER_MAX_CHARGES, net.charges));
    return `${name} ${"◆".repeat(filled)}${"◇".repeat(BARRIER_MAX_CHARGES - filled)}`;
  }
  if (kind === "phase") return `${name} ${net.charges > 0 ? "●" : "◌"}`;
  return `${name} ${net.charges > 0 ? "◆" : "◇"}`;
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
