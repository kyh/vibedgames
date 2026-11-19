import * as THREE from "three";

import { WORLD_HALF_X, WORLD_HALF_Z } from "../shared/constants";
import type { RoadNetwork } from "./network";
import { applyMaterialBreakup, ROAD_BREAKUP } from "../render/material-breakup";
import { WEATHER } from "./masonry";
import { applyAsphaltSpeckle, lowDetailSurfaces } from "./roads";
import { SF_FREEWAY_RAMPS, SF_FREEWAYS } from "./sf-freeways";
import type { Terrain } from "./terrain";

const STEP = 6;
const CLEAR = 6.5;
const MAX_CLEAR = 13;
const DECK_T = 0.9;
const MAX_GRADE = 0.12;
const PILLAR_EVERY = 4;
const PILLAR_CLEAR = 0.4;
const PIER_CAP_T = 0.55;

const PILLAR_OFFSETS: readonly (readonly [number, number])[] = (() => {
  const out: [number, number][] = [];

  for (let dj = -2; dj <= 2; dj += 1) {
    for (let l = -6; l <= 6; l += 1) {
      out.push([dj, l / 6]);
    }
  }

  return out.toSorted(
    (a, b) => Math.hypot(a[0] / 2, a[1] * 0.6) - Math.hypot(b[0] / 2, b[1] * 0.6),
  );
})();

const RAMP_ANCHOR_R = 30;
const BARRIER_H = 0.85;
const GROUND_RUN = 96;
const EDGE_MARGIN = 45;
const RAIL_SOLID_CLEAR = 2.4;
const RAIL_PHYS_EXTRA = 0.9;

const LINE_W = 0.24;
const EDGE_INSET = 0.55;
const DASH_LEN = 3.2;
const DASH_GAP = 3.4;
const PAINT_LIFT = 0.02;

const SIGN_EVERY = 270;
const GANTRY_POST_H = 5.4;
const GANTRY_BEAM_Y0 = 5.05;
const GANTRY_BEAM_Y1 = 5.4;
const GANTRY_BOARD_Y0 = 3.55;
const GANTRY_BOARD_HALF_W = 2.1;

const CON_SOFFIT = 1;
const CON_FASCIA = 2;
const CON_BARRIER = 3;
const CON_SUB = 4;

const applyConcreteWeathering = (mat: THREE.MeshStandardMaterial) => {
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
};

const MAT_CONCRETE = new THREE.MeshStandardMaterial({
  color: 0x97_94_8b,
  roughness: 1,
  side: THREE.DoubleSide,
});

applyConcreteWeathering(MAT_CONCRETE);

const MAT_DECK = new THREE.MeshStandardMaterial({ color: 0x55_5b_68, roughness: 1 });

applyAsphaltSpeckle(MAT_DECK);

applyMaterialBreakup(MAT_DECK, ROAD_BREAKUP);

const MAT_PAINT_WHITE = new THREE.MeshStandardMaterial({
  color: 0xf4_f7_f4,
  polygonOffset: true,
  polygonOffsetFactor: -2,
  polygonOffsetUnits: -4,
  roughness: 0.9,
});

const MAT_PAINT_YELLOW = new THREE.MeshStandardMaterial({
  color: 0xf2_b8_3a,
  polygonOffset: true,
  polygonOffsetFactor: -2,
  polygonOffsetUnits: -4,
  roughness: 0.9,
});

const MAT_SIGN = new THREE.MeshStandardMaterial({ color: 0x25_71_4a, roughness: 0.85 });

interface Line {
  readonly half: number;
  readonly pts: readonly (readonly [number, number])[];
  readonly ys: number[];
  readonly ramp: boolean;
  readonly cum: readonly number[];
  readonly openStart?: boolean;
  readonly openEnd?: boolean;
}

/** Placed pillar footprint (centre + half-extent) — see the placement search. */
export interface PillarSpot {
  readonly x: number;
  readonly z: number;
  readonly half: number;
}

interface ConFace {
  readonly uv: number[];
  readonly kind: number;
  readonly topY: number;
  readonly s?: readonly [number, number, number, number];
}

interface FreewayBuild {
  readonly lines: readonly Line[];
  readonly pillars: readonly PillarSpot[];
  readonly deckPos: Float32Array;
  readonly deckNor: Float32Array;
  readonly bodyPos: Float32Array;
  readonly bodyNor: Float32Array;
  readonly bodyUv: Float32Array;
  readonly whitePos: Float32Array;
  readonly yellowPos: Float32Array;
  readonly signPos: Float32Array;
  readonly signNor: Float32Array;
  readonly physPos: Float32Array;
}

