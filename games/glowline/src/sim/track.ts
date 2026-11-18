// A track is a closed centreline sampled every TRACK_STEP units, with a
// tangent and a height per sample. Everything a kart needs — where it is along
// the lap, how far off the centreline, how high the road is — comes from
// `locate`, which searches a window around the kart's last sample so a kart
// never jumps to a neighbouring stretch of road that happens to pass close by.
//
// No three.js here: the headless harness imports this file under Node.

import { SHOULDER, TRACK_STEP } from "../shared/constants";

export interface TrackPalette {
  /** Kerbs, barriers, gantry, signs. */
  accent: string;
  accent2: string;
  /** Asphalt binder. */
  road: string;
  /** Concrete apron beside the road and the plaza beyond. */
  apron: string;
  plaza: string;
  /** Building walls, lightest to darkest. */
  walls: readonly [string, string, string];
  /** Lit windows. */
  windows: string;
  /** Blue-hour sky, top to bottom, the afterglow and the far skyline. */
  zenith: string;
  mid: string;
  horizon: string;
  sun: string;
  skyline: string;
  /** Low key light: its colour and the compass bearing it comes from, radians. */
  key: string;
  bearing: number;
  /** Cool fill from the sky. */
  fill: string;
}

/** One hill term: `amp * sin(2π * (waves * u + phase))`, u the lap fraction. */
export interface Hill {
  amp: number;
  waves: number;
  phase: number;
}

export interface TrackDef {
  id: string;
  name: string;
  /** Closed loop of control points [x, z]; the lap runs in list order. */
  points: readonly (readonly [number, number])[];
  halfWidth: number;
  hills: readonly Hill[];
  /** Splat pads, as lap fractions. */
  pads: readonly number[];
  palette: TrackPalette;
}

export interface Track {
  def: TrackDef;
  /** Sample count; the lap is `n * TRACK_STEP` long. */
  n: number;
  xs: Float32Array;
  zs: Float32Array;
  /** Unit tangent per sample. */
  tx: Float32Array;
  tz: Float32Array;
  /** Road height per sample. */
  hs: Float32Array;
  /** Signed curvature per sample (1/radius, + turns right). */
  curve: Float32Array;
  halfWidth: number;
  /** Distance from the centreline to the rail. */
  rail: number;
  /** Sample index of each splat pad. */
  pads: number[];
}

export interface Located {
  /** Nearest sample. */
  i: number;
  /** Lap progress in samples, fractional. */
  s: number;
  /** Signed distance from the centreline; + is the right-hand side. */
  lat: number;
  /** Road height here. */
  h: number;
}

const TAU = Math.PI * 2;
const SUBDIVISIONS = 48;
const SEARCH_WINDOW = 14;

export const wrapIndex = (i: number, n: number): number => ((i % n) + n) % n;

/** Read a typed array at an index known to be in range. */
const at = (list: Float32Array, i: number): number => list[i] ?? 0;

