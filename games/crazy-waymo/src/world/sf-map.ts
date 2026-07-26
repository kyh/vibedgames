import { GRID_X, GRID_Z, WORLD_H, WORLD_W } from "../shared/constants";
import { type Hill, type LandFactor, Terrain } from "./terrain";

// THE land mask lives here. tools/sf-data/bake-network.mts imports `landFactor`
// from this file, so the vector street network, the rasterized street mask and
// the runtime grid are clipped by ONE implementation — the grid/vector drift
// this repo keeps re-learning cannot come from the coastline any more.
// (tools/sf-data/lib.mjs keeps a plain-node twin for the .mjs-only extractors,
// which never emit the GEN_ID-stamped pair; change them together.)

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

// Real NE shoreline (Embarcadero), projected from lat/lon through the same
// calibration as the street bake. The old straight u≈0.80 east shore held
// land up to ~1.5 km past the real seawall — downtown met a fictional meadow
// instead of the bay, and no pier placement could ever read as SF's docks.
// [v, shore u] north→south; east of the interpolated line is water.
const EMBARCADERO_SHORE: readonly (readonly [number, number])[] = [
  [0.021, 0.6596], // Pier 39
  [0.0415, 0.7146], // Pier 35
  [0.0838, 0.7458], // Pier 23
  [0.148, 0.7602], // Ferry Building
  [0.2, 0.796], // Bay Bridge anchorage
  [0.2634, 0.8114], // South Beach / Mission Rock
];
function shoreU(v: number): number | null {
  const S = EMBARCADERO_SHORE;
  const first = S[0];
  const last = S[S.length - 1];
  if (!first || !last || v <= first[0] || v >= last[0]) return null;
  let i = 1;
  while (i < S.length - 1 && (S[i]?.[0] ?? 1) < v) i++;
  const a = S[i - 1];
  const b = S[i];
  if (!a || !b) return null;
  const t = (v - a[0]) / (b[0] - a[0] || 1);
  return a[1] + (b[1] - a[1]) * t;
}

function shoreCut(u: number, v: number): number {
  const su = shoreU(v);
  return su === null ? 1 : 1 - smooth(u, su - 0.004, su + 0.008);
}

// South of the Embarcadero's last traced station the bay shore is still
// ENGINEERED, all the way to the county line: Mission Bay's channel walls,
// Dogpatch's quays, the Islais Creek bulkhead, Bayview's rubble revetment,
// the Hunters Point drydocks, Candlestick's riprap. None of it is beach.
const SEAWALL_SOUTH_V = 0.2634;
// East of this the only water at those latitudes is the bay and its two
// creeks; Ocean Beach (u ≈ 0.05) and Lake Merced (u 0.08-0.18) stay natural.
const SEAWALL_EAST_U = 0.6;

// True on engineered waterfront: ground.ts paints a concrete/riprap apron
// there instead of the beach every NATURAL coast gets. Ocean Beach's ~16u of
// dry sand is correct and must keep it; the industrial east shore was getting
// up to 32u of sand where the real shore is bulkhead.
export function seawallShore(u: number, v: number): boolean {
  const su = shoreU(v);
  if (su !== null) return Math.abs(u - su) < 0.02;
  return v > SEAWALL_SOUTH_V && u > SEAWALL_EAST_U;
}

// --- Traced water/land rings ------------------------------------------------
type UVRing = readonly (readonly [number, number])[];
type UVBounds = {
  readonly uMin: number;
  readonly uMax: number;
  readonly vMin: number;
  readonly vMax: number;
};

// Shoreline feather for traced rings, in WORLD units — not uv. Mission Creek
// is ~20u wide, and a uv feather wide enough for the open coast (box() uses
// 0.02 = 63u) would close the channel completely.
const RING_FEATHER = 5;

function ringBounds(ring: UVRing): UVBounds {
  let uMin = Infinity;
  let uMax = -Infinity;
  let vMin = Infinity;
  let vMax = -Infinity;
  for (const [u, v] of ring) {
    uMin = Math.min(uMin, u);
    uMax = Math.max(uMax, u);
    vMin = Math.min(vMin, v);
    vMax = Math.max(vMax, v);
  }
  const pad = RING_FEATHER / Math.min(WORLD_W, WORLD_H);
  return { uMin: uMin - pad, uMax: uMax + pad, vMin: vMin - pad, vMax: vMax + pad };
}

