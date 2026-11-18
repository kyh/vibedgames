import { groundHeight } from "../sim/elevation";

export const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));

  return t * t * (3 - 2 * t);
};

/** Render height of the ground at sim-plane (x, y). */
export const terrainHeight = (x: number, y: number) => groundHeight(x, y);
