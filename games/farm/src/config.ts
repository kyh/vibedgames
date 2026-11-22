export const TILE = 16;
export const ZOOM = 3.25;

/** Camera zoom derived from viewport width so narrow (portrait phone) screens
 *  still see ~9 tiles across; quarter steps keep pixels crisp-ish. */
export const zoomForWidth = (width: number) =>
  Math.max(2, Math.min(ZOOM, Math.round((width / (TILE * 9)) * 4) / 4));

export const MAP_W = 86;
export const MAP_H = 48;

export const WALK_SPEED = 62;
export const RUN_SPEED = 104;
export const CHAR_ORIGIN_Y = 39.5 / 64;

export const MAX_ENERGY = 100;
export const ENERGY_PER_SWING = 2;

export const CAN_MAX = 40;

export const DAY_START_MIN = 6 * 60;
export const DAY_END_MIN = 26 * 60;
export const REAL_SECONDS_PER_GAME_HOUR = 22;
export const GAME_MIN_PER_REAL_SEC = 60 / REAL_SECONDS_PER_GAME_HOUR;

export const START_GOLD = 350;

export const MAX_HP = 100;
export const HP_REGEN_PER_DAY = 30;
export const FAINT_GOLD_LOSS_FRAC = 0.08;
export const SWORD_BASE_DAMAGE = 6;
export const PLAYER_INVULN_MS = 800;

/** Hurt/contact clip lengths; boot-scene derives frame rates so the strips fit. */
export const FARMER_HURT_MS = 260;
export const SKELETON_HURT_MS = 180;
export const SKELETON_CONTACT_MS = 250;

export const BACKPACK = 24;

export const SKILL_MAX_LEVEL = 10;
export const XP_BASE = 60;
export const XP_EXP = 1.45;

export const DEPTH = {
  ground: 0,
  soil: 1,
  highlight: 2,
  decalLow: 3,
  crop: 5,
  entityBase: 10,
  particles: 900_000,
  night: 1_000_000,
} as const;

export const MP_ROOM = "farm-default-v3";
export const MP_MAX_PLAYERS = 4;

/** Farmers farther apart than this (world px, feet to feet) stop receiving
 *  each other's player state — the bulk of the room's traffic — and hide each
 *  other. Past the corner of a 1920×1080 view (591×332 world px at zoom 3.25)
 *  even when the camera rests against the world's edge, so nobody pops in
 *  on screen. The world is 1376×768. */
export const MP_INTEREST_RADIUS = 720;

/** A farmer's feet never leave the world (movement clamps inside it), so the
 *  server drops any player-state patch that puts them outside — a hacked
 *  client cannot write itself off the map, out of everyone's interest. */
export const MP_LIMITS = {
  x: { max: MAP_W * TILE, min: 0 },
  y: { max: MAP_H * TILE, min: 0 },
} as const;

export const OFFLINE_FALLBACK_MS = 6000;

/** Player position/facing broadcast rate, stamped with server time; peers
 *  render it 100 ms or more behind its arrival, as far as the stream needs
 *  (net/farmer-wire). */
export const NET_TICK_HZ = 20;

/** How long a guest's own farming outranks older host values for that tile. */
export const PENDING_EDIT_MS = 1500;

/** A remote farmer moving further than this between updates went through a
 *  door (the mine, a reload): place them there instead of gliding. */
export const REMOTE_SNAP_PX = 32;

/** Fixed seed for a co-op / new farm so all clients build the same map. */
export const FARM_SEED = 20_240_719;
