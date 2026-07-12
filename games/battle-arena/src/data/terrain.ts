// Render-only terrain height. The arena floor is FLAT (so it tiles cleanly with
// no dark gaps); the only elevation is the raised throne platform + its stair
// ramps — a real gameplay level the sim owns (see sim/elevation). Pure +
// deterministic.
//
// This file no longer HAS a height of its own: it forwards to the sim's
// groundHeight() so the ground you see is by construction the ground you walk
// on. (It used to step 0 → 2.0 across a 0.05u band, which teleported units and
// the camera to the top of the stairs.)
//
// HARD RULE: never import this from anything under src/sim/* — that boundary is
// the only thing keeping the sim from depending on the renderer. (CI guard:
// `grep -rn 'data/terrain' src/sim` must be empty.)
import { groundHeight } from "../sim/elevation";

export function smoothstep(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

/** Render height of the ground at sim-plane (x, y). */
export function terrainHeight(x: number, y: number): number {
  return groundHeight(x, y);
}
