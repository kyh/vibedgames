import * as THREE from "three";
import polygonClipping from "polygon-clipping";

import { GRID_X, GRID_Z, ROAD_TILE, ROAD_Y, WORLD_HALF_X, WORLD_HALF_Z } from "../shared/constants";
import {
  conformToTerrain,
  DRAPE_MAX_ERROR,
  type DrapeField,
  seatOnSurface,
  surfaceSampler,
  type SurfaceSampler,
} from "./conform";
import { junctionControl } from "./junction-control";
import type { NetEdge, RoadNetwork } from "./network";
import { districtAt } from "./sf-map";

// PLANAR-MAP street geometry. Every edge sweep and junction patch is built as
// a 2D POLYGON, and the drawable surfaces are boolean combinations:
//
//   asphalt  = union(edge strips, junction patches, dead-end caps)
//   curb     = union(strips grown by CURB_W)  − asphalt
//   sidewalk = union(strips grown by SIDEWALK_W) − asphalt
//
// Overlap between independently generated pieces — the source of every
// "sidewalk slicing across a road" bug — is dissolved by the union instead
// of being someone's rendering problem. Markings stay per-edge but are
// clipped away near junction nodes. The final triangulated surfaces drape
// over the terrain exactly like before.

export const ASPHALT_W = ROAD_TILE * 0.8; // legacy uniform width (tertiary)
// Kit-matched profile — chunky light curbs, brighter sidewalks, cleaner
// asphalt (KayKit City Builder look). Streets v3, 2026-07-07.
export const SIDEWALK_W = 2.0; // arterial sidewalks (ground aprons key off this)
// Sidewalks scale with street class: uniform 2.0 walks around a 3.2-half
// minor made the corridor 11.8u of a 13u cell — the dense hill grid merged
// into asphalt-to-asphalt "lakes" with sliver blocks.
export const walkFor = (half: number): number => (half > 4.7 ? SIDEWALK_W : 1.3);
export const LANE_CENTER = ASPHALT_W * 0.19; // default lane offset for traffic
const CURB_W = 0.7;
export const ASPHALT_LIFT = ROAD_Y + 0.05;
const SIDEWALK_LIFT = ROAD_Y + 0.13;
const CURB_LIFT = SIDEWALK_LIFT + 0.03; // curb lip reads above the walk
// The highest a draped street layer can sit above the height field: the curb
// lip's lift plus the drape's worst-case bow. Runtime ground overlays (fare
// beacon rings, garage pad rings) must clear this or the street depth-tests
// them away / z-fights them at distance.
export const STREET_SURFACE_MAX = CURB_LIFT + DRAPE_MAX_ERROR;
// Markings drape at a looser sag tolerance than the asphalt (thin decals; the
// vert savings across all of SF's paint is large). They no longer need a lift
// that covers the worst relative bow between the two drapes: paint is SEATED
// on the asphalt surface after it is draped (seatOnSurface), so PAINT_SEAT is
// just enough to beat depth precision alongside the decals' polygon offset.
// LINE_LIFT survives only as the fallback for the handful of marking vertices
// that fall outside the asphalt shell.
const MARKING_MAX_ERROR = DRAPE_MAX_ERROR;
const PAINT_SEAT = 0.03;
const LINE_LIFT = ASPHALT_LIFT + MARKING_MAX_ERROR + DRAPE_MAX_ERROR + 0.03;
const LINE_W = 0.24;
const EDGE_INSET = 0.5;
const DASH_LEN = 2.2;
const DASH_GAP = 2.6;
const MITER_LIMIT = 2.5; // clamp spike joints on hairpin polylines
// Signed clearances from the junction patch a marking must keep (see
// nearJunction): positive = stay this far OUTSIDE the patch, negative = may
// run this far INTO its open asphalt.
const LINE_CLIP = 1.2; // solid lines (incl. kerb-hugging edge lines)
const DASH_CLIP = 1.6; // lane dashes on the minor grid
const CENTRE_CLIP = -1.8; // boulevard centre-of-roadway paint
const CROSSWALK_ROOM = 4.5; // swept section an arm needs to carry a crosswalk + stop bar

// Materials by stable key — the worker ships buffers tagged with these keys
// and the main thread looks the material back up.
export const ROAD_MATERIALS: Record<string, THREE.Material> = {};

// Streets v4 palette (2026-07-10, Mario-Kart pass): mid-grey blue asphalt
// instead of near-black — big paved areas must read as surface, not void —
// warm cream sidewalks, bright curb lip.
const MAT_ASPHALT = new THREE.MeshStandardMaterial({ color: 0x555b68, roughness: 1 });
ROAD_MATERIALS.asphalt = MAT_ASPHALT;
const MAT_SIDEWALK = new THREE.MeshStandardMaterial({ color: 0xd9d3c2, roughness: 1 });
ROAD_MATERIALS.walk = MAT_SIDEWALK;
const MAT_CURB = new THREE.MeshStandardMaterial({ color: 0xe8e4d8, roughness: 1 });
ROAD_MATERIALS.curb = MAT_CURB;
// Markings are decals: polygon-offset wins the depth test against the
// asphalt even where the two drapes sample the terrain differently — no
// physical lift can guarantee that on curved ground.
const MAT_DASH = new THREE.MeshStandardMaterial({
  color: 0xf2b93e,
  roughness: 0.9,
  polygonOffset: true,
  polygonOffsetFactor: -2,
  polygonOffsetUnits: -4,
});
ROAD_MATERIALS.dash = MAT_DASH;
const MAT_YELLOW = new THREE.MeshStandardMaterial({
  color: 0xf2b83a,
  roughness: 0.9,
  polygonOffset: true,
  polygonOffsetFactor: -2,
  polygonOffsetUnits: -4,
});
ROAD_MATERIALS.yellow = MAT_YELLOW;
const MAT_WHITE = new THREE.MeshStandardMaterial({
  color: 0xf4f7f4,
  roughness: 0.9,
  polygonOffset: true,
  polygonOffsetFactor: -2,
  polygonOffsetUnits: -4,
});
ROAD_MATERIALS.white = MAT_WHITE;

// --- SF's loud street paint (Mario-Kart pass, 2026-07-10) ---
// The city's real palette IS the cartoon palette: Muni's red transit lanes,
// green bike lanes, the Castro rainbow crosswalk. All decal params identical
// to the other markings so everything still collapses into MAT_ROAD_MARK.
function paintMat(color: number): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color,
    roughness: 0.92,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -4,
  });
}
const MAT_MUNI_RED = paintMat(0xc04a38);
ROAD_MATERIALS.muni = MAT_MUNI_RED;
const MAT_BIKE_GREEN = paintMat(0x27824f);
ROAD_MATERIALS.bike = MAT_BIKE_GREEN;
const MAT_MANHOLE = paintMat(0x434956);
ROAD_MATERIALS.manhole = MAT_MANHOLE;
const RAINBOW_HEX = [0xe64236, 0xf08c2e, 0xf2ce3a, 0x3fae52, 0x3567d6, 0x8a4bc9] as const;
const MAT_RAINBOW = RAINBOW_HEX.map((c, i) => {
  const m = paintMat(c);
  ROAD_MATERIALS[`rb${i}`] = m;
  return m;
});

// --- Collapsed render materials ---
// The six flat colors above stay as the stable WIRE keys (worker payloads,
// caches, live street rebuild), but meshes render through just TWO materials
// with the color baked into a vertex attribute (the ground already renders
// this way): one base surface (asphalt/sidewalk/curb) and one polygon-offset
// paint overlay (dash/yellow/white share identical decal params). Same final
// colors, a third of the draw calls per chunk.
const MAT_ROAD_BASE = new THREE.MeshStandardMaterial({
  color: 0xffffff,
  vertexColors: true,
  roughness: 1,
});
/**
 * True on phones (coarse primary pointer), where fill rate — not draw calls —
 * is the budget. The surface shaders below compile a reduced variant there.
 * Guarded for the gen worker and the node test harness, which have no
 * `window`; in practice it only ever runs inside `onBeforeCompile`, which is
 * main-thread-only (the worker never renders).
 */
