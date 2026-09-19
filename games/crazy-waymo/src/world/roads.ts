import * as THREE from "three";
import polygonClipping from "polygon-clipping";

import { ROAD_TILE, ROAD_Y, WORLD_H, WORLD_W } from "../shared/constants";
import { conformToTerrain, DRAPE_MAX_ERROR, surfaceSampler } from "./conform";
import type { DrapeField, SurfaceSampler } from "./conform";
import { junctionControl } from "./junction-control";
import type { JunctionControl } from "./junction-control";
import type { NetEdge, RoadNetwork } from "./network";
import { applyMaterialBreakup, ROAD_BREAKUP } from "../render/material-breakup";
import { busLoadAt, SF_TRANSIT } from "./sf-transit";

// PLANAR-MAP street geometry. Every edge sweep and junction patch is built as
// a 2D POLYGON, and the drawable surfaces are boolean combinations:
//
//   asphalt  = union(edge strips, junction patches, dead-end caps)
//   curb     = union(strips grown by CURB_W)  − asphalt
//   sidewalk = union(strips grown by SIDEWALK_W) − asphalt − curb
//
// Overlap between independently generated pieces — the source of every
// "sidewalk slicing across a road" bug — is dissolved by the union instead
// of being someone's rendering problem. Markings stay per-edge but are
// clipped away near junction nodes. The final triangulated surfaces drape
// over the terrain exactly like before.

// legacy uniform width (tertiary)
export const ASPHALT_W = ROAD_TILE * 0.8;
// Kit-matched profile — chunky light curbs, brighter sidewalks, cleaner
// asphalt (KayKit City Builder look). Streets v3, 2026-07-07.
// arterial sidewalks (ground aprons key off this)
export const SIDEWALK_W = 2;
// Sidewalks scale with street class: uniform 2.0 walks around a 3.2-half
// minor made the corridor 11.8u of a 13u cell — the dense hill grid merged
// into asphalt-to-asphalt "lakes" with sliver blocks.
export const walkFor = (half: number): number => (half > 4.7 ? SIDEWALK_W : 1.3);
// default lane offset for traffic
export const LANE_CENTER = ASPHALT_W * 0.19;
const CURB_W = 0.7;
export const ASPHALT_LIFT = ROAD_Y + 0.05;
const SIDEWALK_LIFT = ROAD_Y + 0.13;
// curb lip reads above the walk
const CURB_LIFT = SIDEWALK_LIFT + 0.03;
// The highest a draped street layer can sit above the height field: the curb
// lip's lift plus the drape's worst-case bow. Runtime ground overlays (fare
// beacon rings, garage pad rings) must clear this or the street depth-tests
// them away / z-fights them at distance.
export const STREET_SURFACE_MAX = CURB_LIFT + DRAPE_MAX_ERROR;
// Thin paint follows the asphalt's actual triangles with a tighter tolerance.
// Its separation only needs to cover this residual bow; broad physical lifts
// made markings float above the kerb. LINE_LIFT is the fallback for vertices
// grazing outside the asphalt shell.
const MARKING_MAX_ERROR = 0.008;
const PAINT_SEAT = 0.028;
const LINE_LIFT = ASPHALT_LIFT + MARKING_MAX_ERROR + DRAPE_MAX_ERROR + 0.03;
// Same idea one layer up, for the kerb colour zones: they are seated on the
// drawn KERB, and this is only the fallback for the vertices that graze off it.
const KERB_PAINT_LIFT = CURB_LIFT + MARKING_MAX_ERROR + DRAPE_MAX_ERROR + 0.03;
const LINE_W = 0.24;
// red transit lane, kerb to white bound
const MUNI_LANE_W = 1.5;
const EDGE_INSET = 0.5;
const DASH_LEN = 2.2;
const DASH_GAP = 2.6;
// clamp spike joints on hairpin polylines
const MITER_LIMIT = 2.5;
// Signed clearances from the junction patch a marking must keep (see
// nearJunction): positive = stay this far OUTSIDE the patch, negative = may
// run this far INTO its open asphalt.
// solid lines (incl. kerb-hugging edge lines)
const LINE_CLIP = 1.2;
// lane dashes on the minor grid
const DASH_CLIP = 1.6;
// boulevard centre-of-roadway paint
const CENTRE_CLIP = -1.8;
// swept section an arm needs to carry a crosswalk + stop bar
const CROSSWALK_ROOM = 4.5;

// Materials by stable key — the worker ships buffers tagged with these keys
// and the main thread looks the material back up.
export const ROAD_MATERIALS: Record<string, THREE.Material> = {};

// Streets v4 palette (2026-07-10, Mario-Kart pass): mid-grey blue asphalt
// instead of near-black — big paved areas must read as surface, not void — over
// warm concrete walks with a paler kerb lip (values re-graded 2026-07-26, see
// MAT_SIDEWALK).
const MAT_ASPHALT = new THREE.MeshStandardMaterial({ color: 0x55_5b_68, roughness: 1 });
ROAD_MATERIALS.asphalt = MAT_ASPHALT;
// PAVEMENT IS GROUND, AND GROUND IS THE BOTTOM BAND (value pass 2026-07-26).
// The 2026-07-26 palette pass pulled ground.ts's COVER_COLOR down ~18% and left
// these two where they were, which inverted the three-band read: kerb aprons
// measured L133 against building walls at L108, so the kerb+walk ribbon was the
// brightest large surface in every aerial and Twin Peaks read as a WHITE STREET
// GRID with dark confetti in the cells rather than as a city. Both came down
// ~22% — the walk from 0xd2ccb9, the kerb from 0xf1eee2 — to land alongside
// ground.ts's `plaza` 0x9b968a and `quay` 0x938e82: pavement and hardstand are
// the same material family and should not have been two bands apart. The walk-to-kerb RATIO is
// unchanged (1.17), so the lip still reads as a highlight line.
//
// This is baked vertex output (bakeConstantColor): it needs a WORLD_REV bump
// plus `pnpm bake:world`, and the values must stay unique per base material —
// roadCollapseTarget identifies a captured road material by its colour.
const MAT_SIDEWALK = new THREE.MeshStandardMaterial({ color: 0x9a_95_86, roughness: 1 });
ROAD_MATERIALS.walk = MAT_SIDEWALK;
// The kerb is its OWN element, not a lighter sidewalk: the two values used to
// sit 7% apart (0xe8e4d8 over 0xd9d3c2) and merged into one cream band, so the
// lip that separates walk from roadway read as nothing. Now it is a brighter,
// cooler concrete edge — a highlight line around every block — over a warmer,
// darker walk. Kerb COLOUR ZONES paint over it (see kerbZone).
const MAT_CURB = new THREE.MeshStandardMaterial({ color: 0xb3_b0_a6, roughness: 1 });
ROAD_MATERIALS.curb = MAT_CURB;
// Markings are decals: polygon-offset wins the depth test against the
// asphalt even where the two drapes sample the terrain differently — no
// physical lift can guarantee that on curved ground.
const MAT_DASH = new THREE.MeshStandardMaterial({
  color: 0xf2_b9_3e,
  polygonOffset: true,
  polygonOffsetFactor: -2,
  polygonOffsetUnits: -4,
  roughness: 0.9,
});
ROAD_MATERIALS.dash = MAT_DASH;
const MAT_YELLOW = new THREE.MeshStandardMaterial({
  color: 0xf2_b8_3a,
  polygonOffset: true,
  polygonOffsetFactor: -2,
  polygonOffsetUnits: -4,
  roughness: 0.9,
});
ROAD_MATERIALS.yellow = MAT_YELLOW;
const MAT_WHITE = new THREE.MeshStandardMaterial({
  color: 0xf4_f7_f4,
  polygonOffset: true,
  polygonOffsetFactor: -2,
  polygonOffsetUnits: -4,
  roughness: 0.9,
});
ROAD_MATERIALS.white = MAT_WHITE;

// --- SF's loud street paint (Mario-Kart pass, 2026-07-10) ---
// The city's real palette IS the cartoon palette: Muni's red transit lanes,
// green bike lanes, the Castro rainbow crosswalk. All decal params identical
// to the other markings so everything still collapses into MAT_ROAD_MARK.
const paintMat = (color: number): THREE.MeshStandardMaterial =>
  new THREE.MeshStandardMaterial({
    color,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -4,
    roughness: 0.92,
  });
// Muni red is a MATTE PAINTED LANE, not a light source. At 0xc04a38 two 2u
// bands per street made red the loudest colour in an otherwise pastel scene
// and, at night, the brightest thing in a deep-navy frame. This is the same
// hue held down in value and chroma so it still reads as "transit lane" while
// letting the road keep the eye.
const MAT_MUNI_RED = paintMat(0x9c_42_34);
ROAD_MATERIALS.muni = MAT_MUNI_RED;
const MAT_BIKE_GREEN = paintMat(0x27_82_4f);
ROAD_MATERIALS.bike = MAT_BIKE_GREEN;
const MAT_MANHOLE = paintMat(0x43_49_56);
ROAD_MATERIALS.manhole = MAT_MANHOLE;
// Castro & 18th, the ONE rainbow corner (traced (u, v) 0.4995 / 0.4865).
const CASTRO_18TH_X = (0.4995 - 0.5) * WORLD_W;
const CASTRO_18TH_Z = (0.4865 - 0.5) * WORLD_H;
const RAINBOW_HEX = [
  0xe6_42_36, 0xf0_8c_2e, 0xf2_ce_3a, 0x3f_ae_52, 0x35_67_d6, 0x8a_4b_c9,
] as const;
const MAT_RAINBOW = RAINBOW_HEX.map((c, i) => {
  const m = paintMat(c);
  ROAD_MATERIALS[`rb${i}`] = m;
  return m;
});
// Embedded track: a polished railhead and, for the cable lines, the slot.
const MAT_RAIL = paintMat(0x9a_a0_a8);
ROAD_MATERIALS.rail = MAT_RAIL;
const MAT_RAIL_SLOT = paintMat(0x1c_1e_22);
ROAD_MATERIALS.slot = MAT_RAIL_SLOT;
// Kerb colour zones. SF paints the kerb itself and the colour is the rule:
// red = no stopping (every bus stop), yellow = commercial loading, green =
// short-term parking, white = passenger pick-up (that one reuses MAT_WHITE).
const MAT_KERB_RED = paintMat(0xb4_3a_2e);
ROAD_MATERIALS.kerbred = MAT_KERB_RED;
const MAT_KERB_YELLOW = paintMat(0xe0_a9_2c);
ROAD_MATERIALS.kerbyellow = MAT_KERB_YELLOW;
const MAT_KERB_GREEN = paintMat(0x3a_a0_5c);
ROAD_MATERIALS.kerbgreen = MAT_KERB_GREEN;

// --- Road STENCILS: one alpha atlas, one material ---
// stripGeo/discGeo/flatGeo/multiPolyGeo can only paint shapes, so the parts of
// a real roadway that are LETTERS AND SYMBOLS — the transit diamond, BUS ONLY,
// the bike stencil, lane arrows — had no primitive at all. They get one here.
//
// The atlas is rasterized from coverage PREDICATES at module load: no canvas,
// no fetch, no asset, so it behaves identically in the gen worker, the node
// test harness and the browser, and it adds ZERO bake payload (it is code).
// The cost is one extra material — a `map` cannot collapse into MAT_ROAD_MARK
// — i.e. one more draw call per chunk that carries a stencil.
const GLYPH_TILE = 64;
// 4x4 tiles = one 256x256 RGBA texture (256KB)
const GLYPH_GRID = 4;
// transparent margin per tile, so mips can't bleed neighbours
const GLYPH_PAD = 7;
const GLYPH_INNER = GLYPH_TILE - GLYPH_PAD * 2;

/**
 * Ink coverage of one glyph over its tile. (x, y) are in [0, 1] over the tile's
 * padded inner box, and +y points ALONG the direction of travel — so y = 1 is
 * the top of a letter as the approaching driver reads it.
 */
type GlyphInk = (x: number, y: number) => boolean;

const inkUnion =
  (...parts: readonly GlyphInk[]): GlyphInk =>
  (x, y) => {
    for (const p of parts) {
      if (p(x, y)) {
        return true;
      }
    }
    return false;
  };
