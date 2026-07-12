import * as THREE from "three";

import type { Solid } from "../shared/types";
import { SF_FREEWAYS } from "./sf-freeways";
import type { Terrain } from "./terrain";

// Elevated freeway viaducts — 80 to the Bay Bridge, 101/280, the Central
// Freeway. NOT drivable and NOT part of the street network (flat-rendered
// freeways were spaghetti; see bake-network.mts): concrete decks on pillars,
// built main-side like the landmarks (cheap: a few hundred segments), with
// deterministic pillar SOLIDS derived separately so the physics world and the
// visuals can never disagree.

const STEP = 6; // resample pitch along the centerline
const CLEAR = 6.5; // deck soffit clearance above local terrain
const DECK_T = 0.9; // slab thickness
const MAX_GRADE = 0.05; // per-unit climb limit for the smoothed deck
const PILLAR_EVERY = 4; // one pillar per N samples (24u)

// DoubleSide: barrier/pillar quads are hand-wound; guaranteeing outward
// normals everywhere isn't worth the culling win on this little geometry.
const MAT_CONCRETE = new THREE.MeshStandardMaterial({
  color: 0xb6b0a4,
  roughness: 1,
  side: THREE.DoubleSide,
});
const MAT_DECK = new THREE.MeshStandardMaterial({ color: 0x596170, roughness: 1 });

type Line = {
  readonly half: number;
  readonly pts: readonly (readonly [number, number])[]; // resampled
  readonly ys: readonly number[]; // deck TOP height per sample
};

let cachedLines: Line[] | null = null;
function linesFor(terrain: Terrain): Line[] {
  if (cachedLines) return cachedLines;
  const lines: Line[] = [];
  for (const f of SF_FREEWAYS) {
    const src: [number, number][] = [];
    for (let i = 0; i + 1 < f.p.length; i += 2) src.push([f.p[i] ?? 0, f.p[i + 1] ?? 0]);
    if (src.length < 2) continue;
    // Resample at STEP.
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
    if (pts.length < 2) continue;
    // Deck height: terrain + clearance, then an upward-only slew limit both
    // directions so the profile glides over dips instead of rollercoastering.
    const ys = pts.map(([x, z]) => terrain.heightAt(x, z) + CLEAR + DECK_T);
    const maxD = STEP * MAX_GRADE;
    for (let i = 1; i < ys.length; i++) {
      ys[i] = Math.max(ys[i] ?? 0, (ys[i - 1] ?? 0) - maxD);
    }
    for (let i = ys.length - 2; i >= 0; i--) {
      ys[i] = Math.max(ys[i] ?? 0, (ys[i + 1] ?? 0) - maxD);
    }
    lines.push({ half: f.half, pts, ys });
  }
  cachedLines = lines;
  return lines;
}

// --- Placement guard: no procedural building inside the freeway ROW ---
const rowHash = new Map<string, number[]>(); // bucket -> freeway line indices
const ROW_CELL = 60;
let rowBuilt = false;
function buildRowHash(): void {
  if (rowBuilt) return;
  rowBuilt = true;
  SF_FREEWAYS.forEach((f, idx) => {
    const seen = new Set<string>();
    for (let i = 0; i + 3 < f.p.length; i += 2) {
      const x0 = Math.min(f.p[i] ?? 0, f.p[i + 2] ?? 0) - 12;
      const x1 = Math.max(f.p[i] ?? 0, f.p[i + 2] ?? 0) + 12;
      const z0 = Math.min(f.p[i + 1] ?? 0, f.p[i + 3] ?? 0) - 12;
      const z1 = Math.max(f.p[i + 1] ?? 0, f.p[i + 3] ?? 0) + 12;
      for (let bx = Math.floor(x0 / ROW_CELL); bx <= Math.floor(x1 / ROW_CELL); bx++) {
        for (let bz = Math.floor(z0 / ROW_CELL); bz <= Math.floor(z1 / ROW_CELL); bz++) {
          const k = `${bx},${bz}`;
          if (seen.has(k)) continue;
          seen.add(k);
          const arr = rowHash.get(k) ?? [];
          arr.push(idx);
          rowHash.set(k, arr);
        }
      }
    }
  });
}

export function nearFreeway(x: number, z: number, margin: number): boolean {
  buildRowHash();
  const ids = rowHash.get(`${Math.floor(x / ROW_CELL)},${Math.floor(z / ROW_CELL)}`);
  if (!ids) return false;
  for (const idx of ids) {
    const f = SF_FREEWAYS[idx];
    if (!f) continue;
    const lim = f.half + margin;
    for (let i = 0; i + 3 < f.p.length; i += 2) {
      const ax = f.p[i] ?? 0;
      const az = f.p[i + 1] ?? 0;
      const bx = f.p[i + 2] ?? 0;
      const bz = f.p[i + 3] ?? 0;
      const dx = bx - ax;
      const dz = bz - az;
      const l2 = dx * dx + dz * dz;
      const t = l2 > 1e-8 ? Math.min(Math.max(((x - ax) * dx + (z - az) * dz) / l2, 0), 1) : 0;
      const d = Math.hypot(ax + dx * t - x, az + dz * t - z);
      if (d < lim) return true;
    }
  }
  return false;
}