const resample = (p: readonly number[]) => {
  const src: [number, number][] = [];

  for (let i = 0; i + 1 < p.length; i += 2) {
    src.push([p[i] ?? 0, p[i + 1] ?? 0]);
  }

  if (src.length < 2) {
    return [];
  }

  const pts: [number, number][] = [src[0] ?? [0, 0]];
  let carry = 0;

  for (let i = 1; i < src.length; i += 1) {
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

  const last = src.at(-1);
  const tail = pts.at(-1);

  if (last && tail && Math.hypot(last[0] - tail[0], last[1] - tail[1]) > STEP * 0.4) {
    pts.push([last[0], last[1]]);
  }

  return pts;
};

const cumOf = (pts: readonly (readonly [number, number])[]) => {
  let total = 0;

  return pts.map((p, i) => {
    if (i === 0) {
      return 0;
    }

    const [ax, az] = pts[i - 1] ?? [0, 0];
    total += Math.hypot(p[0] - ax, p[1] - az);

    return total;
  });
};

const endpointHangs = (x: number, z: number, self: readonly number[]) => {
  if (Math.abs(x) > WORLD_HALF_X - EDGE_MARGIN || Math.abs(z) > WORLD_HALF_Z - EDGE_MARGIN) {
    return false;
  }

  for (const f of [...SF_FREEWAYS, ...SF_FREEWAY_RAMPS]) {
    if (f.p === self) {
      continue;
    }

    for (let i = 0; i + 3 < f.p.length; i += 2) {
      const ax = f.p[i] ?? 0;
      const az = f.p[i + 1] ?? 0;
      const bx = f.p[i + 2] ?? 0;
      const bz = f.p[i + 3] ?? 0;
      const dx = bx - ax;
      const dz = bz - az;
      const l2 = dx * dx + dz * dz;
      const t = l2 > 1e-8 ? Math.min(Math.max(((x - ax) * dx + (z - az) * dz) / l2, 0), 1) : 0;

      if (Math.hypot(ax + dx * t - x, az + dz * t - z) < f.half + 14) {
        return true;
      }
    }
  }

  return true;
};

const pushQuad = (
  pos: number[],
  nor: number[] | null,
  a: readonly number[],
  b: readonly number[],
  c: readonly number[],
  d: readonly number[],
  face?: ConFace,
) => {
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

  const put = (p: readonly number[], corner: 0 | 1 | 2 | 3) => {
    pos.push(p[0] ?? 0, p[1] ?? 0, p[2] ?? 0);

    if (nor) {
      nor.push(nx, ny, nz);
    }

    if (face) {
      face.uv.push(face.s?.[corner] ?? face.topY - (p[1] ?? 0), face.kind);
    }
  };

  put(a, 0);
  put(b, 1);
  put(c, 2);
  put(a, 0);
  put(c, 2);
  put(d, 3);
};

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
) => {
  const c = (st: number, sp: number, y: number) => [
    cx + tx * halfT * st + px2 * halfP * sp,
    y,
    cz + tz * halfT * st + pz2 * halfP * sp,
  ];

  const face: ConFace | undefined = uv ? { kind: CON_SUB, topY: y1, uv } : undefined;
  pushQuad(pos, nor, c(-1, -1, y1), c(1, -1, y1), c(1, 1, y1), c(-1, 1, y1), face);
  pushQuad(pos, nor, c(-1, -1, y0), c(-1, 1, y0), c(1, 1, y0), c(1, -1, y0), face);
  pushQuad(pos, nor, c(-1, -1, y0), c(1, -1, y0), c(1, -1, y1), c(-1, -1, y1), face);
  pushQuad(pos, nor, c(-1, 1, y0), c(-1, 1, y1), c(1, 1, y1), c(1, 1, y0), face);
  pushQuad(pos, nor, c(-1, -1, y0), c(-1, -1, y1), c(-1, 1, y1), c(-1, 1, y0), face);
  pushQuad(pos, nor, c(1, -1, y0), c(1, 1, y0), c(1, 1, y1), c(1, -1, y1), face);
};

const lift = (p: readonly number[], h: number) => [p[0] ?? 0, (p[1] ?? 0) + h, p[2] ?? 0];

const solveMainProfile = (ground: readonly number[], ys: number[], ceil: readonly number[]) => {
  const maxD = STEP * MAX_GRADE;

  for (let pass = 0; pass < 8; pass += 1) {
    let moved = false;

    const relax = (i: number, from: number) => {
      const want = Math.min(ceil[i] ?? 0, from - maxD);

      if (want > (ys[i] ?? 0) + 1e-4) {
        ys[i] = want;
        moved = true;
      }
    };

    for (let i = 1; i < ys.length; i += 1) {
      relax(i, ys[i - 1] ?? 0);
    }

    for (let i = ys.length - 2; i >= 0; i -= 1) {
      relax(i, ys[i + 1] ?? 0);
    }

    if (!moved) {
      break;
    }
  }

  for (let pass = 0; pass < 24; pass += 1) {
    let moved = false;

    const settle = (i: number, from: number) => {
      const want = Math.max((ground[i] ?? 0) + CLEAR + DECK_T, from + maxD);

      if (want < (ys[i] ?? 0) - 1e-4) {
        ys[i] = want;
        moved = true;
      }
    };

    for (let i = 1; i < ys.length; i += 1) {
      settle(i, ys[i - 1] ?? 0);
    }

    for (let i = ys.length - 2; i >= 0; i -= 1) {
      settle(i, ys[i + 1] ?? 0);
    }

    if (!moved) {
      break;
    }
  }
};

