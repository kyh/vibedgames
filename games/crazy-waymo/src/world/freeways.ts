import * as THREE from "three";

import { WORLD_HALF_X, WORLD_HALF_Z } from "../shared/constants";
import type { RoadNetwork } from "./network";
import { applyMaterialBreakup, ROAD_BREAKUP } from "../render/material-breakup";
import { WEATHER } from "./masonry";
import { applyAsphaltSpeckle, lowDetailSurfaces } from "./roads";
import { SF_FREEWAY_RAMPS, SF_FREEWAYS } from "./sf-freeways";
import type { Terrain } from "./terrain";

// Elevated freeways — 80 to the Bay Bridge, 101/280, the Central Freeway —
// plus their real on/off ramps (OSM motorway/trunk links). DRIVABLE: the
// visual deck+barrier geometry doubles as a static physics trimesh
// (physics-world.addStaticTrimesh) so the raycast vehicle rides exactly what
// it sees, while the street heightfield below stays untouched — underpasses
// keep working because a wheel ray cast from under the deck never reaches it.
// Ramps anchor one end at street grade and the other at the mainline deck.
// Mainline ends that stop mid-map (OSM clips, bridge approaches cut at the
// data boundary) GROUND themselves: the deck glides down to street grade over
// the last stretch like a ramp mouth, so no freeway ever cuts off in the air.
// Everything derives from ONE memoized build so visuals, physics and pillar
// solids can never disagree.

const STEP = 6; // resample pitch along the centerline
const CLEAR = 6.5; // deck soffit clearance above local terrain
// Ceiling on that clearance. The slew limiter below is a max-plus dilation: it
// is the MINIMAL profile that clears the ground at a bounded grade, so given a
// floor and a grade there is no freedom left — the only way down is to cap it.
// Without a cap a summit's influence spreads H/maxD samples in BOTH directions
// (a 60u hill held the deck up for 5.3km each side), and because SF's terrain
// carries ~2x vertical exaggeration (HILL_SCALE) while MAX_GRADE was a real-
// world 5%, a quarter of the network stood on pillars over 24u — up to 55.8u,
// 25x the car's height, above ground that was 2.8u high.
const MAX_CLEAR = 13; // ~2x design, ~6x car height; past this it reads as a tower
const DECK_T = 0.9; // slab thickness
// Exaggerated terrain wants an exaggerated grade to come back down from it.
// The streets already reach 75%, so a 12% freeway is well inside the game's
// own vocabulary and keeps the descent inside a block instead of a kilometre.
const MAX_GRADE = 0.12; // per-unit climb limit for the smoothed mainline deck
const PILLAR_EVERY = 4; // one pillar per N samples (24u)
const PILLAR_CLEAR = 0.4; // footing must miss street asphalt by this much
const PIER_CAP_T = 0.55; // crossbeam depth under the soffit
// Footing search, ordered cheapest-displacement first: shift the pillar to a
// neighbouring sample (±2 keeps the span between 12u and 36u) and slide it
// across the deck. Lateral costs less than moving along — a pier under the
// deck edge reads normal, an uneven bay spacing reads broken.
const PILLAR_OFFSETS: readonly (readonly [number, number])[] = (() => {
  const out: [number, number][] = [];
  for (let dj = -2; dj <= 2; dj++) {
    for (let l = -6; l <= 6; l++) out.push([dj, l / 6]);
  }
  return out.sort((a, b) => Math.hypot(a[0] / 2, a[1] * 0.6) - Math.hypot(b[0] / 2, b[1] * 0.6));
})();
const RAMP_ANCHOR_R = 30; // ramp end within this of a mainline → deck height
const BARRIER_H = 0.85;
const GROUND_RUN = 96; // dead-end mainlines descend to grade over this run
const EDGE_MARGIN = 45; // ends this close to the map edge are meant to cut off
// Elevation above terrain where falling off stops being fun: rails on ramps
// turn physical past this clearance (mouths and merge gaps stay open).
const RAIL_SOLID_CLEAR = 2.4;
// Invisible physics lip above the visual barrier cap — an 0.85u wall alone
// lets a boosted car vault the rail mid-corner.
const RAIL_PHYS_EXTRA = 0.9;

// Deck paint (decals: polygon-offset wins the depth test on the coplanar deck).
const LINE_W = 0.24;
const EDGE_INSET = 0.55;
const DASH_LEN = 3.2;
const DASH_GAP = 3.4;
const PAINT_LIFT = 0.02;

const SIGN_EVERY = 270; // arclength between overhead gantries on a mainline
// Procedural gantry dimensions (kit sign models had free-floating boards —
// a parametric frame always fits the deck it spans).
const GANTRY_POST_H = 5.4;
const GANTRY_BEAM_Y0 = 5.05;
const GANTRY_BEAM_Y1 = 5.4;
const GANTRY_BOARD_Y0 = 3.55;
const GANTRY_BOARD_HALF_W = 2.1;

// Which member of the viaduct a concrete vertex belongs to, and what its
// surface coordinate means. Both ride in the `uv` attribute the way roads.ts
// carries its across-road coordinate — uv.x = the coordinate below, uv.y = the
// member. A geometry without the attribute reads (0, 0), which is the
// documented "no data" opt-out (kind 0 takes the generic treatment).
//
//   CON_SOFFIT   deck underside      uv.x = world units OUT from the centreline
//   CON_FASCIA   deck side edge      uv.x = world units BELOW the deck top
//   CON_BARRIER  wall on the deck    uv.x = world units BELOW the cap
//   CON_SUB      pillar / cap / gantry   uv.x = world units BELOW the member top
//
// uv.x is a drip-run everywhere except the soffit, which has no top edge to
// run from and wants its across-deck coordinate instead (girder ribs).
const CON_SOFFIT = 1;
const CON_FASCIA = 2;
const CON_BARRIER = 3;
const CON_SUB = 4;

// The viaduct concrete. Two things about it are load-bearing.
//
// VALUE. It used to be 0xb6b0a4 — linear luminance 0.44, the same band as the
// building fabric and inside a stone's throw of the sky at 0.50. A viaduct is
// the largest untextured mass in the frame wherever one runs, and this map runs
// one on ~50u columns straight across the Sunset, so at that value the
// colonnade was the loudest object on that skyline: measured on the Sunset
// vista its columns read 0.15 linear against a city fabric of 0.02-0.05. It now
// sits at 0.30 — with the walk and the pavement, which is where a weathered
// cast-concrete albedo actually belongs — so it takes its place in the value
// ordering (asphalt < ground < walk/viaduct < buildings < sky) instead of
// out-ranking the whole district it crosses.
//
// SURFACE. See applyConcreteWeathering: the same procedural vocabulary
// ground.ts and roads.ts established — no textures, everything derived from
// world position, every fixed-width feature faded out by pixel size.
//
// DoubleSide: barrier/pillar quads are hand-wound; guaranteeing outward
// normals everywhere isn't worth the culling win on this little geometry. The
// shader therefore never trusts the SIGN of the normal (pushBox's faces all
// point inward) — only `abs`, plus the member id above.
const MAT_CONCRETE = new THREE.MeshStandardMaterial({
  color: 0x97948b,
  roughness: 1,
  side: THREE.DoubleSide,
});
applyConcreteWeathering(MAT_CONCRETE);
// Deck asphalt matches the street asphalt exactly (same color + aggregate
// speckle) so ramp mouths merge into the roadway with no material seam.
const MAT_DECK = new THREE.MeshStandardMaterial({ color: 0x555b68, roughness: 1 });
applyAsphaltSpeckle(MAT_DECK);
applyMaterialBreakup(MAT_DECK, ROAD_BREAKUP);
const MAT_PAINT_WHITE = new THREE.MeshStandardMaterial({
  color: 0xf4f7f4,
  roughness: 0.9,
  polygonOffset: true,
  polygonOffsetFactor: -2,
  polygonOffsetUnits: -4,
});
const MAT_PAINT_YELLOW = new THREE.MeshStandardMaterial({
  color: 0xf2b83a,
  roughness: 0.9,
  polygonOffset: true,
  polygonOffsetFactor: -2,
  polygonOffsetUnits: -4,
});
// Highway-sign green (the classic guide-sign color, matte).
const MAT_SIGN = new THREE.MeshStandardMaterial({ color: 0x25714a, roughness: 0.85 });