const inkRect =
  (x0: number, y0: number, x1: number, y1: number): GlyphInk =>
  (x, y) =>
    x >= x0 && x <= x1 && y >= y0 && y <= y1;
const halfPlane = (
  px: number,
  py: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): number => (x1 - x0) * (py - y0) - (y1 - y0) * (px - x0);
/** Filled triangle, by half-plane sign tests (all three the same way round). */
const inkTri =
  (ax: number, ay: number, bx: number, by: number, cx: number, cy: number): GlyphInk =>
  (x, y) => {
    const s0 = halfPlane(x, y, ax, ay, bx, by);
    const s1 = halfPlane(x, y, bx, by, cx, cy);
    const s2 = halfPlane(x, y, cx, cy, ax, ay);
    return (s0 >= 0 && s1 >= 0 && s2 >= 0) || (s0 <= 0 && s1 <= 0 && s2 <= 0);
  };
const segDist = (
  px: number,
  py: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): number => {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const l2 = dx * dx + dy * dy;
  const t = l2 > 0 ? Math.max(0, Math.min(1, ((px - x0) * dx + (py - y0) * dy) / l2)) : 0;
  return Math.hypot(px - (x0 + dx * t), py - (y0 + dy * t));
};
/** Stroked polyline set of half-thickness `w` — the letterforms. */
const inkStrokes =
  (w: number, segs: readonly (readonly [number, number, number, number])[]): GlyphInk =>
  (x, y) => {
    for (const [x0, y0, x1, y1] of segs) {
      if (segDist(x, y, x0, y0, x1, y1) <= w) {
        return true;
      }
    }
    return false;
  };
/** Elliptical ring, for the one letterform strokes can't fake (O). */
const inkRing =
  (cx: number, cy: number, rx: number, ry: number, w: number): GlyphInk =>
  (x, y) => {
    const d = Math.hypot((x - cx) / rx, (y - cy) / ry);
    return d <= 1 && d >= 1 - w;
  };

// Road stencils are tall and condensed: a letter occupies this box inside its
// tile and gets stretched again by the quad it is emitted onto.
// letter left
const LX = 0.2;
// letter right
const LR = 0.8;
// letter top
const LT = 0.94;
// letter bottom
const LB = 0.06;
const LM = (LT + LB) / 2;
// stroke half-thickness
const LW = 0.085;

// Tile order IS the atlas layout — appending is safe, reordering renumbers it.
const GLYPH_ORDER = [
  "diamond",
  "bike",
  "arrowUp",
  "arrowLeft",
  "arrowRight",
  "B",
  "U",
  "S",
  "O",
  "N",
  "L",
  "Y",
] as const;
type GlyphName = (typeof GLYPH_ORDER)[number];

const GLYPH_INK = {
  B: inkStrokes(LW, [
    [LX, LB, LX, LT],
    [LX, LT, LR - 0.08, LT],
    [LR - 0.08, LT, LR, LT - 0.14],
    [LR, LT - 0.14, LR - 0.08, LM + 0.04],
    [LR - 0.08, LM + 0.04, LX, LM],
    [LX, LM, LR - 0.06, LM],
    [LR - 0.06, LM, LR, LM - 0.16],
    [LR, LM - 0.16, LR - 0.06, LB],
    [LR - 0.06, LB, LX, LB],
  ]),
  L: inkStrokes(LW, [
    [LX, LT, LX, LB],
    [LX, LB, LR, LB],
  ]),
  N: inkStrokes(LW, [
    [LX, LB, LX, LT],
    [LX, LT, LR, LB],
    [LR, LB, LR, LT],
  ]),
  O: inkRing(0.5, LM, (LR - LX) / 2, (LT - LB) / 2, 0.34),
  S: inkStrokes(LW, [
    [LR, LT - 0.1, LX + 0.12, LT],
    [LX + 0.12, LT, LX, LT - 0.18],
    [LX, LT - 0.18, LX + 0.08, LM + 0.06],
    [LX + 0.08, LM + 0.06, LR - 0.08, LM - 0.06],
    [LR - 0.08, LM - 0.06, LR, LB + 0.18],
    [LR, LB + 0.18, LR - 0.12, LB],
    [LR - 0.12, LB, LX, LB + 0.1],
  ]),
  U: inkStrokes(LW, [
    [LX, LT, LX, LB + 0.12],
    [LX, LB + 0.12, LX + 0.14, LB],
    [LX + 0.14, LB, LR - 0.14, LB],
    [LR - 0.14, LB, LR, LB + 0.12],
    [LR, LB + 0.12, LR, LT],
  ]),
  Y: inkStrokes(LW, [
    [LX, LT, 0.5, LM - 0.02],
    [LR, LT, 0.5, LM - 0.02],
    [0.5, LM + 0.04, 0.5, LB],
  ]),
  arrowLeft: inkUnion(
    inkRect(0.44, 0.04, 0.64, 0.74),
    inkRect(0.2, 0.58, 0.64, 0.78),
    inkTri(0.26, 0.94, 0.26, 0.44, 0.02, 0.69),
  ),
  arrowRight: inkUnion(
    inkRect(0.36, 0.04, 0.56, 0.74),
    inkRect(0.36, 0.58, 0.8, 0.78),
    inkTri(0.74, 0.94, 0.74, 0.44, 0.98, 0.69),
  ),
  arrowUp: inkUnion(inkRect(0.4, 0.04, 0.6, 0.62), inkTri(0.16, 0.58, 0.84, 0.58, 0.5, 0.98)),
  // Bicycle as the driver looks down on it: wheels in line with the lane, front
  // wheel AHEAD, bars across. A side elevation needs the bike's vertical axis to
  // run ACROSS the road, which reads as a smear of frame tubes from a moving car.
  bike: inkUnion(
    // front wheel
    inkRing(0.5, 0.79, 0.15, 0.19, 0.34),
    // rear wheel
    inkRing(0.5, 0.21, 0.15, 0.19, 0.34),
    inkStrokes(0.045, [
      // spine
      [0.5, 0.2, 0.5, 0.8],
      // handlebar
      [0.14, 0.7, 0.86, 0.7],
      // saddle
      [0.33, 0.36, 0.67, 0.36],
    ]),
  ),
  // The transit-lane diamond: an outline, never a solid.
  diamond: (x, y) => {
    const d = Math.abs(x - 0.5) / 0.44 + Math.abs(y - 0.5) / 0.48;
    return d <= 1 && d >= 0.62;
  },
} satisfies Record<GlyphName, GlyphInk>;

/**
 * Per glyph, its [u0, v0, u1, v1] window into the atlas — the tile's inner box,
 * so bilinear filtering and mips sample padding rather than the next glyph.
 */
const GLYPH_UV: Record<GlyphName, readonly [number, number, number, number]> = (() => {
  const size = GLYPH_TILE * GLYPH_GRID;
  const out: Record<string, readonly [number, number, number, number]> = {};
  for (let i = 0; i < GLYPH_ORDER.length; i += 1) {
    const name = GLYPH_ORDER[i];
    if (name === undefined) {
      continue;
    }
    const tx = (i % GLYPH_GRID) * GLYPH_TILE + GLYPH_PAD;
    const ty = Math.floor(i / GLYPH_GRID) * GLYPH_TILE + GLYPH_PAD;
    out[name] = [tx / size, ty / size, (tx + GLYPH_INNER) / size, (ty + GLYPH_INNER) / size];
  }
  // Every GLYPH_ORDER entry was just written; the fallback keeps the type total
  // without a cast if a future edit ever desynchronizes the two.
  const full = {
    B: out.B ?? [0, 0, 1, 1],
    L: out.L ?? [0, 0, 1, 1],
    N: out.N ?? [0, 0, 1, 1],
    O: out.O ?? [0, 0, 1, 1],
    S: out.S ?? [0, 0, 1, 1],
    U: out.U ?? [0, 0, 1, 1],
    Y: out.Y ?? [0, 0, 1, 1],
    arrowLeft: out.arrowLeft ?? [0, 0, 1, 1],
    arrowRight: out.arrowRight ?? [0, 0, 1, 1],
    arrowUp: out.arrowUp ?? [0, 0, 1, 1],
    bike: out.bike ?? [0, 0, 1, 1],
    diamond: out.diamond ?? [0, 0, 1, 1],
  } satisfies Record<GlyphName, readonly [number, number, number, number]>;
  return full;
})();

/**
 * The atlas. White RGB with the coverage in alpha, 3x3 supersampled; row 0 of
 * the data is v = 0, and the ink is authored with +y up, so atlas v increases
 * toward the top of a letter (see GlyphInk).
 */
