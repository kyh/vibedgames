import * as THREE from "three";

import type { Rng } from "../shared/rng";

// Attached SF row housing: one continuous strip of party-wall houses per
// street frontage run, generated as a single vertex-colored geometry.
// Replaces dozens of detached GLB instances per block — reads like real
// Victorians (shared walls, stepped bases on hills, bays, cornices) and
// costs ~45 triangles per house instead of ~600.

export type StripSegmentSpec = {
  // Facade line: the segment's front runs from (ax,az) to (bx,bz), facing
  // outward to the LEFT of a->b (toward the street).
  ax: number;
  az: number;
  bx: number;
  bz: number;
  depth: number;
  baseY: number; // seat height (max ground corner) — walls extend down 1.5 below
  floors: number; // 2..4
};

const PALETTE = [0xf2e8d8, 0xb9c7b4, 0x9aa7b8, 0xd8b9b0, 0xbcd0d8, 0xcfc3e0, 0xe4d9c3];
const TRIM = 0xf5f2ea;
const WINDOW = 0x2e3742;
const FLOOR_H = 2.6;
const PLINTH = 1.6; // extends below baseY so hills never gap under walls

export const STRIP_MAT = new THREE.MeshStandardMaterial({
  vertexColors: true,
  roughness: 0.92,
});

type Sink = {
  pos: number[];
  nor: number[];
  col: number[];
  idx: number[];
};

const C = new THREE.Color();

function quad(
  sink: Sink,
  v0: [number, number, number],
  v1: [number, number, number],
  v2: [number, number, number],
  v3: [number, number, number],
  n: [number, number, number],
  color: number,
): void {
  const base = sink.pos.length / 3;
  C.setHex(color);
  for (const v of [v0, v1, v2, v3]) {
    sink.pos.push(v[0], v[1], v[2]);
    sink.nor.push(n[0], n[1], n[2]);
    sink.col.push(C.r, C.g, C.b);
  }
  sink.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
}

// Axis box in the segment's local frame: f = along facade (a->b), u = outward
// (toward street), y = up. Emits 5 faces (bottom skipped).
function frameBox(
  sink: Sink,
  origin: [number, number, number], // world position of local (0, y0, 0)
  fDir: [number, number], // unit along-facade
  uDir: [number, number], // unit outward
  f0: number,
  f1: number,
  y0: number,
  y1: number,
  u0: number,
  u1: number,
  color: number,
): void {
  const P = (f: number, y: number, u: number): [number, number, number] => [
    origin[0] + fDir[0] * f + uDir[0] * u,
    y,
    origin[2] + fDir[1] * f + uDir[1] * u,
  ];
  const nF: [number, number, number] = [fDir[0], 0, fDir[1]];
  const nB: [number, number, number] = [-fDir[0], 0, -fDir[1]];
  const nU: [number, number, number] = [uDir[0], 0, uDir[1]];
  const nD: [number, number, number] = [-uDir[0], 0, -uDir[1]];
  // front (outward), back, two ends, top
  quad(sink, P(f0, y0, u1), P(f1, y0, u1), P(f1, y1, u1), P(f0, y1, u1), nU, color);
  quad(sink, P(f1, y0, u0), P(f0, y0, u0), P(f0, y1, u0), P(f1, y1, u0), nD, color);
  quad(sink, P(f1, y0, u1), P(f1, y0, u0), P(f1, y1, u0), P(f1, y1, u1), nF, color);
  quad(sink, P(f0, y0, u0), P(f0, y0, u1), P(f0, y1, u1), P(f0, y1, u0), nB, color);
  quad(sink, P(f0, y1, u1), P(f1, y1, u1), P(f1, y1, u0), P(f0, y1, u0), [0, 1, 0], color);
}

export function buildRowStrip(segments: readonly StripSegmentSpec[], rng: Rng): THREE.BufferGeometry {
  const sink: Sink = { pos: [], nor: [], col: [], idx: [] };
  for (const seg of segments) {
    const dx = seg.bx - seg.ax;
    const dz = seg.bz - seg.az;
    const w = Math.hypot(dx, dz);
    if (w < 2) continue;
    const f: [number, number] = [dx / w, dz / w];
    const u: [number, number] = [-dz / w, dx / w]; // left of a->b = street side
    const o: [number, number, number] = [seg.ax, 0, seg.az];
    const body = PALETTE[Math.floor(rng.range(0, PALETTE.length)) % PALETTE.length] ?? 0xf2e8d8;
    const h = seg.floors * FLOOR_H;
    const y0 = seg.baseY - PLINTH;
    const yTop = seg.baseY + h;
    // Massing: facade at u=0, body extends inward (negative u).
    frameBox(sink, o, f, u, 0.06, w - 0.06, y0, yTop, -seg.depth, 0, body);
    // Cornice: white slab, slight overhang.
    frameBox(sink, o, f, u, -0.12, w + 0.12, yTop, yTop + 0.34, -seg.depth - 0.12, 0.22, TRIM);
    // Bay window: prism on most segments, upper floors only.
    if (rng.chance(0.55) && w > 3.2) {
      const bw = w * 0.42;
      const b0 = (w - bw) / 2;
      frameBox(sink, o, f, u, b0, b0 + bw, seg.baseY + FLOOR_H * 0.9, yTop - 0.15, 0, 0.62, body);
    }
    // Windows: two dark insets per floor on the facade plane.
    for (let fl = 0; fl < seg.floors; fl++) {
      const wy0 = seg.baseY + fl * FLOOR_H + 0.7;
      const wy1 = wy0 + FLOOR_H * 0.55;
      for (const t of [0.22, 0.66]) {
        const wx0 = w * t;
        const wx1 = wx0 + Math.min(1.15, w * 0.18);
        const P = (ff: number, y: number): [number, number, number] => [
          o[0] + f[0] * ff + u[0] * 0.03,
          y,
          o[2] + f[1] * ff + u[1] * 0.03,
        ];
        quad(sink, P(wx0, wy0), P(wx1, wy0), P(wx1, wy1), P(wx0, wy1), [u[0], 0, u[1]], WINDOW);
      }
    }
    // Door: ground floor, off-center.
    {
      const dx0 = w * 0.06;
      const dx1 = dx0 + Math.min(1.0, w * 0.16);
      const P = (ff: number, y: number): [number, number, number] => [
        o[0] + f[0] * ff + u[0] * 0.04,
        y,
        o[2] + f[1] * ff + u[1] * 0.04,
      ];
      quad(
        sink,
        P(dx0, seg.baseY),
        P(dx1, seg.baseY),
        P(dx1, seg.baseY + 2.1),
        P(dx0, seg.baseY + 2.1),
        [u[0], 0, u[1]],
        WINDOW,
      );
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(sink.pos), 3));
  geo.setAttribute("normal", new THREE.BufferAttribute(new Float32Array(sink.nor), 3));
  geo.setAttribute("color", new THREE.BufferAttribute(new Float32Array(sink.col), 3));
  const IndexArr = sink.pos.length / 3 > 65535 ? Uint32Array : Uint16Array;
  geo.setIndex(new THREE.BufferAttribute(new IndexArr(sink.idx), 1));
  return geo;
}