// Weathered cast concrete — a runtime shader pass on the shared viaduct
// material, so it covers the live AND the baked world path (freeway meshes are
// rebuilt on both) and costs no extra geometry. Everything derives from world
// position and the face normal, in the same flat-shaded value-only language
// ground.ts and roads.ts speak: the texture is meant to be FELT, not read, and
// every fixed-width feature fades out with pixel size so a colonnade seen from
// three blocks away never aliases into a moire ladder.
//
// A wall and a soffit share ONE FACE COORDINATE: horizontal faces use world
// (x, z), vertical faces use (distance along the face, world y). One
// parameterisation means the grain, the drift and the joints are written once
// and land correctly on a fascia, a soffit and a column alike.
//
// What it draws, in order of how much work each does:
//   - form-board seams, horizontal, ~0.62u apart — the single most
//     recognisable thing about a bridge pier at arm's length;
//   - drip staining running down from every member's top edge, which is the
//     whole reason old concrete reads as old;
//   - a lift joint per deck span, so a viaduct reads as a run of spans rather
//     than one extruded ribbon;
//   - girder ribs on the soffit, which is the face a driver spends most of
//     their time under and was previously one flat plane over a third of the
//     windscreen;
//   - aggregate grain and a slow pour-to-pour drift, so no two bays are the
//     same grey.
function applyConcreteWeathering(mat: THREE.MeshStandardMaterial): void {
  mat.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace(
        "#include <common>",
        "#include <common>\nvarying vec3 vConPos;\nvarying vec3 vConNrm;\nvarying vec2 vConUv;",
      )
      .replace(
        "#include <begin_vertex>",
        `#include <begin_vertex>
vConPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
// Member id + surface coordinate (see CON_* above). \`uv\` is declared
// unconditionally by three's vertex prefix, and a geometry without the
// attribute reads (0, 0) — the documented "no data" opt-out.
vConUv = uv;
// Length-guarded so a geometry that ever shipped without normals cannot
// normalize a zero vector. The SIGN is meaningless here (hand-wound quads);
// only the axis is used.
vec3 conN = mat3(modelMatrix) * objectNormal;
float conNL = length(conN);
vConNrm = conNL > 1e-4 ? conN / conNL : vec3(0.0, 1.0, 0.0);`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        `#include <common>
${lowDetailSurfaces() ? "" : "#define CONCRETE_FULL 1"}
varying vec3 vConPos;
varying vec3 vConNrm;
varying vec2 vConUv;
float conHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float conNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = p - i;
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(conHash(i), conHash(i + vec2(1.0, 0.0)), u.x),
    mix(conHash(i + vec2(0.0, 1.0)), conHash(i + vec2(1.0, 1.0)), u.x),
    u.y);
}
// A fixed-WORLD-width dark line at \`d\` world units from its centre: widened to
// a pixel up close, faded out once a pixel is wider than the line. Same rule
// the ground's parcel seams and the roadway's sealant cuts follow, and the
// reason none of this aliases from the air.
float conLine(float d, float w, float px) {
  return (1.0 - smoothstep(0.0, w + px, d)) * (1.0 - smoothstep(w * 3.0, w * 14.0, px));
}`,
      )
      .replace(
        "#include <color_fragment>",
        `#include <color_fragment>
{
  vec3 wp = vConPos;
  float kind = vConUv.y;
  float coord = vConUv.x;
  // Horizontal tangent of the face. A horizontal face has none and falls back
  // to the x axis, which is all its (x, z) parameterisation needs.
  vec2 tang = vec2(-vConNrm.z, vConNrm.x);
  float tl = length(tang);
  tang = tl > 1e-4 ? tang / tl : vec2(1.0, 0.0);
  float along = dot(wp.xz, tang);
  float vert = 1.0 - smoothstep(0.35, 0.75, abs(vConNrm.y));
  vec2 fc = mix(wp.xz, vec2(along, wp.y), vert);
  // Derivatives stay in UNIFORM control flow — the member gates below are not.
  vec2 dfc = fwidth(fc);
  float px = max(dfc.x, dfc.y);
  float pxy = fwidth(wp.y);

  // Aggregate, a smooth mottle, and the slow pour-to-pour drift: concrete
  // poured on two different days is never the same grey, and the span is the
  // unit that was poured.
  float grit = conHash(floor(fc * 2.4)) - 0.5;
  float mottle = conNoise(fc * 0.55) - 0.5;
  float pour = conNoise(fc * 0.042 + 13.0) - 0.5;
  diffuseColor.rgb *= 1.0 + grit * ${WEATHER.grainValue.toFixed(3)} + mottle * 0.04 + pour * 0.10;

  // FORM-BOARD SEAMS. Cast concrete carries the lines of the boards it was
  // poured against — horizontal, and on vertical faces only.
  diffuseColor.rgb *= 1.0 - conLine(abs(fract(wp.y / 0.62) - 0.5) * 0.62, 0.03, pxy)
    * vert * ${WEATHER.jointValue.toFixed(3)};

  // A lift joint every deck span, on the DECK members only: it means "one span
  // ended here", which is true of a fascia and a barrier and meaningless on a
  // 1.9u column, where the same line lands at an arbitrary spot and reads as a
  // crack splitting the pier.
  float deckMember = step(1.5, kind) * (1.0 - step(3.5, kind));
  float span = conLine(abs(fract(along / 24.0) - 0.5) * 24.0, 0.06, px);
  diffuseColor.rgb *= 1.0 - span * vert * deckMember * 0.15;

  // THE SOFFIT. Its uv.x is the across-deck coordinate, not a drip run: box
  // girders leave longitudinal ribs, which is what stops the underside — the
  // face a driver is under more than any other — reading as one flat plane.
  // It also takes a little bounce off the bright ground it spans, without
  // which the value cut above turns it into a hole in the frame.
  //
  // The ribs run ONE WAY, and a single direction of line is what still left
  // this face reading flat from a chase camera: a real box-girder underside is
  // a grid, ribs along the span crossed by a diaphragm at every floorbeam. The
  // transverse member is the second family, at the deck's own 7.5u bay pitch,
  // and it is what gives the soffit a scale a driver can read as they pass
  // under it.
  float soffit = step(0.5, kind) * (1.0 - step(1.5, kind)) * (1.0 - vert);
  if (soffit > 0.01) {
    float rib = conLine(abs(fract(coord / 1.7) - 0.5) * 1.7, 0.07, px);
    float diaph = conLine(abs(fract(along / 7.5) - 0.5) * 7.5, 0.16, px);
    float shutter = conHash(floor(vec2(coord / 1.7, along / 7.5))) - 0.5;
    diffuseColor.rgb *= 1.0 + soffit
      * (0.10 - rib * 0.30 - diaph * 0.14 + shutter * 0.05);
  }

  #ifdef CONCRETE_FULL
    // AGGREGATE. The 0.42u \`grit\` cells above are a blotch, not a grain: from a
    // chase camera one of them is 170 pixels. This is the octave that actually
    // reads as a cast surface at arm's length, and it fades out completely by
    // the time a pixel is half its size, so it can never alias into noise on a
    // colonnade three blocks away — the same rule every fixed-width feature in
    // this world follows.
    diffuseColor.rgb *= 1.0 + (conHash(floor(fc * 22.0)) - 0.5)
      * ${(WEATHER.grainValue * 1.5).toFixed(3)} * (1.0 - smoothstep(0.012, 0.05, px));

    // LIFT JOINTS ON THE COLUMNS. A pier is poured in lifts like everything
    // else, and the horizontal line where one pour met the next is the cheapest
    // scale cue a bare 1.9u shaft can carry. Deck members already get their
    // per-span joint above; this is the same fact about the substructure.
    float sub = step(3.5, kind);
    diffuseColor.rgb *= 1.0 - conLine(abs(fract(wp.y / 2.9) - 0.5) * 2.9, 0.055, pxy)
      * vert * sub * ${(WEATHER.jointValue * 0.8).toFixed(3)};

    // DRIP STAINING. Every hard edge above sheds water down the face below it.
    // Lanes hashed along the face, decaying over the first few metres under the
    // member's top edge — which is where the streaks actually are.
    float drop = max(coord, 0.0) * (1.0 - soffit);
    float lane = floor(along / 0.5);
    float across = fract(along / 0.5);
    float streak = conHash(vec2(lane, 7.3 + kind))
      * (1.0 - smoothstep(0.12, 0.5, abs(across - 0.5)));
    float run = exp(-drop / ${WEATHER.dripRun.toFixed(1)}) * (1.0 - smoothstep(0.25, 0.9, px));
    diffuseColor.rgb *= 1.0 - vert * streak * run * ${WEATHER.dripValue.toFixed(3)};
    // The continuous darker band right under the drip line, where the water
    // collects before it runs.
    diffuseColor.rgb *= 1.0 - vert * exp(-drop / 0.7) * 0.07;
    // Board-to-board value steps: every plank left its own tone. The runs are
    // LONG (~9u) on purpose — at a few metres the vertical breaks landed close
    // enough to the 0.62u seams to read as courses of ashlar, which is a
    // different material entirely.
    float plank = conHash(vec2(floor(wp.y / 0.62), floor(along / 9.0)));
    diffuseColor.rgb *= 1.0 + vert * (plank - 0.5) * 0.04 * (1.0 - smoothstep(0.2, 0.8, px));
  #endif
}`,
      );
  };
}