const buildGlyphAtlas = (): THREE.DataTexture => {
  const size = GLYPH_TILE * GLYPH_GRID;
  const data = new Uint8Array(size * size * 4);
  const SS = 3;
  for (let g = 0; g < GLYPH_ORDER.length; g += 1) {
    const name = GLYPH_ORDER[g];
    if (name === undefined) {
      continue;
    }
    const ink = GLYPH_INK[name];
    const tx = (g % GLYPH_GRID) * GLYPH_TILE + GLYPH_PAD;
    const ty = Math.floor(g / GLYPH_GRID) * GLYPH_TILE + GLYPH_PAD;
    for (let py = 0; py < GLYPH_INNER; py += 1) {
      for (let px = 0; px < GLYPH_INNER; px += 1) {
        let hits = 0;
        for (let sy = 0; sy < SS; sy += 1) {
          for (let sx = 0; sx < SS; sx += 1) {
            const gx = (px + (sx + 0.5) / SS) / GLYPH_INNER;
            const gy = (py + (sy + 0.5) / SS) / GLYPH_INNER;
            if (ink(gx, gy)) {
              hits += 1;
            }
          }
        }
        const i = ((ty + py) * size + tx + px) * 4;
        data[i] = 255;
        data[i + 1] = 255;
        data[i + 2] = 255;
        data[i + 3] = Math.round((hits / (SS * SS)) * 255);
      }
    }
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = 4;
  tex.needsUpdate = true;
  return tex;
};

// PURE white, unlike MAT_WHITE's 0xf4f7f4, and that is load-bearing: the
// rest.bin round-trip identifies a road material by the colour it serialized
// (roadCollapseTarget), so the stencil material must not share a colour with
// the flat paint or captured chunks would come back on the wrong one.
// One step NEARER than the flat paint (-2/-4): a stencil sits ON a painted
// lane — BUS ONLY and the diamond on the Muni red — and at the same offset the
// two meshes tie on depth and shimmer against each other frame to frame.
const MAT_GLYPH = new THREE.MeshStandardMaterial({
  alphaTest: 0.45,
  color: 0xff_ff_ff,
  map: buildGlyphAtlas(),
  polygonOffset: true,
  polygonOffsetFactor: -3,
  polygonOffsetUnits: -8,
  roughness: 0.9,
});
ROAD_MATERIALS.glyph = MAT_GLYPH;

// The only two words SF paints on a transit lane.
const WORD_BUS: readonly GlyphName[] = ["B", "U", "S"];
const WORD_ONLY: readonly GlyphName[] = ["O", "N", "L", "Y"];

// --- Collapsed render materials ---
// The six flat colors above stay as the stable WIRE keys (worker payloads,
// caches, live street rebuild), but meshes render through just TWO materials
// with the color baked into a vertex attribute (the ground already renders
// this way): one base surface (asphalt/sidewalk/curb) and one polygon-offset
// paint overlay (dash/yellow/white share identical decal params). Same final
// colors, a third of the draw calls per chunk.
const MAT_ROAD_BASE = new THREE.MeshStandardMaterial({
  color: 0xff_ff_ff,
  roughness: 1,
  vertexColors: true,
});
/**
 * True on phones (coarse primary pointer), where fill rate — not draw calls —
 * is the budget. The surface shaders below compile a reduced variant there.
 * Guarded for the gen worker and the node test harness, which have no
 * `window`; in practice it only ever runs inside `onBeforeCompile`, which is
 * main-thread-only (the worker never renders).
 */
export const lowDetailSurfaces = (): boolean =>
  typeof window !== "undefined" && window.matchMedia("(pointer: coarse)").matches;

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
export const applyAsphaltSpeckle = (mat: THREE.MeshStandardMaterial): void => {
  mat.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace(
        "#include <common>",
        "#include <common>\nvarying vec3 vRoadPos;\nvarying vec3 vRoadNrm;\nvarying vec2 vRoadUv;",
      )
      .replace(
        "#include <begin_vertex>",
        `#include <begin_vertex>
vRoadPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
// THE ACROSS-ROAD COORDINATE (writeLateralUv): x = signed lateral offset over
// the roadway's half-width, y = that half-width in world units. \`uv\` is
// declared unconditionally by three's vertex prefix, and a geometry without the
// attribute reads (0, 0) — which is exactly the "no lateral data" opt-out.
vRoadUv = uv;
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
varying vec2 vRoadUv;
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
// inside its cell so no patch ever reads as tiled. Returns (coverage, tone,
// seam): coverage is antialiased off the world-space derivative — NOT off the
// edge distance, which jumps at cell borders and would draw the grid — so
// patches dissolve at distance instead of shimmering. Tone reuses the accept
// hash, so some patches come out darker and some lighter for free.
//
// SEAM is what makes a patch read as a PATCH. Coverage alone is a rectangle a
// few percent off in value, and at chase-cam range — where one patch fills a
// third of the screen and its edge is off-frame — a few percent over a large
// soft area is indistinguishable from dirt. Every real resurfacing cut is
// edged in sealant, and that line is the whole read. It is a fixed-width WORLD
// line, so it widens to a pixel up close and fades out once a pixel is wider
// than the line, exactly like the ground's parcel seams.
vec3 roadPatch(vec2 wp, vec2 dwp, float cell, vec2 hmin, vec2 hvar, float density, float seed) {
  vec2 c = floor(wp / cell);
  float pick = roadHash(c + seed);
  if (pick > density) return vec3(0.0);
  vec2 f = wp / cell - c;
  if (roadHash(c + seed + 41.7) > 0.5) f = f.yx; // half the cuts run crossways
  vec2 h = hmin + hvar * vec2(roadHash(c + seed + 3.7), roadHash(c + seed + 9.1));
  vec2 ctr = h + (1.0 - 2.0 * h) * vec2(roadHash(c + seed + 17.3), roadHash(c + seed + 23.9));
  vec2 d = abs(f - ctr) - h;
  float sd = max(d.x, d.y);
  float px = max(dwp.x, dwp.y);
  float aa = px / cell + 1e-5;
  float seamW = 0.17 / cell; // ~0.17 world units of sealant, in cell units
  float seam = (1.0 - smoothstep(0.0, seamW + aa, abs(sd)))
    * (1.0 - smoothstep(0.45, 1.4, px));
  return vec3(1.0 - smoothstep(-aa, aa, sd), pick / density * 2.0 - 1.0, seam);
}`,
      )
      .replace(
        "#include <color_fragment>",
        `#include <color_fragment>
// Wheel-path polish is consumed by the roughness below, so it has to live at
// function scope rather than inside the block.
float roadPolish = 0.0;
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
  float px = max(dwp.x, dwp.y);
  float dphase = fwidth(phase);
  float speck = roadHash(floor(wp * 1.7));
  // The mid octave used to be roadHash(floor(wp * 0.21)) — hard-edged 4.8u
  // squares at ±4.5%. From the air that averages to nothing; from the chase cam
  // a 4.8u square is a third of the screen, so the roadway read as SOFT DIRTY
  // BLOBS rather than as pavement. The structure a driver actually sees belongs
  // to the patches and their seams below (which have edges), so this octave
  // drops to a fine, smooth aggregate mottle and gets out of the way.
  float coarse = roadNoise(wp * 0.9);
  diffuseColor.rgb *= 1.0 + (speck - 0.5) * 0.05 + (coarse - 0.5) * 0.035;
  // Asphalt is the only base color with a blue cast; walk/curb are cream.
  float asph = smoothstep(0.0, 0.03, diffuseColor.b - diffuseColor.r);
  if (asph > 0.01) {
    // 14u cells, not 26u: at chase-cam range a 26u cell put at most one patch
    // edge on screen, so the tone offset read as a grade across the whole road.
    vec3 slab = roadPatch(wp, dwp, 14.0, vec2(0.14), vec2(0.18), 0.38, 0.0);
    float wear = slab.x * slab.y * 0.09 - slab.z * 0.16;
    #ifdef ROAD_SURFACE_FULL
      vec3 cut = roadPatch(wp, dwp, 47.0, vec2(0.40, 0.022), vec2(0.06, 0.018), 0.26, 71.3);
      wear += cut.x * (cut.y * 0.045 - 0.035) - cut.z * 0.09; // fresh cuts read darker
      // District drift: ~300u wavelength warm/cool, so the Sunset and SoMa
      // are not laid in the same batch of asphalt.
      float drift = roadNoise(wp * 0.0032) - 0.5;
      diffuseColor.rgb *= 1.0 + asph * drift * vec3(0.07, 0.01, -0.07);
    #endif
    diffuseColor.rgb *= 1.0 + wear * asph;
    // --- Across-road structure. Needs the lateral coordinate, which only the
    // street asphalt carries (halfW = 0 on the sidewalk and the freeway deck,
    // both of which share this material and must opt out).
    float halfW = vRoadUv.y;
    if (halfW > 0.5) {
      float lat = abs(vRoadUv.x) * halfW; // world units out from the centreline
      // The gutter is never driven: it collects grime and every block drains
      // through it, so the last ~0.9u before the kerb goes darker and duller.
      // Cheap, and the single biggest read of the two — phones keep it.
      float gutter = smoothstep(halfW - 0.95, halfW - 0.15, lat) * asph;
      diffuseColor.rgb *= 1.0 - gutter * 0.15;
      #ifdef ROAD_SURFACE_FULL
        // Polished wheel paths: each direction's lane sits centred at half the
        // roadway and runs its tyres ~0.5u either side of that, so four ribbons
        // of asphalt are permanently burnished — paler, and much smoother, which
        // is what actually sells them once a light rakes across the street.
        float w0 = (lat - halfW * 0.5 - 0.5) / 0.36;
        float w1 = (lat - halfW * 0.5 + 0.5) / 0.36;
        float track = exp(-w0 * w0) + exp(-w1 * w1);
        // Undersampled at distance the ribbons would alias into moire; fade them
        // out once a pixel spans a big fraction of their width.
        track *= 1.0 - smoothstep(0.15, 0.5, max(dwp.x, dwp.y) / halfW);
        roadPolish = track * asph * (1.0 - gutter);
        // A raking sun turned the sheen into hard streaks, and at a junction
        // the lateral coordinate has no single meaning (see LATERAL_REACH) so
        // the ribbons wandered and crossed. Kept as a hint of lane wear only.
        diffuseColor.rgb *= 1.0 + roadPolish * 0.012;
      #endif
    }
    // Steep blocks are scored concrete, not asphalt (Filbert, 22nd, Jones).
    float steep = smoothstep(0.15, 0.28, nl / max(vRoadNrm.y, 0.05)) * asph;
    if (steep > 0.01) {
      float groove = (0.5 - 0.5 * cos(phase * 6.2831853))
        * (1.0 - smoothstep(0.35, 0.9, dphase)); // drop the pattern once undersampled
      vec3 conc = vec3(0.30, 0.29, 0.26);
      #ifdef ROAD_SURFACE_FULL
        // Depths re-tuned for the post S-curve: the original 0.24/0.15 were
        // authored against the flat vibrance-only grade and read as loud
        // woodgrain down every steep block once midtone contrast arrived.
        conc *= 0.93 + 0.14 * roadNoise(wp * 0.35); // slab-to-slab value variation
      #endif
      diffuseColor.rgb = mix(diffuseColor.rgb, conc * (1.0 - groove * 0.08), steep * 0.6);
    }
  }
  // --- CONCRETE: the walk and the kerb, which ride this same material with
  // their colours in a vertex attribute. Until now the only thing that touched
  // them was the aggregate speckle above, so the second-largest surface in the
  // city — a continuous ribbon around every block in San Francisco — was a flat
  // fill. Same vocabulary as the asphalt: panels instead of resurfacing
  // patches, scoring joints instead of wheel paths, one slow value drift so two
  // adjacent blocks were not poured on the same day.
  float cream = smoothstep(0.0, 0.03, diffuseColor.r - diffuseColor.b) * (1.0 - asph);
  if (cream > 0.01) {
    // The kerb is a single cast lip: no panels, no joints, and it has to stay
    // the brightest line in the street section or the walk/roadway edge stops
    // reading. It is paler than the walk in the LINEAR colours the shader sees
    // (0.43 vs 0.30 luma — sRGB 0xb3b0a6 over 0x9a9586), which is the only
    // separation available on a merged mesh. Re-derive this window if either
    // palette value moves.
    float lip = smoothstep(0.34, 0.42, dot(diffuseColor.rgb, vec3(0.30, 0.59, 0.11)));
    float walk = cream * (1.0 - lip);
    // Pour-to-pour drift, ~85u — block scale, so a corner is where the value
    // changes rather than mid-block.
    diffuseColor.rgb *= 1.0 + cream * (roadNoise(wp * 0.012) - 0.5) * 0.10;
    // Scoring joints. SF scores its walks at roughly 1.5u in this world's
    // scale; the grid is world-aligned rather than kerb-aligned because the
    // walk carries no lateral coordinate (halfW = 0 is its documented opt-out),
    // and at this amplitude the misalignment on a diagonal street reads as
    // texture. Faded out by pixel size well before it could moire from the air.
    vec2 jf = abs(fract(wp / 1.55) - 0.5);
    float jd = (0.5 - max(jf.x, jf.y)) * 1.55; // world distance to the nearest score
    float joint = (1.0 - smoothstep(0.0, 0.05 + px, jd)) * (1.0 - smoothstep(0.10, 0.5, px));
    diffuseColor.rgb *= 1.0 - joint * walk * 0.20;
    #ifdef ROAD_SURFACE_FULL
      // Replaced panels: the same machinery as the roadway's patches at a
      // pavement's scale, so a walk has run-length instead of one value.
      vec3 panel = roadPatch(wp, dwp, 9.0, vec2(0.16), vec2(0.16), 0.35, 137.9);
      diffuseColor.rgb *= 1.0 + walk * (panel.x * panel.y * 0.07 - panel.z * 0.12);
    #endif
  }
}`,
      )
      .replace(
        "#include <roughnessmap_fragment>",
        `#include <roughnessmap_fragment>
// Burnished wheel paths are the one part of the roadway with any sheen.
roughnessFactor *= 1.0 - roadPolish * 0.10;`,
      );
  };
};
applyAsphaltSpeckle(MAT_ROAD_BASE);
// After the speckle so the macro drift chains onto it (shader-side only —
// never the colour, which is the bin round-trip's identity key).
applyMaterialBreakup(MAT_ROAD_BASE, ROAD_BREAKUP);
ROAD_MATERIALS.roadbase = MAT_ROAD_BASE;
const MAT_ROAD_MARK = new THREE.MeshStandardMaterial({
  color: 0xff_ff_ff,
  polygonOffset: true,
  polygonOffsetFactor: -2,
  polygonOffsetUnits: -4,
  roughness: 0.9,
  vertexColors: true,
});
ROAD_MATERIALS.roadmark = MAT_ROAD_MARK;

interface CollapseTarget {
  readonly mat: THREE.Material;
  readonly color: THREE.Color;
}
const BASE_TARGET: CollapseTarget = { color: MAT_ASPHALT.color, mat: MAT_ROAD_BASE };
// Legacy material key → collapsed material + the color it used to carry.
const COLLAPSE_BY_KEY = new Map<string, CollapseTarget>(
  Object.entries({
    asphalt: BASE_TARGET,
    bike: { color: MAT_BIKE_GREEN.color, mat: MAT_ROAD_MARK },
    curb: { color: MAT_CURB.color, mat: MAT_ROAD_BASE },
    dash: { color: MAT_DASH.color, mat: MAT_ROAD_MARK },
    glyph: { color: MAT_GLYPH.color, mat: MAT_GLYPH },
    kerbgreen: { color: MAT_KERB_GREEN.color, mat: MAT_ROAD_MARK },
    kerbred: { color: MAT_KERB_RED.color, mat: MAT_ROAD_MARK },
    kerbyellow: { color: MAT_KERB_YELLOW.color, mat: MAT_ROAD_MARK },
    manhole: { color: MAT_MANHOLE.color, mat: MAT_ROAD_MARK },
    muni: { color: MAT_MUNI_RED.color, mat: MAT_ROAD_MARK },
    rail: { color: MAT_RAIL.color, mat: MAT_ROAD_MARK },
    slot: { color: MAT_RAIL_SLOT.color, mat: MAT_ROAD_MARK },
    walk: { color: MAT_SIDEWALK.color, mat: MAT_ROAD_BASE },
    white: { color: MAT_WHITE.color, mat: MAT_ROAD_MARK },
    yellow: { color: MAT_YELLOW.color, mat: MAT_ROAD_MARK },
  } satisfies Record<string, CollapseTarget>),
);