// 1 well inside the ring, 0 well outside, feathered across the bank. The bbox
// reject keeps it free everywhere else — landFactor runs over millions of
// terrain samples.
function ringFactor(u: number, v: number, ring: UVRing, b: UVBounds): number {
  if (u < b.uMin || u > b.uMax || v < b.vMin || v > b.vMax) return 0;
  const px = u * WORLD_W;
  const pz = v * WORLD_H;
  let best = Infinity;
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i];
    const c = ring[j];
    if (!a || !c) continue;
    const ax = a[0] * WORLD_W;
    const az = a[1] * WORLD_H;
    const cx = c[0] * WORLD_W;
    const cz = c[1] * WORLD_H;
    if (az > pz !== cz > pz && px < ((cx - ax) * (pz - az)) / (cz - az) + ax) inside = !inside;
    const dx = cx - ax;
    const dz = cz - az;
    const t = Math.max(
      0,
      Math.min(1, ((px - ax) * dx + (pz - az) * dz) / (dx * dx + dz * dz || 1)),
    );
    const d = Math.hypot(px - (ax + t * dx), pz - (az + t * dz));
    if (d < best) best = d;
  }
  return 1 - smooth(inside ? -best : best, -RING_FEATHER, RING_FEATHER);
}

// MISSION CREEK / CHINA BASIN — the real 70 m tidal channel. The 4-number box
// that stood in for it (u 0.71-0.8 × v 0.29-0.35) is a measured correctness
// bug: against the licensed model's water polygon it flooded 246 dry cells,
// missed 317 wet ones, and culled 268 real building footprints — Oracle Park's
// entire block among them. This is that polygon (same calibration as the street
// bake), RDP-simplified at 4u, with the mouth carried east past the shore so
// the channel opens INTO the bay instead of ponding behind it.
const MISSION_CREEK: UVRing = [
  [0.7804, 0.3358], // mouth, south bank
  [0.7328, 0.3918], // head at 7th & Channel
  [0.7313, 0.393],
  [0.7297, 0.3884],
  [0.7396, 0.3754], // north bank
  [0.7809, 0.327],
  [0.868, 0.3255], // carried out into the bay
  [0.868, 0.3375],
];
const MISSION_CREEK_BOUNDS = ringBounds(MISSION_CREEK);

// YERBA BUENA ISLAND (+ Treasure Island, which is landfill welded to its north
// shore). One landmass on the Bay Bridge's TRUE 40.5° line — the bridge's west
// crossing lands here at u 0.934 / v 0.015. Only Yerba Buena's southern two
// thirds are on-map: the isthmus and all of Treasure Island sit north of v = 0,
// so the ellipse is elongated northward and runs off the border rather than
// showing a shore just outside it.
const YERBA_BUENA = { u: 0.938, v: -0.005, ru: 95, rv: 190 } as const;

// Radial landmass, in world units so islands stay round on the rectangular map.
function isle(u: number, v: number, c: { u: number; v: number; ru: number; rv: number }): number {
  const du = ((u - c.u) * WORLD_W) / c.ru;
  const dv = ((v - c.v) * WORLD_H) / c.rv;
  return 1 - smooth(Math.hypot(du, dv), 0.72, 1);
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
  // The real Embarcadero seawall (see EMBARCADERO_SHORE above).
  land = Math.min(land, shoreCut(u, v));
  // East-bay land fingers (jut past the 0.80 shore).
  land = Math.max(land, box(u, v, 0.82, 0.99, 0.7, 0.84)); // Hunters Point
  land = Math.max(land, box(u, v, 0.82, 0.98, 0.87, 0.97)); // Candlestick Point
  // Water inlets bitten into the land.
  land = Math.min(land, 1 - ringFactor(u, v, MISSION_CREEK, MISSION_CREEK_BOUNDS));
  land = Math.min(land, 1 - box(u, v, 0.71, 0.82, 0.57, 0.63)); // Islais Creek
  land = Math.min(land, 1 - box(u, v, 0.08, 0.18, 0.72, 0.86)); // Lake Merced (inland)
  // Yerba Buena / Treasure Island: its own landmass out in the bay, so it goes
  // on with max() after every peninsula cut (same rule as Marin below).
  land = Math.max(land, isle(u, v, YERBA_BUENA));
  // Marin headlands: a strip of far-shore land inside the north edge so the
  // Golden Gate DELIVERS somewhere — Battery Ridge, the overlook turnaround.
  // Applied after every peninsula cut (max: it is its own landmass).
  land = Math.max(land, box(u, v, 0.17, 0.36, -0.2, 0.016));
  return land;
};

export function isLandCell(gx: number, gz: number): boolean {
  return landFactor((gx + 0.5) / GRID_X, (gz + 0.5) / GRID_Z) > 0.5;
}

