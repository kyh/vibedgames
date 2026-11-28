/** What a power cube can hold. A car carries one at a time. */
export const SPECIALS = [
  "rocket",
  "seeker",
  "mine",
  "oil",
  "shock",
  "magnet",
  "zap",
  "shield",
  "giant",
  "turbo",
  "wrench",
  "spring",
] as const;

export type SpecialKind = (typeof SPECIALS)[number];

/** A special that changes the car for a while once it is used. */
export type ModKind = "" | "giant" | "turbo" | "shield";

export const MOD_SECONDS = { giant: 7, shield: 8, turbo: 4 } as const;

export const GIANT_SCALE = 1.5;
export const GIANT_RADIUS = 1.3;
export const GIANT_WEIGHT = 1.7;
export const GIANT_POWER = 1.3;
export const GIANT_SLOW = 0.88;
export const TURBO_SPEED = 1.12;

/** Rocket: fast and straight, and it bursts on whoever it reaches. */
export const ROCKET_SPEED = 46;
export const ROCKET_RANGE = 42;
export const ROCKET_BLAST = 3.4;
export const ROCKET_THROW = 5.6;
export const ROCKET_DAMAGE = 18;

/** Seeker: slower, turns after the car it was let go at. */
export const SEEKER_SPEED = 21;
export const SEEKER_TURN = 2.8;
export const SEEKER_LIFE = 4.5;
export const SEEKER_THROW = 4.6;
export const SEEKER_DAMAGE = 14;

/** Mine: arms after a moment, then goes off under the first car near it. */
export const MINE_ARM = 0.7;
export const MINE_LIFE = 25;
export const MINE_TRIGGER = 2.3;
export const MINE_BLAST = 4.6;
export const MINE_THROW = 6;
export const MINE_DAMAGE = 20;

/** Oil: a slick a car slides straight across with no wheel. */
export const OIL_LIFE = 10;
export const OIL_RADIUS = 2.9;
export const OIL_SLIP = 0.8;
export const OIL_DAMAGE = 4;

/** Shock: everyone round the car is thrown outwards. */
export const SHOCK_RADIUS = 7.5;
export const SHOCK_THROW = 5;
export const SHOCK_DAMAGE = 14;

/**
 * Magnet: everyone in reach is yanked to the car's nose. They have their wheel
 * back in `MAGNET_STAGGER`, and the car that pulled them cannot land a blow on
 * them for `MAGNET_LOCK`: the pull sets a fight up, it does not finish one.
 */
export const MAGNET_RADIUS = 9;
export const MAGNET_STOP = 3.2;
export const MAGNET_DAMAGE = 3;
export const MAGNET_STAGGER = 0.3;
export const MAGNET_LOCK = 0.45;

/** Zap: everyone in reach stalls. */
export const ZAP_RADIUS = 9;
export const ZAP_STUN = 0.8;
export const ZAP_DAMAGE = 8;

/** Spring: a hop over anything, and a stomp where it comes down. */
export const SPRING_HEIGHT = 4.2;
export const STOMP_RADIUS = 4;
export const STOMP_THROW = 3.8;
export const STOMP_DAMAGE = 10;

const WEIGHTS: Record<SpecialKind, readonly [front: number, back: number]> = {
  giant: [5, 9],
  magnet: [6, 8],
  mine: [10, 8],
  oil: [10, 8],
  rocket: [9, 11],
  seeker: [5, 10],
  shield: [10, 8],
  shock: [6, 9],
  spring: [9, 8],
  turbo: [10, 9],
  wrench: [8, 9],
  zap: [3, 8],
};

const hash = (a: number, b: number) => {
  const v = Math.sin(a * 127.1 + b * 311.7 + 17.3) * 43_758.5453;

  return v - Math.floor(v);
};

/**
 * What cube `cube` of `round` holds for a car standing `place` of `count`
 * (1 is the leader). The cars at the back are dealt the harder hitters.
 */
export const specialFor: (
  round: number,
  cube: number,
  place: number,
  count: number,
) => SpecialKind = (round, cube, place, count) => {
  const back = count > 1 ? Math.min(1, Math.max(0, (place - 1) / (count - 1))) : 0.5;
  const weigh = (kind: SpecialKind) => WEIGHTS[kind][0] * (1 - back) + WEIGHTS[kind][1] * back;
  let total = 0;

  for (const kind of SPECIALS) {
    total += weigh(kind);
  }

  let roll = hash(round + place * 0.37, cube) * total;

  for (const kind of SPECIALS) {
    roll -= weigh(kind);

    if (roll <= 0) {
      return kind;
    }
  }

  return "turbo";
};
