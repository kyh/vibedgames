import type { RigidBody } from "@dimforge/rapier3d-compat";
import * as THREE from "three";

import type { ModelCache } from "../assets/loader";
import { modelUrl, POLICE_CAR, SERVICE_CARS, TRAFFIC_CARS } from "../assets/manifest";
import type { PhysicsWorld } from "../physics/physics-world";
import { ROAD_TILE, ROAD_Y, TRAFFIC } from "../shared/constants";
import { Rng } from "../shared/rng";
import { type Dir, DIR_DELTA } from "../shared/types";
import type { CityModel, RoadCell } from "../world/city";
import { LANE_CENTER } from "../world/roads";
import { type DistrictChar, districtAt } from "../world/sf-map";
import { slopeQuaternion } from "../world/terrain";

const MODEL_YAW_OFFSET = 0; // Kenney cars face +Z; no offset (π drives rear-first)
const ALL_DIRS: readonly Dir[] = [0, 1, 2, 3];
const SCRATCH_N = new THREE.Vector3();
const OPPOSITE: Record<Dir, Dir> = { 0: 2, 1: 3, 2: 0, 3: 1 };

// --- Tunables (module-local; TRAFFIC in constants.ts holds count/speeds) ---
// Recycling: keep TRAFFIC.count cars, but teleport far-away ones ahead of the
// player so the streets stay busy without raising the car count.
const RECYCLE_TILES = 20; // Manhattan grid distance beyond which a car recycles
const RESPAWN_MIN_TILES = 6; // respawn ring, inclusive
const RESPAWN_MAX_TILES = 12;
const RESPAWN_GUARD_TILES = 4; // last-resort fallback: never this close to the player
// Vehicle mix (fractions of TRAFFIC.count, assigned deterministically by index).
const POLICE_SHARE = 0.08;
const SERVICE_SHARE = 0.14; // civilians take the remaining ~78%
const POLICE_SPEED_MULT = 1.25;
// Player reaction: brake + honk when the taxi bears down from ahead.
const REACT_RADIUS = 8; // world units
const REACT_DOT = 0.5; // cos threshold: travel dir vs. direction to the player
const BRAKE_FACTOR = 0.35; // speed multiplier while braking
const BRAKE_DURATION = 1.0; // seconds of braking after the last trigger
const HONK_COOLDOWN = 2.5; // seconds between honks per car
const BODY_LIFT = 0.8; // rigid-body centre above the mesh origin (wheels)
const WRECK_RESPAWN_S = 7; // a punted car rejoins the flow after this long
const BODY_OFFSET = new THREE.Vector3();

export type VehicleKind = "civilian" | "service" | "police";

// --- Diagonal-avenue spines ---
// A diagonal run is a degree-2 chain (no junctions inside), so a car entering
// one end MUST come out the other — no routing decisions exist inside. Cars
// therefore drive the run's straightened spine (the same line the markings
// are painted on) instead of per-cell beziers, which zigzagged.
type Spine = {
  readonly pts: readonly { x: number; z: number }[]; // edge-mid A … centres … edge-mid B
  readonly cum: readonly number[]; // cumulative arclength per point
  readonly total: number;
  readonly exitA: { gx: number; gz: number; dir: Dir } | null; // cell beyond end A
  readonly exitB: { gx: number; gz: number; dir: Dir } | null;
};

export type TrafficRoutes = {
  readonly spines: readonly Spine[];
  readonly cellSpine: ReadonlyMap<string, number>; // "gx,gz" → spine index
};

// Point + unit tangent at arclength s (measured from pts[0]).
function spineAt(sp: Spine, s: number): { x: number; z: number; tx: number; tz: number } {
  const pts = sp.pts;
  for (let i = 0; i + 1 < pts.length; i++) {
    const s0 = sp.cum[i] ?? 0;
    const s1 = sp.cum[i + 1] ?? 0;
    if (s > s1 && i + 2 < pts.length) continue;
    const a = pts[i];
    const b = pts[i + 1];
    if (!a || !b) break;
    const segLen = s1 - s0;
    const t = segLen > 1e-6 ? THREE.MathUtils.clamp((s - s0) / segLen, 0, 1) : 0;
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const dl = Math.hypot(dx, dz) || 1;
    return { x: a.x + dx * t, z: a.z + dz * t, tx: dx / dl, tz: dz / dl };
  }
  const last = pts[pts.length - 1];
  return { x: last?.x ?? 0, z: last?.z ?? 0, tx: 1, tz: 0 };
}