// Real SF hills (summit u,v + elevation in metres). Scaled to playable game
// units — steep enough to crest and plunge, not unclimbable.
// metres → game units. Hill radii are map fractions, so growing the map's
// linear size flattens every slope unless heights grow with it — slope feel is
// height/(radius·world). At the 244×200 map, 0.15 left Twin Peaks a ~12% grade
// (SF's steep streets are 25-30%); 0.38 restores the crest-and-plunge and the
// hill jumps. ~2× vertical exaggeration vs real SF, which reads right in-game.
const HILL_SCALE = 0.38;
// `green`: forest/parkland hills in real SF (Sutro's eucalyptus, Twin Peaks
// scrub, Bernal's grass dome) — their flanks render grass instead of bare
// concrete. The built-up hills (Nob, Russian, Pacific Heights…) stay urban.
const SF_HILLS_M: ReadonlyArray<{ u: number; v: number; m: number; r: number; green?: true }> = [
  { u: 0.377, v: 0.693, m: 283, r: 0.08, green: true }, // Mount Davidson
  { u: 0.42, v: 0.56, m: 280, r: 0.09, green: true }, // Twin Peaks
  { u: 0.359, v: 0.486, m: 278, r: 0.07, green: true }, // Mount Sutro
  { u: 0.3, v: 0.613, m: 180, r: 0.06, green: true }, // Forest Hill
  { u: 0.457, v: 0.404, m: 175, r: 0.045, green: true }, // Buena Vista
  { u: 0.481, v: 0.434, m: 155, r: 0.04, green: true }, // Corona Heights
  { u: 0.621, v: 0.651, m: 133, r: 0.06, green: true }, // Bernal Heights
  { u: 0.396, v: 0.295, m: 126, r: 0.04, green: true }, // Lone Mountain (USF green)
  { u: 0.63, v: 0.172, m: 114, r: 0.05 }, // Nob Hill
  { u: 0.489, v: 0.182, m: 112, r: 0.06 }, // Pacific Heights
  { u: 0.726, v: 0.509, m: 91, r: 0.06 }, // Potrero Hill
  { u: 0.602, v: 0.091, m: 90, r: 0.045 }, // Russian Hill
  { u: 0.683, v: 0.082, m: 84, r: 0.035 }, // Telegraph Hill
  { u: 0.778, v: 0.234, m: 33, r: 0.035 }, // Rincon Hill
  // The south and west used to be a pancake: no Bayview ridge, no McLaren
  // knolls, and — the reason the Sunset read as flat suburb — no Golden Gate
  // Heights. Elevations are the real summits; radii are the real footprints
  // (r · 2886 · 4.446 ≈ metres), EXCEPT where a summit stands on an existing
  // hill's flank. Hill Gaussians SUM, so a spur has to be entered at its
  // PROMINENCE, not its sea-level height: Tank Hill's 198 m on top of the
  // Twin Peaks flank already there would put it at 600 m.
  { u: 0.26, v: 0.533, m: 203, r: 0.055, green: true }, // Grand View / Golden Gate Heights
  { u: 0.202, v: 0.16, m: 122, r: 0.038, green: true }, // Rob Hill (the Presidio's high point)
  { u: 0.252, v: 0.398, m: 131, r: 0.034, green: true }, // Strawberry Hill (Stow Lake)
  { u: 0.423, v: 0.494, m: 45, r: 0.032, green: true }, // Tank Hill (prominence over Twin Peaks)
  { u: 0.518, v: 0.686, m: 91, r: 0.028, green: true }, // Billy Goat Hill
  { u: 0.624, v: 0.859, m: 150, r: 0.05, green: true }, // McLaren Park, west knoll
  { u: 0.66, v: 0.874, m: 120, r: 0.04, green: true }, // McLaren Park, east knoll
  { u: 0.768, v: 0.907, m: 134, r: 0.042, green: true }, // Bayview Hill
  { u: 0.843, v: 0.78, m: 65, r: 0.032 }, // Hunters Point ridge (shipyard, stays urban)
  { u: 0.938, v: 0.012, m: 103, r: 0.03, green: true }, // Yerba Buena Island (eucalyptus)
  // The Daly City rim. Crests sit just off-map south (v > 1) for the same
  // reason Battery Ridge's do: inside the border the ground slopes UP to the
  // edge, so the wall reads as the ridge behind Guadalupe Canyon.
  { u: 0.3, v: 1.008, m: 150, r: 0.06 },
  { u: 0.47, v: 1.008, m: 170, r: 0.065 },
  // Battery Ridge (Marin headlands): five overlapping summits form one ridge
  // across the bridge's landing strip. Crests sit just off-map north (v < 0)
  // so inside the border the ground always slopes UP toward the edge — the
  // border wall reads as ridge, not invisible wall. Kept low enough (~12-15u)
  // that the grass climb from the bridge deck (y≈7) to the overlook drives.
  { u: 0.195, v: -0.006, m: 30, r: 0.026, green: true },
  { u: 0.235, v: -0.002, m: 38, r: 0.03, green: true },
  { u: 0.27, v: -0.005, m: 36, r: 0.03, green: true },
  { u: 0.305, v: -0.002, m: 39, r: 0.03, green: true },
  { u: 0.34, v: -0.007, m: 29, r: 0.026, green: true },
];
export const SF_HILLS: readonly Hill[] = SF_HILLS_M.map((h) => ({
  u: h.u,
  v: h.v,
  height: h.m * HILL_SCALE,
  radius: h.r,
}));