export function lowDetailSurfaces(): boolean {
  return typeof window !== "undefined" && window.matchMedia("(pointer: coarse)").matches;
}

// Asphalt surface shader — runtime only, on the SHARED base material, so it
// covers live AND baked worlds (no rebake) and costs zero extra geometry.
// Exported so the freeway deck reads as the SAME asphalt — ramp mouths merge
// seamlessly.
//
// The material also carries the sidewalk and the curb (one collapsed draw
// call, colors in a vertex attribute), so everything past the aggregate
// speckle is gated on the asphalt's blue cast: asphalt is the only base color
// with b > r (0x555b68 vs the cream walk/curb).
//
// On top of the speckle, all in world space so the pattern is deterministic
// and seamless across chunk boundaries:
//   - resurfacing patches, whole rectangles a few percent off in value;
//   - utility-trench scars, the same rectangles at a high aspect ratio;
//   - a very-low-frequency warm/cool drift, so districts don't share one mix;
//   - scored pale concrete on grades past ~15%, SF's steep-block paving,
//     with grooves transverse to the fall line.
// All of it stays inside ±10% of the base color — this is a flat-shaded game,
// the texture is meant to be felt, not read.
export function applyAsphaltSpeckle(mat: THREE.MeshStandardMaterial): void {
  mat.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace(
        "#include <common>",
        "#include <common>\nvarying vec3 vRoadPos;\nvarying vec3 vRoadNrm;",
      )
      .replace(
        "#include <begin_vertex>",
        `#include <begin_vertex>
vRoadPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
// World normal of the DRAPE (conformToTerrain writes the engineered street
// profile's normal here), for the grade branch. Length-guarded: a geometry
// that ever shipped without normals would otherwise normalize a zero vector.
vec3 roadN = mat3(modelMatrix) * objectNormal;
float roadNL = length(roadN);
vRoadNrm = roadNL > 1e-4 ? roadN / roadNL : vec3(0.0, 1.0, 0.0);`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        `#include <common>
${lowDetailSurfaces() ? "" : "#define ROAD_SURFACE_FULL 1"}
varying vec3 vRoadPos;
varying vec3 vRoadNrm;
float roadHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float roadNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = p - i;
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(roadHash(i), roadHash(i + vec2(1.0, 0.0)), u.x),
    mix(roadHash(i + vec2(0.0, 1.0)), roadHash(i + vec2(1.0, 1.0)), u.x),
    u.y);
}
// One random axis-aligned rectangle per \`cell\`-sized world cell, kept wholly
// inside its cell so no patch ever reads as tiled. Returns (coverage, tone):
// coverage is antialiased off the world-space derivative — NOT off the edge
// distance, which jumps at cell borders and would draw the grid — so patches
// dissolve at distance instead of shimmering. Tone reuses the accept hash, so
// some patches come out darker and some lighter for free.
vec2 roadPatch(vec2 wp, vec2 dwp, float cell, vec2 hmin, vec2 hvar, float density, float seed) {
  vec2 c = floor(wp / cell);
  float pick = roadHash(c + seed);
  if (pick > density) return vec2(0.0);
  vec2 f = wp / cell - c;
  if (roadHash(c + seed + 41.7) > 0.5) f = f.yx; // half the cuts run crossways
  vec2 h = hmin + hvar * vec2(roadHash(c + seed + 3.7), roadHash(c + seed + 9.1));
  vec2 ctr = h + (1.0 - 2.0 * h) * vec2(roadHash(c + seed + 17.3), roadHash(c + seed + 23.9));
  vec2 d = abs(f - ctr) - h;
  float aa = max(dwp.x, dwp.y) / cell + 1e-5;
  return vec2(1.0 - smoothstep(-aa, aa, max(d.x, d.y)), pick / density * 2.0 - 1.0);
}`,
      )
      .replace(
        "#include <color_fragment>",
        `#include <color_fragment>
{
  vec2 wp = vRoadPos.xz;
  // Grooves run transverse to the fall line, which on a hill street IS
  // transverse to travel — the horizontal normal gives the axis for free.
  vec2 nxz = vRoadNrm.xz;
  float nl = length(nxz);
  float phase = dot(wp, nxz / max(nl, 1e-4)) * 1.15;
  // Derivatives stay in UNIFORM control flow: a quad straddling the asphalt/
  // sidewalk seam of a merged mesh takes both sides of the gate below, and
  // fwidth() inside a divergent branch is undefined.
  vec2 dwp = fwidth(wp);
  float dphase = fwidth(phase);
  float speck = roadHash(floor(wp * 1.7));
  float coarse = roadHash(floor(wp * 0.21));
  diffuseColor.rgb *= 1.0 + (speck - 0.5) * 0.05 + (coarse - 0.5) * 0.045;
  // Asphalt is the only base color with a blue cast; walk/curb are cream.
  float asph = smoothstep(0.0, 0.03, diffuseColor.b - diffuseColor.r);
  if (asph > 0.01) {
    vec2 slab = roadPatch(wp, dwp, 26.0, vec2(0.13), vec2(0.17), 0.34, 0.0);
    float wear = slab.x * slab.y * 0.055;
    #ifdef ROAD_SURFACE_FULL
      vec2 cut = roadPatch(wp, dwp, 47.0, vec2(0.40, 0.022), vec2(0.06, 0.018), 0.26, 71.3);
      wear += cut.x * (cut.y * 0.045 - 0.035); // fresh cuts read darker than the mix
      // District drift: ~300u wavelength warm/cool, so the Sunset and SoMa
      // are not laid in the same batch of asphalt.
      float drift = roadNoise(wp * 0.0032) - 0.5;
      diffuseColor.rgb *= 1.0 + asph * drift * vec3(0.07, 0.01, -0.07);
    #endif
    diffuseColor.rgb *= 1.0 + wear * asph;
    // Steep blocks are scored concrete, not asphalt (Filbert, 22nd, Jones).
    float steep = smoothstep(0.15, 0.28, nl / max(vRoadNrm.y, 0.05)) * asph;
    if (steep > 0.01) {
      float groove = (0.5 - 0.5 * cos(phase * 6.2831853))
        * (1.0 - smoothstep(0.35, 0.9, dphase)); // drop the pattern once undersampled
      vec3 conc = vec3(0.30, 0.29, 0.26);
      #ifdef ROAD_SURFACE_FULL
        conc *= 0.88 + 0.24 * roadNoise(wp * 0.35); // slab-to-slab value variation
      #endif
      diffuseColor.rgb = mix(diffuseColor.rgb, conc * (1.0 - groove * 0.15), steep * 0.7);
    }
  }
}`,
      );
  };
}
applyAsphaltSpeckle(MAT_ROAD_BASE);
ROAD_MATERIALS.roadbase = MAT_ROAD_BASE;
const MAT_ROAD_MARK = new THREE.MeshStandardMaterial({
  color: 0xffffff,
  vertexColors: true,
  roughness: 0.9,
  polygonOffset: true,
  polygonOffsetFactor: -2,
  polygonOffsetUnits: -4,
});
ROAD_MATERIALS.roadmark = MAT_ROAD_MARK;