const groundOpenEnds = (
  terrain: Terrain,
  pts: readonly (readonly [number, number])[],
  ys: number[],
  cum: readonly number[],
  total: number,
  openStart: boolean,
  openEnd: boolean,
) => {
  if (openStart || openEnd) {
    for (let i = 0; i < pts.length; i += 1) {
      const [x, z] = pts[i] ?? [0, 0];

      const endDist = Math.min(
        openStart ? (cum[i] ?? 0) : Infinity,
        openEnd ? total - (cum[i] ?? 0) : Infinity,
      );

      if (endDist >= GROUND_RUN) {
        continue;
      }

      const c = 1 - endDist / GROUND_RUN;
      const k = c * c * (3 - 2 * c);
      const grade = terrain.heightAt(x, z) + 0.08 + endDist * 0.015;
      ys[i] = (ys[i] ?? 0) + (Math.min(grade, ys[i] ?? 0) - (ys[i] ?? 0)) * k;
    }
  }
};

const buildMainlines = (terrain: Terrain) => {
  const mains: Line[] = [];

  for (const f of SF_FREEWAYS) {
    const pts = resample(f.p);

    if (pts.length < 2) {
      continue;
    }

    const ground = pts.map(([x, z]) => terrain.heightAt(x, z));
    const ys = ground.map((h) => h + CLEAR + DECK_T);
    const ceil = ground.map((h) => h + MAX_CLEAR + DECK_T);
    solveMainProfile(ground, ys, ceil);
    const cum = cumOf(pts);
    const total = cum.at(-1) ?? 0;
    const first = pts[0] ?? [0, 0];
    const last = pts.at(-1) ?? [0, 0];
    const openStart = endpointHangs(first[0], first[1], f.p);
    const openEnd = endpointHangs(last[0], last[1], f.p);
    groundOpenEnds(terrain, pts, ys, cum, total, openStart, openEnd);
    mains.push({ cum, half: f.half, openEnd, openStart, pts, ramp: false, ys });
  }

  return mains;
};

