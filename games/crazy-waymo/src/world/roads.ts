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
export const SIDEWALK_W = 1.7;
export const LANE_CENTER = ASPHALT_W * 0.19; // default lane offset for traffic
const CURB_W = 0.38;
const ASPHALT_LIFT = ROAD_Y + 0.05;
const SIDEWALK_LIFT = ROAD_Y + 0.13;
const CURB_LIFT = SIDEWALK_LIFT + 0.03; // curb lip reads above the walk
const LINE_LIFT = ASPHALT_LIFT + 0.07;
const LINE_W = 0.24;
const EDGE_INSET = 0.5;
const DASH_LEN = 2.2;
const DASH_GAP = 2.6;
const MITER_LIMIT = 2.5; // clamp spike joints on hairpin polylines

const MAT_ASPHALT = new THREE.MeshStandardMaterial({ color: 0x40454c, roughness: 1 });
const MAT_SIDEWALK = new THREE.MeshStandardMaterial({ color: 0xb6b9b0, roughness: 1 });
const MAT_CURB = new THREE.MeshStandardMaterial({ color: 0x8f938c, roughness: 1 });
const MAT_YELLOW = new THREE.MeshStandardMaterial({ color: 0xd8a13c, roughness: 0.9 });
const MAT_WHITE = new THREE.MeshStandardMaterial({ color: 0xdfe3e3, roughness: 0.9 });

type Part = { geo: THREE.BufferGeometry; mat: THREE.Material; lift: number };

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

// Closed ring covering the strip between two lateral offsets of a rail.
function railRing(rail: Rail, off0: number, off1: number): Ring {
  const m = rail.pts.length / 2;
  const ring: Ring = [];
  for (let i = 0; i < m; i++) {
    ring.push([
      snap((rail.pts[i * 2] ?? 0) + (rail.normals[i * 2] ?? 0) * off1),
      snap((rail.pts[i * 2 + 1] ?? 0) + (rail.normals[i * 2 + 1] ?? 0) * off1),
    ]);
  }
  for (let i = m - 1; i >= 0; i--) {
    ring.push([
      snap((rail.pts[i * 2] ?? 0) + (rail.normals[i * 2] ?? 0) * off0),
      snap((rail.pts[i * 2 + 1] ?? 0) + (rail.normals[i * 2 + 1] ?? 0) * off0),
    ]);
  }
  return ring;
}

