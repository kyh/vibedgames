import { GRID_X, GRID_Z, WORLD_H, WORLD_W } from "../shared/constants";
import { Terrain } from "./terrain";
import type { Hill, LandFactor } from "./terrain";
import { stowBasinHeight } from "./lake";

// THE land mask lives here. tools/sf-data/bake-network.mts imports `landFactor`
// from this file, so the vector street network, the rasterized street mask and
// the runtime grid are clipped by ONE implementation — the grid/vector drift
// this repo keeps re-learning cannot come from the coastline any more.
// (tools/sf-data/lib.mjs keeps a plain-node twin for the .mjs-only extractors,
// which never emit the GEN_ID-stamped pair; change them together.)

// San Francisco, traced from real geography (DataSF / lat-lon), normalized
// north-up: u = 0 west (Ocean Beach) → 1 east (Bay); v = 0 north (Golden Gate)
// → 1 south (county line). Source: the sf-trace research workflow.

const smooth = (x: number, a: number, b: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

// 1 inside the box (soft edges), 0 outside.
const box = (
  u: number,
  v: number,
  uMin: number,
  uMax: number,
  vMin: number,
  vMax: number,
): number => {
  const fu = Math.min(smooth(u, uMin - 0.02, uMin + 0.01), 1 - smooth(u, uMax - 0.01, uMax + 0.02));
  const fv = Math.min(smooth(v, vMin - 0.02, vMin + 0.01), 1 - smooth(v, vMax - 0.01, vMax + 0.02));
  return Math.min(fu, fv);
};

// Signed side of the line A→B (>0 on the SE/land side).
const lineSide = (u: number, v: number, ax: number, ay: number, bx: number, by: number): number =>
  (bx - ax) * (v - ay) - (by - ay) * (u - ax);

// A traced coast is a list of [along, across] stations: linear between them,
// null off either end (the caller decides what "off the traced run" means).
// Shared by all three coastlines below so a station list can never be walked
// two slightly different ways.
type Stations = readonly (readonly [number, number])[];
const stationAt = (S: Stations, x: number): number | null => {
  const [first] = S;
  const last = S.at(-1);
  if (!first || !last || x <= first[0] || x >= last[0]) {
    return null;
  }
  let i = 1;
  while (i < S.length - 1 && (S[i]?.[0] ?? 1) < x) {
    i += 1;
  }
  const a = S[i - 1];
  const b = S[i];
  if (!a || !b) {
    return null;
  }
  const t = (x - a[0]) / (b[0] - a[0] || 1);
  return a[1] + (b[1] - a[1]) * t;
};

// Real NE shoreline (Embarcadero), projected from lat/lon through the same
// calibration as the street bake. The old straight u≈0.80 east shore held
// land up to ~1.5 km past the real seawall — downtown met a fictional meadow
// instead of the bay, and no pier placement could ever read as SF's docks.
// [v, shore u] north→south; east of the interpolated line is water.
const EMBARCADERO_SHORE: Stations = [
  // Pier 39
  [0.021, 0.6596],
  // Pier 35
  [0.0415, 0.7146],
  // Pier 23
  [0.0838, 0.7458],
  // Ferry Building
  [0.148, 0.7602],
  // Bay Bridge anchorage
  [0.2, 0.796],
  // South Beach / Mission Rock
  [0.2634, 0.8114],
];
const shoreU = (v: number): number | null => stationAt(EMBARCADERO_SHORE, v);

const shoreCut = (u: number, v: number): number => {
  const su = shoreU(v);
  return su === null ? 1 : 1 - smooth(u, su - 0.004, su + 0.008);
};

// --- The Golden Gate ------------------------------------------------------
//
// THE STRAIT IS A LANDMARK, NOT A CHANNEL. Away from it the north coast is one
// latitude — the Marina seawall at v ≈ 0.0475, which is where the whole north
// edge used to sit. That left ~70u (310 m) of water between the Presidio and
// the Marin strip, so BOTH of the bridge's towers stood on dry shore, the main
// cable had nothing to sag across, and the crossing read as a red gantry over a
// river. The real strait is ~1,600 m ≈ 360u here, and it does not fit: the
// calibration puts Lime Point at v = -0.13 (348u off the top of the map) and
// the drivable Marin landing plus the Battery Ridge overlook need every metre
// of the strip that IS on-map.
//
// So the water comes out of the Presidio's flat, empty north edge instead. The
// shore is pulled south across the strait's whole mouth — under 1% of the
// street network lives there, the ground is a featureless 0.3u plain, and the
// coast it leaves behind (a cove opening east toward the Palace of Fine Arts,
// merging west into the Lands End diagonal) is the shape the strait mouth
// actually has. [u, shore v] west→east; north of the interpolated line is water.
const NORTH_SHORE_V = 0.0475;
const NORTH_SHORE_FEATHER = 0.0225;
const GATE_SHORE: Stations = [
  // merges into the Lands End diagonal
  [0.155, 0.124],
  [0.2, 0.116],
  [0.25, 0.104],
  // the bridge column — the anchor solves to u ≈ 0.30
  [0.3, 0.0995],
  [0.34, 0.1015],
  [0.38, 0.0965],
  [0.41, 0.077],
  [0.43, 0.058],
  // Back onto the Marina seawall WEST of the Palace of Fine Arts (u 0.46,
  // reaching u 0.4505): the cove must not lap at a landmark's plinth.
  [0.445, NORTH_SHORE_V],
];
const northShoreV = (u: number): number => stationAt(GATE_SHORE, u) ?? NORTH_SHORE_V;

// MARIN HEADLANDS. A far-shore landmass inside the north edge so the Golden
// Gate DELIVERS somewhere — Battery Ridge, the overlook turnaround. It used to
// be one box whose south edge ran dead straight at v = 0.0205; it is now a
// traced coast that juts south at Lime Point (the north tower stands off that
// point) and falls away east into the bay and west toward Point Bonita, and it
// runs wide enough in u that the headland summits behind it have land to stand
// on. The feather is TIGHT — a headland meets the water at a bluff, and the
// bridge's landfall solve wants the deck-height contour within a few units of
// the waterline so the north tower ends up IN the strait.
// [u, coast v] west→east; north of the interpolated line is land.
const MARIN_FEATHER = 0.005;
const MARIN_COAST: Stations = [
  // west shoulder, already off-map
  [0.085, -0.006],
  [0.13, 0.004],
  [0.18, 0.0135],
  [0.21, 0.0135],
  // Kirby Cove. Also load-bearing: the US-101 mainline north of the Gate
  // (sf-freeways) is clipped at the coast, and with the coast out here it used
  // to end in mid-air over the strait — an elevated road stopping at the
  // waterline, 330u west of a bridge it never reaches. Cut behind its last
  // vertex and the whole Marin mainline falls off the map instead.
  [0.24, 0.0075],
  [0.265, 0.017],
  // Lime Point
  [0.285, 0.0215],
  [0.325, 0.0205],
  [0.355, 0.012],
  [0.385, -0.004],
  // the Sausalito shore, off-map
  [0.42, -0.028],
];
const marinLand = (u: number, v: number): number => {
  const cv = stationAt(MARIN_COAST, u);
  return cv === null ? 0 : 1 - smooth(v, cv - MARIN_FEATHER, cv + MARIN_FEATHER);
};

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
export const seawallShore = (u: number, v: number): boolean => {
  const su = shoreU(v);
  if (su !== null) {
    return Math.abs(u - su) < 0.02;
  }
  return v > SEAWALL_SOUTH_V && u > SEAWALL_EAST_U;
};

// --- Traced water/land rings ------------------------------------------------
type UVRing = readonly (readonly [number, number])[];
interface UVBounds {
  readonly uMin: number;
  readonly uMax: number;
  readonly vMin: number;
  readonly vMax: number;
}

// Shoreline feather for traced rings, in WORLD units — not uv. Mission Creek
// is ~20u wide, and a uv feather wide enough for the open coast (box() uses
// 0.02 = 63u) would close the channel completely.
const RING_FEATHER = 5;

const ringBounds = (ring: UVRing): UVBounds => {
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
  return { uMax: uMax + pad, uMin: uMin - pad, vMax: vMax + pad, vMin: vMin - pad };
};

// 1 well inside the ring, 0 well outside, feathered across the bank. The bbox
// reject keeps it free everywhere else — landFactor runs over millions of
// terrain samples.
const ringFactor = (u: number, v: number, ring: UVRing, b: UVBounds): number => {
  if (u < b.uMin || u > b.uMax || v < b.vMin || v > b.vMax) {
    return 0;
  }
  const px = u * WORLD_W;
  const pz = v * WORLD_H;
  let best = Infinity;
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const a = ring[i];
    const c = ring[j];
    if (!a || !c) {
      continue;
    }
    const ax = a[0] * WORLD_W;
    const az = a[1] * WORLD_H;
    const cx = c[0] * WORLD_W;
    const cz = c[1] * WORLD_H;
    if (az > pz !== cz > pz && px < ((cx - ax) * (pz - az)) / (cz - az) + ax) {
      inside = !inside;
    }
    const dx = cx - ax;
    const dz = cz - az;
    const t = Math.max(
      0,
      Math.min(1, ((px - ax) * dx + (pz - az) * dz) / (dx * dx + dz * dz || 1)),
    );
    const d = Math.hypot(px - (ax + t * dx), pz - (az + t * dz));
    if (d < best) {
      best = d;
    }
  }
  return 1 - smooth(inside ? -best : best, -RING_FEATHER, RING_FEATHER);
};

