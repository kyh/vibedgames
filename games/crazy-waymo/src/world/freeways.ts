import * as THREE from "three";

import { SF_FREEWAY_RAMPS, SF_FREEWAYS } from "./sf-freeways";
import type { Terrain } from "./terrain";

// Elevated freeways — 80 to the Bay Bridge, 101/280, the Central Freeway —
// plus their real on/off ramps (OSM motorway/trunk links). DRIVABLE: the
// visual deck+barrier geometry doubles as a static physics trimesh
// (physics-world.addStaticTrimesh) so the raycast vehicle rides exactly what
// it sees, while the street heightfield below stays untouched — underpasses
// keep working because a wheel ray cast from under the deck never reaches it.
// Ramps anchor one end at street grade and the other at the mainline deck.
// Everything derives from ONE memoized build so visuals, physics and pillar
// solids can never disagree.

const STEP = 6; // resample pitch along the centerline
const CLEAR = 6.5; // deck soffit clearance above local terrain
const DECK_T = 0.9; // slab thickness
const MAX_GRADE = 0.05; // per-unit climb limit for the smoothed mainline deck
const PILLAR_EVERY = 4; // one pillar per N samples (24u)
const RAMP_ANCHOR_R = 30; // ramp end within this of a mainline → deck height
const BARRIER_H = 0.85;

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
  readonly ramp: boolean;
  /** cumulative arclength per sample (ramps only; barrier/lip feathering) */
  readonly cum?: readonly number[];
  readonly openStart?: boolean; // street-grade end — feathered lip, no barrier
  readonly openEnd?: boolean;
};