// Quad strip geometry between two offsets (markings only — no booleans).
function stripGeo(rail: Rail, off0: number, off1: number): THREE.BufferGeometry {
  const m = rail.pts.length / 2;
  const pos: number[] = [];
  for (let i = 0; i + 1 < m; i++) {
    const corner = (j: number, off: number): readonly [number, number] => [
      (rail.pts[j * 2] ?? 0) + (rail.normals[j * 2] ?? 0) * off,
      (rail.pts[j * 2 + 1] ?? 0) + (rail.normals[j * 2 + 1] ?? 0) * off,
    ];
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

// Union a large set of polygons in chunks (single mega-call risks precision
// blowups in the sweep; chunked tree-union isolates any failure).
function treeUnion(polys: Poly[]): MultiPoly {
  const CHUNK = 256;
  let acc: MultiPoly = [];
  for (let i = 0; i < polys.length; i += CHUNK) {
    const chunk = polys.slice(i, i + CHUNK);
    try {
      const merged = polygonClipping.union(
        acc.length > 0 ? acc : [],
        ...chunk,
      );
      acc = merged;
    } catch {
      // A degenerate ring in this chunk: fall back to one-by-one, skipping
      // only the offender(s).
      for (const p of chunk) {
        try {
          acc = polygonClipping.union(acc.length > 0 ? acc : [], p);
        } catch {
          // skip the degenerate polygon
        }
      }
    }
  }
  return acc;
}

// Difference computed per spatial tile: the sweepline occasionally corrupts
// on city-sized inputs; tiling keeps every operation small and isolates any
// failure to one tile (where we drop the walk rather than cover the road).
function tiledDifference(a: MultiPoly, b: MultiPoly, minX: number, minZ: number, maxX: number, maxZ: number): MultiPoly {
  const TILES = 10;
  const out: MultiPoly = [];
  const dx = (maxX - minX) / TILES;
  const dz = (maxZ - minZ) / TILES;
  let failed = 0;
  for (let ix = 0; ix < TILES; ix++) {
    for (let iz = 0; iz < TILES; iz++) {
      const x0 = minX + ix * dx;
      const z0 = minZ + iz * dz;
      const rect: Poly = [[
        [snap(x0), snap(z0)],
        [snap(x0 + dx), snap(z0)],
        [snap(x0 + dx), snap(z0 + dz)],
        [snap(x0), snap(z0 + dz)],
      ]];
      try {
        const at = polygonClipping.intersection(a, [rect]);
        if (at.length === 0) continue;
        const bt = polygonClipping.intersection(b, [rect]);
        out.push(...polygonClipping.difference(at, bt));
      } catch {
        failed++;
      }
    }
  }
  if (failed > 0) console.warn(`[roads] tiled difference: ${failed} tiles dropped`);
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

export function buildRoads(network: RoadNetwork, terrain: Terrain): THREE.Mesh[] {
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

    // White edge lines (inside the asphalt — safe by construction).
    const eo = h - EDGE_INSET;
    markingParts.push({ geo: stripGeo(rail, eo - LINE_W / 2, eo + LINE_W / 2), mat: MAT_WHITE, lift: LINE_LIFT });
    markingParts.push({ geo: stripGeo(rail, -eo - LINE_W / 2, -eo + LINE_W / 2), mat: MAT_WHITE, lift: LINE_LIFT });

    // Centre dashes, skipped near ANY junction so they never float through
    // a merged junction blob.
    const secLen = edge.len - trimA - trimB;
    if (secLen < 12) continue;
    for (let s = 0; s < secLen; s += DASH_LEN + DASH_GAP) {
      const e = Math.min(s + DASH_LEN, secLen);
      if (e - s < 0.6) continue;
      const midS = trimA + (s + e) / 2;
      const mid = network.sample(edge, midS);
      if (nearJunction(mid.x, mid.z, 2.5)) continue;
      const dashRail = railFor(edge, trimA + s, trimA + e);
      if (dashRail) {
        markingParts.push({ geo: stripGeo(dashRail, -LINE_W / 2, LINE_W / 2), mat: MAT_YELLOW, lift: LINE_LIFT });
      }
    }
  }

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

    // Crosswalk stripes across each arm of a real junction (3+ streets).
    if (arms.length >= 3) {
      for (const a of arms) {
        const stripes: number[] = [];
        const inner = 0.7;
        const outer = 2.5;
        const usable = a.half - 0.9;
        const count = Math.max(3, Math.floor(usable / 0.85));
        for (let k = 0; k < count; k++) {
          const lat = -usable + (k / (count - 1)) * 2 * usable;
          const w = 0.42;
          const cx0 = a.px + a.tx * inner;
          const cz0 = a.pz + a.tz * inner;
          const cx1 = a.px + a.tx * outer;
          const cz1 = a.pz + a.tz * outer;
          const ox = -a.tz;
          const oz = a.tx;
          stripes.push(
            cx0 + ox * (lat - w), 0, cz0 + oz * (lat - w),
            cx1 + ox * (lat - w), 0, cz1 + oz * (lat - w),
            cx1 + ox * (lat + w), 0, cz1 + oz * (lat + w),
            cx0 + ox * (lat - w), 0, cz0 + oz * (lat - w),
            cx1 + ox * (lat + w), 0, cz1 + oz * (lat + w),
            cx0 + ox * (lat + w), 0, cz0 + oz * (lat + w),
          );
        }
        markingParts.push({ geo: flatGeo(stripes), mat: MAT_WHITE, lift: LINE_LIFT });
      }
    }
  }

  // --- The planar map: overlap dissolves in the union ---
  const asphalt = treeUnion(asphaltPolys);
  let minX = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxZ = -Infinity;
  for (const poly of asphalt) {
    for (const [x, z] of poly[0] ?? []) {
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minZ = Math.min(minZ, z);
      maxZ = Math.max(maxZ, z);
    }
  }
  const curb = tiledDifference(treeUnion(curbPolys), asphalt, minX, minZ, maxX, maxZ);
  const walk = tiledDifference(treeUnion(pavePolys), asphalt, minX, minZ, maxX, maxZ);

  const parts: Part[] = [
    { geo: multiPolyGeo(asphalt), mat: MAT_ASPHALT, lift: ASPHALT_LIFT },
    { geo: multiPolyGeo(walk), mat: MAT_SIDEWALK, lift: SIDEWALK_LIFT },
    { geo: multiPolyGeo(curb), mat: MAT_CURB, lift: CURB_LIFT },
    ...markingParts,
  ];

  const out: THREE.Mesh[] = [];
  for (const p of parts) {
    const draped = conformToTerrain(p.geo, terrain, p.lift);
    out.push(new THREE.Mesh(draped, p.mat));
  }
  return out;
}