// MISSION CREEK / CHINA BASIN — the real 70 m tidal channel. The 4-number box
// that stood in for it (u 0.71-0.8 × v 0.29-0.35) is a measured correctness
// bug: against the licensed model's water polygon it flooded 246 dry cells,
// missed 317 wet ones, and culled 268 real building footprints — Oracle Park's
// entire block among them. This is that polygon (same calibration as the street
// bake), RDP-simplified at 4u, with the mouth carried east past the shore so
// the channel opens INTO the bay instead of ponding behind it.
const MISSION_CREEK: UVRing = [
  // mouth, south bank
  [0.7804, 0.3358],
  // head at 7th & Channel
  [0.7328, 0.3918],
  [0.7313, 0.393],
  [0.7297, 0.3884],
  // north bank
  [0.7396, 0.3754],
  [0.7809, 0.327],
  // carried out into the bay
  [0.868, 0.3255],
  [0.868, 0.3375],
];
const MISSION_CREEK_BOUNDS = ringBounds(MISSION_CREEK);

// YERBA BUENA ISLAND (+ Treasure Island, which is landfill welded to its north
// shore). One landmass on the Bay Bridge's TRUE 40.5° line — the bridge's west
// crossing lands here at u 0.934 / v 0.015. Only Yerba Buena's southern two
// thirds are on-map: the isthmus and all of Treasure Island sit north of v = 0,
// so the ellipse is elongated northward and runs off the border rather than
// showing a shore just outside it.
const YERBA_BUENA = { ru: 95, rv: 190, u: 0.938, v: -0.005 } as const;