type Line = {
  readonly half: number;
  readonly pts: readonly (readonly [number, number])[]; // resampled
  readonly ys: readonly number[]; // deck TOP height per sample
  readonly ramp: boolean;
  /** cumulative arclength per sample (barrier/lip feathering, dash phase) */
  readonly cum: readonly number[];
  readonly openStart?: boolean; // street-grade end — feathered lip, no barrier
  readonly openEnd?: boolean;
};

/** Placed pillar footprint (centre + half-extent) — see the placement search. */
export type PillarSpot = { readonly x: number; readonly z: number; readonly half: number };

/**
 * Where a concrete quad's `uv` values come from. `uv.y` is always `kind`;
 * `uv.x` is `topY - vertexY` (the drip run under the member's top edge) unless
 * `s` overrides it with an explicit per-corner value, which the soffit uses to
 * carry its across-deck coordinate instead.
 */
type ConFace = {
  readonly uv: number[];
  readonly kind: number;
  readonly topY: number;
  readonly s?: readonly [number, number, number, number];
};

type FreewayBuild = {
  readonly lines: readonly Line[];
  readonly pillars: readonly PillarSpot[];
  readonly deckPos: number[];
  readonly deckNor: number[];
  readonly bodyPos: number[];
  readonly bodyNor: number[];
  readonly bodyUv: number[];
  readonly whitePos: number[];
  readonly yellowPos: number[];
  readonly signPos: number[];
  readonly signNor: number[];
  /** deck top + rail faces, non-indexed triangles — the physics surface */
  readonly physPos: number[];
};

function resample(p: readonly number[]): [number, number][] {
  const src: [number, number][] = [];
  for (let i = 0; i + 1 < p.length; i += 2) src.push([p[i] ?? 0, p[i + 1] ?? 0]);
  if (src.length < 2) return [];
  const pts: [number, number][] = [src[0] ?? [0, 0]];
  let carry = 0;
  for (let i = 1; i < src.length; i++) {
    const [ax, az] = src[i - 1] ?? [0, 0];
    const [bx, bz] = src[i] ?? [0, 0];
    const seg = Math.hypot(bx - ax, bz - az);
    let t = STEP - carry;
    while (t <= seg) {
      pts.push([ax + ((bx - ax) * t) / seg, az + ((bz - az) * t) / seg]);
      t += STEP;
    }
    carry = (carry + seg) % STEP;
  }
  const last = src[src.length - 1];
  const tail = pts[pts.length - 1];
  if (last && tail && Math.hypot(last[0] - tail[0], last[1] - tail[1]) > STEP * 0.4) {
    pts.push([last[0], last[1]]);
  }
  return pts;
}

function cumOf(pts: readonly (readonly [number, number])[]): number[] {
  let total = 0;
  return pts.map((p, i) => {
    if (i === 0) return 0;
    const [ax, az] = pts[i - 1] ?? [0, 0];
    total += Math.hypot(p[0] - ax, p[1] - az);
    return total;
  });
}

// A dead-end test on the RAW polylines: an endpoint is a true dead end when
// it neither reaches the map edge nor lands on any other freeway line.
function endpointHangs(x: number, z: number, self: readonly number[]): boolean {
  if (Math.abs(x) > WORLD_HALF_X - EDGE_MARGIN || Math.abs(z) > WORLD_HALF_Z - EDGE_MARGIN) {
    return false;
  }
  for (const f of [...SF_FREEWAYS, ...SF_FREEWAY_RAMPS]) {
    if (f.p === self) continue;
    for (let i = 0; i + 3 < f.p.length; i += 2) {
      const ax = f.p[i] ?? 0;
      const az = f.p[i + 1] ?? 0;
      const bx = f.p[i + 2] ?? 0;
      const bz = f.p[i + 3] ?? 0;
      const dx = bx - ax;
      const dz = bz - az;
      const l2 = dx * dx + dz * dz;
      const t = l2 > 1e-8 ? Math.min(Math.max(((x - ax) * dx + (z - az) * dz) / l2, 0), 1) : 0;
      if (Math.hypot(ax + dx * t - x, az + dz * t - z) < f.half + 14) return true;
    }
  }
  return true;
}

