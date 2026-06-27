import { GRID } from "../shared/constants";
import { type Hill, type LandFactor, Terrain } from "./terrain";

// San Francisco, traced from real geography (DataSF / lat-lon), normalized
// north-up: u = 0 west (Ocean Beach) → 1 east (Bay); v = 0 north (Golden Gate)
// → 1 south (county line). Source: the sf-trace research workflow.

function smooth(x: number, a: number, b: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

// 1 inside the box (soft edges), 0 outside.
function box(u: number, v: number, uMin: number, uMax: number, vMin: number, vMax: number): number {
  const fu = Math.min(smooth(u, uMin - 0.02, uMin + 0.01), 1 - smooth(u, uMax - 0.01, uMax + 0.02));
  const fv = Math.min(smooth(v, vMin - 0.02, vMin + 0.01), 1 - smooth(v, vMax - 0.01, vMax + 0.02));
  return Math.min(fu, fv);
}

// Signed side of the line A→B (>0 on the SE/land side).
function lineSide(u: number, v: number, ax: number, ay: number, bx: number, by: number): number {
  return (bx - ax) * (v - ay) - (by - ay) * (u - ax);
}

// Peninsula coastline: Pacific (W), Golden Gate (N), Bay (E); land to the south.
export const landFactor: LandFactor = (u, v) => {
  let land = Math.min(
    smooth(u, 0.025, 0.06), // Pacific / Ocean Beach (west)
    1 - smooth(u, 0.78, 0.85), // Bay shore (east) ~u0.80
    smooth(v, 0.025, 0.07), // Golden Gate (north)
  );
  // Lands End: the NW corner is ocean (coast bends Lands End→Golden Gate Bridge).
  land = Math.min(land, smooth(lineSide(u, v, 0.03, 0.26, 0.25, 0.03), -0.015, 0.02));
  // East-bay land fingers (jut past the 0.80 shore).
  land = Math.max(land, box(u, v, 0.82, 0.99, 0.7, 0.84)); // Hunters Point
  land = Math.max(land, box(u, v, 0.82, 0.98, 0.87, 0.97)); // Candlestick Point
  // Water inlets bitten into the land.
  land = Math.min(land, 1 - box(u, v, 0.71, 0.8, 0.29, 0.35)); // China Basin / Mission Bay
  land = Math.min(land, 1 - box(u, v, 0.71, 0.82, 0.57, 0.63)); // Islais Creek
  land = Math.min(land, 1 - box(u, v, 0.08, 0.18, 0.72, 0.86)); // Lake Merced (inland)
  return land;
};

export function isLandCell(gx: number, gz: number): boolean {
  return landFactor((gx + 0.5) / GRID, (gz + 0.5) / GRID) > 0.5;
}

// Real SF hills (summit u,v + elevation in metres). Scaled to playable game
// units — steep enough to crest and plunge, not unclimbable.
const HILL_SCALE = 0.052;
const SF_HILLS_M: ReadonlyArray<{ u: number; v: number; m: number; r: number }> = [
  { u: 0.377, v: 0.693, m: 283, r: 0.08 }, // Mount Davidson
  { u: 0.42, v: 0.56, m: 280, r: 0.09 }, // Twin Peaks
  { u: 0.359, v: 0.486, m: 278, r: 0.07 }, // Mount Sutro
  { u: 0.3, v: 0.613, m: 180, r: 0.06 }, // Forest Hill
  { u: 0.457, v: 0.404, m: 175, r: 0.045 }, // Buena Vista
  { u: 0.481, v: 0.434, m: 155, r: 0.04 }, // Corona Heights
  { u: 0.621, v: 0.651, m: 133, r: 0.06 }, // Bernal Heights
  { u: 0.396, v: 0.295, m: 126, r: 0.04 }, // Lone Mountain
  { u: 0.63, v: 0.172, m: 114, r: 0.05 }, // Nob Hill
  { u: 0.489, v: 0.182, m: 112, r: 0.06 }, // Pacific Heights
  { u: 0.726, v: 0.509, m: 91, r: 0.06 }, // Potrero Hill
  { u: 0.602, v: 0.091, m: 90, r: 0.045 }, // Russian Hill
  { u: 0.683, v: 0.082, m: 84, r: 0.035 }, // Telegraph Hill
  { u: 0.778, v: 0.234, m: 33, r: 0.035 }, // Rincon Hill
];
export const SF_HILLS: readonly Hill[] = SF_HILLS_M.map((h) => ({
  u: h.u,
  v: h.v,
  height: h.m * HILL_SCALE,
  radius: h.r,
}));

export function makeTerrain(): Terrain {
  return new Terrain(SF_HILLS, landFactor);
}