const deckNear = (mains: readonly Line[], x: number, z: number, r: number) => {
  let best: number | undefined;
  let bd = r * r;

  for (const m of mains) {
    for (let i = 0; i < m.pts.length; i += 1) {
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

const extendRampMouths = (p: readonly number[], network: RoadNetwork, mains: readonly Line[]) => {
  const ext = [...p];

  const snapTo: (x: number, z: number) => readonly [number, number] | null = (x, z) => {
    if (deckNear(mains, x, z, RAMP_ANCHOR_R) !== undefined) {
      return null;
    }

    const hit = network.nearest(x, z, 30);

    if (!hit || hit.dist < 2) {
      return null;
    }

    return [hit.x, hit.z];
  };

  const head = snapTo(ext[0] ?? 0, ext[1] ?? 0);

  if (head) {
    ext.unshift(head[0], head[1]);
  }

  const tail = snapTo(ext.at(-2) ?? 0, ext.at(-1) ?? 0);

  if (tail) {
    ext.push(tail[0], tail[1]);
  }

  return ext;
};

const buildRamps = (terrain: Terrain, network: RoadNetwork | undefined, mains: readonly Line[]) => {
  const ramps: Line[] = [];

  for (const r of SF_FREEWAY_RAMPS) {
    const raw = network ? extendRampMouths(r.p, network, mains) : r.p;
    const pts = resample(raw);

    if (pts.length < 2) {
      continue;
    }

    const first = pts[0] ?? [0, 0];
    const last = pts.at(-1) ?? [0, 0];
    const deckA = deckNear(mains, first[0], first[1], RAMP_ANCHOR_R);
    const deckB = deckNear(mains, last[0], last[1], RAMP_ANCHOR_R);
    const yA = deckA ?? terrain.heightAt(first[0], first[1]) + 0.05;
    const yB = deckB ?? terrain.heightAt(last[0], last[1]) + 0.05;
    const cum = cumOf(pts);
    const total = cum.at(-1) ?? 0;

    const ys = pts.map(([x, z], i) => {
      const t = total > 0 ? (cum[i] ?? 0) / total : 0;

      const endDist = Math.min(
        deckA === undefined ? (cum[i] ?? 0) : Infinity,
        deckB === undefined ? total - (cum[i] ?? 0) : Infinity,
      );

      const floor = terrain.heightAt(x, z) + Math.min(0.25, 0.05 + endDist * 0.02);
      let y = Math.max(yA + (yB - yA) * t, floor);
      const B = 44;
      const SAT = 12;

      const blend = (anchor: number, endDist2: number) => {
        const c = Math.min(1, Math.max(0, (B - endDist2) / (B - SAT)));
        const k = c * c * (3 - 2 * c);

        return y + (Math.max(anchor, y) - y) * k;
      };

      if (deckA !== undefined) {
        y = blend(deckA, cum[i] ?? 0);
      }

      if (deckB !== undefined) {
        y = blend(deckB, total - (cum[i] ?? 0));
      }

      return y;
    });

    ramps.push({
      cum,
      half: r.half,
      openEnd: deckB === undefined,
      openStart: deckA === undefined,
      pts,
      ramp: true,
      ys,
    });
  }

  return ramps;
};

const nearestDeckY = (lines: readonly Line[], line: Line, x: number, z: number, y: number) => {
  let bestD = Infinity;
  let bestY: number | undefined;

  for (const m of lines) {
    if (m === line || m.ramp) {
      continue;
    }

    for (let k = 0; k < m.pts.length; k += 1) {
      const [mx, mz] = m.pts[k] ?? [0, 0];
      const d = Math.hypot(mx - x, mz - z);

      if (d < m.half + 1 && d < bestD && Math.abs((m.ys[k] ?? 0) - y) <= 1.8) {
        bestD = d;
        bestY = m.ys[k];
      }
    }
  }

  return bestY;
};

const coplanarizeRamps = (lines: readonly Line[]) => {
  for (const line of lines) {
    if (!line.ramp) {
      continue;
    }

    const { ys } = line;
    let snapped = false;

    for (let i = 0; i < line.pts.length; i += 1) {
      const [x, z] = line.pts[i] ?? [0, 0];
      const bestY = nearestDeckY(lines, line, x, z, ys[i] ?? 0);

      if (bestY !== undefined) {
        ys[i] = bestY;
        snapped = true;
      }
    }

    if (snapped) {
      for (let pass = 0; pass < 2; pass += 1) {
        for (let i = 1; i + 1 < ys.length; i += 1) {
          ys[i] = ((ys[i - 1] ?? 0) + (ys[i] ?? 0) * 2 + (ys[i + 1] ?? 0)) / 4;
        }
      }
    }
  }
};

interface Buffers {
  readonly deckPos: number[];
  readonly deckNor: number[];
  readonly bodyPos: number[];
  readonly bodyNor: number[];
  readonly bodyUv: number[];
  readonly whitePos: number[];
  readonly yellowPos: number[];
  readonly signPos: number[];
  readonly signNor: number[];
  readonly physPos: number[];
  readonly pillars: PillarSpot[];
}

interface Rail {
  readonly l: number[];
  readonly r: number[];
  readonly px: number;
  readonly pz: number;
}

type SampleHash = Map<string, [number, number, number, number, number][]>;

interface EmitCtx {
  readonly buf: Buffers;
  readonly terrain: Terrain;
  readonly network: RoadNetwork | undefined;
  readonly sampleHash: SampleHash;
}

const SAMPLE_CELL = 24;

const buildSampleHash = (lines: readonly Line[]) => {
  const sampleHash: SampleHash = new Map();

  for (const [li, line] of lines.entries()) {
    for (let i = 0; i < line.pts.length; i += 1) {
      const [x, z] = line.pts[i] ?? [0, 0];
      const y = line.ys[i] ?? 0;
      const k = `${Math.floor(x / SAMPLE_CELL)},${Math.floor(z / SAMPLE_CELL)}`;
      const arr = sampleHash.get(k) ?? [];
      arr.push([x, z, y, line.half, li]);
      sampleHash.set(k, arr);
    }
  }

  return sampleHash;
};

const blocksStreet = (network: RoadNetwork | undefined, x: number, z: number, hh: number) => {
  const hit = network?.nearest(x, z, 40);

  return hit ? hit.dist < hit.edge.half + hh : false;
};

const otherDeckAt = (
  sampleHash: SampleHash,
  x: number,
  z: number,
  y: number,
  self: number,
  grow: number,
) => {
  const bx = Math.floor(x / SAMPLE_CELL);
  const bz = Math.floor(z / SAMPLE_CELL);

  for (let ix = bx - 1; ix <= bx + 1; ix += 1) {
    for (let iz = bz - 1; iz <= bz + 1; iz += 1) {
      for (const [sx, sz, sy, half, li] of sampleHash.get(`${ix},${iz}`) ?? []) {
        if (li === self) {
          continue;
        }

        if (Math.abs(sy - y) > 1.5) {
          continue;
        }

        if (Math.hypot(sx - x, sz - z) < half + grow) {
          return true;
        }
      }
    }
  }

  return false;
};

const clearanceAt = (terrain: Terrain, line: Line, i: number) => {
  const [x, z] = line.pts[i] ?? [0, 0];

  return (line.ys[i] ?? 0) - terrain.heightAt(x, z);
};

const buildRails = (line: Line) => {
  const n = line.pts.length;
  const w = line.half;
  const rails: Rail[] = [];

  for (let i = 0; i < n; i += 1) {
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
      px: -tz,
      pz: tx,
      r: [x + tz * w, y, z - tx * w],
    });
  }

  return rails;
};

const dropToSoffit = (p: readonly number[]) => [p[0] ?? 0, (p[1] ?? 0) - DECK_T, p[2] ?? 0];

const emitDeckSegment = (ctx: EmitCtx, line: Line, a: Rail, b: Rail) => {
  const { bodyNor, bodyPos, bodyUv, deckNor, deckPos, physPos } = ctx.buf;
  const w = line.half;
  pushQuad(deckPos, deckNor, a.l, b.l, b.r, a.r);
  pushQuad(physPos, null, a.l, b.l, b.r, a.r);
  const deckTop = Math.max(a.l[1] ?? 0, b.l[1] ?? 0);

  const soffitFace: ConFace = {
    kind: CON_SOFFIT,
    s: [w, w, -w, -w],
    topY: deckTop,
    uv: bodyUv,
  };

  const fasciaFace: ConFace = { kind: CON_FASCIA, topY: deckTop, uv: bodyUv };
  pushQuad(
    bodyPos,
    bodyNor,
    dropToSoffit(a.r),
    dropToSoffit(b.r),
    dropToSoffit(b.l),
    dropToSoffit(a.l),
    soffitFace,
  );
  pushQuad(bodyPos, bodyNor, a.r, b.r, dropToSoffit(b.r), dropToSoffit(a.r), fasciaFace);
  pushQuad(bodyPos, bodyNor, dropToSoffit(a.l), dropToSoffit(b.l), b.l, a.l, fasciaFace);
};

const emitPaint = (
  ctx: EmitCtx,
  line: Line,
  lineIdx: number,
  rails: readonly Rail[],
  i: number,
  segS: number,
) => {
  const { whitePos, yellowPos } = ctx.buf;
  const w = line.half;

  const at: (s: number, o: number) => [number, number, number] = (s, o) => {
    const [x, z] = line.pts[s] ?? [0, 0];
    const rl = rails[s];

    return [x + (rl?.px ?? 0) * o, (line.ys[s] ?? 0) + PAINT_LIFT, z + (rl?.pz ?? 0) * o];
  };

  const eo = w - EDGE_INSET;

  const paintSeg = (arr: number[], o: number) => {
    pushQuad(
      arr,
      null,
      at(i, o - LINE_W / 2),
      at(i + 1, o - LINE_W / 2),
      at(i + 1, o + LINE_W / 2),
      at(i, o + LINE_W / 2),
    );
  };

  for (const side of [-1, 1] as const) {
    const p0 = at(i, eo * side);
    const p1 = at(i + 1, eo * side);

    if (
      otherDeckAt(ctx.sampleHash, p0[0], p0[2], p0[1], lineIdx, -0.3) ||
      otherDeckAt(ctx.sampleHash, p1[0], p1[2], p1[1], lineIdx, -0.3)
    ) {
      continue;
    }

    paintSeg(whitePos, eo * side);
  }

  if (!line.ramp) {
    paintSeg(yellowPos, 0);
    const phase = segS % (DASH_LEN + DASH_GAP);

    if (phase < DASH_LEN) {
      for (const side of [-1, 1] as const) {
        const o = w * 0.45 * side;
        const p0 = at(i, o);

        if (otherDeckAt(ctx.sampleHash, p0[0], p0[2], p0[1], lineIdx, -0.3)) {
          continue;
        }

        paintSeg(whitePos, o);
      }
    }
  }
};

const barrierSuppressed = (
  ctx: EmitCtx,
  line: Line,
  lineIdx: number,
  i: number,
  p0: readonly number[],
  p1: readonly number[],
) => {
  if (
    otherDeckAt(ctx.sampleHash, p0[0] ?? 0, p0[2] ?? 0, p0[1] ?? 0, lineIdx, 1) ||
    otherDeckAt(ctx.sampleHash, p1[0] ?? 0, p1[2] ?? 0, p1[1] ?? 0, lineIdx, 1)
  ) {
    return true;
  }

  return (
    Math.min(clearanceAt(ctx.terrain, line, i), clearanceAt(ctx.terrain, line, i + 1)) <
      RAIL_SOLID_CLEAR &&
    (blocksStreet(ctx.network, p0[0] ?? 0, p0[2] ?? 0, 0.5) ||
      blocksStreet(ctx.network, p1[0] ?? 0, p1[2] ?? 0, 0.5))
  );
};

const emitBarriers = (
  ctx: EmitCtx,
  line: Line,
  lineIdx: number,
  rails: readonly Rail[],
  i: number,
  a: Rail,
  b: Rail,
  barrierH: number,
) => {
  const { bodyNor, bodyPos, bodyUv, physPos } = ctx.buf;

  const railIn = (k: number, side: "l" | "r") => {
    const rl = rails[k];
    const p = rl ? rl[side] : [0, 0, 0];
    const sgn = side === "l" ? -1 : 1;

    return [
      (p[0] ?? 0) + (rl?.px ?? 0) * 0.5 * sgn,
      p[1] ?? 0,
      (p[2] ?? 0) + (rl?.pz ?? 0) * 0.5 * sgn,
    ];
  };

  for (const side of ["l", "r"] as const) {
    const p0 = a[side];
    const p1 = b[side];

    if (barrierSuppressed(ctx, line, lineIdx, i, p0, p1)) {
      continue;
    }

    const q0 = railIn(i, side);
    const q1 = railIn(i + 1, side);
    const capY = Math.max(p0[1] ?? 0, p1[1] ?? 0) + barrierH;
    const railFace: ConFace = { kind: CON_BARRIER, topY: capY, uv: bodyUv };
    pushQuad(
      bodyPos,
      bodyNor,
      lift(q0, barrierH),
      lift(q1, barrierH),
      lift(p1, barrierH),
      lift(p0, barrierH),
      railFace,
    );
    pushQuad(bodyPos, bodyNor, p0, p1, lift(p1, barrierH), lift(p0, barrierH), railFace);
    pushQuad(bodyPos, bodyNor, lift(q0, barrierH), lift(q1, barrierH), q1, q0, railFace);

    const solidRail =
      !line.ramp ||
      Math.min(clearanceAt(ctx.terrain, line, i), clearanceAt(ctx.terrain, line, i + 1)) >
        RAIL_SOLID_CLEAR + DECK_T;

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
};

const emitSegments = (ctx: EmitCtx, line: Line, lineIdx: number, rails: readonly Rail[]) => {
  const n = line.pts.length;
  const total = line.cum.at(-1) ?? Infinity;
  const barrierH = line.ramp ? 0.55 : BARRIER_H;

  for (let i = 0; i + 1 < n; i += 1) {
    const a = rails[i];
    const b = rails[i + 1];

    if (!a || !b) {
      continue;
    }

    emitDeckSegment(ctx, line, a, b);
    const segS = line.cum[i] ?? Infinity;

    const nearOpen =
      (line.openStart === true && segS < 10) || (line.openEnd === true && total - segS < 10);

    emitPaint(ctx, line, lineIdx, rails, i, segS);

    if (nearOpen) {
      continue;
    }

    emitBarriers(ctx, line, lineIdx, rails, i, a, b, barrierH);
  }
};

const emitGantries = (ctx: EmitCtx, line: Line, lineIdx: number, rails: readonly Rail[]) => {
  const { bodyNor, bodyPos, bodyUv, signNor, signPos } = ctx.buf;
  const n = line.pts.length;
  const w = line.half;
  const total = line.cum.at(-1) ?? Infinity;
  let signFlip = lineIdx % 2 === 0;

  for (let s = SIGN_EVERY * 0.5; s < total - 40; s += SIGN_EVERY) {
    let i = 1;

    while (i < n - 1 && (line.cum[i] ?? 0) < s) {
      i += 1;
    }

    if (clearanceAt(ctx.terrain, line, i) < CLEAR * 0.7) {
      continue;
    }

    const rl = rails[i];

    if (!rl) {
      continue;
    }

    const dir = signFlip ? 1 : -1;
    signFlip = !signFlip;
    const [x, z] = line.pts[i] ?? [0, 0];
    const deckY = line.ys[i] ?? 0;
    const tx = rl.pz;
    const tz = -rl.px;
    const span = w + 0.55;

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
};

const pillarSpot = (
  ctx: EmitCtx,
  line: Line,
  rails: readonly Rail[],
  i: number,
  latMax: number,
  pillarH: number,
) => {
  const n = line.pts.length;
  let spot: { j: number; lat: number } | null = null;
  let median: { j: number; lat: number; d: number } | null = null;

  for (const [dj, latF] of PILLAR_OFFSETS) {
    const j = Math.min(n - 2, Math.max(1, i + dj));
    const rl = rails[j];
    const pt = line.pts[j];

    if (!rl || !pt) {
      continue;
    }

    const lat = latF * latMax;
    const cx = pt[0] + rl.px * lat;
    const cz = pt[1] + rl.pz * lat;
    const hit = ctx.network?.nearest(cx, cz, 40) ?? null;

    if (!hit || hit.dist - hit.edge.half - pillarH * Math.SQRT2 > PILLAR_CLEAR) {
      spot = { j, lat };
      break;
    }

    if (!median || hit.dist < median.d) {
      median = { d: hit.dist, j, lat };
    }
  }

  return spot ?? median;
};

const emitPillars = (ctx: EmitCtx, line: Line, rails: readonly Rail[]) => {
  const { bodyNor, bodyPos, bodyUv, physPos, pillars } = ctx.buf;
  const n = line.pts.length;
  const w = line.half;
  const pillarH = line.ramp ? 0.7 : 0.95;
  const latMax = Math.max(0, w - pillarH * 0.5);

  for (let i = PILLAR_EVERY; i < n - 1; i += PILLAR_EVERY) {
    const place = pillarSpot(ctx, line, rails, i, latMax, pillarH);
    const rl = place ? rails[place.j] : undefined;
    const pt = place ? line.pts[place.j] : undefined;

    if (!place || !rl || !pt) {
      continue;
    }

    const x = pt[0] + rl.px * place.lat;
    const z = pt[1] + rl.pz * place.lat;
    const deckY = line.ys[place.j] ?? 0;
    const topY = deckY - DECK_T;
    const botY = ctx.terrain.heightAt(x, z) - 0.6;

    if (topY - botY < 1.2) {
      continue;
    }

    const tx = rl.pz;
    const tz = -rl.px;
    pillars.push({ half: pillarH, x, z });
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
  }
};

const emitLine = (ctx: EmitCtx, line: Line, lineIdx: number) => {
  const rails = buildRails(line);
  emitSegments(ctx, line, lineIdx, rails);

  if (!line.ramp) {
    emitGantries(ctx, line, lineIdx, rails);
  }

  emitPillars(ctx, line, rails);
};

let cachedBuild: FreewayBuild | null = null;

const buildData = (terrain: Terrain, network?: RoadNetwork) => {
  if (cachedBuild) {
    return cachedBuild;
  }

  const mains = buildMainlines(terrain);
  const lines: Line[] = [...mains, ...buildRamps(terrain, network, mains)];
  coplanarizeRamps(lines);

  const buf: Buffers = {
    bodyNor: [],
    bodyPos: [],
    bodyUv: [],
    deckNor: [],
    deckPos: [],
    physPos: [],
    pillars: [],
    signNor: [],
    signPos: [],
    whitePos: [],
    yellowPos: [],
  };

  const ctx: EmitCtx = { buf, network, sampleHash: buildSampleHash(lines), terrain };

  for (let lineIdx = 0; lineIdx < lines.length; lineIdx += 1) {
    const line = lines[lineIdx];

    if (!line) {
      continue;
    }

    emitLine(ctx, line, lineIdx);
  }

  cachedBuild = {
    bodyNor: Float32Array.from(buf.bodyNor),
    bodyPos: Float32Array.from(buf.bodyPos),
    bodyUv: Float32Array.from(buf.bodyUv),
    deckNor: Float32Array.from(buf.deckNor),
    deckPos: Float32Array.from(buf.deckPos),
    lines,
    physPos: Float32Array.from(buf.physPos),
    pillars: buf.pillars,
    signNor: Float32Array.from(buf.signNor),
    signPos: Float32Array.from(buf.signPos),
    whitePos: Float32Array.from(buf.whitePos),
    yellowPos: Float32Array.from(buf.yellowPos),
  };

  return cachedBuild;
};

const rowHash = new Map<string, [number, number, number, number, number][]>();
const ROW_CELL = 60;
let rowBuilt = false;

const buildRowHash = () => {
  if (rowBuilt) {
    return;
  }

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
        cx += 1
      ) {
        for (
          let cz = Math.floor((Math.min(az, bz) - 12) / ROW_CELL);
          cz <= Math.floor((Math.max(az, bz) + 12) / ROW_CELL);
          cz += 1
        ) {
          const k = `${cx},${cz}`;
          const arr = rowHash.get(k) ?? [];
          arr.push(seg);
          rowHash.set(k, arr);
        }
      }
    }
  }
};

