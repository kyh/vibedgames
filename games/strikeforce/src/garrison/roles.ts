// Who the garrison fields, and how the core's tuning reaches them.
//
// The core's Mission/Holdout director was written for machines: it spawns two
// kinds by name — "gull" (many, light) and "hound" (fewer, tough) — and its
// difficulty presets and Holdout waves tune them by writing machine numbers
// into TUNE under those names. The garrison keeps the names as the contract
// and fills the slots with soldiers: a rifleman for a gull, a heavy for a
// hound. It reads the core's numbers as ratios over the machines' baseline,
// so "Hard" or "wave 9" scale a soldier the way they scaled a machine.
import type { EnemyTune } from "../core/types";
import type { Profile } from "../soldier/soldier-brain";

export type Role = "gull" | "hound";

export const roleOf = (type: string): Role => (type === "hound" ? "hound" : "gull");

/** The machines' Standard tuning: what every preset is measured against. */
export const baseTune = (): EnemyTune => ({
  exposureUp: 0.1,
  gull: {
    boltDamage: 7,
    cooldown: [1.9, 3.3],
    hp: 45,
    spreadFar: 0.065,
    spreadNear: 0.018,
    telegraph: 0.55,
  },
  hearRadius: 45,
  hound: {
    burst: 4,
    cooldown: [1.8, 3],
    hp: 140,
    lungeDamage: 15,
    runSpeed: 4.5,
    shotDamage: 5,
    spreadFar: 0.12,
    spreadNear: 0.045,
  },
  maxTokens: 2,
  maxTokensCrowd: 3,
  sightRange: 45,
  tokenGap: 1.25,
});

const BASE = baseTune();

interface RoleDef {
  label: string;
  hp: number;
  profile: Profile;
}

/** Seeing 200 degrees ahead, as the machines did. */
const CONE = Math.cos((100 * Math.PI) / 180);

/** Standard soldiers, before the core's tuning scales them. */
export const ROLES: Record<Role, RoleDef> = {
  gull: {
    hp: 100,
    label: "Rifleman",
    profile: {
      aim: {
        burst: [3, 5],
        cadence: 0.12,
        damage: 8,
        falloff: 0.01,
        headChance: 0.05,
        hit: 0.5,
        minHit: 0.08,
        pause: [0.6, 1.1],
        reaction: [0.4, 0.75],
      },
      gait: { hold: 18, run: 4.4, strafe: 2.2, turn: 5, walk: 1.6 },
      senses: { cone: CONE, lose: 4, range: 45, search: 8 },
    },
  },
  hound: {
    hp: 160,
    label: "Heavy",
    profile: {
      aim: {
        burst: [4, 7],
        cadence: 0.1,
        damage: 7,
        falloff: 0.012,
        headChance: 0.04,
        hit: 0.42,
        minHit: 0.08,
        pause: [0.9, 1.4],
        reaction: [0.5, 0.85],
      },
      gait: { hold: 9, run: 3.6, strafe: 1.6, turn: 4, walk: 1.4 },
      senses: { cone: CONE, lose: 4, range: 45, search: 8 },
    },
  },
};

const mean = (pair: readonly number[]): number =>
  pair.length > 0 ? pair.reduce((a, b) => a + b, 0) / pair.length : 1;

const scalePair = ([lo, hi]: readonly [number, number], k: number): [number, number] => [
  lo * k,
  hi * k,
];

export interface Fielded {
  label: string;
  hp: number;
  profile: Profile;
}

/** A soldier for `role`, scaled by the core's current tuning. */
export const field = (role: Role, tune: EnemyTune): Fielded => {
  const def = ROLES[role];
  const now = tune[role];
  const base = BASE[role];
  const damage =
    role === "gull"
      ? tune.gull.boltDamage / BASE.gull.boltDamage
      : tune.hound.shotDamage / BASE.hound.shotDamage;
  const pace = mean(now.cooldown) / mean(base.cooldown);
  // A tighter spread is a better shot; capped so a soldier never lasers.
  const accuracy = Math.min(1.35, base.spreadFar / now.spreadFar);
  const speed = role === "hound" ? tune.hound.runSpeed / BASE.hound.runSpeed : 1;
  const { aim, gait, senses } = def.profile;
  return {
    hp: Math.round(def.hp * (now.hp / base.hp)),
    label: def.label,
    profile: {
      aim: {
        ...aim,
        damage: aim.damage * damage,
        hit: Math.min(0.85, aim.hit * accuracy),
        pause: scalePair(aim.pause, pace),
      },
      gait: { ...gait, run: gait.run * speed, strafe: gait.strafe * speed },
      senses: { ...senses, range: tune.sightRange },
    },
  };
};