let cachedBuild: FreewayBuild | null = null;

function buildData(terrain: Terrain, network?: RoadNetwork): FreewayBuild {
  if (cachedBuild) return cachedBuild;

  // --- Mainlines: terrain + clearance with an upward-only slew limit both
  // directions, so the profile glides over dips instead of rollercoastering —
  // but each sample's rise is capped by its OWN ceiling, so a hill lifts the
  // deck over itself without carrying the next kilometre of valley with it.
  // Relaxing the neighbour term through `min(ceil, …)` is what bounds the
  // dilation; the floor term is never relaxed, so the deck still always clears
  // the ground and the profile stays the minimum that does. Iterated because
  // one capped pass no longer propagates a summit to its full reach; it is
  // monotone increasing and bounded, so it converges (2-4 rounds in practice).
  const mains: Line[] = [];
  for (const f of SF_FREEWAYS) {
    const pts = resample(f.p);
    if (pts.length < 2) continue;
    const ground = pts.map(([x, z]) => terrain.heightAt(x, z));
    const ys = ground.map((h) => h + CLEAR + DECK_T);
    const ceil = ground.map((h) => h + MAX_CLEAR + DECK_T);
    const maxD = STEP * MAX_GRADE;
    for (let pass = 0; pass < 8; pass++) {
      let moved = false;
      const relax = (i: number, from: number): void => {
        const want = Math.min(ceil[i] ?? 0, from - maxD);
        if (want > (ys[i] ?? 0) + 1e-4) {
          ys[i] = want;
          moved = true;
        }
      };
      for (let i = 1; i < ys.length; i++) relax(i, ys[i - 1] ?? 0);
      for (let i = ys.length - 2; i >= 0; i--) relax(i, ys[i + 1] ?? 0);
      if (!moved) break;
    }
    // Capping the rise buys short pillars at the cost of a steeper deck, and
    // unchecked that is the worse defect: it took the steepest in-map grade
    // from 43% to 165%, i.e. a wall. Settle it by LOWERING the high side of
    // any over-steep pair toward its neighbour rather than lifting the low
    // side back up — height is what we just paid for. The floor still wins,
    // so where the ground itself steps (a cliff, an island shore) the grade
    // stays steep and honestly reports terrain rather than hiding it.
    for (let pass = 0; pass < 24; pass++) {
      let moved = false;
      const settle = (i: number, from: number): void => {
        const want = Math.max((ground[i] ?? 0) + CLEAR + DECK_T, from + maxD);
        if (want < (ys[i] ?? 0) - 1e-4) {
          ys[i] = want;
          moved = true;
        }
      };
      for (let i = 1; i < ys.length; i++) settle(i, ys[i - 1] ?? 0);
      for (let i = ys.length - 2; i >= 0; i--) settle(i, ys[i + 1] ?? 0);
      if (!moved) break;
    }
    const cum = cumOf(pts);
    const total = cum[cum.length - 1] ?? 0;

    // Dead-end grounding: the deck descends to street grade over the last
    // GROUND_RUN like an oversized ramp mouth, instead of stopping in the air.
    const first = pts[0] ?? [0, 0];
    const last = pts[pts.length - 1] ?? [0, 0];
    const openStart = endpointHangs(first[0], first[1], f.p);
    const openEnd = endpointHangs(last[0], last[1], f.p);
    if (openStart || openEnd) {
      for (let i = 0; i < pts.length; i++) {
        const [x, z] = pts[i] ?? [0, 0];
        const endDist = Math.min(
          openStart ? (cum[i] ?? 0) : Infinity,
          openEnd ? total - (cum[i] ?? 0) : Infinity,
        );
        if (endDist >= GROUND_RUN) continue;
        const c = 1 - endDist / GROUND_RUN;
        const k = c * c * (3 - 2 * c);
        const grade = terrain.heightAt(x, z) + 0.08 + endDist * 0.015;
        ys[i] = (ys[i] ?? 0) + (Math.min(grade, ys[i] ?? 0) - (ys[i] ?? 0)) * k;
      }
    }
    mains.push({ half: f.half, pts, ys, cum, ramp: false, openStart, openEnd });
  }

  // Deck height on the nearest mainline sample, if one is within r.
  const deckNear = (x: number, z: number, r: number): number | undefined => {
    let best: number | undefined;
    let bd = r * r;
    for (const m of mains) {
      for (let i = 0; i < m.pts.length; i++) {
        const [px, pz] = m.pts[i] ?? [0, 0];
        const d2 = (px - x) * (px - x) + (pz - z) * (pz - z);
        if (d2 < bd) {
          bd = d2;
          best = m.ys[i];
        }
      }
    }
    return best;
  };

  // --- Ramps: linear grade between anchored ends (deck if a mainline is
  // near, street level otherwise), floored to the terrain so the profile
  // never dives underground mid-run.
  const lines: Line[] = [...mains];
  for (const r of SF_FREEWAY_RAMPS) {
    // Street-grade mouths snap to the road NETWORK: OSM clips many links a
    // half-block short, leaving the mouth on a lawn or lot. Extending the
    // polyline to the nearest street centerline paves the missing connector
    // (same asphalt material — it reads as one surface).
    let raw: readonly number[] = r.p;
    if (network) {
      const ext = [...r.p];
      const snapTo = (x: number, z: number): readonly [number, number] | null => {
        if (deckNear(x, z, RAMP_ANCHOR_R) !== undefined) return null; // deck end
        const hit = network.nearest(x, z, 30);
        if (!hit || hit.dist < 2) return null; // already on a street
        return [hit.x, hit.z];
      };
      const head = snapTo(ext[0] ?? 0, ext[1] ?? 0);
      if (head) ext.unshift(head[0], head[1]);
      const tail = snapTo(ext[ext.length - 2] ?? 0, ext[ext.length - 1] ?? 0);
      if (tail) ext.push(tail[0], tail[1]);
      raw = ext;
    }
    const pts = resample(raw);
    if (pts.length < 2) continue;
    const first = pts[0] ?? [0, 0];
    const last = pts[pts.length - 1] ?? [0, 0];
    const deckA = deckNear(first[0], first[1], RAMP_ANCHOR_R);
    const deckB = deckNear(last[0], last[1], RAMP_ANCHOR_R);
    // Street-grade ends sit a hair above the heightfield (the raycast car
    // stalls on any real lip), and the floor clamp fades in from the mouth
    // so the first meters ARE the street.
    const yA = deckA ?? terrain.heightAt(first[0], first[1]) + 0.05;
    const yB = deckB ?? terrain.heightAt(last[0], last[1]) + 0.05;
    const cum = cumOf(pts);
    const total = cum[cum.length - 1] ?? 0;
    const ys = pts.map(([x, z], i) => {
      const t = total > 0 ? (cum[i] ?? 0) / total : 0;
      const endDist = Math.min(
        deckA === undefined ? (cum[i] ?? 0) : Infinity,
        deckB === undefined ? total - (cum[i] ?? 0) : Infinity,
      );
      const floor = terrain.heightAt(x, z) + Math.min(0.25, 0.05 + endDist * 0.02);
      let y = Math.max(yA + (yB - yA) * t, floor);
      // Deck-anchored ends BLEND to the mainline height over the last
      // stretch: the raw lerp arrives at deck level only at the very tip
      // (car face-plants into the slab edge), and a hard plateau is a step
      // in the ramp itself. Smoothstep into the anchor instead.
      // Full deck height must arrive BEFORE the ribbons overlap (the slab
      // edge is a 0.9u wall) — blend saturates 12u out from the tip.
      const B = 44;
      const SAT = 12;
      const blend = (anchor: number, endDist2: number): number => {
        const c = Math.min(1, Math.max(0, (B - endDist2) / (B - SAT)));
        const k = c * c * (3 - 2 * c);
        return y + (Math.max(anchor, y) - y) * k;
      };
      if (deckA !== undefined) y = blend(deckA, cum[i] ?? 0);
      if (deckB !== undefined) y = blend(deckB, total - (cum[i] ?? 0));
      return y;
    });
    lines.push({
      half: r.half,
      pts,
      ys,
      ramp: true,
      cum,
      openStart: deckA === undefined,
      openEnd: deckB === undefined,
    });
  }

  // CO-PLANARIZE the braids: where a ramp crosses or merges with a mainline
  // at grade (|Δy| ≤ 1.8), snap the ramp height to the mainline deck and
  // re-smooth. Crossing surfaces then coincide instead of leaving slab edges
  // and skirt ridges across the roadway — the braid rides as one surface.
  for (const line of lines) {
    if (!line.ramp) continue;
    const ys = line.ys as number[];
    let snapped = false;
    for (let i = 0; i < line.pts.length; i++) {
      const [x, z] = line.pts[i] ?? [0, 0];
      const y = ys[i] ?? 0;
      let bestD = Infinity;
      let bestY: number | undefined;
      for (const m of lines) {
        if (m === line || m.ramp) continue;
        for (let k = 0; k < m.pts.length; k++) {
          const [mx, mz] = m.pts[k] ?? [0, 0];
          const d = Math.hypot(mx - x, mz - z);
          if (d < m.half + 1 && d < bestD && Math.abs((m.ys[k] ?? 0) - y) <= 1.8) {
            bestD = d;
            bestY = m.ys[k];
          }
        }
      }
      if (bestY !== undefined) {
        ys[i] = bestY;
        snapped = true;
      }
    }
    if (snapped) {
      // Local re-smooth so snaps blend instead of stepping.
      for (let pass = 0; pass < 2; pass++) {
        for (let i = 1; i + 1 < ys.length; i++) {
          ys[i] = ((ys[i - 1] ?? 0) + (ys[i] ?? 0) * 2 + (ys[i + 1] ?? 0)) / 4;
        }
      }
    }
  }

  const deckPos: number[] = [];
  const deckNor: number[] = [];
  const bodyPos: number[] = [];
  const bodyNor: number[] = [];
  const bodyUv: number[] = [];
  const whitePos: number[] = [];
  const yellowPos: number[] = [];
  const signPos: number[] = [];
  const signNor: number[] = [];
  const physPos: number[] = [];
  const pillars: PillarSpot[] = [];

  // Axis-of-the-line box: center (cx, cz), vertical span y0..y1, half-extent
  // along the tangent (halfT) and along the lateral (halfP). Six quads.
  const pushBox = (
    pos: number[],
    nor: number[] | null,
    cx: number,
    cz: number,
    y0: number,
    y1: number,
    tx: number,
    tz: number,
    px2: number,
    pz2: number,
    halfT: number,
    halfP: number,
    uv?: number[],
  ): void => {
    const c = (st: number, sp: number, y: number): number[] => [
      cx + tx * halfT * st + px2 * halfP * sp,
      y,
      cz + tz * halfT * st + pz2 * halfP * sp,
    ];
    // Every box in the viaduct is a substructure member (pillar, pier cap,
    // gantry frame) and hangs from its own lid, so one face descriptor covers
    // all six quads.
    const face: ConFace | undefined = uv ? { uv, kind: CON_SUB, topY: y1 } : undefined;
    pushQuad(pos, nor, c(-1, -1, y1), c(1, -1, y1), c(1, 1, y1), c(-1, 1, y1), face); // top
    pushQuad(pos, nor, c(-1, -1, y0), c(-1, 1, y0), c(1, 1, y0), c(1, -1, y0), face); // bottom
    pushQuad(pos, nor, c(-1, -1, y0), c(1, -1, y0), c(1, -1, y1), c(-1, -1, y1), face);
    pushQuad(pos, nor, c(-1, 1, y0), c(-1, 1, y1), c(1, 1, y1), c(1, 1, y0), face);
    pushQuad(pos, nor, c(-1, -1, y0), c(-1, -1, y1), c(-1, 1, y1), c(-1, 1, y0), face);
    pushQuad(pos, nor, c(1, -1, y0), c(1, 1, y0), c(1, 1, y1), c(1, -1, y1), face);
  };

  // Where two ribbons meet at grade (ramp merging into its mainline, ramps
  // crossing at an interchange), a continuous barrier walls off the roadway.
  // Hash every line's samples; a barrier segment is suppressed when ANOTHER
  // line's deck covers its rail point at roughly the same height.
  const CELL = 24;
  const sampleHash = new Map<string, [number, number, number, number, number][]>(); // [x,z,y,half,lineIdx]
  lines.forEach((line, li) => {
    for (let i = 0; i < line.pts.length; i++) {
      const [x, z] = line.pts[i] ?? [0, 0];
      const y = line.ys[i] ?? 0;
      const k = `${Math.floor(x / CELL)},${Math.floor(z / CELL)}`;
      const arr = sampleHash.get(k) ?? [];
      arr.push([x, z, y, line.half, li]);
      sampleHash.set(k, arr);
    }
  });
  // A footprint of half-extent `hh` at (x, z) overlaps surface-street asphalt.
  // Undefined network (the pre-network build path) keeps the old behaviour.
  const blocksStreet = (x: number, z: number, hh: number): boolean => {
    const hit = network?.nearest(x, z, 40);
    return hit ? hit.dist < hit.edge.half + hh : false;
  };

  // Another ribbon covers this point at grade (within `grow` of its deck).
  const otherDeckAt = (x: number, z: number, y: number, self: number, grow: number): boolean => {
    const bx = Math.floor(x / CELL);
    const bz = Math.floor(z / CELL);
    for (let ix = bx - 1; ix <= bx + 1; ix++) {
      for (let iz = bz - 1; iz <= bz + 1; iz++) {
        for (const [sx, sz, sy, half, li] of sampleHash.get(`${ix},${iz}`) ?? []) {
          if (li === self) continue;
          if (Math.abs(sy - y) > 1.5) continue;
          if (Math.hypot(sx - x, sz - z) < half + grow) return true;
        }
      }
    }
    return false;
  };

  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    const line = lines[lineIdx];
    if (!line) continue;
    const n = line.pts.length;
    const w = line.half;
    const total = line.cum[line.cum.length - 1] ?? Infinity;
    const barrierH = line.ramp ? 0.55 : BARRIER_H;
    // Per-sample rails + the unit lateral (perp) so paint strips can sit at
    // any offset without re-deriving tangents.
    const rails: { l: number[]; r: number[]; px: number; pz: number }[] = [];
    for (let i = 0; i < n; i++) {
      const [x, z] = line.pts[i] ?? [0, 0];
      const [px, pz] = line.pts[Math.max(0, i - 1)] ?? [0, 0];
      const [qx, qz] = line.pts[Math.min(n - 1, i + 1)] ?? [0, 0];
      let tx = qx - px;
      let tz = qz - pz;
      const tl = Math.hypot(tx, tz) || 1;
      tx /= tl;
      tz /= tl;
      const y = line.ys[i] ?? 0;
      rails.push({
        l: [x - tz * w, y, z + tx * w],
        r: [x + tz * w, y, z - tx * w],
        px: -tz,
        pz: tx,
      });
    }
    // A point at lateral offset o from the centerline sample i (deck-top y).
    const at = (i: number, o: number): [number, number, number] => {
      const [x, z] = line.pts[i] ?? [0, 0];
      const rl = rails[i];
      return [x + (rl?.px ?? 0) * o, (line.ys[i] ?? 0) + PAINT_LIFT, z + (rl?.pz ?? 0) * o];
    };
    const clearanceAt = (i: number): number => {
      const [x, z] = line.pts[i] ?? [0, 0];
      return (line.ys[i] ?? 0) - terrain.heightAt(x, z);
    };
    for (let i = 0; i + 1 < n; i++) {
      const a = rails[i];
      const b = rails[i + 1];
      if (!a || !b) continue;
      const drop = (p: readonly number[]): number[] => [p[0] ?? 0, (p[1] ?? 0) - DECK_T, p[2] ?? 0];
      // Deck top (asphalt look) — also the physics ride surface.
      pushQuad(deckPos, deckNor, a.l, b.l, b.r, a.r);
      pushQuad(physPos, null, a.l, b.l, b.r, a.r);
      // Soffit + fasciae (concrete). The soffit's uv carries the across-deck
      // coordinate (its corners run r, r, l, l, i.e. +w to -w), the fasciae
      // carry their drip run below the deck top.
      const deckTop = Math.max(a.l[1] ?? 0, b.l[1] ?? 0);
      const soffitFace: ConFace = {
        uv: bodyUv,
        kind: CON_SOFFIT,
        topY: deckTop,
        s: [w, w, -w, -w],
      };
      const fasciaFace: ConFace = { uv: bodyUv, kind: CON_FASCIA, topY: deckTop };
      pushQuad(bodyPos, bodyNor, drop(a.r), drop(b.r), drop(b.l), drop(a.l), soffitFace);
      pushQuad(bodyPos, bodyNor, a.r, b.r, drop(b.r), drop(a.r), fasciaFace);
      pushQuad(bodyPos, bodyNor, drop(a.l), drop(b.l), b.l, a.l, fasciaFace);

      const segS = line.cum[i] ?? Infinity;
      const nearOpen =
        (line.openStart === true && segS < 10) || (line.openEnd === true && total - segS < 10);

      // --- Deck paint ---
      // Solid edge lines both sides (suppressed through merge blobs so paint
      // never slices across a joining roadway), a yellow centerline on
      // mainlines (the deck carries both directions), and white lane dashes.
      const eo = w - EDGE_INSET;
      const paintSeg = (arr: number[], o: number): void => {
        pushQuad(
          arr,
          null,
          at(i, o - LINE_W / 2),
          at(i + 1, o - LINE_W / 2),
          at(i + 1, o + LINE_W / 2),
          at(i, o + LINE_W / 2),
        );
      };
      // Paint suppresses only where another ribbon TRULY overlaps (grow
      // -0.3): the old 1u grow blanked every parallel braid section bald.
      for (const side of [-1, 1] as const) {
        const p0 = at(i, eo * side);
        const p1 = at(i + 1, eo * side);
        if (
          otherDeckAt(p0[0], p0[2], p0[1], lineIdx, -0.3) ||
          otherDeckAt(p1[0], p1[2], p1[1], lineIdx, -0.3)
        ) {
          continue;
        }
        paintSeg(whitePos, eo * side);
      }
      if (!line.ramp) {
        paintSeg(yellowPos, 0);
        // Dash phase from arclength so the pattern flows through samples.
        const phase = segS % (DASH_LEN + DASH_GAP);
        if (phase < DASH_LEN) {
          for (const side of [-1, 1] as const) {
            const o = w * 0.45 * side;
            const p0 = at(i, o);
            if (otherDeckAt(p0[0], p0[2], p0[1], lineIdx, -0.3)) continue;
            paintSeg(whitePos, o);
          }
        }
      }

      // Side barriers: low walls hugging the deck edges — solid in physics so
      // the car banks off them instead of sailing into the void mid-corner.
      // The inner face insets along each SAMPLE'S OWN lateral (rails[k]) —
      // insetting both ends toward pts[i] skewed every quad backward and the
      // wall read as chopped wedges with gaps at every joint.
      const railIn = (k: number, side: "l" | "r"): number[] => {
        const rl = rails[k];
        const p = rl ? rl[side] : [0, 0, 0];
        const sgn = side === "l" ? -1 : 1;
        return [
          (p[0] ?? 0) + (rl?.px ?? 0) * 0.5 * sgn,
          p[1] ?? 0,
          (p[2] ?? 0) + (rl?.pz ?? 0) * 0.5 * sgn,
        ];
      };
      const lift = (p: readonly number[], h: number): number[] => [
        p[0] ?? 0,
        (p[1] ?? 0) + h,
        p[2] ?? 0,
      ];
      // Open mouths (ramp ends at street grade, grounded mainline ends): no
      // barrier within 10u, so the car rolls on/off without threading a
      // walled slot.
      if (nearOpen) continue;
      for (const side of ["l", "r"] as const) {
        const p0 = a[side];
        const p1 = b[side];
        // Merge/crossing gap: another ribbon runs through this rail point at
        // grade — leave the barrier out so the roadways connect (and so a
        // lower ribbon's rail never pierces a deck above as a fallen beam).
        if (
          otherDeckAt(p0[0] ?? 0, p0[2] ?? 0, p0[1] ?? 0, lineIdx, 1.0) ||
          otherDeckAt(p1[0] ?? 0, p1[2] ?? 0, p1[1] ?? 0, lineIdx, 1.0)
        ) {
          continue;
        }
        // A grounded end's deck IS road at street grade, so its rail is a
        // concrete wall standing across whatever street it crosses. Drop the
        // segment visually AND physically (dropping only the collider leaves
        // a wall you drive through): falling off a lip near grade is
        // recoverable, the same rationale the ramp clearance gate uses.
        if (
          Math.min(clearanceAt(i), clearanceAt(i + 1)) < RAIL_SOLID_CLEAR &&
          (blocksStreet(p0[0] ?? 0, p0[2] ?? 0, 0.5) || blocksStreet(p1[0] ?? 0, p1[2] ?? 0, 0.5))
        ) {
          continue;
        }
        const q0 = railIn(i, side);
        const q1 = railIn(i + 1, side);
        const capY = Math.max(p0[1] ?? 0, p1[1] ?? 0) + barrierH;
        const railFace: ConFace = { uv: bodyUv, kind: CON_BARRIER, topY: capY };
        pushQuad(
          bodyPos,
          bodyNor,
          lift(q0, barrierH),
          lift(q1, barrierH),
          lift(p1, barrierH),
          lift(p0, barrierH),
          railFace,
        ); // cap
        pushQuad(bodyPos, bodyNor, p0, p1, lift(p1, barrierH), lift(p0, barrierH), railFace); // outer face
        pushQuad(bodyPos, bodyNor, lift(q0, barrierH), lift(q1, barrierH), q1, q0, railFace); // inner face
        // Rails are PHYSICAL wherever falling off would strand the car:
        // every mainline, and any ramp section riding clear of the ground
        // (the old visual-only ramp rails were the "drove off the side of
        // the highway" report). Low ramp sections stay open — sailing off
        // near grade is recoverable (and fun) where a mid-air exit is not.
        // The wall extends an invisible RAIL_PHYS_EXTRA above the visual cap
        // so a boosted car can't vault it.
        const solidRail =
          !line.ramp || Math.min(clearanceAt(i), clearanceAt(i + 1)) > RAIL_SOLID_CLEAR + DECK_T;
        if (solidRail) {
          pushQuad(
            physPos,
            null,
            lift(q0, barrierH + RAIL_PHYS_EXTRA),
            lift(q1, barrierH + RAIL_PHYS_EXTRA),
            q1,
            q0,
          );
        }
      }
    }

    // Overhead signage: PROCEDURAL gantries — two posts just outside the
    // barriers, a beam across the full deck, and a green guide board hung
    // over the travel side. Parametric to the deck, so nothing ever floats.
    if (!line.ramp) {
      let signFlip = lineIdx % 2 === 0;
      for (let s = SIGN_EVERY * 0.5; s < total - 40; s += SIGN_EVERY) {
        let i = 1;
        while (i < n - 1 && (line.cum[i] ?? 0) < s) i++;
        if (clearanceAt(i) < CLEAR * 0.7) continue; // grounded stretch — no gantries
        const rl = rails[i];
        if (!rl) continue;
        const dir = signFlip ? 1 : -1;
        signFlip = !signFlip;
        const [x, z] = line.pts[i] ?? [0, 0];
        const deckY = line.ys[i] ?? 0;
        const tx = rl.pz; // tangent = perp rotated -90°
        const tz = -rl.px;
        const span = w + 0.55; // posts just outside the barrier line
        for (const ps of [-1, 1] as const) {
          pushBox(
            bodyPos,
            bodyNor,
            x + rl.px * span * ps,
            z + rl.pz * span * ps,
            deckY - 0.1,
            deckY + GANTRY_POST_H,
            tx,
            tz,
            rl.px,
            rl.pz,
            0.2,
            0.2,
            bodyUv,
          );
        }
        pushBox(
          bodyPos,
          bodyNor,
          x,
          z,
          deckY + GANTRY_BEAM_Y0,
          deckY + GANTRY_BEAM_Y1,
          tx,
          tz,
          rl.px,
          rl.pz,
          0.14,
          span + 0.2,
          bodyUv,
        );
        // Guide board over the chosen travel side, facing its oncoming flow.
        pushBox(
          signPos,
          signNor,
          x + rl.px * w * 0.5 * dir,
          z + rl.pz * w * 0.5 * dir,
          deckY + GANTRY_BOARD_Y0,
          deckY + GANTRY_BEAM_Y0,
          tx,
          tz,
          rl.px,
          rl.pz,
          0.08,
          GANTRY_BOARD_HALF_W,
        );
      }
    }

    // Pillars. Dropping one on the centerline every N samples put 24% of them
    // INSIDE a street — SF's viaducts were built over the boulevards they
    // follow, so the centerline IS the roadway for long stretches. Search the
    // neighbouring samples and a lateral band under the deck for a footing
    // that misses the asphalt; when the whole bay is roadway, fall back to the
    // street's own MEDIAN (a median pier reads intentional, a pole in a travel
    // lane reads broken). A pier CAP spans the deck so an off-centre column
    // still visibly carries it.
    const pillarH = line.ramp ? 0.7 : 0.95;
    const latMax = Math.max(0, w - pillarH * 0.5);
    for (let i = PILLAR_EVERY; i < n - 1; i += PILLAR_EVERY) {
      let spot: { j: number; lat: number } | null = null;
      let median: { j: number; lat: number; d: number } | null = null;
      for (const [dj, latF] of PILLAR_OFFSETS) {
        const j = Math.min(n - 2, Math.max(1, i + dj));
        const rl = rails[j];
        const pt = line.pts[j];
        if (!rl || !pt) continue;
        const lat = latF * latMax;
        const cx = pt[0] + rl.px * lat;
        const cz = pt[1] + rl.pz * lat;
        const hit = network?.nearest(cx, cz, 40) ?? null;
        if (!hit || hit.dist - hit.edge.half - pillarH * Math.SQRT2 > PILLAR_CLEAR) {
          spot = { j, lat };
          break;
        }
        if (!median || hit.dist < median.d) median = { j, lat, d: hit.dist };
      }
      const place = spot ?? median;
      const rl = place ? rails[place.j] : undefined;
      const pt = place ? line.pts[place.j] : undefined;
      if (!place || !rl || !pt) continue;
      const x = pt[0] + rl.px * place.lat;
      const z = pt[1] + rl.pz * place.lat;
      const deckY = line.ys[place.j] ?? 0;
      const topY = deckY - DECK_T;
      const botY = terrain.heightAt(x, z) - 0.6;
      if (topY - botY < 1.2) continue;
      // Tangent basis (see the gantry posts): keeps the column square to the
      // deck instead of to the world axes.
      const tx = rl.pz;
      const tz = -rl.px;
      // Visual + physics are the SAME closed box: an open shaft is a wheel
      // trap (a car that lands on a pillar must find a lid and drive off),
      // and the column must stop at the soffit — the generic 12u solid boxes
      // walled off the very deck they hold up.
      pillars.push({ x, z, half: pillarH });
      pushBox(bodyPos, bodyNor, x, z, botY, topY, tx, tz, rl.px, rl.pz, pillarH, pillarH, bodyUv);
      pushBox(physPos, null, x, z, botY, topY, tx, tz, rl.px, rl.pz, pillarH, pillarH);
      pushBox(
        bodyPos,
        bodyNor,
        pt[0],
        pt[1],
        topY - PIER_CAP_T,
        topY,
        tx,
        tz,
        rl.px,
        rl.pz,
        pillarH * 0.85,
        w * 0.9,
        bodyUv,
      );
      // NO solid: the arcade solid-index is height-blind (a pillar box is an
      // invisible wall ON the deck it holds up). The trimesh walls above
      // already stop street-level traffic into the pillar.
    }
  }

  cachedBuild = {
    lines,
    pillars,
    deckPos,
    deckNor,
    bodyPos,
    bodyNor,
    bodyUv,
    whitePos,
    yellowPos,
    signPos,
    signNor,
    physPos,
  };
  return cachedBuild;
}