type CollapseTarget = { readonly mat: THREE.Material; readonly color: THREE.Color };
const BASE_TARGET: CollapseTarget = { mat: MAT_ROAD_BASE, color: MAT_ASPHALT.color };
// Legacy material key → collapsed material + the color it used to carry.
const COLLAPSE_BY_KEY: Record<string, CollapseTarget> = {
  asphalt: BASE_TARGET,
  walk: { mat: MAT_ROAD_BASE, color: MAT_SIDEWALK.color },
  curb: { mat: MAT_ROAD_BASE, color: MAT_CURB.color },
  dash: { mat: MAT_ROAD_MARK, color: MAT_DASH.color },
  yellow: { mat: MAT_ROAD_MARK, color: MAT_YELLOW.color },
  white: { mat: MAT_ROAD_MARK, color: MAT_WHITE.color },
  muni: { mat: MAT_ROAD_MARK, color: MAT_MUNI_RED.color },
  bike: { mat: MAT_ROAD_MARK, color: MAT_BIKE_GREEN.color },
  manhole: { mat: MAT_ROAD_MARK, color: MAT_MANHOLE.color },
};
for (let i = 0; i < MAT_RAINBOW.length; i++) {
  const m = MAT_RAINBOW[i];
  if (m) COLLAPSE_BY_KEY[`rb${i}`] = { mat: MAT_ROAD_MARK, color: m.color };
}

// Collapse target for a captured/baked material descriptor (legacy rest.bin
// chunks carry the six flat road materials): matched by the exact colors the
// capture serialized. Already-collapsed (vertex-colored) recs pass through.
export function roadCollapseTarget(
  colorHex: number,
  polygonOffset: boolean,
  vertexColors: boolean,
): CollapseTarget | null {
  if (vertexColors) {
    // Already-collapsed capture (white + vertex colors): route back onto the
    // SHARED road materials instead of a descriptor clone, so runtime shader
    // tweaks (asphalt speckle) reach baked worlds too. Callers must keep the
    // rec's own vertex colors in this case (color here is just the uniform).
    if (colorHex === 0xffffff) {
      return polygonOffset
        ? { mat: MAT_ROAD_MARK, color: MAT_ROAD_MARK.color }
        : { mat: MAT_ROAD_BASE, color: MAT_ROAD_BASE.color };
    }
    return null;
  }
  for (const t of Object.values(COLLAPSE_BY_KEY)) {
    const isMark = t.mat === MAT_ROAD_MARK;
    if (isMark === polygonOffset && t.color.getHex() === colorHex) return t;
  }
  return null;
}

// Fill a constant vertex-color attribute matching `color` (linear-space, the
// same value the collapsed flat material used as its uniform color).
export function bakeConstantColor(geo: THREE.BufferGeometry, color: THREE.Color): void {
  const pos = geo.getAttribute("position");
  const col = new Float32Array(pos.count * 3);
  for (let i = 0; i < col.length; i += 3) {
    col[i] = color.r;
    col[i + 1] = color.g;
    col[i + 2] = color.b;
  }
  geo.setAttribute("color", new THREE.BufferAttribute(col, 3));
}

type Part = { geo: THREE.BufferGeometry; mat: THREE.Material; lift: number; maxError?: number };

export type RoadPartBuffers = {
  matKey: string;
  position: Float32Array;
  normal: Float32Array;
  uv: Float32Array | null;
  index: Uint16Array | Uint32Array | null;
};

type Pair = [number, number];

const SNAP = 64; // 1/64 u grid: exact in binary floating point
const snap = (v: number): number => Math.round(v * SNAP) / SNAP;
type Ring = Pair[];
type Poly = Ring[]; // [outer, ...holes]
type MultiPoly = Poly[];

// A polyline resampled to the working section [s0, s1] with per-vertex
// mitered offset normals — the core sweep primitive.
type Rail = { pts: number[]; normals: number[] }; // flat [x,z] pairs

function railFor(edge: NetEdge, s0: number, s1: number): Rail | null {
  if (s1 - s0 < 0.6) return null;
  const pts: number[] = [];
  const n = edge.pts.length / 2;
  const at = (s: number): readonly [number, number] => {
    let k = 1;
    while (k < n - 1 && (edge.cum[k] ?? 0) < s) k++;
    const sa = edge.cum[k - 1] ?? 0;
    const sb = edge.cum[k] ?? 0;
    const t = sb > sa ? (s - sa) / (sb - sa) : 0;
    return [
      (edge.pts[k * 2 - 2] ?? 0) + ((edge.pts[k * 2] ?? 0) - (edge.pts[k * 2 - 2] ?? 0)) * t,
      (edge.pts[k * 2 - 1] ?? 0) + ((edge.pts[k * 2 + 1] ?? 0) - (edge.pts[k * 2 - 1] ?? 0)) * t,
    ];
  };
  const [ex0, ez0] = at(s0);
  pts.push(ex0, ez0);
  for (let k = 0; k < n; k++) {
    const s = edge.cum[k] ?? 0;
    if (s > s0 + 0.3 && s < s1 - 0.3) pts.push(edge.pts[k * 2] ?? 0, edge.pts[k * 2 + 1] ?? 0);
  }
  const [ex1, ez1] = at(s1);
  pts.push(ex1, ez1);

  const m = pts.length / 2;
  const normals: number[] = [];
  for (let i = 0; i < m; i++) {
    const px = pts[Math.max(0, i - 1) * 2] ?? 0;
    const pz = pts[Math.max(0, i - 1) * 2 + 1] ?? 0;
    const nx2 = pts[Math.min(m - 1, i + 1) * 2] ?? 0;
    const nz2 = pts[Math.min(m - 1, i + 1) * 2 + 1] ?? 0;
    const dx = nx2 - px;
    const dz = nz2 - pz;
    const dl = Math.hypot(dx, dz) || 1;
    let mx = -dz / dl;
    let mz = dx / dl;
    if (i > 0 && i < m - 1) {
      const d1x = (pts[i * 2] ?? 0) - px;
      const d1z = (pts[i * 2 + 1] ?? 0) - pz;
      const l1 = Math.hypot(d1x, d1z) || 1;
      const dot = (d1x / l1) * (dx / dl) + (d1z / l1) * (dz / dl);
      const scale = Math.min(MITER_LIMIT, 1 / Math.max(0.4, Math.sqrt((1 + dot) / 2)));
      mx *= scale;
      mz *= scale;
    }
    normals.push(mx, mz);
  }
  return { pts, normals };
}

// Miter length cap as a function of the lateral offset: hairpin vertices
// carry miter scales up to MITER_LIMIT; at pave offsets (~9u) that is a 22u
// lateral spike. Allow at most 4u of extra lateral reach.
function miterCap(rail: Rail, i: number, off: number): number {
  const nx = rail.normals[i * 2] ?? 0;
  const nz = rail.normals[i * 2 + 1] ?? 0;
  const nLen = Math.hypot(nx, nz) || 1;
  const allowed = 1 + 4 / Math.max(Math.abs(off), 0.5);
  return nLen > allowed ? allowed / nLen : 1;
}

// Closed ring covering the strip between two lateral offsets of a rail.
function railRing(rail: Rail, off0: number, off1: number): Ring {
  const m = rail.pts.length / 2;
  const ring: Ring = [];
  for (let i = 0; i < m; i++) {
    const k = miterCap(rail, i, off1);
    ring.push([
      snap((rail.pts[i * 2] ?? 0) + (rail.normals[i * 2] ?? 0) * off1 * k),
      snap((rail.pts[i * 2 + 1] ?? 0) + (rail.normals[i * 2 + 1] ?? 0) * off1 * k),
    ]);
  }
  for (let i = m - 1; i >= 0; i--) {
    const k = miterCap(rail, i, off0);
    ring.push([
      snap((rail.pts[i * 2] ?? 0) + (rail.normals[i * 2] ?? 0) * off0 * k),
      snap((rail.pts[i * 2 + 1] ?? 0) + (rail.normals[i * 2 + 1] ?? 0) * off0 * k),
    ]);
  }
  return ring;
}