export const nearFreeway = (x: number, z: number, margin: number) => {
  buildRowHash();
  const segs = rowHash.get(`${Math.floor(x / ROW_CELL)},${Math.floor(z / ROW_CELL)}`);

  if (!segs) {
    return false;
  }

  for (const [ax, az, bx, bz, half] of segs) {
    const lim = half + margin;
    const dx = bx - ax;
    const dz = bz - az;
    const l2 = dx * dx + dz * dz;
    const t = l2 > 1e-8 ? Math.min(Math.max(((x - ax) * dx + (z - az) * dz) / l2, 0), 1) : 0;

    if (Math.hypot(ax + dx * t - x, az + dz * t - z) < lim) {
      return true;
    }
  }

  return false;
};

type DeckSample = readonly [
  ax: number,
  az: number,
  bx: number,
  bz: number,
  ya: number,
  yb: number,
  lim: number,
];

const soffitHash = new Map<string, DeckSample[]>();
let soffitHashFor: FreewayBuild | null = null;
const SOFFIT_CELL = 60;

const buildSoffitHash = (build: FreewayBuild) => {
  if (soffitHashFor === build) {
    return;
  }

  soffitHashFor = build;
  soffitHash.clear();

  for (const line of build.lines) {
    const { pts } = line;

    for (let i = 0; i + 1 < pts.length; i += 1) {
      const [ax, az] = pts[i] ?? [0, 0];
      const [bx, bz] = pts[i + 1] ?? [0, 0];
      const s: DeckSample = [ax, az, bx, bz, line.ys[i] ?? 0, line.ys[i + 1] ?? 0, line.half + 1];

      for (
        let cx = Math.floor((Math.min(ax, bx) - 12) / SOFFIT_CELL);
        cx <= Math.floor((Math.max(ax, bx) + 12) / SOFFIT_CELL);
        cx += 1
      ) {
        for (
          let cz = Math.floor((Math.min(az, bz) - 12) / SOFFIT_CELL);
          cz <= Math.floor((Math.max(az, bz) + 12) / SOFFIT_CELL);
          cz += 1
        ) {
          const k = `${cx},${cz}`;
          const arr = soffitHash.get(k) ?? [];
          arr.push(s);
          soffitHash.set(k, arr);
        }
      }
    }
  }
};