// --- Placement guard: no procedural building inside the freeway ROW ---
const rowHash = new Map<string, [number, number, number, number, number][]>(); // bucket -> segments [ax,az,bx,bz,half]
const ROW_CELL = 60;
let rowBuilt = false;
function buildRowHash(): void {
  if (rowBuilt) return;
  rowBuilt = true;
  for (const f of [...SF_FREEWAYS, ...SF_FREEWAY_RAMPS]) {
    for (let i = 0; i + 3 < f.p.length; i += 2) {
      const ax = f.p[i] ?? 0;
      const az = f.p[i + 1] ?? 0;
      const bx = f.p[i + 2] ?? 0;
      const bz = f.p[i + 3] ?? 0;
      const seg: [number, number, number, number, number] = [ax, az, bx, bz, f.half];
      for (
        let cx = Math.floor((Math.min(ax, bx) - 12) / ROW_CELL);
        cx <= Math.floor((Math.max(ax, bx) + 12) / ROW_CELL);
        cx++
      ) {
        for (
          let cz = Math.floor((Math.min(az, bz) - 12) / ROW_CELL);
          cz <= Math.floor((Math.max(az, bz) + 12) / ROW_CELL);
          cz++
        ) {
          const k = `${cx},${cz}`;
          const arr = rowHash.get(k) ?? [];
          arr.push(seg);
          rowHash.set(k, arr);
        }
      }
    }
  }
}