type FreewayBuild = {
  readonly lines: readonly Line[];
  readonly deckPos: number[];
  readonly deckNor: number[];
  readonly bodyPos: number[];
  readonly bodyNor: number[];
  /** deck top + pillar faces, non-indexed triangles — the physics surface */
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

let cachedBuild: FreewayBuild | null = null;

function buildData(terrain: Terrain): FreewayBuild {
  if (cachedBuild) return cachedBuild;

  // --- Mainlines: terrain + clearance with an upward-only slew limit both
  // directions, so the profile glides over dips instead of rollercoastering.
  const mains: Line[] = [];
  for (const f of SF_FREEWAYS) {
    const pts = resample(f.p);
    if (pts.length < 2) continue;
    const ys = pts.map(([x, z]) => terrain.heightAt(x, z) + CLEAR + DECK_T);
    const maxD = STEP * MAX_GRADE;
    for (let i = 1; i < ys.length; i++) ys[i] = Math.max(ys[i] ?? 0, (ys[i - 1] ?? 0) - maxD);
    for (let i = ys.length - 2; i >= 0; i--) ys[i] = Math.max(ys[i] ?? 0, (ys[i + 1] ?? 0) - maxD);
    mains.push({ half: f.half, pts, ys, ramp: false });
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
    const pts = resample(r.p);
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
    let total = 0;
    const cum = pts.map((p, i) => {
      if (i === 0) return 0;
      const [ax, az] = pts[i - 1] ?? [0, 0];
      total += Math.hypot(p[0] - ax, p[1] - az);
      return total;
    });
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
      const blend = (anchor: number, endDist: number): number => {
        const c = Math.min(1, Math.max(0, (B - endDist) / (B - SAT)));
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
  const physPos: number[] = [];

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
    const barrierH = line.ramp ? 0.55 : BARRIER_H;
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
      // Deck top (asphalt look) — also the physics ride surface.
      pushQuad(deckPos, deckNor, a.l, b.l, b.r, a.r);
      pushQuad(physPos, null, a.l, b.l, b.r, a.r);
      // Soffit + fasciae (concrete).
      pushQuad(bodyPos, bodyNor, drop(a.r), drop(b.r), drop(b.l), drop(a.l));
      pushQuad(bodyPos, bodyNor, a.r, b.r, drop(b.r), drop(a.r));
      pushQuad(bodyPos, bodyNor, drop(a.l), drop(b.l), b.l, a.l);
      // Side barriers: low walls hugging the deck edges — solid in physics so
      // the car banks off them instead of sailing into the void mid-corner.
      const rail = (p: readonly number[], inset: number): number[] => {
        const cxr = line.pts[i] ?? [0, 0];
        const dx = cxr[0] - (p[0] ?? 0);
        const dz = cxr[1] - (p[2] ?? 0);
        const dl = Math.hypot(dx, dz) || 1;
        return [(p[0] ?? 0) + (dx / dl) * inset, p[1] ?? 0, (p[2] ?? 0) + (dz / dl) * inset];
      };
      const lift = (p: readonly number[]): number[] => [
        p[0] ?? 0,
        (p[1] ?? 0) + barrierH,
        p[2] ?? 0,
      ];
      // Open ramp mouths: no barrier within 10u of a street-grade end, so
      // the car rolls on/off without threading a walled slot.
      const segS = line.cum?.[i] ?? Infinity;
      const total = line.cum?.[line.cum.length - 1] ?? Infinity;
      const nearOpen =
        (line.openStart === true && segS < 10) || (line.openEnd === true && total - segS < 10);
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
        const q0 = rail(p0, 0.5);
        const q1 = rail(p1, 0.5);
        pushQuad(bodyPos, bodyNor, lift(q0), lift(q1), lift(p1), lift(p0)); // cap
        pushQuad(bodyPos, bodyNor, p0, p1, lift(p1), lift(p0)); // outer face
        pushQuad(bodyPos, bodyNor, lift(q0), lift(q1), q1, q0); // inner face
        // MAINLINE barriers are physical (guardrails for the high-speed
        // cruise; merge gaps above keep the ramp mouths open). RAMP rails
        // stay visual-only — braided links turned solid rails into
        // invisible-wall traps, and sailing off a ramp onto the street below
        // is recoverable (and fun) where a wedged car is neither.
        if (!line.ramp) pushQuad(physPos, null, lift(q0), lift(q1), q1, q0);
      }
    }
    // Pillars (visual quads + arcade solids; the trimesh handles the deck).
    for (let i = PILLAR_EVERY; i < n - 1; i += PILLAR_EVERY) {
      const [x, z] = line.pts[i] ?? [0, 0];
      const topY = (line.ys[i] ?? 0) - DECK_T;
      const botY = terrain.heightAt(x, z) - 0.6;
      if (topY - botY < 1.2) continue;
      const h = line.ramp ? 0.7 : 0.95;
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
        // Physics too: pillars stand on the CENTERLINE, so they must stop at
        // the soffit — the generic solid boxes are a fixed 12u tall and
        // walled off the very deck they hold up.
        pushQuad(
          physPos,
          null,
          [p[0], botY, p[1]],
          [q[0], botY, q[1]],
          [q[0], topY, q[1]],
          [p[0], topY, p[1]],
        );
      }
      // Close the pillar TOP in physics: an open shaft is a wheel trap — a
      // car that drops onto a pillar must land on a lid and drive off.
      const c0 = c[0];
      const c1 = c[1];
      const c2 = c[2];
      const c3 = c[3];
      if (c0 && c1 && c2 && c3) {
        pushQuad(
          physPos,
          null,
          [c0[0], topY, c0[1]],
          [c1[0], topY, c1[1]],
          [c2[0], topY, c2[1]],
          [c3[0], topY, c3[1]],
        );
      }
      // NO solid: the arcade solid-index is height-blind (a pillar box is an
      // invisible wall ON the deck it holds up). The trimesh walls above
      // already stop street-level traffic into the pillar.
    }
  }

  cachedBuild = { lines, deckPos, deckNor, bodyPos, bodyNor, physPos };
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
export function freewayPhysics(terrain: Terrain): Float32Array {
  return new Float32Array(buildData(terrain).physPos);
}

function pushQuad(
  pos: number[],
  nor: number[] | null,
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
    if (nor) nor.push(nx, ny, nz);
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
  const data = buildData(terrain);
  const group = new THREE.Group();
  const deckMesh = new THREE.Mesh(geoFrom(data.deckPos, data.deckNor), MAT_DECK);
  const bodyMesh = new THREE.Mesh(geoFrom(data.bodyPos, data.bodyNor), MAT_CONCRETE);
  deckMesh.receiveShadow = true;
  bodyMesh.castShadow = true;
  bodyMesh.receiveShadow = true;
  group.add(deckMesh, bodyMesh);
  return group;
}
