// Render-only terrain height. The arena floor is FLAT (so it tiles cleanly with
// no dark gaps); the only elevation is the raised throne platform — a real
// gameplay level the sim owns (see sim/elevation). Pure + deterministic.
//
// HARD RULE: never import this from anything under src/sim/* — that boundary is
// the only thing keeping gameplay on the flat plane. (CI guard: `grep -rn
// 'data/terrain' src/sim` must be empty.)
import { PLATEAU_H, PLATEAU_R } from "../sim/elevation";

// Near-vertical edge: the plateau is a clean raised PLATFORM (stone wall arcs
// + stairways carry the visual) — no sloped skirt half-burying the stairs.
export const PLATEAU_SKIRT = 0.05;

export function smoothstep(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

/** Render height of the ground at sim-plane (x, y): flat everywhere except the
 *  raised throne platform (flat top out to PLATEAU_R, steep skirt to the plaza). */
export function terrainHeight(x: number, y: number): number {
  const r = Math.hypot(x, y);
  return PLATEAU_H * (1 - smoothstep(PLATEAU_R, PLATEAU_R + PLATEAU_SKIRT, r));
}