export function nearFreeway(x: number, z: number, margin: number): boolean {
  buildRowHash();
  const segs = rowHash.get(`${Math.floor(x / ROW_CELL)},${Math.floor(z / ROW_CELL)}`);
  if (!segs) return false;
  for (const [ax, az, bx, bz, half] of segs) {
    const lim = half + margin;
    const dx = bx - ax;
    const dz = bz - az;
    const l2 = dx * dx + dz * dz;
    const t = l2 > 1e-8 ? Math.min(Math.max(((x - ax) * dx + (z - az) * dz) / l2, 0), 1) : 0;
    if (Math.hypot(ax + dx * t - x, az + dz * t - z) < lim) return true;
  }
  return false;
}

// Deck + inner-barrier triangles for the static physics trimesh — the car
// drives the exact rendered surface. Streets keep the heightfield below:
// wheel rays cast from under the deck never reach it, so underpasses work.
/** Pillar footprints of the memoized build — `pnpm test` asserts none sit in a street. */
export function freewayPillars(terrain: Terrain, network?: RoadNetwork): readonly PillarSpot[] {
  return buildData(terrain, network).pillars;
}

export function freewayPhysics(terrain: Terrain, network?: RoadNetwork): Float32Array {
  return new Float32Array(buildData(terrain, network).physPos);
}

