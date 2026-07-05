import * as THREE from "three";

import { ROAD_TILE, ROAD_Y } from "../shared/constants";
import { conformToTerrain } from "./conform";
import type { NetEdge, RoadNetwork } from "./network";
import type { Terrain } from "./terrain";

// Vector-first street geometry: every edge of the road NETWORK is swept as a
// mitered strip (asphalt, sidewalks, curb tops, markings) along its true
// polyline, and every junction node gets an asphalt disc that the incident
// strips butt into. Diagonals, curves and freeway ramps render exactly as the
// map data describes them — there is no tile grid in this path at all.

// Street profile shared with furniture/traffic (offsets measured from the
// edge centreline; per-edge asphalt half-width comes from the road class).
export const ASPHALT_W = ROAD_TILE * 0.8; // legacy uniform width (tertiary)
export const SIDEWALK_W = 1.3;
export const LANE_CENTER = ASPHALT_W * 0.19; // default lane offset for traffic
const CURB_W = 0.28;
const ASPHALT_LIFT = ROAD_Y + 0.05;
const SIDEWALK_LIFT = ROAD_Y + 0.13;
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

// A polyline resampled to the working section [s0, s1] with per-vertex
// mitered offset normals — the core sweep primitive.
type Rail = { pts: number[]; normals: number[] }; // flat [x,z] pairs

function railFor(edge: NetEdge, s0: number, s1: number): Rail | null {
  if (s1 - s0 < 0.6) return null;
  const pts: number[] = [];
  // Collect the clipped polyline: entry point, interior vertices, exit point.
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

  // Mitered per-vertex normals (perpendicular, averaged at joints).
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
    // Perpendicular of the averaged direction; miter scale from the angle.
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

// Quad strip between two lateral offsets of a rail (CCW from above).
function stripGeo(rail: Rail, off0: number, off1: number): THREE.BufferGeometry {
  const m = rail.pts.length / 2;
  const pos: number[] = [];
  const uv: number[] = [];
  for (let i = 0; i + 1 < m; i++) {
    const corner = (j: number, off: number): readonly [number, number] => [
      (rail.pts[j * 2] ?? 0) + (rail.normals[j * 2] ?? 0) * off,
      (rail.pts[j * 2 + 1] ?? 0) + (rail.normals[j * 2 + 1] ?? 0) * off,
    ];
    const [ax, az] = corner(i, off0);
    const [bx, bz] = corner(i, off1);
    const [cx, cz] = corner(i + 1, off1);
    const [dx2, dz2] = corner(i + 1, off0);
    // Winding for +Y normal: (a, b, c) + (a, c, d).
    pos.push(ax, 0, az, bx, 0, bz, cx, 0, cz, ax, 0, az, cx, 0, cz, dx2, 0, dz2);
    uv.push(0, 0, 0, 1, 1, 1, 0, 0, 1, 1, 1, 0);
  }
  const geo = new THREE.BufferGeometry();
  const nor = new Float32Array(pos.length);
  for (let i = 1; i < nor.length; i += 3) nor[i] = 1;
  geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(pos), 3));
  geo.setAttribute("normal", new THREE.BufferAttribute(nor, 3));
  geo.setAttribute("uv", new THREE.BufferAttribute(new Float32Array(uv), 2));
  return geo;
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

// Fan triangulation of a boundary polyline around a centre (CCW from above).
function fanGeo(cx: number, cz: number, boundary: number[]): THREE.BufferGeometry {
  const pos: number[] = [];
  const m = boundary.length / 2;
  for (let i = 0; i < m; i++) {
    const j = (i + 1) % m;
    const ax = boundary[i * 2] ?? 0;
    const az = boundary[i * 2 + 1] ?? 0;
    const bx = boundary[j * 2] ?? 0;
    const bz = boundary[j * 2 + 1] ?? 0;
    // Winding for +Y: centre, b, a (boundary runs CCW).
    pos.push(cx, 0, cz, bx, 0, bz, ax, 0, az);
  }
  return flatGeo(pos);
}

// Strip along a polyline, extruded AWAY from an anchor point by `w`.
function bandGeo(ax0: number, az0: number, line: [number, number][], w: number): THREE.BufferGeometry {
  const pos: number[] = [];
  const outer: [number, number][] = line.map(([x, z]) => {
    const dx = x - ax0;
    const dz = z - az0;
    const d = Math.hypot(dx, dz) || 1;
    return [x + (dx / d) * w, z + (dz / d) * w];
  });
  for (let i = 0; i + 1 < line.length; i++) {
    const a = line[i];
    const b = line[i + 1];
    const oa = outer[i];
    const ob = outer[i + 1];
    if (!a || !b || !oa || !ob) continue;
    pos.push(a[0], 0, a[1], b[0], 0, b[1], ob[0], 0, ob[1]);
    pos.push(a[0], 0, a[1], ob[0], 0, ob[1], oa[0], 0, oa[1]);
  }
  return flatGeo(pos);
}