// Closest point on the spine to (x, z): arclength + local tangent.
function projectSpine(sp: Spine, x: number, z: number): { s: number; tx: number; tz: number } {
  let best = { s: 0, tx: 1, tz: 0 };
  let bd = Infinity;
  const pts = sp.pts;
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    if (!a || !b) continue;
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const l2 = dx * dx + dz * dz;
    const t = l2 > 1e-8 ? THREE.MathUtils.clamp(((x - a.x) * dx + (z - a.z) * dz) / l2, 0, 1) : 0;
    const px = a.x + dx * t;
    const pz = a.z + dz * t;
    const d = (px - x) * (px - x) + (pz - z) * (pz - z);
    if (d < bd) {
      bd = d;
      const dl = Math.sqrt(l2) || 1;
      best = { s: (sp.cum[i] ?? 0) + dl * t, tx: dx / dl, tz: dz / dl };
    }
  }
  return best;
}

// Build the spine table from the city plan (called once by Traffic).
function buildRoutes(city: CityModel): TrafficRoutes {
  const spines: Spine[] = [];
  const cellSpine = new Map<string, number>();
  const isRoad = (gx: number, gz: number): boolean => city.plan.cells[gx]?.[gz] === "road";
  const outNeighbor = (
    end: { gx: number; gz: number },
    inRun: { gx: number; gz: number },
  ): { gx: number; gz: number; dir: Dir } | null => {
    for (const d of [0, 1, 2, 3] as const) {
      const [dx, dz] = DIR_DELTA[d];
      const nx = end.gx + dx;
      const nz = end.gz + dz;
      if (!isRoad(nx, nz)) continue;
      if (nx === inRun.gx && nz === inRun.gz) continue;
      return { gx: nx, gz: nz, dir: d };
    }
    return null;
  };
  for (const run of city.plan.diagonalRuns) {
    const cells = run.cells;
    const first = cells[0];
    const second = cells[1];
    const last = cells[cells.length - 1];
    const beforeLast = cells[cells.length - 2];
    if (!first || !second || !last || !beforeLast) continue;
    const exitA = outNeighbor(first, second);
    const exitB = outNeighbor(last, beforeLast);
    const pts: { x: number; z: number }[] = [];
    if (exitA) {
      pts.push({
        x: (city.worldX(first.gx) + city.worldX(exitA.gx)) / 2,
        z: (city.worldZ(first.gz) + city.worldZ(exitA.gz)) / 2,
      });
    }
    for (const p of run.spine) pts.push({ x: city.worldX(p.gx), z: city.worldZ(p.gz) });
    if (exitB) {
      pts.push({
        x: (city.worldX(last.gx) + city.worldX(exitB.gx)) / 2,
        z: (city.worldZ(last.gz) + city.worldZ(exitB.gz)) / 2,
      });
    }
    const cum: number[] = [0];
    for (let i = 0; i + 1 < pts.length; i++) {
      const a = pts[i];
      const b = pts[i + 1];
      cum.push((cum[i] ?? 0) + (a && b ? Math.hypot(b.x - a.x, b.z - a.z) : 0));
    }
    const idx = spines.length;
    spines.push({ pts, cum, total: cum[cum.length - 1] ?? 0, exitA, exitB });
    for (const c of cells) {
      const k = `${c.gx},${c.gz}`;
      if (!cellSpine.has(k)) cellSpine.set(k, idx); // split runs share a boundary cell
    }
  }
  return { spines, cellSpine };
}

// District spawn weight ×2 so "park ×0.5" stays an integer repeat count:
// downtown/highrise/commercial ×3, wharf ×2, res/victorian/industrial ×1, park ×0.5.
function districtSpawnWeight(c: DistrictChar): number {
  switch (c) {
    case "downtown":
    case "highrise":
    case "commercial":
      return 6;
    case "wharf":
      return 4;
    case "residential":
    case "victorian":
    case "industrial":
      return 2;
    case "park":
      return 1;
  }
}

