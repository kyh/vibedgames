/** Cars on the board: humans first, bots fill the rest. */
export const GRID_SIZE = 8;

/** Humans one room holds; the SDK overflows the rest into a sibling room. */
export const MAX_PLAYERS = 8;
export const ROOM_ID = "tabletop-turbo-v2";

export const ROUND_MS = 90_000;
export const COUNTDOWN_MS = 4000;
export const RESULTS_MS = 9000;

/** The ends of the board start blinking this long before the round ends, then drop. */
export const SHRINK_MS = 25_000;
export const SHRINK_WARN_MS = 3000;

/** What a knock-off is worth once the ends start to blink. */
export const SQUEEZE_POINTS = 2;

/** The sim's fixed step, and the most steps one frame may run. */
export const STEP = 1 / 60;
export const MAX_STEPS = 4;

export const MAX_SPEED = 14.4;
export const ACCEL = 30;

/** Speed bled per second with no stick: a car left alone stops in under half a second. */
export const COAST_DRAG = 5.5;

/** Radians per second the nose swings towards the stick. */
export const TURN_RATE = 5.4;

/** Lateral velocity killed per second (higher = more grip). */
export const GRIP = 11;

export const BOOST_SPEED = 21.6;
export const BOOST_ACCEL = 70;

/** Seconds a full meter lasts, seconds to refill it, and the wait before it starts refilling. */
export const BOOST_SECONDS = 1;
export const BOOST_REFILL = 5;
export const BOOST_REST = 0.5;

/** The meter has to be this full to start a boost, and a knock-off gives this much back. */
export const BOOST_MIN = 0.2;
export const BOOST_REWARD = 0.5;

/** Collision radius of a car, and its nose from its centre. */
export const CAR_RADIUS = 1.2;
export const CAR_NOSE = 1.3;

export const GRAVITY = 46;

/** Seconds a car falls before it is out. */
export const FALL_SECONDS = 0.7;

/** The punch: a press is remembered this long, then wind-up, strike, hold and retract. */
export const PUNCH_BUFFER = 0.15;
export const PUNCH_WINDUP = 0.055;
export const BOT_WINDUP = 0.2;
export const PUNCH_STRIKE = 0.1;
export const PUNCH_HOLD = 0.12;
export const PUNCH_RETRACT = 0.2;
export const PUNCH_COOLDOWN = 2.2;
export const PUNCH_WHIFF_COOLDOWN = 3;

/** How far past the nose the bumper reaches, and the half width it sweeps. */
export const PUNCH_REACH = 2.5;
export const PUNCH_HALF_WIDTH = 1.45;

/** How far a standing punch throws a car, and the extra per unit of the attacker's speed. */
export const PUNCH_THROW = 5.5;
export const PUNCH_SPEED_THROW = 0.1;

/** A thrown car covers its distance on this time constant, and leaves the floor this high. */
export const KNOCK_TAU = 0.18;
export const KNOCK_HOP = 1.4;

/** Seconds a thrown car has no steering, then seconds for it to come back. */
export const STAGGER = 0.45;
export const STAGGER_EASE = 0.2;

/** The attacker is pushed back this far as the bumper lands, and lunges this far on a boosted punch. */
export const PUNCH_RECOIL = 1;
export const PUNCH_LUNGE = 1.2;

/** Two bumpers meeting throw both cars back this far. */
export const CLASH_THROW = 2.2;

/** Dents: each punch taken adds one, up to the last multiplier; one heals after this long unhit. */
export const DENT_GAIN = [1, 1.3, 1.6] as const;
export const DENT_HEAL = 8;

/** A ram needs this closing speed, which only a boost reaches, and throws this far. */
export const RAM_MIN = 16;
export const RAM_THROW = 4.3;

/** What the board's own toys throw a car: pop bumper, sweeper arm, piston. */
export const BUMPER_THROW = 3.6;
export const SWEEPER_THROW = 7.2;
export const PISTON_THROW = 9.6;

/** Seconds a piston's lane is lit before it fires, and seconds its head stays out. */
export const PISTON_WARN = 0.9;
export const PISTON_OUT = 0.45;

/** Seconds a hit stays yours: a fall within it is your knock-off. */
export const CREDIT_SECONDS = 3;

export const RESPAWN_SECONDS = 1;
export const SAFE_SECONDS = 1.5;

/** Height a respawning car drops from. */
export const DROP_HEIGHT = 12;

/** The same attacker cannot land twice inside the first window, nor anyone inside the second. */
export const HIT_LOCK_SAME = 0.4;
export const HIT_LOCK_ANY = 0.12;

/** Seconds into the round before the first crate, the gap between crates, and the beam before each lands. */
export const ITEMS_AT = 10;
export const CRATE_EVERY = 9;
export const CRATE_BEAM = 2;
export const PICKUP_RADIUS = 2;

export const ITEM_KINDS = ["mega", "spring", "giant", "turbo"] as const;

export type ItemKind = (typeof ITEM_KINDS)[number];

/** Punches a bumper mod lasts, and seconds a car mod lasts. */
export const ITEM_PUNCHES = 2;
export const ITEM_SECONDS = 6;

export const MEGA_FORCE = 1.5;
export const MEGA_WIDTH = 1.5;
export const SPRING_REACH = 2;
export const SPRING_FORCE = 1.25;
export const GIANT_SCALE = 1.5;
export const GIANT_TAKEN = 0.7;
export const GIANT_SLOW = 0.85;

export const SEND_HZ = 20;
export const BOT_SEND_HZ = 20;
export const FALLBACK_MS = 5000;

/** Longest frame the sim will swallow (seconds). */
export const MAX_DT = 1 / 15;

/** Bot identities: name + colour. Humans take the SDK's player colour. */
export const BOTS = [
  { color: "#ee3fa8", name: "Mirage" },
  { color: "#a4d81c", name: "Zest" },
  { color: "#8f3fe0", name: "Onyx" },
  { color: "#f26a1b", name: "Rusty" },
  { color: "#c9cede", name: "Chalk" },
  { color: "#f7c820", name: "Kiko" },
  { color: "#e02a2f", name: "Ember" },
] as const;

export const LOCAL_COLOR = "#18bfb4";