// Radial landmass, in world units so islands stay round on the rectangular map.
const isle = (
  u: number,
  v: number,
  c: { u: number; v: number; ru: number; rv: number },
): number => {
  const du = ((u - c.u) * WORLD_W) / c.ru;
  const dv = ((v - c.v) * WORLD_H) / c.rv;
  return 1 - smooth(Math.hypot(du, dv), 0.72, 1);
};

// Peninsula coastline: Pacific (W), Golden Gate (N), Bay (E); land to the south.
export const landFactor: LandFactor = (u, v) => {
  const ns = northShoreV(u);
  let land = Math.min(
    // Pacific / Ocean Beach (west)
    smooth(u, 0.025, 0.06),
    // Bay shore (east) ~u0.80
    1 - smooth(u, 0.78, 0.85),
    // north coast
    smooth(v, ns - NORTH_SHORE_FEATHER, ns + NORTH_SHORE_FEATHER),
  );
  // Lands End: the NW corner is ocean (coast bends Lands End→Golden Gate Bridge).
  land = Math.min(land, smooth(lineSide(u, v, 0.03, 0.26, 0.25, 0.03), -0.015, 0.02));
  // The real Embarcadero seawall (see EMBARCADERO_SHORE above).
  land = Math.min(land, shoreCut(u, v));
  // East-bay land fingers (jut past the 0.80 shore).
  // Hunters Point
  land = Math.max(land, box(u, v, 0.82, 0.99, 0.7, 0.84));
  // Candlestick Point
  land = Math.max(land, box(u, v, 0.82, 0.98, 0.87, 0.97));
  // Water inlets bitten into the land.
  land = Math.min(land, 1 - ringFactor(u, v, MISSION_CREEK, MISSION_CREEK_BOUNDS));
  // Islais Creek
  land = Math.min(land, 1 - box(u, v, 0.71, 0.82, 0.57, 0.63));
  // Lake Merced (inland)
  land = Math.min(land, 1 - box(u, v, 0.08, 0.18, 0.72, 0.86));
  // Yerba Buena / Treasure Island: its own landmass out in the bay, so it goes
  // on with max() after every peninsula cut (same rule as Marin below).
  land = Math.max(land, isle(u, v, YERBA_BUENA));
  // Marin headlands (see MARIN_COAST). Applied after every peninsula cut
  // (max: it is its own landmass).
  land = Math.max(land, marinLand(u, v));
  return land;
};