export class TrafficCar {
  readonly object3D: THREE.Object3D;
  readonly kind: VehicleKind;
  readonly position = new THREE.Vector3();
  readonly radius = 1.35;
  hitCooldown = 0;
  missCooldown = 0;
  // Set on the brake-reaction rising edge; the game scene consumes it (plays a
  // honk) and clears it. Rate-limited to one honk per HONK_COOLDOWN per car.
  wantsHonk = false;
  // Rigid body (kinematic on route, dynamic once punted by the taxi).
  body: RigidBody | null = null;
  wrecked = false;
  wreckTime = 0;
  puntCooldown = 0;
  private gx: number;
  private gz: number;
  // Cars route cell-to-cell on a quadratic bezier: entry-edge midpoint →
  // cell centre → exit-edge midpoint. `dir` is the direction of travel when
  // ENTERING the cell; `nextDir` (picked on entry, not on exit like the old
  // straight-line router) is where it leaves. Staircase diagonals become
  // smooth S-curves and junction turns read as real cornering, not pivots.
  private dir: Dir;
  private nextDir: Dir;
  private routeInited = false; // nextDir needs city+rng — resolved on first update
  private t = 0; // 0 entry edge .. 1 exit edge
  tanX = 0; // current path tangent (unit) — yaw, lane offset, react, following
  tanZ = 1;
  // Spine mode (diagonal avenues): index into routes.spines, arclength, and
  // travel sign (+1 = toward exitB). -1 index = normal cell routing.
  private spineIdx = -1;
  private spineS = 0;
  private spineSign: 1 | -1 = 1;
  followFactor = 1; // 0..1 speed clamp from the car ahead (set by Traffic)
  private readonly baseSpeed: number;
  private brakeTimer = 0;
  private honkCooldown = 0;
  private yaw = 0;
  private targetQuat = new THREE.Quaternion();

  constructor(
    object3D: THREE.Object3D,
    kind: VehicleKind,
    start: RoadCell,
    dir: Dir,
    speed: number,
    private routes: TrafficRoutes,
  ) {
    this.object3D = object3D;
    this.kind = kind;
    this.gx = start.gx;
    this.gz = start.gz;
    this.dir = dir;
    this.nextDir = dir;
    this.baseSpeed = speed;
  }

  respawn(cell: RoadCell, dir: Dir): void {
    this.gx = cell.gx;
    this.gz = cell.gz;
    this.dir = dir;
    this.nextDir = dir;
    this.routeInited = false;
    this.spineIdx = -1;
    this.t = 0;
    this.hitCooldown = 0;
    this.missCooldown = 0;
    this.brakeTimer = 0;
    this.honkCooldown = 0;
    this.wantsHonk = false;
    this.wrecked = false;
    this.wreckTime = 0;
    this.puntCooldown = 0;
  }

  // Engage spine mode: project the entry point onto the spine, travel in the
  // direction that agrees with the current motion.
  private enterSpine(idx: number, x: number, z: number, mx: number, mz: number): void {
    const sp = this.routes.spines[idx];
    if (!sp || sp.total < 1e-3) return;
    const proj = projectSpine(sp, x, z);
    const dot = proj.tx * mx + proj.tz * mz;
    // Perpendicular arrivals are side-street cars CROSSING the avenue at a
    // junction — they stay in cell mode and drive straight over.
    if (Math.abs(dot) < 0.5) return;
    this.spineIdx = idx;
    this.spineSign = dot >= 0 ? 1 : -1;
    this.spineS = dot >= 0 ? proj.s : sp.total - proj.s;
  }