/**
 * Height of the deck UNDERSIDE over a point, or null when no deck covers it
 * (within `half + margin` of a centreline, margin at most 1). The lowest
 * covering deck wins, which is what a building's roof has to clear. Ramps
 * descend to grade, so a parcel under a ramp mouth gets a soffit at ground
 * level and nothing fits — the right answer, since that is where the ramp
 * lands.
 */
export const freewaySoffitAt = (
  terrain: Terrain,
  network: RoadNetwork | undefined,
  x: number,
  z: number,
  margin: number,
) => {
  buildSoffitHash(buildData(terrain, network));
  const segs = soffitHash.get(`${Math.floor(x / SOFFIT_CELL)},${Math.floor(z / SOFFIT_CELL)}`);

  if (!segs) {
    return null;
  }

  let soffit: number | null = null;

  for (const [ax, az, bx, bz, ya, yb, lim0] of segs) {
    const lim = lim0 - 1 + Math.min(margin, 1);
    const dx = bx - ax;
    const dz = bz - az;
    const l2 = dx * dx + dz * dz;
    const t = l2 > 1e-8 ? Math.min(Math.max(((x - ax) * dx + (z - az) * dz) / l2, 0), 1) : 0;

    if (Math.hypot(ax + dx * t - x, az + dz * t - z) >= lim) {
      continue;
    }

    const y = ya + (yb - ya) * t - DECK_T;

    if (soffit === null || y < soffit) {
      soffit = y;
    }
  }

  return soffit;
};

