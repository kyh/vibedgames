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
import { landmarkMarkers } from "../world/landmarks";
import { districtAt, type DistrictChar } from "../world/sf-map";
import {
  type Approach,
  type CornerSpot,
  type CrestSpot,
  type DescentSpot,
  type FreewayRun,
  type GateSpot,
  type JunctionSpot,
  type NearRun,
  type RunSpot,
  type ScoutCtx,
  edgeInPlayArea,
  isWaterAt,
  nearFreeway,
  scoutArterial,
  scoutCorners,
  scoutCrests,
  scoutDescent,
  scoutFreeway,
  scoutGoldenGate,
  scoutPlowRun,
  scoutRunNear,
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

const HERO_SKIN = "waymo";

/** The pack-race beat is the trailer's only chance to say "the robotaxi is a
 *  CHOICE" — six liveries bought at garages, not six flavours of traffic.
 *
 *  The player stays in the WHITE WAYMO for it. A revision that put the player
 *  in the Cybercab to make the roster read did the opposite on screen: against
 *  dark asphalt at 0.44 the dark-gold coupe is chromatically indistinguishable
 *  from traffic, and the frame-by-frame verification could not identify the
 *  subject in ANY of the four delivered stills. The trailer spends twelve other
 *  beats training the viewer on one silhouette — white body, blue lidar band,
 *  roof dome — and this is the shot where losing it costs the most, because it
 *  is the only shot with six similar cars in it. The roster still reads: the
 *  five RIVALS wear everything else, Cybercab included. */
const RIVAL_SKINS: readonly string[] = SKIN_IDS.filter((id) => id !== HERO_SKIN);

/** Boulevard desirability by district character. A trailer shot on a street
 *  is also a shot of the neighbourhood it runs through, and the raw
 *  length × width score kept handing the biggest beats to Dogpatch warehouse
 *  walls and the China Basin pier apron — the two characters with the least
 *  San Francisco in them. */
const DISTRICT_WEIGHT: Partial<Record<DistrictChar, number>> = {
  downtown: 1.35,
  highrise: 1.35,
  commercial: 1.35,
  victorian: 1.25,
  residential: 1,
  park: 0.9,
  industrial: 0.5,
  wharf: 0.5,
};

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

/** HUD policy: everything off; only the fare run restores the juicy layer
 *  (score, dial, fare card, combo/receipt) — nav chrome stays hidden.
 *
 *  Module-level because it also has to run BEFORE the first scene stages: the
 *  game's boot HUD (EARNED 0 / TIME 60 + the loading bar) draws above the
 *  shell's black cut plate, so it was on screen for the recording's opening
 *  frames until something hid it. */
function hideChrome(hud: boolean): void {
  setDisplay("hud", hud);
  setDisplay("netinfo", false);
  setDisplay("touch", false);
  for (const id of ["minimap", "area", "district", "dest-arrow"]) setDisplay(id, false);
}

class Director {
  private stage: TrailerStage | null = null;
  private readonly city: CityModel;
  private readonly ctx: ScoutCtx;

  // Scouted once — the baked world is deterministic, so these never change.
  private readonly plow: RunSpot | null;
  private readonly boulevards: { edge: NetEdge; dir: 1 | -1 }[];
  private readonly arterial: { edge: NetEdge; dir: 1 | -1 };
  private readonly crests: CrestSpot[];
  private readonly descent: DescentSpot | null;
  private readonly ferry: NearRun | null;
  private readonly bayBridge: NearRun | null;
  private readonly bayBridgeAt: { x: number; z: number } | null;
  private readonly summit: NearRun | null;
  private readonly summitAt: { x: number; z: number } | null;
  /** The Golden Gate's south landfall. Not a beat of its own — it is what the
   *  vista crane opens onto, 1238u out, and the only structure that survives
   *  that range (see sceneVista). */
  private readonly fortPointAt: { x: number; z: number } | null;
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
  /** 0..1 camera blend a scene drives itself (step changes are instantaneous;
   *  a camera that followed one would cut rather than move). */
  private blend = 0;
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
    // The plow beat has the hardest requirement in the cut (230u of straight,
    // flat, DRY kerb), so it claims its street first and the general-purpose
    // boulevards are picked around it.
    this.plow = scoutPlowRun(this.ctx);
    this.boulevards = this.pickBoulevards(4, this.plow?.edge);
    this.arterial = scoutArterial(this.ctx) ?? this.boulevard(0);
    this.crests = scoutCrests(this.ctx, 3);
    this.descent = scoutDescent(this.ctx);
    // Landmark-anchored beats. landmarkMarkers resolves the authored lat/lon
    // marks against the built network, so these are the monuments' real
    // positions, not the authoring guesses.
    const marks = landmarkMarkers(city.network);
    const markAt = (name: string): { x: number; z: number } | null =>
      marks.find((m) => m.name === name) ?? null;
    const runAt = (
      name: string,
      opts: { radius: number; minLen: number; minHalf: number },
    ): NearRun | null => {
      const m = markAt(name);
      return m ? scoutRunNear(this.ctx, m.x, m.z, opts) : null;
    };
    this.ferry = runAt("the Ferry Building", { radius: 90, minLen: 60, minHalf: 5 });
    this.bayBridge = runAt("the Bay Bridge", { radius: 60, minLen: 55, minHalf: 5 });
    this.bayBridgeAt = markAt("the Bay Bridge");
    this.summit = runAt("the Twin Peaks overlook", { radius: 70, minLen: 45, minHalf: 3 });
    this.summitAt = markAt("the Twin Peaks overlook");
    this.fortPointAt = markAt("Fort Point");
    this.freeway = scoutFreeway(this.ctx);
    const corners = this.pickCorners();
    this.fareCorner = corners.fare;
    this.driftCorner = corners.drift;
    this.junctions = scoutSignalJunctions(this.ctx, 10);
    this.gate = scoutGoldenGate(this.ctx);
    for (const [name, ok] of [
      ["crest", this.crests.length > 0],
      ["descent", this.descent !== null],
      ["plow street", this.plow !== null],
      ["ferry building", this.ferry !== null],
      ["bay bridge", this.bayBridge !== null && this.bayBridgeAt !== null],
      ["twin peaks", this.summit !== null && this.summitAt !== null],
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
    this.blend = 0;
    this.substituted = false;
    this.fakes = [];
    return st;
  }

  private hudVisible(on: boolean): void {
    hideChrome(on);
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
   *  impact shake fed by real collisions (lastWallHit).
   *
   *  `sideLeft`: lateral eye offset in units along (+tz, −tx), which with y up
   *  is the LEFT of travel — used when the boost flame would otherwise eclipse
   *  the action dead ahead. The parameter used to be called `side` and
   *  documented as right-of-travel; it never was, and that inversion is what
   *  staged the demolition cruisers head-on into the plow line. Sign checked
   *  against world/roads.ts (its lane normal is (−tz, tx) and it drives the
   *  +side along the edge's own direction) and game/traffic.ts, which offsets
   *  every car by that same normal. */
  private chaseCam(
    dist: number,
    height: number,
    ahead: number,
    dts: number,
    fov: number,
    sideLeft = 0,
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
    const lx = fz; // (+tz, -tx) — left of travel
    const lz = -fx;
    this.shake = Math.max(0, this.shake - dts * 2.2);
    if (car.lastWallHit > 5) this.shake = Math.min(1, this.shake + 0.45);
    const s = this.shake * this.shake;
    const t = performance.now() / 1000;
    const px =
      car.position.x -
      fx * dist +
      lx * sideLeft +
      (Math.sin(t * 31) + Math.sin(t * 57) * 0.6) * s * 0.5;
    const py = car.position.y + height + (Math.sin(t * 43) + Math.sin(t * 71) * 0.6) * s * 0.35;
    const pz =
      car.position.z -
      fz * dist +
      lz * sideLeft +
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
   *  Offsets are in units: `back`/`up`/`left` place the eye, `aheadOf`/
   *  `aimUp`/`aimLeft` place the look-at, all relative to the car and its
   *  smoothed heading. `floorY` is an ABSOLUTE minimum eye height, and only
   *  binds when it exceeds `car.y + up`.
   *
   *  The two lateral offsets run along (+tz, −tx) — the LEFT of travel. They
   *  were named `right`/`aimRight` and every caller's value was tuned by eye
   *  against the delivered frames, so the numbers were right and the name was
   *  not; the same inversion in edgePath's docstring is what put the
   *  demolition cruisers in the player's lane. */
  private trackCam(
    o: {
      back: number;
      up: number;
      left?: number;
      aheadOf: number;
      aimUp?: number;
      aimLeft?: number;
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
    const lx = fz;
    const lz = -fx;
    const left = o.left ?? 0;
    const px = car.position.x - fx * o.back + lx * left;
    const pz = car.position.z - fz * o.back + lz * left;
    const floor = o.floorY ?? this.city.heightAt(px, pz) + 1.4;
    const aimLeft = o.aimLeft ?? 0;
    this.cam(
      px,
      Math.max(car.position.y + o.up, floor),
      pz,
      car.position.x + fx * o.aheadOf + lx * aimLeft,
      car.position.y + (o.aimUp ?? 1.0),
      car.position.z + fz * o.aheadOf + lz * aimLeft,
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
  private pickBoulevards(n: number, exclude?: NetEdge): { edge: NetEdge; dir: 1 | -1 }[] {
    const scored: { edge: NetEdge; score: number; x: number; z: number }[] = [];
    for (const e of this.city.network.edges) {
      if (e === exclude) continue;
      if (e.len < 150 || e.half < 4.4) continue;
      if (!edgeInPlayArea(e)) continue;
      const a = this.city.network.sample(e, 0);
      const b = this.city.network.sample(e, e.len);
      const straightness = Math.hypot(b.x - a.x, b.z - a.z) / e.len;
      if (straightness < 0.95) continue;
      // Flat: every consumer of this list is a straight-line speed shot, and a
      // hidden dip either hides the subject or launches it.
      let maxGrade = 0;
      for (let s = 6; s <= e.len; s += 6) {
        const p = this.city.network.sample(e, s - 6);
        const q = this.city.network.sample(e, s);
        maxGrade = Math.max(
          maxGrade,
          Math.abs(this.city.heightAt(q.x, q.z) - this.city.heightAt(p.x, p.z)) / 6,
        );
      }
      if (maxGrade > 0.06) continue;
      const mid = this.city.network.sample(e, e.len / 2);
      const weight =
        DISTRICT_WEIGHT[districtAt(this.city.gridX(mid.x), this.city.gridZ(mid.z)).character] ?? 1;
      scored.push({ edge: e, score: e.len * e.half * straightness * weight, x: mid.x, z: mid.z });
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

  /** The same junction taken the OTHER way round: arrive down the exit street,
   *  leave down the entry street. scoutCorners emits both orientations of every
   *  corner but then de-duplicates by POSITION, so only one of the pair ever
   *  survives — and which one is an accident of node order, not a choice. Both
   *  arms are the same two streets, so `cornerFlat` (which probes the same two
   *  points, swapped) is unchanged by the flip. */
  private reverseCorner(c: CornerSpot): CornerSpot {
    return {
      node: c.node,
      x: c.x,
      z: c.z,
      inArm: { ...c.outArm, tx: -c.outArm.tx, tz: -c.outArm.tz },
      outArm: { ...c.inArm, tx: -c.inArm.tx, tz: -c.inArm.tz },
    };
  }

  private pickCorners(): { fare: CornerSpot | null; drift: CornerSpot | null } {
    // 8, not 20. scoutCorners de-duplicates within 160u BEFORE applying `max`,
    // and this bake only yields 8 distinct corners — asking for 20 returned
    // the identical list (verified headless), so the wider scan bought nothing
    // and the "top eight are all downtown retail" reasoning it carried was
    // simply false.
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
    // What the Victorian preference was actually losing to: the only Victorian
    // corner in `rest` stares 18 degrees off the sun ONE way round (dot 0.954)
    // and 72 degrees off it the other (dot 0.300), and scoutCorners had kept
    // the wrong one. Trying the reversed turn is what makes the preference the
    // docstring has always claimed real — measured, the drift now lands on the
    // Victorian block instead of a commercial one.
    const turns = rest.flatMap((c) => [c, this.reverseCorner(c)]);
    const drift =
      turns.find((c) => sunOk(c) && isVic(c)) ??
      turns.find(sunOk) ??
      turns.find(isVic) ??
      rest[0] ??
      fare;
    return { fare, drift };
  }

  /** Polyline down an edge in travel order. `lateral` offsets it along
   *  (+tz, −tx), which with y up is the LEFT of travel — so a POSITIVE lateral
   *  puts the line in the ONCOMING lane, and the right-hand lane a scene
   *  actually wants is a NEGATIVE one.
   *
   *  This docstring said "right-of-travel" for three revisions and both
   *  measured lane collisions in the cut came from believing it. The ground
   *  truth is world/roads.ts, which builds its lane normal as (−tz, tx) and
   *  states that the +side of THAT normal is driven along the edge's own
   *  direction, and game/traffic.ts, which poses every car at
   *  `smp − (tanZ, −tanX)·lane` off the same normal. Two consequences worth
   *  keeping in mind when staging: an ONCOMING car sits at +lane in this
   *  frame (the same side as a positive `lateral`), and a SAME-DIRECTION one
   *  at −lane. */
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
   * blows to white. So the trailer opens warm (0.42), sits in the warm band for
   * the verbs (0.40-0.44), drops to dusk for the climax, and comes back out
   * into the light for the last two beats. Two bands are banned outright:
   * 0.48-0.52 and 0.89-0.95, where day-night.ts lerps the shadow direction as a
   * VECTOR from sun to moon and the city casts full-strength shadows from a
   * light 15 degrees off the visible sun.
   *
   * The order of the last four is what that costs and buys. Sorting purely by
   * phase put the two dusk beats and the closer together, and the reel then
   * spent its final nine seconds in the dark — measured 46 / 29 / 37 mean luma
   * on the last three shots against a 49 reel mean, with the closer also the
   * emptiest frame in the cut. The dusk pair is now the climax proper, back to
   * back, and the vista and the Golden Gate follow it in daylight. The reversal
   * is deliberate and it earns its keep twice: it ends the trailer on a value
   * change instead of a third shade of night, and the vista crane opens onto
   * the Golden Gate silhouette 1238u away, which is the shot that comes next.
   *
   * CONTRAST. Nothing reads as fast when everything is fast. The three boost
   * shots (cold open, demolition, freeway) are spaced so each lands against a
   * slower neighbour, and the fare run deliberately drives at 20-24 u/s.
   *
   * CAMERA. Consecutive pairs change grammar: chase, locked-off whip-by,
   * crane, tracking, locked-off, chase, locked-off, chase, chase, tracking,
   * locked-off, crane, locked-off. The one repeat (pack race into demolition)
   * is deliberate — the compositions differ by a 9u lateral swing and the
   * subjects are opposites (six clean liveries, then a block of cartwheeling
   * wreckage).
   *
   * PLACE. The map is the product. Measured against this bake, the cut visits
   * a Mission victorian avenue, the Embarcadero at the Ferry Building, Alamo
   * Square, a second victorian block for the drift, a West Portal grade, a
   * downtown junction, the Twin Peaks summit, the Bay Bridge anchorage and the
   * Golden Gate.
   *
   * What it does NOT do is spread evenly: five beats (the crest, the pack
   * race, the plow street, the summit approach and the freeway) resolve to the
   * western residential belt — the Sunset and Lakeshore — because that is
   * where this network's long, flat, straight, dry-kerbed runs are, and every
   * one of those beats has a hard geometric requirement that the dense
   * districts cannot meet. pickBoulevards weights by district character to
   * claw back what it can; scoutPlowRun, scoutCrests and scoutFreeway take the
   * geometry wherever it exists. Closing that gap needs a district-weighted
   * variant of all three, not a docstring.
   */
  scenes(): TrailerScene[] {
    return [
      this.sceneColdOpen(), // chase          0.42  speed
      this.sceneHillAir(), // locked-off      0.42  air
      this.sceneWaterfront(), // crane        0.40  the city is real
      this.sceneFareRun(), // tracking        0.43  the loop
      this.sceneMontageDrift(), // locked-off 0.44  the drift
      this.sceneHillDescent(), // chase       0.44  the SF grade
      this.sceneMontageSmash(), // locked-off 0.44  cones
      this.scenePackRace(), // chase          0.44  other players + liveries
      this.sceneTrafficChaos(), // chase      0.44  physics
      this.sceneFreeway(), // tracking        0.47  dusk viaduct
      this.sceneBayBridgeNight(), // locked   0.47  dusk landmark
      this.sceneVista(), // crane             0.42  the whole city, from above
      this.sceneHeroDrive(), // locked-off    0.40  release
    ];
  }

  /** 1 — COLD OPEN: flat out down a downtown arterial, threading moving
   *  traffic on both sides. Game chase rig (speed crouch + FOV kick). */
  private sceneColdOpen(): TrailerScene {
    return {
      id: "cold-open-weave",
      // 3000, not 4500. The opening shot is one straight road at one speed;
      // past ~3s it has said everything it has to say and the trailer is just
      // waiting. Cutting it early is what makes the next cut land.
      duration: 3000,
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
        //
        // NEGATIVE 2.1: `lateral` is left-of-travel (see edgePath), so +2.1
        // was the oncoming lane. Measured on this bake — the staged oncoming
        // cars pose at +2.27 (traffic lane = min(half·0.42, 2.4) on a half-5.4
        // street), which put the trailer's OPENING SHOT 0.17u from four
        // head-on kinematic bodies closing at ~68 u/s. At −2.1 the gap is the
        // 4.37u this comment always claimed.
        const path = this.edgePath(edge, dir, 120, -2.1);
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
        //
        // Two things the first cut of this shot got wrong. The exhaust plume
        // fires straight down a dead-astern optical axis and stacks
        // additively, so by the end of the cut the trailer's opening subject
        // was a white blob with no car in it — hence the 3.6u lateral offset
        // (chaseCam documents exactly this use) and the longer look-ahead,
        // which together put the car off-centre with the flame off-axis and
        // the road carrying the rest of the frame. And the camera never moved:
        // same distance, same subject scale, four frames out of four. It now
        // pushes 13u → 8.5u as the boost lights, so the FOV kick lands against
        // a closing camera instead of a static one.
        //
        // The offset goes to the KERB side (−3.6, now that the car rides the
        // right lane), never the centreline side: at +3.6 the eye sits 0.77u
        // off the oncoming lane and every whoosh clips the lens.
        const push = smooth(clamp(t / 3000, 0, 1));
        this.chaseCam(13 - 4.5 * push, 3.4, 15, dts, lit ? 62 : 56, -3.6);
      },
    };
  }

  /** 2 — HILL AIR: crest the steepest scouted SF hill at speed, all four
   *  wheels off. Fixed low camera past the crest — the car launches at the
   *  lens, whips by and lands. */
  private sceneHillAir(): TrailerScene {
    return {
      id: "hill-air",
      // 2000, not 2600. At 46 u/s a 44u run-in is nearly a second of empty road
      // and a house wall before the car is even in shot — a third of the
      // trailer's second beat with no subject. 30u puts the car in frame from
      // the reveal, the launch at ~40% and the whip-by at ~70%, and the cut
      // ends before the following pan swings into the low sun.
      //
      // Not shorter than that, and not faster into the crest: a 20u run-in at
      // 42 u/s launched the car before the suspension had settled onto the
      // scouted line, it flew off the roadway, landed in a front yard and sat
      // there at 0 u/s for the back half of the cut.
      duration: 2000,
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
        const start = path.at(sC - 30);
        st.placeCar(start.x, start.z, Math.atan2(start.tx, start.tz), 0);
        // Camera 24u past the crest and 2.4u off the centreline, low over the
        // ROADWAY (the shoulder line is lamp-post/tree territory — a trunk 1u
        // from the lens fills the frame once the car passes). Close and on a
        // long lens: the airborne car used to read 6% of frame width against a
        // flat tan hillside of nearly the same value, which is the whole beat
        // rendered as a speck. 24u at 40 degrees is ~2.2x bigger, and the low
        // eye puts the launch against sky instead of against the cut bank.
        //
        // 2.4, not 1.8: this crest edge measures half 3.2, the car is driven
        // on the CENTRELINE and it arrives ballistic with air steering, so at
        // 1.8 a landing that drifts 0.9u laterally — nothing, on a beat whose
        // earlier variant left the roadway entirely — puts the chassis through
        // the lens. 2.4 is still 0.8u inside the kerb. The eye offset goes
        // 1.5 -> 1.8 to compensate: the shoulder falls away 0.36u over that
        // 0.6u, so the eye lands within 0.06u of the height it was shot at.
        const p = path.at(sC + 24);
        this.sceneNode.set(p.x + p.tz * 2.4, p.z - p.tx * 2.4);
        this.sceneAux.set(this.city.heightAt(this.sceneNode.x, this.sceneNode.y) + 1.8, 0);
        this.applyInput({ throttle: 1, boost: true });
        await settle();
        this.kickSpeed = 36;
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
          40,
        );
      },
    };
  }

  /** 3 — THE CITY IS REAL: the Embarcadero at the FERRY BUILDING, running
   *  SOUTH toward the building with the bay off the left (seaward) shoulder.
   *
   *  Compass, measured rather than assumed: the resolved run is
   *  (748,-1008) -> (787,-943), and north is -Z in this world (the Ferry
   *  Building mark sits at z -910, the Bay Bridge landfall at z -747, and the
   *  Ferry Building is north of the bridge), so travel is southbound. An
   *  earlier version of this comment had it northbound with the bridge astern;
   *  the bridge is in fact ahead and off to the left, and Coit Tower is behind.
   *
   *  This shot's job is the one claim the whole product rests on — that you are
   *  driving actual San Francisco — and until now it played in China Basin,
   *  because the scout that chose it filtered on the `wharf` district character
   *  and the Embarcadero at the Ferry Building classifies as the Financial
   *  District. It is now anchored on the resolved monument itself (see
   *  scoutRunNear): closest approach of the run to the mark is 42u, and the
   *  mark itself is 41u BEYOND the end of the edge, straight down the travel
   *  direction — which is why the car never reaches it inside the cut and why
   *  the aim has to be pointed at it rather than away.
   *
   *  The other failure was scale: a 30u standoff at 60 degrees rendered the
   *  Waymo 3% of frame width — indistinguishable from a road marking, four
   *  identical frames, nothing moving anywhere. The crane now starts close and
   *  descends while its aim swings out over the water, and three fleet cars are
   *  staged down the run so the car has something to thread. */
  private sceneWaterfront(): TrailerScene {
    return {
      id: "embarcadero",
      duration: 2800,
      setup: async () => {
        const run = this.ferry;
        if (!run) {
          await this.substituteBoostRun(0.4);
          return;
        }
        const path = this.edgePath(run.edge, run.dir, 90);
        const start = path.at(2);
        // Scatter traffic clear of the run: the teleport otherwise leaves most
        // of the fleet >260u away and the recycler mass-respawns it 78-156u
        // AHEAD on the sparse wharf edges — a random rear-end punt mid-shot.
        const st = this.base({ phase: 0.4, avoidX: start.x, avoidZ: start.z, avoidR: 14 });
        this.path = path;
        st.placeCar(start.x, start.z, Math.atan2(start.tx, start.tz), 0);
        // Which shoulder the bay is on, measured rather than assumed: the
        // apron between roadway and open water is ~60u wide here.
        const mid = path.at(run.edge.len * 0.5);
        this.driftSide = isWaterAt(mid.x + mid.tz * 60, mid.z - mid.tx * 60) ? 1 : -1;
        // Three fleet cars down the run, same direction and slower: the shot
        // gets a verb (a real overtake through real traffic) instead of a
        // straight line at a constant speed.
        const cars = this.stagedTraffic(3);
        const sEdge = (travel: number): number => (run.dir > 0 ? travel : run.edge.len - travel);
        [22, 44, 64].forEach((s, i) => this.placeTraffic(cars[i], run.edge, sEdge(s), run.dir));
        // Staged at rest: NEUTRAL through the cut, full speed at reveal.
        await settle();
        this.kickSpeed = 28;
      },
      run: (t, dt) => {
        if (this.runSubstitute(dt)) return;
        this.reveal();
        const st = this.stage;
        const path = this.path;
        if (!st || !path) return;
        const dts = Math.min(dt, 50) / 1000;
        // No boost here. This is the breath between the cold open and the fare
        // run, and the flame washes out the one shot whose job is the view.
        this.followPath(
          30,
          false,
          dts,
          st.traffic.cars.map((c) => c.position),
        );
        const water = this.driftSide;
        // The balancing act: rake toward the bay for water, but the beat is
        // named after a BUILDING and the building is on the land shoulder.
        // Both have to be in the same frame, and the previous rake could not
        // do it: at back 16-20 on a 44-degree lens (horizontal half-angle
        // ~36 degrees) a 14→20u seaward aim offset put the optical axis 39-51
        // degrees off travel, and the Ferry Building — 113u ahead and 23u to
        // the LAND side at t0 — measured 46 degrees, then 55 degrees, off
        // axis. The shot whose job is a named landmark did not contain it for
        // the first 60% of its length.
        //
        // The aim now STARTS inland (4u, axis dead down the road, the building
        // near centre) and swings out over the water, so the frame opens from
        // "the Embarcadero with the Ferry Building at the end of it" onto the
        // bay. Measured off-axis for the building across the cut: -8, -26,
        // +5 degrees — inside the frustum throughout — and the car itself sits
        // between 11 and 15 degrees off axis, so it never leaves frame either.
        //
        // The eye has to stay HIGH. Dropped to 6u it framed nothing but the
        // four-storey block on the land shoulder, and no water appeared at
        // all; the pier apron here is ~60u wide, so the bay only clears the
        // shed rooflines from around 12u up. It also comes IN to 4u off the
        // centreline: at 7u the extra parallax pushed the building a further
        // 3-6 degrees toward the frame edge for nothing the frame showed.
        const e = smooth(clamp(t / 2800, 0, 1));
        this.trackCam(
          {
            back: 20 - 4 * e,
            up: 17 - 5 * e,
            left: -water * 4, // eye inland, over the sidewalk
            aheadOf: 6,
            aimLeft: water * (-4 + 12 * e),
            aimUp: 1.2,
            fov: 44,
            lag: 3, // slow, so the crane drifts rather than snaps
          },
          dts,
        );
      },
    };
  }

  /** 10 — NIGHT CITY: the elevated viaduct at full boost, rival taxis running
   *  it with you, the lit skyline off to the side.
   *
   *  Shot after sundown for two reasons. Every clean, straight, elevated, downtown-
   *  facing run in this bake points at the sun all day long — the sun sits in
   *  the southern half from dawn to dusk and the viaducts run south-southwest —
   *  so a daylight version is either a white-out or a run pointed away from the
   *  skyline. After dark there is no sun to dodge, the city reads as a field of
   *  lit windows, and the player's headlights are the only real light source in
   *  frame, which suits a boost run down an empty deck.
   *
   *  NIGHT, NOT DARKNESS. 0.66 measured 88-90% of every frame crushed at or
   *  below value 25 and a mean luma of 12/255 — no deck, no rail, no drop, no
   *  rivals, nothing. It sat between the two sun-at-minus-30 stops, whose fills
   *  day-night.ts deliberately halves for phone legibility. 0.47 — the sunset
   *  stop, sun 2 degrees up, lamp factor 0.62 — is where the windows, the
   *  headlights and the deck lamps are all lit while a twilight sky still gives
   *  the deck and the drop below it a silhouette. Later than that (0.53 is the
   *  first stop past the banned 0.48-0.52 shadow handoff) the sky goes with it
   *  and the drop stops reading at all.
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
          await this.substituteBoostRun(0.53);
          return;
        }
        const st = this.base({ phase: 0.47 });
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
        // NO BOOST. The twin plume fires dead astern into a lens 15u back and
        // at this hour it is the brightest thing in frame by an order of
        // magnitude: measured, it bloomed over the bottom-right quadrant and
        // was the only part of the player a viewer could find. Throttle alone
        // holds 38 u/s up here, which is what the deck, the rails and the
        // rivals need to read anyway — the trailer already boosts in four
        // other beats.
        this.applyInput({ throttle: 1 });
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
        const obstacles = this.fakes.map((f) => {
          const p = path.at(f.s);
          return { x: p.x + p.tz * f.lane, z: p.z - p.tx * f.lane };
        });
        this.followPath(40, true, dts, obstacles);
        // Raked off the side rather than straight down the lane: shooting
        // along the deck axis puts the barrier out of frame on both sides, so
        // "elevated viaduct" rendered identically to a surface street. From 8u
        // off the car the deck edge, the rail and the drop below all sit in
        // the near third and the run finally reads as being up in the air.
        //
        // NO floorY. city.heightAt up here is the STREET, 7u below the deck,
        // so the trackCam default floor would let the eye sink through the
        // roadway — but `up: 10` is measured off the CAR, which is on the
        // deck, so the eye is 10u above the deck by construction and no floor
        // can bind. (The previous revision passed `floorY: car.y + 1.6` with a
        // comment claiming to guard exactly this; `Math.max(car.y + 10, ...)`
        // meant it was dead code. Keep `up` well above the barrier height and
        // the guard is not needed; drop it below and the deck-relative floor
        // has to come back as a real deck-top probe at the CAMERA's position,
        // not the staging point, whose ramped profile once held the eye 20u
        // up in a near-top-down.)
        // A rigid follow rig holds the car at exactly one screen position for
        // the whole cut (measured: NDC 0.131/−0.442 at all four sample marks),
        // so the only motion a viewer gets is the deck sliding under it. The
        // slow swing in and down over the barrier gives the near rail and the
        // town below real parallax against the car — this beat sits in the
        // stretch of the reel the frame-by-frame pass called the most static.
        const e = smooth(clamp(t / 2600, 0, 1));
        this.trackCam(
          {
            back: 15,
            up: 9 - 1.6 * e,
            left: 13 - 4 * e,
            aheadOf: 16,
            aimLeft: -7,
            aimUp: 2.2,
            fov: 54,
          },
          dts,
        );
      },
      teardown: () => this.stage?.setFakePlayers(null),
    };
  }

  /** 11 — NIGHT LANDMARK: the Waymo running the Embarcadero straight at a
   *  locked-off lens, under the Bay Bridge anchorage, with the crossing itself
   *  springing out of the stonework and climbing away over the bay behind it.
   *
   *  SHOOT DOWN THE ROAD, NOT ACROSS IT. The first version stood 11u off the
   *  kerb and aimed sideways at the landfall; every delivered frame was the
   *  underside of the approach viaduct with a 6%-of-frame car under it, mean
   *  luma 10.2/10.5/10.2/3.6 with 82-98% of pixels crushed, and no span in
   *  frame at all. The geometry says why, and it is not fixable by nudging: the
   *  crossing runs out on bearing 40.5 degrees (world/landmarks.ts rotDeg 49.5)
   *  while this stretch of the Embarcadero runs almost due south, so a camera
   *  standing beside the road sees the span END-ON behind its own anchorage. A
   *  broadside camera has to stand out in the bay, and from far enough out to
   *  fit 600u of deck the car is a speck.
   *
   *  The composition that carries both is a camera ON the road axis, 8u off the
   *  kerb and 10u up — above the pier sheds' roofline, which is the only way the
   *  towers clear them — looking back NORTH up the Embarcadero with the aim
   *  raked out over the bay. Photographed at the four sample marks: the car runs
   *  43u -> 19u down the near lane at 94 -> 213px, the suspension towers, their
   *  cables and their lit deck sit in the upper third against the twilight band,
   *  and the anchorage masonry closes the top-left corner.
   *
   *  0.47, NOT 0.53. At the night stop this composition measures mean luma 11-12
   *  with four fifths of every frame crushed below 16 — the crossing is unlit
   *  structure over black water and the sky behind it is black too. 0.47 keeps
   *  the lamp factor at 0.62 (deck lamps, kerb pools and the car's own
   *  headlights all on) and puts a lit horizon behind the towers, which is the
   *  only thing in this frame that can silhouette them. Measured after the
   *  change: luma 30.5-31.0, 15.9-21.2% crushed. */
  private sceneBayBridgeNight(): TrailerScene {
    return {
      id: "bay-bridge-night",
      duration: 2400,
      setup: async () => {
        const run = this.bayBridge;
        const at = this.bayBridgeAt;
        if (!run || !at) {
          await this.substituteBoostRun(0.47);
          return;
        }
        // TOWARD the anchorage: scoutRunNear's own dir points away from it here
        // (measured, this bake: the run leaves the landfall heading south down
        // the Embarcadero), and the car has to drive INTO the frame the
        // anchorage anchors, not out of the back of it.
        const dir: 1 | -1 = run.dir > 0 ? -1 : 1;
        const path = this.edgePath(run.edge, dir, 60);
        const start = path.at(14);
        const st = this.base({ phase: 0.47, avoidX: start.x, avoidZ: start.z, avoidR: 26 });
        this.path = path;
        st.placeCar(start.x, start.z, Math.atan2(start.tx, start.tz), 0);
        // The eye sits 61u down the run, 8u off the kerb on the LAND shoulder,
        // looking back up the roadway. 8u, not 11-30: the shoulders here carry
        // the anchorage footings on one side and pier sheds on the other, and
        // two earlier takes from further out were shot entirely into a flat
        // wall. Inside a kerb's width nothing can occlude.
        //
        // LAND SHOULDER, not the bay one, and it is composition rather than
        // safety. Measured from the bay shoulder: a pier shed sits ~10u off the
        // lens and its blank flank filled 56% of frame, with the crossing
        // squeezed into the last few degrees behind it. From the land side the
        // same sheds are across the street, in the middle distance, where they
        // read as the waterfront the road runs along — and the crossing clears
        // their roofline because its towers are 40u tall.
        const camAt = path.at(61);
        // Which side the bay is on, measured rather than assumed: 26u out still
        // lands on seawall and pier apron on BOTH shoulders here (probed), so
        // the test has to reach past the wharf line before it means anything.
        // (tz, −tx) is the left of travel; looking back up the run that is also
        // the RIGHT of frame, which is what makes the rake below readable.
        const bay: 1 | -1 = isWaterAt(camAt.x + camAt.tz * 70, camAt.z - camAt.tx * 70) ? 1 : -1;
        const off = -8 * bay;
        const eye = { x: camAt.x + camAt.tz * off, z: camAt.z - camAt.tx * off };
        // Fall back to the far shoulder if the preferred one is already wet.
        const dry = isWaterAt(eye.x, eye.z)
          ? { x: camAt.x - camAt.tz * off, z: camAt.z + camAt.tx * off }
          : eye;
        // Aim up the run and RAKED 24u toward the bay: dead down the roadway
        // the crossing sits 44-49 degrees off axis against a 42-degree half
        // angle, i.e. just outside. The rake trades road for span — the car
        // only reaches 15 degrees the other way, so it has the room. The offset
        // uses the tangent AT THE CAMERA, not at the aim point: the run bends
        // through the landfall, and taking the aim's own tangent rotated the
        // offset up the street instead of across it (measured: it moved the
        // optical axis 3u the WRONG way).
        const l = path.at(10);
        const look = { x: l.x + camAt.tz * 24 * bay, z: l.z - camAt.tx * 24 * bay };
        this.sceneNode.set(camAt.x, camAt.z);
        this.sceneAux.set(dry.x, dry.z);
        this.sceneDir.set(look.x, look.z);
        this.applyInput({ throttle: 1 });
        await settle();
        // 15 u/s over 2.4s = 36u, which walks the car from 43u out to 19u —
        // measured 94px to 213px across, ending before it reaches the lens.
        // Not a boost run: the flame at this hour is a white hole, and the
        // headlights coming at the camera are the shot's light source.
        this.kickSpeed = 15;
      },
      run: (_t, dt) => {
        if (this.runSubstitute(dt)) return;
        this.reveal();
        const st = this.stage;
        if (!st) return;
        this.followPath(15, false, Math.min(dt, 50) / 1000);
        const camX = this.sceneAux.x;
        const camZ = this.sceneAux.y;
        // Eye height off the ROADWAY, not off the camera's own ground: the
        // shoulder here steps down to riprap and pier apron.
        const eyeY = this.city.heightAt(this.sceneNode.x, this.sceneNode.y) + 10;
        const aimX = this.sceneDir.x;
        const aimZ = this.sceneDir.y;
        // Aim 4u over the roadway, not up at the deck: the towers are 40u tall
        // and 80-250u out, so they fit the upper frame on their own, while the
        // car is 17-57u out and needs the lower third to itself.
        this.cam(camX, eyeY, camZ, aimX, this.city.heightAt(aimX, aimZ) + 6, aimZ, 54);
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

  /** 4 — the core loop as one continuous gameplay shot: board a staged
   *  customer, drift the corner, skid into the drop-off, confetti + receipt.
   *  Fare HUD on.
   *
   *  Two fixes the measured frames forced. LIGHT: this is the trailer's
   *  longest cut and the one that has to sell the loop, and at 0.465 it played
   *  at effective dusk — mean luma 29-36 of 255 with 48-60% of every frame
   *  crushed black. That is the exact failure DRIFT_PHASE documents ("at 0.465
   *  the sun is 2 degrees up and a two-storey street reads as near-night"),
   *  applied everywhere in this file except here. 0.43 puts the sun ~9 degrees
   *  up with the key still near full, and the beacons and combo pops read
   *  against a warm street instead of a black one.
   *
   *  CAMERA: it used to hand the shot to the game's own chase rig, which is
   *  tuned for playing — high, far and unchanging, so the car sat at 4-5% of
   *  frame width for all 4.8 seconds. The director drives it now: tight and
   *  low through the pickup and the drift, then widening onto the confetti so
   *  the payout beat has somewhere to open into. */
  private sceneFareRun(): TrailerScene {
    return {
      id: "fare-run",
      duration: 4600,
      setup: async () => {
        const corner = this.fareCorner;
        if (!corner) {
          await this.substituteBoostRun(0.43);
          return;
        }
        const st = this.base({
          phase: 0.43,
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
        // LONG tier, not medium: same staging cost, but the red $$$ beacon and
        // the 1.5x receipt line are the distinctive end of a scale the trailer
        // otherwise never shows.
        st.fares.stageTrailerFare(fromCell, destCell, "long");
        // Mid-run dashboard: a believable bankroll and a live combo chain.
        st.state.score = 2140;
        st.state.combo = 2;
        st.state.comboTimer = 8;
        st.hud.resetScore(2140);
        st.placeCar(corner.x - inA.tx * 44, corner.z - inA.tz * 44, Math.atan2(inA.tx, inA.tz), 0);
        // Staged at rest: NEUTRAL through the cut, full speed at reveal.
        await settle();
        this.kickSpeed = 20;
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
        // Tight and low for the pickup, the carry and the drift; widening onto
        // the drop-off so the confetti burst, the shockwave ring and the
        // itemised receipt land in an opening frame rather than a static one.
        // The blend is time-based: `step` jumps, and a camera keyed straight
        // off it would cut mid-scene instead of pulling out.
        const dts = Math.min(dt, 50) / 1000;
        this.blend += ((this.step >= 3 ? 1 : 0) - this.blend) * Math.min(1, 1.6 * dts);
        const wide = smooth(this.blend);
        this.trackCam(
          {
            back: 9.5 + 4 * wide,
            up: 3 + 2 * wide,
            left: 3,
            aheadOf: 11 - 3 * wide,
            aimUp: 1.1 + 0.4 * wide,
            fov: 58 + 4 * wide,
            lag: 5,
          },
          dts,
        );
      },
      teardown: () => {
        this.hudVisible(false);
        this.stage?.fares.setTrailerHold(true);
      },
    };
  }

  /** 8 — OTHER PLAYERS, AND THE ROSTER: a pack of rival robotaxis running the
   *  same boulevard, the white Waymo threading up through them from the back.
   *
   *  Legibility is the whole job here — "multiplayer" has to read in three
   *  seconds with no text. Four things carry it: five distinct rival liveries
   *  (every GLB is preloaded before beginTrailer, so a mixed pack can never
   *  magenta-box); the roof beacon RemoteCars gives every remote player, whose
   *  colour is a hash of the id; a player car the viewer can find instantly;
   *  and an overtake that actually completes on camera.
   *
   *  The measured failure was distance. A pack spread 20-70u ahead of a camera
   *  12.5u back renders six liveries as 40-90px grey blobs and their beacon
   *  colours as single pixels, and 6-11 u/s of closure over 3.4s cannot clear
   *  that spread — so the shot promised a pass and delivered a convoy, with an
   *  ordinary NPC minibus as the largest vehicle in three of four frames. The
   *  pack now runs 14-42u out, the chase is 10.5u back on a 66-degree lens, and
   *  avoidR clears the live fleet 45u off the corridor so nothing but rivals is
   *  in shot.
   *
   *  THE FOREGROUND HAS TO STAY EMPTY. The first respread put the tail of the
   *  pack at s=6 with the player at s=10 on a ±3.0 lane split — a rival 4u
   *  ahead and 3u across from a lens 8.5u back, which delivered a blurred white
   *  mass with a blown headlight ellipse eating a sixth of the frame in three
   *  of four stills, and read as the camera clipping through another car. The
   *  whole pack now starts AHEAD of the player (nearest 4u further out than the
   *  camera's own standoff) on a ±4.4 split, so every rival is something the
   *  Waymo drives up to and past rather than something the lens is inside.
   *
   *  Remote cars are visual-only — no colliders — so the player passes THROUGH
   *  anything it touches. Lanes are laid out so that never has to happen on
   *  camera: the pack holds two lanes and the player threads the gap between.
   */
  private scenePackRace(): TrailerScene {
    return {
      id: "pack-race",
      duration: 2600,
      setup: async () => {
        const { edge } = this.boulevard(1);
        const dir = this.awayFromSun(edge, 1, 0.44);
        // The player runs the CENTRELINE here, not a lane. The pack all sits
        // right of travel and the camera swings left, so the two need opposite
        // halves of the street to stay on tarmac: staged 2.2u left of centre
        // (the previous value) the swing carried the eye over the kerb and the
        // final frame was half building wall. Safe only because avoidR below
        // teleports the entire live fleet ~390u clear and the rivals are
        // remote-player visuals with no colliders — nothing this line could hit
        // exists in the shot. Pack lanes are relative to this line.
        const path = this.edgePath(edge, dir, 140);
        const start = path.at(10);
        // base() wipes the per-scene scratch, this.path included — assign after.
        // 0.44, not golden 0.465: this district reads near-night at 0.465 and
        // the whole point of the shot is telling the liveries apart.
        // avoidR is in TILES (13u): 30 clears the fleet ~390u off a corridor
        // the player covers in 140u, so the only vehicles in shot are rivals.
        // The largest, nearest car in three of four delivered frames used to be
        // an ordinary NPC minibus, which actively taught the viewer that the
        // pack was traffic.
        const st = this.base({ phase: 0.44, avoidX: start.x, avoidZ: start.z, avoidR: 30 });
        this.path = path;
        this.weaveAmp = 2.0;
        st.placeCar(start.x, start.z, Math.atan2(start.tx, start.tz), 0);
        // The pack starts 12u ahead of the player — 22.5u from a lens that sits
        // 10.5u back — and every rival holds the RIGHT of travel. That is the
        // fix for the lower-left smear: chaseCam's swing moves the eye left of
        // travel, so a lane at +4.4 puts a just-overtaken rival within half a
        // unit of the eye's own line and a couple of units ahead of it, i.e.
        // the lens inside another car (measured: it ate the bottom half of the
        // 88% frame). With the pack all on one side the camera swings AWAY from
        // it, the player passes on the open left, and a passed rival leaves
        // frame sideways at ~90 degrees off axis instead of across the lens.
        // 27-31 u/s, not 36-40. Measured: the player tops out at 38 u/s on
        // throttle alone (followPath's 46 target is never reached without
        // boost), so a pack at 36-40 has ±2 u/s of closure and NOTHING is ever
        // overtaken — the previous cut hid that by starting rivals level with
        // or behind the player, which is what put one in the lens. At 27-31 the
        // closure is 7-11 u/s and the first two passes land at ~t1.3s and
        // ~t2.3s of the 3s cut, both in open frame.
        this.fakes = RIVAL_SKINS.map((_, i) => ({
          s: 22 + i * 8,
          lane: i % 2 === 0 ? -3.6 : -7.2,
          speed: 27 + (i % 3) * 2,
        }));
        this.publishPack();
        this.applyInput({ throttle: 1 });
        await settle();
        this.kickSpeed = 38;
      },
      run: (t, dt) => {
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
        // player is closing on them.
        const obstacles = this.fakes.map((f) => {
          const p = path.at(f.s);
          return { x: p.x + p.tz * f.lane, z: p.z - p.tx * f.lane };
        });
        this.followPath(46, false, dts, obstacles);
        // Close, and drifting off the axis as the pass develops: a rival seen
        // from dead astern is a rectangle, one seen from three-quarters is a
        // Zoox. Remote cars have no colliders, so an overtake can put the
        // camera THROUGH whichever rival was just cleared — the lateral swing
        // keeps the pass outside the near plane that the old 9.5u chase kept
        // clipping.
        const swing = smooth(clamp(t / 3000, 0, 1));
        this.chaseCam(10.5, 2.6, 17, dts, 66, 2.5 * swing);
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
          skin: RIVAL_SKINS[i % RIVAL_SKINS.length] ?? HERO_SKIN,
          msg: "",
          msgAt: 0,
        },
      };
    });
    st.setFakePlayers(players);
  }

  /** 9 — PHYSICS: full boost through a curbside row of parked cars, Rapier
   *  sending them tumbling. Low manual chase + impact shake.
   *
   *  THIS SHOT HAS NEVER ONCE BEEN SEEN, for two different reasons, and the
   *  street it stages on is the fix for both. First it took whatever
   *  `scoutArterial(exclude) ?? this.arterial` produced — and since
   *  scoutArterial returns null in this bake, both terms collapsed onto a bare
   *  longest-edge fallback, the one edge in the network that runs 357u past the
   *  ground collider: the car fell out of the world for the whole take. Then it
   *  took the third-best boulevard by length x width, which is the China Basin
   *  shoreline crossing, where "the curb lane, right of travel" is OPEN BAY —
   *  every staged car seated at the water height and sank, and the beat played
   *  as an empty intersection with a boost flame in it.
   *
   *  It now takes `scoutPlowRun`, whose whole job is to prove there is dry
   *  kerb — both sides, out to twice the curb offset, for the length of the
   *  run — before a single car is relocated onto it. */
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
        const alt = this.plow ?? this.boulevard(0);
        const dir = this.awayFromSun(alt.edge, alt.dir, 0.44);
        const path0 = this.edgePath(alt.edge, dir, 0);
        // Row start needs 91u of row + 70u run-out before the edge ends.
        const sRow = Math.max(64, Math.min(alt.edge.len - 180, alt.edge.len / 2 - 20));
        const p0 = path0.at(sRow);
        // Row against the LEFT kerb — (tz, -tx) is left of travel, not right
        // (see edgePath). scoutPlowRun proves both kerbs are dry, so the side
        // is free; what it costs is that the player's plow line then shares
        // the half of the street ONCOMING traffic uses, which is why the
        // cruisers below run with `dir`.
        const curb = Math.max(2.6, alt.edge.half - 1.6);
        const x0 = p0.x + p0.tz * curb;
        const z0 = p0.z - p0.tx * curb;
        const st = this.base({ phase: 0.44, avoidX: x0, avoidZ: z0, avoidR: 8 });
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
        // Row staged AFTER the player is on its mark: stageRow relocates the
        // parked cars NEAREST the row start, and the culling sweep that makes
        // them visible again is keyed off the camera, which placeCar snaps.
        st.stageParkedRow(x0, z0, p0.tx, p0.tz, ROW_N, ROW_GAP);
        // Two police cruisers in the far lane — they live at the front of
        // traffic.cars (POLICE_SHARE takes the first 8%): chaos with witnesses
        // instead of chaos in a vacuum.
        //
        // SAME direction, not oncoming. Measured on this bake: the plow line
        // sits at +3.4 in the edgePath frame and an oncoming car poses at
        // +2.4 — 1.0u between two 2u-wide bodies closing at ~56 u/s, i.e. a
        // guaranteed head-on inside the parked row on every take. With `dir`
        // the cruisers pose at −2.4, 5.8u clear of the plow line, and the
        // player never reaches them: it covers ~98u in the cut from −62 while
        // the nearer cruiser starts at +30 and drives away at 10-22 u/s.
        // (Placed AHEAD for the same reason the camera can't have them — the
        // eye rides 5u kerbward of the player at −1.6, 0.8u off their lane.)
        const sEdge = (travel: number): number => (dir > 0 ? travel : alt.edge.len - travel);
        const police = st.traffic.cars.slice(0, 2);
        [sRow + 30, sRow + 72].forEach((s, i) =>
          this.placeTraffic(police[i], alt.edge, sEdge(s), dir),
        );
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
        // Off the axis, not above it. Raising the eye to 5.0u to "look over"
        // the boost flame did not work — the plume is emitted straight down a
        // dead-astern optical axis and stacks additively, so it grew wider
        // than the car and by the end of the cut the vehicle was not visible
        // at all. 5u to the RIGHT of travel (the street side, opposite the
        // kerb row) takes the exhaust off-axis in one move and puts the row on
        // the far side of frame, where the punts have room to cartwheel.
        this.chaseCam(12, 3.6, 14, dts, 58, -5);
      },
    };
  }

  /** 5 — fast cut 1: committed handbrake drift around a Victorian corner,
   *  smoke and skids, mini-turbo pop on release. Fixed low cam on the exit
   *  street — the car slides around it, toward the lens.
   *
   *  1800, not 1500: the mini-turbo release — the button of the whole cut —
   *  fired at t≈1350 and was clipped by the dip 150ms later.
   *
   *  "Victorian" is now measured rather than hoped for — see pickCorners's
   *  reversed-turn fallback, which is what finally lets the preference beat
   *  the sun test. */
  private sceneMontageDrift(): TrailerScene {
    return {
      id: "montage-drift",
      duration: 1800,
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
        // of the turn so the drift sweeps across frame.
        //
        // 13u down the arm rather than 20: at 20 the opening frame was a dead
        // wide — 65px of car and the bottom 45% bare asphalt with the horizon
        // pinned at exactly mid-height. And 5.0u off the centreline rather than
        // 2.6: at the kerb line both head lamps stared into the lens and their
        // halos blew the largest hot patch in the reel over the hero frame, so
        // the eye moves further to the outside and the lamps rake past it.
        let px = outA.tz;
        let pz = -outA.tx;
        if (px * -inA.tx + pz * -inA.tz > 0) {
          px = -px;
          pz = -pz;
        }
        this.sceneAux.set(corner.x + outA.tx * 13 + px * 5, corner.z + outA.tz * 13 + pz * 5);
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
          if ((Math.abs(errExit) < 0.25 && t > 1250) || t > 1400) this.step = 2;
          else this.drift(this.driftSide);
        }
        if (this.step === 2) {
          this.driveAt(node.x + exit.x * 40, node.y + exit.y * 40, 34);
        }
        const p = car.position;
        const camX = this.sceneAux.x;
        const camZ = this.sceneAux.y;
        // 2.0u eye, not 3.4: lower drops the horizon to the upper third and
        // crops the dead asphalt out of the bottom of the approach frames.
        this.cam(camX, this.city.heightAt(camX, camZ) + 2, camZ, p.x, p.y + 0.9, p.z, 55);
      },
    };
  }

  /** 6 — THE SF GRADE: the roadway falls away under the camera. A steep
   *  straight descent taken flat out, entered late so the run ENDS on the
   *  steepening tail (this bake: 17.5% average, a 30% window, West Portal down
   *  into Miraloma Park).
   *
   *  This is the traversal verb that separates the map from a flat arcade city
   *  and it was missing entirely — every one of the previous eleven shots was
   *  filmed on level ground or on a single crest. The camera is the whole
   *  trick: a low chase aims at a point level with the car's own nose, so on a
   *  falling grade the roadway drops clean out of the bottom of frame at every
   *  brow and slams back in on the far side.
   *
   *  No boost. Gravity supplies the acceleration here, and holding a flame down
   *  a hill this steep just paints the lower frame orange. */
  private sceneHillDescent(): TrailerScene {
    return {
      id: "hill-descent",
      duration: 2200,
      setup: async () => {
        const d = this.descent;
        if (!d) {
          await this.substituteBoostRun(0.44);
          return;
        }
        const path = this.edgePath(d.edge, d.dir, 80);
        const start = path.at(d.sStart);
        const st = this.base({ phase: 0.44, avoidX: start.x, avoidZ: start.z, avoidR: 12 });
        this.path = path;
        // base() zeroes the rabbit, and project() only searches FORWARD of it —
        // entering mid-edge without this leaves the rabbit at the hilltop.
        this.pathS = d.sStart;
        st.placeCar(start.x, start.z, Math.atan2(start.tx, start.tz), 0);
        this.applyInput({ throttle: 1 });
        await settle();
        this.kickSpeed = 30;
      },
      run: (_t, dt) => {
        if (this.runSubstitute(dt)) return;
        this.reveal();
        // Target ABOVE what the hill will give anyway: a lower target makes the
        // pursuit controller brake on the descent, and braking mid-grade arms
        // the drift and spins the take.
        this.followPath(48, false, Math.min(dt, 50) / 1000);
        this.chaseCam(9.5, 2.3, 17, Math.min(dt, 50) / 1000, 66, 2.6);
      },
    };
  }

  /** 12 — THE VISTA: the Twin Peaks summit road, and the whole city underneath.
   *
   *  The map is the most expensive thing in this repo and no shot had ever
   *  stood anywhere high and looked at it — all eleven were filmed between 1.5u
   *  and 20u above a roadway, so the viewer never saw more than a block and a
   *  half of a 14km city. The hills, the height-attenuated aerial haze and the
   *  far-terrain silhouette bands only pay off from altitude.
   *
   *  Staging: the summit road climbs from y81 to y100 over 81u, running due
   *  NORTH, with the overlook terrace 46u off the eastern shoulder. The car
   *  drives it slowly while the camera cranes from a tight chase out to a wide,
   *  high three-quarter — so the shot OPENS rather than being a small subject
   *  held still.
   *
   *  IT LOOKS NORTH, NOT EAST. The first cut craned east, across the car toward
   *  the overlook, and every delivered frame was roofs: the terrace is the local
   *  HIGH ground (46u out and ~12u above the roadway), so aiming at it aims into
   *  the hill, and the beat commissioned as "the city from above" delivered a
   *  residential hillside with Sutro Tower over it.
   *
   *  Downtown cannot answer that, and it is worth writing down why so nobody
   *  re-tries it: the resolved towers are 1400u out on bearing 41-53, and
   *  DRAW_DISTANCE is 900 with fog far ~940 — the Financial District is not
   *  merely hazy from up here, it is culled. What IS renderable at that range is
   *  the bay itself and the Golden Gate, whose long-range stand-in
   *  (render/landmark-silhouette.ts) is drawn at EVERY distance by design. Fort
   *  Point resolves 1238u out on bearing -9, i.e. barely off the run's own
   *  travel direction, so pointing the crane down the road and letting the aim
   *  drift to the Gate's side of it puts the bay, the headlands and an orange
   *  portal on the horizon behind a whole neighbourhood of falling rooftops.
   *  Which side that is gets measured against the resolved monument, not
   *  assumed. It also sets up the closer, which is that bridge.
   *
   *  THE CRANE RUNS ON ITS OWN CLOCK (2.6s, against the aim's 4.2s). Measured
   *  on this bake, the ridge between the summit road and the strait hides the
   *  water until the eye passes ~123u absolute; a single 4.2s ramp only crosses
   *  that in the last second, so three of the four delivered frames would still
   *  have been rooftops. Lifting first and swinging after is also the better
   *  move — rise, then look.
   *
   *  Two cautions carried into the staging: do not drive onto the terrace (its
   *  paving disc and parapet blocks are meshes, and the landmark protection
   *  reserves those cells), and keep the eye above ~100u or the aerial haze
   *  washes the ridgelines out. */
  private sceneVista(): TrailerScene {
    return {
      id: "twin-peaks-vista",
      duration: 4200,
      setup: async () => {
        const run = this.summit;
        const at = this.summitAt;
        if (!run || !at) {
          await this.substituteBoostRun(0.44);
          return;
        }
        const path = this.edgePath(run.edge, run.dir, 60);
        // From the very start of the roadway, not 3u in: the summit edge
        // measures 80.7u and the run has to END on it. See kickSpeed below.
        const start = path.at(0);
        // 0.42, not 0.44: this road climbs the WEST flank, so a later phase
        // puts the whole vista in the ridge's own shadow with the street lamps
        // already coming up. 0.42 keeps the key near full and the sky blue.
        const st = this.base({ phase: 0.42, avoidX: start.x, avoidZ: start.z, avoidR: 24 });
        this.path = path;
        st.placeCar(start.x, start.z, Math.atan2(start.tx, start.tz), 0);
        // Which side of travel the Golden Gate — the one long-range landmark
        // this altitude can actually deliver — sits on: +1 = LEFT of travel,
        // which is the sign trackCam's `left`/`aimLeft` already use. Measured
        // off the resolved Fort Point mark; the summit mark only guards staging
        // now, because aiming at it aims into the hill (see the docstring).
        const mid = path.at(run.edge.len * 0.5);
        const beyond = this.fortPointAt ?? at;
        this.driftSide = (beyond.x - mid.x) * mid.tz - (beyond.z - mid.z) * mid.tx >= 0 ? 1 : -1;
        this.applyInput({ throttle: 1 });
        await settle();
        // 17, not 19, and from s0 rather than s3. A vista is not a speed beat,
        // but the arithmetic has to close: the edge is 80.7u, and 3 + 19x4.2
        // ran the car 2.1u PAST the end of the summit road onto the straight
        // overrun — with followPath's rabbit (pathS + 7 + 0.28xspeed, ~12u
        // ahead) off the roadway from t3.6s, so the last 0.6s of the trailer's
        // vista beat steered at open terrain on the one beat whose staging
        // notes say do not leave the road. 0 + 17x4.2 = 71.4u ends 9u short of
        // the end with the rabbit still on the tarmac until t4.05s.
        this.kickSpeed = 17;
      },
      run: (t, dt) => {
        if (this.runSubstitute(dt)) return;
        this.reveal();
        const dts = Math.min(dt, 50) / 1000;
        this.followPath(17, false, dts);
        // Two clocks. The crane tops out at 2.6s, the aim keeps opening for the
        // full 4.2s: the strait does not clear the ridge north of this road
        // until the eye passes ~123u absolute (measured — at 118 the horizon is
        // hillside, at 128 it is water with the bridge on it), and a single
        // 4.2s ramp only crosses that in the last second. Lift first, then look.
        const lift = smooth(clamp(t / 2600, 0, 1));
        const e = smooth(clamp(t / 4200, 0, 1));
        const bay = this.driftSide;
        // Eye on the bay side of the roadway, aim opening down the run: the
        // Waymo settles into the lower third while the frame fills with the
        // neighbourhood falling away, the water band and the Gate on it. Slow
        // lag so the crane drifts.
        //
        // The crane HAS to end high AND far back, and the two are locked. High,
        // for the ridge above. Far back, because 33u of lift over a 4.5u car
        // drops it clean out of the bottom of the frame at anything under ~50u
        // of standoff — at 56 it sits ~84% down, which is the lower third
        // rather than the edge. (The previous 22u/34u crane cleared neither:
        // it framed the hillside, the terrace parapet and a row of roofs.)
        this.trackCam(
          {
            back: 11 + 45 * lift,
            up: 3.2 + 29.8 * lift,
            left: bay * (3.5 + 5 * e),
            aheadOf: 9 + 121 * e,
            // Starts a touch to the far side — the car reads centred under the
            // tight opening chase — and crosses to the Gate's side as the frame
            // opens out.
            aimLeft: bay * (-3 + 23 * e),
            // Aim BELOW the car by the end, not level with it. The eye finishes
            // ~33u over the roadway; an aim held at car height tips the optical
            // axis up into empty sky and pushes the horizon band — the whole
            // point of the shot — off the top of the frame.
            aimUp: 1 - 6 * e,
            fov: 58 - 4 * e,
            lag: 2.2,
          },
          dts,
        );
      },
    };
  }

  /** 7 — fast cut 2: a cone barricade across a junction, hit at full boost
   *  — front-reverse camera, cones scatter at the lens.
   *
   *  1250, not 1500, and the run-in is 22u instead of 36. At 46 u/s a 36u
   *  approach is 0.78s — two of four frames were a 50px car driving toward a
   *  static cone line, the contact landed at 63% and the scatter was over by
   *  88%. The hit now lands at ~35% and the scatter owns the back half. */
  private sceneMontageSmash(): TrailerScene {
    return {
      id: "montage-smash",
      duration: 1250,
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
        st.placeCar(j.x - pT.x * 22, j.z - pT.z * 22, Math.atan2(pT.x, pT.z), 0);
        // 9u past the junction, not 15: closer roughly doubles the cones'
        // on-screen size, and with the eye dropped to +1.05 the horizon lifts
        // off the exact middle of frame it used to sit on.
        this.sceneAux.set(j.x + pT.x * 9 + pT.z * 3.0, j.z + pT.z * 9 - pT.x * 3.0);
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
        this.cam(camX, this.city.heightAt(camX, camZ) + 1.05, camZ, car.x, car.y + 0.9, car.z, 44);
      },
    };
  }

  /** 13 — RELEASE: the Waymo crossing the Golden Gate, shot from off the deck
   *  and out over the water so the bridge actually reads as a bridge.
   *
   *  The framing before this one sat ON the deck, 2.6u off centreline, because
   *  the cables hang at x ±7.2 and the portal beams start at deckY+7.8 —
   *  anything wider shot through red girders. But from inside that safe
   *  cylinder the only thing in frame is roadway. Moving 24u west fixed that
   *  and broke three other things, all measured off the delivered frames: the
   *  camera stared at a mark 24u downstream of a car doing 10 u/s, so the
   *  trailer's CLOSING SHOT had no subject in it for its first half; the car
   *  then crossed all the way out of the left of frame before the cut; and a
   *  tower leg 24u from the lens filled the right 40% of every frame as a flat,
   *  textureless red slab.
   *
   *  Standing off and upstream fixed the slab and won the best-composed frame
   *  in the reel — the full deck, the catenary, the lamps, the bay — but it
   *  left the other two criticals standing, and the frames say exactly why.
   *
   *  START PAST THE TOWER. With the car placed at the deck lip it spent the
   *  first half of the cut SOUTH of the south tower, and from a lens 26u west
   *  the tower's west leg sits between the two: probed at the 12% mark, the ray
   *  through the car's own screen position hit a mesh 13u short of it, which is
   *  why the closing shot still opened on a bridge with no Waymo in it. The
   *  occlusion is geometric, not a timing accident — a camera s units off the
   *  deck axis and dLeg past the tower has the leg crossing the car's sightline
   *  at exactly D = s·dLeg/(s−6.9), and for every value that keeps the tower in
   *  frame that D lands inside the run. Starting the car NORTH of the tower
   *  puts the tower behind it instead of in front, and nothing can cross.
   *
   *  CLOSER, NOT WIDER. 26u of lateral standoff caps the closest approach at
   *  26u no matter how long the run is, and the delivered car measured smaller
   *  than the version this replaced. 19u is the tightest offset that still
   *  clears the ±7.2 cable plane by more than a car's width; with the run cut
   *  to 28.5u the Waymo works 42u -> 26u, photographed at 116 -> 189px across
   *  and in frame at all four sample marks (it was 89 -> 162 with nothing at
   *  all in the first).
   *
   *  Locked off, and that matters most: this bridge only composes from abeam,
   *  so a camera that tracks the car necessarily swings AWAY from the
   *  composition as the car moves. Holding the frame and letting the Waymo
   *  drive through it keeps the good angle for the whole shot. The only motion
   *  is a slow rise, which parallaxes the near cables against the headlands. */
  private sceneHeroDrive(): TrailerScene {
    return {
      id: "hero-drive",
      duration: 3000,
      setup: async () => {
        const gate = this.gate;
        if (!gate) {
          await this.substituteBoostRun(0.45);
          return;
        }
        // 0.40, and this is the beat that has to carry the reel's last value
        // change. The cut climaxes on two night beats; a closer at 0.45 —
        // two-thirds of the way from the golden-hour stop toward sunset, sun
        // 5 degrees up, lamp factor already 0.44 — made the trailer's final
        // NINE seconds one unbroken dark block, and it measured that way: 46 /
        // 29 / 37 mean luma against a 49 reel mean, with the closer also the
        // emptiest frame in the cut (64.5% of it within ten levels of the modal
        // grey — flat dark bay and flat dark sky).
        //
        // 0.40 is a STOP, not a blend, and day-night.ts labels it: "Golden hour
        // is DAYLIGHT: sun still 12 degrees up, blue sky, full-strength key."
        // Photographed at the same camera across 0.45 / 0.42 / 0.40 / 0.37, it
        // reads 38.7 / 52.2 / 57.6 / 62.2 luma and 67.5 / 55.9 / 54.3 / 57.0%
        // empty — 0.40 is where the paint comes back to International Orange,
        // the bay takes a value and the headlands go green, and it is the last
        // stop before the light flattens toward noon again.
        //
        // What it costs is the parapet lamps (lamp factor is 0 at this stop),
        // which were the prettiest thing in the old frame. Worth it: the
        // trailer's job here is to end in the light.
        //
        // The geometry is unchanged by the move — the camera stands WEST of the
        // deck looking south-east, and the sun sits at azimuth 235 (WSW), so it
        // is behind the lens at every stop in this band and the span is
        // front-lit rather than raked. (0.48-0.52 stays off limits: the shadow
        // direction lerps through the sun-to-moon handoff there and the city
        // casts full-strength shadows from the wrong place.)
        const st = this.base({ phase: 0.4, avoidX: gate.x, avoidZ: gate.shoreZ, avoidR: 10 });
        // North across the deck (north = -Z, heading π). Start 46u out, which
        // is ~16u NORTH of the south tower — measured on this bake, the tower's
        // portal sits 30.4u past the ramp top. That is the whole occlusion fix:
        // from here the tower is behind the car for the entire run, so its legs
        // can never cross the sightline, and the Waymo drives out of the portal
        // toward the lens instead of arriving from behind it. The extra 6u past
        // the tower was lamp phasing — the parapet lamps are 51u apart and at
        // 40u the car sat inside a halo at the 12% mark. The lamps are dark at
        // 0.40 so that no longer binds, but the margin is free and the shot was
        // photographed at it.
        const startZ = gate.rampTopZ - 46;
        st.placeCar(gate.x, startZ, Math.PI, 0);
        this.sceneNode.set(gate.x, gate.deckY);
        // Camera 42u NORTH of the start looking back down the span, aim fixed
        // 25u out. The aim splits the run's angular sweep: the car enters ~13
        // degrees left of the optical axis and leaves ~17 degrees right of it,
        // against a horizontal half-angle of 37 at this lens, so it is inside
        // the frame at every sample mark and never near an edge.
        // x = eye z, y = aim z.
        this.sceneAux.set(startZ - 42, startZ - 17);
        this.applyInput({ throttle: 1 });
        await settle();
        this.kickSpeed = 9.5;
      },
      run: (t, dt) => {
        if (this.runSubstitute(dt)) return;
        this.reveal();
        const st = this.stage;
        if (!st) return;
        const car = st.car;
        const x = this.sceneNode.x;
        const deckY = this.sceneNode.y;
        this.driveAt(x, car.position.z - 300, 9.5);
        const e = smooth(clamp(t / 3000, 0, 1));
        // Eye above deck level aiming just over it: the tilt drops the roadway
        // onto the lower third, so the tower, the cables and the sky band get
        // the top two-thirds instead of an equal split with the bay.
        //
        // 19u off the deck axis, not 26. A locked-off camera can never bring
        // its subject nearer than its own lateral offset, and at 26 the Waymo
        // bottomed out at 30u — smaller on screen than the framing this beat
        // replaced, which was the regression. 19 still clears the ±7.2 cable
        // plane by 11.8u, so the near suspenders stay thin verticals rather
        // than bars across the lens.
        this.cam(x - 19, deckY + 5 + e * 2.4, this.sceneAux.x, x, deckY + 2.4, this.sceneAux.y, 46);
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
  // Before anything stages: the game's boot HUD (EARNED 0 / TIME 60 and the
  // loading-bar box) draws ABOVE the shell's black cut plate, so it was the
  // first thing in the recording until the first scene's base() hid it.
  hideChrome(false);
  const director = new Director(game);
  runTrailer({
    onGesture: () => director.unlockAudio(),
    scenes: director.scenes(),
  });
  // runTrailer has built its own black plate by now, so the boot plate that
  // covered world-load can go (see #trailer-plate in index.html).
  document.getElementById("trailer-plate")?.remove();
}