  // Quadratic bezier through the cell: entry-edge mid → centre → exit-edge
  // mid. Position AND tangent are C¹-continuous across cells, so lane offset
  // and yaw rotate smoothly through every turn.
  private bezierPose(city: CityModel): { tx: number; tz: number; bx: number; bz: number } {
    const cx = city.worldX(this.gx);
    const cz = city.worldZ(this.gz);
    const [inx, inz] = DIR_DELTA[this.dir];
    const [outx, outz] = DIR_DELTA[this.nextDir];
    const h = ROAD_TILE / 2;
    const e0x = cx - inx * h;
    const e0z = cz - inz * h;
    const e1x = cx + outx * h;
    const e1z = cz + outz * h;
    const t = this.t;
    const s = 1 - t;
    const bx = s * s * e0x + 2 * s * t * cx + t * t * e1x;
    const bz = s * s * e0z + 2 * s * t * cz + t * t * e1z;
    let tx = s * (cx - e0x) + t * (e1x - cx);
    let tz = s * (cz - e0z) + t * (e1z - cz);
    const tl = Math.hypot(tx, tz);
    if (tl > 1e-4) {
      tx /= tl;
      tz /= tl;
    } else {
      // Degenerate U-turn midpoint (dead end): hold the exit direction.
      tx = outx;
      tz = outz;
    }
    return { tx, tz, bx, bz };
  }

  // The taxi hit this car: hand it to the physics world and SET its velocity.
  // (Impulses scaled by body.mass() silently no-op when the body is still
  // kinematic — mass reads 0 — which left punted cars glued in place.)
  punt(physics: PhysicsWorld, vx: number, vy: number, vz: number): void {
    const body = this.body;
    if (!body) return;
    if (!this.wrecked) {
      physics.makeDynamic(body);
      this.wrecked = true;
      this.wreckTime = 0;
    }
    const v = body.linvel();
    body.setLinvel({ x: v.x * 0.3 + vx, y: Math.max(v.y, vy), z: v.z * 0.3 + vz }, true);
  }

  private isRoad(city: CityModel, gx: number, gz: number): boolean {
    return city.plan.cells[gx]?.[gz] === "road";
  }

  // Exit direction from the CURRENT cell, given the arrival direction. Never
  // leaves the road network; reverses only at dead ends.
  private pickExit(city: CityModel, rng: Rng): Dir {
    const reverse = OPPOSITE[this.dir];
    const forward: Dir[] = [];
    for (const d of [0, 1, 2, 3] as const) {
      if (d === reverse) continue;
      const [dx, dz] = DIR_DELTA[d];
      if (this.isRoad(city, this.gx + dx, this.gz + dz)) forward.push(d);
    }
    if (forward.length === 0) return reverse;
    if (forward.includes(this.dir) && rng.chance(0.62)) return this.dir; // keep straight
    return rng.pick(forward);
  }