const catmull = (p0: number, p1: number, p2: number, p3: number, t: number): number => {
  const t2 = t * t;
  const t3 = t2 * t;
  return (
    0.5 *
    (2 * p1 +
      (p2 - p0) * t +
      (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 +
      (3 * p1 - p0 - 3 * p2 + p3) * t3)
  );
};

interface Polyline {
  x: number[];
  z: number[];
}

/** The control loop as a dense polyline (uneven spacing). */
const densify = (points: TrackDef["points"]): Polyline => {
  const x: number[] = [];
  const z: number[] = [];
  const count = points.length;
  const pick = (i: number): readonly [number, number] => points[wrapIndex(i, count)] ?? [0, 0];
  for (let i = 0; i < count; i += 1) {
    const [p0, p1, p2, p3] = [pick(i - 1), pick(i), pick(i + 1), pick(i + 2)];
    for (let k = 0; k < SUBDIVISIONS; k += 1) {
      const t = k / SUBDIVISIONS;
      x.push(catmull(p0[0], p1[0], p2[0], p3[0], t));
      z.push(catmull(p0[1], p1[1], p2[1], p3[1], t));
    }
  }
  return { x, z };
};

const heightAt = (hills: readonly Hill[], u: number): number => {
  let h = 0;
  for (const hill of hills) {
    h += hill.amp * Math.sin(TAU * (hill.waves * u + hill.phase));
  }
  return h;
};

/** Cumulative arc length around a closed polyline; the last entry is the lap. */
const arcLengths = (line: Polyline): number[] => {
  const m = line.x.length;
  const cum: number[] = [0];
  for (let i = 0; i < m; i += 1) {
    const j = (i + 1) % m;
    const dx = (line.x[j] ?? 0) - (line.x[i] ?? 0);
    const dz = (line.z[j] ?? 0) - (line.z[i] ?? 0);
    cum.push((cum[i] ?? 0) + Math.hypot(dx, dz));
  }
  return cum;
};

interface Centreline {
  n: number;
  step: number;
  xs: Float32Array;
  zs: Float32Array;
}

/** Walk the polyline at even spacing, as close to TRACK_STEP as divides the lap. */
const resample = (line: Polyline): Centreline => {
  const m = line.x.length;
  const cum = arcLengths(line);
  const total = cum[m] ?? 0;
  const n = Math.max(8, Math.round(total / TRACK_STEP));
  const step = total / n;
  const xs = new Float32Array(n);
  const zs = new Float32Array(n);
  let seg = 0;
  for (let i = 0; i < n; i += 1) {
    const target = i * step;
    while (seg < m - 1 && (cum[seg + 1] ?? 0) < target) {
      seg += 1;
    }
    const a = cum[seg] ?? 0;
    const b = cum[seg + 1] ?? a;
    const k = b > a ? (target - a) / (b - a) : 0;
    const j = (seg + 1) % m;
    const x0 = line.x[seg] ?? 0;
    const z0 = line.z[seg] ?? 0;
    xs[i] = x0 + ((line.x[j] ?? 0) - x0) * k;
    zs[i] = z0 + ((line.z[j] ?? 0) - z0) * k;
  }
  return { n, step, xs, zs };
};

export const buildTrack = (def: TrackDef): Track => {
  const { n, step, xs, zs } = resample(densify(def.points));
  const tx = new Float32Array(n);
  const tz = new Float32Array(n);
  const hs = new Float32Array(n);
  const curve = new Float32Array(n);
  for (let i = 0; i < n; i += 1) {
    const prev = wrapIndex(i - 1, n);
    const next = wrapIndex(i + 1, n);
    const dx = at(xs, next) - at(xs, prev);
    const dz = at(zs, next) - at(zs, prev);
    const len = Math.hypot(dx, dz) || 1;
    tx[i] = dx / len;
    tz[i] = dz / len;
    hs[i] = heightAt(def.hills, i / n);
  }
  for (let i = 0; i < n; i += 1) {
    const prev = wrapIndex(i - 2, n);
    const next = wrapIndex(i + 2, n);
    // Cross of the tangents two samples either side: sin of the turn over ~4 steps.
    const cross = at(tx, prev) * at(tz, next) - at(tz, prev) * at(tx, next);
    curve[i] = cross / (4 * step);
  }
  return {
    curve,
    def,
    halfWidth: def.halfWidth,
    hs,
    n,
    pads: def.pads.map((u) => wrapIndex(Math.round(u * n), n)),
    rail: def.halfWidth + SHOULDER,
    tx,
    tz,
    xs,
    zs,
  };
};

/**
 * Where (x, z) is on the track. `hint` is the kart's last sample; pass a
 * negative hint to search the whole lap (a spawn, a host taking over a bot).
 */
export const locate = (track: Track, x: number, z: number, hint: number): Located => {
  const { n } = track;
  let best = 0;
  let bestD = Number.POSITIVE_INFINITY;
  const from = hint < 0 ? 0 : hint - SEARCH_WINDOW;
  const to = hint < 0 ? n - 1 : hint + SEARCH_WINDOW;
  for (let k = from; k <= to; k += 1) {
    const i = wrapIndex(k, n);
    const dx = x - at(track.xs, i);
    const dz = z - at(track.zs, i);
    const d = dx * dx + dz * dz;
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  const dx = x - at(track.xs, best);
  const dz = z - at(track.zs, best);
  const tx = at(track.tx, best);
  const tz = at(track.tz, best);
  const along = dx * tx + dz * tz;
  // Right-hand normal of a heading (tx, tz) is (-tz, tx).
  const lat = dx * -tz + dz * tx;
  const next = wrapIndex(best + (along >= 0 ? 1 : -1), n);
  const k = Math.min(1, Math.abs(along) / TRACK_STEP);
  return {
    h: at(track.hs, best) + (at(track.hs, next) - at(track.hs, best)) * k,
    i: best,
    lat,
    s: best + along / TRACK_STEP,
  };
};

export interface TrackPoint {
  x: number;
  z: number;
  /** Heading of the road here, radians. */
  a: number;
  h: number;
}

/** A point `lat` to the right of the centreline at (fractional) sample `s`. */
export const pointAt = (track: Track, s: number, lat: number): TrackPoint => {
  const i = wrapIndex(Math.round(s), track.n);
  const tx = at(track.tx, i);
  const tz = at(track.tz, i);
  return {
    a: Math.atan2(tz, tx),
    h: at(track.hs, i),
    x: at(track.xs, i) - tz * lat,
    z: at(track.zs, i) + tx * lat,
  };
};

export const curvatureAt = (track: Track, s: number): number =>
  at(track.curve, wrapIndex(Math.round(s), track.n));

// --- The circuits ------------------------------------------------------------
// Three night circuits. Each loop stays inside ±120 so the paint grid covers it,
// and no stretch passes within two rails of another.

export const TRACK_DEFS: readonly TrackDef[] = [
  {
    halfWidth: 7.5,
    hills: [],
    id: "sodium-loop",
    name: "Sodium Loop",
    pads: [0.2, 0.47, 0.76],
    palette: {
      accent: "#19c8f0",
      accent2: "#ff3d81",
      apron: "#a7a3ac",
      bearing: 2.3,
      fill: "#9fc4ff",
      horizon: "#ffd9ad",
      key: "#ffd2a1",
      mid: "#7fb2ea",
      plaza: "#8f8b96",
      road: "#4a4a55",
      skyline: "#5b6f9e",
      sun: "#ffe0b0",
      walls: ["#d9cfc6", "#b9a79d", "#8e8ba0"],
      windows: "#ffd58a",
      zenith: "#2f5fb4",
    },
    points: [
      [-70, -78],
      [-10, -92],
      [58, -84],
      [96, -44],
      [84, 6],
      [40, 16],
      [22, 52],
      [58, 86],
      [18, 104],
      [-36, 84],
      [-52, 40],
      [-96, 22],
      [-104, -32],
    ],
  },
  {
    halfWidth: 7,
    hills: [],
    id: "harbor-hairpins",
    name: "Harbor Hairpins",
    pads: [0.14, 0.4, 0.63, 0.88],
    palette: {
      accent: "#3fd85a",
      accent2: "#ffc21f",
      apron: "#a3aba8",
      bearing: 0.7,
      fill: "#a6d6e6",
      horizon: "#ffe6b8",
      key: "#ffdcaa",
      mid: "#7cc4d8",
      plaza: "#88928f",
      road: "#454c50",
      skyline: "#4f7f8e",
      sun: "#fff0c4",
      walls: ["#d6dcd2", "#a9b9b2", "#7d949a"],
      windows: "#fff0b8",
      zenith: "#1f6f9c",
    },
    points: [
      [-98, -70],
      [-40, -96],
      [30, -90],
      [52, -52],
      [14, -30],
      [-34, -40],
      [-52, -8],
      [-10, 12],
      [48, 2],
      [98, -20],
      [106, 40],
      [62, 62],
      [20, 48],
      [-8, 78],
      [-58, 100],
      [-102, 66],
      [-84, 18],
      [-108, -24],
    ],
  },
  {
    halfWidth: 8,
    hills: [],
    id: "ultraviolet-ridge",
    name: "Ultraviolet Ridge",
    pads: [0.25, 0.55, 0.82],
    palette: {
      accent: "#a55cff",
      accent2: "#ff7a2f",
      apron: "#aca2ad",
      bearing: 4.1,
      fill: "#c4a8ff",
      horizon: "#ffc4b0",
      key: "#ffc6a8",
      mid: "#a888e0",
      plaza: "#93879a",
      road: "#4b4552",
      skyline: "#6d5a9a",
      sun: "#ffd0b0",
      walls: ["#e0d2d6", "#b8a2b4", "#8a7aa0"],
      windows: "#ffe0c0",
      zenith: "#4a3aa6",
    },
    points: [
      [-104, -40],
      [-66, -92],
      [0, -78],
      [44, -100],
      [100, -74],
      [104, -14],
      [60, 10],
      [72, 60],
      [34, 100],
      [-22, 88],
      [-30, 40],
      [-76, 56],
      [-108, 18],
    ],
  },
];

export const TRACKS: readonly Track[] = TRACK_DEFS.map((def) => buildTrack(def));

export const trackFor = (index: number): Track => {
  const track = TRACKS[wrapIndex(index, TRACKS.length)];
  if (!track) {
    throw new Error("no tracks defined");
  }
  return track;
};
