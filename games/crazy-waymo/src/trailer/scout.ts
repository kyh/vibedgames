// Trailer location scouting — pure queries over the baked world (street plan,
// vector network, terrain heights). No THREE, no DOM, no GameScene: the same
// functions run inside the trailer director AND headless under vite-node
// (tools-style), so every staged location can be verified without a browser.
//
// All results are deterministic: the plan/network/terrain derive from baked
// data and fixed seeds, so a spot scouted headless is the spot used on screen.

import {
  GRID_X,
  GRID_Z,
  ROAD_TILE,
  WORLD_H,
  WORLD_HALF_X,
  WORLD_HALF_Z,
  WORLD_W,
} from "../shared/constants";
import type { CityPlan } from "../world/grid";
import { controlArms, junctionControl } from "../world/junction-control";
import type { NetEdge, RoadNetwork } from "../world/network";
import { districtAt, landFactor, type DistrictChar } from "../world/sf-map";
import { SF_FREEWAYS } from "../world/sf-freeways";

export type ScoutCtx = {
  readonly plan: CityPlan;
  readonly network: RoadNetwork;
  /** Drive-surface (or raw terrain) height. Every grade/flatness test here
   *  tolerates the difference between the two, but `FreewayRun.deckTopAt`
   *  does NOT: it mirrors world/freeways.ts, which profiles the deck from RAW
   *  terrain. Hand this raw terrain to make that field exact. */
  readonly heightAt: (x: number, z: number) => number;
};

export const worldX = (gx: number): number => (gx + 0.5) * ROAD_TILE - WORLD_HALF_X;
export const worldZ = (gz: number): number => (gz + 0.5) * ROAD_TILE - WORLD_HALF_Z;
export const gridX = (x: number): number => Math.floor((x + WORLD_HALF_X) / ROAD_TILE);
export const gridZ = (z: number): number => Math.floor((z + WORLD_HALF_Z) / ROAD_TILE);

// ---------------------------------------------------------------------------
// Play area — the map is DRAWN wider than it is playable, and staging a shot
// out there drops the car through the world.
//
// Four extents disagree. The rendered ground mesh reaches |x| 1713 / |z| 1404
// and the Rapier ground heightfield stops at 1681 / 1378, but the plan cells,
// districtAt and the terrain field cache all stop at WORLD_HALF (1586 / 1300)
// — and `heightAt` does not fail past the cache, it clamps its index and keeps
// returning the edge sample. The baked road network runs several hundred units
// past WORLD_HALF to the north, so that tail reads as flat drivable asphalt at
// a fake constant height over open bay, with no collider under it.
//
// WORLD_HALF is the gate rather than the collider extent: past it every query
// a scout makes is fiction anyway, and it leaves ~95u/78u of collider slack
// for a shot that overruns its mark.

/** Margin from the map edge that any staged point must keep — roughly one
 *  scene's worth of overrun (a take drives ~40u/s for a couple of seconds). */
export const STAGE_MARGIN = 60;

export function inPlayArea(x: number, z: number, margin = STAGE_MARGIN): boolean {
  return Math.abs(x) <= WORLD_HALF_X - margin && Math.abs(z) <= WORLD_HALF_Z - margin;
}

/** EVERY vertex must be inside: a take can stage anywhere along the edge it
 *  picked, so one vertex in the void disqualifies the whole edge. */
export function edgeInPlayArea(e: NetEdge, margin = STAGE_MARGIN): boolean {
  for (let i = 0; i + 1 < e.pts.length; i += 2) {
    if (!inPlayArea(e.pts[i] ?? 0, e.pts[i + 1] ?? 0, margin)) return false;
  }
  return true;
}

const districtAtWorld = (x: number, z: number): DistrictChar =>
  districtAt(gridX(x), gridZ(z)).character;

const waterAt = (x: number, z: number): boolean =>
  landFactor(x / WORLD_W + 0.5, z / WORLD_H + 0.5) < 0.5;

function straightness(e: NetEdge): number {
  const n = e.pts.length / 2;
  if (n < 2 || e.len < 1) return 0;
  const dx = (e.pts[n * 2 - 2] ?? 0) - (e.pts[0] ?? 0);
  const dz = (e.pts[n * 2 - 1] ?? 0) - (e.pts[1] ?? 0);
  return Math.hypot(dx, dz) / e.len;
}

const DENSE: ReadonlySet<DistrictChar> = new Set(["downtown", "highrise", "commercial"]);
const CORNER_OK: ReadonlySet<DistrictChar> = new Set([
  "downtown",
  "highrise",
  "commercial",
  "victorian",
]);

// ---------------------------------------------------------------------------
// Straight downtown arterial for the cold-open weave.

export type RunSpot = {
  readonly edge: NetEdge;
  readonly dir: 1 | -1; // travel direction (a→b = 1)
};

