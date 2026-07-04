// Tunable game constants. Speeds are world-units/second, angles radians.
// World scale: the Car Kit is authored ~1.5 units wide; the City Kit road tile
// is a 1×1 unit tile. We scale the city UP so one road cell = ROAD_TILE units,
// giving arcade-wide two-lane roads the taxi can drift across.

export const MAX_DT = 1 / 30; // clamp delta on tab-away

// --- World / city grid ---
export const ROAD_TILE = 13; // world units per grid cell (wider arcade boulevards)
export const ROAD_Y = 0.02; // lift road tiles above the ground plane
// Rectangular grid matching SF's true ~1.22:1 aspect (14.1km E-W × 11.6km N-S) —
// GRID_X cells east-west, GRID_Z cells north-south. The road network is the real
// SF street grid (OpenStreetMap), rasterized at this resolution by
// tools/sf-data/rasterize.mjs — keep the baked mask (src/world/sf-streets.ts) in
// sync: `node tools/sf-data/rasterize.mjs 244 200`.
export const GRID_X = 244; // cells east-west (u axis)
export const GRID_Z = 200; // cells north-south (v axis)
export const CITY_SEED = 1337; // still seeds traffic, props and other scatter
// Rotation sign mapping grid clockwise quarter-turns → Three.js Y rotation.
// Verified visually; flip to +1 if road tiles point the wrong way.
export const ROAD_ROT_SIGN = -1;

// World extent per axis. x spans WORLD_W (east-west), z spans WORLD_H (north-south).
export const WORLD_W = GRID_X * ROAD_TILE;
export const WORLD_H = GRID_Z * ROAD_TILE;
export const WORLD_HALF_X = WORLD_W / 2;
export const WORLD_HALF_Z = WORLD_H / 2;

// Chunk streaming: static city geometry is bucketed into CHUNK-sized square
// tiles so the renderer frustum-culls off-screen tiles, and tiles whose nearest
// point is farther than DRAW_DISTANCE from the camera are hidden each frame.
// Keep DRAW_DISTANCE ≥ the fog far plane so nothing pops in ahead of the haze.
export const CHUNK = 320;
// ~12M tris/frame at 1900 (the whole city fit inside the fog) — SF haze pulls
// in instead: full fog by ~1250, chunks released just past it.
export const DRAW_DISTANCE = 1000;

// --- Car (arcade handling) ---
// Turn radius R = speed / (turnRate·authority). A road tile is ROAD_TILE (13u)
// with ~10u of asphalt, so a right-angle corner needs R ≈ 6u. The design:
// plain steering is for lane-following and gentle curves ONLY — at cruise its
// radius is deliberately too wide to take a 90° corner (R_top ≈ 30/(3.0·0.7) ≈
// 14u), so you must either slow right down or DRIFT. The drift (Space) breaks
// traction and multiplies the turn (driftTurnBoost), carving the corner:
//   ω_drift at 24u/s ≈ 3.0·0.76·2.0 ≈ 4.6 rad/s → a ~90° sweep in ~0.34s.
export const CAR = {
  maxSpeed: 30, // top forward speed
  boostSpeed: 44, // top speed while boosting (a burst, still controllable)
  accel: 20, // forward acceleration — gentle launch, no twitchy leap to top
  brakeDecel: 82, // braking / active slow-down (scrub hard for tight corners)
  coastDecel: 22, // engine braking when no input — lifting off scrubs speed for turns
  reverseMax: 16,
  reverseAccel: 24,
  // Steering: angular speed (rad/s) you can turn, scaled by how fast you go.
  turnRate: 3.0, // gentle steering — lane changes and sweeping curves, not 90°s
  turnSpeedFalloff: 0.7, // authority drops with speed → can't hard-corner at cruise
  steerRamp: 0.08, // seconds to ramp steering input to full lock (crisp, not icy)
  // Grip controls how fast the velocity vector realigns to the car's heading.
  gripNormal: 8.0, // high grip → predictable, goes where it points (nav feel)
  gripDrift: 2.6, // low grip while drifting → slides, but carves the corner
  driftTurnBoost: 2.0, // Space-drift multiplies the turn to whip through right angles
  driftMinSpeed: 10, // must be moving this fast to drift (easy to break loose)
  driftMinSlip: 0.05, // radians of real slip before a drift counts — low, so even light drifts earn boost
  miniBoostImpulse: 14, // instant forward pop when releasing a charged drift
  slopeGravity: 40, // how hard SF hills pull the car back uphill / drag it downhill
  // Hill jumps: cresting fast enough goes ballistic instead of gluing to the road.
  gravity: 52, // vertical fall accel while airborne (snappy arcs, not moon-floats)
  maxLaunchVy: 8, // cap the upward pop off a crest so air time stays a beat
  minAirSpeed: 20, // slower than this just sticks to the ground
  launchDropRate: -6, // go airborne when the ground falls away faster than this (u/s)
  airSteerFactor: 0.3, // steering authority in the air
  boostDrain: 34, // boost units/s spent while boosting
  boostRefill: 5, // trickle only — real boost comes from drifts/near-misses/fares
  boostMax: 100,
  boostPerDriftSec: 50, // boost/s gained continuously WHILE drifting — fills fast, easy to earn
  driftSlingArm: 0.22, // seconds of drift before the release slingshot arms (low = forgiving)
  boostPerNearMiss: 10,
  bodyHalfWidth: 0.85, // collision half-extents (a bit > visual for forgiveness)
  bodyHalfLength: 1.5,
  bounce: 0.35, // wall bounce restitution
} as const;