// Decal materials: polygon-offset overlays that win the depth test against the
// asphalt. The capture round-trip matches on this flag plus the colour, so the
// set has to name every one of them (MAT_GLYPH is a decal too).
const DECAL_MATS: ReadonlySet<THREE.Material> = new Set([MAT_ROAD_MARK, MAT_GLYPH]);
for (let i = 0; i < MAT_RAINBOW.length; i += 1) {
  const m = MAT_RAINBOW[i];
  if (m) {
    COLLAPSE_BY_KEY.set(`rb${i}`, { color: m.color, mat: MAT_ROAD_MARK });
  }
}

// Collapse target for a captured/baked material descriptor (legacy rest.bin
// chunks carry the six flat road materials): matched by the exact colors the
// capture serialized. Already-collapsed (vertex-colored) recs pass through.
export const roadCollapseTarget = (
  colorHex: number,
  polygonOffset: boolean,
  vertexColors: boolean,
): CollapseTarget | null => {
  if (vertexColors) {
    // Already-collapsed capture (white + vertex colors): route back onto the
    // SHARED road materials instead of a descriptor clone, so runtime shader
    // tweaks (asphalt speckle) reach baked worlds too. Callers must keep the
    // rec's own vertex colors in this case (color here is just the uniform).
    if (colorHex === 0xff_ff_ff) {
      return polygonOffset
        ? { color: MAT_ROAD_MARK.color, mat: MAT_ROAD_MARK }
        : { color: MAT_ROAD_BASE.color, mat: MAT_ROAD_BASE };
    }
    return null;
  }
  for (const t of COLLAPSE_BY_KEY.values()) {
    if (DECAL_MATS.has(t.mat) === polygonOffset && t.color.getHex() === colorHex) {
      return t;
    }
  }
  return null;
};

// Fill a constant vertex-color attribute matching `color` (linear-space, the
// same value the collapsed flat material used as its uniform color).
export const bakeConstantColor = (geo: THREE.BufferGeometry, color: THREE.Color): void => {
  const pos = geo.getAttribute("position");
  const col = new Float32Array(pos.count * 3);
  for (let i = 0; i < col.length; i += 3) {
    col[i] = color.r;
    col[i + 1] = color.g;
    col[i + 2] = color.b;
  }
  geo.setAttribute("color", new THREE.BufferAttribute(col, 3));
};

// Which drawn surface supplies a decal's adaptive drape. Road paint follows
// asphalt; kerb colour zones follow the kerb's higher surface.
type PaintSeat = "asphalt" | "curb";

interface Part {
  geo: THREE.BufferGeometry;
  mat: THREE.Material;
  lift: number;
  maxError?: number;
  seat?: PaintSeat;
}

// Physical layering survives the road batch merge and binary round-trip.
// Lane fills sit below linework, embedded iron sits above the linework, and
// stencils remain legible on all of them. Giving every decal the same depth
// made Muni bounds, cable crossings and markings fight inside one draw call.
const paintSeatLift = (mat: THREE.Material): number => {
  if (mat === MAT_MUNI_RED || mat === MAT_BIKE_GREEN || MAT_RAINBOW.some((m) => m === mat)) {
    return 0.012;
  }
  if (mat === MAT_RAIL || mat === MAT_RAIL_SLOT || mat === MAT_MANHOLE) {
    return 0.048;
  }
  if (mat === MAT_GLYPH) {
    return 0.068;
  }
  return PAINT_SEAT;
};

export interface RoadPartBuffers {
  matKey: string;
  position: Float32Array;
  normal: Float32Array;
  uv: Float32Array | null;
  index: Uint16Array | Uint32Array | null;
}

type Pair = [number, number];

// 1/64 u grid: exact in binary floating point
const SNAP = 64;
const snap = (v: number): number => Math.round(v * SNAP) / SNAP;
type Ring = Pair[];
// [outer, ...holes]
type Poly = Ring[];
type MultiPoly = Poly[];

// A polyline resampled to the working section [s0, s1] with per-vertex
// mitered offset normals — the core sweep primitive.
interface Rail {
  pts: number[];
  normals: number[];
  // flat [x,z] pairs
}

const railFor = (edge: NetEdge, s0: number, s1: number): Rail | null => {
  if (s1 - s0 < 0.6) {
    return null;
  }
  const pts: number[] = [];
  const n = edge.pts.length / 2;
  const at = (s: number): readonly [number, number] => {
    let k = 1;
    while (k < n - 1 && (edge.cum[k] ?? 0) < s) {
      k += 1;
    }
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
  for (let k = 0; k < n; k += 1) {
    const s = edge.cum[k] ?? 0;
    if (s > s0 + 0.3 && s < s1 - 0.3) {
      pts.push(edge.pts[k * 2] ?? 0, edge.pts[k * 2 + 1] ?? 0);
    }
  }
  const [ex1, ez1] = at(s1);
  pts.push(ex1, ez1);

  const m = pts.length / 2;
  const normals: number[] = [];
  for (let i = 0; i < m; i += 1) {
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
  return { normals, pts };
};

// Miter length cap as a function of the lateral offset: hairpin vertices
// carry miter scales up to MITER_LIMIT; at pave offsets (~9u) that is a 22u
// lateral spike. Allow at most 4u of extra lateral reach.
const miterCap = (rail: Rail, i: number, off: number): number => {
  const nx = rail.normals[i * 2] ?? 0;
  const nz = rail.normals[i * 2 + 1] ?? 0;
  const nLen = Math.hypot(nx, nz) || 1;
  const allowed = 1 + 4 / Math.max(Math.abs(off), 0.5);
  return nLen > allowed ? allowed / nLen : 1;
};

// Closed ring covering the strip between two lateral offsets of a rail.
const railRing = (rail: Rail, off0: number, off1: number): Ring => {
  const m = rail.pts.length / 2;
  const ring: Ring = [];
  for (let i = 0; i < m; i += 1) {
    const k = miterCap(rail, i, off1);
    ring.push([
      snap((rail.pts[i * 2] ?? 0) + (rail.normals[i * 2] ?? 0) * off1 * k),
      snap((rail.pts[i * 2 + 1] ?? 0) + (rail.normals[i * 2 + 1] ?? 0) * off1 * k),
    ]);
  }
  for (let i = m - 1; i >= 0; i -= 1) {
    const k = miterCap(rail, i, off0);
    ring.push([
      snap((rail.pts[i * 2] ?? 0) + (rail.normals[i * 2] ?? 0) * off0 * k),
      snap((rail.pts[i * 2 + 1] ?? 0) + (rail.normals[i * 2 + 1] ?? 0) * off0 * k),
    ]);
  }
  return ring;
};

const flatGeo = (pos: number[]): THREE.BufferGeometry => {
  const geo = new THREE.BufferGeometry();
  const nor = new Float32Array(pos.length);
  for (let i = 1; i < nor.length; i += 3) {
    nor[i] = 1;
  }
  const uv = new Float32Array((pos.length / 3) * 2);
  geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(pos), 3));
  geo.setAttribute("normal", new THREE.BufferAttribute(nor, 3));
  geo.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  return geo;
};