export const isLandCell = (gx: number, gz: number): boolean =>
  landFactor((gx + 0.5) / GRID_X, (gz + 0.5) / GRID_Z) > 0.5;

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
const SF_HILLS_M: readonly { u: number; v: number; m: number; r: number; green?: true }[] = [
  // Mount Davidson
  // oxlint-disable-next-line oxc/approx-constant -- 0.693 is a map v coordinate, not ln 2
  { green: true, m: 283, r: 0.08, u: 0.377, v: 0.693 },
  // Twin Peaks
  { green: true, m: 280, r: 0.09, u: 0.42, v: 0.56 },
  // Mount Sutro
  { green: true, m: 278, r: 0.07, u: 0.359, v: 0.486 },
  // Forest Hill
  { green: true, m: 180, r: 0.06, u: 0.3, v: 0.613 },
  // Buena Vista
  { green: true, m: 175, r: 0.045, u: 0.457, v: 0.404 },
  // Corona Heights
  // oxlint-disable-next-line oxc/approx-constant -- 0.434 is a map v coordinate, not log10 e
  { green: true, m: 155, r: 0.04, u: 0.481, v: 0.434 },
  // Bernal Heights
  { green: true, m: 133, r: 0.06, u: 0.621, v: 0.651 },
  // Lone Mountain (USF green)
  { green: true, m: 126, r: 0.04, u: 0.396, v: 0.295 },
  // Nob Hill
  { m: 114, r: 0.05, u: 0.63, v: 0.172 },
  // Pacific Heights
  { m: 112, r: 0.06, u: 0.489, v: 0.182 },
  // Potrero Hill
  { m: 91, r: 0.06, u: 0.726, v: 0.509 },
  // Russian Hill
  { m: 90, r: 0.045, u: 0.602, v: 0.091 },
  // Telegraph Hill
  { m: 84, r: 0.035, u: 0.683, v: 0.082 },
  // Rincon Hill
  { m: 33, r: 0.035, u: 0.778, v: 0.234 },
  // The south and west used to be a pancake: no Bayview ridge, no McLaren
  // knolls, and — the reason the Sunset read as flat suburb — no Golden Gate
  // Heights. Elevations are the real summits; radii are the real footprints
  // (r · 2886 · 4.446 ≈ metres), EXCEPT where a summit stands on an existing
  // hill's flank. Hill Gaussians SUM, so a spur has to be entered at its
  // PROMINENCE, not its sea-level height: Tank Hill's 198 m on top of the
  // Twin Peaks flank already there would put it at 600 m.
  // Grand View / Golden Gate Heights
  { green: true, m: 203, r: 0.055, u: 0.26, v: 0.533 },
  // Rob Hill (the Presidio's high point)
  { green: true, m: 122, r: 0.038, u: 0.202, v: 0.16 },
  // Strawberry Hill (Stow Lake)
  { green: true, m: 131, r: 0.034, u: 0.252, v: 0.398 },
  // Tank Hill (prominence over Twin Peaks)
  { green: true, m: 45, r: 0.032, u: 0.423, v: 0.494 },
  // Billy Goat Hill
  { green: true, m: 91, r: 0.028, u: 0.518, v: 0.686 },
  // McLaren Park, west knoll
  { green: true, m: 150, r: 0.05, u: 0.624, v: 0.859 },
  // McLaren Park, east knoll
  { green: true, m: 120, r: 0.04, u: 0.66, v: 0.874 },
  // Bayview Hill
  { green: true, m: 134, r: 0.042, u: 0.768, v: 0.907 },
  // Hunters Point ridge (shipyard, stays urban)
  { m: 65, r: 0.032, u: 0.843, v: 0.78 },
  // Yerba Buena Island (eucalyptus)
  { green: true, m: 103, r: 0.03, u: 0.938, v: 0.012 },
  // The Daly City rim. Crests sit just off-map south (v > 1) for the same
  // reason Battery Ridge's do: inside the border the ground slopes UP to the
  // edge, so the wall reads as the ridge behind Guadalupe Canyon.
  { m: 150, r: 0.06, u: 0.3, v: 1.008 },
  { m: 170, r: 0.065, u: 0.47, v: 1.008 },
  // Battery Ridge (Marin headlands), FOREGROUND: the bluff the bridge lands
  // on. Crests sit just off-map north (v < 0) so inside the border the ground
  // always slopes UP toward the edge — the border wall reads as ridge, not
  // invisible wall. Two things are load-bearing here. (1) The ridge is a
  // SADDLE at the bridge column (u ≈ 0.30) and knobs either side of it, so the
  // grass climb from the deck (y ≈ 7) to the overlook stays ~24% and the
  // headland stops reading as one extruded shelf. (2) It has to carry ~6.5u of
  // ground AT THE WATERLINE: golden-gate.ts lands the deck on the first
  // deck-height contour it finds, so a low shore puts the landfall — and with
  // it the north tower — inland, which is exactly how both towers ended up on
  // dry land.
  // west shoulder
  { green: true, m: 46, r: 0.024, u: 0.135, v: 0 },
  { green: true, m: 74, r: 0.028, u: 0.19, v: -0.004 },
  // Battery Spencer knob
  { green: true, m: 62, r: 0.026, u: 0.245, v: -0.001 },
  // the landing saddle
  { green: true, m: 52, r: 0.028, u: 0.3, v: -0.002 },
  // Lime Point knob — the one the bridge actually lands beside, so its height
  // is SOLVED, not chosen: the shore drop puts the full hill sum on at the
  // waterline (hills scale with the land factor), which makes every headland
  // coast a bluff whose height IS that sum. At m 80 the bluff stood 13.5u out
  // of the water and the deck arrived at 7 — a 6.5u wall across the carriageway
  // measured on the drive surface. At m 56 the bluff tops out at deck height
  // and the deck runs onto it flush, then climbs ~25% to the overlook.
  { green: true, m: 56, r: 0.028, u: 0.35, v: -0.005 },
  // falls into the bay
  { green: true, m: 55, r: 0.026, u: 0.395, v: -0.012 },
  // Battery Ridge, BACKDROP. The gate audit's words were "Marin behind it is a
  // flat olive plateau" — the bridge had a shelf behind it, not a landmass, so
  // it read as a gantry over a river. These are the real headland summits at
  // their real elevations, crested far enough north (~90u past the border) that
  // their tails add ~12u at the wall and nothing at the landing, and inside the
  // ground mesh's 1.08× overscan so they are actually DRAWN (terrain.ts MARGIN
  // covers the whole drawn skirt for the same reason).
  // Hawk Hill
  { green: true, m: 280, r: 0.03, u: 0.245, v: -0.0345 },
  // Wolf Ridge
  { green: true, m: 300, r: 0.028, u: 0.165, v: -0.03 },
  // Slacker Ridge. Set WEST of the bridge column and further out than the
  // other two: at u 0.335 / v -0.0295 its tail added ~10u at the border wall
  // on the landing column, which took the grass climb off the deck to 45% and
  // tilted the overlook terrace 53%. A backdrop summit has to stay OUT of the
  // one corridor on this headland that gets driven.
  { green: true, m: 250, r: 0.024, u: 0.32, v: -0.032 },
  // …and its two end shoulders, which exist to stop the headland running out
  // as a flat sea-level shelf at the corners of the drawn ground.
  // Point Bonita
  { green: true, m: 150, r: 0.024, u: 0.115, v: -0.032 },
  // Fort Baker ridge
  { green: true, m: 140, r: 0.023, u: 0.385, v: -0.035 },
];
export const SF_HILLS: readonly Hill[] = SF_HILLS_M.map((h) => ({
  height: h.m * HILL_SCALE,
  radius: h.r,
  u: h.u,
  v: h.v,
}));

