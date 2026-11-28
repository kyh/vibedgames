export const CAR_KINDS = ["bumper", "dart", "brick", "popper", "scoop", "twister"] as const;

export type CarKind = (typeof CAR_KINDS)[number];

/** What a car's own attack does when its button is pressed. */
export type AttackKind = "punch" | "dash" | "slam" | "shot" | "scoop" | "spin";

export interface KindDef {
  name: string;
  attack: AttackKind;
  attackName: string;
  /** One line for the picker. */
  blurb: string;
  /** Top speed, pull-away and steering against an even car. */
  speed: number;
  accel: number;
  turn: number;
  /** Endurance: a blow throws this car 1/weight as far. */
  weight: number;
  /** Scales how far this car's own blows throw. */
  power: number;
  /** Seconds: wind-up, strike, hold, retract, then the wait before the next. */
  windup: number;
  strike: number;
  hold: number;
  retract: number;
  cooldown: number;
  /** The wait after an attack that touched nobody. */
  whiff: number;
  /** How far the attack throws a fresh car of even weight, and the damage it adds. */
  throw: number;
  damage: number;
}

export const KINDS: Record<CarKind, KindDef> = {
  brick: {
    accel: 0.85,
    attack: "slam",
    attackName: "SLAM",
    blurb: "Hops and comes down hard: everyone around it flies.",
    cooldown: 3.8,
    damage: 16,
    hold: 0.1,
    name: "BRICK",
    power: 1.15,
    retract: 0.25,
    speed: 0.86,
    strike: 0.08,
    throw: 4.2,
    turn: 0.88,
    weight: 1.26,
    whiff: 4.2,
    windup: 0.26,
  },
  bumper: {
    accel: 1,
    attack: "punch",
    attackName: "PUNCH",
    blurb: "A spring bumper straight ahead. Good at everything.",
    cooldown: 2.1,
    damage: 14,
    hold: 0.12,
    name: "BUMPER",
    power: 1,
    retract: 0.2,
    speed: 1,
    strike: 0.1,
    throw: 3.9,
    turn: 1,
    weight: 1,
    whiff: 3,
    windup: 0.12,
  },
  dart: {
    accel: 1.15,
    attack: "dash",
    attackName: "DASH",
    blurb: "Lunges through whoever is ahead. Fast, and light.",
    cooldown: 2.1,
    damage: 10,
    hold: 0,
    name: "DART",
    power: 0.85,
    retract: 0.15,
    speed: 1.14,
    strike: 0.26,
    throw: 4.2,
    turn: 1.08,
    weight: 0.86,
    whiff: 2.8,
    windup: 0.12,
  },
  popper: {
    accel: 1,
    attack: "shot",
    attackName: "POP SHOT",
    blurb: "Fires a puck down the board. Keeps its distance.",
    cooldown: 1.7,
    damage: 10,
    hold: 0,
    name: "POPPER",
    power: 0.8,
    retract: 0.15,
    speed: 0.97,
    strike: 0.05,
    throw: 4.6,
    turn: 1,
    weight: 0.9,
    whiff: 1.7,
    windup: 0.08,
  },
  scoop: {
    accel: 1,
    attack: "scoop",
    attackName: "FLIP",
    blurb: "Scoops the car in front and tosses it over its roof.",
    cooldown: 1.6,
    damage: 18,
    hold: 0.12,
    name: "SCOOP",
    power: 1.1,
    retract: 0.2,
    speed: 0.98,
    strike: 0.1,
    throw: 6.5,
    turn: 0.95,
    weight: 1.18,
    whiff: 2.2,
    windup: 0.14,
  },
  twister: {
    accel: 1.05,
    attack: "spin",
    attackName: "WHIRL",
    blurb: "Spins on the spot and bats away anything close.",
    cooldown: 3.9,
    damage: 8,
    hold: 0,
    name: "TWISTER",
    power: 0.92,
    retract: 0.12,
    speed: 1.02,
    strike: 0.3,
    throw: 3.3,
    turn: 1.12,
    weight: 0.9,
    whiff: 4.1,
    windup: 0.1,
  },
};

/** How far past the nose a punch reaches, and the half width it sweeps. */
export const PUNCH_REACH = 2.5;
export const PUNCH_HALF_WIDTH = 1.45;

/** The scoop: shorter and wider than a punch, and it throws high. */
export const SCOOP_REACH = 2.6;
export const SCOOP_HALF_WIDTH = 1.9;
export const SCOOP_LIFT = 1.7;

/** How far a dash carries its car, and how close a body has to be to be caught by it. */
export const DASH_REACH = 5.6;
export const DASH_CATCH = 0.9;

/** Centre-to-centre reach of the two attacks that hit all round. */
export const SLAM_RADIUS = 4.3;
export const SPIN_RADIUS = 3;

/** The popper's puck: units a second, and how far it flies. */
export const PUCK_SPEED = 38;
export const PUCK_RANGE = 18;

/** How far a car's own attack reaches from its centre: what a bot swings by. */
export const attackRange: (kind: CarKind) => number = (kind) => {
  const { attack } = KINDS[kind];

  if (attack === "punch") {
    return 1.3 + PUNCH_REACH + 0.6;
  }

  if (attack === "scoop") {
    return 1.3 + SCOOP_REACH + 0.6;
  }

  if (attack === "dash") {
    return DASH_REACH + 1.2;
  }

  if (attack === "slam") {
    return SLAM_RADIUS;
  }

  return attack === "spin" ? SPIN_RADIUS : PUCK_RANGE - 1;
};

const pips = (value: number, low: number, high: number) =>
  Math.min(5, Math.max(1, Math.round(1 + ((value - low) / (high - low)) * 4)));

const REACH_PIPS = { dash: 4, punch: 2, scoop: 1, shot: 5, slam: 4, spin: 4 } satisfies Record<
  AttackKind,
  number
>;

/**
 * A kind as the picker shows it: one to five pips a stat. Speed counts the
 * steering in; reach is how much board the attack covers, which is what the
 * slow and the weak get in return.
 */
export const kindPips = (kind: CarKind) => {
  const def = KINDS[kind];

  return {
    endurance: pips(def.weight, 0.86, 1.26),
    power: pips(def.power * def.throw, 3, 5.9),
    reach: REACH_PIPS[def.attack],
    speed: pips(def.speed + (def.turn - 1) * 0.5, 0.86, 1.14),
  };
};
