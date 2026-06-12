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
  return Math.min(24, Math.round((5 + 9 * intensity) * pressure));
}

export function asteroidSpawnIntervalMs(intensity: number): number {
  return Math.min(4000, Math.max(350, 1800 / intensity));
}

export function enemyCap(intensity: number, pressure: number): number {
  return Math.min(16, Math.round((2 + 5 * intensity) * pressure));
}

export function enemySpawnIntervalMs(intensity: number): number {
  return Math.min(8000, Math.max(900, 2500 / intensity));
}

/** Host seeds this many asteroids at arena start (don't wait for the interval). */
export const ASTEROID_SEED_COUNT = 5;

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
  | "glaive";

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
    sfx: "scatter",
  },
  {
    name: "HOMING",
    power: 0.45,
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
    sfx: "glaive",
  },
];

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

// ---- shields (§5) -----------------------------------------------------------------

export type ShieldKind = "barrier" | "reflect" | "ram" | "phase";

/** Index order on the wire (`ItemState.shieldIdx`). */
export const SHIELD_KINDS: readonly ShieldKind[] = ["barrier", "reflect", "ram", "phase"];

export type ShieldSpec = { name: string; tint: number };

export const SHIELD_SPECS: Record<ShieldKind, ShieldSpec> = {
  barrier: { name: "BARRIER", tint: 0x7dd3fc },
  reflect: { name: "REFLECT", tint: 0xc084fc },
  ram: { name: "RAM", tint: 0xffb454 },
  phase: { name: "PHASE", tint: 0xe2e8f0 },
};

export const SHIELD_HALO_RADIUS = 14;
export const BARRIER_MAX_CHARGES = 2;
/** No damage for this long → start regenerating charges. */
export const BARRIER_REGEN_DELAY_MS = 5_000;
/** One charge regained per this interval once regenerating. */
export const BARRIER_REGEN_INTERVAL_MS = 3_000;
/** REFLECT consumes one incoming shot/beam per this cooldown. */
export const REFLECT_COOLDOWN_MS = 800;
/** Owner i-frames after reflecting a PvP beam (the beam keeps rendering). */
export const REFLECT_PVP_IFRAME_MS = 300;
/** RAM is armed above this speed. */
export const RAM_ARM_SPEED = 220;
/** HP damage dealt to enemies on armed contact. */
export const RAM_DAMAGE = 60;
/** Knockback applied to the rammed enemy, px/s. */
export const RAM_KNOCKBACK = 320;
/** Contact immunity vs the rammed enemy after a hit. */
export const RAM_IMMUNITY_MS = 400;
/** Asteroids at or under this radius are destroyed outright by an armed RAM. */
export const RAM_ASTEROID_DESTROY_R = 28;
/** Chip damage (power units) vs bigger asteroids. */
export const RAM_ASTEROID_CHIP = 0.35;
export const PHASE_DURATION_MS = 1_500;
export const PHASE_COOLDOWN_MS = 12_000;

/** Loot table for WASP/LANCER/SPLITTER kills (integer weights, sum 100). */
export const SHIELD_DROP_WEIGHTS: ReadonlyArray<{ kind: ShieldKind | null; weight: number }> = [
  { kind: null, weight: 70 },
  { kind: "barrier", weight: 12 },
  { kind: "ram", weight: 7 },
  { kind: "reflect", weight: 6 },
  { kind: "phase", weight: 5 },
];
/** After this many eligible kills with no drop, the next roll forces non-null. */
export const SHIELD_PITY_KILLS = 12;

/** Roll the shield table; pity renormalizes without the null entry. */
export function rollShieldDrop(forceNonNull: boolean): ShieldKind | null {
  const entries = forceNonNull
    ? SHIELD_DROP_WEIGHTS.filter((e) => e.kind !== null)
    : SHIELD_DROP_WEIGHTS;
  const total = entries.reduce((sum, e) => sum + e.weight, 0);
  let roll = Math.random() * total;
  for (const e of entries) {
    roll -= e.weight;
    if (roll <= 0) return e.kind;
  }
  return null;
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

export const ENEMY_SPECS: Record<EnemyKind, EnemySpec> = {
  drone: { name: "DRONE", tint: 0xff7a6b, hitRadius: 7, hp: 20, score: SCORE.DRONE },
  wasp: { name: "WASP", tint: 0xff4757, hitRadius: 8, hp: 40, score: SCORE.WASP },
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

export function enemySpawnWeight(kind: EnemyKind, intensity: number): number {
  switch (kind) {
    case "drone":
      return 10;
    case "wasp":
      return 12 * Math.max(0, intensity - 0.5);
    case "lancer":
      return 9 * Math.max(0, intensity - 0.9);
    case "splitter":
      return 7 * Math.max(0, intensity - 1.2);
  }
}

export const ENEMY_KINDS: readonly EnemyKind[] = ["drone", "wasp", "lancer", "splitter"];

/** Breather rule: once the live count exceeds the cap by this slack (splitter
 *  children bypass the cap), the host quietly despawns the enemy farthest from
 *  all living players — no loot, no score. */
export const ENEMY_DESPAWN_SLACK = 2;
/** Only despawn an enemy farther than this from EVERY living player. */
export const ENEMY_DESPAWN_MIN_DIST = 1200;
/** At most one breather despawn per this interval. */
export const ENEMY_DESPAWN_INTERVAL_MS = 2_000;

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

export type ItemState = {
  id: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** Host-clock expiry timestamp. */
  diesAt: number;
} & ({ kind: "weapon"; weaponIdx: number } | { kind: "shield"; shieldIdx: number });

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
};

export type ShieldNetState = { kind: ShieldKind; charges: number; phased: boolean };

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
  shield: ShieldNetState | null;
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

export function spawnWeaponItemState(x: number, y: number): ItemState {
  const ang = Math.random() * Math.PI * 2;
  return {
    id: crypto.randomUUID(),
    x,
    y,
    vx: Math.cos(ang) * ITEM_SPEED,
    vy: Math.sin(ang) * ITEM_SPEED,
    kind: "weapon",
    weaponIdx: Math.floor(Math.random() * WEAPONS_SPECIAL.length),
    diesAt: Date.now() + ITEM_LIFETIME_MS,
  };
}

export function spawnShieldItemState(x: number, y: number, shieldIdx: number): ItemState {
  const ang = Math.random() * Math.PI * 2;
  return {
    id: crypto.randomUUID(),
    x,
    y,
    vx: Math.cos(ang) * ITEM_SPEED,
    vy: Math.sin(ang) * ITEM_SPEED,
    kind: "shield",
    shieldIdx,
    diesAt: Date.now() + ITEM_LIFETIME_MS,
  };
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