const contactHash = new Map<string, number[]>();
let contactHashFor: FreewayBuild | null = null;

const indexFreewayContacts = (build: FreewayBuild) => {
  const positions = build.deckPos;

  if (contactHashFor !== build) {
    contactHashFor = build;
    contactHash.clear();

    for (let i = 0; i + 8 < positions.length; i += 9) {
      const ax = positions[i] ?? 0;
      const az = positions[i + 2] ?? 0;
      const bx = positions[i + 3] ?? 0;
      const bz = positions[i + 5] ?? 0;
      const cx = positions[i + 6] ?? 0;
      const cz = positions[i + 8] ?? 0;

      for (
        let gx = Math.floor(Math.min(ax, bx, cx) / SOFFIT_CELL);
        gx <= Math.floor(Math.max(ax, bx, cx) / SOFFIT_CELL);
        gx += 1
      ) {
        for (
          let gz = Math.floor(Math.min(az, bz, cz) / SOFFIT_CELL);
          gz <= Math.floor(Math.max(az, bz, cz) / SOFFIT_CELL);
          gz += 1
        ) {
          const key = `${gx},${gz}`;
          const bucket = contactHash.get(key) ?? [];
          bucket.push(i);
          contactHash.set(key, bucket);
        }
      }
    }
  }
};