// Quad strip geometry between two offsets (markings only — no booleans).
const stripGeo = (rail: Rail, off0: number, off1: number): THREE.BufferGeometry => {
  const m = rail.pts.length / 2;
  const pos: number[] = [];
  for (let i = 0; i + 1 < m; i += 1) {
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
};

// Small up-facing disc (manhole covers) — center fan, wound to match the
// planar-map triangles (see multiPolyGeo's cross check).
const discGeo = (cx: number, cz: number, r: number, segs = 10): THREE.BufferGeometry => {
  const pos: number[] = [];
  for (let i = 0; i < segs; i += 1) {
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
};

/**
 * One stencil quad: `name`'s atlas tile mapped onto a `w` x `l` patch centred at
 * (cx, cz), reading correctly for a driver travelling along the unit (tx, tz) —
 * the glyph's top points that way. `right` below is the driver's right hand,
 * matching the sign convention of every lateral offset in this file (a marking
 * at offset `o` sits at (x - tz*o, z + tx*o)).
 */
const glyphGeo = (
  name: GlyphName,
  cx: number,
  cz: number,
  tx: number,
  tz: number,
  w: number,
  l: number,
): THREE.BufferGeometry => {
  const rx = -tz;
  const rz = tx;
  const hw = w / 2;
  const hl = l / 2;
  const px = (sl: number, sa: number): number => cx + rx * sl * hw + tx * sa * hl;
  const pz = (sl: number, sa: number): number => cz + rz * sl * hw + tz * sa * hl;
  // (right, tangent) is left-handed in XZ, so this corner order — and not the
  // obvious one — is the up-facing winding (see the crosswalk quads).
  const pos = [
    px(-1, -1),
    0,
    pz(-1, -1),
    px(1, -1),
    0,
    pz(1, -1),
    px(1, 1),
    0,
    pz(1, 1),
    px(-1, -1),
    0,
    pz(-1, -1),
    px(1, 1),
    0,
    pz(1, 1),
    px(-1, 1),
    0,
    pz(-1, 1),
  ];
  const [u0, v0, u1, v1] = GLYPH_UV[name];
  const geo = flatGeo(pos);
  geo.setAttribute(
    "uv",
    new THREE.BufferAttribute(
      new Float32Array([u0, v0, u1, v0, u1, v1, u0, v0, u1, v1, u0, v1]),
      2,
    ),
  );
  return geo;
};

// Intersection of two rays (p + t*d); null when near-parallel.
const lineIntersect = (
  ax: number,
  az: number,
  adx: number,
  adz: number,
  bx: number,
  bz: number,
  bdx: number,
  bdz: number,
): Pair | null => {
  const den = adx * bdz - adz * bdx;
  if (Math.abs(den) < 1e-4) {
    return null;
  }
  const t = ((bx - ax) * bdz - (bz - az) * bdx) / den;
  return [ax + adx * t, az + adz * t];
};

interface Arm {
  angle: number;
  // outward tangent (away from the node)
  tx: number;
  tz: number;
  half: number;
  // centreline trim point
  px: number;
  pz: number;
  // swept section length of the owning edge
  sec: number;
}

// Junction polygon at a lateral grow of `extra` beyond each arm's asphalt.
const patchRing = (
  nx: number,
  nz: number,
  arms: readonly Arm[],
  extra: number,
  trimCap: number,
): Ring => {
  const ring: Ring = [];
  for (let i = 0; i < arms.length; i += 1) {
    const a = arms[i];
    const b = arms[(i + 1) % arms.length];
    if (!a || !b) {
      continue;
    }
    const ha = a.half + extra;
    const hb = b.half + extra;
    ring.push(
      // a minus side
      [snap(a.px + a.tz * ha), snap(a.pz - a.tx * ha)],
      // a plus side
      [snap(a.px - a.tz * ha), snap(a.pz + a.tx * ha)],
    );
    // The corner fills the notch between adjacent arm edges — but only wide
    // angular gaps HAVE a notch. At shallow gaps the strips overlap and the
    // ray intersection shoots off as a needle spike across the sidewalk
    // (the "dark wedge over the walk" artifact).
    let gap = b.angle - a.angle;
    if (arms.length === 1 || gap <= 0) {
      gap += Math.PI * 2;
    }
    if (gap < 0.9) {
      continue;
    }
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
      if (cd < trimCap + extra * 2) {
        ring.push([snap(corner[0]), snap(corner[1])]);
      }
    }
  }
  return ring;
};

// Dead-end cap ring: half-disc past the trim point.
const capRing = (arm: Arm, extra: number): Ring => {
  const r = arm.half + extra;
  const base = Math.atan2(arm.tx, -arm.tz);
  const ring: Ring = [];
  const SEGS = 10;
  for (let i = 0; i <= SEGS; i += 1) {
    const a = base + (i / SEGS) * Math.PI;
    ring.push([snap(arm.px + Math.cos(a) * r), snap(arm.pz + Math.sin(a) * r)]);
  }
  return ring;
};

// Signed distance from a ring's boundary, negative inside. The paint clip
// tests the junction patch it actually has to avoid; the old circle of radius
// nodeTrim*1.55 was the patch's CIRCUMSCRIBED radius, so it over-clipped by
// ~0.55·nodeTrim at both ends of every block — enough to leave the 20–40u
// blocks that are most of the SF grid with no centre line at all.
const ringSignedDist = (ring: Ring, x: number, z: number): number => {
  let best = Infinity;
  let inside = false;
  // j trails i by one vertex (wrapping), so [a, b] is each ring edge in turn.
  let j = ring.length - 1;
  for (let i = 0; i < ring.length; i += 1) {
    const a = ring[i];
    const b = ring[j];
    j = i;
    if (!a || !b) {
      continue;
    }
    if (a[1] > z !== b[1] > z && x < ((b[0] - a[0]) * (z - a[1])) / (b[1] - a[1]) + a[0]) {
      inside = !inside;
    }
    const dx = b[0] - a[0];
    const dz = b[1] - a[1];
    const l2 = dx * dx + dz * dz;
    const t = l2 > 0 ? Math.max(0, Math.min(1, ((x - a[0]) * dx + (z - a[1]) * dz) / l2)) : 0;
    best = Math.min(best, Math.hypot(x - (a[0] + dx * t), z - (a[1] + dz * t)));
  }
  return inside ? -best : best;
};

// The whole boolean pipeline runs PER SPATIAL TILE with bbox-filtered local
// inputs. City-scale sweeps are both slow (the accumulator grows with every
// chunk) and fragile (martinez corrupts on huge inputs); per-tile the inputs
// are dozens of polygons and the work is linear in the city. Adjacent tiles
// share exact snapped cut lines. Failed booleans abort generation.
interface PlanarMap {
  asphalt: MultiPoly;
  curb: MultiPoly;
  walk: MultiPoly;
}

const bboxOf = (poly: Poly): [number, number, number, number] => {
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
};

// Boolean intersections introduce rational coordinates even though the input
// rings use a binary-exact grid. Feeding those nearly coincident segments to
// the next boolean can corrupt the sweep tree (a missing sidewalk tile at
// Russian Hill). Reuse the authored precision between operations; collapsed
// sliver rings have no drawable area and are discarded at this boundary.
const snappedPolygons = (polygons: MultiPoly): MultiPoly => {
  const out: MultiPoly = [];
  for (const polygon of polygons) {
    const rings: Poly = [];
    for (let i = 0; i < polygon.length; i += 1) {
      const ring = polygon[i];
      if (!ring) {
        continue;
      }
      const points: Ring = [];
      for (const [x, z] of ring) {
        const px = snap(x);
        const pz = snap(z);
        const previous = points.at(-1);
        if (!previous || previous[0] !== px || previous[1] !== pz) {
          points.push([px, pz]);
        }
      }
      const [first] = points;
      const last = points.at(-1);
      if (first && last && first[0] === last[0] && first[1] === last[1]) {
        points.pop();
      }
      if (points.length < 3) {
        if (i === 0) {
          break;
        }
        continue;
      }
      rings.push(points);
    }
    if (rings.length > 0) {
      out.push(rings);
    }
  }
  return out;
};

const tiledPlanarMap = (asphaltPolys: Poly[], curbPolys: Poly[], pavePolys: Poly[]): PlanarMap => {
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
  for (let ix = 0; ix < TILES; ix += 1) {
    for (let iz = 0; iz < TILES; iz += 1) {
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
      if (aLoc.length === 0) {
        continue;
      }
      try {
        const A = snappedPolygons(
          polygonClipping.intersection(polygonClipping.union([], ...aLoc), [rect]),
        );
        if (A.length === 0) {
          continue;
        }
        out.asphalt.push(...A);
        const C = snappedPolygons(
          polygonClipping.intersection(polygonClipping.union([], ...local(curbPolys, boxes.c)), [
            rect,
          ]),
        );
        out.curb.push(...polygonClipping.difference(C, A));
        const P = snappedPolygons(
          polygonClipping.intersection(polygonClipping.union([], ...local(pavePolys, boxes.p)), [
            rect,
          ]),
        );
        // These are adjacent surfaces, never stacked shells. A sidewalk
        // beneath the curb put two independently draped faces 0.03u apart;
        // either drape can bow 0.09u and cut through the other on a grade.
        out.walk.push(...polygonClipping.difference(P, A, C));
      } catch (error) {
        console.warn(`[roads] tile ${ix},${iz} failed`, error);
        failed += 1;
      }
    }
  }
  // An incomplete city must never be published as a successful bake.
  if (failed > 0) {
    throw new Error(`Street geometry failed in ${failed} tiles`);
  }
  return out;
};

// A ring as THREE points, without the duplicated closing point.
const openContour = (ring: Ring): THREE.Vector2[] => {
  const pts = ring.map(([x, z]) => new THREE.Vector2(x, z));
  const last = pts.at(-1);
  const [first] = pts;
  if (last && first && last.distanceToSquared(first) < 1e-9) {
    pts.pop();
  }
  return pts;
};

// Triangulate a boolean-result multipolygon into a flat draped geometry.
const multiPolyGeo = (mp: MultiPoly): THREE.BufferGeometry => {
  const pos: number[] = [];
  for (const poly of mp) {
    const [outer] = poly;
    if (!outer || outer.length < 3) {
      continue;
    }
    const contour = openContour(outer);
    const holes: THREE.Vector2[][] = [];
    for (let h = 1; h < poly.length; h += 1) {
      const ring = poly[h];
      if (!ring || ring.length < 3) {
        continue;
      }
      holes.push(openContour(ring));
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
      if (!a || !b || !c) {
        continue;
      }
      // +Y winding in XZ: (b−a)×(c−a) must point up.
      const cross = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
      if (cross < 0) {
        pos.push(a.x, 0, a.y, b.x, 0, b.y, c.x, 0, c.y);
      } else {
        pos.push(a.x, 0, a.y, c.x, 0, c.y, b.x, 0, b.y);
      }
    }
  }
  return flatGeo(pos);
};

// --- Real SF transit, drawn as OUR OWN street furniture ---
// sf-transit.ts resolves the city's real rail and trolley corridors onto lists
// of indices into SF_EDGES. Nothing here renders the extracted polylines: the
// rails below are swept from the game's own NetEdge, at the game's own
// centreline, so track cannot land beside the asphalt — it IS the asphalt's
// centreline — and no epsilon fitting is involved.

/** The track embedded in a street, at most one kind per street. */
type RailKind = "cable" | "tram" | "railway";

// The `railway` corridor list is dominated by the Market Street subway, which
// the extractor resolved onto every cross street the tunnel happens to pass
// under; none of that has a surface trace and drawing it would lay rails across
// half of downtown. These are the corridors that DO surface: the Embarcadero's
// belt track, the T-Third on 3rd/Illinois, and the Caltrain approach and its
// at-grade crossings into the 4th & King yard.
const SURFACE_RAILWAY_STREETS: ReadonlySet<string> = new Set([
  "The Embarcadero",
  "King Street",
  "Townsend Street",
  "3rd Street",
  "Illinois Street",
  "7th Street",
  "16th Street",
]);

// A corridor shorter than this is RESOLUTION BLEED, not track. Track that
// crosses an intersection is briefly nearest to the CROSS street, so the
// extractor credits that street one 13-36u edge — which would draw a one-block
// stub of cable track down Broadway, Post, Union, Sansome and 25 others. The
// real network survives the cut intact: California / Powell / Mason / Hyde /
// Jackson / Washington / Taylor / Columbus, 2,406u, against a true one-way route
// length of ~8.8 km = 1,980u for the three lines.
const MIN_CORRIDOR_U = 80;

/**
 * SF_EDGES index → embedded track. Cable wins over tram wins over railway: the
 * source model tags the cable lines as tram as well, the modes genuinely share
 * streets (Powell, Market, the Embarcadero), and one asphalt can only carry one
 * gauge — so the most distinctive read takes it.
 * light_rail is absent on purpose: 2,342u of its 2,572u is the Market subway.
 */
const transitRailKinds = (edgeCount: number): Map<number, RailKind> => {
  const out = new Map<number, RailKind>();
  const claim = (kind: RailKind, edges: Iterable<number>): void => {
    for (const e of edges) {
      if (e >= 0 && e < edgeCount && !out.has(e)) {
        out.set(e, kind);
      }
    }
  };
  for (const c of SF_TRANSIT.cable) {
    if (c.lengthU >= MIN_CORRIDOR_U) {
      claim("cable", c.edges);
    }
  }
  for (const c of SF_TRANSIT.tram) {
    if (c.lengthU >= MIN_CORRIDOR_U) {
      claim("tram", c.edges);
    }
  }
  for (const c of SF_TRANSIT.railway) {
    if (SURFACE_RAILWAY_STREETS.has(c.street)) {
      claim("railway", c.edges);
    }
  }
  return out;
};

// Real gauge is 1.067m (cable) / 1.435m (standard), i.e. 0.24u / 0.32u at our
// ~4.45m per unit — sub-pixel from a moving car. The read matters more than the
// measurement, so the gauge below is deliberately exaggerated.
// rail centre to track centre
const CABLE_GAUGE = 0.25;
const RAILWAY_GAUGE = 0.34;
const RAILHEAD_W = 0.1;
// the black slot IS the cable-car icon
const CABLE_SLOT_HALF = 0.05;

/**
 * Trolleybus corridors are what a red transit lane actually follows. All 584 of
 * them is 21,538u — 11% of the roadway, which reads as rust, not as special —
 * so take corridors longest-first until the budget is spent. `SF_TRANSIT`
 * partitions each mode's coverage into corridors sorted by length, so this is
 * just a prefix.
 */
const MUNI_RED_BUDGET_U = 5300;

const muniRedEdges = (): Set<number> => {
  const out = new Set<number>();
  let len = 0;
  for (const c of SF_TRANSIT.trolleybus) {
    if (len >= MUNI_RED_BUDGET_U) {
      break;
    }
    for (const e of c.edges) {
      out.add(e);
    }
    len += c.lengthU;
  }
  return out;
};

/** patchRing's corner-fan cap, in nodeTrim units. */
const PATCH_FACTOR = 1.55;

export interface JunctionMap {
  /** angle-sorted arms per node (null where the node carries no edges) */
  readonly arms: readonly (readonly Arm[] | null)[];
  /**
   * True when (x, z) is within `margin` of a junction patch. `margin` is a
   * SIGNED offset from the patch boundary: positive keeps a marking that far
   * clear of the junction, negative lets it run that far into the junction's
   * open asphalt (boulevard centre-of-roadway paint).
   */
  readonly near: (x: number, z: number, margin: number) => boolean;
}

/**
 * Junction patches, built once and shared by the drawn asphalt and the paint
 * clip — so paint can neither overlap a patch (the old "spoke" stripes) nor be
 * clipped by a circle the patch never fills. Exported so `pnpm test` can
 * assert paint coverage against the real predicate.
 */
export const buildJunctionMap = (network: RoadNetwork): JunctionMap => {
  const nodeArms: (readonly Arm[] | null)[] = network.nodes.map(() => null);
  const patchRings: (Ring | null)[] = network.nodes.map(() => null);
  const patchBuckets = new Map<string, number[]>();
  const NB = 40;
  let maxPatchR = 0;
  for (let n = 0; n < network.nodes.length; n += 1) {
    const ids = network.nodeEdges[n];
    const node = network.nodes[n];
    if (!ids || ids.length === 0 || !node) {
      continue;
    }
    const arms: Arm[] = [];
    for (const id of ids) {
      const edge = network.edges[id];
      if (!edge) {
        continue;
      }
      const ends: ("a" | "b")[] = [];
      if (edge.a === n) {
        ends.push("a");
      }
      if (edge.b === n) {
        ends.push("b");
      }
      for (const end of ends) {
        const trim = Math.min(network.nodeTrim(n), edge.len * 0.45);
        const s0 = end === "a" ? trim : edge.len - trim;
        const smp = network.sample(edge, s0);
        const sign = end === "a" ? 1 : -1;
        arms.push({
          angle: Math.atan2(smp.tz * sign, smp.tx * sign),
          half: edge.half,
          px: smp.x,
          pz: smp.z,
          sec:
            edge.len -
            trim -
            Math.min(network.nodeTrim(end === "a" ? edge.b : edge.a), edge.len * 0.45),
          tx: smp.tx * sign,
          tz: smp.tz * sign,
        });
      }
    }
    if (arms.length === 0) {
      continue;
    }
    arms.sort((u, v) => u.angle - v.angle);
    nodeArms[n] = arms;
    const [first] = arms;
    const ring =
      arms.length === 1 && first
        ? capRing(first, 0)
        : patchRing(node[0], node[1], arms, 0, network.nodeTrim(n) * PATCH_FACTOR);
    if (ring.length < 3) {
      continue;
    }
    patchRings[n] = ring;
    // Mid-street joints (two near-collinear arms) are not junctions — paint
    // runs straight through them, so they stay out of the clip index.
    if (network.nodeIsPassThrough(n)) {
      continue;
    }
    let r = 0;
    for (const [px, pz] of ring) {
      r = Math.max(r, Math.hypot(px - node[0], pz - node[1]));
    }
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
      for (let ix = bx - rings; ix <= bx + rings; ix += 1) {
        for (let iz = bz - rings; iz <= bz + rings; iz += 1) {
          for (const n of patchBuckets.get(`${ix},${iz}`) ?? []) {
            const node = network.nodes[n];
            const ring = patchRings[n];
            if (!node || !ring) {
              continue;
            }
            if (Math.hypot(node[0] - x, node[1] - z) > reach) {
              continue;
            }
            if (ringSignedDist(ring, x, z) < margin) {
              return true;
            }
          }
        }
      }
      return false;
    },
  };
};