// Dead-end cap: half-disc past the trim point (optionally grown by `extra`).
function capGeo(arm: { tx: number; tz: number; half: number; px: number; pz: number }, extra: number): THREE.BufferGeometry {
  const r = arm.half + extra;
  const base = Math.atan2(arm.tx, -arm.tz); // start on the "-" kerb side
  const pos: number[] = [];
  const SEGS = 10;
  for (let i = 0; i < SEGS; i++) {
    const a0 = base + (i / SEGS) * Math.PI;
    const a1 = base + ((i + 1) / SEGS) * Math.PI;
    pos.push(
      arm.px, 0, arm.pz,
      arm.px + Math.cos(a1) * r, 0, arm.pz + Math.sin(a1) * r,
      arm.px + Math.cos(a0) * r, 0, arm.pz + Math.sin(a0) * r,
    );
  }
  return flatGeo(pos);
}

// Intersection of two rays (p + t*d); null when near-parallel.
function lineIntersect(
  ax: number, az: number, adx: number, adz: number,
  bx: number, bz: number, bdx: number, bdz: number,
): [number, number] | null {
  const den = adx * bdz - adz * bdx;
  if (Math.abs(den) < 1e-4) return null;
  const t = ((bx - ax) * bdz - (bz - az) * bdx) / den;
  return [ax + adx * t, az + adz * t];
}

