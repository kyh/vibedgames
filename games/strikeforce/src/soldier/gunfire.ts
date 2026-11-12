import { Vector3 } from "three";

import type { StrikeforceGame } from "../core/types";

const dir = new Vector3();

/** Someone else's shot: a tracer from the muzzle and a flash at it. Sound is the caller's. */
export const showShot = (game: StrikeforceGame, muzzle: Vector3, end: Vector3): void => {
  dir.subVectors(end, muzzle).normalize();
  game.fx.tracer(muzzle, end);
  game.fx.muzzleFlash(muzzle, dir, { scale: 0.8 });
};
