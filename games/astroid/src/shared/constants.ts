// ---- world -------------------------------------------------------------------

export const WORLD_W = 3840;
export const WORLD_H = 2160;

// All speeds are px/second (the legacy build used px/tick at 60Hz; ×60 here).

// ---- ship ---------------------------------------------------------------------

export const SHIP_RADIUS = 8;
export const SHIP_SPEED = 90;
/** Dart hull: 4 points at these angles, radius SHIP_RADIUS except the notched
 *  180° point at half radius. */
export const SHIP_HULL_DEG = [0, 140, 180, 220] as const;

export const RESPAWN_DELAY_MS = 5_000;
export const INVULNERABLE_MS = 2_000;
/** Invulnerability blink: alpha alternates 0.3/0.9 on this period. */
export const INVULN_BLINK_MS = 200;
/** Respawn keeps this far from the world edges. */
export const RESPAWN_EDGE_MARGIN = 300;

// ---- asteroids ----------------------------------------------------------------

export const ASTEROID_MAX_RADIUS = 80;
export const ASTEROID_MIN_RADIUS = 5;
export const ASTEROID_MAX_NUM = 5;
export const ASTEROID_SPAWN_INTERVAL_MS = 350;
export const ASTEROID_VERTEX_COUNT = 12;
export const ASTEROID_ROT_SPEED = 0.3; // rad/s
/** Removed once this far past the world edge. */
export const ASTEROID_CULL_MARGIN = ASTEROID_MAX_RADIUS + 20;

/** Size-inverse speed: slow giants (~15 px/s) to fast pebbles (~113 px/s). */
export function asteroidSpeed(radius: number): number {
  return ((1 - radius / ASTEROID_MAX_RADIUS) * 1.75 + 0.25) * 60;
}

// ---- UFO ----------------------------------------------------------------------

export const UFO_SPEED = 120;
/** Spawn probability per second (legacy 0.0035/tick × 60). */
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

// ---- scoring ------------------------------------------------------------------

export const SCORE = {
  ASTEROID_DAMAGE: 10,
  ASTEROID_DESTROY: 50,
  UFO_DAMAGE: 0,
  UFO_DESTROY: 300,
  PLAYER_KILL: 200,
} as const;

// ---- weapons ------------------------------------------------------------------

export type Weapon = {
  name: string;
  /** Damage fraction: asteroids lose ASTEROID_MAX_RADIUS×min(power,1) radius,
   *  the UFO loses power×100 HP. */
  power: number;
  speed: number; // px/s
  length: number; // px
  width: number; // px
  tint: number;
  intervalMs: number;
  /** Laser-style: beam survives hits and passes through targets. */
  through: boolean;
  /** On hit, becomes an expanding circle (growth px/s up to range px). */
  explosion: { range: number; growth: number } | null;
};

export const WEAPON_DEFAULT: Weapon = {
  name: "NORMAL BEAM",
  power: 0.3,
  speed: 180,
  length: 10,
  width: 1,
  tint: 0xffffff,
  intervalMs: 350,
  through: false,
  explosion: null,
};

export const WEAPONS_SPECIAL: Weapon[] = [
  {
    name: "TINY BEAM",
    power: 0.1,
    speed: 600,
    length: 5,
    width: 1,
    tint: 0x83e008,
    intervalMs: 100,
    through: false,
    explosion: null,
  },
  {
    name: "BLASTER",
    power: 1,
    speed: 180,
    length: 15,
    width: 3,
    tint: 0xf4007a,
    intervalMs: 300,
    through: false,
    explosion: null,
  },
  {
    name: "LASER",
    power: 0.2,
    speed: 2100,
    length: 200,
    width: 2,
    tint: 0x8ae3fc,
    intervalMs: 600,
    through: true,
    explosion: null,
  },
  {
    name: "EXPLOSION BEAM",
    power: 0.15,
    speed: 900,
    length: 10,
    width: 2,
    tint: 0xff9900,
    intervalMs: 500,
    through: false,
    explosion: { range: 100, growth: 540 },
  },
];

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
  /** Index into WEAPONS_SPECIAL. */
  weaponIdx: number;
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
};

/** Per-player networked state (each client writes its own at 20Hz). */
export type PlayerNetState = {
  x: number;
  y: number;
  angle: number;
  alive: boolean;
  invuln: boolean;
  score: number;
  weaponName: string;
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
function edgeSpawn(margin: number): { x: number; y: number; ang: number } {
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

export function spawnItemState(x: number, y: number): ItemState {
  const ang = Math.random() * Math.PI * 2;
  return {
    id: crypto.randomUUID(),
    x,
    y,
    vx: Math.cos(ang) * ITEM_SPEED,
    vy: Math.sin(ang) * ITEM_SPEED,
    weaponIdx: Math.floor(Math.random() * WEAPONS_SPECIAL.length),
    diesAt: Date.now() + ITEM_LIFETIME_MS,
  };
}