const GREEN_HILLS = SF_HILLS_M.filter((h) => h.green);

/** 0..1 forest-cover weight at map fraction (u,v). Mirrors the terrain height
 *  field's gaussian exactly (world-unit distances, MAP_REF radii), so the
 *  green cover tracks each hill's actual rendered shape. */
export function greenHillWeightAt(u: number, v: number): number {
  const mapRef = (WORLD_W + WORLD_H) / 2;
  let w = 0;
  for (const h of GREEN_HILLS) {
    const du = (u - h.u) * WORLD_W;
    const dv = (v - h.v) * WORLD_H;
    const r = h.r * mapRef;
    w += Math.exp(-(du * du + dv * dv) / (r * r * 0.5));
  }
  // The gaussian tail covers the whole map — gate it so streetside concrete
  // stays concrete and only real hill flanks turn green.
  const t = (w - 0.3) / (0.75 - 0.3);
  const c = t < 0 ? 0 : t > 1 ? 1 : t;
  return c * c * (3 - 2 * c);
}

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
  commercial: 0.5,
  wharf: 0.42,
  residential: 0.55,
  victorian: 0.62,
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
  // Marin side of the Golden Gate. NOT character "park" — that would invite
  // the park-tile furniture machinery onto the headland; it stays wild grass.
  {
    name: "Battery Ridge Overlook",
    character: "residential",
    color: 0x93a06b,
    uMin: 0.16,
    uMax: 0.37,
    vMin: 0,
    vMax: 0.026,
  },
  // Yerba Buena Island. NOT character "park" for the same reason Battery Ridge
  // is not: the park-tile machinery would move onto a wooded island the player
  // only ever sees from the bridge deck.
  {
    name: "Yerba Buena Island",
    character: "residential",
    color: 0x8a9a72,
    uMin: 0.905,
    uMax: 0.975,
    vMin: 0,
    vMax: 0.06,
  },
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
  // Chinatown sits NORTH of Union Square. It used to be entered as the whole
  // 0.15-0.225 band, which fully contained the Union Square box below it, and
  // districtAt is first-inside-wins — so Union Square (and its
  // PACKED_COMMERCIAL frontage rule) was dead code.
  {
    name: "Chinatown",
    character: "commercial",
    color: 0xc8442b,
    uMin: 0.645,
    uMax: 0.7,
    vMin: 0.15,
    vMax: 0.19,
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
    vMin: 0.6,
    vMax: 0.77,
  },
  // --- Gap fill: every drivable cell should announce a real neighborhood ---
  {
    name: "Union Square",
    character: "commercial",
    color: 0xc98a3c,
    uMin: 0.645,
    uMax: 0.7,
    vMin: 0.19,
    vMax: 0.225,
  },
  {
    name: "Mission Bay",
    character: "highrise",
    color: 0x7c98ac,
    uMin: 0.7,
    uMax: 0.79,
    vMin: 0.42,
    vMax: 0.47,
  },
  {
    name: "Potrero Hill",
    character: "residential",
    color: 0xc2a878,
    uMin: 0.69,
    uMax: 0.77,
    vMin: 0.45,
    vMax: 0.6,
  },
  {
    name: "Noe Valley",
    character: "victorian",
    color: 0x7ca8c2,
    uMin: 0.49,
    uMax: 0.575,
    vMin: 0.55,
    vMax: 0.65,
  },
  {
    name: "Twin Peaks",
    character: "park",
    color: 0x2e6f4e,
    uMin: 0.39,
    uMax: 0.46,
    vMin: 0.52,
    vMax: 0.6,
  },
  {
    name: "Glen Park",
    character: "residential",
    color: 0x94ab88,
    uMin: 0.47,
    uMax: 0.575,
    vMin: 0.65,
    vMax: 0.73,
  },
  {
    name: "West Portal",
    character: "commercial",
    color: 0xd0a06a,
    uMin: 0.3,
    uMax: 0.42,
    vMin: 0.6,
    vMax: 0.68,
  },
  {
    name: "Miraloma Park",
    character: "residential",
    color: 0xb3bda0,
    uMin: 0.36,
    uMax: 0.47,
    vMin: 0.6,
    vMax: 0.67,
  },
  {
    name: "Ingleside",
    character: "residential",
    color: 0xc0b394,
    uMin: 0.3,
    uMax: 0.5,
    vMin: 0.79,
    vMax: 0.94,
  },
  {
    name: "Lakeshore",
    character: "residential",
    color: 0xa8bcae,
    uMin: 0.05,
    uMax: 0.3,
    vMin: 0.79,
    vMax: 0.97,
  },
  {
    name: "the Outer Mission",
    character: "residential",
    color: 0xc7a98c,
    uMin: 0.5,
    uMax: 0.575,
    vMin: 0.73,
    vMax: 0.89,
  },
  {
    name: "the Excelsior",
    character: "residential",
    color: 0xd0b184,
    uMin: 0.575,
    uMax: 0.66,
    vMin: 0.77,
    vMax: 0.9,
  },
  {
    name: "the Portola",
    character: "residential",
    color: 0xb8ab7c,
    uMin: 0.66,
    uMax: 0.76,
    vMin: 0.72,
    vMax: 0.82,
  },
  {
    name: "Bayview",
    character: "industrial",
    color: 0xa87850,
    uMin: 0.72,
    uMax: 0.84,
    vMin: 0.6,
    vMax: 0.76,
  },
  {
    name: "Hunters Point",
    character: "industrial",
    color: 0x97694a,
    uMin: 0.8,
    uMax: 0.99,
    vMin: 0.66,
    vMax: 0.86,
  },
  {
    name: "Visitacion Valley",
    character: "residential",
    color: 0xbfae88,
    uMin: 0.64,
    uMax: 0.8,
    vMin: 0.82,
    vMax: 1.0,
  },
  {
    name: "Crocker-Amazon",
    character: "residential",
    color: 0xb2a487,
    uMin: 0.5,
    uMax: 0.64,
    vMin: 0.89,
    vMax: 1.0,
  },
  {
    name: "Mission Dolores",
    character: "victorian",
    color: 0xd88a6a,
    uMin: 0.48,
    uMax: 0.66,
    vMin: 0.37,
    vMax: 0.44,
  },
  {
    name: "Cole Valley",
    character: "residential",
    color: 0xa9bfa2,
    uMin: 0.4,
    uMax: 0.47,
    vMin: 0.44,
    vMax: 0.55,
  },
  {
    name: "Sunnyside",
    character: "residential",
    color: 0xb9b78e,
    uMin: 0.42,
    uMax: 0.5,
    vMin: 0.67,
    vMax: 0.8,
  },
  {
    name: "Silver Terrace",
    character: "residential",
    color: 0xbc9a72,
    uMin: 0.675,
    uMax: 0.73,
    vMin: 0.6,
    vMax: 0.73,
  },
  {
    name: "Jackson Square",
    character: "commercial",
    color: 0xc09060,
    uMin: 0.685,
    uMax: 0.78,
    vMin: 0.06,
    vMax: 0.12,
  },
  {
    name: "China Basin",
    character: "wharf",
    color: 0x5b86a0,
    uMin: 0.775,
    uMax: 0.86,
    vMin: 0.33,
    vMax: 0.47,
  },
  {
    name: "Daly City",
    character: "residential",
    color: 0xc4bda6,
    uMin: 0.18,
    uMax: 0.5,
    vMin: 0.92,
    vMax: 1.0,
  },
];

export function districtAt(gx: number, gz: number): District {
  const u = (gx + 0.5) / GRID_X;
  const v = (gz + 0.5) / GRID_Z;
  let best: Box | null = null;
  let bd = Infinity;
  for (const n of NEIGHBORHOODS) {
    if (u >= n.uMin && u <= n.uMax && v >= n.vMin && v <= n.vMax) {
      return { name: n.name, character: n.character, color: n.color };
    }
    // Distance to the box (0 inside) — slivers between traced boxes adopt
    // their nearest real neighborhood instead of a generic fallback label.
    const du = Math.max(n.uMin - u, 0, u - n.uMax);
    const dv = Math.max(n.vMin - v, 0, v - n.vMax);
    const d = du * du + dv * dv;
    if (d < bd) {
      bd = d;
      best = n;
    }
  }
  if (best) return { name: best.name, character: best.character, color: best.color };
  return { name: "San Francisco", character: "residential", color: 0xbfc6c2 };
}
