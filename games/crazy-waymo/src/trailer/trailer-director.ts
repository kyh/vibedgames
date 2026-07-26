// trailer-director.ts — CRAZY WAYMO gameplay trailer (?trailer=1).
//
// Twelve staged scenes of REAL gameplay: every car is the live Traffic fleet,
// every crash is Rapier, every pickup runs the normal FareManager event path.
// The director owns three things per scene: WHERE (scouted deterministically
// from the baked world — see scout.ts), the SCRIPT (a scripted CarInput driven
// by a pursuit controller — reactive, so nondeterministic physics can't break
// a shot), and the CAMERA (a different composition per scene: rig chase, side
// whip-by, dolly, fixed corner, front-reverse, rising pull-back).
//
// Loaded lazily from main.ts only under ?trailer=1 — dead code otherwise.

import * as THREE from "three";
import type { PlayerMap } from "@vibedgames/multiplayer";

import type { GameScene, TrailerStage } from "../scenes/game-scene";
import type { TrafficCar } from "../game/traffic";
import type { CarInput } from "../vehicle/car";
import type { CityModel, RoadCell } from "../world/city";
import type { NetEdge } from "../world/network";
import { districtAt } from "../world/sf-map";
import {
  type Approach,
  type CornerSpot,
  type CrestSpot,
  type FreewayRun,
  type GateSpot,
  type JunctionSpot,
  type ScoutCtx,
  type ShoreSpot,
  edgeInPlayArea,
  nearFreeway,
  scoutArterial,
  scoutCorners,
  scoutCrests,
  scoutFreeway,
  scoutGoldenGate,
  scoutShore,
  scoutSignalJunctions,
} from "./scout";
import { runTrailer, type TrailerScene } from "./trailer-shell";

