// Core tunable constants.

export const TILE = 16; // source art is 16px
export const ZOOM = 3.25; // camera zoom — pixels are crisp at integer-ish zoom

/** Camera zoom derived from viewport width so narrow (portrait phone) screens
 *  still see ~9 tiles across; quarter steps keep pixels crisp-ish. */
export function zoomForWidth(width: number): number {
  return Math.max(2, Math.min(ZOOM, Math.round((width / (TILE * 9)) * 4) / 4));
}

// World size in tiles (the world map, public/assets/map.json).
export const MAP_W = 86;
export const MAP_H = 48;

// Player
export const WALK_SPEED = 62; // px/sec (world units, pre-zoom)
export const RUN_SPEED = 104;
// Character frames are 96x64 with the body in the middle; the feet sit at
// row ~39.5, so this origin puts them exactly on the sprite's anchor point.
export const CHAR_ORIGIN_Y = 39.5 / 64;

// Energy
export const MAX_ENERGY = 100;
export const ENERGY_PER_SWING = 2;

// Watering can
export const CAN_MAX = 40;

// Time: in-game clock runs 6:00 -> 26:00 (2am). Sleeping or 2am ends the day.
export const DAY_START_MIN = 6 * 60; // 360
export const DAY_END_MIN = 26 * 60; // 1560 (2am)
export const REAL_SECONDS_PER_GAME_HOUR = 22; // ~7.3 min playable day
export const GAME_MIN_PER_REAL_SEC = 60 / REAL_SECONDS_PER_GAME_HOUR;

// Economy
export const START_GOLD = 350;

// Vitals & combat
export const MAX_HP = 100;
export const HP_REGEN_PER_DAY = 30; // restored on sleep
export const FAINT_GOLD_LOSS_FRAC = 0.08;
export const SWORD_BASE_DAMAGE = 6;
export const PLAYER_INVULN_MS = 800;

// Inventory
export const BACKPACK = 24;

// Skills
export const SKILL_MAX_LEVEL = 10;
export const XP_BASE = 60;
export const XP_EXP = 1.45;

// Depths (render ordering layers)
export const DEPTH = {
  ground: 0,
  soil: 1,
  highlight: 2,
  decalLow: 3,
  crop: 5,
  // y-sorted entities (player, trees, rocks, buildings) live between 10 and 1e6
  entityBase: 10,
  particles: 900_000,
  night: 1_000_000,
} as const;

// ---- multiplayer (co-op shared farm) ----------------------------------------
// New farms use a FIXED seed so every client generates the identical map (like
// crazy-waymo's fixed city) — no seed exchange needed. The host owns the world
// (tilled/watered/crops) and the clock; players see each other and tend the
// same land. Inventory/energy/money stay per-player. Solo/offline is unchanged
// except the (now deterministic) starting farm.
export const MP_ROOM = "farm-default";
export const MP_MAX_PLAYERS = 4;
export const OFFLINE_FALLBACK_MS = 6000;
/** Player position/facing broadcast rate. */
export const NET_TICK_HZ = 12;
/** Host clock (day/time/weather) broadcast rate. */
export const CLOCK_TICK_HZ = 2;
/** Fixed seed for a co-op / new farm so all clients build the same map. */
export const FARM_SEED = 20240719;