// Deterministic pillar boxes — pushed into the physics solids by city.ts.
export function freewaySolids(terrain: Terrain): Solid[] {
  const solids: Solid[] = [];
  for (const line of linesFor(terrain)) {
    for (let i = PILLAR_EVERY; i < line.pts.length - 1; i += PILLAR_EVERY) {
      const [x, z] = line.pts[i] ?? [0, 0];
      const h = 0.95;
      solids.push({ minX: x - h, maxX: x + h, minZ: z - h, maxZ: z + h });
    }
  }
  return solids;
}

function pushQuad(
  pos: number[],
  nor: number[],
  a: readonly number[],
  b: readonly number[],
  c: readonly number[],
  d: readonly number[],
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
  const put = (p: readonly number[]): void => {
    pos.push(p[0] ?? 0, p[1] ?? 0, p[2] ?? 0);
    nor.push(nx, ny, nz);
  };
  put(a);
  put(b);
  put(c);
  put(a);
  put(c);
  put(d);
}

function geoFrom(pos: number[], nor: number[]): THREE.BufferGeometry {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(pos), 3));
  geo.setAttribute("normal", new THREE.BufferAttribute(new Float32Array(nor), 3));
  geo.setAttribute("uv", new THREE.BufferAttribute(new Float32Array((pos.length / 3) * 2), 2));
  return geo;
}

export function buildFreeways(terrain: Terrain): THREE.Group {
  const group = new THREE.Group();
  const deckPos: number[] = [];
  const deckNor: number[] = [];
  const bodyPos: number[] = [];
  const bodyNor: number[] = [];

  for (const line of linesFor(terrain)) {
    const n = line.pts.length;
    const w = line.half;
    // Per-sample lateral normal.
    const rails: { l: number[]; r: number[] }[] = [];
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
      rails.push({ l: [x - tz * w, y, z + tx * w], r: [x + tz * w, y, z - tx * w] });
    }
    for (let i = 0; i + 1 < n; i++) {
      const a = rails[i];
      const b = rails[i + 1];
      if (!a || !b) continue;
      const drop = (p: readonly number[]): number[] => [p[0] ?? 0, (p[1] ?? 0) - DECK_T, p[2] ?? 0];
      // Deck top (asphalt look).
      pushQuad(deckPos, deckNor, a.l, b.l, b.r, a.r);
      // Soffit + fasciae (concrete).
      pushQuad(bodyPos, bodyNor, drop(a.r), drop(b.r), drop(b.l), drop(a.l));
      pushQuad(bodyPos, bodyNor, a.r, b.r, drop(b.r), drop(a.r));
      pushQuad(bodyPos, bodyNor, drop(a.l), drop(b.l), b.l, a.l);
      // Side barriers: low walls hugging the deck edges.
      const rail = (p: readonly number[], inset: number): number[] => {
        const cxr = line.pts[i] ?? [0, 0];
        const dx = cxr[0] - (p[0] ?? 0);
        const dz = cxr[1] - (p[2] ?? 0);
        const dl = Math.hypot(dx, dz) || 1;
        return [(p[0] ?? 0) + (dx / dl) * inset, p[1] ?? 0, (p[2] ?? 0) + (dz / dl) * inset];
      };
      for (const side of ["l", "r"] as const) {
        const p0 = a[side];
        const p1 = b[side];
        const q0 = rail(p0, 0.5);
        const q1 = rail(p1, 0.5);
        const up = (p: readonly number[]): number[] => [p[0] ?? 0, (p[1] ?? 0) + 0.85, p[2] ?? 0];
        pushQuad(bodyPos, bodyNor, up(q0), up(q1), up(p1), up(p0)); // cap
        pushQuad(bodyPos, bodyNor, p0, p1, up(p1), up(p0)); // outer face
        pushQuad(bodyPos, bodyNor, up(q0), up(q1), q1, q0); // inner face
      }
    }
    // Pillars.
    for (let i = PILLAR_EVERY; i < n - 1; i += PILLAR_EVERY) {
      const [x, z] = line.pts[i] ?? [0, 0];
      const topY = (line.ys[i] ?? 0) - DECK_T;
      const botY = terrain.heightAt(x, z) - 0.6;
      if (topY - botY < 1.2) continue;
      const h = 0.95;
      const c = [
        [x - h, z - h],
        [x + h, z - h],
        [x + h, z + h],
        [x - h, z + h],
      ] as const;
      for (let k = 0; k < 4; k++) {
        const p = c[k];
        const q = c[(k + 1) % 4];
        if (!p || !q) continue;
        pushQuad(
          bodyPos,
          bodyNor,
          [p[0], botY, p[1]],
          [q[0], botY, q[1]],
          [q[0], topY, q[1]],
          [p[0], topY, p[1]],
        );
      }
    }
  }

  const deckMesh = new THREE.Mesh(geoFrom(deckPos, deckNor), MAT_DECK);
  const bodyMesh = new THREE.Mesh(geoFrom(bodyPos, bodyNor), MAT_CONCRETE);
  deckMesh.receiveShadow = true;
  bodyMesh.castShadow = true;
  bodyMesh.receiveShadow = true;
  group.add(deckMesh, bodyMesh);
  return group;
}