const clamp = THREE.MathUtils.clamp;
const wrapAngle = (a: number): number => ((a + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
const smooth = (f: number): number => f * f * (3 - 2 * f);

const NEUTRAL: CarInput = { throttle: 0, brake: 0, steer: 0, boost: false };

/** Every robotaxi livery the game ships (vehicle/car.ts ROBOTAXI_SKINS). All six
 *  GLBs are in the preload manifest and awaited before beginTrailer(), so the
 *  pack-race shot can mix them freely — an unknown id would silently fall back
 *  to a Waymo and the pack would read as one car six times. */
const SKIN_IDS = ["cruise", "zoox", "lyft", "uber", "cybercab", "waymo"] as const;

/** Day phase for the drift beat. Shared, because pickCorners rejects corners
 *  whose exit street stares into the sun — and that test is only meaningful if
 *  it runs at the phase the shot is actually lit at. The two used to disagree
 *  (corner chosen for 0.40, scene shot at 0.465). 0.44 also keeps the Victorian
 *  block off the floor: at 0.465 the sun is 2 degrees up and a two-storey
 *  street reads as near-night, which buries a shot whose whole subject is a
 *  smoke plume. */
const DRIFT_PHASE = 0.44;

type Pt = readonly [number, number];

// ---------------------------------------------------------------------------
// Polyline path: the rabbit every scripted drive pursues.

class Path {
  private readonly pts: Pt[];
  private readonly cum: number[];

  constructor(pts: readonly Pt[]) {
    this.pts = [...pts];
    this.cum = [0];
    let acc = 0;
    for (let i = 1; i < this.pts.length; i++) {
      const a = this.pts[i - 1] ?? [0, 0];
      const b = this.pts[i] ?? [0, 0];
      acc += Math.hypot(b[0] - a[0], b[1] - a[1]);
      this.cum.push(acc);
    }
  }

  get length(): number {
    return this.cum[this.cum.length - 1] ?? 0;
  }

  /** Append a straight run along the final tangent — overrun room so the
   *  rabbit never stalls at the end of an edge mid-shot. */
  extend(dist: number): this {
    const n = this.pts.length;
    const a = this.pts[n - 2] ?? [0, 0];
    const b = this.pts[n - 1] ?? [0, 1];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    const tx = (b[0] - a[0]) / len;
    const tz = (b[1] - a[1]) / len;
    this.pts.push([b[0] + tx * dist, b[1] + tz * dist]);
    this.cum.push(this.length + dist);
    return this;
  }

  at(s: number): { x: number; z: number; tx: number; tz: number } {
    const sc = clamp(s, 0, this.length);
    let i = 1;
    while (i < this.pts.length - 1 && (this.cum[i] ?? 0) < sc) i++;
    const s0 = this.cum[i - 1] ?? 0;
    const s1 = this.cum[i] ?? s0 + 1;
    const a = this.pts[i - 1] ?? [0, 0];
    const b = this.pts[i] ?? a;
    const f = clamp((sc - s0) / Math.max(1e-4, s1 - s0), 0, 1);
    const dx = b[0] - a[0];
    const dz = b[1] - a[1];
    const dl = Math.hypot(dx, dz) || 1;
    return { x: a[0] + dx * f, z: a[1] + dz * f, tx: dx / dl, tz: dz / dl };
  }

  /** Arclength of the nearest sampled point, biased forward past `sMin`. */
  project(x: number, z: number, sMin = 0): number {
    let best = Math.max(0, sMin);
    let bd = Infinity;
    for (let i = 0; i < this.pts.length; i++) {
      const s = this.cum[i] ?? 0;
      if (s < sMin - 6) continue;
      const p = this.pts[i] ?? [0, 0];
      const d = (p[0] - x) * (p[0] - x) + (p[1] - z) * (p[1] - z);
      if (d < bd) {
        bd = d;
        best = s;
      }
    }
    return best;
  }
}

// ---------------------------------------------------------------------------

type FakeCar = { s: number; lane: number; speed: number };

const settle = (ms = 180): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function setDisplay(id: string, show: boolean): void {
  const el = document.getElementById(id);
  if (el) el.style.display = show ? "" : "none";
}

class Director {
  private stage: TrailerStage | null = null;
  private readonly city: CityModel;
  private readonly ctx: ScoutCtx;

  // Scouted once — the baked world is deterministic, so these never change.
  private readonly boulevards: { edge: NetEdge; dir: 1 | -1 }[];
  private readonly arterial: { edge: NetEdge; dir: 1 | -1 };
  private readonly crests: CrestSpot[];
  private readonly shore: ShoreSpot | null;
  private readonly freeway: FreewayRun | null;
  private readonly fareCorner: CornerSpot | null;
  private readonly driftCorner: CornerSpot | null;
  private readonly junctions: JunctionSpot[];
  private readonly gate: GateSpot | null;

  // Per-scene scratch — base() wipes all of it before every setup.
  private path: Path | null = null;
  private pathS = 0;
  private weaveOffset = 0;
  private weaveAmp = 2.5;
  private kickSpeed: number | null = null;
  private camYaw: number | null = null;
  private shake = 0;
  private step = 0;
  private substituted = false;
  private fakes: FakeCar[] = [];
  private sceneNode = new THREE.Vector2(); // active junction/corner centre
  private sceneDir = new THREE.Vector2(); // active travel direction
  private sceneAux = new THREE.Vector2(); // scene-specific extra vector
  private driftSide: 1 | -1 = 1;
  // Set when the first user gesture lands before the stage exists — the
  // request is replayed the moment staging opens (see ensureStage).
  private audioPending = false;

  constructor(private readonly game: GameScene) {
    const city = game.getCity();
    if (!city) throw new Error("[trailer] city not built");
    this.city = city;
    this.ctx = {
      plan: city.plan,
      network: city.network,
      heightAt: (x, z) => city.heightAt(x, z),
    };
    this.boulevards = this.pickBoulevards(4);
    this.arterial = scoutArterial(this.ctx) ?? this.boulevard(0);
    this.crests = scoutCrests(this.ctx, 3);
    this.shore = scoutShore(this.ctx);
    this.freeway = scoutFreeway(this.ctx);
    const corners = this.pickCorners();
    this.fareCorner = corners.fare;
    this.driftCorner = corners.drift;
    this.junctions = scoutSignalJunctions(this.ctx, 10);
    this.gate = scoutGoldenGate(this.ctx);
    for (const [name, ok] of [
      ["crest", this.crests.length > 0],
      ["shore", this.shore !== null],
      ["freeway", this.freeway !== null],
      ["corner", this.fareCorner !== null],
      ["junction", this.junctions.length > 0],
      ["golden-gate", this.gate !== null],
    ] as const) {
      if (!ok) console.warn(`[trailer] scout found no ${name} — scene will substitute`);
    }
  }

  // ---- shared plumbing ------------------------------------------------------

  private ensureStage(): TrailerStage {
    if (this.stage) return this.stage;
    const stage = this.game.beginTrailer();
    if (!stage) throw new Error("[trailer] game not ready for beginTrailer()");
    this.stage = stage;
    if (this.audioPending) {
      this.audioPending = false;
      stage.unlockAudio();
    }
    return stage;
  }

  /** Engine, tyres and music, from the shell's first-gesture hook: the trailer
   *  rolls unattended, so an audio graph built at staging time would sit
   *  suspended. Safe before the stage exists — the unlock is replayed then. */
  unlockAudio(): void {
    const stage = this.stage;
    if (stage) stage.unlockAudio();
    else this.audioPending = true;
  }

  private base(opts: {
    phase: number;
    hud?: boolean;
    avoidX?: number;
    avoidZ?: number;
    avoidR?: number;
  }): TrailerStage {
    const st = this.ensureStage();
    st.setScriptedInput({ ...NEUTRAL });
    st.setFreecam(true);
    st.setFakePlayers(null);
    st.setDayPhase(opts.phase);
    st.cones.reset();
    st.restoreParked(); // fresh curb rows: replay/loop re-scouts the SAME row
    st.fares.setTrailerHold(true);
    // Every scene stages its fleet by hand — the recycler would otherwise
    // teleport far cars into a ring right AHEAD of the run mid-shot (chronic
    // rear-end punts on the piers/crest/jump takes).
    st.traffic.setHoldRecycle(true);
    if (opts.avoidX !== undefined && opts.avoidZ !== undefined) {
      st.traffic.reset(
        { gx: this.city.gridX(opts.avoidX), gz: this.city.gridZ(opts.avoidZ) },
        opts.avoidR ?? 8,
      );
    }
    st.car.boostMeter = 100;
    this.hudVisible(opts.hud === true);
    this.path = null;
    this.pathS = 0;
    this.weaveOffset = 0;
    this.weaveAmp = 2.5;
    this.kickSpeed = null;
    this.camYaw = null;
    this.shake = 0;
    this.step = 0;
    this.substituted = false;
    this.fakes = [];
    return st;
  }

  /** HUD policy: everything off; fare-run restores only the juicy layer
   *  (score, dial, fare card, combo/receipt) — nav chrome stays hidden. */
  private hudVisible(on: boolean): void {
    setDisplay("hud", on);
    setDisplay("netinfo", false);
    setDisplay("touch", false);
    for (const id of ["minimap", "area", "district", "dest-arrow"]) setDisplay(id, false);
  }

  /** The pre-roll: applied on the first visible frame (run t≈0) so the reveal
   *  opens at full speed with the suspension already settled — never a
   *  spawn-in, never a teleport bounce on camera. Scenes staged at rest (the
   *  fare pickup, the drift) hold NEUTRAL through the cut and take their whole
   *  speed here. */
  private reveal(): void {
    if (this.kickSpeed === null) return;
    this.stage?.setSpeed(this.kickSpeed);
    this.kickSpeed = null;
  }

  /** Scenes that hold boost longer than the meter lasts (100 units /
   *  34 u/s drain ≈ 2.9s) get an invisible mid-shot refill — otherwise the
   *  exhaust flames, boost trails and FOV kick collapse right in the middle
   *  of the cut. Only used where the HUD is hidden, so no meter pop on
   *  camera. */
  private topUpBoost(): void {
    const car = this.stage?.car;
    if (car && car.boostMeter < 40) car.boostMeter = 100;
  }

  /** When a scout came up empty the scene was re-staged as an arterial boost
   *  run — drive that instead of the scene's geometry-specific script. */
  private runSubstitute(dt: number): boolean {
    if (!this.substituted) return false;
    this.reveal();
    this.followPath(42, true, Math.min(dt, 50) / 1000);
    return true;
  }

  private applyInput(partial: Partial<CarInput>): void {
    this.stage?.setScriptedInput({ ...NEUTRAL, ...partial });
  }

  /** Pursuit controller: steer at a point, hold a speed. Steering is capped
   *  while braking so a slow-down can never accidentally arm the drift. */
  private driveAt(x: number, z: number, speed: number, boost = false): void {
    const st = this.stage;
    if (!st) return;
    const car = st.car;
    const err = wrapAngle(Math.atan2(x - car.position.x, z - car.position.z) - car.heading);
    let steer = clamp(-err * 2.4, -1, 1);
    const over = car.forwardSpeed - speed;
    const brake = over > 4 ? 0.8 : 0;
    if (brake > 0) steer = clamp(steer, -0.2, 0.2);
    this.applyInput({
      throttle: over < 0 ? 1 : 0,
      brake,
      steer,
      boost: boost && over < 2,
    });
  }

  /** Committed Mario-Kart drift: pedal + full steer in one direction. */
  private drift(dir: 1 | -1): void {
    this.applyInput({ brake: 1, steer: dir * 0.85 });
  }

  /** Follow this.path at a speed, optionally weaving around obstacles:
   *  aims for the side OPPOSITE the nearest obstacle ahead — reactive, so
   *  nondeterministic traffic can never be driven into. */
  private followPath(
    speed: number,
    boost: boolean,
    dts: number,
    obstacles?: readonly { x: number; z: number }[],
  ): void {
    const st = this.stage;
    const path = this.path;
    if (!st || !path) return;
    const car = st.car;
    this.pathS = path.project(car.position.x, car.position.z, this.pathS);
    let offset = 0;
    if (obstacles) offset = this.updateWeave(obstacles, dts);
    const look = path.at(this.pathS + 7 + car.speed * 0.28);
    this.driveAt(look.x + look.tz * offset, look.z - look.tx * offset, speed, boost);
  }

  private updateWeave(obstacles: readonly { x: number; z: number }[], dts: number): number {
    const path = this.path;
    if (!path) return 0;
    let want = 0;
    let bestAhead = Infinity;
    for (const o of obstacles) {
      const so = path.project(o.x, o.z, Math.max(0, this.pathS - 10));
      const ahead = so - this.pathS;
      if (ahead < 3 || ahead > 40 || ahead >= bestAhead) continue;
      const p = path.at(so);
      const lat = (o.x - p.x) * p.tz - (o.z - p.z) * p.tx;
      // Only near-lane obstacles steer the weave: project() snaps ANY car to
      // its nearest path sample, so a scattered fleet car 100u off to the
      // side would otherwise register "ahead" and jerk a phantom swerve.
      if (Math.abs(lat) > 6) continue;
      bestAhead = ahead;
      want = lat >= 0 ? -this.weaveAmp : this.weaveAmp;
    }
    this.weaveOffset += (want - this.weaveOffset) * Math.min(1, 6 * dts);
    return this.weaveOffset;
  }

  private cam(
    px: number,
    py: number,
    pz: number,
    tx: number,
    ty: number,
    tz: number,
    fov?: number,
  ): void {
    const st = this.stage;
    if (!st) return;
    st.camera.position.set(px, py, pz);
    st.camera.lookAt(tx, ty, tz);
    if (fov !== undefined && Math.abs(st.camera.fov - fov) > 0.01) {
      st.camera.fov = fov;
      st.camera.updateProjectionMatrix();
    }
  }

  /** Manual low chase — tighter and lower than the game rig, with handheld
   *  impact shake fed by real collisions (lastWallHit). */
  /** side: lateral camera offset in units, + = right of travel — used when
   *  the boost flame would otherwise eclipse the action dead ahead. */
  private chaseCam(
    dist: number,
    height: number,
    ahead: number,
    dts: number,
    fov: number,
    side = 0,
  ): void {
    const st = this.stage;
    if (!st) return;
    const car = st.car;
    this.camYaw =
      this.camYaw === null
        ? car.heading
        : this.camYaw + wrapAngle(car.heading - this.camYaw) * Math.min(1, 6 * dts);
    const fx = Math.sin(this.camYaw);
    const fz = Math.cos(this.camYaw);
    const rx = fz;
    const rz = -fx;
    this.shake = Math.max(0, this.shake - dts * 2.2);
    if (car.lastWallHit > 5) this.shake = Math.min(1, this.shake + 0.45);
    const s = this.shake * this.shake;
    const t = performance.now() / 1000;
    const px =
      car.position.x -
      fx * dist +
      rx * side +
      (Math.sin(t * 31) + Math.sin(t * 57) * 0.6) * s * 0.5;
    const py = car.position.y + height + (Math.sin(t * 43) + Math.sin(t * 71) * 0.6) * s * 0.35;
    const pz =
      car.position.z -
      fz * dist +
      rz * side +
      (Math.sin(t * 37) + Math.sin(t * 61) * 0.6) * s * 0.5;
    const minY = this.city.heightAt(px, pz) + 1.4;
    this.cam(
      px,
      Math.max(py, minY),
      pz,
      car.position.x + fx * ahead,
      car.position.y + 1.3,
      car.position.z + fz * ahead,
      fov,
    );
  }

  /** Tracking camera in the car's travel frame, for shots the low chase can't
   *  frame: cranes, side rakes, anything that has to hold scenery (water, a
   *  bridge tower, a skyline) in the same frame as the car.
   *
   *  Offsets are in units: `back`/`up`/`right` place the eye, `aheadOf`/
   *  `aimUp`/`aimRight` place the look-at, all relative to the car and its
   *  smoothed heading. `floorY` is an ABSOLUTE minimum eye height — pass the
   *  deck top on elevated shots, where city.heightAt reports the street 7u
   *  below and would happily let the eye sink through the roadway. */
  private trackCam(
    o: {
      back: number;
      up: number;
      right?: number;
      aheadOf: number;
      aimUp?: number;
      aimRight?: number;
      fov: number;
      floorY?: number;
      lag?: number;
    },
    dts: number,
  ): void {
    const st = this.stage;
    if (!st) return;
    const car = st.car;
    const lag = o.lag ?? 6;
    this.camYaw =
      this.camYaw === null
        ? car.heading
        : this.camYaw + wrapAngle(car.heading - this.camYaw) * Math.min(1, lag * dts);
    const fx = Math.sin(this.camYaw);
    const fz = Math.cos(this.camYaw);
    const rx = fz;
    const rz = -fx;
    const right = o.right ?? 0;
    const px = car.position.x - fx * o.back + rx * right;
    const pz = car.position.z - fz * o.back + rz * right;
    const floor = o.floorY ?? this.city.heightAt(px, pz) + 1.4;
    const aimRight = o.aimRight ?? 0;
    this.cam(
      px,
      Math.max(car.position.y + o.up, floor),
      pz,
      car.position.x + fx * o.aheadOf + rx * aimRight,
      car.position.y + (o.aimUp ?? 1.0),
      car.position.z + fz * o.aheadOf + rz * aimRight,
      o.fov,
    );
  }

  // ---- scouting helpers -----------------------------------------------------

  /** Horizontal direction TOWARD the sun at a pinned day phase. Tracks the
   *  day-night azimuth ramp over the trailer's daylight span (STOPS 0.25
   *  az150° → 0.40 az235° → 0.47 az248° — see render/day-night.ts). */
  private sunHorizontal(phase: number): { x: number; z: number } {
    const az =
      phase <= 0.4
        ? 150 + ((clamp(phase, 0.25, 0.4) - 0.25) / 0.15) * 85
        : 235 + ((Math.min(phase, 0.47) - 0.4) / 0.07) * 13;
    const r = (az * Math.PI) / 180;
    return { x: Math.sin(r), z: Math.cos(r) };
  }

  /** Flip a run's travel direction when it points INTO the sun — a chase cam
   *  looking down-sun renders the whole street as horizon glare. */
  private awayFromSun(edge: NetEdge, dir: 1 | -1, phase: number): 1 | -1 {
    const mid = this.city.network.sample(edge, edge.len / 2);
    const sun = this.sunHorizontal(phase);
    const toward = mid.tx * dir * sun.x + mid.tz * dir * sun.z;
    return toward > 0.25 ? (dir > 0 ? -1 : 1) : dir;
  }

  /** Long, wide, straight streets to drive, best first and spread across the
   *  map so consecutive shots never reuse one.
   *
   *  This replaces a bare longest-edge fallback that had NO criteria at all.
   *  scoutArterial returns null in this bake (its maxGrade <= 0.05 gate rejects
   *  the single candidate that survives the other filters), so that fallback is
   *  what actually staged the cold open and the demolition — and it picked the
   *  one edge in the network that runs 357u PAST the ground collider. The car
   *  free-fell through the world for both shots. Bounds are now non-negotiable:
   *  every vertex of the edge has to be somewhere the physics world exists. */
  private pickBoulevards(n: number): { edge: NetEdge; dir: 1 | -1 }[] {
    const scored: { edge: NetEdge; score: number; x: number; z: number }[] = [];
    for (const e of this.city.network.edges) {
      if (e.len < 150 || e.half < 4.4) continue;
      if (!edgeInPlayArea(e)) continue;
      const a = this.city.network.sample(e, 0);
      const b = this.city.network.sample(e, e.len);
      const straightness = Math.hypot(b.x - a.x, b.z - a.z) / e.len;
      if (straightness < 0.95) continue;
      const mid = this.city.network.sample(e, e.len / 2);
      scored.push({ edge: e, score: e.len * e.half * straightness, x: mid.x, z: mid.z });
    }
    scored.sort((p, q) => q.score - p.score);
    const out: { edge: NetEdge; dir: 1 | -1 }[] = [];
    const taken: { x: number; z: number }[] = [];
    for (const c of scored) {
      if (out.length >= n) break;
      if (taken.some((t) => Math.hypot(t.x - c.x, t.z - c.z) < 260)) continue;
      taken.push({ x: c.x, z: c.z });
      out.push({ edge: c.edge, dir: 1 });
    }
    if (out.length === 0) throw new Error("[trailer] no stageable boulevard in play area");
    return out;
  }

  /** boulevards[i], wrapping — so a scene can ask for "a different street" and
   *  still get something when the bake is thin. */
  private boulevard(i: number): { edge: NetEdge; dir: 1 | -1 } {
    const list = this.boulevards;
    const pick = list[i % list.length];
    if (!pick) throw new Error("[trailer] no stageable boulevard in play area");
    return pick;
  }

  private cornerFlat(c: CornerSpot): boolean {
    const h = this.city.heightAt(c.x, c.z);
    const hIn = this.city.heightAt(c.x - c.inArm.tx * 30, c.z - c.inArm.tz * 30);
    const hOut = this.city.heightAt(c.x + c.outArm.tx * 30, c.z + c.outArm.tz * 30);
    return Math.abs(hIn - h) < 2.4 && Math.abs(hOut - h) < 2.4;
  }

  private pickCorners(): { fare: CornerSpot | null; drift: CornerSpot | null } {
    const corners = scoutCorners(this.ctx, 8);
    // Corners under the elevated freeway stage fine but SHOOT terribly —
    // viaduct pillars and deck cut the fixed cam's sightline to the apex.
    const flat = corners.filter((c) => this.cornerFlat(c) && !nearFreeway(c.x, c.z));
    const fare =
      flat.find((c) => c.inArm.run >= 55 && c.outArm.run >= 40) ?? flat[0] ?? corners[0] ?? null;
    const rest = flat.filter(
      (c) => fare === null || (c !== fare && Math.hypot(c.x - fare.x, c.z - fare.z) > 150),
    );
    // The drift cam sits on the exit street looking BACK along -outArm; if
    // that stare lines up with the sun the whole cut is horizon glare — prefer
    // corners whose exit points away from it, at the phase the shot is lit at.
    const sun = this.sunHorizontal(DRIFT_PHASE);
    const sunOk = (c: CornerSpot): boolean => -(c.outArm.tx * sun.x + c.outArm.tz * sun.z) < 0.35;
    const isVic = (c: CornerSpot): boolean =>
      districtAt(this.city.gridX(c.x), this.city.gridZ(c.z)).character === "victorian";
    const drift =
      rest.find((c) => sunOk(c) && isVic(c)) ??
      rest.find(sunOk) ??
      rest.find(isVic) ??
      rest[0] ??
      fare;
    return { fare, drift };
  }

  /** Polyline down an edge in travel order; `lateral` > 0 shifts the line
   *  right-of-travel (a lane line instead of the centreline). */
  private edgePath(edge: NetEdge, dir: 1 | -1, extendBy = 0, lateral = 0): Path {
    const pts: Pt[] = [];
    const n = Math.max(2, Math.ceil(edge.len / 5));
    for (let i = 0; i <= n; i++) {
      const s = dir > 0 ? (edge.len * i) / n : edge.len * (1 - i / n);
      const smp = this.city.network.sample(edge, s);
      pts.push([smp.x + smp.tz * dir * lateral, smp.z - smp.tx * dir * lateral]);
    }
    const p = new Path(pts);
    if (extendBy > 0) p.extend(extendBy);
    return p;
  }

  /** The last N fleet cars (the police cruisers live at the front). */
  private stagedTraffic(n: number): TrafficCar[] {
    const st = this.stage;
    if (!st) return [];
    return st.traffic.cars.slice(Math.max(0, st.traffic.cars.length - n));
  }

  private placeTraffic(car: TrafficCar | undefined, edge: NetEdge, s: number, dir: 1 | -1): void {
    if (!car) return;
    this.stage?.traffic.placeCar(car, edge, clamp(s, 6, edge.len - 6), dir);
  }

  // ---- scenes ---------------------------------------------------------------

  /**
   * The cut. Three things drive the order:
   *
   * LIGHT. The game is at its best in the warm half of the cycle — flat noon
   * (0.25-0.35) renders the whole city milky and any heading near the sun
   * blows to white. So the trailer opens warm (0.42), sits in golden hour for
   * the verbs (0.465, where the street lamps are already up), drops to night
   * for the climax, and returns to gold for the closer. Two bands are banned
   * outright: 0.48-0.52 and 0.89-0.95, where day-night.ts lerps the shadow
   * direction as a VECTOR from sun to moon and the city casts full-strength
   * shadows from a light 15 degrees off the visible sun.
   *
   * CONTRAST. Nothing reads as fast when everything is fast. The three boost
   * shots (cold open, demolition, freeway) are spaced so each lands against a
   * slower neighbour, and the fare run deliberately drives at 20-24 u/s.
   *
   * CAMERA. Every consecutive pair changes grammar: chase, locked-off whip-by,
   * crane, the game's own rig, locked-off, chase, chase, front-reverse, chase,
   * locked-off, crane.
   */
  scenes(): TrailerScene[] {
    return [
      this.sceneColdOpen(), // chase        0.42  speed
      this.sceneHillAir(), // locked-off    0.42  air
      this.sceneWaterfront(), // crane      0.38  the city is real
      this.sceneFareRun(), // game rig      0.465 the loop
      this.sceneMontageDrift(), // locked   0.465 the drift
      this.scenePackRace(), // chase        0.465 other players
      this.sceneTrafficChaos(), // chase    0.44  physics
      this.sceneMontageSmash(), // reverse  0.44  physics
      this.sceneFreeway(), // chase         0.66  night city
      this.sceneNightRun(), // locked-off   0.70  night street
      this.sceneHeroDrive(), // crane       0.465 release
    ];
  }

  /** 1 — COLD OPEN: flat out down a downtown arterial, threading moving
   *  traffic on both sides. Game chase rig (speed crouch + FOV kick). */
  private sceneColdOpen(): TrailerScene {
    return {
      id: "cold-open-weave",
      // 3200, not 4500. The opening shot is one straight road at one speed;
      // past ~3s it has said everything it has to say and the trailer is just
      // waiting. Cutting it early is what makes the next cut land.
      duration: 3200,
      setup: async () => {
        const { edge } = this.arterial;
        // Glare beats skyline: drive away from the sun (the game rig stares
        // straight down the street — into-sun runs open the trailer white).
        const dir = this.awayFromSun(edge, this.arterial.dir, 0.42);
        // Ride the RIGHT LANE (not the centreline) and stage the traffic
        // ONCOMING in its own lane: every weave-based slalom variant tried
        // (both-sides, alternating, same-direction-only, three amplitudes)
        // eventually clipped a staged car — transient pursuit convergence
        // can't be trusted at 40 u/s. Parallel lanes need no dodging at all:
        // the whooshes close at ~55 u/s with a fixed ~4u lateral gap, which
        // reads as threading on camera and cannot end a take.
        const path = this.edgePath(edge, dir, 120, 2.1);
        const start = path.at(12);
        const st = this.base({ phase: 0.42, avoidX: start.x, avoidZ: start.z, avoidR: 3 });
        this.path = path;
        const cars = this.stagedTraffic(4);
        const sEdge = (travel: number): number => (dir > 0 ? travel : edge.len - travel);
        const oncoming = [70, 105, 140, 175];
        for (let i = 0; i < oncoming.length; i++) {
          const s = oncoming[i] ?? 70;
          // Skip depths past the edge — placeTraffic clamps, and clamped
          // placements would stack cars on the same end-of-edge spot.
          if (s < edge.len - 10) this.placeTraffic(cars[i], edge, sEdge(s), dir > 0 ? -1 : 1);
        }
        st.placeCar(start.x, start.z, Math.atan2(start.tx, start.tz), 0);
        this.applyInput({ throttle: 1 });
        await settle();
        this.kickSpeed = 28;
      },
      run: (t, dt) => {
        this.reveal();
        const st = this.stage;
        const path = this.path;
        if (!st || !path) return;
        const dts = Math.min(dt, 50) / 1000;
        // Open at speed but NOT on boost, then light it at ~1.1s. Held boost
        // from frame one gives a flat shot: the flame, the FOV kick and the
        // speed lines are all already at maximum, so the first three seconds of
        // the trailer have nowhere to go. Igniting on camera is the surge.
        const lit = t > 1100;
        if (lit) this.topUpBoost();
        const top = Math.min(lit ? 44 : 32, (path.length - 40) / 3.2);
        this.followPath(top, lit, dts);
        // The beat calls for a LOW rear chase — the game rig rides too high
        // and opens the trailer on sky wash; the manual chase hugs the car.
        this.chaseCam(10.5, 2.9, 11, dts, lit ? 62 : 56);
      },
    };
  }

  /** 2 — HILL AIR: crest the steepest scouted SF hill at speed, all four
   *  wheels off. Fixed low camera past the crest — the car launches at the
   *  lens, whips by and lands. */
  private sceneHillAir(): TrailerScene {
    return {
      id: "hill-air",
      // 2600. The whip-by lands around 65% of the cut; after it the fixed cam
      // swings downhill to follow, which at this phase points it straight into
      // the sun and blows the last half-second to white. Cut on the pass.
      duration: 2600,
      setup: async () => {
        const crest = this.crests[0];
        if (!crest) {
          // No crest scouted (should not happen in SF): boost run substitute.
          await this.substituteBoostRun(0.42);
          return;
        }
        const st = this.base({ phase: 0.42, avoidX: crest.x, avoidZ: crest.z, avoidR: 8 });
        const path = this.edgePath(crest.edge, crest.dir, 160);
        this.path = path;
        const sC = crest.dir > 0 ? crest.sCrest : crest.edge.len - crest.sCrest;
        const start = path.at(sC - 44);
        st.placeCar(start.x, start.z, Math.atan2(start.tx, start.tz), 0);
        // Camera 38u past the crest, low over the ROADWAY edge (the shoulder
        // line is lamp-post/tree territory — a trunk 1u from the lens fills
        // the frame once the car passes and the cam turns downhill). 38u puts
        // the whip-by at ~65% of the cut: launch silhouette → flight AT the
        // lens → landing bounce beside it → short tail.
        const p = path.at(sC + 38);
        this.sceneNode.set(p.x + p.tz * 2.5, p.z - p.tx * 2.5);
        this.sceneAux.set(this.city.heightAt(this.sceneNode.x, this.sceneNode.y) + 3.0, 0);
        this.applyInput({ throttle: 1, boost: true });
        await settle();
        this.kickSpeed = 32;
      },
      run: (_t, dt) => {
        if (this.runSubstitute(dt)) return;
        this.reveal();
        const st = this.stage;
        if (!st) return;
        this.followPath(46, true, Math.min(dt, 50) / 1000);
        const car = st.car.position;
        this.cam(
          this.sceneNode.x,
          this.sceneAux.x,
          this.sceneNode.y,
          car.x,
          car.y + 1.0,
          car.z,
          48,
        );
      },
    };
  }

  /** 3 — THE CITY IS REAL: the Embarcadero, shot so the bay is unmistakably in
   *  frame. The pitch for this game is that you are driving actual San
   *  Francisco, and the previous version of this shot rode 11u over the road
   *  raking 19u to the side — close enough to the deck that the shorefront
   *  sheds filled the frame and no water ever appeared. A crane 20u up aiming
   *  55u out over the water puts the bay and the horizon across the top of the
   *  frame with the car running the lower third. */
  private sceneWaterfront(): TrailerScene {
    return {
      id: "waterfront",
      duration: 2400,
      setup: async () => {
        const shore = this.shore;
        if (!shore) {
          await this.substituteBoostRun(0.38);
          return;
        }
        const path = this.edgePath(shore.edge, shore.dir, 100);
        // Start 30 in (not 10): the land-side dolly line at the edge mouth
        // runs through a 4-storey block — deeper in, the strip is low sheds
        // and the camera clears the rooflines.
        const start = path.at(30);
        // Scatter traffic clear of the run: the teleport otherwise leaves most
        // of the fleet >260u away and the recycler mass-respawns it 78-156u
        // AHEAD on the sparse wharf edges — a random rear-end punt mid-shot.
        const st = this.base({ phase: 0.38, avoidX: start.x, avoidZ: start.z, avoidR: 10 });
        this.path = path;
        st.placeCar(start.x, start.z, Math.atan2(start.tx, start.tz), 0);
        // Water side expressed RIGHT-of-travel, which is the frame trackCam
        // works in: left of travel is -right.
        this.driftSide = shore.waterLeft ? -1 : 1;
        // Staged at rest: NEUTRAL through the cut, full speed at reveal.
        await settle();
        this.kickSpeed = 36;
      },
      run: (_t, dt) => {
        if (this.runSubstitute(dt)) return;
        this.reveal();
        const st = this.stage;
        const path = this.path;
        if (!st || !path) return;
        const dts = Math.min(dt, 50) / 1000;
        // No boost here. This is the breath between the cold open and the fare
        // run, and the flame washes out the one shot whose job is the view.
        this.followPath(
          38,
          false,
          dts,
          st.traffic.cars.map((c) => c.position),
        );
        const water = this.driftSide;
        // Framing is a balancing act: rake far enough toward the bay to get
        // water in shot, but the car leaves frame the moment the aim swings
        // past the half-FOV. At 34u back a 20u lateral aim offset is only
        // atan(20/40) = 27 degrees, so with a 60-degree FOV the Waymo sits low
        // in the near corner and the bay fills the diagonal behind it. (Aiming
        // 55u out, as the first cut of this shot did, is 74 degrees off-axis —
        // a gorgeous empty postcard with no car anywhere in it.)
        this.trackCam(
          {
            back: 30,
            up: 16,
            right: -water * 8, // eye inland, over the sidewalk
            aheadOf: 6,
            aimRight: water * 20,
            aimUp: 1,
            fov: 60,
            lag: 3.2, // slow, so the crane drifts rather than snaps
          },
          dts,
        );
      },
    };
  }

  /** 9 — NIGHT CITY: the elevated viaduct at full boost, rival taxis running
   *  it with you, the lit skyline off to the side.
   *
   *  Shot at night for two reasons. Every clean, straight, elevated, downtown-
   *  facing run in this bake points at the sun all day long — the sun sits in
   *  the southern half from dawn to dusk and the viaducts run south-southwest —
   *  so a daylight version is either a white-out or a run pointed away from the
   *  skyline. After dark there is no sun to dodge, the city reads as a field of
   *  lit windows, and the player's headlights are the only real light source in
   *  frame, which suits a boost run down an empty deck.
   *
   *  Lane discipline is not optional up here. The car used to be placed on the
   *  scouted CENTRELINE, which on a self-doubling polyline is the inside of a
   *  1.75u barrier — the chassis spawned inside the wall and Rapier squeezed it
   *  into the 3u slot between carriageways for the whole cut. Staging now rides
   *  the painted lane centre, and `hold` lets the suspension settle under the
   *  black instead of dropping on camera. */
  private sceneFreeway(): TrailerScene {
    // Middle of the measured free corridor, not the painted centreline. The
    // scouted polyline is one carriageway of a twin deck: the inner rail is
    // suppressed where the two fuse, so the drivable width is lopsided (about
    // 4.7u one side, 12u the other) and the safe line sits well off centre.
    const LANE = 3.4;
    return {
      id: "freeway-night",
      duration: 2600,
      setup: async () => {
        const fw = this.freeway;
        if (!fw) {
          await this.substituteBoostRun(0.66);
          return;
        }
        const st = this.base({ phase: 0.66 });
        // Ride the lane, never the centreline: offset every sample right of
        // travel before the Path is built, so followPath's rabbit is already
        // in-lane and the weave swings around that instead of the paint.
        const pts: Pt[] = fw.pts.map((p, i) => {
          const q = fw.pts[Math.min(i + 1, fw.pts.length - 1)] ?? p;
          const r = fw.pts[Math.max(i - 1, 0)] ?? p;
          const tx = q[0] - r[0];
          const tz = q[1] - r[1];
          const l = Math.hypot(tx, tz) || 1;
          return [p[0] + (tz / l) * LANE, p[1] - (tx / l) * LANE];
        });
        const path = new Path(pts).extend(140);
        this.path = path;
        this.weaveAmp = 1.5;
        const start = path.at(14);
        const yaw = Math.atan2(start.tx, start.tz);
        // placeCar lifts whatever y it is given by 1.4, and a resting chassis
        // belongs at deckTop + 0.68 — so hand it deckTop - 0.72 and the car is
        // simply sitting on the deck. The old call passed deckYAt (which reads
        // high off a 60u ground max) straight through, spawning the car ~1.2u
        // in the air and dropping it on camera at t0.
        const deckTop = fw.deckTopAt(start.x, start.z);
        st.placeCar(start.x, start.z, yaw, 0, deckTop - 0.72);
        this.sceneAux.set(deckTop, 0); // deck Y, for the camera floor
        this.fakes = [0, 1, 2].map((i) => ({
          s: 46 + i * 26,
          lane: i % 2 === 0 ? 0 : -4.7, // in-lane beside us, or the far carriageway
          speed: 22 + i * 3,
        }));
        this.publishFakes(fw);
        this.applyInput({ throttle: 1, boost: true });
        await settle();
        this.kickSpeed = 38;
      },
      run: (_t, dt) => {
        if (this.runSubstitute(dt)) return;
        this.reveal();
        const st = this.stage;
        const path = this.path;
        const fw = this.freeway;
        if (!st || !path || !fw) return;
        this.topUpBoost();
        const dts = Math.min(dt, 50) / 1000;
        for (const f of this.fakes) f.s += f.speed * dts;
        this.publishFakes(fw);
        const obstacles = this.fakes.map((f) => {
          const p = path.at(f.s);
          return { x: p.x + p.tz * f.lane, z: p.z - p.tx * f.lane };
        });
        this.followPath(40, true, dts, obstacles);
        // city.heightAt up here is the STREET, 7u below the deck — the usual
        // chase-cam floor would happily let the eye sink through the roadway.
        // Pin it to the deck instead.
        this.trackCam(
          { back: 11, up: 2.9, aheadOf: 12, fov: 62, floorY: this.sceneAux.x + 2.2 },
          dts,
        );
      },
      teardown: () => this.stage?.setFakePlayers(null),
    };
  }

  /** 10 — NIGHT STREET: a locked-off low angle, the car sweeping past with its
   *  headlights doing the lighting. The one shot with no boost, no collision
   *  and no cargo — pure breath before the closer.
   *
   *  Traffic, parked cars and remote taxis carry no lights of their own in this
   *  engine (only the player has a real SpotLight), so a busy night street is a
   *  herd of dark blobs. This shot is staged deliberately empty and leans on
   *  the two things that DO read after dark: the headlight cone raking the
   *  facades, and the lamp glow the city bakes along every kerb. */
  private sceneNightRun(): TrailerScene {
    return {
      id: "night-street",
      duration: 1900,
      setup: async () => {
        const corner = this.driftCorner ?? this.fareCorner;
        if (!corner) {
          await this.substituteBoostRun(0.7);
          return;
        }
        const st = this.base({ phase: 0.7, avoidX: corner.x, avoidZ: corner.z, avoidR: 30 });
        const inA = corner.inArm;
        this.sceneNode.set(corner.x, corner.z);
        this.sceneDir.set(inA.tx, inA.tz);
        st.placeCar(corner.x - inA.tx * 52, corner.z - inA.tz * 52, Math.atan2(inA.tx, inA.tz), 0);
        // Locked off low and just off the kerb, looking back up the approach so
        // the car arrives head-on with its lights in the lens.
        const px = inA.tz;
        const pz = -inA.tx;
        this.sceneAux.set(corner.x - inA.tx * 8 + px * 5.5, corner.z - inA.tz * 8 + pz * 5.5);
        this.applyInput({ throttle: 1 });
        await settle();
        this.kickSpeed = 30;
      },
      run: (_t, dt) => {
        if (this.runSubstitute(dt)) return;
        this.reveal();
        const st = this.stage;
        if (!st) return;
        const node = this.sceneNode;
        const pT = this.sceneDir;
        this.driveAt(node.x + pT.x * 40, node.y + pT.y * 40, 34);
        const car = st.car.position;
        const camX = this.sceneAux.x;
        const camZ = this.sceneAux.y;
        this.cam(camX, this.city.heightAt(camX, camZ) + 1.5, camZ, car.x, car.y + 1.0, car.z, 50);
      },
    };
  }

  private publishFakes(fw: FreewayRun): void {
    const st = this.stage;
    const path = this.path;
    if (!st || !path) return;
    const players: PlayerMap = {};
    this.fakes.forEach((f, i) => {
      const p = path.at(f.s);
      const x = p.x + p.tz * f.lane;
      const z = p.z - p.tx * f.lane;
      players[`trailer-${i}`] = {
        id: `trailer-${i}`,
        state: {
          x,
          y: fw.deckYAt(x, z),
          z,
          h: Math.atan2(p.tx, p.tz),
          skin: "waymo",
          msg: "",
          msgAt: 0,
        },
      };
    });
    st.setFakePlayers(players);
  }

  /** 6 — the core loop as one continuous gameplay shot: board a staged
   *  customer, drift the corner, skid into the drop-off, confetti + receipt.
   *  Fare HUD on; game chase rig. */
  private sceneFareRun(): TrailerScene {
    return {
      id: "fare-run",
      duration: 4800,
      setup: async () => {
        const corner = this.fareCorner;
        if (!corner) {
          await this.substituteBoostRun(0.465);
          return;
        }
        const st = this.base({
          phase: 0.465,
          hud: true,
          avoidX: corner.x,
          avoidZ: corner.z,
          avoidR: 6,
        });
        const inA = corner.inArm;
        const outA = corner.outArm;
        this.sceneNode.set(corner.x, corner.z);
        this.sceneDir.set(outA.tx, outA.tz);
        const fromCell: RoadCell = {
          gx: this.city.gridX(corner.x - inA.tx * 20),
          gz: this.city.gridZ(corner.z - inA.tz * 20),
        };
        // Drop-off 40u out (was 30): at 30 the celebration parks right at the
        // corner-lot wall and the chase rig frames half the shot as blank
        // facade — mid-block keeps the confetti in the open street.
        const destCell: RoadCell = {
          gx: this.city.gridX(corner.x + outA.tx * 40),
          gz: this.city.gridZ(corner.z + outA.tz * 40),
        };
        st.fares.stageTrailerFare(fromCell, destCell, "medium");
        // Mid-run dashboard: a believable bankroll and a live combo chain.
        st.state.score = 2140;
        st.state.combo = 2;
        st.state.comboTimer = 8;
        st.hud.resetScore(2140);
        st.placeCar(corner.x - inA.tx * 44, corner.z - inA.tz * 44, Math.atan2(inA.tx, inA.tz), 0);
        st.setFreecam(false);
        // Staged at rest: NEUTRAL through the cut, full speed at reveal.
        await settle();
        this.kickSpeed = 20;
        st.snapCamera();
      },
      run: (t, dt) => {
        if (this.runSubstitute(dt)) return;
        this.reveal();
        const st = this.stage;
        if (!st) return;
        const car = st.car;
        const node = this.sceneNode;
        const exit = this.sceneDir;
        const carrying = st.fares.carryingInfo();
        if (this.step === 0) {
          // Seek the customer's curb beacon.
          if (carrying) this.step = 1;
          else {
            const obj = st.fares.objective();
            if (obj) this.driveAt(obj.pos.x, obj.pos.z, 21);
            else this.driveAt(node.x, node.y, 21);
          }
        }
        if (this.step === 1) {
          // Carry toward the corner; commit the drift when it opens.
          if (!carrying) this.step = 3;
          else {
            const dNode = Math.hypot(node.x - car.position.x, node.y - car.position.z);
            const exitPt = { x: node.x + exit.x * 22, z: node.y + exit.y * 22 };
            const err = wrapAngle(
              Math.atan2(exitPt.x - car.position.x, exitPt.z - car.position.z) - car.heading,
            );
            if (dNode < 15 && Math.abs(err) > 0.45 && car.forwardSpeed > 14) {
              this.driftSide = err < 0 ? 1 : -1;
              this.step = 2;
            } else {
              this.driveAt(node.x, node.y, 23);
            }
          }
        }
        if (this.step === 2) {
          if (!carrying) this.step = 3;
          else {
            const err = wrapAngle(
              Math.atan2(
                node.x + exit.x * 22 - car.position.x,
                node.y + exit.y * 22 - car.position.z,
              ) - car.heading,
            );
            this.drift(this.driftSide);
            if (Math.abs(err) < 0.22) this.step = 3;
          }
        }
        if (this.step === 3) {
          const target = carrying ? carrying.pos : null;
          if (!target && t > 2200) {
            this.step = 4; // delivered — celebrate
          } else if (target) {
            const d = Math.hypot(target.x - car.position.x, target.z - car.position.z);
            this.driveAt(target.x, target.z, d > 20 ? 24 : d > 12 ? 14 : 8);
          } else {
            this.driveAt(node.x + exit.x * 40, node.y + exit.y * 40, 18);
          }
        }
        if (this.step === 4) {
          // Roll to a stop on the confetti (never brake at standstill — that
          // is the reverse gear).
          this.applyInput(car.forwardSpeed > 1 ? { brake: 0.8 } : {});
        }
      },
      teardown: () => {
        this.hudVisible(false);
        this.stage?.fares.setTrailerHold(true);
      },
    };
  }

  /** 6 — OTHER PLAYERS: a pack of rival robotaxis running the same boulevard,
   *  the player threading up through them from the back.
   *
   *  Legibility is the whole job here — "multiplayer" has to read in three
   *  seconds with no text. Three things carry it: the pack is SIX DIFFERENT
   *  liveries (the game ships waymo/cruise/zoox/lyft/uber/cybercab and every
   *  GLB is preloaded before beginTrailer, so a mixed pack can never
   *  magenta-box); each carries the roof beacon RemoteCars gives every remote
   *  player, whose colour is a hash of the id, so the pack is a spread of
   *  distinct colours; and the player starts BEHIND and overtakes, so the shot
   *  is about them rather than a convoy driving in formation.
   *
   *  Remote cars are visual-only — no colliders — so the player passes THROUGH
   *  anything it touches. Lanes are laid out so that never has to happen on
   *  camera: the pack holds two lanes and the player threads the gap between.
   */
  private scenePackRace(): TrailerScene {
    return {
      id: "pack-race",
      duration: 3400,
      setup: async () => {
        const { edge } = this.boulevard(1);
        const dir = this.awayFromSun(edge, 1, 0.44);
        const path = this.edgePath(edge, dir, 140, 2.2);
        const start = path.at(10);
        // base() wipes the per-scene scratch, this.path included — assign after.
        // 0.44, not golden 0.465: this district reads near-night at 0.465 and
        // the whole point of the shot is telling six liveries apart.
        const st = this.base({ phase: 0.44, avoidX: start.x, avoidZ: start.z, avoidR: 12 });
        this.path = path;
        this.weaveAmp = 3.0;
        st.placeCar(start.x, start.z, Math.atan2(start.tx, start.tz), 0);
        // Tight and staggered, not strung out. The first cut spread the pack
        // 26-96u ahead, which put two distant rivals in frame and read as
        // ordinary traffic; the liveries only sell "other players" if several
        // are close enough to tell a Cruise from a Zoox from a Lyft. Starting
        // them 12-67u out with alternating lanes keeps three or four in shot
        // through the whole overtake. Speeds stay below the player's 42 so the
        // shot is a pass rather than a convoy.
        this.fakes = SKIN_IDS.map((_, i) => ({
          s: 20 + i * 10,
          lane: i % 2 === 0 ? 3.2 : -3.2,
          speed: 31 + (i % 3) * 2.5,
        }));
        this.publishPack();
        this.applyInput({ throttle: 1 });
        await settle();
        this.kickSpeed = 34;
      },
      run: (_t, dt) => {
        if (this.runSubstitute(dt)) return;
        this.reveal();
        const st = this.stage;
        const path = this.path;
        if (!st || !path) return;
        const dts = Math.min(dt, 50) / 1000;
        for (const f of this.fakes) f.s += f.speed * dts;
        this.publishPack();
        // Weave around the pack the same way the cold open weaves traffic —
        // reactive, so a pack car can never be driven into even though the
        // player is closing on them at ~10 u/s.
        const obstacles = this.fakes.map((f) => {
          const p = path.at(f.s);
          return { x: p.x + p.tz * f.lane, z: p.z - p.tx * f.lane };
        });
        this.followPath(42, false, dts, obstacles);
        // Back and up a little from the usual low chase. Remote cars have no
        // colliders, so an overtake puts the camera THROUGH whichever rival the
        // player has just cleared; at 9.5u back and 2.6u up one of them filled
        // half the lens. 12.5/3.3 keeps the pass outside the near plane.
        this.chaseCam(12.5, 3.3, 14, dts, 60);
      },
      teardown: () => this.stage?.setFakePlayers(null),
    };
  }

  /** Publish the pack as remote players on the street surface.
   *
   *  Two details RemoteCars forces: `y` is used verbatim as the render height
   *  (nothing re-seats a remote car on the drive surface), so it has to come
   *  from city.heightAt; and the receiver smooths toward each target at
   *  `1 - exp(-12·dt)`, which parks every car a steady v/12 behind where it was
   *  published. Publishing a lead of speed/12 puts them where the staging
   *  actually intends. Ids are stable per index so the beacon colours — a hash
   *  of the id — stay put instead of flickering between frames. */
  private publishPack(): void {
    const st = this.stage;
    const path = this.path;
    if (!st || !path) return;
    const players: PlayerMap = {};
    this.fakes.forEach((f, i) => {
      const p = path.at(f.s + f.speed / 12);
      const x = p.x + p.tz * f.lane;
      const z = p.z - p.tx * f.lane;
      players[`rival-${i}`] = {
        id: `rival-${i}`,
        state: {
          x,
          y: this.city.heightAt(x, z),
          z,
          h: Math.atan2(p.tx, p.tz),
          skin: SKIN_IDS[i % SKIN_IDS.length] ?? "waymo",
          msg: "",
          msgAt: 0,
        },
      };
    });
    st.setFakePlayers(players);
  }

  /** 7 — PHYSICS: full boost through a curbside row of parked cars, Rapier
   *  sending them tumbling. Low manual chase + impact shake.
   *
   *  This shot has never once been seen. It used to stage on whatever
   *  `scoutArterial(exclude) ?? this.arterial` produced — and since
   *  scoutArterial returns null in this bake, both terms collapsed onto the
   *  same bare longest-edge fallback, which is the one edge in the network that
   *  runs 357u past the ground collider. The car spawned beyond the physics
   *  world, fell, got teleported back to the same hole by the out-of-world
   *  rescue, and fell again, for the whole 3.6s: an empty street with an
   *  invisible car and a row of parked cars nobody ever hit. It now takes a
   *  bounds-checked boulevard, and a different one from the cold open. */
  private sceneTrafficChaos(): TrailerScene {
    // 14 cars (91u of row) keeps punts landing until ~t2.6s at 44 u/s.
    const ROW_N = 14;
    const ROW_GAP = 6.5;
    return {
      id: "demolition",
      // 2400: probed, the plow runs clean at 44 u/s until ~t2.3s, at which
      // point enough punted wrecks have tumbled back into the lane to stop the
      // car dead (44 -> 11 u/s, chassis climbing to y 2.9). Cut on the carnage,
      // not on the wreck the carnage makes.
      duration: 2400,
      setup: async () => {
        const alt = this.boulevard(2);
        const dir = this.awayFromSun(alt.edge, alt.dir, 0.44);
        const path0 = this.edgePath(alt.edge, dir, 0);
        // Row start needs 91u of row + 70u run-out before the edge ends.
        const sRow = Math.max(64, Math.min(alt.edge.len - 180, alt.edge.len / 2 - 20));
        const p0 = path0.at(sRow);
        // Row in the curb lane, right of travel (tz, -tx).
        const curb = Math.max(2.6, alt.edge.half - 1.6);
        const x0 = p0.x + p0.tz * curb;
        const z0 = p0.z - p0.tx * curb;
        const st = this.base({ phase: 0.44, avoidX: x0, avoidZ: z0, avoidR: 8 });
        st.stageParkedRow(x0, z0, p0.tx, p0.tz, ROW_N, ROW_GAP);
        const rowLen = ROW_GAP * (ROW_N - 1);
        // Approach in the STREET lane, merge into the curb lane AT the row:
        // the curb lane between spawn and row start carries natural parked
        // cars (mass 135, not the light staged ones) — a straight curb-lane
        // run plowed one of those at ~t1.2 and the take died before the row.
        // The final leg rides 1.3u street-side of the row axis so row hits
        // are glancing: dead-centre impacts spun the player into the lens.
        const lane = (along: number, out: number): Pt => [
          x0 + p0.tx * along - p0.tz * out,
          z0 + p0.tz * along + p0.tx * out,
        ];
        // Densified to ~5u pitch — Path.project() snaps to POINTS, so long
        // bare segments would teleport the rabbit leg-to-leg.
        // Start 62 back (not 46): the first punt then lands ~t1.5s, so the
        // 30% frame is the full-speed approach with the row readable ahead
        // instead of a tumbling wreck eclipsing the lens.
        const waypoints: Pt[] = [];
        for (let a = -62; a < -12; a += 5) waypoints.push(lane(a, 3.8));
        for (let a = -12; a < 2; a += 5) waypoints.push(lane(a, 3.8 - ((a + 12) / 14) * 2.5));
        // 2.0 street-side of the row axis, not 1.3: far enough that contacts
        // stay glancing punts instead of square hits that spin the player.
        for (let a = 2; a <= rowLen + 70; a += 5) waypoints.push(lane(a, 2.0));
        this.path = new Path(waypoints);
        const s0 = lane(-62, 3.8);
        st.placeCar(s0[0], s0[1], Math.atan2(p0.tx, p0.tz), 0);
        this.applyInput({ throttle: 1, boost: true });
        await settle();
        this.kickSpeed = 32;
      },
      run: (_t, dt) => {
        // 4s of held boost with zero refill sources (parked-car punts award
        // none) — refill invisibly so the plow stays flamed to the cut.
        this.topUpBoost();
        if (this.runSubstitute(dt)) return;
        this.reveal();
        const dts = Math.min(dt, 50) / 1000;
        this.followPath(44, true, dts);
        // Higher than the usual low chase: at 2.3u the boost flame sprite
        // sits dead-centre and hides the row cars being punted — 5.0u looks
        // over the flame down onto the carnage. (Both a lateral offset and a
        // steeper 7.5u pitch were tried: the offset shoves the minY clamp
        // into cross-sloped sidewalks, the pitch drops the car out of frame.
        // The near punt ducking behind the flame for a beat is acceptable.)
        this.chaseCam(13, 5.0, 11, dts, 58);
      },
    };
  }

  /** 9 — fast cut 1: committed handbrake drift around a Victorian corner,
   *  smoke and skids, mini-turbo pop on release. Fixed low cam on the exit
   *  street — the car slides around it, toward the lens. */
  private sceneMontageDrift(): TrailerScene {
    return {
      id: "montage-drift",
      duration: 1500,
      setup: async () => {
        const corner = this.driftCorner ?? this.fareCorner;
        if (!corner) {
          await this.substituteBoostRun(DRIFT_PHASE);
          return;
        }
        const st = this.base({ phase: DRIFT_PHASE, avoidX: corner.x, avoidZ: corner.z, avoidR: 6 });
        const inA = corner.inArm;
        const outA = corner.outArm;
        this.sceneNode.set(corner.x, corner.z);
        this.sceneDir.set(outA.tx, outA.tz);
        const hIn = Math.atan2(inA.tx, inA.tz);
        const hOut = Math.atan2(outA.tx, outA.tz);
        this.driftSide = wrapAngle(hOut - hIn) < 0 ? 1 : -1;
        st.placeCar(corner.x - inA.tx * 26, corner.z - inA.tz * 26, hIn, 0);
        // Camera on the exit street looking back; laterally on the OUTSIDE
        // of the turn so the drift sweeps across frame. Kept near the kerb
        // line (2.6u) — further out sits on the corner lot, where podium
        // walls eat half the frame at street height.
        let px = outA.tz;
        let pz = -outA.tx;
        if (px * -inA.tx + pz * -inA.tz > 0) {
          px = -px;
          pz = -pz;
        }
        this.sceneAux.set(corner.x + outA.tx * 20 + px * 2.6, corner.z + outA.tz * 20 + pz * 2.6);
        // Staged at rest: NEUTRAL through the cut (brake at standstill would
        // reverse); drift input starts the frame the reveal kicks the speed.
        await settle();
        this.kickSpeed = 26;
      },
      run: (t, dt) => {
        if (this.runSubstitute(dt)) return;
        this.reveal();
        const st = this.stage;
        if (!st) return;
        const node = this.sceneNode;
        const exit = this.sceneDir;
        const car = st.car;
        // Straight in → committed drift at the mouth (turn radius v/arcMax
        // ≈ 10u — earlier and the arc cuts the block) → release aligned with
        // the exit street, mini-turbo pops the car out toward the camera.
        const dNode = Math.hypot(node.x - car.position.x, node.y - car.position.z);
        const errExit = wrapAngle(
          Math.atan2(node.x + exit.x * 22 - car.position.x, node.y + exit.y * 22 - car.position.z) -
            car.heading,
        );
        if (this.step === 0) {
          if (dNode < 16) this.step = 1;
          else this.driveAt(node.x, node.y, 27);
        }
        if (this.step === 1) {
          // Hold ≥ ~850ms of drift (tier-1 mini-turbo arms at 0.8s) so the
          // release POP is the button of the cut, right before it ends.
          if ((Math.abs(errExit) < 0.25 && t > 1200) || t > 1350) this.step = 2;
          else this.drift(this.driftSide);
        }
        if (this.step === 2) {
          this.driveAt(node.x + exit.x * 40, node.y + exit.y * 40, 34);
        }
        const p = car.position;
        const camX = this.sceneAux.x;
        const camZ = this.sceneAux.y;
        this.cam(camX, this.city.heightAt(camX, camZ) + 3.4, camZ, p.x, p.y + 0.9, p.z, 55);
      },
    };
  }

  /** 11 — fast cut 3: a cone barricade across a junction, hit at full boost
   *  — front-reverse camera, cones scatter at the lens. */
  private sceneMontageSmash(): TrailerScene {
    return {
      id: "montage-smash",
      duration: 1500,
      setup: async () => {
        const j =
          this.junctions.find((cand) => cand.approaches.some((a) => a.run >= 30)) ??
          this.junctions[0];
        if (!j) {
          await this.substituteBoostRun(0.44);
          return;
        }
        const st = this.base({ phase: 0.44, avoidX: j.x, avoidZ: j.z, avoidR: 7 });
        const arm = j.approaches.reduce<Approach | null>(
          (acc, a) => (acc && acc.run >= a.run ? acc : a),
          null,
        );
        if (!arm) return;
        const pT = { x: arm.tx, z: arm.tz };
        this.sceneNode.set(j.x, j.z);
        this.sceneDir.set(pT.x, pT.z);
        st.cones.stageBarricade(j.x - pT.x * 3, j.z - pT.z * 3, pT.z, -pT.x, pT.x, pT.z, 12, 1.1);
        st.placeCar(j.x - pT.x * 36, j.z - pT.z * 36, Math.atan2(pT.x, pT.z), 0);
        this.sceneAux.set(j.x + pT.x * 15 + pT.z * 4.0, j.z + pT.z * 15 - pT.x * 4.0);
        this.applyInput({ throttle: 1, boost: true });
        await settle();
        this.kickSpeed = 36;
      },
      run: (_t, dt) => {
        if (this.runSubstitute(dt)) return;
        this.reveal();
        const st = this.stage;
        if (!st) return;
        const node = this.sceneNode;
        const pT = this.sceneDir;
        this.driveAt(node.x + pT.x * 55, node.y + pT.y * 55, 46, true);
        const car = st.car.position;
        const camX = this.sceneAux.x;
        const camZ = this.sceneAux.y;
        this.cam(camX, this.city.heightAt(camX, camZ) + 1.7, camZ, car.x, car.y + 0.9, car.z, 55);
      },
    };
  }

  /** 11 — RELEASE: the Waymo crossing the Golden Gate, shot from off the deck
   *  and out over the water so the bridge actually reads as a bridge.
   *
   *  The previous framing sat ON the deck, 2.6u off centreline, because the
   *  cables hang at x ±7.2 and the portal beams start at deckY+7.8 — anything
   *  wider shot through red girders. But from inside that safe cylinder the
   *  only thing in frame is roadway: the towers are a distant red frame, the
   *  water never appears, and the closing image of the trailer is an empty
   *  carriageway. The fix is to leave the deck entirely. A camera hung out over
   *  the bay, level with the roadway and swinging forward as the car passes,
   *  never touches the lattice and puts tower, span, water and sunset in one
   *  frame with the car crossing it. */
  private sceneHeroDrive(): TrailerScene {
    return {
      id: "hero-drive",
      duration: 4200,
      setup: async () => {
        const gate = this.gate;
        if (!gate) {
          await this.substituteBoostRun(0.44);
          return;
        }
        // 0.44, not 0.465. Moving the camera west to keep the sun out of the
        // lens also took the warmth off the bridge — at 0.465 the span reads
        // as a dark silhouette. A slightly earlier phase lifts the sun to ~6
        // degrees and still leaves it behind the camera, so the towers catch
        // the light instead of blocking it. (0.48-0.52 is off limits: the
        // shadow direction lerps through the sun-to-moon handoff there and the
        // city casts full-strength shadows from the wrong place.)
        const st = this.base({ phase: 0.44, avoidX: gate.x, avoidZ: gate.shoreZ, avoidR: 10 });
        // North across the deck (north = -Z, heading π). Start just past the
        // deck lip: the north tower portal sits ~64u out, and at 13 u/s over
        // 4s the car must END short of it — from -26 the trailing camera
        // spent the last ~1.1s of the cut inside the red tower lattice.
        const startZ = gate.rampTopZ - 8;
        st.placeCar(gate.x, startZ, Math.PI, 0);
        this.sceneNode.set(gate.x, gate.deckY);
        // Where the locked-off camera stares: abeam the span the car crosses.
        // Distance is set by how big the Waymo needs to read, then the speed is
        // set to match. At 24u off the deck the visible span at a 50-degree
        // vertical FOV is ~40u, so the car must cover about that much in 4.2s
        // to enter at one edge and still be in shot at the cut — 10 u/s. Slow
        // is right here anyway: this is the release beat, not a speed beat.
        this.sceneAux.set(startZ - 24, 0);
        this.applyInput({ throttle: 1 });
        await settle();
        this.kickSpeed = 10;
      },
      run: (t, dt) => {
        if (this.runSubstitute(dt)) return;
        this.reveal();
        const st = this.stage;
        if (!st) return;
        const car = st.car;
        const x = this.sceneNode.x;
        const deckY = this.sceneNode.y;
        this.driveAt(x, car.position.z - 300, 10);
        const e = smooth(clamp(t / 4200, 0, 1));
        // LOCKED OFF, west of the deck, and the car crosses frame.
        //
        // West matters: the sun sits at azimuth ~243 at this phase, so an
        // east-side camera looks straight into it and the frame blows to white.
        // From here the sun is behind the lens and rakes the bridge warm.
        //
        // Locked off matters more. This bridge only composes from abeam — that
        // is the one angle where tower, cables, deck and water stack up behind
        // the car — so a camera that tracks the car necessarily swings AWAY
        // from the composition as the car moves. Holding the frame and letting
        // the Waymo drive through it keeps the good angle for the whole shot,
        // and a crossing subject reads as travel far better than one pinned to
        // the middle of frame. The only motion is a slow rise, which parallaxes
        // the near cables against the far headlands.
        const markZ = this.sceneAux.x;
        // Eye just under deck level aiming just over it: the tilt drops the
        // roadway onto the lower third, so the tower, the cables and the sunset
        // band get the top two-thirds instead of an equal split with the bay.
        this.cam(x - 24, deckY + 1.5 + e * 2.6, markZ, x, deckY + 2.6, markZ, 50);
      },
      teardown: () => this.applyInput({}),
    };
  }

  /** Last-resort substitute if a scout came back empty: a clean boost run
   *  down the arterial on the game chase rig (still real gameplay; the
   *  console warning flags it for the report). runSubstitute() drives it. */
  private async substituteBoostRun(phase: number): Promise<void> {
    console.warn("[trailer] scene substituted with arterial boost run");
    const { edge, dir } = this.arterial;
    const st = this.base({ phase });
    this.path = this.edgePath(edge, dir, 120);
    const start = this.path.at(20);
    st.placeCar(start.x, start.z, Math.atan2(start.tx, start.tz), 0);
    st.setFreecam(false);
    this.applyInput({ throttle: 1, boost: true });
    await settle();
    this.kickSpeed = 34;
    this.substituted = true;
    st.snapCamera();
  }
}

export function startTrailer(game: GameScene): void {
  const director = new Director(game);
  runTrailer({
    onGesture: () => director.unlockAudio(),
    scenes: director.scenes(),
  });
  // runTrailer has built its own black plate by now, so the boot plate that
  // covered world-load can go (see #trailer-plate in index.html).
  document.getElementById("trailer-plate")?.remove();
}
