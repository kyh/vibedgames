// Tunable game constants. Speeds are world-units/second, angles radians.
// World scale: the Car Kit is authored ~1.5 units wide; the City Kit road tile
// is a 1×1 unit tile. We scale the city UP so one road cell = ROAD_TILE units,
// giving arcade-wide two-lane roads the taxi can drift across.

export const MAX_DT = 1 / 30; // clamp delta on tab-away

// --- World / city grid ---
export const ROAD_TILE = 8; // world units per grid cell
export const ROAD_Y = 0.02; // lift road tiles above the ground plane
export const GRID = 37; // cells per side (irregular road network laid on this)
export const CITY_SEED = 1337;
// Rotation sign mapping grid clockwise quarter-turns → Three.js Y rotation.
// Verified visually; flip to +1 if road tiles point the wrong way.
export const ROAD_ROT_SIGN = -1;

export const WORLD_SIZE = GRID * ROAD_TILE;
export const WORLD_HALF = WORLD_SIZE / 2;

// --- Taxi (arcade handling) ---
export const CAR = {
  maxSpeed: 52, // top forward speed
  boostSpeed: 76, // top speed while boosting
  accel: 36, // forward acceleration
  brakeDecel: 80, // braking / active slow-down
  coastDecel: 14, // engine braking when no input
  reverseMax: 16,
  reverseAccel: 24,
  // Steering: angular speed (rad/s) you can turn, scaled by how fast you go.
  turnRate: 2.6,
  turnSpeedFalloff: 0.6, // less steering authority at very high speed
  steerRamp: 0.12, // seconds to ramp steering input to full lock (crisp, not icy)
  // Grip controls how fast the velocity vector realigns to the car's heading.
  gripNormal: 7.0, // high grip → little slide (THE feel knob: lower = slidier)
  gripDrift: 1.5, // low grip while drifting → big hangable slide
  driftTurnBoost: 1.7, // extra steering while drifting
  driftMinSpeed: 18, // must be moving this fast to drift
  miniBoostImpulse: 14, // instant forward pop when releasing a charged drift
  boostDrain: 34, // boost units/s spent while boosting
  boostRefill: 16, // boost units/s regained otherwise
  boostMax: 100,
  boostPerDrift: 26, // boost gained for a sustained drift release
  boostPerNearMiss: 10,
  bodyHalfWidth: 0.85, // collision half-extents (a bit > visual for forgiveness)
  bodyHalfLength: 1.5,
  bounce: 0.35, // wall bounce restitution
} as const;

export const MPH_FACTOR = 2.1; // displayed "MPH" = speed * factor (flavor only)

// --- Chase camera ---
export const CAMERA = {
  fov: 60,
  fovBoost: 76, // widen FOV with speed for a rush
  distance: 13.5, // behind the car
  height: 7.4,
  lookHeight: 1.4,
  lookAhead: 7.5, // aim ahead of the car
  lookAheadSpeed: 5, // extra look-ahead at top speed (road opens up)
  posLerp: 4.5, // position follow stiffness
  aimLerp: 7, // look-at follow stiffness
  yawLerp: 3.2, // how fast the camera swings behind the heading
  driftSwing: 0.6, // max camera yaw bias toward the slide (radians)
  minHeight: 2.0, // never let collision pull the camera below this
} as const;

// --- Fares / scoring / timer ---
export const FARE = {
  startTime: 75, // seconds on the clock at start
  pickupRadius: 4.0, // distance to auto-board a waiting passenger
  dropoffRadius: 4.5, // distance to complete a delivery
  baseFare: 60,
  farePerTile: 14, // reward scales with trip distance (grid tiles)
  timePerTile: 1.5, // seconds added to the clock per trip tile
  minTimeBonus: 8,
  maxTimeBonus: 28,
  tipFastBonus: 120, // tip for a speedy delivery (scaled by leftover time frac)
  comboWindow: 6, // s after a dropoff to chain the next for a multiplier
  comboMax: 8,
  nearMissBonus: 25,
  nearMissRadius: 3.4, // pass traffic this close (and fast) for a bonus
  driftScorePerSec: 40,
} as const;

// --- Traffic ---
export const TRAFFIC = {
  count: 26,
  minSpeed: 8,
  maxSpeed: 18,
} as const;