function pushQuad(
  pos: number[],
  nor: number[] | null,
  a: readonly number[],
  b: readonly number[],
  c: readonly number[],
  d: readonly number[],
  face?: ConFace,
): void {
  const ux = (b[0] ?? 0) - (a[0] ?? 0);
  const uy = (b[1] ?? 0) - (a[1] ?? 0);
  const uz = (b[2] ?? 0) - (a[2] ?? 0);
  const vx = (d[0] ?? 0) - (a[0] ?? 0);
  const vy = (d[1] ?? 0) - (a[1] ?? 0);
  const vz = (d[2] ?? 0) - (a[2] ?? 0);
  let nx = uy * vz - uz * vy;
  let ny = uz * vx - ux * vz;
  let nz = ux * vy - uy * vx;
  const nl = Math.hypot(nx, ny, nz) || 1;
  nx /= nl;
  ny /= nl;
  nz /= nl;
  const put = (p: readonly number[], corner: 0 | 1 | 2 | 3): void => {
    pos.push(p[0] ?? 0, p[1] ?? 0, p[2] ?? 0);
    if (nor) nor.push(nx, ny, nz);
    if (face) face.uv.push(face.s?.[corner] ?? face.topY - (p[1] ?? 0), face.kind);
  };
  put(a, 0);
  put(b, 1);
  put(c, 2);
  put(a, 0);
  put(c, 2);
  put(d, 3);
}