// How far off the network a piece of asphalt can be and still be given a lateral
// coordinate, and how far PAST its own roadway edge a vertex may sit before its
// answer stops meaning anything. Junction patches and aprons reach well past
// both: out there the nearest edge is often the CROSSING street, so a clamped
// ±1 would hand the shader a lateral frame that flips mid-triangle — which drew
// wheel paths that wandered and crossed over every junction. Such a vertex
// publishes the documented opt-out (v = 0) instead, and interpolation against
// its neighbours fades the effect out across the apron on its own.
const LATERAL_REACH = 24;
const LATERAL_SLOP = 0.8;

/**
 * THE ACROSS-ROAD COORDINATE, written into the drawn asphalt's `uv` AFTER it is
 * draped. Without it a fragment shader knows where a road pixel is in the world
 * but not where it is across the road, which is what wheel paths, gutters, lane
 * shading and wear all key off — `flatGeo` allocated the attribute and left it
 * zero-filled.
 *
 *   u = signed lateral offset / half-width  (-1 = left kerb, 0 = centreline,
 *       +1 = right kerb; sign matches every other offset in this file)
 *   v = that half-width in world units, so a shader can turn u back into a
 *       distance and size a gutter in metres instead of in percentages.
 *
 * Written post-drape, per WELDED vertex, from the vertex's own position — which
 * keeps it exact (no interpolation across a block-spanning triangle), keeps
 * identical positions on identical values (so it cannot un-weld anything) and
 * costs one nearest-edge query per unique asphalt vertex.
 *
 * v = 0 is the documented opt-out: the sidewalk, the kerb and the freeway deck
 * share this material and never get lateral data, so the shader must gate on it.
 */
const writeLateralUv = (geo: THREE.BufferGeometry, network: RoadNetwork): void => {
  const pos = geo.getAttribute("position");
  const uv = geo.getAttribute("uv");
  if (!(uv instanceof THREE.BufferAttribute)) {
    return;
  }
  const arr = uv.array;
  for (let i = 0; i < pos.count; i += 1) {
    const x = pos.getX(i);
    const z = pos.getZ(i);
    const hit = network.nearest(x, z, LATERAL_REACH);
    if (!hit) {
      continue;
    }
    const lat = (x - hit.x) * -hit.tz + (z - hit.z) * hit.tx;
    if (Math.abs(lat) > hit.edge.half + LATERAL_SLOP) {
      continue;
    }
    arr[i * 2] = Math.max(-1, Math.min(1, lat / hit.edge.half));
    arr[i * 2 + 1] = hit.edge.half;
  }
  uv.needsUpdate = true;
};

// Yellow (loading), white (passenger), green (short-term) or unpainted, keyed
// on the street line so a commercial street keeps its character block to block.
const kerbZoneMat = (h5: number): THREE.Material | null => {
  if (h5 < 0.14) {
    return MAT_KERB_YELLOW;
  }
  if (h5 < 0.22) {
    return MAT_WHITE;
  }
  if (h5 < 0.32) {
    return MAT_KERB_GREEN;
  }
  return null;
};

