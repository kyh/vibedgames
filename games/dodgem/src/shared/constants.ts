/** Cars on the board: humans first, bots fill the rest. */
export const GRID_SIZE = 8;

/** Humans one room holds; the SDK overflows the rest into a sibling room. */
export const MAX_PLAYERS = 8;
export const ROOM_ID = "dodgem-v1";

export const ROUND_MS = 120_000;
export const COUNTDOWN_MS = 4000;
export const RESULTS_MS = 9000;

/** The rim of the board starts blinking this long before the round ends, then drops. */
export const SHRINK_MS = 35_000;
export const SHRINK_WARN_MS = 3000;

/** The sim's fixed step, and the most steps one frame may run. */
export const STEP = 1 / 60;
export const MAX_STEPS = 4;

/** What an even car does: each kind scales these. */
export const MAX_SPEED = 14.4;
export const ACCEL = 30;

/** A car backs up at this share of its top speed. */
export const REVERSE = 0.45;

/** Speed bled per second with no throttle: a car left alone stops in under half a second. */
export const COAST_DRAG = 5.5;

/** Radians per second at full lock. */
export const TURN_RATE = 3.5;

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

/** A press of the attack button, and of the special's, is remembered this long. */
export const ATTACK_BUFFER = 0.15;
export const SPECIAL_BUFFER = 0.3;

/** Extra throw per unit of the attacker's speed along the blow. */
export const SPEED_THROW = 0.1;

/**
 * Damage: every blow adds to it, and a car flies this much further per point.
 * A fresh car is shoved; at 100 the same blow throws it over two and a half
 * times as far.
 */
export const DAMAGE_GAIN = 0.016;
export const DAMAGE_MAX = 300;

/** A thrown car covers its distance on this time constant, stretched for long throws. */
export const KNOCK_TAU = 0.18;
export const KNOCK_HOP = 1.2;

/** Seconds a thrown car has no steering, then seconds for it to come back. */
export const STAGGER = 0.45;
export const STAGGER_EASE = 0.2;

/** The attacker is pushed back this far as a punch lands, and lunges this far on a boosted one. */
export const PUNCH_RECOIL = 1;
export const PUNCH_LUNGE = 1.2;

/** Two bumpers meeting throw both cars back this far. */
export const CLASH_THROW = 2.2;

/** A ram needs this closing speed, which only a boost reaches. */
export const RAM_MIN = 17;
export const RAM_THROW = 2.8;
export const RAM_DAMAGE = 5;

/** What the board's own toys throw a fresh car, and the damage they do. */
export const BUMPER_THROW = 2.6;
export const SWEEPER_THROW = 4.4;
export const PISTON_THROW = 5.6;
export const BUMPER_DAMAGE = 5;
export const SWEEPER_DAMAGE = 10;
export const PISTON_DAMAGE = 12;

/** Seconds a piston's lane is lit before it fires, and seconds its head stays out. */
export const PISTON_WARN = 0.9;
export const PISTON_OUT = 0.45;

/** Seconds a hit stays yours: a fall within it is your knock-off. */
export const CREDIT_SECONDS = 3.5;

export const RESPAWN_SECONDS = 1;
export const SAFE_SECONDS = 1.5;

/** Height a respawning car drops from. */
export const DROP_HEIGHT = 12;

/** The same attacker cannot land twice inside the first window, nor anyone inside the second. */
export const HIT_LOCK_SAME = 0.4;
export const HIT_LOCK_ANY = 0.12;

/** Power cubes: seconds before the first, seconds between cubes on one pad, the beam before each. */
export const CUBES_AT = 4;
export const CUBE_EVERY = 11;
export const CUBE_BEAM = 1.5;
export const PICKUP_RADIUS = 2.1;

export const SEND_HZ = 20;
export const BOT_SEND_HZ = 20;
export const FALLBACK_MS = 5000;

/** Longest frame the sim will swallow (seconds). */
export const MAX_DT = 1 / 15;

/** Bot names, by seat. */
export const BOTS = ["Mirage", "Zest", "Onyx", "Rusty", "Chalk", "Kiko", "Ember"] as const;
