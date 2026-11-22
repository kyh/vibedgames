import { GRID_X, GRID_Z, WORLD_H, WORLD_W } from "../shared/constants";
import { Terrain } from "./terrain";
import type { Hill, LandFactor } from "./terrain";
import { stowBasinHeight } from "./lake";

const smooth = (x: number, a: number, b: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));

  return t * t * (3 - 2 * t);
};

const box = (u: number, v: number, uMin: number, uMax: number, vMin: number, vMax: number) => {
  const fu = Math.min(smooth(u, uMin - 0.02, uMin + 0.01), 1 - smooth(u, uMax - 0.01, uMax + 0.02));
  const fv = Math.min(smooth(v, vMin - 0.02, vMin + 0.01), 1 - smooth(v, vMax - 0.01, vMax + 0.02));

  return Math.min(fu, fv);
};

const lineSide = (u: number, v: number, ax: number, ay: number, bx: number, by: number) =>
  (bx - ax) * (v - ay) - (by - ay) * (u - ax);

type Stations = readonly (readonly [number, number])[];

const stationAt = (S: Stations, x: number) => {
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

const EMBARCADERO_SHORE: Stations = [
  [0.021, 0.6596],
  [0.0415, 0.7146],
  [0.0838, 0.7458],
  [0.148, 0.7602],
  [0.2, 0.796],
  [0.2634, 0.8114],
];

const shoreU = (v: number) => stationAt(EMBARCADERO_SHORE, v);

const shoreCut = (u: number, v: number) => {
  const su = shoreU(v);

  return su === null ? 1 : 1 - smooth(u, su - 0.004, su + 0.008);
};

const NORTH_SHORE_V = 0.0475;
const NORTH_SHORE_FEATHER = 0.0225;

const GATE_SHORE: Stations = [
  [0.155, 0.124],
  [0.2, 0.116],
  [0.25, 0.104],
  [0.3, 0.0995],
  [0.34, 0.1015],
  [0.38, 0.0965],
  [0.41, 0.077],
  [0.43, 0.058],
  [0.445, NORTH_SHORE_V],
];

const northShoreV = (u: number) => stationAt(GATE_SHORE, u) ?? NORTH_SHORE_V;

const MARIN_FEATHER = 0.005;

const MARIN_COAST: Stations = [
  [0.085, -0.006],
  [0.13, 0.004],
  [0.18, 0.0135],
  [0.21, 0.0135],
  [0.24, 0.0075],
  [0.265, 0.017],
  [0.285, 0.0215],
  [0.325, 0.0205],
  [0.355, 0.012],
  [0.385, -0.004],
  [0.42, -0.028],
];

const marinLand = (u: number, v: number) => {
  const cv = stationAt(MARIN_COAST, u);

  return cv === null ? 0 : 1 - smooth(v, cv - MARIN_FEATHER, cv + MARIN_FEATHER);
};

const SEAWALL_SOUTH_V = 0.2634;
const SEAWALL_EAST_U = 0.6;

export const seawallShore = (u: number, v: number) => {
  const su = shoreU(v);

  if (su !== null) {
    return Math.abs(u - su) < 0.02;
  }

  return v > SEAWALL_SOUTH_V && u > SEAWALL_EAST_U;
};

type UVRing = readonly (readonly [number, number])[];

interface UVBounds {
  readonly uMin: number;
  readonly uMax: number;
  readonly vMin: number;
  readonly vMax: number;
}

const RING_FEATHER = 5;

const ringBounds = (ring: UVRing) => {
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

const ringFactor = (u: number, v: number, ring: UVRing, b: UVBounds) => {
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

const MISSION_CREEK: UVRing = [
  [0.7804, 0.3358],
  [0.7328, 0.3918],
  [0.7313, 0.393],
  [0.7297, 0.3884],
  [0.7396, 0.3754],
  [0.7809, 0.327],
  [0.868, 0.3255],
  [0.868, 0.3375],
];

const MISSION_CREEK_BOUNDS = ringBounds(MISSION_CREEK);

const YERBA_BUENA = { ru: 95, rv: 190, u: 0.938, v: -0.005 } as const;

const isle = (u: number, v: number, c: { u: number; v: number; ru: number; rv: number }) => {
  const du = ((u - c.u) * WORLD_W) / c.ru;
  const dv = ((v - c.v) * WORLD_H) / c.rv;

  return 1 - smooth(Math.hypot(du, dv), 0.72, 1);
};

export const landFactor: LandFactor = (u, v) => {
  const ns = northShoreV(u);

  let land = Math.min(
    smooth(u, 0.025, 0.06),
    1 - smooth(u, 0.78, 0.85),
    smooth(v, ns - NORTH_SHORE_FEATHER, ns + NORTH_SHORE_FEATHER),
  );

  land = Math.min(land, smooth(lineSide(u, v, 0.03, 0.26, 0.25, 0.03), -0.015, 0.02));
  land = Math.min(land, shoreCut(u, v));
  land = Math.max(land, box(u, v, 0.82, 0.99, 0.7, 0.84));
  land = Math.max(land, box(u, v, 0.82, 0.98, 0.87, 0.97));
  land = Math.min(land, 1 - ringFactor(u, v, MISSION_CREEK, MISSION_CREEK_BOUNDS));
  land = Math.min(land, 1 - box(u, v, 0.71, 0.82, 0.57, 0.63));
  land = Math.min(land, 1 - box(u, v, 0.08, 0.18, 0.72, 0.86));
  land = Math.max(land, isle(u, v, YERBA_BUENA));
  land = Math.max(land, marinLand(u, v));

  return land;
};

export const isLandCell = (gx: number, gz: number) =>
  landFactor((gx + 0.5) / GRID_X, (gz + 0.5) / GRID_Z) > 0.5;

const HILL_SCALE = 0.38;

const SF_HILLS_M: readonly { u: number; v: number; m: number; r: number; green?: true }[] = [
  // oxlint-disable-next-line oxc/approx-constant -- 0.693 is a map v coordinate, not ln 2
  { green: true, m: 283, r: 0.08, u: 0.377, v: 0.693 },
  { green: true, m: 280, r: 0.09, u: 0.42, v: 0.56 },
  { green: true, m: 278, r: 0.07, u: 0.359, v: 0.486 },
  { green: true, m: 180, r: 0.06, u: 0.3, v: 0.613 },
  { green: true, m: 175, r: 0.045, u: 0.457, v: 0.404 },
  // oxlint-disable-next-line oxc/approx-constant -- 0.434 is a map v coordinate, not log10 e
  { green: true, m: 155, r: 0.04, u: 0.481, v: 0.434 },
  { green: true, m: 133, r: 0.06, u: 0.621, v: 0.651 },
  { green: true, m: 126, r: 0.04, u: 0.396, v: 0.295 },
  { m: 114, r: 0.05, u: 0.63, v: 0.172 },
  { m: 112, r: 0.06, u: 0.489, v: 0.182 },
  { m: 91, r: 0.06, u: 0.726, v: 0.509 },
  { m: 90, r: 0.045, u: 0.602, v: 0.091 },
  { m: 84, r: 0.035, u: 0.683, v: 0.082 },
  { m: 33, r: 0.035, u: 0.778, v: 0.234 },
  { green: true, m: 203, r: 0.055, u: 0.26, v: 0.533 },
  { green: true, m: 122, r: 0.038, u: 0.202, v: 0.16 },
  { green: true, m: 131, r: 0.034, u: 0.252, v: 0.398 },
  { green: true, m: 45, r: 0.032, u: 0.423, v: 0.494 },
  { green: true, m: 91, r: 0.028, u: 0.518, v: 0.686 },
  { green: true, m: 150, r: 0.05, u: 0.624, v: 0.859 },
  { green: true, m: 120, r: 0.04, u: 0.66, v: 0.874 },
  { green: true, m: 134, r: 0.042, u: 0.768, v: 0.907 },
  { m: 65, r: 0.032, u: 0.843, v: 0.78 },
  { green: true, m: 103, r: 0.03, u: 0.938, v: 0.012 },
  { m: 150, r: 0.06, u: 0.3, v: 1.008 },
  { m: 170, r: 0.065, u: 0.47, v: 1.008 },
  { green: true, m: 46, r: 0.024, u: 0.135, v: 0 },
  { green: true, m: 74, r: 0.028, u: 0.19, v: -0.004 },
  { green: true, m: 62, r: 0.026, u: 0.245, v: -0.001 },
  { green: true, m: 52, r: 0.028, u: 0.3, v: -0.002 },
  { green: true, m: 56, r: 0.028, u: 0.35, v: -0.005 },
  { green: true, m: 55, r: 0.026, u: 0.395, v: -0.012 },
  { green: true, m: 280, r: 0.03, u: 0.245, v: -0.0345 },
  { green: true, m: 300, r: 0.028, u: 0.165, v: -0.03 },
  { green: true, m: 250, r: 0.024, u: 0.32, v: -0.032 },
  { green: true, m: 150, r: 0.024, u: 0.115, v: -0.032 },
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
export const greenHillWeightAt = (u: number, v: number) => {
  const mapRef = (WORLD_W + WORLD_H) / 2;
  let w = 0;

  for (const h of GREEN_HILLS) {
    const du = (u - h.u) * WORLD_W;
    const dv = (v - h.v) * WORLD_H;
    const r = h.r * mapRef;
    w += Math.exp(-(du * du + dv * dv) / (r * r * 0.5));
  }

  const t = (w - 0.3) / (0.75 - 0.3);
  const c = t < 0 ? 0 : Math.min(1, t);

  return c * c * (3 - 2 * c);
};

export const makeTerrain = () => new Terrain(SF_HILLS, landFactor, stowBasinHeight);

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

const PALETTES = {
  commercial: [0xe0_c1_93, 0xcf_9a_6c, 0xb2_60_3c, 0x8e_3f_36, 0xf0_dc_bb, 0x8f_ae_9e],
  downtown: [0xbf_c4_c9, 0xa2_ad_b6, 0xd0_ca_bd, 0x8b_98_a4, 0xdb_d5_c6],
  highrise: [0x9f_b2_c4, 0x83_99_b0, 0xbc_c8_d2, 0x6f_85_98, 0xc9_d2_da],
  industrial: [0xa8_62_3e, 0x8a_6a_4c, 0xb0_89_68, 0x6f_7c_84, 0x9a_8f_7c],
  park: [0xe8_e0_cc, 0xd8_cf_b8, 0xcf_c4_a8],
  residential: [0xf4_e8_db, 0xe4_dc_c9, 0xcf_e0_dc, 0xaf_c6_c8, 0xdf_d7_ea, 0xf6_c8_d4],
  victorian: [0xf3_d9_c4, 0xe8_9a_76, 0xd2_5c_4f, 0xa3_3f_52, 0x6f_3f_5e, 0xe8_b4_58],
  wharf: [0xdc_d6_c7, 0xb6_b0_a1, 0x94_a3_ad, 0xb5_38_4a, 0xe8_ec_e9],
} satisfies Record<DistrictChar, readonly number[]>;

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

export const paletteFor = (d: District) => PALETTES[d.character];
export const tintAmountFor = (d: District) => TINT_AMOUNT[d.character];

type Box = District & {
  readonly uMin: number;
  readonly uMax: number;
  readonly vMin: number;
  readonly vMax: number;
};

const NEIGHBORHOODS: readonly Box[] = [
  {
    character: "residential",
    color: 0x93_a0_6b,
    name: "Battery Ridge Overlook",
    uMax: 0.42,
    uMin: 0.08,
    vMax: 0.03,
    vMin: 0,
  },
  {
    character: "residential",
    color: 0x8a_9a_72,
    name: "Yerba Buena Island",
    uMax: 0.975,
    uMin: 0.905,
    vMax: 0.06,
    vMin: 0,
  },
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

export const districtAt: (gx: number, gz: number) => District = (gx, gz) => {
  const u = (gx + 0.5) / GRID_X;
  const v = (gz + 0.5) / GRID_Z;
  let best: Box | null = null;
  let bd = Infinity;

  for (const n of NEIGHBORHOODS) {
    if (u >= n.uMin && u <= n.uMax && v >= n.vMin && v <= n.vMax) {
      return { character: n.character, color: n.color, name: n.name };
    }

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