// Quad strip geometry between two offsets (markings only — no booleans).
function stripGeo(rail: Rail, off0: number, off1: number): THREE.BufferGeometry {
  const m = rail.pts.length / 2;
  const pos: number[] = [];
  for (let i = 0; i + 1 < m; i++) {
    const corner = (j: number, off: number): readonly [number, number] => {
      const k = miterCap(rail, j, off);
      return [
        (rail.pts[j * 2] ?? 0) + (rail.normals[j * 2] ?? 0) * off * k,
        (rail.pts[j * 2 + 1] ?? 0) + (rail.normals[j * 2 + 1] ?? 0) * off * k,
      ];
    };
    const [ax, az] = corner(i, off0);
    const [bx, bz] = corner(i, off1);
    const [cx, cz] = corner(i + 1, off1);
    const [dx2, dz2] = corner(i + 1, off0);
    pos.push(ax, 0, az, bx, 0, bz, cx, 0, cz, ax, 0, az, cx, 0, cz, dx2, 0, dz2);
  }
  return flatGeo(pos);
}

// Small up-facing disc (manhole covers) — center fan, wound to match the
// planar-map triangles (see multiPolyGeo's cross check).
function discGeo(cx: number, cz: number, r: number, segs = 10): THREE.BufferGeometry {
  const pos: number[] = [];
  for (let i = 0; i < segs; i++) {
    const a0 = (i / segs) * Math.PI * 2;
    const a1 = ((i + 1) / segs) * Math.PI * 2;
    pos.push(
      cx,
      0,
      cz,
      cx + Math.cos(a1) * r,
      0,
      cz + Math.sin(a1) * r,
      cx + Math.cos(a0) * r,
      0,
      cz + Math.sin(a0) * r,
    );
  }
  return flatGeo(pos);
}

function flatGeo(pos: number[]): THREE.BufferGeometry {
  const geo = new THREE.BufferGeometry();
  const nor = new Float32Array(pos.length);
  for (let i = 1; i < nor.length; i += 3) nor[i] = 1;
  const uv = new Float32Array((pos.length / 3) * 2);
  geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(pos), 3));
  geo.setAttribute("normal", new THREE.BufferAttribute(nor, 3));
  geo.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  return geo;
}

// Intersection of two rays (p + t*d); null when near-parallel.
function lineIntersect(
  ax: number,
  az: number,
  adx: number,
  adz: number,
  bx: number,
  bz: number,
  bdx: number,
  bdz: number,
): Pair | null {
  const den = adx * bdz - adz * bdx;
  if (Math.abs(den) < 1e-4) return null;
  const t = ((bx - ax) * bdz - (bz - az) * bdx) / den;
  return [ax + adx * t, az + adz * t];
}

type Arm = {
  angle: number;
  tx: number; // outward tangent (away from the node)
  tz: number;
  half: number;
  px: number; // centreline trim point
  pz: number;
  sec: number; // swept section length of the owning edge
};

// Junction polygon at a lateral grow of `extra` beyond each arm's asphalt.
function patchRing(
  nx: number,
  nz: number,
  arms: readonly Arm[],
  extra: number,
  trimCap: number,
): Ring {
  const ring: Ring = [];
  for (let i = 0; i < arms.length; i++) {
    const a = arms[i];
    const b = arms[(i + 1) % arms.length];
    if (!a || !b) continue;
    const ha = a.half + extra;
    const hb = b.half + extra;
    ring.push([snap(a.px + a.tz * ha), snap(a.pz - a.tx * ha)]); // a minus side
    ring.push([snap(a.px - a.tz * ha), snap(a.pz + a.tx * ha)]); // a plus side
    // The corner fills the notch between adjacent arm edges — but only wide
    // angular gaps HAVE a notch. At shallow gaps the strips overlap and the
    // ray intersection shoots off as a needle spike across the sidewalk
    // (the "dark wedge over the walk" artifact).
    let gap = b.angle - a.angle;
    if (arms.length === 1 || gap <= 0) gap += Math.PI * 2;
    if (gap < 0.9) continue;
    const corner = lineIntersect(
      a.px - a.tz * ha,
      a.pz + a.tx * ha,
      -a.tx,
      -a.tz,
      b.px + b.tz * hb,
      b.pz - b.tx * hb,
      -b.tx,
      -b.tz,
    );
    if (corner) {
      const cd = Math.hypot(corner[0] - nx, corner[1] - nz);
      if (cd < trimCap + extra * 2) ring.push([snap(corner[0]), snap(corner[1])]);
    }
  }
  return ring;
}

// Dead-end cap ring: half-disc past the trim point.
function capRing(arm: Arm, extra: number): Ring {
  const r = arm.half + extra;
  const base = Math.atan2(arm.tx, -arm.tz);
  const ring: Ring = [];
  const SEGS = 10;
  for (let i = 0; i <= SEGS; i++) {
    const a = base + (i / SEGS) * Math.PI;
    ring.push([snap(arm.px + Math.cos(a) * r), snap(arm.pz + Math.sin(a) * r)]);
  }
  return ring;
}

// Signed distance from a ring's boundary, negative inside. The paint clip
// tests the junction patch it actually has to avoid; the old circle of radius
// nodeTrim*1.55 was the patch's CIRCUMSCRIBED radius, so it over-clipped by
// ~0.55·nodeTrim at both ends of every block — enough to leave the 20–40u
// blocks that are most of the SF grid with no centre line at all.
function ringSignedDist(ring: Ring, x: number, z: number): number {
  let best = Infinity;
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i];
    const b = ring[j];
    if (!a || !b) continue;
    if (a[1] > z !== b[1] > z && x < ((b[0] - a[0]) * (z - a[1])) / (b[1] - a[1]) + a[0])
      inside = !inside;
    const dx = b[0] - a[0];
    const dz = b[1] - a[1];
    const l2 = dx * dx + dz * dz;
    const t = l2 > 0 ? Math.max(0, Math.min(1, ((x - a[0]) * dx + (z - a[1]) * dz) / l2)) : 0;
    best = Math.min(best, Math.hypot(x - (a[0] + dx * t), z - (a[1] + dz * t)));
  }
  return inside ? -best : best;
}

// The whole boolean pipeline runs PER SPATIAL TILE with bbox-filtered local
// inputs. City-scale sweeps are both slow (the accumulator grows with every
// chunk) and fragile (martinez corrupts on huge inputs); per-tile the inputs
// are dozens of polygons, the work is linear in the city, and any failure
// costs one tile. Adjacent tiles share exact snapped cut lines, so the seams
// are invisible.
type PlanarMap = { asphalt: MultiPoly; curb: MultiPoly; walk: MultiPoly };

function bboxOf(poly: Poly): [number, number, number, number] {
  let x0 = Infinity;
  let z0 = Infinity;
  let x1 = -Infinity;
  let z1 = -Infinity;
  for (const [x, z] of poly[0] ?? []) {
    x0 = Math.min(x0, x);
    x1 = Math.max(x1, x);
    z0 = Math.min(z0, z);
    z1 = Math.max(z1, z);
  }
  return [x0, z0, x1, z1];
}

