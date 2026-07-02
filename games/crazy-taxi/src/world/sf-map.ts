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
// metres → game units. Hill radii are map fractions, so doubling the map's
// linear size would halve every slope — heights scale up with it to keep the
// crest-and-plunge feel.
const HILL_SCALE = 0.15;
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

// --- Neighborhoods (traced (u,v) boxes from the research) ---
export type DistrictChar =
  | "downtown"
  | "highrise"
  | "commercial"
  | "wharf"
  | "residential"
  | "victorian"
  | "industrial"
  | "park";

export type District = {
  readonly name: string;
  readonly character: DistrictChar;
  readonly color: number;
};

// Building tint palettes per district character. Each building picks one color
// so streets read as a mixed row, not a monotone block. SF pastels for the
// residential west, saturated victorians for the Mission/Haight, cool glass
// and stone downtown.
const PALETTES: Record<DistrictChar, readonly number[]> = {
  downtown: [0xbfc4c9, 0xa8b2ba, 0xcfc9bd, 0x9aa7b2, 0xd8d2c4],
  highrise: [0x9fb2c4, 0x8ea3b8, 0xb8c4cf, 0xa2afb8, 0xc4cdd6],
  commercial: [0xd8b48a, 0xc9917a, 0xb5384a, 0xd89a5c, 0xe0c9a0, 0x8fae9e],
  wharf: [0xd6cfc0, 0x9fb4bf, 0xc9b68f, 0xb5384a, 0xdde2e4],
  residential: [0xf2e3d5, 0xf6c8d4, 0xcfe3dd, 0xf2e0b0, 0xdfd7ea, 0xe8d0b8],
  victorian: [0xe0564b, 0x8e4fa8, 0x2f9e8f, 0xf6c8d4, 0xe8b458, 0x6f8fc9],
  industrial: [0xa8623e, 0x8f7a5f, 0xb08968, 0x7f8a8f, 0xa89078],
  park: [0xe8e0cc, 0xd8cfb8, 0xcfc4a8],
};

// Tint strength per character — victorians get bold paint, glass stays subtle.
const TINT_AMOUNT: Record<DistrictChar, number> = {
  downtown: 0.28,
  highrise: 0.22,
  commercial: 0.4,
  wharf: 0.38,
  residential: 0.5,
  victorian: 0.58,
  industrial: 0.4,
  park: 0.35,
};

export function paletteFor(d: District): readonly number[] {
  return PALETTES[d.character];
}
export function tintAmountFor(d: District): number {
  return TINT_AMOUNT[d.character];
}

type Box = District & {
  readonly uMin: number;
  readonly uMax: number;
  readonly vMin: number;
  readonly vMax: number;
};