/** Wheel material follows the exact rendered/physical top triangles, including
 * curved ramps and stacked spans. An underpass contact keeps its ground type. */
export const isFreewayDeckContact = (
  terrain: Terrain,
  network: RoadNetwork | undefined,
  x: number,
  z: number,
  y: number,
) => {
  const build = buildData(terrain, network);
  indexFreewayContacts(build);
  const positions = build.deckPos;

  const candidates = contactHash.get(
    `${Math.floor(x / SOFFIT_CELL)},${Math.floor(z / SOFFIT_CELL)}`,
  );

  if (!candidates) {
    return false;
  }

  for (const i of candidates) {
    const ax = positions[i] ?? 0;
    const az = positions[i + 2] ?? 0;
    const dx1 = (positions[i + 3] ?? 0) - ax;
    const dz1 = (positions[i + 5] ?? 0) - az;
    const dx2 = (positions[i + 6] ?? 0) - ax;
    const dz2 = (positions[i + 8] ?? 0) - az;
    const determinant = dx1 * dz2 - dx2 * dz1;

    if (Math.abs(determinant) < 1e-8) {
      continue;
    }

    const u = ((x - ax) * dz2 - (z - az) * dx2) / determinant;
    const v = (dx1 * (z - az) - dz1 * (x - ax)) / determinant;

    if (u < -1e-6 || v < -1e-6 || u + v > 1.000001) {
      continue;
    }

    const ay = positions[i + 1] ?? 0;
    const height = ay + u * ((positions[i + 4] ?? 0) - ay) + v * ((positions[i + 7] ?? 0) - ay);

    if (Math.abs(y - height) <= 0.4) {
      return true;
    }
  }

  return false;
};

/** Pillar footprints of the memoized build — `pnpm test` asserts none sit in a street. */
export const freewayPillars = (terrain: Terrain, network?: RoadNetwork) =>
  buildData(terrain, network).pillars;

export const freewayPhysics = (terrain: Terrain, network?: RoadNetwork) => {
  const build = buildData(terrain, network);
  indexFreewayContacts(build);

  return build.physPos;
};

const geoFrom = (pos: Float32Array, nor: Float32Array | null, uv?: Float32Array) => {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));

  if (nor) {
    geo.setAttribute("normal", new THREE.BufferAttribute(nor, 3));
  } else {
    const up = new Float32Array(pos.length);

    for (let i = 1; i < up.length; i += 3) {
      up[i] = 1;
    }

    geo.setAttribute("normal", new THREE.BufferAttribute(up, 3));
  }

  const n = (pos.length / 3) * 2;
  const src = uv && uv.length === n ? uv : new Float32Array(n);
  geo.setAttribute("uv", new THREE.BufferAttribute(src, 2));

  return geo;
};

export const buildFreeways = (terrain: Terrain, network?: RoadNetwork) => {
  const data = buildData(terrain, network);
  const group = new THREE.Group();
  const deckMesh = new THREE.Mesh(geoFrom(data.deckPos, data.deckNor), MAT_DECK);
  const bodyMesh = new THREE.Mesh(geoFrom(data.bodyPos, data.bodyNor, data.bodyUv), MAT_CONCRETE);
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
};
