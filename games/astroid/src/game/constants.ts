import type { Weapon } from "./types";

export const WORLD_WIDTH = 3840;
export const WORLD_HEIGHT = 2160;

export const FPS = 60;
export const NETWORK_HZ = 20; // how often to send state updates
export const NETWORK_FRAME_SKIP = Math.round(FPS / NETWORK_HZ);

export const SHIP_SIZE = 8;
export const SHIP_SPEED = 1.5;
export const SHIP_ANGLES_DEG = [0, 140, 180, 220];

export const RESPAWN_DELAY_MS = 5_000;
export const INVULNERABLE_MS = 2_000;

export const ASTEROID_MAX_SIZE = 80;
export const ASTEROID_MIN_SIZE = 5;
export const ASTEROID_MAX_NUM = 5;
export const ASTEROID_SPAWN_INTERVAL = 350; // ms between spawns
export const ASTEROID_VERTEX_COUNT = 12;

export const UFO_SPEED = 2;
export const UFO_SPAWN_CHANCE = 0.0035; // per tick
export const UFO_SIZE = 15;
export const UFO_HP = 100;

export const ITEM_SPEED = 0.5;
export const ITEM_LIFETIME = FPS * 30; // 30 seconds in ticks

export const SPECIAL_WEAPON_DURATION_MS = 20_000;

export const SCORE = {
  ASTEROID_DAMAGE: 10,
  ASTEROID_DESTROY: 50,
  UFO_DAMAGE: 0,
  UFO_DESTROY: 300,
  PLAYER_KILL: 200,
} as const;

export const WEAPON_DEFAULT: Weapon = {
  name: "NORMAL BEAM",
  power: 0.3,
  speed: 3,
  length: 10,
  width: 1,
  color: "white",
  shootingInterval: 350,
  through: false,
  explosion: false,
};

export const WEAPONS_SPECIAL: Weapon[] = [
  {
    name: "TINY BEAM",
    power: 0.1,
    speed: 10,
    length: 5,
    width: 1,
    color: "rgb(131, 224, 8)",
    shootingInterval: 100,
    through: false,
    explosion: false,
  },
  {
    name: "BLASTER",
    power: 1,
    speed: 3,
    length: 15,
    width: 3,
    color: "rgb(244, 0, 122)",
    shootingInterval: 300,
    through: false,
    explosion: false,
  },
  {
    name: "LASER",
    power: 0.2,
    speed: 35,
    length: 200,
    width: 2,
    color: "rgb(138, 227, 252)",
    shootingInterval: 600,
    through: true,
    explosion: false,
  },
  {
    name: "EXPLOSION BEAM",
    power: 0.15,
    speed: 15,
    length: 10,
    width: 2,
    color: "rgb(255, 153, 0)",
    shootingInterval: 500,
    through: false,
    explosion: { range: 100, speed: 4.5 },
  },
];

export const MINIMAP_SIZE = 140;
export const MINIMAP_PADDING = 12;