/**
 * `uv` carries the concrete shader's member channel (see CON_* above) when one
 * is supplied; every other mesh keeps the zero-filled attribute, which is that
 * shader's documented "no data" opt-out and what three's uv-transform chunks
 * expect to exist.
 */
function geoFrom(pos: number[], nor: number[] | null, uv?: number[]): THREE.BufferGeometry {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(pos), 3));
  if (nor) {
    geo.setAttribute("normal", new THREE.BufferAttribute(new Float32Array(nor), 3));
  } else {
    const up = new Float32Array(pos.length);
    for (let i = 1; i < up.length; i += 3) up[i] = 1;
    geo.setAttribute("normal", new THREE.BufferAttribute(up, 3));
  }
  const n = (pos.length / 3) * 2;
  const src = uv && uv.length === n ? new Float32Array(uv) : new Float32Array(n);
  geo.setAttribute("uv", new THREE.BufferAttribute(src, 2));
  return geo;
}

export function buildFreeways(terrain: Terrain, network?: RoadNetwork): THREE.Group {
  const data = buildData(terrain, network);
  const group = new THREE.Group();
  const deckMesh = new THREE.Mesh(geoFrom(data.deckPos, data.deckNor), MAT_DECK);
  const bodyMesh = new THREE.Mesh(geoFrom(data.bodyPos, data.bodyNor, data.bodyUv), MAT_CONCRETE);
  // Named so `__taxi.pick` reports them and a headless QA pass can mask the
  // viaduct out of a frame by object identity rather than by material colour
  // (which is exactly what a value pass changes).
  deckMesh.name = "freeway-deck";
  bodyMesh.name = "freeway-concrete";
  deckMesh.receiveShadow = true;
  bodyMesh.castShadow = true;
  bodyMesh.receiveShadow = true;
  group.add(deckMesh, bodyMesh);
  if (data.whitePos.length > 0) {
    group.add(new THREE.Mesh(geoFrom(data.whitePos, null), MAT_PAINT_WHITE));
  }
  if (data.yellowPos.length > 0) {
    group.add(new THREE.Mesh(geoFrom(data.yellowPos, null), MAT_PAINT_YELLOW));
  }
  if (data.signPos.length > 0) {
    const boards = new THREE.Mesh(geoFrom(data.signPos, data.signNor), MAT_SIGN);
    boards.castShadow = true;
    group.add(boards);
  }
  return group;
}