  update(dt: number, city: CityModel, rng: Rng, playerX: number, playerZ: number): void {
    if (this.hitCooldown > 0) this.hitCooldown -= dt;
    if (this.missCooldown > 0) this.missCooldown -= dt;
    if (this.honkCooldown > 0) this.honkCooldown -= dt;
    if (this.puntCooldown > 0) this.puntCooldown -= dt;

    // Wrecked: physics owns it — the mesh follows the body after the step
    // (syncFromBody), route logic pauses until the recycler respawns it.
    if (this.wrecked) {
      this.wreckTime += dt;
      return;
    }

    // Resolve the first route choice lazily (needs city+rng, which the
    // constructor/respawn don't have). Spawns on a diagonal avenue go
    // straight into spine mode.
    if (!this.routeInited) {
      this.routeInited = true;
      const spIdx = this.routes.cellSpine.get(`${this.gx},${this.gz}`);
      if (spIdx !== undefined) {
        const [mx, mz] = DIR_DELTA[this.dir];
        this.enterSpine(spIdx, city.worldX(this.gx), city.worldZ(this.gz), mx, mz);
      } else {
        this.nextDir = this.pickExit(city, rng);
      }
    }

    // --- Player reaction: taxi close AND roughly ahead → brake, honk once ---
    if (dt > 0) {
      const dx = playerX - this.position.x;
      const dz = playerZ - this.position.z;
      const distSq = dx * dx + dz * dz;
      if (distSq > 1e-6 && distSq < REACT_RADIUS * REACT_RADIUS) {
        if (this.tanX * dx + this.tanZ * dz > REACT_DOT * Math.sqrt(distSq)) {
          if (this.brakeTimer <= 0 && this.honkCooldown <= 0) {
            this.wantsHonk = true; // rising edge only, cooldown-gated
            this.honkCooldown = HONK_COOLDOWN;
          }
          this.brakeTimer = BRAKE_DURATION;
        }
      }
      if (this.brakeTimer > 0) this.brakeTimer -= dt;
    }

    // Car-following: hold behind a same-direction car ahead (Traffic sets
    // followFactor each frame) so traffic never stacks into one spot.
    const brakeMul = this.brakeTimer > 0 ? BRAKE_FACTOR : 1;
    const speed = this.baseSpeed * Math.min(brakeMul, this.followFactor);

    let tx: number;
    let tz: number;
    let bx: number;
    let bz: number;
    if (this.spineIdx >= 0) {
      // --- Spine mode: straight down the avenue centreline. ---
      this.spineS += speed * dt;
      const sp = this.routes.spines[this.spineIdx];
      if (!sp) {
        this.spineIdx = -1;
        return;
      }
      if (this.spineS >= sp.total) {
        // Off the far end: hand back to cell routing at the exit cell.
        const leftover = this.spineS - sp.total;
        const exit = this.spineSign > 0 ? sp.exitB : sp.exitA;
        const endPt = this.spineSign > 0 ? sp.pts[sp.pts.length - 1] : sp.pts[0];
        this.spineIdx = -1;
        if (exit && endPt) {
          this.gx = exit.gx;
          this.gz = exit.gz;
          this.dir = exit.dir;
          const nIdx = this.routes.cellSpine.get(`${this.gx},${this.gz}`);
          if (nIdx !== undefined) {
            // Split runs share boundary cells — flow straight into the next.
            const [mx, mz] = DIR_DELTA[exit.dir];
            this.enterSpine(nIdx, endPt.x, endPt.z, mx, mz);
            this.spineS += leftover;
          } else {
            this.nextDir = this.pickExit(city, rng);
            this.t = leftover / ROAD_TILE;
          }
        } else {
          // Dead-ended spine (shouldn't happen): bounce back the way we came.
          this.spineSign = this.spineSign > 0 ? -1 : 1;
          this.spineS = leftover;
          this.spineIdx = this.routes.spines.indexOf(sp);
        }
      }
      if (this.spineIdx >= 0) {
        const cur = this.routes.spines[this.spineIdx];
        if (!cur) return;
        const sAct = this.spineSign > 0 ? this.spineS : cur.total - this.spineS;
        const at = spineAt(cur, sAct);
        tx = at.tx * this.spineSign;
        tz = at.tz * this.spineSign;
        bx = at.x;
        bz = at.z;
        // Track the grid cell for the recycler's distance bookkeeping.
        this.gx = city.gridX(bx);
        this.gz = city.gridZ(bz);
      } else {
        // Just exited — fall through to a bezier pose in the exit cell.
        ({ tx, tz, bx, bz } = this.bezierPose(city));
      }
    } else {
      this.t += (speed * dt) / ROAD_TILE;
      while (this.t >= 1) {
        this.t -= 1;
        const step = this.nextDir;
        const [dx, dz] = DIR_DELTA[step];
        const pgx = this.gx;
        const pgz = this.gz;
        this.gx += dx;
        this.gz += dz;
        this.dir = step;
        const spIdx = this.routes.cellSpine.get(`${this.gx},${this.gz}`);
        if (spIdx !== undefined) {
          // Entered a diagonal avenue: engage at the shared edge midpoint.
          const ex = (city.worldX(pgx) + city.worldX(this.gx)) / 2;
          const ez = (city.worldZ(pgz) + city.worldZ(this.gz)) / 2;
          this.enterSpine(spIdx, ex, ez, dx, dz);
          this.spineS += this.t * ROAD_TILE;
          this.t = 0;
          break;
        }
        this.nextDir = this.pickExit(city, rng);
      }
      if (this.spineIdx >= 0) {
        const cur = this.routes.spines[this.spineIdx];
        if (!cur) return;
        const sAct = this.spineSign > 0 ? this.spineS : cur.total - this.spineS;
        const at = spineAt(cur, sAct);
        tx = at.tx * this.spineSign;
        tz = at.tz * this.spineSign;
        bx = at.x;
        bz = at.z;
      } else {
        ({ tx, tz, bx, bz } = this.bezierPose(city));
      }
    }
    this.tanX = tx;
    this.tanZ = tz;
    // Keep right of the yellow line (lane centre from the street profile).
    const px = bx - tz * LANE_CENTER;
    const pz = bz + tx * LANE_CENTER;
    // Axle-composite ground height — centre-only sampling buries the
    // nose/tail on convex hill crests.
    const gy = Math.max(
      city.terrain.heightAt(px, pz),
      (city.terrain.heightAt(px + tx * 1.2, pz + tz * 1.2) +
        city.terrain.heightAt(px - tx * 1.2, pz - tz * 1.2)) /
        2,
    );
    this.position.set(px, gy + ROAD_Y, pz);
    this.object3D.position.copy(this.position);

    const targetYaw = Math.atan2(tx, tz) + MODEL_YAW_OFFSET;
    let d = ((targetYaw - this.yaw + Math.PI) % (Math.PI * 2)) - Math.PI;
    if (d < -Math.PI) d += Math.PI * 2;
    this.yaw += d * Math.min(1, dt * 8);
    const n = city.terrain.normalInto(SCRATCH_N, px, pz);
    slopeQuaternion(this.targetQuat, this.yaw, n);
    // Slerp instead of snapping — terrain-normal jitter reads as suspension.
    if (dt === 0) this.object3D.quaternion.copy(this.targetQuat);
    else this.object3D.quaternion.slerp(this.targetQuat, Math.min(1, dt * 10));

    // Drag the kinematic body along the route (it shoves wrecks aside).
    if (this.body) {
      this.body.setNextKinematicTranslation({
        x: this.position.x,
        y: this.position.y + BODY_LIFT,
        z: this.position.z,
      });
      const q = this.object3D.quaternion;
      this.body.setNextKinematicRotation({ x: q.x, y: q.y, z: q.z, w: q.w });
    }
  }