export const buildRoadParts = (network: RoadNetwork, terrain: DrapeField): RoadPartBuffers[] => {
  const asphaltPolys: Poly[] = [];
  const curbPolys: Poly[] = [];
  const pavePolys: Poly[] = [];
  const markingParts: Part[] = [];

  const junctions = buildJunctionMap(network);
  const nodeArms = junctions.arms;
  const nearJunction = junctions.near;
  const railKinds = transitRailKinds(network.edges.length);
  const redEdges = muniRedEdges();

  const paintEdge = (edge: NetEdge): void => {
    const trimA = Math.min(network.nodeTrim(edge.a), edge.len * 0.45);
    const trimB = Math.min(network.nodeTrim(edge.b), edge.len * 0.45);
    const rail = railFor(edge, trimA, edge.len - trimB);
    if (!rail) {
      return;
    }
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
    // primary/secondary (see CLASS_HALF in bake-network)
    const major = h > 4.7;
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
    if (streetAng < 0) {
      streetAng += Math.PI;
    }
    const dirBucket = Math.round((streetAng / Math.PI) * 12) % 12;
    const bucketAng = (dirBucket / 12) * Math.PI;
    const lineOff = Math.round(
      (midSmp.x * -Math.sin(bucketAng) + midSmp.z * Math.cos(bucketAng)) / 9,
    );
    /* oxlint-disable no-bitwise -- xorshift mix; the uint32 wrap IS the hash */
    let sh = ((dirBucket + 3) * 73_856_093) ^ (lineOff * 19_349_663);
    sh = Math.imul(sh ^ (sh >>> 13), 0x4_5d_9f_3b);
    const h01 = ((sh ^ (sh >>> 16)) >>> 0) / 4_294_967_296;
    /* oxlint-enable no-bitwise */
    const h2 = (h01 * 7.13) % 1;
    const h3 = (h01 * 13.71) % 1;
    const h4 = (h01 * 23.31) % 1;
    const h5 = (h01 * 31.77) % 1;

    // Junction-clipped line runs: a full-rail strip radiates straight
    // through merged junction blobs (short edges barely trim, and
    // through-streets pass near foreign nodes) — the "spoke" bug.
    const emitLine = (off: number, mat: THREE.Material, margin = LINE_CLIP): void => {
      const steps = Math.max(1, Math.ceil(paintLen / 4));
      let runStart = -1;
      for (let i = 0; i <= steps; i += 1) {
        const sc = (i / steps) * paintLen;
        const smp = network.sample(edge, paintA + sc);
        const blocked = nearJunction(smp.x - smp.tz * off, smp.z + smp.tx * off, margin);
        if (!blocked && runStart < 0) {
          runStart = sc;
        }
        if (runStart >= 0 && (blocked || i === steps)) {
          const runEnd = blocked ? Math.max(runStart, sc - paintLen / steps) : sc;
          if (runEnd - runStart >= 2) {
            const r = railFor(edge, paintA + runStart, paintA + runEnd);
            if (r) {
              markingParts.push({
                geo: stripGeo(r, off - LINE_W / 2, off + LINE_W / 2),
                lift: LINE_LIFT,
                mat,
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
        if (e - s < 0.6) {
          continue;
        }
        const mid = network.sample(edge, paintA + (s + e) / 2);
        if (nearJunction(mid.x, mid.z, margin)) {
          continue;
        }
        const dashRail = railFor(edge, paintA + s, paintA + e);
        if (!dashRail) {
          continue;
        }
        markingParts.push({
          geo: stripGeo(dashRail, off - LINE_W / 2, off + LINE_W / 2),
          lift: LINE_LIFT,
          mat,
        });
      }
    };

    // A stencil at arclength `s` (in the paint range), lateral `off`, read by a
    // driver travelling `dir` (+1 = the edge's own direction). Junction-clipped
    // like everything else — a diamond half-swallowed by a crossing reads as a
    // mistake.
    const pushGlyph = (
      name: GlyphName,
      s: number,
      off: number,
      dir: -1 | 1,
      w: number,
      l: number,
    ): void => {
      const smp = network.sample(edge, paintA + s);
      const gx = smp.x - smp.tz * off;
      const gz = smp.z + smp.tx * off;
      if (nearJunction(gx, gz, 2)) {
        return;
      }
      markingParts.push({
        geo: glyphGeo(name, gx, gz, smp.tx * dir, smp.tz * dir, w, l),
        lift: LINE_LIFT,
        mat: MAT_GLYPH,
      });
    };
    // Road text advances ALONG the direction of travel, so the driver arrives
    // at the first letter first.
    const pushWord = (
      word: readonly GlyphName[],
      s0: number,
      off: number,
      dir: -1 | 1,
      pitch: number,
    ): void => {
      for (let i = 0; i < word.length; i += 1) {
        const g = word[i];
        if (g === undefined) {
          continue;
        }
        pushGlyph(g, s0 + dir * i * pitch, off, dir, 1.4, 2.6);
      }
    };

    // --- Muni red transit lanes ---
    // The gate WAS `h >= 5.5`, i.e. "any wide road": that painted both outer
    // edges of 333 OSM primaries, 16,854u — Great Highway, Sloat, Skyline, JFK
    // Drive and Oak, none of which has ever carried a bus lane. The real
    // trolleybus corridors decide it now (sf-transit.ts), and the band moved
    // into the GUTTER: at `eo - LINE_W/2 - 0.3` it sat 0.92u short of the kerb,
    // out in the parking lane, with nothing between it and moving traffic.
    const muniRed = redEdges.has(edge.id) && h >= 4.4;
    const busOut = h - 0.12;
    const busIn = busOut - MUNI_LANE_W;

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
      seat: PaintSeat = "asphalt",
    ): void => {
      const o0 = Math.min(side * bandIn, side * bandOut);
      const o1 = Math.max(side * bandIn, side * bandOut);
      const lat = (o0 + o1) / 2;
      const lo = endMargin;
      const hi = paintLen - endMargin;
      if (hi - lo < 1.5) {
        return;
      }
      const emit = (a: number, b: number): void => {
        for (let s = a; s < b - 0.4; s += segLen + segGap) {
          const e = Math.min(s + segLen, b);
          if (e - s < Math.min(segLen, 1.6)) {
            continue;
          }
          const r = railFor(edge, paintA + s, paintA + e);
          if (r) {
            markingParts.push({
              geo: stripGeo(r, o0, o1),
              lift: seat === "curb" ? KERB_PAINT_LIFT : LINE_LIFT,
              mat,
              seat,
            });
          }
        }
      };
      const steps = Math.max(1, Math.ceil((hi - lo) / 2));
      let runStart = -1;
      for (let i = 0; i <= steps; i += 1) {
        const sc = lo + ((hi - lo) * i) / steps;
        const smp = network.sample(edge, paintA + sc);
        const blocked = nearJunction(smp.x - smp.tz * lat, smp.z + smp.tx * lat, junctionMargin);
        if (!blocked && runStart < 0) {
          runStart = sc;
        }
        if (runStart >= 0 && (blocked || i === steps)) {
          const runEnd = blocked ? Math.max(runStart, sc - (hi - lo) / steps) : sc;
          emit(runStart, runEnd);
          runStart = -1;
        }
      }
    };

    // --- Kerb colour zones ---
    // In SF the kerb itself is a signal and the colour is the rule. Red is the
    // one that isn't decoration: it follows the REAL bus network (sf-transit's
    // per-edge service density), one near-side stop per direction, so the paint
    // agrees with where the shelters and the routes are. The other three are
    // keyed on the street LINE, so a commercial street keeps its character
    // block to block instead of flickering per edge.
    const kerbZone = (side: -1 | 1, s0: number, s1: number, mat: THREE.Material): void => {
      if (s0 < 0 || s1 > paintLen || s1 - s0 < 1.5) {
        return;
      }
      const mid = network.sample(edge, paintA + (s0 + s1) / 2);
      const lat = side * (h + CURB_W / 2);
      if (nearJunction(mid.x - mid.tz * lat, mid.z + mid.tx * lat, 0.6)) {
        return;
      }
      const r = railFor(edge, paintA + s0, paintA + s1);
      if (!r) {
        return;
      }
      const a = side * (h + 0.05);
      const b = side * (h + CURB_W - 0.05);
      markingParts.push({
        geo: stripGeo(r, Math.min(a, b), Math.max(a, b)),
        lift: KERB_PAINT_LIFT,
        mat,
        seat: "curb",
      });
    };

    // Green bike lanes: a sparse subset of the minor grid — SF's bike-network
    // look without painting every street. Keyed on the STREET LINE (the same
    // hash as the centre-line scheme), not the OSM edge id: ids run in bake
    // order, so a modulo on them scattered 4.5u dashes over unrelated blocks
    // instead of running a lane the length of a street. Narrow + dark so they
    // read as PAINT (the old wide bright band read as grass medians), and
    // never stacked on solid/double-yellow streets — that was paint soup.
    // …and only where one FITS. The band sits at h-1.75..h-0.95, so on the 3.2
    // half-width residential class (the bulk of the grid) it lands 1.5-2.3u off
    // the centreline — the middle of the travel lane, not the kerb. Seen from
    // above that reads as loose green patches dropped on the roadway rather
    // than as a lane, which is what it is. 4.0 keeps the 4.6 class (1142 edges,
    // band at 71% of the half-width) and drops the 3.2 class (3465).
    const solidCentre = h2 >= 0.34 && h2 < 0.68;
    const bikeLane = !major && h >= 4 && secLen > 8 && h4 < 0.12 && !solidCentre;

    const paintLines = (): void => {
      // Edge lines: boulevards only, and WHITE. A red lane needs no edge line —
      // its own white bound is the marking, and a yellow line under the red was
      // the inverted convention twice over.
      if (major && !muniRed) {
        emitLine(eo, MAT_WHITE);
        emitLine(-eo, MAT_WHITE);
      }

      // Embedded track owns the centre of the street; a double yellow through a
      // cable slot is paint soup.
      const railKind = railKinds.get(edge.id);
      if (secLen >= 6 && railKind === undefined) {
        if (major) {
          // Centre-of-roadway paint may run INTO a junction's open asphalt
          // (negative margin) — only EDGE lines must not slice across a merged
          // blob. Dense corridors (Market) otherwise read bald between nodes.
          emitDashes(-h * 0.33, MAT_WHITE, CENTRE_CLIP);
          emitDashes(h * 0.33, MAT_WHITE, CENTRE_CLIP);
          // Double yellow down every boulevard. US convention: yellow is the line
          // between OPPOSING directions, white is lanes and edges — so a divided
          // boulevard is not a per-corridor style choice, it is the rule.
          emitLine(0.28, MAT_YELLOW, CENTRE_CLIP);
          emitLine(-0.28, MAT_YELLOW, CENTRE_CLIP);
          // Minor-grid variety below, all of it US-legal: yellow divides
          // opposing directions, or the street carries no centre line at all (a
          // third of the grid — real residentials).
        } else if (h2 < 0.34) {
          // classic yellow dash
          emitDashes(0, MAT_DASH);
        } else if (h2 < 0.56) {
          // solid yellow
          emitLine(0, MAT_YELLOW);
        } else if (h2 < 0.68) {
          // double yellow
          emitLine(0.26, MAT_YELLOW);
          emitLine(-0.26, MAT_YELLOW);
        }
      }

      // --- Embedded track, swept from OUR centreline ---
      // Not junction-clipped: real track runs straight through the crossing
      // (Powell & California is the postcard) and the junction patch has already
      // paved what it crosses. It also spans the FULL edge, not the trimmed
      // section, so consecutive edges of a line meet instead of dotting.
      if (railKind !== undefined) {
        const track = railFor(edge, 0, edge.len);
        if (track) {
          const gauge = railKind === "railway" ? RAILWAY_GAUGE : CABLE_GAUGE;
          for (const side of [-1, 1] as const) {
            markingParts.push({
              geo: stripGeo(track, side * gauge - RAILHEAD_W / 2, side * gauge + RAILHEAD_W / 2),
              lift: LINE_LIFT,
              mat: MAT_RAIL,
            });
          }
          if (railKind === "cable") {
            markingParts.push({
              geo: stripGeo(track, -CABLE_SLOT_HALF, CABLE_SLOT_HALF),
              lift: LINE_LIFT,
              mat: MAT_RAIL_SLOT,
            });
          }
        }
      }
    };

    const paintTransitLane = (): void => {
      // The red lane itself: CONTINUOUS between crosswalks (a real transit lane
      // is one unbroken strip), bounded on the traffic side by the white line the
      // band never had, and stencilled with the diamond and BUS ONLY. Right-hand
      // traffic, so the lane on the +lateral side is driven along the edge's own
      // direction and the other one against it.
      if (muniRed) {
        paintBand(-1, busIn, busOut, Infinity, 0, 3, MAT_MUNI_RED, 2.4);
        paintBand(1, busIn, busOut, Infinity, 0, 3, MAT_MUNI_RED, 2.4);
        emitLine(busIn, MAT_WHITE);
        emitLine(-busIn, MAT_WHITE);
        const lat = (busIn + busOut) / 2;
        for (const side of [-1, 1] as const) {
          for (let s = 12; s < paintLen - 8; s += 30) {
            pushGlyph("diamond", s, side * lat, side, 1.5, 2.4);
          }
          if (paintLen >= 40) {
            const mid = paintLen / 2;
            pushWord(WORD_BUS, mid - side * 8, side * lat, side, 2);
            pushWord(WORD_ONLY, mid + side * 1.5, side * lat, side, 2);
          }
        }
      }
    };

    const paintBikeLane = (): void => {
      if (bikeLane) {
        paintBand(-1, h - 1.75, h - 0.95, 4.5, 2.2, 3, MAT_BIKE_GREEN);
        paintBand(1, h - 1.75, h - 0.95, 4.5, 2.2, 3, MAT_BIKE_GREEN);
        for (const side of [-1, 1] as const) {
          for (let s = 8; s < paintLen - 6; s += 15) {
            pushGlyph("bike", s, side * (h - 1.35), side, 1.3, 2.2);
          }
        }
      }
    };

    const paintParking = (): void => {
      // Parking bays on the residential grid. The marker is a T — a tick out from
      // the kerb with a short bar along it at the traffic end — not the plain
      // lateral bar this used to draw, and it is now what tells a residential
      // street where its kerb is: minor streets carry no edge line at all (real
      // ones don't; the parked cars are the edge).
      if (!major && h >= 3.6 && !bikeLane && !muniRed && h3 < 0.5) {
        // kerb end of the stem
        const tOut = h - 0.45;
        // traffic end, where the crossbar sits
        const tIn = h - 1.9;
        for (let s = 5; s < paintLen - 5; s += 7) {
          const smp = network.sample(edge, paintA + s);
          if (nearJunction(smp.x, smp.z, 4)) {
            continue;
          }
          const stem = railFor(edge, paintA + s, paintA + s + 0.62);
          const bar = railFor(edge, paintA + s - 0.55, paintA + s + 1.15);
          if (!stem || !bar) {
            continue;
          }
          for (const side of [-1, 1] as const) {
            // stripGeo winds by off order (see paintBand) — keep off0 < off1.
            markingParts.push(
              {
                geo: stripGeo(
                  stem,
                  Math.min(side * tIn, side * tOut),
                  Math.max(side * tIn, side * tOut),
                ),
                lift: LINE_LIFT,
                mat: MAT_WHITE,
              },
              {
                geo: stripGeo(
                  bar,
                  Math.min(side * tIn, side * (tIn + 0.3)),
                  Math.max(side * tIn, side * (tIn + 0.3)),
                ),
                lift: LINE_LIFT,
                mat: MAT_WHITE,
              },
            );
          }
        }
      }
    };

    const paintKerbZones = (): void => {
      if (busLoadAt(edge.id) > 0 && paintLen > 18) {
        kerbZone(1, paintLen - 10.5, paintLen - 3, MAT_KERB_RED);
        kerbZone(-1, 3, 10.5, MAT_KERB_RED);
      }
      const zoneMat = kerbZoneMat(h5);
      if (zoneMat && paintLen > 20) {
        kerbZone(1, paintLen / 2 - 4.5, paintLen / 2 + 4.5, zoneMat);
        if (h4 > 0.5) {
          kerbZone(-1, paintLen / 2 - 3, paintLen / 2 + 3, zoneMat);
        }
      }
    };

    const paintManholes = (): void => {
      // Manhole covers: sparse dark discs, alternating lanes on the minor grid.
      if (!major) {
        for (let s = 14; s < paintLen - 8; s += 34) {
          const smp = network.sample(edge, paintA + s);
          if (nearJunction(smp.x, smp.z, 5)) {
            continue;
          }
          const off = (Math.floor(s / 34) % 2 === 0 ? 1 : -1) * h * 0.45;
          const cx = smp.x - smp.tz * off;
          const cz = smp.z + smp.tx * off;
          markingParts.push({ geo: discGeo(cx, cz, 0.55), lift: LINE_LIFT, mat: MAT_MANHOLE });
        }
      }
    };

    paintLines();
    paintTransitLane();
    paintBikeLane();
    paintParking();
    paintKerbZones();
    paintManholes();
  };

  // --- Edge sweeps as polygons + markings ---
  for (const edge of network.edges) {
    paintEdge(edge);
  }

  // The rainbow crosswalk is ONE intersection — Castro at 18th — not a
  // district. Painting every junction inside the 300 × 286u Castro box in
  // rainbow bands (which is what `districtAt(...) === "the Castro"` did) both
  // destroyed the landmark by repetition and filled the district with confetti
  // that competes with the driving line. Resolve the single nearest junction
  // to the real corner once, and paint that.
  const rainbowNode = (() => {
    let best = -1;
    let bestD = 55 * 55;
    for (let n = 0; n < network.nodes.length; n += 1) {
      const node = network.nodes[n];
      const arms = nodeArms[n];
      if (!node || !arms || arms.length < 3 || arms.length > 5) {
        continue;
      }
      const d = (node[0] - CASTRO_18TH_X) ** 2 + (node[1] - CASTRO_18TH_Z) ** 2;
      if (d >= bestD) {
        continue;
      }
      bestD = d;
      best = n;
    }
    return best;
  })();

  let crosswalkArms = 0;
  const paintArm = (
    arms: readonly Arm[],
    ai: number,
    zebra: boolean,
    rainbow: boolean,
    control: JunctionControl,
  ): void => {
    const a = arms[ai];
    if (!a) {
      return;
    }
    const prev = arms[(ai + arms.length - 1) % arms.length];
    const next = arms[(ai + 1) % arms.length];
    const gapTo = (o: Arm | undefined): number => {
      if (!o || o === a) {
        return Math.PI * 2;
      }
      const g = Math.abs(a.angle - o.angle) % (Math.PI * 2);
      return Math.min(g, Math.PI * 2 - g);
    };
    // 45° neighbours leave no room — a zebra ladder's quads would overlap.
    // The two thin transverse lines need much less, so they hold the
    // shallow-angle arms (1,326 of them) the ladder has to skip.
    const gap = Math.min(gapTo(prev), gapTo(next));
    // The zebra band spans [0.9, outer + 1.0] outward; a shorter swept
    // section spills it past the strip into the next node's patch. The
    // transverse pair only reaches 2.5u, which is what the 913 short arms
    // have.
    // The rainbow corner earns its ladder whatever its control warrant is:
    // it is the landmark, and a two-line transverse crossing cannot carry
    // six colours.
    const ladder = (zebra || rainbow) && gap >= Math.PI / 3 && a.sec >= CROSSWALK_ROOM;
    if (!ladder && (gap < 0.87 || a.sec < 2.9)) {
      return;
    }
    const ox = -a.tz;
    const oz = a.tx;
    const quad = (out: number[], d0: number, d1: number, l0: number, l1: number): void => {
      // Coarse ~3u pre-slices only — conformToTerrain's adaptive split
      // adds density exactly where the terrain curves; a fixed fine grid
      // here just multiplied verts on dead-flat intersections.
      const dSlices = Math.max(1, Math.ceil((d1 - d0) / 3));
      const lSlices = Math.max(1, Math.ceil((l1 - l0) / 3));
      for (let di = 0; di < dSlices; di += 1) {
        for (let li = 0; li < lSlices; li += 1) {
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
          out.push(x00, 0, z00, x11, 0, z11, x10, 0, z10, x00, 0, z00, x01, 0, z01, x11, 0, z11);
        }
      }
    };
    // Chunky zebra (stripes run with the road, laid across the width).
    const inner = 0.9;
    const outer = inner + (ladder ? 2.6 : 1.6);
    const usable = a.half - 0.8;
    const count = Math.max(rainbow ? MAT_RAINBOW.length : 4, Math.floor(usable / 0.95));
    crosswalkArms += 1;
    const b0 = outer + 0.5;
    const b1 = b0 + 0.5;

    const paintCrossing = (): void => {
      if (!ladder) {
        // Transverse crosswalk: two thin lines across the roadway instead of
        // the full ladder. This is what an all-way stop gets, what an
        // uncontrolled crossing gets, and what a shallow or short arm gets.
        const lines: number[] = [];
        quad(lines, inner, inner + 0.3, -usable, usable);
        quad(lines, outer - 0.3, outer, -usable, usable);
        markingParts.push({ geo: flatGeo(lines), lift: LINE_LIFT, mat: MAT_WHITE });
      } else if (rainbow) {
        // Contiguous bands (half the stripe pitch each side) — gaps would
        // read as scattered confetti, not a rainbow.
        const halfW = usable / (count - 1);
        for (let k = 0; k < count; k += 1) {
          const lat = -usable + (k / (count - 1)) * 2 * usable;
          const stripe: number[] = [];
          quad(stripe, inner, outer, lat - halfW, lat + halfW);
          markingParts.push({
            geo: flatGeo(stripe),
            lift: LINE_LIFT,
            mat: MAT_RAINBOW[k % MAT_RAINBOW.length] ?? MAT_WHITE,
          });
        }
      } else {
        const stripes: number[] = [];
        for (let k = 0; k < count; k += 1) {
          const lat = -usable + (k / (count - 1)) * 2 * usable;
          quad(stripes, inner, outer, lat - 0.34, lat + 0.34);
        }
        markingParts.push({ geo: flatGeo(stripes), lift: LINE_LIFT, mat: MAT_WHITE });
      }
    };

    const paintStopBar = (): void => {
      const bar: number[] = [];
      if (a.half > 4.7) {
        quad(bar, b0, b1, -usable, usable);
      } else {
        const segs = 4;
        for (let k = 0; k < segs; k += 1) {
          const l0 = -usable + (k / segs) * 2 * usable;
          quad(bar, b0, b1, l0, l0 + (usable * 2) / segs - 0.5);
        }
      }
      markingParts.push({ geo: flatGeo(bar), lift: LINE_LIFT, mat: MAT_WHITE });
    };

    const paintLaneArrows = (): void => {
      const dirX = -a.tx;
      const dirZ = -a.tz;
      let canRight = false;
      let canLeft = false;
      for (const o of arms) {
        if (!o || o === a) {
          continue;
        }
        if (o.tx * a.tz + o.tz * -a.tx > 0.6) {
          canRight = true;
        }
        if (o.tx * -a.tz + o.tz * a.tx > 0.6) {
          canLeft = true;
        }
      }
      const lanes = Math.max(1, Math.min(3, Math.floor(a.half / 2.4)));
      // behind the stop bar, from the driver's side of it
      const at = b1 + 3.6;
      for (let li = 0; li < lanes; li += 1) {
        // Lane 0 is the kerb lane, lane `lanes-1` the one against the centre.
        const frac = (li + 0.5) / lanes;
        const lat = -a.half * (1 - frac * 0.86) - 0.2;
        let glyph: GlyphName = "arrowUp";
        if (li === 0 && canRight) {
          glyph = "arrowRight";
        } else if (li === lanes - 1 && lanes > 1 && canLeft) {
          glyph = "arrowLeft";
        }
        markingParts.push({
          geo: glyphGeo(
            glyph,
            a.px + a.tx * at + ox * lat,
            a.pz + a.tz * at + oz * lat,
            dirX,
            dirZ,
            1.7,
            3.2,
          ),
          lift: LINE_LIFT,
          mat: MAT_GLYPH,
        });
      }
    };

    paintCrossing();
    // Stop bar just past the crosswalk: solid on boulevards, dashed on
    // streets (the KayKit look). An UNCONTROLLED crossing has nothing to
    // stop for and gets none — that, not the crosswalk, is what a signal or
    // a stop sign actually adds to the paint.
    if (control === "none" || a.sec < b1 + 0.6) {
      return;
    }
    paintStopBar();
    // --- Lane arrows on signalized boulevard approaches ---
    // The APPROACH is the half of the roadway on this arm that drives TOWARD
    // the node: those drivers travel -t, so their lanes sit at negative
    // lateral offsets and their right hand points along (a.tz, -a.tx). An
    // arrow only claims a turn the junction can actually make, which is a
    // question the arm list already answers.
    if (!zebra || a.half <= 4.7 || a.sec < b1 + 8) {
      return;
    }
    paintLaneArrows();
  };

  const paintJunction = (n: number): void => {
    const node = network.nodes[n];
    const arms = nodeArms[n];
    if (!node || !arms || arms.length === 0) {
      return;
    }
    const [nx, nz] = node;

    if (arms.length === 1) {
      const [a] = arms;
      if (a) {
        asphaltPolys.push([capRing(a, 0)]);
        curbPolys.push([capRing(a, CURB_W)]);
        pavePolys.push([capRing(a, walkFor(a.half))]);
      }
      return;
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
    // A crossing is not conditional on a signal. Gating the paint on
    // junctionControl left 1,138 of SF's 2,748 intersections — 41% — with no
    // crosswalk at all, because the minor grid's all-way-stop warrant is a coin
    // flip and the loser got nothing. An uncontrolled junction still has marked
    // crossings; what it does NOT have is a stop bar, which is the real split.
    const control = junctionControl(network, n);
    if (arms.length >= 3 && arms.length <= 5) {
      const zebra = control === "signal";
      // Castro at 18th paints its crosswalks rainbow — so do we, THERE.
      const rainbow = n === rainbowNode;
      for (let ai = 0; ai < arms.length; ai += 1) {
        paintArm(arms, ai, zebra, rainbow, control);
      }
    }
  };

  // --- Junction patches + crosswalks + dead-end caps ---
  for (let n = 0; n < network.nodes.length; n += 1) {
    paintJunction(n);
  }

  // --- The planar map: overlap dissolves in the union ---
  console.log(`[roads] crosswalk arms painted: ${crosswalkArms}`);
  const t0 = performance.now();
  const { asphalt, curb, walk } = tiledPlanarMap(asphaltPolys, curbPolys, pavePolys);
  console.log(`[roads] planar map in ${Math.round(performance.now() - t0)}ms`);

  const surfaceParts: Part[] = [
    { geo: multiPolyGeo(asphalt), lift: ASPHALT_LIFT, mat: MAT_ASPHALT },
    { geo: multiPolyGeo(walk), lift: SIDEWALK_LIFT, mat: MAT_SIDEWALK },
    { geo: multiPolyGeo(curb), lift: CURB_LIFT, mat: MAT_CURB },
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
    const position = pos.array;
    const normal = nor.array;
    const texcoord = uv?.array ?? null;
    const index = idx?.array ?? null;
    if (!(position instanceof Float32Array) || !(normal instanceof Float32Array)) {
      throw new Error("Street geometry requires float positions and normals");
    }
    if (texcoord !== null && !(texcoord instanceof Float32Array)) {
      throw new Error("Street geometry requires float texture coordinates");
    }
    if (index !== null && !(index instanceof Uint16Array) && !(index instanceof Uint32Array)) {
      throw new Error("Street geometry requires unsigned triangle indices");
    }
    out.push({
      index,
      matKey: keyOfMat.get(mat) ?? "asphalt",
      normal,
      position,
      uv: texcoord,
    });
  };

  let asphaltSurface: SurfaceSampler | null = null;
  let curbSurface: SurfaceSampler | null = null;
  for (const p of surfaceParts) {
    const draped = conformToTerrain(p.geo, terrain, p.lift, p.maxError);
    if (p.mat === MAT_ASPHALT) {
      asphaltSurface = surfaceSampler(draped);
      const tUv = performance.now();
      writeLateralUv(draped, network);
      console.log(`[roads] lateral uv in ${Math.round(performance.now() - tUv)}ms`);
    }
    if (p.mat === MAT_CURB) {
      curbSurface = surfaceSampler(draped);
    }
    publish(p.mat, draped);
  }
  // Refine against the DRAWN surface, not just its vertex heights. Moving
  // the vertices of a coarse decal onto asphalt still leaves its triangle
  // chords cutting through the road between those vertices. Fine adaptive
  // edges follow the asphalt triangles closely enough to keep each paint
  // layer separated. Kerb zones use the kerb shell by the same contract.
  const paintField = (sample: SurfaceSampler | null, fallback: number): DrapeField => ({
    heightAt: (x, z) => sample?.(x, z) ?? terrain.heightAt(x, z) + fallback,
    normalInto: (normal, x, z) => terrain.normalInto(normal, x, z),
  });
  const asphaltPaint = paintField(asphaltSurface, LINE_LIFT);
  const curbPaint = paintField(curbSurface, KERB_PAINT_LIFT);
  const tPaint = performance.now();
  for (const p of markingParts) {
    const onCurb = p.seat === "curb";
    const draped = conformToTerrain(
      p.geo,
      onCurb ? curbPaint : asphaltPaint,
      paintSeatLift(p.mat),
      MARKING_MAX_ERROR,
      { maxDepth: 8, minEdge: 0.4 },
    );
    publish(p.mat, draped);
  }
  console.log(`[roads] paint seated in ${Math.round(performance.now() - tPaint)}ms`);
  return out;
};

export const roadPartsToMeshes = (parts: readonly RoadPartBuffers[]): THREE.Mesh[] => {
  const out: THREE.Mesh[] = [];
  for (const p of parts) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(p.position, 3));
    geo.setAttribute("normal", new THREE.BufferAttribute(p.normal, 3));
    if (p.uv) {
      geo.setAttribute("uv", new THREE.BufferAttribute(p.uv, 2));
    }
    if (p.index) {
      geo.setIndex(new THREE.BufferAttribute(p.index, 1));
    }
    // Legacy wire key → one of the collapsed materials. The stencil material
    // carries its colour as a uniform (it needs the atlas in `map`), so it is
    // the one target that must NOT be handed a vertex-colour attribute.
    const target = COLLAPSE_BY_KEY.get(p.matKey) ?? BASE_TARGET;
    if (target.mat.vertexColors) {
      bakeConstantColor(geo, target.color);
    }
    out.push(new THREE.Mesh(geo, target.mat));
  }
  return out;
};

export const buildRoads = (network: RoadNetwork, terrain: DrapeField): THREE.Mesh[] =>
  roadPartsToMeshes(buildRoadParts(network, terrain));
