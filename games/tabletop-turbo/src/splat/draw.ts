// Puts a baked model on stage for one frame: every splat of the template is
// turned, squashed and moved on the CPU into the stage's moving set. Models are
// a few hundred splats, so a whole grid of karts costs a few thousand copies.

import { TEAM_RAMP } from "./palette";
import type { SplatSet } from "./splat-set";

export interface Placement {
  x: number;
  y: number;
  z: number;
  /** Heading: turns the model's +x towards +z. */
  yaw: number;
  /** Lean about the model's length, and nose-up tilt. */
  roll?: number;
  pitch?: number;
  scale?: number;
  /** Extra vertical squash on top of `scale`. */
  squash?: number;
  /** The ramp that replaces the template's team colour. */
  ramp?: number;
  /** Draw every part in `ramp`, whatever it was baked in: a silhouette. */
  mono?: boolean;
}

const M = new Float32Array(9);

/** Rotation for a placement: heading, then pitch about the cross axis, then roll about the length. */
const orient = (yaw: number, roll: number, pitch: number): void => {
  const cy = Math.cos(yaw);
  const sy = Math.sin(yaw);
  const cr = Math.cos(roll);
  const sr = Math.sin(roll);
  const cp = Math.cos(pitch);
  const sp = Math.sin(pitch);
  // Columns of (yaw · pitch · roll), where pitch turns x towards y and roll turns y towards z.
  M[0] = cy * cp;
  M[1] = sp;
  M[2] = sy * cp;
  M[3] = -cy * sp * cr - sy * sr;
  M[4] = cp * cr;
  M[5] = -sy * sp * cr + cy * sr;
  M[6] = cy * sp * sr - sy * cr;
  M[7] = -cp * sr;
  M[8] = sy * sp * sr + cy * cr;
};

const m = (i: number): number => M[i] ?? 0;

export const drawSplats = (out: SplatSet, model: SplatSet, place: Placement): void => {
  orient(place.yaw, place.roll ?? 0, place.pitch ?? 0);
  const scale = place.scale ?? 1;
  const tall = scale * (place.squash ?? 1);
  const team = place.ramp ?? 0;
  for (let i = 0; i < model.count; i += 1) {
    const x = (model.centers[i * 3] ?? 0) * scale;
    const y = (model.centers[i * 3 + 1] ?? 0) * tall;
    const z = (model.centers[i * 3 + 2] ?? 0) * scale;
    const nx = (model.normals[i * 4] ?? 0) / 127;
    const ny = (model.normals[i * 4 + 1] ?? 0) / 127;
    const nz = (model.normals[i * 4 + 2] ?? 0) / 127;
    const ramp = model.data[i * 4 + 1] ?? 0;
    out.push(
      place.x + m(0) * x + m(3) * y + m(6) * z,
      place.y + m(1) * x + m(4) * y + m(7) * z,
      place.z + m(2) * x + m(5) * y + m(8) * z,
      m(0) * nx + m(3) * ny + m(6) * nz,
      m(1) * nx + m(4) * ny + m(7) * nz,
      m(2) * nx + m(5) * ny + m(8) * nz,
      ((model.data[i * 4] ?? 0) / 100) * scale,
      (place.mono === true || ramp === TEAM_RAMP ? team : ramp) * 8 + (model.data[i * 4 + 2] ?? 0),
      model.data[i * 4 + 3] ?? 0,
    );
  }
};