function tiledPlanarMap(asphaltPolys: Poly[], curbPolys: Poly[], pavePolys: Poly[]): PlanarMap {
  const boxes = {
    a: asphaltPolys.map(bboxOf),
    c: curbPolys.map(bboxOf),
    p: pavePolys.map(bboxOf),
  };
  let minX = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxZ = -Infinity;
  for (const [x0, z0, x1, z1] of boxes.p) {
    minX = Math.min(minX, x0);
    maxX = Math.max(maxX, x1);
    minZ = Math.min(minZ, z0);
    maxZ = Math.max(maxZ, z1);
  }
  const TILES = 12;
  const dx = (maxX - minX) / TILES;
  const dz = (maxZ - minZ) / TILES;
  const out: PlanarMap = { asphalt: [], curb: [], walk: [] };
  let failed = 0;
  for (let ix = 0; ix < TILES; ix++) {
    for (let iz = 0; iz < TILES; iz++) {
      const x0 = minX + ix * dx;
      const z0 = minZ + iz * dz;
      const x1 = x0 + dx;
      const z1 = z0 + dz;
      const rect: Poly = [
        [
          [snap(x0), snap(z0)],
          [snap(x1), snap(z0)],
          [snap(x1), snap(z1)],
          [snap(x0), snap(z1)],
        ],
      ];
      const local = (polys: Poly[], bx: [number, number, number, number][]): Poly[] =>
        polys.filter((_, i) => {
          const b = bx[i];
          return b !== undefined && b[0] <= x1 && b[2] >= x0 && b[1] <= z1 && b[3] >= z0;
        });
      const aLoc = local(asphaltPolys, boxes.a);
      if (aLoc.length === 0) continue;
      try {
        const A = polygonClipping.intersection(polygonClipping.union([], ...aLoc), [rect]);
        if (A.length === 0) continue;
        out.asphalt.push(...A);
        const C = polygonClipping.intersection(
          polygonClipping.union([], ...local(curbPolys, boxes.c)),
          [rect],
        );
        out.curb.push(...polygonClipping.difference(C, A));
        const P = polygonClipping.intersection(
          polygonClipping.union([], ...local(pavePolys, boxes.p)),
          [rect],
        );
        out.walk.push(...polygonClipping.difference(P, A));
      } catch {
        failed++;
      }
    }
  }
  if (failed > 0) console.warn(`[roads] planar map: ${failed} tiles degraded`);
  return out;
}

// Triangulate a boolean-result multipolygon into a flat draped geometry.
function multiPolyGeo(mp: MultiPoly): THREE.BufferGeometry {
  const pos: number[] = [];
  for (const poly of mp) {
    const outer = poly[0];
    if (!outer || outer.length < 3) continue;
    const contour = outer.map(([x, z]) => new THREE.Vector2(x, z));
    // Drop the duplicated closing point if present.
    const last = contour[contour.length - 1];
    const first = contour[0];
    if (last && first && last.distanceToSquared(first) < 1e-9) contour.pop();
    const holes: THREE.Vector2[][] = [];
    for (let h = 1; h < poly.length; h++) {
      const ring = poly[h];
      if (!ring || ring.length < 3) continue;
      const hv = ring.map(([x, z]) => new THREE.Vector2(x, z));
      const hl = hv[hv.length - 1];
      const hf = hv[0];
      if (hl && hf && hl.distanceToSquared(hf) < 1e-9) hv.pop();
      holes.push(hv);
    }
    const all = [...contour, ...holes.flat()];
    let tris: number[][];
    try {
      tris = THREE.ShapeUtils.triangulateShape(contour, holes);
    } catch {
      continue;
    }
    for (const t of tris) {
      const a = all[t[0] ?? 0];
      const b = all[t[1] ?? 0];
      const c = all[t[2] ?? 0];
      if (!a || !b || !c) continue;
      // +Y winding in XZ: (b−a)×(c−a) must point up.
      const cross = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
      if (cross < 0) pos.push(a.x, 0, a.y, b.x, 0, b.y, c.x, 0, c.y);
      else pos.push(a.x, 0, a.y, c.x, 0, c.y, b.x, 0, b.y);
    }
  }
  return flatGeo(pos);
}

/** patchRing's corner-fan cap, in nodeTrim units. */
const PATCH_FACTOR = 1.55;

export type JunctionMap = {
  /** angle-sorted arms per node (null where the node carries no edges) */
  readonly arms: readonly (readonly Arm[] | null)[];
  /**
   * True when (x, z) is within `margin` of a junction patch. `margin` is a
   * SIGNED offset from the patch boundary: positive keeps a marking that far
   * clear of the junction, negative lets it run that far into the junction's
   * open asphalt (boulevard centre-of-roadway paint).
   */
  near(x: number, z: number, margin: number): boolean;
};

/**
 * Junction patches, built once and shared by the drawn asphalt and the paint
 * clip — so paint can neither overlap a patch (the old "spoke" stripes) nor be
 * clipped by a circle the patch never fills. Exported so `pnpm test` can
 * assert paint coverage against the real predicate.
 */
export function buildJunctionMap(network: RoadNetwork): JunctionMap {
  const nodeArms: (readonly Arm[] | null)[] = network.nodes.map(() => null);
  const patchRings: (Ring | null)[] = network.nodes.map(() => null);
  const patchBuckets = new Map<string, number[]>();
  const NB = 40;
  let maxPatchR = 0;
  for (let n = 0; n < network.nodes.length; n++) {
    const ids = network.nodeEdges[n];
    const node = network.nodes[n];
    if (!ids || ids.length === 0 || !node) continue;
    const arms: Arm[] = [];
    for (const id of ids) {
      const edge = network.edges[id];
      if (!edge) continue;
      const ends: ("a" | "b")[] = [];
      if (edge.a === n) ends.push("a");
      if (edge.b === n) ends.push("b");
      for (const end of ends) {
        const trim = Math.min(network.nodeTrim(n), edge.len * 0.45);
        const s0 = end === "a" ? trim : edge.len - trim;
        const smp = network.sample(edge, s0);
        const sign = end === "a" ? 1 : -1;
        arms.push({
          angle: Math.atan2(smp.tz * sign, smp.tx * sign),
          tx: smp.tx * sign,
          tz: smp.tz * sign,
          half: edge.half,
          px: smp.x,
          pz: smp.z,
          sec:
            edge.len -
            trim -
            Math.min(network.nodeTrim(end === "a" ? edge.b : edge.a), edge.len * 0.45),
        });
      }
    }
    if (arms.length === 0) continue;
    arms.sort((u, v) => u.angle - v.angle);
    nodeArms[n] = arms;
    const first = arms[0];
    const ring =
      arms.length === 1 && first
        ? capRing(first, 0)
        : patchRing(node[0], node[1], arms, 0, network.nodeTrim(n) * PATCH_FACTOR);
    if (ring.length < 3) continue;
    patchRings[n] = ring;
    // Mid-street joints (two near-collinear arms) are not junctions — paint
    // runs straight through them, so they stay out of the clip index.
    if (network.nodeIsPassThrough(n)) continue;
    let r = 0;
    for (const [px, pz] of ring) r = Math.max(r, Math.hypot(px - node[0], pz - node[1]));
    maxPatchR = Math.max(maxPatchR, r);
    const k = `${Math.floor(node[0] / NB)},${Math.floor(node[1] / NB)}`;
    const arr = patchBuckets.get(k) ?? [];
    arr.push(n);
    patchBuckets.set(k, arr);
  }
  return {
    arms: nodeArms,
    near(x: number, z: number, margin: number): boolean {
      const bx = Math.floor(x / NB);
      const bz = Math.floor(z / NB);
      const reach = maxPatchR + Math.max(margin, 0);
      const rings = Math.max(1, Math.ceil(reach / NB));
      for (let ix = bx - rings; ix <= bx + rings; ix++) {
        for (let iz = bz - rings; iz <= bz + rings; iz++) {
          for (const n of patchBuckets.get(`${ix},${iz}`) ?? []) {
            const node = network.nodes[n];
            const ring = patchRings[n];
            if (!node || !ring) continue;
            if (Math.hypot(node[0] - x, node[1] - z) > reach) continue;
            if (ringSignedDist(ring, x, z) < margin) return true;
          }
        }
      }
      return false;
    },
  };
}