  // After the physics step: wrecked meshes follow their rigid bodies.
  syncFromBody(): void {
    const body = this.body;
    if (!body || !this.wrecked) return;
    const t = body.translation();
    const r = body.rotation();
    this.object3D.quaternion.set(r.x, r.y, r.z, r.w);
    BODY_OFFSET.set(0, BODY_LIFT, 0).applyQuaternion(this.object3D.quaternion);
    this.object3D.position.set(t.x - BODY_OFFSET.x, t.y - BODY_OFFSET.y, t.z - BODY_OFFSET.z);
    this.position.copy(this.object3D.position);
  }
}

export type TrafficOpts = { seed?: number; avoid?: RoadCell; avoidR?: number };

export class Traffic {
  readonly group = new THREE.Group();
  readonly cars: TrafficCar[] = [];
  private rng: Rng;

  private city: CityModel;
  private readonly routes: TrafficRoutes;
  // Road cells repeated by district weight — built once, sampled by index so
  // spawn/respawn picks are district-weighted with zero per-pick allocation.
  private readonly weightedCells: RoadCell[] = [];
  private readonly industrialCells: RoadCell[] = []; // garbage-truck home turf

  constructor(
    cache: ModelCache,
    city: CityModel,
    opts: TrafficOpts = {},
    private physics: PhysicsWorld | null = null,
  ) {
    this.city = city;
    this.routes = buildRoutes(city);
    this.rng = new Rng(opts.seed ?? 99);

    for (const cell of city.roadCells) {
      const character = districtAt(cell.gx, cell.gz).character;
      const w = districtSpawnWeight(character);
      for (let i = 0; i < w; i++) this.weightedCells.push(cell);
      if (character === "industrial") this.industrialCells.push(cell);
    }

    const avoid = opts.avoid;
    const avoidR = opts.avoidR ?? 4;
    const count = TRAFFIC.count;
    for (let i = 0; i < count && this.weightedCells.length > 0; i++) {
      // Deterministic mix by index: ~8% police, ~14% service, rest civilian.
      let kind: VehicleKind;
      let model: string;
      if (i < count * POLICE_SHARE) {
        kind = "police";
        model = POLICE_CAR;
      } else if (i < count * (POLICE_SHARE + SERVICE_SHARE)) {
        kind = "service";
        model = this.rng.pick(SERVICE_CARS);
      } else {
        kind = "civilian";
        model = this.rng.pick(TRAFFIC_CARS);
      }
      // Garbage trucks prefer industrial streets when the map offers them.
      const pool =
        model === "garbage-truck" && this.industrialCells.length > 0
          ? this.industrialCells
          : this.weightedCells;
      let cell: RoadCell | undefined;
      // A few attempts for a spawn cell clear of already-placed cars.
      for (let attempt = 0; attempt < 4; attempt++) {
        cell =
          this.pickCell(
            pool,
            avoid?.gx ?? 0,
            avoid?.gz ?? 0,
            avoid ? avoidR : -1,
            Infinity,
            0,
            0,
            false,
          ) ??
          this.pickCell(
            this.weightedCells,
            avoid?.gx ?? 0,
            avoid?.gz ?? 0,
            avoid ? avoidR : -1,
            Infinity,
            0,
            0,
            false,
          );
        if (!cell || this.cellClearOfCars(cell, null)) break;
      }
      if (!cell) break;
      const obj = cache.instance(modelUrl("cars", model));
      this.group.add(obj);
      const dir = this.rng.pick(ALL_DIRS);
      const speed =
        this.rng.range(TRAFFIC.minSpeed, TRAFFIC.maxSpeed) *
        (kind === "police" ? POLICE_SPEED_MULT : 1);
      const car = new TrafficCar(obj, kind, cell, dir, speed, this.routes);
      car.update(0, city, this.rng, 0, 0); // place it (dt=0 skips reaction)
      if (this.physics) {
        car.body = this.physics.createCarBody(
          car.position.x,
          car.position.y + BODY_LIFT,
          car.position.z,
        );
      }
      this.cars.push(car);
    }
  }

