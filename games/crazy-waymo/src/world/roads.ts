import * as THREE from "three";
import polygonClipping from "polygon-clipping";

import { ROAD_TILE, ROAD_Y } from "../shared/constants";
import { conformToTerrain } from "./conform";
import type { NetEdge, RoadNetwork } from "./network";
import type { Terrain } from "./terrain";

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
export const SIDEWALK_W = 2.0;
export const LANE_CENTER = ASPHALT_W * 0.19; // default lane offset for traffic
const CURB_W = 0.7;
const ASPHALT_LIFT = ROAD_Y + 0.05;
const SIDEWALK_LIFT = ROAD_Y + 0.13;
const CURB_LIFT = SIDEWALK_LIFT + 0.03; // curb lip reads above the walk
const LINE_LIFT = ASPHALT_LIFT + 0.1;
const LINE_W = 0.24;
const EDGE_INSET = 0.5;
const DASH_LEN = 2.2;
const DASH_GAP = 2.6;
const MITER_LIMIT = 2.5; // clamp spike joints on hairpin polylines

// Materials by stable key — the worker ships buffers tagged with these keys
// and the main thread looks the material back up.
export const ROAD_MATERIALS: Record<string, THREE.Material> = {};

const MAT_ASPHALT = new THREE.MeshStandardMaterial({ color: 0x3d4049, roughness: 1 });
ROAD_MATERIALS.asphalt = MAT_ASPHALT;
const MAT_SIDEWALK = new THREE.MeshStandardMaterial({ color: 0xc9cdc9, roughness: 1 });
ROAD_MATERIALS.walk = MAT_SIDEWALK;
const MAT_CURB = new THREE.MeshStandardMaterial({ color: 0xd4d8da, roughness: 1 });
ROAD_MATERIALS.curb = MAT_CURB;
// Markings are decals: polygon-offset wins the depth test against the
// asphalt even where the two drapes sample the terrain differently — no
// physical lift can guarantee that on curved ground.
const MAT_DASH = new THREE.MeshStandardMaterial({
  color: 0xd8a23c,
  roughness: 0.9,
  polygonOffset: true,
  polygonOffsetFactor: -2,
  polygonOffsetUnits: -4,
});
ROAD_MATERIALS.dash = MAT_DASH;
const MAT_YELLOW = new THREE.MeshStandardMaterial({
  color: 0xd8a13c,
  roughness: 0.9,
  polygonOffset: true,
  polygonOffsetFactor: -2,
  polygonOffsetUnits: -4,
});
ROAD_MATERIALS.yellow = MAT_YELLOW;
const MAT_WHITE = new THREE.MeshStandardMaterial({
  color: 0xdfe3e3,
  roughness: 0.9,
  polygonOffset: true,
  polygonOffsetFactor: -2,
  polygonOffsetUnits: -4,
});
ROAD_MATERIALS.white = MAT_WHITE;

type Part = { geo: THREE.BufferGeometry; mat: THREE.Material; lift: number };

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
  ax: number, az: number, adx: number, adz: number,
  bx: number, bz: number, bdx: number, bdz: number,
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
};

