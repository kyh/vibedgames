import { PUCK_RANGE, PUCK_SPEED } from "./kinds";
import {
  MINE_LIFE,
  OIL_LIFE,
  ROCKET_RANGE,
  ROCKET_SPEED,
  SEEKER_LIFE,
  SEEKER_SPEED,
  SEEKER_TURN,
} from "./specials";

/** Things a car lets go of that then live on the board by themselves. */
export const SHOT_KINDS = ["puck", "rocket", "seeker", "mine", "oil"] as const;

export type ShotKind = (typeof SHOT_KINDS)[number];

export interface Shot {
  /** Unique in the room: its owner's key, the round and a count. */
  id: string;
  kind: ShotKind;
  /** The car that let it go. */
  by: string;
  /** Where, which way and when (seconds into the round) it was let go. */
  x0: number;
  z0: number;
  a0: number;
  t0: number;
  /** Where it is now and which way it points. */
  x: number;
  z: number;
  a: number;
  /** The car a seeker is after. */
  target: string;
  /** Its owner's power, for a puck. */
  power: number;
  /** Simulated here: this client decides what it hits. */
  own: boolean;
  dead: boolean;
}

export const makeShot: (
  id: string,
  kind: ShotKind,
  by: string,
  at: { x: number; z: number; a: number; t: number },
  own: boolean,
) => Shot = (id, kind, by, at, own) => ({
  a: at.a,
  a0: at.a,
  by,
  dead: false,
  id,
  kind,
  own,
  power: 1,
  t0: at.t,
  target: "",
  x: at.x,
  x0: at.x,
  z: at.z,
  z0: at.z,
});

const wrapAngle = (a: number) => {
  const turn = Math.PI * 2;
  const r = ((a % turn) + turn) % turn;

  return r > Math.PI ? r - turn : r;
};

/** Seconds a shot lasts if it meets nothing. */
export const shotLife = (kind: ShotKind) => {
  if (kind === "puck") {
    return PUCK_RANGE / PUCK_SPEED;
  }

  if (kind === "rocket") {
    return ROCKET_RANGE / ROCKET_SPEED;
  }

  if (kind === "seeker") {
    return SEEKER_LIFE;
  }

  return kind === "mine" ? MINE_LIFE : OIL_LIFE;
};

/**
 * Move a shot to where it is at `time`. A puck and a rocket fly straight from
 * where they were let go; a seeker turns after `prey`, if it has one.
 */
export const moveShot = (
  shot: Shot,
  time: number,
  dt: number,
  prey: { x: number; z: number } | null,
) => {
  const age = time - shot.t0;

  if (shot.kind === "puck" || shot.kind === "rocket") {
    const speed = shot.kind === "puck" ? PUCK_SPEED : ROCKET_SPEED;
    shot.x = shot.x0 + Math.cos(shot.a0) * speed * age;
    shot.z = shot.z0 + Math.sin(shot.a0) * speed * age;
  } else if (shot.kind === "seeker") {
    if (prey) {
      const off = wrapAngle(Math.atan2(prey.z - shot.z, prey.x - shot.x) - shot.a);
      const most = SEEKER_TURN * dt;
      shot.a = wrapAngle(shot.a + Math.min(most, Math.max(-most, off)));
    }

    shot.x += Math.cos(shot.a) * SEEKER_SPEED * dt;
    shot.z += Math.sin(shot.a) * SEEKER_SPEED * dt;
  }

  return age;
};