  // Pick a random cell from `pool` whose Manhattan grid distance to (pgx, pgz)
  // is in (minExcl, maxIncl], optionally restricted to the (hx, hz) forward
  // half-plane. Two passes (count, then select) — no allocation.
  private pickCell(
    pool: readonly RoadCell[],
    pgx: number,
    pgz: number,
    minExcl: number,
    maxIncl: number,
    hx: number,
    hz: number,
    forwardOnly: boolean,
  ): RoadCell | undefined {
    let count = 0;
    for (const c of pool) {
      if (this.cellOk(c, pgx, pgz, minExcl, maxIncl, hx, hz, forwardOnly)) count++;
    }
    if (count === 0) return undefined;
    let k = this.rng.int(count);
    for (const c of pool) {
      if (!this.cellOk(c, pgx, pgz, minExcl, maxIncl, hx, hz, forwardOnly)) continue;
      if (k === 0) return c;
      k--;
    }
    return undefined;
  }

  private cellOk(
    c: RoadCell,
    pgx: number,
    pgz: number,
    minExcl: number,
    maxIncl: number,
    hx: number,
    hz: number,
    forwardOnly: boolean,
  ): boolean {
    const dgx = c.gx - pgx;
    const dgz = c.gz - pgz;
    const d = Math.abs(dgx) + Math.abs(dgz);
    if (d <= minExcl || d > maxIncl) return false;
    return !forwardOnly || dgx * hx + dgz * hz > 0;
  }

  // Respawn target for a recycled car: a road cell 6–12 tiles ahead of the
  // player; else any cell in that ring; else anywhere clear of the player.
  private respawnCell(pgx: number, pgz: number, hx: number, hz: number): RoadCell | undefined {
    return (
      this.pickCell(
        this.weightedCells,
        pgx,
        pgz,
        RESPAWN_MIN_TILES - 1,
        RESPAWN_MAX_TILES,
        hx,
        hz,
        true,
      ) ??
      this.pickCell(
        this.weightedCells,
        pgx,
        pgz,
        RESPAWN_MIN_TILES - 1,
        RESPAWN_MAX_TILES,
        hx,
        hz,
        false,
      ) ??
      this.pickCell(this.weightedCells, pgx, pgz, RESPAWN_GUARD_TILES, Infinity, hx, hz, false)
    );
  }

  // Scatter traffic back across the map, clear of the player's spawn, so a
  // restart never drops the taxi on top of a car.
  reset(avoid?: RoadCell, avoidR = 4): void {
    if (this.weightedCells.length === 0) return;
    for (const c of this.cars) {
      const cell = avoid
        ? (this.pickCell(this.weightedCells, avoid.gx, avoid.gz, avoidR, Infinity, 0, 0, false) ??
          this.rng.pick(this.weightedCells))
        : this.rng.pick(this.weightedCells);
      c.respawn(cell, this.rng.pick(ALL_DIRS));
      c.update(0, this.city, this.rng, 0, 0);
      this.restoreBody(c);
    }
  }