const NEIGHBORHOODS: readonly Box[] = [
  // Real SF green spaces (traced): the 4× map has room for the small parks.
  {
    name: "Dolores Park",
    character: "park",
    color: 0x3c8147,
    uMin: 0.555,
    uMax: 0.585,
    vMin: 0.46,
    vMax: 0.5,
  },
  {
    name: "Buena Vista Park",
    character: "park",
    color: 0x2e6f4e,
    uMin: 0.445,
    uMax: 0.475,
    vMin: 0.395,
    vMax: 0.425,
  },
  {
    name: "Mount Davidson Park",
    character: "park",
    color: 0x2e6f4e,
    uMin: 0.355,
    uMax: 0.4,
    vMin: 0.67,
    vMax: 0.715,
  },
  {
    name: "McLaren Park",
    character: "park",
    color: 0x3c8147,
    uMin: 0.63,
    uMax: 0.72,
    vMin: 0.79,
    vMax: 0.87,
  },
  {
    name: "the Panhandle",
    character: "park",
    color: 0x3c8147,
    uMin: 0.4,
    uMax: 0.475,
    vMin: 0.36,
    vMax: 0.385,
  },
  {
    name: "the Presidio",
    character: "park",
    color: 0x2e6f4e,
    uMin: 0.2,
    uMax: 0.41,
    vMin: 0.03,
    vMax: 0.21,
  },
  {
    name: "the Marina",
    character: "residential",
    color: 0xc9d6df,
    uMin: 0.42,
    uMax: 0.56,
    vMin: 0.02,
    vMax: 0.13,
  },
  {
    name: "Fisherman's Wharf",
    character: "wharf",
    color: 0x356a8a,
    uMin: 0.56,
    uMax: 0.685,
    vMin: 0,
    vMax: 0.07,
  },
  {
    name: "Russian Hill",
    character: "residential",
    color: 0x9cae86,
    uMin: 0.575,
    uMax: 0.645,
    vMin: 0.07,
    vMax: 0.155,
  },
  {
    name: "North Beach",
    character: "commercial",
    color: 0xb5384a,
    uMin: 0.645,
    uMax: 0.7,
    vMin: 0.07,
    vMax: 0.15,
  },
  {
    name: "the Financial District",
    character: "highrise",
    color: 0x9aa7b2,
    uMin: 0.7,
    uMax: 0.775,
    vMin: 0.11,
    vMax: 0.225,
  },
  {
    name: "the Embarcadero",
    character: "wharf",
    color: 0x4a7c9b,
    uMin: 0.775,
    uMax: 0.85,
    vMin: 0.07,
    vMax: 0.33,
  },
  {
    name: "Chinatown",
    character: "commercial",
    color: 0xc8442b,
    uMin: 0.645,
    uMax: 0.7,
    vMin: 0.15,
    vMax: 0.225,
  },
  {
    name: "Nob Hill",
    character: "residential",
    color: 0x8c7b9e,
    uMin: 0.575,
    uMax: 0.645,
    vMin: 0.155,
    vMax: 0.225,
  },
  {
    name: "Pacific Heights",
    character: "residential",
    color: 0xd8c7a8,
    uMin: 0.42,
    uMax: 0.575,
    vMin: 0.13,
    vMax: 0.245,
  },
  {
    name: "SoMa",
    character: "highrise",
    color: 0xa87c53,
    uMin: 0.66,
    uMax: 0.775,
    vMin: 0.225,
    vMax: 0.42,
  },
  {
    name: "Dogpatch",
    character: "industrial",
    color: 0xa8623e,
    uMin: 0.77,
    uMax: 0.85,
    vMin: 0.45,
    vMax: 0.57,
  },
  {
    name: "Alamo Square",
    character: "victorian",
    color: 0xe7b5c6,
    uMin: 0.44,
    uMax: 0.555,
    vMin: 0.245,
    vMax: 0.37,
  },
  {
    name: "Hayes Valley",
    character: "commercial",
    color: 0xd89a5c,
    uMin: 0.555,
    uMax: 0.595,
    vMin: 0.245,
    vMax: 0.375,
  },
  {
    name: "Civic Center",
    character: "downtown",
    color: 0xbfa75e,
    uMin: 0.595,
    uMax: 0.66,
    vMin: 0.225,
    vMax: 0.37,
  },
  {
    name: "the Richmond",
    character: "residential",
    color: 0xb6c2bc,
    uMin: 0.03,
    uMax: 0.42,
    vMin: 0.21,
    vMax: 0.36,
  },
  {
    name: "Golden Gate Park",
    character: "park",
    color: 0x3c8147,
    uMin: 0.03,
    uMax: 0.4,
    vMin: 0.36,
    vMax: 0.44,
  },
  {
    name: "the Sunset",
    character: "residential",
    color: 0xc6ccc6,
    uMin: 0.02,
    uMax: 0.4,
    vMin: 0.44,
    vMax: 0.79,
  },
  {
    name: "the Haight",
    character: "victorian",
    color: 0x8e4fa8,
    uMin: 0.4,
    uMax: 0.48,
    vMin: 0.37,
    vMax: 0.44,
  },
  {
    name: "the Mission",
    character: "victorian",
    color: 0xe0564b,
    uMin: 0.575,
    uMax: 0.69,
    vMin: 0.42,
    vMax: 0.6,
  },
  {
    name: "the Castro",
    character: "commercial",
    color: 0xd14e9b,
    uMin: 0.46,
    uMax: 0.555,
    vMin: 0.44,
    vMax: 0.55,
  },
  {
    name: "Bernal Heights",
    character: "residential",
    color: 0x9db07c,
    uMin: 0.575,
    uMax: 0.675,
    vMin: 0.63,
    vMax: 0.77,
  },
];

const DEFAULT_DISTRICT: District = {
  name: "San Francisco",
  character: "residential",
  color: 0xbfc6c2,
};

export function districtAt(gx: number, gz: number): District {
  const u = (gx + 0.5) / GRID;
  const v = (gz + 0.5) / GRID;
  for (const n of NEIGHBORHOODS) {
    if (u >= n.uMin && u <= n.uMax && v >= n.vMin && v <= n.vMax) {
      return { name: n.name, character: n.character, color: n.color };
    }
  }
  return DEFAULT_DISTRICT;
}