export function buildRoads(network: RoadNetwork, terrain: Terrain): THREE.Mesh[] {
  const parts: Part[] = [];

  for (const edge of network.edges) {
    const trimA = Math.min(network.nodeTrim(edge.a), edge.len * 0.45);
    const trimB = Math.min(network.nodeTrim(edge.b), edge.len * 0.45);
    const rail = railFor(edge, trimA, edge.len - trimB);
    if (!rail) continue;
    const h = edge.half;

    // Asphalt ribbon.
    parts.push({ geo: stripGeo(rail, -h, h), mat: MAT_ASPHALT, lift: ASPHALT_LIFT });
    // Sidewalks + kerb tops both sides; junction patches close the corners.
    parts.push({ geo: stripGeo(rail, h, h + SIDEWALK_W), mat: MAT_SIDEWALK, lift: SIDEWALK_LIFT });
    parts.push({ geo: stripGeo(rail, -h - SIDEWALK_W, -h), mat: MAT_SIDEWALK, lift: SIDEWALK_LIFT });
    parts.push({ geo: stripGeo(rail, h - CURB_W, h), mat: MAT_CURB, lift: SIDEWALK_LIFT - 0.02 });
    parts.push({ geo: stripGeo(rail, -h, -h + CURB_W), mat: MAT_CURB, lift: SIDEWALK_LIFT - 0.02 });
    const eo = h - EDGE_INSET;
    parts.push({ geo: stripGeo(rail, eo - LINE_W / 2, eo + LINE_W / 2), mat: MAT_WHITE, lift: LINE_LIFT });
    parts.push({ geo: stripGeo(rail, -eo - LINE_W / 2, -eo + LINE_W / 2), mat: MAT_WHITE, lift: LINE_LIFT });

    // Yellow centre dashes by arclength along the trimmed section. Sliver
    // sections between near-coincident junctions get no markings at all —
    // stray dashes inside overlapping discs read as debris.
    const secLen = edge.len - trimA - trimB;
    if (secLen < 12) continue;
    for (let s = 0; s < secLen; s += DASH_LEN + DASH_GAP) {
      const e = Math.min(s + DASH_LEN, secLen);
      if (e - s < 0.6) continue;
      const dashRail = railFor(edge, trimA + s, trimA + e);
      if (dashRail) {
        parts.push({ geo: stripGeo(dashRail, -LINE_W / 2, LINE_W / 2), mat: MAT_YELLOW, lift: LINE_LIFT });
      }
    }
  }

  // Junction discs — sized to the widest incident edge; strips butt into them.
  // Junction patches — real intersection geometry. For every node, take each
  // incident edge at its trim point ("arm"), sort arms by angle, and close the
  // asphalt polygon with kerb-corner points where adjacent arms' kerb lines
  // intersect. Sidewalk bands wrap the corners so the kerb line is continuous
  // from street to street — corners belong to the streets that meet there.
  for (let n = 0; n < network.nodes.length; n++) {
    const ids = network.nodeEdges[n];
    if (!ids || ids.length === 0) continue;
    const node = network.nodes[n];
    if (!node) continue;
    const nx = node[0];
    const nz = node[1];

    type Arm = {
      angle: number;
      tx: number; // outward tangent (away from the node)
      tz: number;
      half: number;
      px: number; // centreline trim point
      pz: number;
    };
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
        const tx = smp.tx * sign;
        const tz = smp.tz * sign;
        arms.push({ angle: Math.atan2(tz, tx), tx, tz, half: edge.half, px: smp.x, pz: smp.z });
      }
    }
    if (arms.length === 0) continue;
    arms.sort((u, v) => u.angle - v.angle);

    if (arms.length === 1) {
      // Dead end: half-disc cap beyond the trim point.
      const a = arms[0];
      if (a) {
        parts.push({ geo: capGeo(a, SIDEWALK_W), mat: MAT_SIDEWALK, lift: SIDEWALK_LIFT });
        parts.push({ geo: capGeo(a, 0), mat: MAT_ASPHALT, lift: ASPHALT_LIFT });
      }
      continue;
    }

    // Kerb endpoints per arm: "+" is the counter-clockwise side.
    const plus = (a: Arm): readonly [number, number] => [a.px - a.tz * a.half, a.pz + a.tx * a.half];
    const minus = (a: Arm): readonly [number, number] => [a.px + a.tz * a.half, a.pz - a.tx * a.half];

    const poly: number[] = [];
    const walkBands: [number, number][][] = [];
    for (let i = 0; i < arms.length; i++) {
      const a = arms[i];
      const b = arms[(i + 1) % arms.length];
      if (!a || !b) continue;
      const [amx, amz] = minus(a);
      const [apx, apz] = plus(a);
      poly.push(amx, amz, apx, apz);
      // Corner between arm a (its + kerb) and arm b (its - kerb): intersect
      // the two kerb lines running INWARD (toward the node).
      const [bmx, bmz] = minus(b);
      const corner = lineIntersect(apx, apz, -a.tx, -a.tz, bmx, bmz, -b.tx, -b.tz);
      const band: [number, number][] = [[apx, apz]];
      if (corner) {
        const cd = Math.hypot(corner[0] - nx, corner[1] - nz);
        const lim = network.nodeTrim(n) * 1.8;
        if (cd < lim) {
          poly.push(corner[0], corner[1]);
          band.push([corner[0], corner[1]]);
        }
      }
      band.push([bmx, bmz]);
      walkBands.push(band);
    }
    // Asphalt polygon as a fan from the node centre.
    parts.push({ geo: fanGeo(nx, nz, poly), mat: MAT_ASPHALT, lift: ASPHALT_LIFT });
    // Crosswalk stripes across each arm of a real junction (3+ streets).
    if (arms.length >= 3) {
      for (const a of arms) {
        const stripes: number[] = [];
        const inner = 0.7; // start just outside the junction polygon
        const outer = 2.5;
        const usable = a.half - 0.9;
        const count = Math.max(3, Math.floor(usable / 0.85));
        for (let k = 0; k < count; k++) {
          const lat = -usable + (k / (count - 1)) * 2 * usable;
          const w = 0.42;
          for (const [d0, d1] of [[inner, outer]] as const) {
            const cx0 = a.px + a.tx * d0;
            const cz0 = a.pz + a.tz * d0;
            const cx1 = a.px + a.tx * d1;
            const cz1 = a.pz + a.tz * d1;
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
        }
        parts.push({ geo: flatGeo(stripes), mat: MAT_WHITE, lift: LINE_LIFT });
      }
    }
    // Sidewalk corner bands: each band polyline pushed outward from the node.
    for (const band of walkBands) {
      if (band.length < 2) continue;
      parts.push({ geo: bandGeo(nx, nz, band, SIDEWALK_W), mat: MAT_SIDEWALK, lift: SIDEWALK_LIFT });
      parts.push({ geo: bandGeo(nx, nz, band, CURB_W), mat: MAT_CURB, lift: SIDEWALK_LIFT - 0.02 });
    }
  }

  // Conform every part to the terrain; caller merges by material into chunks.
  const out: THREE.Mesh[] = [];
  for (const p of parts) {
    const draped = conformToTerrain(p.geo, terrain, p.lift);
    out.push(new THREE.Mesh(draped, p.mat));
  }
  return out;
}