  // Put a (possibly wrecked) car's rigid body back into kinematic route mode.
  private restoreBody(c: TrafficCar): void {
    if (!c.body || !this.physics) return;
    this.physics.makeKinematic(c.body);
    this.physics.teleport(
      c.body,
      c.position.x,
      c.position.y + BODY_LIFT,
      c.position.z,
      c.object3D.quaternion,
    );
  }

  // Player heading: forward = (sin h, cos h) in XZ. Cars that drift beyond
  // RECYCLE_TILES are teleported into the ring ahead of the player, keeping
  // streets busy at a constant car count.
  update(
    dt: number,
    city: CityModel,
    playerX: number,
    playerZ: number,
    playerHeading: number,
  ): void {
    const pgx = city.gridX(playerX);
    const pgz = city.gridZ(playerZ);
    const hx = Math.sin(playerHeading);
    const hz = Math.cos(playerHeading);

    // Car-following separation: hold behind a same-direction car (or a wreck)
    // ahead in the same lane, so cars can never stack on top of each other.
    // Oncoming traffic (opposite lane, ~4u lateral) is excluded by the lane
    // width check and the direction dot.
    for (const c of this.cars) c.followFactor = 1;
    for (let i = 0; i < this.cars.length; i++) {
      const a = this.cars[i];
      if (!a || a.wrecked) continue;
      for (let j = 0; j < this.cars.length; j++) {
        const b = this.cars[j];
        if (!b || a === b) continue;
        const dx = b.position.x - a.position.x;
        const dz = b.position.z - a.position.z;
        const ahead = dx * a.tanX + dz * a.tanZ;
        if (ahead > 7) continue;
        if (ahead < 0.5) {
          // Coincident/stacked pair (bad spawn): brake exactly ONE of the two
          // (index tiebreak) so the other drives clear instead of deadlocking.
          if (Math.hypot(dx, dz) < 2 && i > j) a.followFactor = 0;
          continue;
        }
        const lat = Math.abs(-dx * a.tanZ + dz * a.tanX);
        if (lat > 2.2) continue;
        if (!b.wrecked && b.tanX * a.tanX + b.tanZ * a.tanZ < 0.3) continue;
        a.followFactor = Math.min(a.followFactor, ahead < 3.5 ? 0 : 0.45);
      }
    }

    for (const c of this.cars) {
      const d = Math.abs(city.gridX(c.position.x) - pgx) + Math.abs(city.gridZ(c.position.z) - pgz);
      // Wrecks rejoin the flow once they've had their moment (or drift far).
      const recycleWreck = c.wrecked && c.wreckTime > WRECK_RESPAWN_S;
      if (d > RECYCLE_TILES || recycleWreck) {
        // Retry a few times for a cell clear of other cars — respawning onto
        // an occupied cell is how overlapping cars were born.
        let cell = this.respawnCell(pgx, pgz, hx, hz);
        for (let attempt = 0; attempt < 4 && cell && !this.cellClearOfCars(cell, c); attempt++) {
          cell = this.respawnCell(pgx, pgz, hx, hz);
        }
        if (cell) {
          c.respawn(cell, this.rng.pick(ALL_DIRS));
          c.update(0, city, this.rng, 0, 0);
          this.restoreBody(c);
        }
      }
      c.update(dt, city, this.rng, playerX, playerZ);
    }
  }

  // No other car within ~1.5 tiles of the cell centre.
  private cellClearOfCars(cell: RoadCell, self: TrafficCar | null): boolean {
    const x = this.city.worldX(cell.gx);
    const z = this.city.worldZ(cell.gz);
    for (const c of this.cars) {
      if (c === self) continue;
      if (Math.hypot(c.position.x - x, c.position.z - z) < ROAD_TILE * 1.5) return false;
    }
    return true;
  }

  // Called after the physics step: wrecked meshes follow their bodies.
  syncWrecked(): void {
    for (const c of this.cars) c.syncFromBody();
  }
}
