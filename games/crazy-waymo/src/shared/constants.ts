import type { InterestRule } from "@vibedgames/multiplayer";

export const MAX_DT = 1 / 30;

export const ROAD_TILE = 13;
export const ROAD_Y = 0.02;
export const GRID_X = 244;
export const GRID_Z = 200;
export const CITY_SEED = 1337;
export const ROAD_ROT_SIGN = -1;

export const WORLD_W = GRID_X * ROAD_TILE;
export const WORLD_H = GRID_Z * ROAD_TILE;
export const WORLD_HALF_X = WORLD_W / 2;
export const WORLD_HALF_Z = WORLD_H / 2;

export const CHUNK = 320;
export const DRAW_DISTANCE = 900;

export const CAR = {
  accel: 20,
  airSteerFactor: 0.3,
  bodyHalfLength: 1.5,
  bodyHalfWidth: 0.85,
  boostDrain: 34,
  boostMax: 100,
  boostPerDriftSec: 50,
  boostPerNearMiss: 10,
  boostRefill: 5,
  boostSpeed: 44,
  bounce: 0.35,
  brakeDecel: 82,
  coastDecel: 22,
  driftMinSlip: 0.05,
  driftMinSpeed: 10,
  driftSlingArm: 0.22,
  driftTurnBoost: 2,
  gravity: 52,
  gripDrift: 2.6,
  gripNormal: 8,
  launchDropRate: -6,
  maxLaunchVy: 8,
  maxSpeed: 30,
  minAirSpeed: 20,
  miniBoostImpulse: 14,
  reverseAccel: 24,
  reverseMax: 16,
  slopeGravity: 40,
  steerRamp: 0.08,
  turnRate: 3,
  turnSpeedFalloff: 0.7,
} as const;

export const MPH_FACTOR = 2.1;

export const CAMERA = {
  aimLerp: 7,
  ceilingClear: 0.9,
  ceilingDuckRate: 12,
  ceilingFloor: 1.4,
  ceilingProbe: 1.6,
  ceilingRelease: 3,
  ceilingRiseRate: 2.6,
  distance: 13,
  driftSwing: 0.6,
  fov: 58,
  fovBoost: 70,
  height: 5.2,
  lookAhead: 12,
  lookAheadSpeed: 9,
  lookHeight: 1.6,
  minHeight: 2,
  posLerp: 4.5,
  yawLerp: 3.2,
} as const;

export const CEILING = {
  deckThickness: 0.8,
  flatTol: 0.6,
  harvestCheckTris: 4096,
  harvestSliceMs: 4,
  minArea: 8,
  minClear: 5,
  roadMargin: 4,
} as const;

export const FARE = {
  baseFare: 60,
  comboMax: 8,
  comboWindow: 10,
  driftScorePerSec: 40,
  dropoffRadius: 5.4,
  farePerTile: 14,
  firstSeekMax: 5,
  maxTimeBonus: 20,
  minTimeBonus: 8,
  nearMissBonus: 25,
  nearMissRadius: 3.4,
  overflowDollarPerSec: 5,
  patienceParMult: 2.2,
  pickupRadius: 4.8,
  seekMax: 28,
  seekMin: 6,
  seekRetire: 36,
  smashBonus: 5,
  startTime: 75,
  tierLongMax: 90,
  tierMediumMax: 40,
  tierShortMax: 16,
  timeCap: 90,
  timePerTile: 1.5,
  tipFastBonus: 120,
  waitingFares: 3,
} as const;

export const TRAFFIC = {
  count: 88,
  maxSpeed: 18,
  minSpeed: 8,
} as const;

export const MP_ROOM = "crazy-waymo-v2";
export const MP_MAX_PLAYERS = 64;

/** Play solo when no room admits us within this long of rendered frames,
 *  counted from joining — when the city turns playable (net/session.ts). */
export const OFFLINE_FALLBACK_MS = 8000;

/** Car-transform broadcast rate. Remote cars are drawn at least 100 ms behind
 *  their owner's fastest relay through the server (net/remote-cars.ts), which
 *  covers one interval plus a calm link's jitter at 20, and further back when
 *  a jittery link needs it. */
export const NET_TICK_HZ = 20;

/**
 * Interest management: the server relays a taxi's pose only to players within
 * `radius` of it, so a full room spread over the city costs each client its
 * neighbourhood, not the whole roster. Measured on the planar keys — `x` and
 * `z`; `y` is height. Remote taxis are drawn inside 520 u and dropped past
 * 580 (net/remote-cars.ts); the 220 u beyond that is several times what two
 * taxis closing at drift-boost speed cover while a reveal crosses the server
 * and the render delay, so nobody pops in view. Out of range a player reads
 * `visible: false` (never to the room's host, which sees everyone) and is off
 * the scene and the minimap. Nothing in this game is simulated by the host for
 * everyone (traffic, fares and score are each client's own), so nothing else
 * depends on who sees whom.
 */
export const MP_INTEREST = { radius: 800, x: "x", y: "z" } satisfies InterestRule;