export function scoutArterial(ctx: ScoutCtx, exclude?: NetEdge): RunSpot | null {
  let best: RunSpot | null = null;
  let bestScore = 0;
  for (const e of ctx.network.edges) {
    if (!edgeInPlayArea(e)) continue;
    if (e === exclude) continue;
    if (e.len < 150 || e.half < 4.6) continue;
    if (straightness(e) < 0.965) continue;
    const mid = ctx.network.sample(e, e.len / 2);
    if (!DENSE.has(districtAtWorld(mid.x, mid.z))) continue;
    // Flat enough that the weave reads (no hidden dips).
    let maxGrade = 0;
    for (let s = 6; s < e.len; s += 6) {
      const a = ctx.network.sample(e, s - 6);
      const b = ctx.network.sample(e, s);
      maxGrade = Math.max(maxGrade, Math.abs(ctx.heightAt(b.x, b.z) - ctx.heightAt(a.x, a.z)) / 6);
    }
    if (maxGrade > 0.05) continue;
    const score = e.len * e.half;
    if (score > bestScore) {
      bestScore = score;
      // Drive toward the denser end (skyline ahead of the camera).
      const endA = ctx.network.sample(e, Math.min(8, e.len));
      const dir: 1 | -1 = DENSE.has(districtAtWorld(endA.x, endA.z)) ? -1 : 1;
      best = { edge: e, dir };
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Hill crests: uphill approach that falls away hard — the launch spots.

export type CrestSpot = {
  readonly edge: NetEdge;
  readonly sCrest: number;
  readonly dir: 1 | -1; // travel direction that climbs INTO the crest
  readonly x: number;
  readonly z: number;
  readonly yaw: number; // travel heading (forward = sin,cos)
  readonly upGrade: number;
  readonly downGrade: number;
};

export function scoutCrests(ctx: ScoutCtx, max = 6): CrestSpot[] {
  const RUN = 21; // grade measured over this approach/exit distance
  const found: CrestSpot[] = [];
  for (const e of ctx.network.edges) {
    if (!edgeInPlayArea(e)) continue;
    if (e.len < 70 || straightness(e) < 0.9) continue;
    for (let s = RUN + 6; s <= e.len - RUN - 24; s += 3) {
      const here = ctx.network.sample(e, s);
      const h = ctx.heightAt(here.x, here.z);
      const back = ctx.network.sample(e, s - RUN);
      const fwd = ctx.network.sample(e, s + RUN);
      const hBack = ctx.heightAt(back.x, back.z);
      const hFwd = ctx.heightAt(fwd.x, fwd.z);
      // Crest travelling a→b: climbs from `back`, drops toward `fwd` (or the
      // mirror). Both grades must be real for the suspension to unload.
      for (const dir of [1, -1] as const) {
        const up = ((dir > 0 ? hBack : hFwd) - h) / -RUN;
        const down = (h - (dir > 0 ? hFwd : hBack)) / RUN;
        if (up < 0.09 || down < 0.11) continue;
        const yaw = Math.atan2(here.tx * dir, here.tz * dir);
        found.push({
          edge: e,
          sCrest: s,
          dir,
          x: here.x,
          z: here.z,
          yaw,
          upGrade: up,
          downGrade: down,
        });
      }
    }
  }
  found.sort((a, b) => Math.min(b.upGrade, b.downGrade) - Math.min(a.upGrade, a.downGrade));
  // Spatially dedupe (one crest per hill, and per scene).
  const picked: CrestSpot[] = [];
  for (const c of found) {
    if (picked.some((p) => Math.hypot(p.x - c.x, p.z - c.z) < 120)) continue;
    picked.push(c);
    if (picked.length >= max) break;
  }
  return picked;
}

// ---------------------------------------------------------------------------
// The SF grade: a long straight street that falls away hard under the camera.
//
// This replaces a `scoutVista` that asked for a downhill with open WATER ahead
// and, in this bake, answered with a 7% run through Jackson Square — a slope
// too gentle to drop the horizon out of any frame, which is why nothing ever
// staged on it. What actually reads on camera is the GRADE, so that is what is
// gated here; where the street points is left to the shot.

export type DescentSpot = {
  readonly edge: NetEdge;
  readonly dir: 1 | -1;
  /** Arclength IN TRAVEL ORDER to enter at — placed so the steep tail of the
   *  run lands inside a ~2s take rather than after it. */
  readonly sStart: number;
  readonly grade: number; // average over the whole run
  readonly steepest: number; // worst 12u window — the bit that reads
};

/** How much road a descent take actually uses (≈2.2s at 40 u/s, plus slack). */
const DESCENT_RUN = 100;
/** Above this, a 12u window is a terrain cliff the drape happens to cross, not
 *  a street: the car launches off it and the take ends in a barrel roll. */
const DESCENT_MAX_STEP = 0.4;

export function scoutDescent(ctx: ScoutCtx, minGrade = 0.12): DescentSpot | null {
  let best: DescentSpot | null = null;
  let bestScore = 0;
  for (const e of ctx.network.edges) {
    if (!edgeInPlayArea(e)) continue;
    if (e.len < 120 || e.half < 4.0 || straightness(e) < 0.93) continue;
    const a = ctx.network.sample(e, 4);
    const b = ctx.network.sample(e, e.len - 4);
    const hA = ctx.heightAt(a.x, a.z);
    const hB = ctx.heightAt(b.x, b.z);
    const run = e.len - 8;
    const grade = Math.abs(hA - hB) / run;
    if (grade < minGrade) continue;
    const dir: 1 | -1 = hA > hB ? 1 : -1;
    // Steepest local window, and a monotonicity check: a street that dips and
    // climbs back reads as a bump, not as a hill.
    let steepest = 0;
    let rises = 0;
    for (let s = 4 + 12; s <= e.len - 4; s += 12) {
      const p = ctx.network.sample(e, s - 12);
      const q = ctx.network.sample(e, s);
      const d = (ctx.heightAt(q.x, q.z) - ctx.heightAt(p.x, p.z)) * (dir > 0 ? -1 : 1);
      if (d < -0.3) rises++;
      steepest = Math.max(steepest, d / 12);
    }
    if (rises > 1 || steepest > DESCENT_MAX_STEP) continue;
    // Enter late enough that the run ENDS at the bottom: SF grades steepen as
    // they fall, so the last 100u is the part worth filming.
    const sStart = Math.max(4, e.len - 4 - DESCENT_RUN);
    const score = grade * run + steepest * 200;
    if (score > bestScore) {
      bestScore = score;
      best = { edge: e, dir, sStart, grade, steepest };
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// A street near a named monument — the "you are driving actual San Francisco"
// shots. The scout layer cannot resolve landmark names (world/landmarks.ts
// pulls in THREE), so the caller passes the resolved position.
//
// This replaces a `scoutShore` that looked for a waterfront edge by district
// character. The Embarcadero at the Ferry Building classifies as the Financial
// District, so that scout could never find the shot it was written for and put
// the trailer's "the city is real" beat in China Basin, looking at sheds.
// Anchoring on the monument instead is exact by construction.

export type NearRun = {
  readonly edge: NetEdge;
  /** Travel direction whose FAR end is nearer the anchor — drive toward it. */
  readonly dir: 1 | -1;
  readonly dist: number; // closest approach of the edge to the anchor
};

export function scoutRunNear(
  ctx: ScoutCtx,
  x: number,
  z: number,
  opts: { radius: number; minLen: number; minHalf: number },
): NearRun | null {
  let best: NearRun | null = null;
  let bestScore = -Infinity;
  for (const e of ctx.network.edges) {
    if (!edgeInPlayArea(e)) continue;
    if (e.len < opts.minLen || e.half < opts.minHalf) continue;
    if (straightness(e) < 0.93) continue;
    let dist = Infinity;
    for (let s = 0; s <= e.len; s += 5) {
      const p = ctx.network.sample(e, s);
      dist = Math.min(dist, Math.hypot(p.x - x, p.z - z));
    }
    if (dist > opts.radius) continue;
    const a = ctx.network.sample(e, 0);
    const b = ctx.network.sample(e, e.len);
    const dir: 1 | -1 = Math.hypot(b.x - x, b.z - z) <= Math.hypot(a.x - x, a.z - z) ? 1 : -1;
    // Long and wide enough to drive, but proximity is what puts the monument
    // in frame — a 250u boulevard 80u away is a worse shot than an 80u one
    // that runs past the door.
    const score = e.len * e.half - dist * 12;
    if (score > bestScore) {
      bestScore = score;
      best = { edge: e, dir, dist };
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Plow street — a long flat straight run whose KERBS are real land.
//
// The demolition beat relocates a row of parked cars to the curb offset. Taking
// the widest boulevard by score put that row on the China Basin shoreline,
// where "right of travel" is open bay: every car seated at the water height and
// sank, and the beat played as an empty crossing. Dry kerb, both sides, is a
// hard requirement — the travel direction is chosen later (sun avoidance).

export function scoutPlowRun(ctx: ScoutCtx, minLen = 230): RunSpot | null {
  let best: RunSpot | null = null;
  let bestScore = 0;
  for (const e of ctx.network.edges) {
    if (!edgeInPlayArea(e)) continue;
    if (e.len < minLen || e.half < 4.6 || straightness(e) < 0.95) continue;
    const curb = Math.max(2.6, e.half - 1.6);
    let ok = true;
    for (let s = 0; s <= e.len && ok; s += 6) {
      const p = ctx.network.sample(e, s);
      if (s >= 6) {
        const q = ctx.network.sample(e, s - 6);
        if (Math.abs(ctx.heightAt(p.x, p.z) - ctx.heightAt(q.x, q.z)) / 6 > 0.05) ok = false;
      }
      // A punted car cartwheels off the kerb, so the strip BEYOND it has to be
      // land too — probe out to twice the curb offset.
      for (const side of [1, -1] as const) {
        for (const d of [curb, curb * 2]) {
          if (waterAt(p.x + p.tz * d * side, p.z - p.tx * d * side)) ok = false;
        }
      }
    }
    if (!ok) continue;
    const score = e.len * e.half;
    if (score > bestScore) {
      bestScore = score;
      best = { edge: e, dir: 1 };
    }
  }
  return best;
}

/** Open water at a world point — the trailer uses it to put a locked-off
 *  camera on the BAY side of a shoreline street without hard-coding compass
 *  directions into a scene. */
export function isWaterAt(x: number, z: number): boolean {
  return waterAt(x, z);
}

// ---------------------------------------------------------------------------
// Signalled 4-way downtown junctions (queued cross-traffic tableau).

export type Approach = {
  readonly edge: NetEdge;
  readonly dirToNode: 1 | -1;
  readonly tx: number; // travel direction TOWARD the node
  readonly tz: number;
  readonly axisX: boolean;
  readonly run: number; // usable straight approach length
};

export type JunctionSpot = {
  readonly node: number;
  readonly x: number;
  readonly z: number;
  readonly approaches: readonly Approach[];
};

export function scoutSignalJunctions(ctx: ScoutCtx, max = 10): JunctionSpot[] {
  // Signalled blocks in this bake are SHORT: the best 4-way junction has
  // ~45u of straight approach per axis, most sit near 34 — so the arm gate
  // is 26u and junctions are RANKED (dense district, then approach length)
  // rather than hard-filtered on downtown-scale runs that don't exist.
  const net = ctx.network;
  const out: { spot: JunctionSpot; q: number; dense: boolean }[] = [];
  for (let node = 0; node < net.nodes.length; node++) {
    const pos = net.nodes[node];
    if (!pos || !inPlayArea(pos[0], pos[1])) continue;
    if (junctionControl(net, node) !== "signal") continue;
    if (controlArms(net, node).length < 4) continue;
    const approaches: Approach[] = [];
    for (const id of net.nodeEdges[node] ?? []) {
      const e = net.edges[id];
      // The ARM needs the guard too, not just the node it hangs off: a take
      // queues cross-traffic up to `run` (90u) back along it while the node
      // gate only keeps 60u. No signalled junction in this bake sits within
      // 230u of the margin, so this drops nothing today — it stops the node
      // guard from resting on that coincidence. Same rule scoutCorners uses.
      if (!e || !edgeInPlayArea(e) || e.len < 30) continue;
      const ends: (1 | -1)[] = [];
      if (e.b === node) ends.push(1);
      if (e.a === node) ends.push(-1);
      for (const dirToNode of ends) {
        const sNear = dirToNode > 0 ? Math.max(0, e.len - 10) : Math.min(10, e.len);
        const smp = net.sample(e, sNear);
        approaches.push({
          edge: e,
          dirToNode,
          tx: smp.tx * dirToNode,
          tz: smp.tz * dirToNode,
          axisX: Math.abs(smp.tx) > Math.abs(smp.tz),
          run: Math.min(e.len - 12, 90),
        });
      }
    }
    const xRuns = approaches.filter((a) => a.axisX && a.run >= 26).map((a) => a.run);
    const zRuns = approaches.filter((a) => !a.axisX && a.run >= 26).map((a) => a.run);
    if (xRuns.length < 2 || zRuns.length < 2) continue;
    xRuns.sort((a, b) => b - a);
    zRuns.sort((a, b) => b - a);
    out.push({
      spot: { node, x: pos[0], z: pos[1], approaches },
      q: Math.min(xRuns[1] ?? 0, zRuns[1] ?? 0),
      dense: DENSE.has(districtAtWorld(pos[0], pos[1])),
    });
  }
  out.sort((a, b) => (a.dense === b.dense ? b.q - a.q : a.dense ? -1 : 1));
  // Dedupe spatially so takes don't reuse a block.
  const picked: JunctionSpot[] = [];
  for (const { spot } of out) {
    if (picked.some((p) => Math.hypot(p.x - spot.x, p.z - spot.z) < 150)) continue;
    picked.push(spot);
    if (picked.length >= max) break;
  }
  return picked;
}

// ---------------------------------------------------------------------------
// Freeway proximity — corner/fixed-cam scenes must not stage under the
// elevated viaduct (pillars + deck slice through the shot).

export function nearFreeway(x: number, z: number, r = 34): boolean {
  const r2 = r * r;
  for (const f of SF_FREEWAYS) {
    for (let i = 0; i + 3 < f.p.length; i += 2) {
      const ax = f.p[i] ?? 0;
      const az = f.p[i + 1] ?? 0;
      const bx = f.p[i + 2] ?? 0;
      const bz = f.p[i + 3] ?? 0;
      const dx = bx - ax;
      const dz = bz - az;
      const len2 = dx * dx + dz * dz || 1;
      const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / len2));
      const px = ax + dx * t - x;
      const pz = az + dz * t - z;
      if (px * px + pz * pz < r2) return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// 90° corners with straight legs — drift-shot geometry.

export type CornerSpot = {
  readonly node: number;
  readonly x: number;
  readonly z: number;
  readonly inArm: Approach; // travel toward the node
  readonly outArm: Approach; // travel AWAY from the node (tx/tz point away)
};

export function scoutCorners(ctx: ScoutCtx, max = 5): CornerSpot[] {
  const net = ctx.network;
  const found: CornerSpot[] = [];
  for (let node = 0; node < net.nodes.length; node++) {
    const pos = net.nodes[node];
    const ids = net.nodeEdges[node];
    if (!pos || !ids || ids.length < 2 || ids.length > 4) continue;
    if (!inPlayArea(pos[0], pos[1])) continue;
    if (!CORNER_OK.has(districtAtWorld(pos[0], pos[1]))) continue;
    const arms: Approach[] = [];
    for (const id of ids) {
      const e = net.edges[id];
      if (!e || !edgeInPlayArea(e)) continue;
      if (e.len < 46 || e.half < 4.0 || straightness(e) < 0.93) continue;
      const ends: (1 | -1)[] = [];
      if (e.b === node) ends.push(1);
      if (e.a === node) ends.push(-1);
      for (const dirToNode of ends) {
        const sNear = dirToNode > 0 ? Math.max(0, e.len - 10) : Math.min(10, e.len);
        const smp = net.sample(e, sNear);
        arms.push({
          edge: e,
          dirToNode,
          tx: smp.tx * dirToNode,
          tz: smp.tz * dirToNode,
          axisX: Math.abs(smp.tx) > Math.abs(smp.tz),
          run: Math.min(e.len - 12, 80),
        });
      }
    }
    for (const a of arms) {
      for (const b of arms) {
        if (a === b || a.edge === b.edge) continue;
        // a arrives at the node; b leaves it. Perpendicular pair only.
        const dot = a.tx * -b.tx + a.tz * -b.tz;
        if (Math.abs(dot) > 0.3) continue;
        if (a.run < 46 || b.run < 42) continue;
        found.push({
          node,
          x: pos[0],
          z: pos[1],
          inArm: a,
          outArm: { ...b, tx: -b.tx, tz: -b.tz }, // point away from the node
        });
      }
    }
  }
  const picked: CornerSpot[] = [];
  for (const c of found) {
    if (picked.some((p) => Math.hypot(p.x - c.x, p.z - c.z) < 160)) continue;
    picked.push(c);
    if (picked.length >= max) break;
  }
  return picked;
}

// ---------------------------------------------------------------------------
// Golden Gate deck start — mirrors buildGoldenGate's anchor hunt exactly
// (world/golden-gate.ts) so the trailer start sits on the real deck.

export type GateSpot = {
  readonly x: number; // deck centreline
  readonly shoreZ: number;
  readonly rampTopZ: number; // deck begins here, running north (-Z)
  readonly deckY: number;
};

export function scoutGoldenGate(ctx: ScoutCtx): GateSpot | null {
  let anchor: { gx: number; gz: number } | null = null;
  for (let gx = 0; gx < GRID_X; gx++) {
    const wx = worldX(gx);
    const u = wx / WORLD_W + 0.5;
    if (u < 0.19 || u > 0.35) continue;
    for (let gz = 8; gz < GRID_Z; gz++) {
      if (ctx.plan.cells[gx]?.[gz] !== "road") continue;
      if (!anchor || gz < anchor.gz) anchor = { gx, gz };
      break;
    }
  }
  if (!anchor) return null;
  const ax = worldX(anchor.gx);
  const shoreZ = worldZ(anchor.gz);
  const shoreH = ctx.heightAt(ax, shoreZ) + 0.04;
  const endZ = -WORLD_HALF_Z + 3.5;
  const span = shoreZ - endZ;
  const rampLen = Math.min(Math.max(span * 0.6, 10), 26);
  const deckY = Math.min(7, shoreH + rampLen * 0.36);
  return { x: ax, shoreZ, rampTopZ: shoreZ - rampLen, deckY };
}

// ---------------------------------------------------------------------------
// Freeway mainline run (elevated deck, drivable trimesh).
//
// The deck profile and the barrier rules below MIRROR world/freeways.ts. That
// module owns the geometry but builds it with THREE and never exports its
// lines, and scout.ts stays headless — so the parts a staged shot depends on
// are reproduced here. Keep the FW_* constants in sync with it: drift shows up
// as the trailer staging the car inside a wall.

const FW_STEP = 6; // freeways.ts STEP — centreline resample pitch
const FW_CLEAR = 7.4; // CLEAR + DECK_T — deck TOP above local terrain
const FW_MAX_CLEAR = 13.9; // MAX_CLEAR + DECK_T — ceiling on that clearance
const FW_SLEW = 0.72; // STEP * MAX_GRADE — profile slew per sample
const FW_RAIL_INSET = 0.5; // barrier inner face, inboard of the deck edge
const FW_MERGE_GROW = 1.0; // otherDeckAt() grow that suppresses a barrier
const FW_MERGE_DY = 1.5; // ...and the height window it suppresses within
const FW_GROUND_RUN = 96; // GROUND_RUN — hanging ends glide down to street grade
const FW_CELL = 24; // sample-hash bucket (freeways.ts CELL)

// Staging gates on top of the mirrored geometry.
const FW_MIN_RUN = 150; // shortest usable clean stretch
const FW_MIN_FREE = 9; // barrier-free lateral corridor the car needs
const FW_FREE_CAP = 12; // corridor probe range — anything wider is "open"
const FW_MAX_TURN = (3 * Math.PI) / 180; // heading change per sample
const FW_SELF_GAP = 4; // samples apart before two points count as "doubled back"

export type FreewayRun = {
  /** Resampled centreline points in travel order, ~6u pitch. */
  readonly pts: readonly (readonly [number, number])[];
  readonly deckYAt: (x: number, z: number) => number;
  /** Deck top — the surface the wheels rest on, profiled the way freeways.ts
   *  profiles it (local ground + clearance, then the slew) rather than
   *  `deckYAt`'s ground max over a 60u disc. `deckYAt` reads high on anything
   *  but dead-flat ground, so a chassis staged from it drops onto the deck ON
   *  CAMERA — physics does not advance under a cut.
   *
   *  NOT exact against the trimesh, because `ScoutCtx.heightAt` is normally
   *  the DRIVE surface while freeways.ts reads raw terrain: measured along the
   *  mainlines those disagree by −0.67u (street depression) to +2.24u (street
   *  terrace). The upward slew swallows most of it — the current pick reads
   *  0.216u LOW at its staging sample — but budget ±0.3u, and note LOW is the
   *  awkward direction (a chassis seated from it starts compressed). Passing
   *  raw terrain as `ScoutCtx.heightAt` removes the residual entirely.
   *
   *  A resting chassis belongs at `deckTopAt(x, z) + 0.68` (ride height); mind
   *  that TrailerStage.placeCar adds its own +1.4 to the y it is handed. */
  readonly deckTopAt: (x: number, z: number) => number;
};

type Ribbon = {
  readonly half: number;
  readonly pts: readonly (readonly [number, number])[];
  readonly ys: readonly number[]; // deck TOP per sample
};

type DeckSample = { x: number; z: number; y: number; half: number; line: number };
/** A barrier's inner face — the lateral edge of drivable deck. */
type Wall = { x: number; z: number; y: number };

const cellKey = (cell: number, x: number, z: number): string =>
  `${Math.floor(x / cell)},${Math.floor(z / cell)}`;

function pushCell<T>(map: Map<string, T[]>, key: string, v: T): void {
  const arr = map.get(key);
  if (arr) arr.push(v);
  else map.set(key, [v]);
}

/** Every entry in the 3×3 bucket neighbourhood around (x, z). */
function* nearCells<T>(map: Map<string, T[]>, cell: number, x: number, z: number): Generator<T> {
  const bx = Math.floor(x / cell);
  const bz = Math.floor(z / cell);
  for (let ix = bx - 1; ix <= bx + 1; ix++) {
    for (let iz = bz - 1; iz <= bz + 1; iz++) {
      for (const v of map.get(`${ix},${iz}`) ?? []) yield v;
    }
  }
}

/** freeways.ts resample(), including its "keep the final source point" tail —
 *  sample indices have to line up with the deck it builds. */
function resampleFreeway(p: readonly number[]): [number, number][] {
  const src: [number, number][] = [];
  for (let i = 0; i + 1 < p.length; i += 2) src.push([p[i] ?? 0, p[i + 1] ?? 0]);
  if (src.length < 2) return [];
  const pts: [number, number][] = [src[0] ?? [0, 0]];
  let carry = 0;
  for (let i = 1; i < src.length; i++) {
    const [ax, az] = src[i - 1] ?? [0, 0];
    const [bx, bz] = src[i] ?? [0, 0];
    const seg = Math.hypot(bx - ax, bz - az);
    let t = FW_STEP - carry;
    while (t <= seg) {
      pts.push([ax + ((bx - ax) * t) / seg, az + ((bz - az) * t) / seg]);
      t += FW_STEP;
    }
    carry = (carry + seg) % FW_STEP;
  }
  const last = src[src.length - 1];
  const tail = pts[pts.length - 1];
  if (last && tail && Math.hypot(last[0] - tail[0], last[1] - tail[1]) > FW_STEP * 0.4) {
    pts.push([last[0], last[1]]);
  }
  return pts;
}

/** Unit lateral (left of travel) at a sample, matching the rails freeways.ts
 *  lays out from the same central-difference tangent. */
function lateralAt(r: Ribbon, i: number): readonly [number, number] {
  const [px, pz] = r.pts[Math.max(0, i - 1)] ?? [0, 0];
  const [qx, qz] = r.pts[Math.min(r.pts.length - 1, i + 1)] ?? [0, 0];
  const tl = Math.hypot(qx - px, qz - pz) || 1;
  return [-(qz - pz) / tl, (qx - px) / tl];
}

/** Mainline deck profile, mirroring freeways.ts buildData: ground + clearance,
 *  then its two iterated passes — a CAPPED upward slew (the deck glides over
 *  dips, but each sample's rise is bounded by its own MAX_CLEAR ceiling) and a
 *  downward settle that lowers over-steep pairs. Its dead-end GROUNDING is
 *  deliberately NOT modelled — the last FW_GROUND_RUN of every polyline is
 *  excluded from staging instead, which is strictly more conservative. The one
 *  residual is that freeways.ts reads RAW terrain here and ctx.heightAt is
 *  usually the drive surface — see FreewayRun.deckTopAt.
 *
 *  The cap and the slew constant are not optional detail. Without the ceiling
 *  the dilation is unbounded, and a single hilltop dragged the whole ribbon up
 *  with it: measured on the staged mainline this profile read 36.8 where the
 *  deck is 7.7, so the trailer spawned its car 29u in the air and dropped it
 *  through the first second of the shot. FW_SLEW had drifted too (0.3 against
 *  the current STEP * MAX_GRADE of 0.72). */
function buildRibbons(ctx: ScoutCtx): Ribbon[] {
  const out: Ribbon[] = [];
  for (const f of SF_FREEWAYS) {
    const pts = resampleFreeway(f.p);
    if (pts.length < 2) continue;
    const ground = pts.map(([x, z]) => ctx.heightAt(x, z));
    const ys = ground.map((h) => h + FW_CLEAR);
    const ceil = ground.map((h) => h + FW_MAX_CLEAR);
    const sweep = (step: (i: number, from: number) => void): boolean => {
      let moved = false;
      const wrap = (i: number, from: number): void => {
        const before = ys[i] ?? 0;
        step(i, from);
        if (Math.abs((ys[i] ?? 0) - before) > 1e-4) moved = true;
      };
      for (let i = 1; i < ys.length; i++) wrap(i, ys[i - 1] ?? 0);
      for (let i = ys.length - 2; i >= 0; i--) wrap(i, ys[i + 1] ?? 0);
      return moved;
    };
    for (let pass = 0; pass < 8; pass++) {
      const moved = sweep((i, from) => {
        const want = Math.min(ceil[i] ?? 0, from - FW_SLEW);
        if (want > (ys[i] ?? 0) + 1e-4) ys[i] = want;
      });
      if (!moved) break;
    }
    for (let pass = 0; pass < 24; pass++) {
      const moved = sweep((i, from) => {
        const want = Math.max((ground[i] ?? 0) + FW_CLEAR, from + FW_SLEW);
        if (want < (ys[i] ?? 0) - 1e-4) ys[i] = want;
      });
      if (!moved) break;
    }
    out.push({ half: f.half, pts, ys });
  }
  return out;
}

/** Barrier inner faces that actually get built, hashed for lateral probing.
 *  freeways.ts suppresses a rail wherever ANOTHER ribbon's deck covers it at
 *  the same height — that is how the two carriageways of one freeway fuse into
 *  a single wide surface. `li === self` is skipped there, so a polyline that
 *  doubles back on ITSELF keeps both walls, ~0.7u apart, standing on the deck
 *  the trailer would otherwise stage on. */
function buildWalls(ribbons: readonly Ribbon[]): Map<string, Wall[]> {
  const decks = new Map<string, DeckSample[]>();
  ribbons.forEach((r, line) => {
    for (let i = 0; i < r.pts.length; i++) {
      const [x, z] = r.pts[i] ?? [0, 0];
      pushCell(decks, cellKey(FW_CELL, x, z), { x, z, y: r.ys[i] ?? 0, half: r.half, line });
    }
  });
  const covered = (x: number, z: number, y: number, self: number): boolean => {
    for (const d of nearCells(decks, FW_CELL, x, z)) {
      if (d.line === self) continue;
      if (Math.abs(d.y - y) > FW_MERGE_DY) continue;
      if (Math.hypot(d.x - x, d.z - z) < d.half + FW_MERGE_GROW) return true;
    }
    return false;
  };
  const walls = new Map<string, Wall[]>();
  ribbons.forEach((r, line) => {
    for (let i = 0; i < r.pts.length; i++) {
      const [x, z] = r.pts[i] ?? [0, 0];
      const y = r.ys[i] ?? 0;
      const [lx, lz] = lateralAt(r, i);
      for (const side of [1, -1] as const) {
        if (covered(x + lx * r.half * side, z + lz * r.half * side, y, line)) continue;
        const o = (r.half - FW_RAIL_INSET) * side;
        const wx = x + lx * o;
        const wz = z + lz * o;
        pushCell(walls, cellKey(FW_CELL, wx, wz), { x: wx, z: wz, y });
      }
    }
  });
  return walls;
}

/** Barrier-free width across the deck at one sample. Walls are sampled every
 *  FW_STEP along their own ribbon, so whatever the crossing angle at least one
 *  sample of a wall spanning this cross-section lands within half a step of
 *  it. */
function freeWidth(
  walls: Map<string, Wall[]>,
  x: number,
  z: number,
  y: number,
  lx: number,
  lz: number,
): number {
  let left = FW_FREE_CAP;
  let right = FW_FREE_CAP;
  for (const w of nearCells(walls, FW_CELL, x, z)) {
    if (Math.abs(w.y - y) > FW_MERGE_DY) continue; // a rail at another grade is not in the way
    const dx = w.x - x;
    const dz = w.z - z;
    if (Math.abs(dx * lz - dz * lx) > FW_STEP / 2) continue; // not at this cross-section
    const lat = dx * lx + dz * lz;
    if (lat >= 0) left = Math.min(left, lat);
    else right = Math.min(right, -lat);
  }
  return left + right;
}

/** Which samples of a ribbon a car can be staged on: inside the play area,
 *  clear of the grounded ends, straight, not doubled back on itself, and with
 *  a free corridor to weave in. */
function markStageable(r: Ribbon, walls: Map<string, Wall[]>): boolean[] {
  const n = r.pts.length;
  const selfGap = 2 * r.half + 4;
  const ok: boolean[] = [];
  for (let i = 0; i < n; i++) {
    const [x, z] = r.pts[i] ?? [0, 0];
    ok.push(false);
    if (!inPlayArea(x, z)) continue;
    if (Math.min(i, n - 1 - i) * FW_STEP < FW_GROUND_RUN) continue;
    const [ax, az] = r.pts[i - 1] ?? [0, 0];
    const [bx, bz] = r.pts[i + 1] ?? [0, 0];
    let turn = Math.atan2(bx - x, bz - z) - Math.atan2(x - ax, z - az);
    turn = Math.abs(((turn + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
    if (turn > FW_MAX_TURN) continue;
    let doubled = false;
    for (let j = 0; j < n && !doubled; j++) {
      if (Math.abs(j - i) < FW_SELF_GAP) continue;
      const [qx, qz] = r.pts[j] ?? [0, 0];
      doubled = Math.hypot(qx - x, qz - z) < selfGap;
    }
    if (doubled) continue;
    const [lx, lz] = lateralAt(r, i);
    if (freeWidth(walls, x, z, r.ys[i] ?? 0, lx, lz) < FW_MIN_FREE) continue;
    ok[i] = true;
  }
  return ok;
}

type RunCandidate = { pts: [number, number][]; tops: number[]; score: number };

/** Score one contiguous stageable stretch, oriented for the camera, or reject
 *  it as unusable. */
function evalRun(ctx: ScoutCtx, r: Ribbon, i: number, j: number): RunCandidate | null {
  const runLen = (j - i) * FW_STEP;
  if (runLen < FW_MIN_RUN) return null;
  const pts: [number, number][] = [];
  const tops: number[] = [];
  let hMin = Infinity;
  let hMax = -Infinity;
  for (let k = i; k <= j; k++) {
    const [x, z] = r.pts[k] ?? [0, 0];
    pts.push([x, z]);
    tops.push(r.ys[k] ?? 0);
    const h = ctx.heightAt(x, z);
    hMin = Math.min(hMin, h);
    hMax = Math.max(hMax, h);
  }
  // Flat ground below is no longer an accuracy crutch — deckTopAt models the
  // slew exactly now. It stays a FRAMING gate: a deck riding 10u of relief
  // porpoises the low chase cam through the whole cut.
  const flatness = hMax - hMin;
  if (flatness > 2.5) return null;
  // Prefer the run pointing INTO dense skyline.
  const head = pts[0] ?? [0, 0];
  const tail = pts[pts.length - 1] ?? [0, 0];
  const tailDense = DENSE.has(districtAtWorld(tail[0], tail[1]));
  const headDense = DENSE.has(districtAtWorld(head[0], head[1]));
  if (!tailDense && headDense) {
    pts.reverse();
    tops.reverse();
  }
  return { pts, tops, score: runLen - flatness * 40 + (tailDense || headDense ? 500 : 0) };
}

export function scoutFreeway(ctx: ScoutCtx): FreewayRun | null {
  const ribbons = buildRibbons(ctx);
  const walls = buildWalls(ribbons);
  let best: RunCandidate | null = null;
  for (const r of ribbons) {
    const ok = markStageable(r, walls);
    for (let i = 0; i < ok.length; i++) {
      if (!ok[i]) continue;
      let j = i;
      while (j + 1 < ok.length && ok[j + 1]) j++;
      const cand = evalRun(ctx, r, i, j);
      if (cand && (!best || cand.score > best.score)) best = cand;
      i = j;
    }
  }
  if (!best) return null;
  const pts = best.pts;
  const tops = best.tops;
  const deckYAt = (x: number, z: number): number => {
    let h = -Infinity;
    for (const [px, pz] of pts) {
      if (Math.hypot(px - x, pz - z) > 60) continue;
      h = Math.max(h, ctx.heightAt(px, pz));
    }
    if (h === -Infinity) h = ctx.heightAt(x, z);
    return h + FW_CLEAR;
  };
  const deckTopAt = (x: number, z: number): number => {
    // Nearest point on the run's centreline, profile interpolated along it.
    let bestD2 = Infinity;
    let y = tops[0] ?? 0;
    for (let i = 0; i + 1 < pts.length; i++) {
      const [ax, az] = pts[i] ?? [0, 0];
      const [bx, bz] = pts[i + 1] ?? [0, 0];
      const dx = bx - ax;
      const dz = bz - az;
      const t = Math.max(
        0,
        Math.min(1, ((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz || 1)),
      );
      const ex = ax + dx * t - x;
      const ez = az + dz * t - z;
      const d2 = ex * ex + ez * ez;
      if (d2 < bestD2) {
        bestD2 = d2;
        const y0 = tops[i] ?? 0;
        y = y0 + ((tops[i + 1] ?? 0) - y0) * t;
      }
    }
    return y;
  };
  return { pts, deckYAt, deckTopAt };
}

// ---------------------------------------------------------------------------
// Longest curbside row of parked cars near a dense district — the pileup toy.
// Runs in-game only (specs come from the built city's furniture pass).

export type ParkedRowSpec = { readonly x: number; readonly z: number; readonly yaw: number };

export type ParkedRow = {
  /** Row cars ordered along the row direction. */
  readonly cars: readonly ParkedRowSpec[];
  readonly tx: number; // unit row direction
  readonly tz: number;
};

export function scoutParkedRow(specs: readonly ParkedRowSpec[], minCars = 6): ParkedRow | null {
  let best: ParkedRow | null = null;
  for (let i = 0; i < specs.length; i++) {
    const s = specs[i];
    if (!s) continue;
    const tx = Math.sin(s.yaw);
    const tz = Math.cos(s.yaw);
    const row: { spec: ParkedRowSpec; along: number }[] = [];
    for (let j = 0; j < specs.length; j++) {
      const o = specs[j];
      if (!o) continue;
      const dx = o.x - s.x;
      const dz = o.z - s.z;
      const along = dx * tx + dz * tz;
      const lat = Math.abs(-dx * tz + dz * tx);
      if (lat > 1.7 || along < -2 || along > 80) continue;
      row.push({ spec: o, along });
    }
    if (row.length < minCars) continue;
    row.sort((a, b) => a.along - b.along);
    // Require the row to be gap-free enough to read as one line.
    let ok = true;
    for (let k = 1; k < row.length; k++) {
      const prev = row[k - 1];
      const cur = row[k];
      if (!prev || !cur) continue;
      if (cur.along - prev.along > 14) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;
    if (!best || row.length > best.cars.length) {
      best = { cars: row.map((r) => r.spec), tx, tz };
    }
  }
  return best;
}
