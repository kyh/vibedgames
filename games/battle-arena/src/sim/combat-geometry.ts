// Combat hit geometry — the ONE source of truth for the sim's hit tests
// (combat.ts basic cleave, abilities.ts corridor/cone abilities) AND the
// viewer's hit-surface overlay (scenes/viewer-scene.ts). Keeping these here
// means the visualised shape can never drift from the actual damage test.

/** Basic-attack cleave cone half-angle (radians) — a 100° frontal cone. */
export const MELEE_HALF_ANGLE = (5 * Math.PI) / 18;
/** Basic melee reaches attackRange + this (a little cleave overreach). */
export const MELEE_OVERREACH = 1.4;

/** rogue:Q Poison Lunge — corridor half-width along the lunge. */
export const ROGUE_LUNGE_WIDTH = 1.4;
/** rogue:W Rupture — corridor half-width of the gash. */
export const ROGUE_GASH_WIDTH = 1.2;
/** rogue:R Execute — half-arc (radians) it scans for a target in front. */
export const ROGUE_EXECUTE_ARC = (70 * Math.PI) / 180;
