import * as THREE from "three";

import { WORLD_HALF_X, WORLD_HALF_Z } from "../shared/constants";
import type { RoadNetwork } from "./network";
import { applyAsphaltSpeckle } from "./roads";
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
const DECK_T = 0.9; // slab thickness
const MAX_GRADE = 0.05; // per-unit climb limit for the smoothed mainline deck
const PILLAR_EVERY = 4; // one pillar per N samples (24u)
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

// DoubleSide: barrier/pillar quads are hand-wound; guaranteeing outward
// normals everywhere isn't worth the culling win on this little geometry.
const MAT_CONCRETE = new THREE.MeshStandardMaterial({
  color: 0xb6b0a4,
  roughness: 1,
  side: THREE.DoubleSide,
});
// Deck asphalt matches the street asphalt exactly (same color + aggregate
// speckle) so ramp mouths merge into the roadway with no material seam.
const MAT_DECK = new THREE.MeshStandardMaterial({ color: 0x555b68, roughness: 1 });
applyAsphaltSpeckle(MAT_DECK);
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

type FreewayBuild = {
  readonly lines: readonly Line[];
  readonly deckPos: number[];
  readonly deckNor: number[];
  readonly bodyPos: number[];
  readonly bodyNor: number[];
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
  // directions, so the profile glides over dips instead of rollercoastering.
  const mains: Line[] = [];
  for (const f of SF_FREEWAYS) {
    const pts = resample(f.p);
    if (pts.length < 2) continue;
    const ys = pts.map(([x, z]) => terrain.heightAt(x, z) + CLEAR + DECK_T);
    const maxD = STEP * MAX_GRADE;
    for (let i = 1; i < ys.length; i++) ys[i] = Math.max(ys[i] ?? 0, (ys[i - 1] ?? 0) - maxD);
    for (let i = ys.length - 2; i >= 0; i--) ys[i] = Math.max(ys[i] ?? 0, (ys[i + 1] ?? 0) - maxD);
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
  const whitePos: number[] = [];
  const yellowPos: number[] = [];
  const signPos: number[] = [];
  const signNor: number[] = [];
  const physPos: number[] = [];

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
  ): void => {
    const c = (st: number, sp: number, y: number): number[] => [
      cx + tx * halfT * st + px2 * halfP * sp,
      y,
      cz + tz * halfT * st + pz2 * halfP * sp,
    ];
    pushQuad(pos, nor, c(-1, -1, y1), c(1, -1, y1), c(1, 1, y1), c(-1, 1, y1)); // top
    pushQuad(pos, nor, c(-1, -1, y0), c(-1, 1, y0), c(1, 1, y0), c(1, -1, y0)); // bottom
    pushQuad(pos, nor, c(-1, -1, y0), c(1, -1, y0), c(1, -1, y1), c(-1, -1, y1));
    pushQuad(pos, nor, c(-1, 1, y0), c(-1, 1, y1), c(1, 1, y1), c(1, 1, y0));
    pushQuad(pos, nor, c(-1, -1, y0), c(-1, -1, y1), c(-1, 1, y1), c(-1, 1, y0));
    pushQuad(pos, nor, c(1, -1, y0), c(1, 1, y0), c(1, 1, y1), c(1, -1, y1));
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
      // Soffit + fasciae (concrete).
      pushQuad(bodyPos, bodyNor, drop(a.r), drop(b.r), drop(b.l), drop(a.l));
      pushQuad(bodyPos, bodyNor, a.r, b.r, drop(b.r), drop(a.r));
      pushQuad(bodyPos, bodyNor, drop(a.l), drop(b.l), b.l, a.l);

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
        const q0 = railIn(i, side);
        const q1 = railIn(i + 1, side);
        pushQuad(
          bodyPos,
          bodyNor,
          lift(q0, barrierH),
          lift(q1, barrierH),
          lift(p1, barrierH),
          lift(p0, barrierH),
        ); // cap
        pushQuad(bodyPos, bodyNor, p0, p1, lift(p1, barrierH), lift(p0, barrierH)); // outer face
        pushQuad(bodyPos, bodyNor, lift(q0, barrierH), lift(q1, barrierH), q1, q0); // inner face
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

  cachedBuild = {
    lines,
    deckPos,
    deckNor,
    bodyPos,
    bodyNor,
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

function geoFrom(pos: number[], nor: number[] | null): THREE.BufferGeometry {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(pos), 3));
  if (nor) {
    geo.setAttribute("normal", new THREE.BufferAttribute(new Float32Array(nor), 3));
  } else {
    const up = new Float32Array(pos.length);
    for (let i = 1; i < up.length; i += 3) up[i] = 1;
    geo.setAttribute("normal", new THREE.BufferAttribute(up, 3));
  }
  geo.setAttribute("uv", new THREE.BufferAttribute(new Float32Array((pos.length / 3) * 2), 2));
  return geo;
}

export function buildFreeways(terrain: Terrain, network?: RoadNetwork): THREE.Group {
  const data = buildData(terrain, network);
  const group = new THREE.Group();
  const deckMesh = new THREE.Mesh(geoFrom(data.deckPos, data.deckNor), MAT_DECK);
  const bodyMesh = new THREE.Mesh(geoFrom(data.bodyPos, data.bodyNor), MAT_CONCRETE);
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