export function buildRoadParts(network: RoadNetwork, terrain: DrapeField): RoadPartBuffers[] {
  const asphaltPolys: Poly[] = [];
  const curbPolys: Poly[] = [];
  const pavePolys: Poly[] = [];
  const markingParts: Part[] = [];

  const junctions = buildJunctionMap(network);
  const nodeArms = junctions.arms;
  const nearJunction = junctions.near;

  // --- Edge sweeps as polygons + markings ---
  for (const edge of network.edges) {
    const trimA = Math.min(network.nodeTrim(edge.a), edge.len * 0.45);
    const trimB = Math.min(network.nodeTrim(edge.b), edge.len * 0.45);
    const rail = railFor(edge, trimA, edge.len - trimB);
    if (!rail) continue;
    const h = edge.half;
    asphaltPolys.push([railRing(rail, -h, h)]);
    curbPolys.push([railRing(rail, -h - CURB_W, h + CURB_W)]);
    pavePolys.push([railRing(rail, -h - walkFor(h), h + walkFor(h))]);

    // Street paint schemes (variety pass, KayKit-tile spirit): boulevards
    // stay consistent — yellow edges + white lane dashes (± a double-yellow
    // divider) — while the minor grid mixes real street types: yellow or
    // white centre lines, dashed or solid or double, some streets bare.
    // A physical street is a CHAIN of edges, so hashing per edge would flip
    // the style every block: the scheme is keyed on the street's LINE
    // (quantized direction mod 180° + quantized perpendicular offset), which
    // every edge of a straight street shares.
    const major = h > 4.7; // primary/secondary (see CLASS_HALF in bake-network)
    const eo = h - EDGE_INSET;
    const secLen = edge.len - trimA - trimB;
    // Mid-street joints (two near-collinear arms) are not junctions — they are
    // already out of the paint clip — but the rail was still cut back by
    // nodeTrim at both ends, punching a ~12u hole through every line in the
    // MIDDLE of a straight block. Paint runs through on its own trim; the
    // 2-arm patch has already paved that asphalt.
    const paintA = network.nodeIsPassThrough(edge.a) ? 0 : trimA;
    const paintB = network.nodeIsPassThrough(edge.b) ? 0 : trimB;
    const paintLen = edge.len - paintA - paintB;
    const midSmp = network.sample(edge, trimA + secLen / 2);
    let streetAng = Math.atan2(midSmp.tz, midSmp.tx);
    if (streetAng < 0) streetAng += Math.PI;
    const dirBucket = Math.round((streetAng / Math.PI) * 12) % 12;
    const bucketAng = (dirBucket / 12) * Math.PI;
    const lineOff = Math.round(
      (midSmp.x * -Math.sin(bucketAng) + midSmp.z * Math.cos(bucketAng)) / 9,
    );
    let sh = ((dirBucket + 3) * 73856093) ^ (lineOff * 19349663);
    sh = Math.imul(sh ^ (sh >>> 13), 0x45d9f3b);
    const h01 = ((sh ^ (sh >>> 16)) >>> 0) / 4294967296;
    const h2 = (h01 * 7.13) % 1;
    const h3 = (h01 * 13.71) % 1;
    const h4 = (h01 * 23.31) % 1;

    // Junction-clipped line runs: a full-rail strip radiates straight
    // through merged junction blobs (short edges barely trim, and
    // through-streets pass near foreign nodes) — the "spoke" bug.
    const emitLine = (off: number, mat: THREE.Material, margin = LINE_CLIP): void => {
      const steps = Math.max(1, Math.ceil(paintLen / 4));
      let runStart = -1;
      for (let i = 0; i <= steps; i++) {
        const sc = (i / steps) * paintLen;
        const smp = network.sample(edge, paintA + sc);
        const blocked = nearJunction(smp.x - smp.tz * off, smp.z + smp.tx * off, margin);
        if (!blocked && runStart < 0) runStart = sc;
        if (runStart >= 0 && (blocked || i === steps)) {
          const runEnd = blocked ? Math.max(runStart, sc - paintLen / steps) : sc;
          if (runEnd - runStart >= 2) {
            const r = railFor(edge, paintA + runStart, paintA + runEnd);
            if (r) {
              markingParts.push({
                geo: stripGeo(r, off - LINE_W / 2, off + LINE_W / 2),
                mat,
                lift: LINE_LIFT,
              });
            }
          }
          runStart = -1;
        }
      }
    };
    // Dashed line at an offset, junction-clipped, pattern centred in the
    // section so short blocks keep a visible dash.
    const emitDashes = (off: number, mat: THREE.Material, margin = DASH_CLIP): void => {
      for (let s = (paintLen % (DASH_LEN + DASH_GAP)) / 2; s < paintLen; s += DASH_LEN + DASH_GAP) {
        const e = Math.min(s + DASH_LEN, paintLen);
        if (e - s < 0.6) continue;
        const mid = network.sample(edge, paintA + (s + e) / 2);
        if (nearJunction(mid.x, mid.z, margin)) continue;
        const dashRail = railFor(edge, paintA + s, paintA + e);
        if (!dashRail) continue;
        markingParts.push({
          geo: stripGeo(dashRail, off - LINE_W / 2, off + LINE_W / 2),
          mat,
          lift: LINE_LIFT,
        });
      }
    };

    // Edge lines: always on boulevards (yellow); most minors carry white
    // ones, but a third of the grid runs bare-shouldered (real residentials).
    const hasEdgeLines = major || h01 < 0.65;
    if (hasEdgeLines) {
      const edgeMat = major ? MAT_YELLOW : MAT_WHITE;
      emitLine(eo, edgeMat);
      emitLine(-eo, edgeMat);
    }

    if (secLen >= 6) {
      if (major) {
        // Centre-of-roadway paint may run INTO a junction's open asphalt
        // (negative margin) — only EDGE lines must not slice across a merged
        // blob. Dense corridors (Market) otherwise read bald between nodes.
        emitDashes(-h * 0.33, MAT_WHITE, CENTRE_CLIP);
        emitDashes(h * 0.33, MAT_WHITE, CENTRE_CLIP);
        // Divided-boulevard look on some corridors: double-yellow centre.
        if (h2 < 0.45) {
          emitLine(0.28, MAT_YELLOW, CENTRE_CLIP);
          emitLine(-0.28, MAT_YELLOW, CENTRE_CLIP);
        }
      } else {
        // Minor-grid centre-line variety.
        if (h2 < 0.3) {
          emitDashes(0, MAT_DASH); // classic yellow dash
        } else if (h2 < 0.5) {
          emitLine(0, MAT_YELLOW); // solid yellow
        } else if (h2 < 0.62) {
          emitLine(0.26, MAT_YELLOW); // double yellow
          emitLine(-0.26, MAT_YELLOW);
        } else if (h2 < 0.8) {
          emitDashes(0, MAT_WHITE); // white dash
        }
        // else: bare street — no centre line at all.
      }
    }

    // A band between lateral offsets [in, out] on one side. Clipped by RUN
    // like the lines are: a midpoint test dropped whole 14u segments wherever
    // one end grazed a junction, which is what chewed the transit lane into
    // scattered red patches. The run is cut into segments afterwards, so a
    // continuous band (segLen = Infinity) just ends cleanly at the crosswalk.
    const paintBand = (
      side: -1 | 1,
      bandIn: number,
      bandOut: number,
      segLen: number,
      segGap: number,
      endMargin: number,
      mat: THREE.Material,
      junctionMargin = 4.5,
    ): void => {
      const o0 = Math.min(side * bandIn, side * bandOut);
      const o1 = Math.max(side * bandIn, side * bandOut);
      const lat = (o0 + o1) / 2;
      const lo = endMargin;
      const hi = paintLen - endMargin;
      if (hi - lo < 1.5) return;
      const emit = (a: number, b: number): void => {
        for (let s = a; s < b - 0.4; s += segLen + segGap) {
          const e = Math.min(s + segLen, b);
          if (e - s < Math.min(segLen, 1.6)) continue;
          const r = railFor(edge, paintA + s, paintA + e);
          if (r) markingParts.push({ geo: stripGeo(r, o0, o1), mat, lift: LINE_LIFT });
        }
      };
      const steps = Math.max(1, Math.ceil((hi - lo) / 2));
      let runStart = -1;
      for (let i = 0; i <= steps; i++) {
        const sc = lo + ((hi - lo) * i) / steps;
        const smp = network.sample(edge, paintA + sc);
        const blocked = nearJunction(smp.x - smp.tz * lat, smp.z + smp.tx * lat, junctionMargin);
        if (!blocked && runStart < 0) runStart = sc;
        if (runStart >= 0 && (blocked || i === steps)) {
          const runEnd = blocked ? Math.max(runStart, sc - (hi - lo) / steps) : sc;
          emit(runStart, runEnd);
          runStart = -1;
        }
      }
    };

    // Muni red transit lanes: ONLY the widest corridor class (Market/Van
    // Ness/Geary scale) — red everywhere reads rusty instead of special.
    // A thin curb-hugging lane, CONTINUOUS between crosswalks: real transit
    // lanes are one unbroken strip, and the old 14u segmentation read as
    // random red slabs dropped on the kerb.
    if (h >= 5.5) {
      // primary corridors only
      const laneOut = eo - LINE_W / 2 - 0.3;
      const laneIn = laneOut - 1.9;
      paintBand(-1, laneIn, laneOut, Infinity, 0, 3, MAT_MUNI_RED, 2.4);
      paintBand(1, laneIn, laneOut, Infinity, 0, 3, MAT_MUNI_RED, 2.4);
    }

    // Green bike lanes: a sparse subset of the minor grid — SF's bike-network
    // look without painting every street. Keyed on the STREET LINE (the same
    // hash as the centre-line scheme), not the OSM edge id: ids run in bake
    // order, so a modulo on them scattered 4.5u dashes over unrelated blocks
    // instead of running a lane the length of a street. Narrow + dark so they
    // read as PAINT (the old wide bright band read as grass medians), and
    // never stacked on solid/double-yellow streets — that was paint soup.
    const solidCentre = h2 >= 0.3 && h2 < 0.62;
    const bikeLane = !major && secLen > 8 && h4 < 0.12 && !solidCentre;
    if (bikeLane) {
      paintBand(-1, h - 1.75, h - 0.95, 4.5, 2.2, 3, MAT_BIKE_GREEN);
      paintBand(1, h - 1.75, h - 0.95, 4.5, 2.2, 3, MAT_BIKE_GREEN);
    }

    // Parking-bay ticks: short white separators inside the kerb lane — the
    // street reads as marked parking from above. Only on lined streets with
    // no bike lane claiming the same kerb strip.
    if (!major && h >= 3.6 && hasEdgeLines && !bikeLane && h3 < 0.45) {
      for (let s = 5; s < paintLen - 5; s += 7) {
        const smp = network.sample(edge, paintA + s);
        if (nearJunction(smp.x, smp.z, 4)) continue;
        const tickRail = railFor(edge, paintA + s, paintA + s + 0.62);
        if (!tickRail) continue;
        for (const side of [-1, 1] as const) {
          // stripGeo winds by off order (see paintBand) — keep off0 < off1.
          const o0 = Math.min(side * (h - 2.0), side * (h - 0.55));
          const o1 = Math.max(side * (h - 2.0), side * (h - 0.55));
          markingParts.push({
            geo: stripGeo(tickRail, o0, o1),
            mat: MAT_WHITE,
            lift: LINE_LIFT,
          });
        }
      }
    }

    // Manhole covers: sparse dark discs, alternating lanes on the minor grid.
    if (!major) {
      for (let s = 14; s < paintLen - 8; s += 34) {
        const smp = network.sample(edge, paintA + s);
        if (nearJunction(smp.x, smp.z, 5)) continue;
        const off = (Math.floor(s / 34) % 2 === 0 ? 1 : -1) * h * 0.45;
        const cx = smp.x - smp.tz * off;
        const cz = smp.z + smp.tx * off;
        markingParts.push({ geo: discGeo(cx, cz, 0.55), mat: MAT_MANHOLE, lift: LINE_LIFT });
      }
    }
  }

  let crosswalkArms = 0;
  // --- Junction patches + crosswalks + dead-end caps ---
  for (let n = 0; n < network.nodes.length; n++) {
    const node = network.nodes[n];
    const arms = nodeArms[n];
    if (!node || !arms || arms.length === 0) continue;
    const nx = node[0];
    const nz = node[1];

    if (arms.length === 1) {
      const a = arms[0];
      if (a) {
        asphaltPolys.push([capRing(a, 0)]);
        curbPolys.push([capRing(a, CURB_W)]);
        pavePolys.push([capRing(a, walkFor(a.half))]);
      }
      continue;
    }

    const trimCap = network.nodeTrim(n) * PATCH_FACTOR;
    const patchWalk = Math.max(...arms.map((a) => walkFor(a.half)));
    asphaltPolys.push([patchRing(nx, nz, arms, 0, trimCap)]);
    curbPolys.push([patchRing(nx, nz, arms, CURB_W, trimCap)]);
    pavePolys.push([patchRing(nx, nz, arms, patchWalk, trimCap)]);

    // Crosswalks follow the junction CONTROL (junction-control.ts): zebra
    // stripes at signalized crossings, transverse two-line crosswalks at
    // all-way stops — the same split SF paints. Only clean 3-4 arm nodes;
    // complex multi-arm junctions turn into a tangle. The room a crosswalk
    // needs is PER ARM (its band reaches ~4.5u out from the trim point), not
    // per node: gating the whole junction on its trim left the widest ones —
    // the ones whose approaches already lose the most paint — as featureless
    // asphalt lakes where several painted streets appear to just stop.
    const control = junctionControl(network, n);
    if (arms.length >= 3 && arms.length <= 4 && control !== "none") {
      const zebra = control === "signal";
      // The Castro paints its crosswalks rainbow — so do we.
      const gxN = Math.min(GRID_X - 1, Math.max(0, Math.floor((nx + WORLD_HALF_X) / ROAD_TILE)));
      const gzN = Math.min(GRID_Z - 1, Math.max(0, Math.floor((nz + WORLD_HALF_Z) / ROAD_TILE)));
      const rainbow = districtAt(gxN, gzN).name === "the Castro";
      for (let ai = 0; ai < arms.length; ai++) {
        const a = arms[ai];
        if (!a) continue;
        // 45° neighbours leave no room — zebra quads would overlap. Only
        // paint arms with >= 60° of clearance on both sides.
        const prev = arms[(ai + arms.length - 1) % arms.length];
        const next = arms[(ai + 1) % arms.length];
        const gapTo = (o: Arm | undefined): number => {
          if (!o || o === a) return Math.PI * 2;
          const g = Math.abs(a.angle - o.angle) % (Math.PI * 2);
          return Math.min(g, Math.PI * 2 - g);
        };
        if (Math.min(gapTo(prev), gapTo(next)) < Math.PI / 3) continue;
        // The band spans [0.9, outer + 1.0] outward — a shorter swept section
        // would spill it past the strip into the next node's patch.
        if (a.sec < CROSSWALK_ROOM) continue;
        const ox = -a.tz;
        const oz = a.tx;
        const quad = (out: number[], d0: number, d1: number, l0: number, l1: number): void => {
          // Coarse ~3u pre-slices only — conformToTerrain's adaptive split
          // adds density exactly where the terrain curves; a fixed fine grid
          // here just multiplied verts on dead-flat intersections.
          const dSlices = Math.max(1, Math.ceil((d1 - d0) / 3.0));
          const lSlices = Math.max(1, Math.ceil((l1 - l0) / 3.0));
          for (let di = 0; di < dSlices; di++) {
            for (let li = 0; li < lSlices; li++) {
              const da = d0 + ((d1 - d0) * di) / dSlices;
              const db = d0 + ((d1 - d0) * (di + 1)) / dSlices;
              const la = l0 + ((l1 - l0) * li) / lSlices;
              const lb = l0 + ((l1 - l0) * (li + 1)) / lSlices;
              const x00 = a.px + a.tx * da + ox * la;
              const z00 = a.pz + a.tz * da + oz * la;
              const x01 = a.px + a.tx * da + ox * lb;
              const z01 = a.pz + a.tz * da + oz * lb;
              const x10 = a.px + a.tx * db + ox * la;
              const z10 = a.pz + a.tz * db + oz * la;
              const x11 = a.px + a.tx * db + ox * lb;
              const z11 = a.pz + a.tz * db + oz * lb;
              // (t, o) is a LEFT-handed basis in XZ — emit reversed so the
              // triangles wind CCW from above (else they backface-cull).
              out.push(
                x00,
                0,
                z00,
                x11,
                0,
                z11,
                x10,
                0,
                z10,
                x00,
                0,
                z00,
                x01,
                0,
                z01,
                x11,
                0,
                z11,
              );
            }
          }
        };
        // Chunky zebra (stripes run with the road, laid across the width).
        const inner = 0.9;
        const outer = inner + (zebra ? 2.6 : 1.6);
        const usable = a.half - 0.8;
        const count = Math.max(4, Math.floor(usable / 0.95));
        crosswalkArms++;
        if (!zebra) {
          // Transverse crosswalk (all-way stops): two thin lines across the
          // roadway instead of the full zebra ladder.
          const lines: number[] = [];
          quad(lines, inner, inner + 0.3, -usable, usable);
          quad(lines, outer - 0.3, outer, -usable, usable);
          markingParts.push({ geo: flatGeo(lines), mat: MAT_WHITE, lift: LINE_LIFT });
        } else if (rainbow) {
          // Contiguous bands (half the stripe pitch each side) — gaps would
          // read as scattered confetti, not a rainbow.
          const halfW = usable / (count - 1);
          for (let k = 0; k < count; k++) {
            const lat = -usable + (k / (count - 1)) * 2 * usable;
            const stripe: number[] = [];
            quad(stripe, inner, outer, lat - halfW, lat + halfW);
            markingParts.push({
              geo: flatGeo(stripe),
              mat: MAT_RAINBOW[k % MAT_RAINBOW.length] ?? MAT_WHITE,
              lift: LINE_LIFT,
            });
          }
        } else {
          const stripes: number[] = [];
          for (let k = 0; k < count; k++) {
            const lat = -usable + (k / (count - 1)) * 2 * usable;
            quad(stripes, inner, outer, lat - 0.34, lat + 0.34);
          }
          markingParts.push({ geo: flatGeo(stripes), mat: MAT_WHITE, lift: LINE_LIFT });
        }
        // Stop bar just past the crosswalk: solid on boulevards, dashed on
        // streets (the KayKit look).
        const bar: number[] = [];
        const b0 = outer + 0.5;
        const b1 = b0 + 0.5;
        if (a.half > 4.7) {
          quad(bar, b0, b1, -usable, usable);
        } else {
          const segs = 4;
          for (let k = 0; k < segs; k++) {
            const l0 = -usable + (k / segs) * 2 * usable;
            quad(bar, b0, b1, l0, l0 + (usable * 2) / segs - 0.5);
          }
        }
        markingParts.push({ geo: flatGeo(bar), mat: MAT_WHITE, lift: LINE_LIFT });
      }
    }
  }

  // --- The planar map: overlap dissolves in the union ---
  console.log(`[roads] crosswalk arms painted: ${crosswalkArms}`);
  const t0 = performance.now();
  const { asphalt, curb, walk } = tiledPlanarMap(asphaltPolys, curbPolys, pavePolys);
  console.log(`[roads] planar map in ${Math.round(performance.now() - t0)}ms`);

  const surfaceParts: Part[] = [
    { geo: multiPolyGeo(asphalt), mat: MAT_ASPHALT, lift: ASPHALT_LIFT },
    { geo: multiPolyGeo(walk), mat: MAT_SIDEWALK, lift: SIDEWALK_LIFT },
    { geo: multiPolyGeo(curb), mat: MAT_CURB, lift: CURB_LIFT },
  ];

  const keyOfMat = new Map<THREE.Material, string>(
    Object.entries(ROAD_MATERIALS).map(([k, m]) => [m, k]),
  );
  const out: RoadPartBuffers[] = [];
  const publish = (mat: THREE.Material, draped: THREE.BufferGeometry): void => {
    const pos = draped.getAttribute("position");
    const nor = draped.getAttribute("normal");
    const uv = draped.getAttribute("uv");
    const idx = draped.index;
    out.push({
      matKey: keyOfMat.get(mat) ?? "asphalt",
      position: pos.array as Float32Array,
      normal: nor.array as Float32Array,
      uv: uv ? (uv.array as Float32Array) : null,
      index: idx ? (idx.array as Uint16Array | Uint32Array) : null,
    });
  };

  let asphaltSurface: SurfaceSampler | null = null;
  for (const p of surfaceParts) {
    const draped = conformToTerrain(p.geo, terrain, p.lift, p.maxError);
    if (p.mat === MAT_ASPHALT) asphaltSurface = surfaceSampler(draped);
    publish(p.mat, draped);
  }
  // Paint is SEATED on the asphalt that was just draped, not draped on its own
  // over the terrain. The two surfaces disagree (a 14u-wide roadway's chords
  // cut corners a 0.24u line's don't, and the terrace field steps between
  // them), which is why the lift had grown to 0.30u above the asphalt —
  // higher than the kerb lip, so every marking parallaxed off the road.
  const tPaint = performance.now();
  for (const p of markingParts) {
    const draped = conformToTerrain(p.geo, terrain, 0, MARKING_MAX_ERROR);
    seatOnSurface(draped, asphaltSurface, PAINT_SEAT, LINE_LIFT);
    publish(p.mat, draped);
  }
  console.log(`[roads] paint seated in ${Math.round(performance.now() - tPaint)}ms`);
  return out;
}

export function roadPartsToMeshes(parts: readonly RoadPartBuffers[]): THREE.Mesh[] {
  const out: THREE.Mesh[] = [];
  for (const p of parts) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(p.position, 3));
    geo.setAttribute("normal", new THREE.BufferAttribute(p.normal, 3));
    if (p.uv) geo.setAttribute("uv", new THREE.BufferAttribute(p.uv, 2));
    if (p.index) geo.setIndex(new THREE.BufferAttribute(p.index, 1));
    // Legacy wire key → one of the two collapsed vertex-colored materials.
    const target = COLLAPSE_BY_KEY[p.matKey] ?? BASE_TARGET;
    bakeConstantColor(geo, target.color);
    out.push(new THREE.Mesh(geo, target.mat));
  }
  return out;
}

export function buildRoads(network: RoadNetwork, terrain: DrapeField): THREE.Mesh[] {
  return roadPartsToMeshes(buildRoadParts(network, terrain));
}