const GREEN_HILLS = SF_HILLS_M.filter((h) => h.green);

/** 0..1 forest-cover weight at map fraction (u,v). Mirrors the terrain height
 *  field's gaussian exactly (world-unit distances, MAP_REF radii), so the
 *  green cover tracks each hill's actual rendered shape. */
export const greenHillWeightAt = (u: number, v: number): number => {
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
  const c = t < 0 ? 0 : Math.min(1, t);
  return c * c * (3 - 2 * c);
};

export const makeTerrain = (): Terrain => new Terrain(SF_HILLS, landFactor, stowBasinHeight);

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

export interface District {
  readonly name: string;
  readonly character: DistrictChar;
  readonly color: number;
}

// Building tint palettes per district character. Each building picks one color
// so streets read as a mixed row, not a monotone block. SF pastels for the
// residential west, saturated victorians for the Mission/Haight, cool glass
// and stone downtown.
//
// EACH PALETTE IS A KEY, NOT A COLOUR WHEEL (grading pass 2026-07-26). The
// victorian set used to be [crimson, purple, teal, pink, mustard, cornflower]:
// six fully saturated hues spanning the entire wheel, at equal chroma and
// near-equal value, drawn per building with no relationship to the neighbour.
// At street level any one house looked fine; at any oblique the Mission, the
// Haight, Alamo Square and Noe Valley all dissolved into the same visual
// static, and none of them was distinguishable from the others. That is a
// palette failing on BOTH criteria at once — "limited palette with clear
// relationships, not everything at once", and district identity through colour.
//
// Each list is now built the way a Mario Kart street is: ONE dominant hue
// family, ONE complementary accent, and a VALUE RAMP through it (light plaster,
// mid body colour, deep trim) so buildings separate from each other by value
// rather than by hue. The families are also chosen to be different FROM EACH
// OTHER, which is the part that makes crossing a district line read as a key
// change: victorian is warm red-to-plum, residential is cool cream-to-sea,
// commercial is ochre-to-rust, industrial is oxide-to-slate.
const PALETTES = {
  // Ochre → rust, with one sage accent to stop the row going monochrome.
  commercial: [0xe0_c1_93, 0xcf_9a_6c, 0xb2_60_3c, 0x8e_3f_36, 0xf0_dc_bb, 0x8f_ae_9e],
  // Stone and glass. Kept nearly as-is; downtown's job is to be the neutral
  // everything else is colourful against.
  downtown: [0xbf_c4_c9, 0xa2_ad_b6, 0xd0_ca_bd, 0x8b_98_a4, 0xdb_d5_c6],
  highrise: [0x9f_b2_c4, 0x83_99_b0, 0xbc_c8_d2, 0x6f_85_98, 0xc9_d2_da],
  // Oxide → slate.
  industrial: [0xa8_62_3e, 0x8a_6a_4c, 0xb0_89_68, 0x6f_7c_84, 0x9a_8f_7c],
  park: [0xe8_e0_cc, 0xd8_cf_b8, 0xcf_c4_a8],
  // Cool cream → sea, the Sunset/Richmond stucco read.
  residential: [0xf4_e8_db, 0xe4_dc_c9, 0xcf_e0_dc, 0xaf_c6_c8, 0xdf_d7_ea, 0xf6_c8_d4],
  // Warm red → plum, ramped light-to-deep, with ONE gold accent. Same family
  // top to bottom, so a Mission block reads as a painted terrace rather than a
  // paint chart.
  victorian: [0xf3_d9_c4, 0xe8_9a_76, 0xd2_5c_4f, 0xa3_3f_52, 0x6f_3f_5e, 0xe8_b4_58],
  // Salt-bleached boards: warm greys and a single signal red.
  wharf: [0xdc_d6_c7, 0xb6_b0_a1, 0x94_a3_ad, 0xb5_38_4a, 0xe8_ec_e9],
} satisfies Record<DistrictChar, readonly number[]>;