// Junction polygon at a lateral grow of `extra` beyond each arm's asphalt.
function patchRing(nx: number, nz: number, arms: Arm[], extra: number, trimCap: number): Ring {
  const ring: Ring = [];
  for (let i = 0; i < arms.length; i++) {
    const a = arms[i];
    const b = arms[(i + 1) % arms.length];
    if (!a || !b) continue;
    const ha = a.half + extra;
    const hb = b.half + extra;
    ring.push([snap(a.px + a.tz * ha), snap(a.pz - a.tx * ha)]); // a minus side
    ring.push([snap(a.px - a.tz * ha), snap(a.pz + a.tx * ha)]); // a plus side
    const corner = lineIntersect(
      a.px - a.tz * ha, a.pz + a.tx * ha, -a.tx, -a.tz,
      b.px + b.tz * hb, b.pz - b.tx * hb, -b.tx, -b.tz,
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
      const rect: Poly = [[
        [snap(x0), snap(z0)],
        [snap(x1), snap(z0)],
        [snap(x1), snap(z1)],
        [snap(x0), snap(z1)],
      ]];
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

export function buildRoadParts(network: RoadNetwork, terrain: Terrain): RoadPartBuffers[] {
  const asphaltPolys: Poly[] = [];
  const curbPolys: Poly[] = [];
  const pavePolys: Poly[] = [];
  const markingParts: Part[] = [];

  // Node lookup for clipping markings out of junction areas.
  const nodeBuckets = new Map<string, number[]>();
  const NB = 40;
  for (let n = 0; n < network.nodes.length; n++) {
    if ((network.nodeEdges[n]?.length ?? 0) === 0) continue;
    const node = network.nodes[n];
    if (!node) continue;
    const k = `${Math.floor(node[0] / NB)},${Math.floor(node[1] / NB)}`;
    const arr = nodeBuckets.get(k) ?? [];
    arr.push(n);
    nodeBuckets.set(k, arr);
  }
  const nearJunction = (x: number, z: number, margin: number): boolean => {
    const bx = Math.floor(x / NB);
    const bz = Math.floor(z / NB);
    for (let ix = bx - 1; ix <= bx + 1; ix++) {
      for (let iz = bz - 1; iz <= bz + 1; iz++) {
        for (const n of nodeBuckets.get(`${ix},${iz}`) ?? []) {
          const node = network.nodes[n];
          if (!node) continue;
          if (Math.hypot(node[0] - x, node[1] - z) < network.nodeTrim(n) + margin) return true;
        }
      }
    }
    return false;
  };

  // --- Edge sweeps as polygons + markings ---
  for (const edge of network.edges) {
    const trimA = Math.min(network.nodeTrim(edge.a), edge.len * 0.45);
    const trimB = Math.min(network.nodeTrim(edge.b), edge.len * 0.45);
    const rail = railFor(edge, trimA, edge.len - trimB);
    if (!rail) continue;
    const h = edge.half;
    asphaltPolys.push([railRing(rail, -h, h)]);
    curbPolys.push([railRing(rail, -h - CURB_W, h + CURB_W)]);
    pavePolys.push([railRing(rail, -h - SIDEWALK_W, h + SIDEWALK_W)]);

    // KayKit-style paint: boulevards get YELLOW edge lines + white dashed
    // lane lines; streets get white edges + a yellow centre dash.
    const major = h > 5.5;
    const eo = h - EDGE_INSET;
    const edgeMat = major ? MAT_YELLOW : MAT_WHITE;
    markingParts.push({ geo: stripGeo(rail, eo - LINE_W / 2, eo + LINE_W / 2), mat: edgeMat, lift: LINE_LIFT });
    markingParts.push({ geo: stripGeo(rail, -eo - LINE_W / 2, -eo + LINE_W / 2), mat: edgeMat, lift: LINE_LIFT });

    // Dashes (junction-clipped so they never float through a merged blob):
    // boulevards carry two white lane lines, streets one yellow centre line.
    const secLen = edge.len - trimA - trimB;
    if (secLen < 12) continue;
    const dashOffsets: { off: number; mat: THREE.Material }[] = major
      ? [
          { off: -h * 0.33, mat: MAT_WHITE },
          { off: h * 0.33, mat: MAT_WHITE },
        ]
      : [{ off: 0, mat: MAT_YELLOW }];
    for (let s = 0; s < secLen; s += DASH_LEN + DASH_GAP) {
      const e = Math.min(s + DASH_LEN, secLen);
      if (e - s < 0.6) continue;
      const midS = trimA + (s + e) / 2;
      const mid = network.sample(edge, midS);
      if (nearJunction(mid.x, mid.z, 2.5)) continue;
      const dashRail = railFor(edge, trimA + s, trimA + e);
      if (dashRail) {
        for (const d of dashOffsets) {
          markingParts.push({
            geo: stripGeo(dashRail, d.off - LINE_W / 2, d.off + LINE_W / 2),
            mat: d.mat === MAT_YELLOW ? MAT_DASH : d.mat,
            lift: LINE_LIFT,
          });
        }
      }
    }
  }

  let crosswalkArms = 0;
  // --- Junction patches + crosswalks + dead-end caps ---
  for (let n = 0; n < network.nodes.length; n++) {
    const ids = network.nodeEdges[n];
    if (!ids || ids.length === 0) continue;
    const node = network.nodes[n];
    if (!node) continue;
    const nx = node[0];
    const nz = node[1];

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
        });
      }
    }
    if (arms.length === 0) continue;
    arms.sort((u, v) => u.angle - v.angle);

    if (arms.length === 1) {
      const a = arms[0];
      if (a) {
        asphaltPolys.push([capRing(a, 0)]);
        curbPolys.push([capRing(a, CURB_W)]);
        pavePolys.push([capRing(a, SIDEWALK_W)]);
      }
      continue;
    }

    const trimCap = network.nodeTrim(n) * 1.8;
    asphaltPolys.push([patchRing(nx, nz, arms, 0, trimCap)]);
    curbPolys.push([patchRing(nx, nz, arms, CURB_W, trimCap)]);
    pavePolys.push([patchRing(nx, nz, arms, SIDEWALK_W, trimCap)]);

    // Zebra crosswalks + stop bars only on CLEAN intersections (3-4 arms):
    // complex multi-arm nodes turn into a tangle of overlapping paint — the
    // real-world cue there is plain open asphalt anyway.
    if (arms.length >= 3 && arms.length <= 4) {
      for (const a of arms) {
        const ox = -a.tz;
        const oz = a.tx;
        const quad = (
          out: number[],
          d0: number,
          d1: number,
          l0: number,
          l1: number,
        ): void => {
          // Emit in ~1.2u slices on both axes so the drape follows terrain
          // curvature as closely as the asphalt underneath does.
          const dSlices = Math.max(1, Math.ceil((d1 - d0) / 1.2));
          const lSlices = Math.max(1, Math.ceil((l1 - l0) / 1.2));
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
              out.push(x00, 0, z00, x11, 0, z11, x10, 0, z10, x00, 0, z00, x01, 0, z01, x11, 0, z11);
            }
          }
        };
        // Chunky zebra (stripes run with the road, laid across the width).
        const stripes: number[] = [];
        const inner = 0.9;
        const outer = inner + 2.6;
        const usable = a.half - 0.8;
        const count = Math.max(4, Math.floor(usable / 0.95));
        for (let k = 0; k < count; k++) {
          const lat = -usable + (k / (count - 1)) * 2 * usable;
          quad(stripes, inner, outer, lat - 0.34, lat + 0.34);
        }
        crosswalkArms++;
        markingParts.push({ geo: flatGeo(stripes), mat: MAT_WHITE, lift: LINE_LIFT });
        // Stop bar just past the crosswalk: solid on boulevards, dashed on
        // streets (the KayKit look).
        const bar: number[] = [];
        const b0 = outer + 0.5;
        const b1 = b0 + 0.5;
        if (a.half > 5.5) {
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

  const parts: Part[] = [
    { geo: multiPolyGeo(asphalt), mat: MAT_ASPHALT, lift: ASPHALT_LIFT },
    { geo: multiPolyGeo(walk), mat: MAT_SIDEWALK, lift: SIDEWALK_LIFT },
    { geo: multiPolyGeo(curb), mat: MAT_CURB, lift: CURB_LIFT },
    ...markingParts,
  ];

  const keyOfMat = new Map<THREE.Material, string>(
    Object.entries(ROAD_MATERIALS).map(([k, m]) => [m, k]),
  );
  const out: RoadPartBuffers[] = [];
  for (const p of parts) {
    const draped = conformToTerrain(p.geo, terrain, p.lift);
    const pos = draped.getAttribute("position");
    const nor = draped.getAttribute("normal");
    const uv = draped.getAttribute("uv");
    const idx = draped.index;
    out.push({
      matKey: keyOfMat.get(p.mat) ?? "asphalt",
      position: pos.array as Float32Array,
      normal: nor.array as Float32Array,
      uv: uv ? (uv.array as Float32Array) : null,
      index: idx ? (idx.array as Uint16Array | Uint32Array) : null,
    });
  }
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
    out.push(new THREE.Mesh(geo, ROAD_MATERIALS[p.matKey] ?? ROAD_MATERIALS.asphalt));
  }
  return out;
}

export function buildRoads(network: RoadNetwork, terrain: Terrain): THREE.Mesh[] {
  return roadPartsToMeshes(buildRoadParts(network, terrain));
}
