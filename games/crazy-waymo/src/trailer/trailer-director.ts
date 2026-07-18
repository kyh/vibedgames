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
import { signalGreen } from "../world/junction-control";
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
  type VistaSpot,
  nearFreeway,
  scoutArterial,
  scoutCorners,
  scoutCrests,
  scoutFreeway,
  scoutGoldenGate,
  scoutShore,
  scoutSignalJunctions,
  scoutVista,
} from "./scout";
import { runTrailer, type TrailerScene } from "./trailer-shell";

const clamp = THREE.MathUtils.clamp;
const wrapAngle = (a: number): number => ((a + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
const smooth = (f: number): number => f * f * (3 - 2 * f);

const NEUTRAL: CarInput = { throttle: 0, brake: 0, steer: 0, boost: false };

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
  private readonly arterial: { edge: NetEdge; dir: 1 | -1 };
  private readonly crests: CrestSpot[];
  private readonly shore: ShoreSpot | null;
  private readonly freeway: FreewayRun | null;
  private readonly vista: VistaSpot | null;
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
  private crossCars: TrafficCar[] = [];
  private crossPrev = new Map<TrafficCar, { x: number; z: number; v: number }>();
  private s7Node = -1;
  private fakes: FakeCar[] = [];
  private sceneNode = new THREE.Vector2(); // active junction/corner centre
  private sceneDir = new THREE.Vector2(); // active travel direction
  private sceneAux = new THREE.Vector2(); // scene-specific extra vector
  private driftSide: 1 | -1 = 1;

  constructor(private readonly game: GameScene) {
    const city = game.getCity();
    if (!city) throw new Error("[trailer] city not built");
    this.city = city;
    this.ctx = {
      plan: city.plan,
      network: city.network,
      heightAt: (x, z) => city.heightAt(x, z),
    };
    this.arterial = scoutArterial(this.ctx) ?? this.longestEdge();
    this.crests = scoutCrests(this.ctx, 6);
    this.shore = scoutShore(this.ctx);
    this.freeway = scoutFreeway(this.ctx);
    this.vista = scoutVista(this.ctx);
    const corners = this.pickCorners();
    this.fareCorner = corners.fare;
    this.driftCorner = corners.drift;
    this.junctions = scoutSignalJunctions(this.ctx, 10);
    this.gate = scoutGoldenGate(this.ctx);
    for (const [name, ok] of [
      ["crest", this.crests.length > 0],
      ["shore", this.shore !== null],
      ["freeway", this.freeway !== null],
      ["vista", this.vista !== null],
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
    return stage;
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
    this.crossCars = [];
    this.crossPrev.clear();
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
   *  spawn-in, never a teleport bounce on camera. Card scenes hold NEUTRAL
   *  through the black card and get their whole speed here. */
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

  private longestEdge(): { edge: NetEdge; dir: 1 | -1 } {
    let best: NetEdge | null = null;
    for (const e of this.city.network.edges) {
      if (!best || e.len > best.len) best = e;
    }
    if (!best) throw new Error("[trailer] empty road network");
    return { edge: best, dir: 1 };
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
    // that stare lines up with the phase-0.4 golden-hour sun the whole cut
    // is horizon glare — prefer corners whose exit points away from it.
    const sun = this.sunHorizontal(0.4);
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

  /** Straight path densified to ~5u samples — project() works on POINTS, so
   *  a bare two-point line would snap the rabbit start→end. */
  private linePath(x0: number, z0: number, x1: number, z1: number): Path {
    const len = Math.hypot(x1 - x0, z1 - z0) || 1;
    const n = Math.max(2, Math.ceil(len / 5));
    const pts: Pt[] = [];
    for (let i = 0; i <= n; i++) {
      pts.push([x0 + ((x1 - x0) * i) / n, z0 + ((z1 - z0) * i) / n]);
    }
    return new Path(pts);
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

  /** Seconds the CROSS axis of `node` stays green from time `t` (0 if red). */
  private crossGreenRemaining(node: number, tx: number, tz: number, t: number): number {
    if (!signalGreen(node, tx, tz, t)) return 0;
    for (let dt = 0.1; dt <= 6.01; dt += 0.1) {
      if (!signalGreen(node, tx, tz, t + dt)) return dt;
    }
    return 6;
  }

  // ---- scenes ---------------------------------------------------------------

  scenes(): TrailerScene[] {
    return [
      this.sceneColdOpen(),
      this.sceneHillAir(),
      this.scenePiers(),
      this.sceneFreeway(),
      this.sceneHills(),
      this.sceneFareRun(),
      this.sceneJunction(),
      this.sceneTrafficChaos(),
      this.sceneMontageDrift(),
      this.sceneMontageJump(),
      this.sceneMontageSmash(),
      this.sceneHeroDrive(),
    ];
  }

  /** 1 — COLD OPEN: flat out down a downtown arterial, threading moving
   *  traffic on both sides. Game chase rig (speed crouch + FOV kick). */
  private sceneColdOpen(): TrailerScene {
    return {
      id: "cold-open-weave",
      duration: 4500,
      setup: async () => {
        const { edge } = this.arterial;
        // Glare beats skyline: drive away from the sun (the game rig stares
        // straight down the street — into-sun runs open the trailer white).
        const dir = this.awayFromSun(edge, this.arterial.dir, 0.3);
        // Ride the RIGHT LANE (not the centreline) and stage the traffic
        // ONCOMING in its own lane: every weave-based slalom variant tried
        // (both-sides, alternating, same-direction-only, three amplitudes)
        // eventually clipped a staged car — transient pursuit convergence
        // can't be trusted at 40 u/s. Parallel lanes need no dodging at all:
        // the whooshes close at ~55 u/s with a fixed ~4u lateral gap, which
        // reads as threading on camera and cannot end a take.
        const path = this.edgePath(edge, dir, 120, 2.1);
        const start = path.at(12);
        const st = this.base({ phase: 0.3, avoidX: start.x, avoidZ: start.z, avoidR: 3 });
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
        this.applyInput({ throttle: 1, boost: true });
        await settle();
        this.kickSpeed = 34;
      },
      run: (_t, dt) => {
        this.reveal();
        const st = this.stage;
        const path = this.path;
        if (!st || !path) return;
        // 4.5s of held boost outlasts the meter; near-misses alone don't
        // reliably cover the gap, so keep the flames alive to the cut.
        this.topUpBoost();
        const dts = Math.min(dt, 50) / 1000;
        const top = Math.min(44, (path.length - 40) / 4.5);
        this.followPath(top, true, dts);
        // The beat calls for a LOW rear chase — the game rig rides too high
        // and opens the trailer on sky wash; the manual chase hugs the car.
        this.chaseCam(10.5, 2.9, 11, dts, 58);
      },
    };
  }

  /** 2 — HILL AIR: crest the steepest scouted SF hill at speed, all four
   *  wheels off. Fixed low camera past the crest — the car launches at the
   *  lens, whips by and lands. */
  private sceneHillAir(): TrailerScene {
    return {
      id: "hill-air",
      // 3000, not the beat sheet's 3500: past ~2.8s the car has whipped by
      // and shrunk into the downhill distance-haze — a dead-air tail.
      duration: 3000,
      setup: async () => {
        const crest = this.crests[0];
        if (!crest) {
          // No crest scouted (should not happen in SF): boost run substitute.
          await this.substituteBoostRun(0.3);
          return;
        }
        const st = this.base({ phase: 0.3, avoidX: crest.x, avoidZ: crest.z, avoidR: 8 });
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

  /** 3 — REAL SAN FRANCISCO card: Embarcadero sweep, side dolly with the
   *  water and pier sheds behind the car. */
  private scenePiers(): TrailerScene {
    return {
      id: "landmark-piers",
      duration: 2000,
      card: { title: "REAL SAN FRANCISCO", sub: "EVERY STREET. EVERY HILL." },
      setup: async () => {
        const shore = this.shore;
        if (!shore) {
          await this.substituteBoostRun(0.33);
          return;
        }
        const path = this.edgePath(shore.edge, shore.dir, 100);
        // Start 30 in (not 10): the land-side dolly line at the edge mouth
        // runs through a 4-storey block — deeper in, the strip is low sheds
        // and the camera clears the rooflines.
        const start = path.at(30);
        // Scatter traffic clear of the run: the teleport otherwise leaves most
        // of the fleet >260u away and the recycler mass-respawns it 78-156u
        // AHEAD on the sparse wharf edges — a random rear-end punt mid-card.
        const st = this.base({ phase: 0.33, avoidX: start.x, avoidZ: start.z, avoidR: 10 });
        this.path = path;
        st.placeCar(start.x, start.z, Math.atan2(start.tx, start.tz), 0);
        this.driftSide = shore.waterLeft ? 1 : -1; // water side, reused as sign
        // Card scene: hold NEUTRAL under the black card, full speed at reveal.
        await settle();
        this.kickSpeed = 38;
      },
      run: (_t, dt) => {
        if (this.runSubstitute(dt)) return;
        this.reveal();
        const st = this.stage;
        const path = this.path;
        if (!st || !path) return;
        this.followPath(
          44,
          true,
          Math.min(dt, 50) / 1000,
          st.traffic.cars.map((c) => c.position),
        );
        const car = st.car.position;
        const p = path.at(this.pathS);
        // waterLeft: left of travel is (-tz, tx). The shorefront strips carry
        // 2-4 storey buildings that heightAt() knows nothing about, and any
        // lateral dolly line eventually passes through one (three offsets
        // tried; each take clipped a different block). The only always-clear
        // volume is ABOVE THE ROAD ITSELF: a high rear chase at +11 out-sees
        // the ~8u rooflines, raking across to the sea horizon while the car
        // holds the lower third of the frame.
        const wx = this.driftSide > 0 ? -p.tz : p.tz;
        const wz = this.driftSide > 0 ? p.tx : -p.tx;
        // Camera rides the LAND edge of the road corridor (5u off centreline
        // stays over sidewalk, +11 clears the ~8u rooflines) and rakes hard
        // across the car toward the sea: aim 26u water-side puts the horizon
        // and pier sheds across the upper two-thirds instead of a corner
        // sliver, car anchored lower-left blasting through frame.
        this.cam(
          car.x - p.tx * 14 - wx * 5,
          car.y + 11,
          car.z - p.tz * 14 - wz * 5,
          car.x + p.tx * 2 + wx * 19,
          car.y + 0.3,
          car.z + p.tz * 2 + wz * 19,
          52,
        );
      },
    };
  }

  /** 4 — elevated freeway at max boost, weaving a staged fleet of other
   *  Waymos (fake multiplayer — visual-only remote cars). Low manual chase,
   *  skyline dead ahead. */
  private sceneFreeway(): TrailerScene {
    return {
      id: "landmark-freeway",
      duration: 2000,
      setup: async () => {
        const fw = this.freeway;
        if (!fw) {
          await this.substituteBoostRun(0.33);
          return;
        }
        const st = this.base({ phase: 0.33 });
        // Scout orders the run INTO the skyline with no regard for the sun;
        // when that faces the phase-0.33 sun the whole cut is bloom + boost
        // flame — a white-out. Reverse the run rather than shoot into it.
        const head = fw.pts[0] ?? [0, 0];
        const tail = fw.pts[fw.pts.length - 1] ?? [0, 1];
        const runLen = Math.hypot(tail[0] - head[0], tail[1] - head[1]) || 1;
        const sun = this.sunHorizontal(0.33);
        const towardSun =
          ((tail[0] - head[0]) / runLen) * sun.x + ((tail[1] - head[1]) / runLen) * sun.z;
        const pts = towardSun > 0.25 ? [...fw.pts].reverse() : fw.pts;
        const path = new Path(pts).extend(140);
        this.path = path;
        // Narrow weave: the deck is half 5.2 with barrier faces at ±4.65 and
        // an invisible physics lip on top — the default ±2.5 swing at 40 u/s
        // overshoots into the lip, which CAPTURES the wheels and grinds the
        // whole cut (probed: sawtooth speed decay pinned wall-parallel).
        // ±1.2 still splits the ±2.3-lane fakes visibly.
        this.weaveAmp = 1.2;
        const start = path.at(14);
        const yaw = Math.atan2(start.tx, start.tz);
        st.placeCar(start.x, start.z, yaw, 0, fw.deckYAt(start.x, start.z));
        this.fakes = [0, 1, 2, 3, 4].map((i) => ({
          s: 42 + i * 18,
          lane: i % 2 === 0 ? 2.3 : -2.3,
          speed: 14 + i,
        }));
        this.publishFakes(fw);
        this.applyInput({ throttle: 1, boost: true });
        await settle();
        this.kickSpeed = 38;
      },
      run: (t, dt) => {
        if (this.runSubstitute(dt)) return;
        this.reveal();
        const st = this.stage;
        const path = this.path;
        const fw = this.freeway;
        if (!st || !path || !fw) return;
        const dts = Math.min(dt, 50) / 1000;
        for (const f of this.fakes) f.s += f.speed * dts;
        this.publishFakes(fw);
        // Physics does NOT advance under the dark cut, so the ~1.2u
        // deckYAt-estimate drop happens ON camera at t0. Hold dead-straight
        // pedal-only input while the car falls and the suspension settles —
        // steering during the unloaded bounce yawed the car onto the barrier
        // lip (probed: wheels captured, whole cut spent grinding the wall).
        if (t < 650) {
          this.applyInput({ throttle: 1, boost: true });
        } else {
          const obstacles = this.fakes.map((f) => {
            const p = path.at(f.s);
            return { x: p.x + p.tz * f.lane, z: p.z - p.tx * f.lane };
          });
          this.followPath(38, true, dts, obstacles);
        }
        this.chaseCam(10.5, 2.7, 11, dts, 60);
      },
      teardown: () => this.stage?.setFakePlayers(null),
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

  /** 5 — the plunge: long steep street falling toward open water, high wide
   *  camera. Rule-of-three closer: the mid-run bench reads as a small hop. */
  private sceneHills(): TrailerScene {
    return {
      id: "landmark-hills",
      duration: 2000,
      setup: async () => {
        const vista = this.vista;
        if (!vista) {
          await this.substituteBoostRun(0.33);
          return;
        }
        const st = this.base({ phase: 0.33 });
        const path = this.edgePath(vista.edge, vista.dir, 140);
        this.path = path;
        const sT = vista.dir > 0 ? vista.sStart : vista.edge.len - vista.sStart;
        const start = path.at(Math.max(4, sT - 4));
        st.placeCar(start.x, start.z, Math.atan2(start.tx, start.tz), 0);
        const avoid = path.at(sT + 40);
        st.traffic.reset({ gx: this.city.gridX(avoid.x), gz: this.city.gridZ(avoid.z) }, 8);
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
        const car = st.car;
        const fx = Math.sin(car.heading);
        const fz = Math.cos(car.heading);
        // Low-ish wide from behind: a high crane flattens the grade — from
        // near hood height the street falls away below the eyeline and the
        // drop toward the water reads.
        this.cam(
          car.position.x - fx * 19,
          car.position.y + 6.5,
          car.position.z - fz * 19,
          car.position.x + fx * 32,
          car.position.y + 0.6,
          car.position.z + fz * 32,
          58,
        );
      },
    };
  }

  /** 6 — PICK UP. FLOOR IT. — the core loop as one continuous gameplay shot:
   *  board a staged customer, drift the corner, skid into the drop-off,
   *  confetti + receipt. Fare HUD on; game chase rig. */
  private sceneFareRun(): TrailerScene {
    return {
      id: "fare-run",
      duration: 5000,
      card: { title: "PICK UP. FLOOR IT." },
      setup: async () => {
        const corner = this.fareCorner;
        if (!corner) {
          await this.substituteBoostRun(0.36);
          return;
        }
        const st = this.base({
          phase: 0.36,
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
        // Card scene: hold NEUTRAL under the black card, full speed at reveal.
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

  /** 7 — quiet-tension beat: a signalled downtown box with cross traffic
   *  flowing on the green. Roll to the line, read the gaps, thread it.
   *  Fixed elevated corner camera; engine + horns, no crashes. */
  private sceneJunction(): TrailerScene {
    return {
      id: "junction-thread",
      duration: 4000,
      setup: async () => {
        const st = this.ensureStage();
        // Choose the junction + axis with the LONGEST remaining cross-green,
        // measured on the live signal clock — the shot needs flow for ~4s.
        const t0 = st.traffic.time + 0.6;
        let best: {
          j: JunctionSpot;
          player: Approach;
          cross: Approach[];
          remain: number;
        } | null = null;
        // Run gates match the bake (short signalled blocks — see scout.ts):
        // the player needs ~36u to roll up and read the box, cross arms only
        // need room to stage a visible queue.
        for (const j of this.junctions) {
          for (const crossIsX of [true, false]) {
            const cross = j.approaches.filter((a) => a.axisX === crossIsX && a.run >= 24);
            const player = j.approaches
              .filter((a) => a.axisX !== crossIsX && a.run >= 36)
              .reduce<Approach | null>((acc, a) => (acc && acc.run >= a.run ? acc : a), null);
            const c0 = cross[0];
            if (!player || !c0 || cross.length < 2) continue;
            const remain = this.crossGreenRemaining(j.node, c0.tx, c0.tz, t0);
            if (!best || remain > best.remain) best = { j, player, cross, remain };
          }
        }
        if (!best) {
          await this.substituteBoostRun(0.36);
          return;
        }
        this.base({ phase: 0.36, avoidX: best.j.x, avoidZ: best.j.z, avoidR: 7 });
        this.s7Node = best.j.node;
        this.sceneNode.set(best.j.x, best.j.z);
        this.sceneDir.set(best.player.tx, best.player.tz);
        // Cross traffic queued/rolling on the green: three per side, spaced
        // to the arm that exists (short blocks → the queue starts closer).
        const cars = this.stagedTraffic(6);
        for (let side = 0; side < 2; side++) {
          const arm = best.cross[side];
          if (!arm) continue;
          const gap = clamp((arm.run - 12) / 2, 9, 24);
          for (let k = 0; k < 3; k++) {
            const d = 12 + gap * k;
            const s = arm.dirToNode > 0 ? arm.edge.len - d : d;
            this.placeTraffic(cars[side * 3 + k], arm.edge, s, arm.dirToNode);
          }
        }
        this.crossCars = cars;
        const pT = this.sceneDir;
        // 30u back (was 42): the camera hangs 22u back, and from deeper
        // starts the car only clears the camera plane ~t1.5s — the first
        // third of the cut had no subject in frame.
        st.placeCar(best.j.x - pT.x * 30, best.j.z - pT.y * 30, Math.atan2(pT.x, pT.y), 0);
        // Fixed elevated cam: behind the player's approach, hung over the
        // sidewalk of the player's OWN street. Junctions are scouted in DENSE
        // districts, so anything >9u laterally off a street centerline sits
        // inside a corner building footprint — keep the lateral term small.
        const c0 = best.cross[0];
        const sideX = c0 ? -c0.tx : pT.y;
        const sideZ = c0 ? -c0.tz : -pT.x;
        this.sceneAux.set(best.j.x - pT.x * 22 + sideX * 7, best.j.z - pT.y * 22 + sideZ * 7);
        this.applyInput({ throttle: 1 });
        await settle();
        this.kickSpeed = 15;
      },
      run: (t, dt) => {
        if (this.runSubstitute(dt)) return;
        this.reveal();
        const st = this.stage;
        if (!st) return;
        const dts = Math.max(1 / 120, Math.min(dt, 50) / 1000);
        const car = st.car;
        const node = this.sceneNode;
        const pT = this.sceneDir;
        // Estimate each cross car's speed from frame deltas (baseSpeed is
        // private — and an estimate stays honest about wrecks/braking).
        for (const c of this.crossCars) {
          const prev = this.crossPrev.get(c);
          const v = prev ? Math.hypot(c.position.x - prev.x, c.position.z - prev.z) / dts : 12;
          this.crossPrev.set(c, {
            x: c.position.x,
            z: c.position.z,
            v: prev ? prev.v + (v - prev.v) * 0.3 : v,
          });
        }
        if (this.step === 0) {
          // Creep to the line while the box is hot.
          const dAlong = (node.x - car.position.x) * pT.x + (node.y - car.position.z) * pT.y;
          this.driveAt(node.x, node.y, dAlong > 15 ? 12 : 4);
          let threat = false;
          for (const c of this.crossCars) {
            const dNode = (node.x - c.position.x) * c.tanX + (node.y - c.position.z) * c.tanZ;
            if (Math.abs(dNode) > 60) continue;
            const v = Math.max(3, this.crossPrev.get(c)?.v ?? 12);
            const tta = dNode / v;
            if (tta > -0.4 && tta < 1.5) threat = true;
          }
          if ((t > 900 && !threat) || t > 2400) this.step = 1;
        } else {
          // Punch the gap — full throttle straight through the box.
          this.driveAt(node.x + pT.x * 55, node.y + pT.y * 55, 30);
        }
        const camX = this.sceneAux.x;
        const camZ = this.sceneAux.y;
        this.cam(
          camX,
          this.city.heightAt(camX, camZ) + 7,
          camZ,
          node.x + pT.x * 4,
          this.city.heightAt(node.x, node.y) + 1.2,
          node.y + pT.y * 4,
          52,
        );
      },
    };
  }

  /** 8 — RELEASE: full boost through a curbside row of parked cars — Rapier
   *  sends them tumbling. Low manual chase + impact shake. The row is STAGED
   *  (natural curb parking in this bake never lines up more than ~3 cars) on
   *  a second arterial, so the shot doesn't reuse the cold-open street. */
  private sceneTrafficChaos(): TrailerScene {
    // 14 cars (91u of row) keeps punts landing until ~t3.4s at 44 u/s —
    // 9 cars ran dry at ~2.7s and the last quarter of the cut was empty road.
    const ROW_N = 14;
    const ROW_GAP = 6.5;
    return {
      id: "traffic-chaos",
      duration: 3600,
      setup: async () => {
        const alt = scoutArterial(this.ctx, this.arterial.edge) ?? this.arterial;
        const dir = this.awayFromSun(alt.edge, alt.dir, 0.36);
        const path0 = this.edgePath(alt.edge, dir, 0);
        // Row start needs 91u of row + 70u run-out before the edge ends.
        const sRow = Math.max(64, Math.min(alt.edge.len - 180, alt.edge.len / 2 - 20));
        const p0 = path0.at(sRow);
        // Row in the curb lane, right of travel (tz, -tx).
        const curb = Math.max(2.6, alt.edge.half - 1.6);
        const x0 = p0.x + p0.tz * curb;
        const z0 = p0.z - p0.tx * curb;
        const st = this.base({ phase: 0.36, avoidX: x0, avoidZ: z0, avoidR: 8 });
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
        for (let a = 2; a <= rowLen + 70; a += 5) waypoints.push(lane(a, 1.3));
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

  /** 9 — GO ANYWHERE card, fast cut 1: committed handbrake drift around a
   *  Victorian corner, smoke and skids, mini-turbo pop on release. Fixed low
   *  cam on the exit street — the car slides around it, toward the lens. */
  private sceneMontageDrift(): TrailerScene {
    return {
      id: "montage-drift",
      duration: 1500,
      card: { title: "GO ANYWHERE" },
      setup: async () => {
        const corner = this.driftCorner ?? this.fareCorner;
        if (!corner) {
          await this.substituteBoostRun(0.4);
          return;
        }
        const st = this.base({ phase: 0.4, avoidX: corner.x, avoidZ: corner.z, avoidR: 6 });
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
        // Card scene: NEUTRAL through the card (brake at standstill would
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

  /** 10 — fast cut 2: boost launch off a second crest, clearing oncoming
   *  traffic mid-air. (Substituted for the freeway on-ramp lip: crest
   *  launches are the game's reliable big-air move — noted in the report.) */
  private sceneMontageJump(): TrailerScene {
    return {
      id: "montage-jump",
      duration: 1500,
      setup: async () => {
        // crests[0] — the SAME crest as hill-air, not crests[1]: the runner-up
        // crest's approach drifts the car ~4u laterally into curb furniture
        // right before the lip (probed 44→9 u/s wall stop on every take).
        // crests[0] launches clean; golden-hour light + the side cam keep the
        // repeat from reading as the same shot.
        const crest = this.crests[0];
        if (!crest) {
          await this.substituteBoostRun(0.4);
          return;
        }
        const st = this.base({ phase: 0.4, avoidX: crest.x, avoidZ: crest.z, avoidR: 8 });
        const path = this.edgePath(crest.edge, crest.dir, 160);
        this.path = path;
        const sC = crest.dir > 0 ? crest.sCrest : crest.edge.len - crest.sCrest;
        const start = path.at(sC - 30);
        st.placeCar(start.x, start.z, Math.atan2(start.tx, start.tz), 0);
        // The lane to clear: two oncoming cars in the far lane while the car
        // flies. Staged DEEP (58/86, was 28/56): a fast fleet draw (8-18 u/s
        // toward the crest) from 28 reached the lip right at takeoff and the
        // jump became a chronic head-on punt — the player tumbled inverted,
        // duplicating scene 11's smash beat. Cars that DON'T FIT the edge's
        // remaining run are skipped outright: placeTraffic clamps to the edge
        // end, which on a short downhill run drags the "deep" car right back
        // to the lip — the exact punt the depth was meant to prevent.
        const cars = this.stagedTraffic(2);
        const room = crest.dir > 0 ? crest.edge.len - crest.sCrest : crest.sCrest;
        for (const [i, depth] of [58, 86].entries()) {
          if (depth + 10 > room) continue;
          this.placeTraffic(
            cars[i],
            crest.edge,
            crest.sCrest + crest.dir * depth,
            crest.dir > 0 ? -1 : 1,
          );
        }
        const p = path.at(sC + 20);
        this.sceneNode.set(p.x + p.tz * 4.6, p.z - p.tx * 4.6);
        this.sceneAux.set(this.city.heightAt(this.sceneNode.x, this.sceneNode.y) + 3.2, 0);
        this.applyInput({ throttle: 1, boost: true });
        await settle();
        this.kickSpeed = 38;
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
          car.y + 0.8,
          car.z,
          50,
        );
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
          this.junctions.find(
            (cand) => cand.node !== this.s7Node && cand.approaches.some((a) => a.run >= 30),
          ) ?? this.junctions[0];
        if (!j) {
          await this.substituteBoostRun(0.4);
          return;
        }
        const st = this.base({ phase: 0.4, avoidX: j.x, avoidZ: j.z, avoidR: 7 });
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

  /** 12 — RELEASE: the white Waymo cruising onto the Golden Gate deck toward
   *  the sunset horizon, camera rising and pulling back. End on feeling. */
  private sceneHeroDrive(): TrailerScene {
    return {
      id: "hero-drive",
      duration: 4000,
      setup: async () => {
        const gate = this.gate;
        if (!gate) {
          await this.substituteBoostRun(0.465);
          return;
        }
        const st = this.base({ phase: 0.465, avoidX: gate.x, avoidZ: gate.shoreZ, avoidR: 10 });
        // North across the deck (north = -Z, heading π). Start just past the
        // deck lip: the north tower portal sits ~64u out, and at 13 u/s over
        // 4s the car must END short of it — from -26 the trailing camera
        // spent the last ~1.1s of the cut inside the red tower lattice.
        st.placeCar(gate.x, gate.rampTopZ - 8, Math.PI, 0);
        this.sceneNode.set(gate.x, gate.deckY);
        this.applyInput({ throttle: 1 });
        await settle();
        this.kickSpeed = 13;
      },
      run: (t, dt) => {
        if (this.runSubstitute(dt)) return;
        this.reveal();
        const st = this.stage;
        if (!st) return;
        const car = st.car;
        const x = this.sceneNode.x;
        const deckY = this.sceneNode.y;
        this.driveAt(x, car.position.z - 200, 13);
        const e = smooth(clamp(t / 4000, 0, 1));
        // Rising rear three-quarter pinned INSIDE the bridge's safe volume:
        // cables + suspender rods hang at x ±7.2 and the lowest portal beam
        // face sits at deckY+7.8, so any wide lateral swing shoots THROUGH
        // red girders (the old ±14.5 swing spent the whole cut inside the
        // tower lattice). Offset 2.6, rise capped at +7.0, pull-back along
        // the deck — car holds the lower third, deck lines run to the
        // horizon, sun stays ~68° off-axis instead of filling the frame.
        this.cam(
          x + 2.6,
          deckY + 3.2 + e * 3.8,
          car.position.z + 11 + e * 11,
          x,
          deckY + 1.6,
          car.position.z - 12,
          56,
        );
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
    title: "CRAZY WAYMO",
    url: "crazy-waymo.vibedgames.com",
    accent: "#4bd1a0",
    tagline: "Arcade driving in real San Francisco",
    fontFamily: 'ui-monospace, "SF Mono", Menlo, monospace',
    scenes: director.scenes(),
  });
}