// Tint strength per character — victorians get bold paint, glass stays subtle.
// Victorian came down from 0.62: with the palette now ramped by value instead
// of scattered by hue, the same 0.62 pushed the deep end almost to flat colour
// and cost the kit models their own shading.
const TINT_AMOUNT = {
  commercial: 0.5,
  downtown: 0.28,
  highrise: 0.22,
  industrial: 0.4,
  park: 0.35,
  residential: 0.55,
  victorian: 0.54,
  wharf: 0.42,
} satisfies Record<DistrictChar, number>;

export const paletteFor = (d: District): readonly number[] => PALETTES[d.character];
export const tintAmountFor = (d: District): number => TINT_AMOUNT[d.character];

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
    character: "residential",
    color: 0x93_a0_6b,
    name: "Battery Ridge Overlook",
    uMax: 0.42,
    uMin: 0.08,
    vMax: 0.03,
    vMin: 0,
  },
  // Yerba Buena Island. NOT character "park" for the same reason Battery Ridge
  // is not: the park-tile machinery would move onto a wooded island the player
  // only ever sees from the bridge deck.
  {
    character: "residential",
    color: 0x8a_9a_72,
    name: "Yerba Buena Island",
    uMax: 0.975,
    uMin: 0.905,
    vMax: 0.06,
    vMin: 0,
  },
  // Real SF green spaces (traced): the 4× map has room for the small parks.
  {
    character: "park",
    color: 0x3c_81_47,
    name: "Dolores Park",
    uMax: 0.585,
    uMin: 0.555,
    vMax: 0.5,
    vMin: 0.46,
  },
  {
    character: "park",
    color: 0x2e_6f_4e,
    name: "Buena Vista Park",
    uMax: 0.475,
    uMin: 0.445,
    vMax: 0.425,
    vMin: 0.395,
  },
  {
    character: "park",
    color: 0x2e_6f_4e,
    name: "Mount Davidson Park",
    uMax: 0.4,
    uMin: 0.355,
    vMax: 0.715,
    vMin: 0.67,
  },
  {
    character: "park",
    color: 0x3c_81_47,
    name: "McLaren Park",
    uMax: 0.72,
    uMin: 0.63,
    vMax: 0.87,
    vMin: 0.79,
  },
  {
    character: "park",
    color: 0x3c_81_47,
    name: "the Panhandle",
    uMax: 0.475,
    uMin: 0.4,
    vMax: 0.385,
    vMin: 0.36,
  },
  {
    character: "park",
    color: 0x2e_6f_4e,
    name: "the Presidio",
    uMax: 0.41,
    uMin: 0.2,
    vMax: 0.21,
    vMin: 0.03,
  },
  {
    character: "residential",
    color: 0xc9_d6_df,
    name: "the Marina",
    uMax: 0.56,
    uMin: 0.42,
    vMax: 0.13,
    vMin: 0.02,
  },
  {
    character: "wharf",
    color: 0x35_6a_8a,
    name: "Fisherman's Wharf",
    uMax: 0.685,
    uMin: 0.56,
    vMax: 0.07,
    vMin: 0,
  },
  {
    character: "residential",
    color: 0x9c_ae_86,
    name: "Russian Hill",
    uMax: 0.645,
    uMin: 0.575,
    vMax: 0.155,
    vMin: 0.07,
  },
  {
    character: "commercial",
    color: 0xb5_38_4a,
    name: "North Beach",
    uMax: 0.7,
    uMin: 0.645,
    vMax: 0.15,
    vMin: 0.07,
  },
  {
    character: "highrise",
    color: 0x9a_a7_b2,
    name: "the Financial District",
    uMax: 0.775,
    uMin: 0.7,
    vMax: 0.225,
    vMin: 0.11,
  },
  {
    character: "wharf",
    color: 0x4a_7c_9b,
    name: "the Embarcadero",
    uMax: 0.85,
    uMin: 0.775,
    vMax: 0.33,
    vMin: 0.07,
  },
  // Chinatown sits NORTH of Union Square. It used to be entered as the whole
  // 0.15-0.225 band, which fully contained the Union Square box below it, and
  // districtAt is first-inside-wins — so Union Square (and its
  // PACKED_COMMERCIAL frontage rule) was dead code.
  {
    character: "commercial",
    color: 0xc8_44_2b,
    name: "Chinatown",
    uMax: 0.7,
    uMin: 0.645,
    vMax: 0.19,
    vMin: 0.15,
  },
  {
    character: "residential",
    color: 0x8c_7b_9e,
    name: "Nob Hill",
    uMax: 0.645,
    uMin: 0.575,
    vMax: 0.225,
    vMin: 0.155,
  },
  {
    character: "residential",
    color: 0xd8_c7_a8,
    name: "Pacific Heights",
    uMax: 0.575,
    uMin: 0.42,
    vMax: 0.245,
    vMin: 0.13,
  },
  {
    character: "highrise",
    color: 0xa8_7c_53,
    name: "SoMa",
    uMax: 0.775,
    uMin: 0.66,
    vMax: 0.42,
    vMin: 0.225,
  },
  {
    character: "industrial",
    color: 0xa8_62_3e,
    name: "Dogpatch",
    uMax: 0.85,
    uMin: 0.77,
    vMax: 0.57,
    vMin: 0.45,
  },
  {
    character: "victorian",
    color: 0xe7_b5_c6,
    name: "Alamo Square",
    uMax: 0.555,
    uMin: 0.44,
    vMax: 0.37,
    vMin: 0.245,
  },
  {
    character: "commercial",
    color: 0xd8_9a_5c,
    name: "Hayes Valley",
    uMax: 0.595,
    uMin: 0.555,
    vMax: 0.375,
    vMin: 0.245,
  },
  {
    character: "downtown",
    color: 0xbf_a7_5e,
    name: "Civic Center",
    uMax: 0.66,
    uMin: 0.595,
    vMax: 0.37,
    vMin: 0.225,
  },
  {
    character: "residential",
    color: 0xb6_c2_bc,
    name: "the Richmond",
    uMax: 0.42,
    uMin: 0.03,
    vMax: 0.36,
    vMin: 0.21,
  },
  {
    character: "park",
    color: 0x3c_81_47,
    name: "Golden Gate Park",
    uMax: 0.4,
    uMin: 0.03,
    vMax: 0.44,
    vMin: 0.36,
  },
  {
    character: "residential",
    color: 0xc6_cc_c6,
    name: "the Sunset",
    uMax: 0.4,
    uMin: 0.02,
    vMax: 0.79,
    vMin: 0.44,
  },
  {
    character: "victorian",
    color: 0x8e_4f_a8,
    name: "the Haight",
    uMax: 0.48,
    uMin: 0.4,
    vMax: 0.44,
    vMin: 0.37,
  },
  {
    character: "victorian",
    color: 0xe0_56_4b,
    name: "the Mission",
    uMax: 0.69,
    uMin: 0.575,
    vMax: 0.6,
    vMin: 0.42,
  },
  {
    character: "commercial",
    color: 0xd1_4e_9b,
    name: "the Castro",
    uMax: 0.555,
    uMin: 0.46,
    vMax: 0.55,
    vMin: 0.44,
  },
  {
    character: "residential",
    color: 0x9d_b0_7c,
    name: "Bernal Heights",
    uMax: 0.675,
    uMin: 0.575,
    vMax: 0.77,
    vMin: 0.6,
  },
  // --- Gap fill: every drivable cell should announce a real neighborhood ---
  {
    character: "commercial",
    color: 0xc9_8a_3c,
    name: "Union Square",
    uMax: 0.7,
    uMin: 0.645,
    vMax: 0.225,
    vMin: 0.19,
  },
  {
    character: "highrise",
    color: 0x7c_98_ac,
    name: "Mission Bay",
    uMax: 0.79,
    uMin: 0.7,
    vMax: 0.47,
    vMin: 0.42,
  },
  {
    character: "residential",
    color: 0xc2_a8_78,
    name: "Potrero Hill",
    uMax: 0.77,
    uMin: 0.69,
    vMax: 0.6,
    vMin: 0.45,
  },
  {
    character: "victorian",
    color: 0x7c_a8_c2,
    name: "Noe Valley",
    uMax: 0.575,
    uMin: 0.49,
    vMax: 0.65,
    vMin: 0.55,
  },
  {
    character: "park",
    color: 0x2e_6f_4e,
    name: "Twin Peaks",
    uMax: 0.46,
    uMin: 0.39,
    vMax: 0.6,
    vMin: 0.52,
  },
  {
    character: "residential",
    color: 0x94_ab_88,
    name: "Glen Park",
    uMax: 0.575,
    uMin: 0.47,
    vMax: 0.73,
    vMin: 0.65,
  },
  {
    character: "commercial",
    color: 0xd0_a0_6a,
    name: "West Portal",
    uMax: 0.42,
    uMin: 0.3,
    vMax: 0.68,
    vMin: 0.6,
  },
  {
    character: "residential",
    color: 0xb3_bd_a0,
    name: "Miraloma Park",
    uMax: 0.47,
    uMin: 0.36,
    vMax: 0.67,
    vMin: 0.6,
  },
  {
    character: "residential",
    color: 0xc0_b3_94,
    name: "Ingleside",
    uMax: 0.5,
    uMin: 0.3,
    vMax: 0.94,
    vMin: 0.79,
  },
  {
    character: "residential",
    color: 0xa8_bc_ae,
    name: "Lakeshore",
    uMax: 0.3,
    uMin: 0.05,
    vMax: 0.97,
    vMin: 0.79,
  },
  {
    character: "residential",
    color: 0xc7_a9_8c,
    name: "the Outer Mission",
    uMax: 0.575,
    uMin: 0.5,
    vMax: 0.89,
    vMin: 0.73,
  },
  {
    character: "residential",
    color: 0xd0_b1_84,
    name: "the Excelsior",
    uMax: 0.66,
    uMin: 0.575,
    vMax: 0.9,
    vMin: 0.77,
  },
  {
    character: "residential",
    color: 0xb8_ab_7c,
    name: "the Portola",
    uMax: 0.76,
    uMin: 0.66,
    vMax: 0.82,
    vMin: 0.72,
  },
  {
    character: "industrial",
    color: 0xa8_78_50,
    name: "Bayview",
    uMax: 0.84,
    uMin: 0.72,
    vMax: 0.76,
    vMin: 0.6,
  },
  {
    character: "industrial",
    color: 0x97_69_4a,
    name: "Hunters Point",
    uMax: 0.99,
    uMin: 0.8,
    vMax: 0.86,
    vMin: 0.66,
  },
  {
    character: "residential",
    color: 0xbf_ae_88,
    name: "Visitacion Valley",
    uMax: 0.8,
    uMin: 0.64,
    vMax: 1,
    vMin: 0.82,
  },
  {
    character: "residential",
    color: 0xb2_a4_87,
    name: "Crocker-Amazon",
    uMax: 0.64,
    uMin: 0.5,
    vMax: 1,
    vMin: 0.89,
  },
  {
    character: "victorian",
    color: 0xd8_8a_6a,
    name: "Mission Dolores",
    uMax: 0.66,
    uMin: 0.48,
    vMax: 0.44,
    vMin: 0.37,
  },
  {
    character: "residential",
    color: 0xa9_bf_a2,
    name: "Cole Valley",
    uMax: 0.47,
    uMin: 0.4,
    vMax: 0.55,
    vMin: 0.44,
  },
  {
    character: "residential",
    color: 0xb9_b7_8e,
    name: "Sunnyside",
    uMax: 0.5,
    uMin: 0.42,
    vMax: 0.8,
    vMin: 0.67,
  },
  {
    character: "residential",
    color: 0xbc_9a_72,
    name: "Silver Terrace",
    uMax: 0.73,
    uMin: 0.675,
    vMax: 0.73,
    vMin: 0.6,
  },
  {
    character: "commercial",
    color: 0xc0_90_60,
    name: "Jackson Square",
    uMax: 0.78,
    uMin: 0.685,
    vMax: 0.12,
    vMin: 0.06,
  },
  {
    character: "wharf",
    color: 0x5b_86_a0,
    name: "China Basin",
    uMax: 0.86,
    uMin: 0.775,
    vMax: 0.47,
    vMin: 0.33,
  },
  {
    character: "residential",
    color: 0xc4_bd_a6,
    name: "Daly City",
    uMax: 0.5,
    uMin: 0.18,
    vMax: 1,
    vMin: 0.92,
  },
];

export const districtAt = (gx: number, gz: number): District => {
  const u = (gx + 0.5) / GRID_X;
  const v = (gz + 0.5) / GRID_Z;
  let best: Box | null = null;
  let bd = Infinity;
  for (const n of NEIGHBORHOODS) {
    if (u >= n.uMin && u <= n.uMax && v >= n.vMin && v <= n.vMax) {
      return { character: n.character, color: n.color, name: n.name };
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
  if (best) {
    return { character: best.character, color: best.color, name: best.name };
  }
  return { character: "residential", color: 0xbf_c6_c2, name: "San Francisco" };
};
