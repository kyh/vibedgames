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

// Junction disc (flat n-gon fan).
function discGeo(x: number, z: number, r: number, segs = 14): THREE.BufferGeometry {
  const pos: number[] = [];
  const uv: number[] = [];
  for (let i = 0; i < segs; i++) {
    const a0 = (i / segs) * Math.PI * 2;
    const a1 = ((i + 1) / segs) * Math.PI * 2;
    // CCW from above (+Y): centre, then a1 before a0.
    pos.push(x, 0, z, x + Math.cos(a1) * r, 0, z + Math.sin(a1) * r, x + Math.cos(a0) * r, 0, z + Math.sin(a0) * r);
    uv.push(0.5, 0.5, 0, 0, 1, 1);
  }
  const geo = new THREE.BufferGeometry();
  const nor = new Float32Array(pos.length);
  for (let i = 1; i < nor.length; i += 3) nor[i] = 1;
  geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(pos), 3));
  geo.setAttribute("normal", new THREE.BufferAttribute(nor, 3));
  geo.setAttribute("uv", new THREE.BufferAttribute(new Float32Array(uv), 2));
  return geo;
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
    // Sidewalks, curbs and edge lines pull further back from junctions —
    // at shallow-angle crossings their strips would otherwise slice across
    // the neighbour edge's asphalt. Overlapping asphalt is invisible;
    // overlapping kerbs are not.
    const walk = railFor(edge, trimA + 3, edge.len - trimB - 3);
    if (walk) {
      parts.push({ geo: stripGeo(walk, h, h + SIDEWALK_W), mat: MAT_SIDEWALK, lift: SIDEWALK_LIFT });
      parts.push({ geo: stripGeo(walk, -h - SIDEWALK_W, -h), mat: MAT_SIDEWALK, lift: SIDEWALK_LIFT });
      parts.push({ geo: stripGeo(walk, h - CURB_W, h), mat: MAT_CURB, lift: SIDEWALK_LIFT - 0.02 });
      parts.push({ geo: stripGeo(walk, -h, -h + CURB_W), mat: MAT_CURB, lift: SIDEWALK_LIFT - 0.02 });
      const eo = h - EDGE_INSET;
      parts.push({ geo: stripGeo(walk, eo - LINE_W / 2, eo + LINE_W / 2), mat: MAT_WHITE, lift: LINE_LIFT });
      parts.push({ geo: stripGeo(walk, -eo - LINE_W / 2, -eo + LINE_W / 2), mat: MAT_WHITE, lift: LINE_LIFT });
    }

    // Yellow centre dashes by arclength along the trimmed section.
    const secLen = edge.len - trimA - trimB;
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
  for (let n = 0; n < network.nodes.length; n++) {
    const ids = network.nodeEdges[n];
    if (!ids || ids.length === 0) continue;
    const node = network.nodes[n];
    if (!node) continue;
    const r = network.nodeTrim(n) + 0.4;
    parts.push({ geo: discGeo(node[0], node[1], r), mat: MAT_ASPHALT, lift: ASPHALT_LIFT });
  }

  // Conform every part to the terrain; caller merges by material into chunks.
  const out: THREE.Mesh[] = [];
  for (const p of parts) {
    const draped = conformToTerrain(p.geo, terrain, p.lift);
    out.push(new THREE.Mesh(draped, p.mat));
  }
  return out;
}
