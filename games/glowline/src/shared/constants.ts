// Every tuning number in one place. The sim (src/sim) reads only this file, so
// the headless harness under tools/ runs the same race the browser does.

/** Laps in one race. */
export const LAPS = 3;
/** Karts on the grid: humans first, bots fill the rest. */
export const GRID_SIZE = 8;
/** Humans one room holds; the SDK overflows the rest into a sibling room. */
export const MAX_PLAYERS = 8;
export const ROOM_ID = "glowline-v2";

// --- Kart handling (world units, seconds) ---------------------------------
export const MAX_SPEED = 34;
export const REVERSE_SPEED = 9;
export const ACCEL = 30;
export const BRAKE = 46;
/** Speed bled per second with no throttle, as a fraction of current speed. */
export const COAST_DRAG = 0.55;
export const TURN_RATE = 2.3;
/** Speed at which steering reaches full authority. */
export const STEER_FULL_SPEED = 9;
/** How much top-speed steering tightens: 0 none, 1 no steering at top speed. */
export const STEER_SPEED_FALLOFF = 0.32;
/** Lateral velocity killed per second (higher = more grip). */
export const GRIP = 9.5;
export const GRIP_DRIFT = 2.1;
export const GRIP_SLICK = 3.1;
export const GRIP_SHOULDER = 6;
/** Seconds the steering input takes to follow the stick. */
export const STEER_SMOOTH = 0.09;

// --- Drift + boost ---------------------------------------------------------
export const DRIFT_MIN_SPEED = 13;
export const DRIFT_MIN_STEER = 0.2;
/** While drifting the kart always turns into the slide: base + steer * range. */
export const DRIFT_BASE_TURN = 0.72;
export const DRIFT_STEER_RANGE = 0.62;
/** Seconds of drift that earn each boost tier. */
export const BOOST_TIERS = [0.55, 1.3, 2.3] as const;
/** Seconds each tier's boost lasts. */
export const BOOST_SECONDS = [0.7, 1.15, 1.8] as const;
export const BOOST_SPEED = 11;
export const BOOST_ACCEL = 60;

// --- Paint -------------------------------------------------------------------
/** Paint grid: PAINT_SIZE cells a side, PAINT_CELL world units each, centred on the origin. */
export const PAINT_SIZE = 512;
export const PAINT_CELL = 0.5;
/** Seconds a stamp glows before it is gone. */
export const PAINT_LIFE = 34;
/** Below this strength paint no longer boosts or slicks anyone. */
export const PAINT_ACTIVE = 0.12;
export const PAINT_RADIUS = 0.8;
export const PAINT_RADIUS_DRIFT = 1.45;
export const PAINT_RADIUS_BOOST = 1.1;
/** Minimum speed to lay paint: a parked kart does not flood its grid slot. */
export const PAINT_MIN_SPEED = 5;
/** Top-speed multiplier on your own paint. */
export const OWN_PAINT_SPEED = 1.16;
export const OWN_PAINT_ACCEL = 1.35;
/** Top-speed multiplier on a rival's paint. */
export const RIVAL_PAINT_SPEED = 0.96;
/** Seconds a splat pad rests after firing. */
export const PAD_COOLDOWN = 7;

// --- Track corridor ----------------------------------------------------------
/** World units between centreline samples. */
export const TRACK_STEP = 1;
/** Extra width beyond the road edge before the rail. */
export const SHOULDER = 3.2;
export const SHOULDER_SPEED = 0.6;
/** Speed kept when scraping the rail. */
export const RAIL_SCRUB = 0.985;
export const KART_RADIUS = 1.15;

// --- Race flow (ms) ----------------------------------------------------------
export const COUNTDOWN_MS = 5000;
export const RESULTS_MS = 9000;
/** After the first finisher, everyone else gets this long. */
export const FINISH_GRACE_MS = 30_000;

// --- Net -----------------------------------------------------------------------
export const SEND_HZ = 20;
export const BOT_SEND_HZ = 15;
export const FALLBACK_MS = 5000;

/** Longest frame the sim will swallow in one step (seconds). */
export const MAX_DT = 1 / 20;

/** Bot identities: name + paint colour. Humans take the SDK's player colour. */
export const BOTS = [
  { color: "#ff3d81", name: "Mirage" },
  { color: "#ffd23f", name: "Zest" },
  { color: "#7cff5b", name: "Kiko" },
  { color: "#b56bff", name: "Onyx" },
  { color: "#ff8a3d", name: "Ember" },
  { color: "#3d6bff", name: "Flux" },
  { color: "#f4f1ea", name: "Chalk" },
] as const;

// --- Chassis -----------------------------------------------------------------
/** Three karts, three trade-offs. Multipliers on top speed, acceleration and grip. */
export const CHASSIS = [
  { accel: 1, grip: 1, name: "Dart", speed: 1, tag: "All-rounder" },
  { accel: 0.86, grip: 0.93, name: "Anvil", speed: 1.045, tag: "Top speed" },
  { accel: 1.2, grip: 1.12, name: "Wisp", speed: 0.965, tag: "Corners" },
] as const;

// --- Orbs --------------------------------------------------------------------
/** Glow orbs a kart can carry; each adds ORB_SPEED to its top speed. */
export const ORB_MAX = 10;
export const ORB_SPEED = 0.011;
/** Orbs lost on a spin-out. */
export const ORB_LOSS = 3;
export const ORB_RESPAWN = 14;
export const PICKUP_RADIUS = 1.9;

// --- Items -------------------------------------------------------------------
export const ITEM_KINDS = ["turbo", "bomb", "solvent", "blot"] as const;
export type ItemKind = (typeof ITEM_KINDS)[number];
export const BOX_RESPAWN = 4.5;
export const TURBO_SECONDS = 1.7;
/** Paint bomb: how far ahead it lands (samples), flight time, splat and blast radius. */
export const BOMB_REACH = 30;
export const BOMB_FLIGHT = 0.8;
export const BOMB_SPLAT = 7.5;
export const BOMB_BLAST = 6;
/** Solvent: radius wiped of rival paint, and seconds of immunity to slick. */
export const SOLVENT_RADIUS = 18;
export const SOLVENT_SECONDS = 4;
/** Blot: a puddle dropped behind; radius, lifetime, and the grace before it arms. */
export const BLOT_RADIUS = 2.3;
export const BLOT_SECONDS = 16;
export const BLOT_ARM = 0.6;
/** Seconds a spun-out kart is out of the driver's hands. */
export const SPIN_SECONDS = 1.15;

// --- Rocket start ------------------------------------------------------------
/** Gas pressed this long (seconds) before the green earns a launch boost. */
export const LAUNCH_MIN = 0.08;
export const LAUNCH_MAX = 0.75;
export const LAUNCH_SECONDS = 1.1;

export const LOCAL_COLOR = "#2fe6ff";