export const MPH_FACTOR = 2.1; // displayed "MPH" = speed * factor (flavor only)

// --- Chase camera ---
// Close and low: the taxi should fill real screen space — a far, high camera
// makes the hero read tiny and the streets hard to judge.
export const CAMERA = {
  fov: 58,
  fovBoost: 70, // widen FOV with speed for a rush
  distance: 13, // behind the car
  height: 6.8,
  lookHeight: 1.6,
  lookAhead: 12, // aim ahead of the car (see corners sooner)
  lookAheadSpeed: 9, // extra look-ahead at top speed (road opens up)
  posLerp: 4.5, // position follow stiffness
  aimLerp: 7, // look-at follow stiffness
  yawLerp: 3.2, // how fast the camera swings behind the heading
  driftSwing: 0.6, // max camera yaw bias toward the slide (radians)
  minHeight: 2.0, // never let collision pull the camera below this
} as const;

// --- Fares / scoring / timer ---
export const FARE = {
  startTime: 75, // seconds on the clock at start
  pickupRadius: 4.8, // distance to auto-board a waiting passenger
  dropoffRadius: 5.4, // distance to complete a delivery
  baseFare: 60,
  farePerTile: 14, // reward scales with trip distance (grid tiles)
  timePerTile: 1.5, // seconds added to the clock per trip tile
  minTimeBonus: 8,
  maxTimeBonus: 20,
  timeCap: 90, // the clock never banks past this; overflow converts to cash
  overflowDollarPerSec: 5, // $ per second of time bonus lost to the cap
  tipFastBonus: 120, // tip for a speedy delivery (scaled by leftover time frac)
  // Combo: the chain timer ticks ONLY while carrying a fare — it judges how
  // fast you deliver, not how lucky the next spawn is.
  comboWindow: 10,
  comboMax: 8,
  nearMissBonus: 25, // scaled up to 3× by speed in state.nearMiss
  nearMissRadius: 3.4, // pass traffic this close (and fast) for a bonus
  driftScorePerSec: 40,
  waitingFares: 3, // simultaneous customers on the street
  // Trip tiers (trip length in grid tiles): pay + beacon color identity.
  tierShortMax: 6, // green $
  tierMediumMax: 10, // amber $$
  tierLongMax: 14, // red $$$ (superlinear payout)
  firstSeekMax: 5, // the very first customer spawns close (fast first loop)
  patienceParMult: 2.2, // patience budget = par seconds × this
  smashBonus: 5, // $ per smashed cone
} as const;

// --- Traffic ---
export const TRAFFIC = {
  count: 36,
  minSpeed: 8,
  maxSpeed: 18,
} as const;

// --- Multiplayer (free-roam presence; no shared scoring) ---
// The city is generated from a fixed CITY_SEED, so every client builds an
// identical map and remote taxis line up on the same roads. We only broadcast
// each player's car transform and render the others; fares/score stay private
// and local. 64 is the party server's hard per-room ceiling.
export const MP_ROOM = "crazy-waymo-default";
export const MP_MAX_PLAYERS = 64;
export const OFFLINE_FALLBACK_MS = 8000;
/** Car-transform broadcast rate; remote cars interpolate between updates. */
export const NET_TICK_HZ = 15;
