// City footage reel. Real roads, physics, fleet and existing NPC dialogue.
// Gameplay cuts use the game's chase rig/HUD. Camera cuts use authored lenses.
// No hero cards, fake races, fabricated rewards or car-transform animation.
import * as THREE from "three";
import type { GameScene, TrailerStage } from "../scenes/game-scene";
import type { TrafficCar } from "../game/traffic-car";
import type { TrafficQuip } from "../fx/speech-bubbles";
import type { CarInput } from "../vehicle/car";
import { landmarkMarkers } from "../world/landmarks";
import { nearFreeway, scoutCorners, scoutDescent, scoutGoldenGate, scoutRunNear } from "./scout";
import type { CornerSpot, ScoutCtx } from "./scout";
import type { Point } from "./street-path";
import { StreetPath } from "./street-path";
import { runTrailer } from "./trailer-shell";
import type { TrailerScene } from "./trailer-shell";

const { clamp } = THREE.MathUtils;
const ease = (t: number): number => {
  const p = clamp(t, 0, 1);
  return p * p * (3 - 2 * p);
};
const angle = (v: number): number => Math.atan2(Math.sin(v), Math.cos(v));
const NEUTRAL: CarInput = { boost: false, brake: 0, steer: 0, throttle: 0 };
type View =
  | { kind: "gameplay" }
  | { kind: "roadside" }
  | { kind: "tracking"; back: number; up: number; side: number; fov: number };
interface CityShot {
  id: string;
  landmark: string;
  phase: number;
  seconds: number;
  view: Exclude<View, { kind: "roadside" }>;
  radius?: number;
  /** Start beyond an obstruction, measured along the selected road. */
  start?: number;
  /** Cruise limit for tighter streets, in world units per second. */
  speedCap?: number;
}
type DriftState =
  | { kind: "approach" }
  | { kind: "arming" }
  | { kind: "sliding"; since: number }
  | { kind: "exit"; since: number };
interface DriftShot {
  id: string;
  corner: number;
  view: "roadside" | "gameplay";
  seconds: number;
  approach: number;
  quip: TrafficQuip;
}

class Director {
  private readonly stage: TrailerStage;
  private readonly scout: ScoutCtx;
  private readonly clean = new URLSearchParams(window.location.search).has("clean");
  private elapsed = 0;
  private pending: (() => void) | null = null;
  private fault: Error | null = null;
  private preparing = false;
  private launchSpeed: number | null = null;
  private cameraYaw = 0;
  readonly clock = (): number => this.elapsed;

  constructor(game: GameScene) {
    const stage = game.beginTrailer();
    if (!stage) {
      throw new Error("Trailer started before the world was ready");
    }
    this.stage = stage;
    this.scout = {
      heightAt: (x, z) => stage.city.heightAt(x, z),
      network: stage.city.network,
      plan: stage.city.plan,
    };
    stage.setFrameHook((dt) => {
      this.elapsed += dt * 1000;
      const frame = this.pending;
      this.pending = null;
      try {
        frame?.();
      } catch (error) {
        this.fault = error instanceof Error ? error : new Error(String(error));
      }
    });
  }
  unlockAudio(): void {
    this.stage.unlockAudio();
  }

  private reset(phase: number, view: View): void {
    const st = this.stage;
    this.pending = null;
    this.fault = null;
    this.launchSpeed = null;
    st.setScriptedInput(NEUTRAL);
    st.setFreecam(view.kind !== "gameplay");
    st.setFakePlayers(null);
    st.setDayPhase(phase);
    st.setFxDim(0.6);
    st.cones.reset();
    st.restoreParked();
    st.fares.setTrailerHold(true);
    st.setCommentary(!this.clean);
    st.traffic.setHoldRecycle(true);
    st.state.reset();
    st.hud.resetScore(0);
    st.car.boostMeter = 100;
    const hud = view.kind === "gameplay" && !this.clean;
    for (const id of ["hud", "minimap", "area", "district", "dest-arrow", "netinfo", "touch"]) {
      const el = document.querySelector<HTMLElement>(`#${id}`);
      if (el) {
        el.style.display = hud && !["netinfo", "touch"].includes(id) ? "" : "none";
      }
    }
    st.setGameplayHud(hud);
  }

  private spawn(x: number, z: number, yaw: number, speed: number, clearTiles = 10): void {
    const st = this.stage;
    st.traffic.reset({ gx: st.city.gridX(x), gz: st.city.gridZ(z) }, clearTiles);
    st.placeCar(x, z, yaw, 0);
    this.cameraYaw = yaw;
    this.launchSpeed = speed;
  }

  private drive(target: Point, speed: number): void {
    if (this.preparing) {
      return;
    }
    const { car } = this.stage;
    const error = angle(
      Math.atan2(target.x - car.position.x, target.z - car.position.z) - car.heading,
    );
    const excess = car.forwardSpeed - speed;
    // Coast through small speed differences. The game's brake pedal engages
    // its drift setting, so constantly tapping it creates smoke on a straight.
    const brake = clamp((excess - 1.5) * 0.18, 0, 0.8);
    this.stage.setScriptedInput({
      boost: false,
      brake,
      steer: clamp(-error * 2.2, brake > 0.05 ? -0.2 : -1, brake > 0.05 ? 0.2 : 1),
      throttle: clamp(-excess * 0.45, 0, 1),
    });
  }

  private camera(eye: THREE.Vector3, target: THREE.Vector3, fov: number): void {
    const { camera } = this.stage;
    camera.position.copy(eye);
    camera.lookAt(target);
    if (camera.fov !== fov) {
      camera.fov = fov;
      camera.updateProjectionMatrix();
    }
    camera.updateMatrixWorld(true);
  }

  private track(view: Extract<View, { kind: "tracking" }>, t: number, dt: number): void {
    const { car } = this.stage;
    this.cameraYaw += angle(car.heading - this.cameraYaw) * (1 - Math.exp(-dt * 0.004));
    const fx = Math.sin(this.cameraYaw);
    const fz = Math.cos(this.cameraYaw);
    const p = car.position;
    const back = view.back - ease(t / 6000) * 1.5;
    const x = p.x - fx * back + fz * view.side;
    const z = p.z - fz * back - fx * view.side;
    this.camera(
      new THREE.Vector3(x, Math.max(p.y + view.up, this.stage.city.heightAt(x, z) + 1), z),
      new THREE.Vector3(p.x + fx * 5, p.y + 1.5, p.z + fz * 5),
      view.fov,
    );
  }

  /** Only setup teleports. Let suspension and the destination's streamed
   * buildings settle before revealing the first frame. Export skips this hold. */
  private shot(scene: TrailerScene): TrailerScene {
    const body = scene.run;
    return {
      ...scene,
      run: (t, dt) => {
        if (this.fault) {
          throw this.fault;
        }
        this.pending = () => {
          if (this.launchSpeed !== null) {
            this.stage.setSpeed(this.launchSpeed);
            this.launchSpeed = null;
          }
          body?.(t, dt);
        };
      },
      setup: async () => {
        this.pending = null;
        this.fault = null;
        await scene.setup();
        this.preparing = true;
        body?.(0, 0);
        this.preparing = false;
        this.stage.setScriptedInput(NEUTRAL);
        const deadline = performance.now() + 30_000;
        let stable = 0;
        while (stable < 8) {
          // oxlint-disable-next-line promise/avoid-new -- rAF has no promise form in the browser
          await new Promise<void>((resolve) => {
            requestAnimationFrame(() => resolve());
          });
          if (performance.now() > deadline) {
            throw new Error(`Scenery did not settle for ${scene.id}`);
          }
          stable = (this.stage.city.parcelStreamStats()?.pending ?? 0) === 0 ? stable + 1 : 0;
        }
      },
      teardown: () => {
        this.pending = null;
        this.stage.setScriptedInput(NEUTRAL);
        scene.teardown?.();
      },
    };
  }

  scenes(): TrailerScene[] {
    return [
      this.driftShot({
        approach: 36,
        corner: 0,
        id: "intersection-drift",
        quip: "spreadsheet",
        seconds: 3.2,
        view: "roadside",
      }),
      this.cityShot({
        id: "north-beach",
        landmark: "Coit Tower",
        phase: 0.3,
        radius: 130,
        seconds: 3.2,
        view: { kind: "gameplay" },
      }),
      this.cityShot({
        id: "ferry-building",
        landmark: "the Ferry Building",
        phase: 0.36,
        seconds: 3.4,
        view: { back: 15, fov: 52, kind: "tracking", side: 1, up: 7 },
      }),
      this.driftShot({
        approach: 52,
        corner: 1,
        id: "gameplay-drift",
        quip: "brakes",
        seconds: 3.8,
        view: "gameplay",
      }),
      this.hillShot(),
      this.cityShot({
        id: "palace-of-fine-arts",
        landmark: "the Palace of Fine Arts",
        phase: 0.38,
        seconds: 3,
        start: 48,
        view: { back: 11, fov: 54, kind: "tracking", side: 0, up: 3.4 },
      }),
      this.bridgeShot(),
      this.vistaShot(),
    ];
  }

  private cityShot(spec: CityShot): TrailerScene {
    let path: StreetPath | null = null;
    let speed = 12;

    const startPosition = new THREE.Vector3();
    return this.shot({
      duration: spec.seconds * 1000,
      id: spec.id,
      run: (t, dt) => {
        if (!path) {
          return;
        }
        const { car } = this.stage;
        const s = path.project(car.position);
        const next = path.at(s + 7 + car.speed * 0.3);
        let targetSpeed = speed;
        for (const other of this.stage.traffic.cars) {
          const dx = other.position.x - car.position.x;
          const dz = other.position.z - car.position.z;
          const ahead = dx * next.tx + dz * next.tz;
          const across = Math.abs(dx * next.tz - dz * next.tx);
          if (ahead > 0 && ahead < 25 && across < 2.7) {
            targetSpeed = Math.min(targetSpeed, Math.max(0, (ahead - 6) * 1.8));
          }
        }
        this.drive(next, targetSpeed);
        if (spec.view.kind === "tracking") {
          this.track(spec.view, t, dt);
        }
        if (
          t > spec.seconds * 1000 - 120 &&
          car.position.distanceTo(startPosition) < speed * spec.seconds * 0.35
        ) {
          throw new Error(`Drive stalled in ${spec.id}`);
        }
      },
      setup: () => {
        const st = this.stage;
        const mark = landmarkMarkers(st.city.network).find((m) => m.name === spec.landmark);
        if (!mark) {
          throw new Error(`Landmark missing: ${spec.landmark}`);
        }
        const run = scoutRunNear(this.scout, mark.x, mark.z, {
          minHalf: 4,
          minLen: 65,
          radius: spec.radius ?? 90,
        });
        if (!run) {
          throw new Error(`No driveable approach to ${spec.landmark}`);
        }
        this.reset(spec.phase, spec.view);
        path = new StreetPath(this.scout, run.edge, run.dir);
        const startDistance = spec.start ?? 8;
        const start = path.at(startDistance);
        speed = Math.min(spec.speedCap ?? 14, (run.edge.len - startDistance - 16) / spec.seconds);
        if (speed <= 0) {
          throw new Error(`No road remaining for ${spec.id}`);
        }
        this.spawn(start.x, start.z, Math.atan2(start.tx, start.tz), speed, 3);
        startPosition.copy(st.car.position);
        if (spec.view.kind === "gameplay") {
          st.snapCamera();
        }
      },
    });
  }

  /** Use the widest flat junctions. A slide needs asphalt on both legs,
   * including its exit; hiding a collision behind a cut is not a route. */
  private driftCorner(index: number): CornerSpot {
    const grade = (c: CornerSpot): number => {
      const h = this.scout.heightAt(c.x, c.z);
      return Math.max(
        Math.abs(this.scout.heightAt(c.x - c.inArm.tx * 30, c.z - c.inArm.tz * 30) - h),
        Math.abs(this.scout.heightAt(c.x + c.outArm.tx * 30, c.z + c.outArm.tz * 30) - h),
      );
    };
    const candidates = scoutCorners(this.scout, 12)
      .filter((c) => !nearFreeway(c.x, c.z) && grade(c) < 2.4)
      .toSorted(
        (a, b) =>
          Math.min(b.inArm.edge.half, b.outArm.edge.half) -
            Math.min(a.inArm.edge.half, a.outArm.edge.half) || grade(a) - grade(b),
      );
    const corner = candidates[index];
    if (!corner) {
      throw new Error(`No safe drift junction ${index}`);
    }
    return corner;
  }

  private driftShot(spec: DriftShot): TrailerScene {
    const corner = this.driftCorner(spec.corner);
    const incoming = corner.inArm;
    const outgoing = corner.outArm;
    const heading = Math.atan2(incoming.tx, incoming.tz);
    const exitHeading = Math.atan2(outgoing.tx, outgoing.tz);
    const exitPath = new StreetPath(this.scout, outgoing.edge, outgoing.dirToNode > 0 ? -1 : 1);
    const direction = angle(exitHeading - heading) < 0 ? 1 : -1;
    let state: DriftState = { kind: "approach" };
    let witness: TrafficCar | null = null;
    let commented = false;
    let driftSeen = false;
    let turboSeen = false;
    let wallHit = false;
    let driftingMs = 0;
    // Opposite the inside corner: both road legs remain visible without
    // sightlines cutting through the building beside the approach.
    const eyeX = corner.x - outgoing.tx * 6 + incoming.tx * 6;
    const eyeZ = corner.z - outgoing.tz * 6 + incoming.tz * 6;
    const placeWitness = (): void => {
      if (!witness) {
        return;
      }
      const arm = outgoing;
      const distance = Math.min(arm.edge.len - 8, 40);
      this.stage.traffic.placeCar(
        witness,
        arm.edge,
        arm.dirToNode > 0 ? arm.edge.len - distance : distance,
        arm.dirToNode,
      );
    };
    const observe = (t: number, dt: number): void => {
      const { car } = this.stage;
      const sliding = car.physicsVehicle?.isDrifting === true;
      driftSeen ||= sliding;
      turboSeen ||= car.miniBoostFired;
      wallHit ||= car.wallContact;
      if (sliding) {
        driftingMs += dt;
      }
      const remaining =
        (corner.x - car.position.x) * incoming.tx + (corner.z - car.position.z) * incoming.tz;
      if (state.kind === "approach" && remaining < 16) {
        state = { kind: "arming" };
      }
      if (state.kind === "arming" && sliding) {
        state = { kind: "sliding", since: t };
      }
      if (state.kind === "sliding") {
        if (!commented && t - state.since >= 300 && witness) {
          this.stage.sayTraffic(witness, spec.quip);
          commented = true;
        }
        if (car.driftTier >= 1 && Math.abs(angle(exitHeading - car.heading)) < 0.25) {
          state = { kind: "exit", since: t };
        }
      }
    };
    const steer = (): void => {
      if (state.kind === "approach") {
        this.drive(corner, 24);
      } else if (state.kind === "arming" || state.kind === "sliding") {
        // Full steer arms the slide. Neutral steering then widens its arc,
        // leaving enough time for a real tier-one charge before a 90° exit.
        this.stage.setScriptedInput({
          boost: false,
          brake: 1,
          steer: state.kind === "arming" ? direction * 0.85 : 0,
          throttle: 0,
        });
      } else {
        this.drive(exitPath.at(exitPath.project(this.stage.car.position) + 12), 30);
      }
    };
    const assertComplete = (t: number): void => {
      if (
        t > spec.seconds * 1000 - 120 &&
        (!driftSeen ||
          !turboSeen ||
          driftingMs < 750 ||
          wallHit ||
          state.kind !== "exit" ||
          t - state.since < 500)
      ) {
        throw new Error(
          `Incomplete drift ${spec.id}: ${JSON.stringify({ driftSeen, driftingMs, turboSeen, wallHit })}`,
        );
      }
    };
    return this.shot({
      duration: spec.seconds * 1000,
      id: spec.id,
      reveal: placeWitness,
      run: (t, dt) => {
        const { car } = this.stage;
        if (!this.preparing) {
          observe(t, dt);
          steer();
          assertComplete(t);
        }
        if (spec.view === "roadside") {
          this.camera(
            new THREE.Vector3(eyeX, this.scout.heightAt(eyeX, eyeZ) + 3.2, eyeZ),
            new THREE.Vector3(car.position.x, car.position.y + 1, car.position.z),
            58,
          );
        }
      },
      setup: () => {
        this.reset(0.34, { kind: spec.view });
        this.stage.setFxDim(0.4);
        this.spawn(
          corner.x - incoming.tx * spec.approach,
          corner.z - incoming.tz * spec.approach,
          heading,
          24,
        );
        state = { kind: "approach" };
        witness = this.stage.traffic.cars.find((car) => car.kind === "civilian") ?? null;
        placeWitness();
        commented = false;
        driftSeen = false;
        turboSeen = false;
        wallHit = false;
        driftingMs = 0;
        if (spec.view === "gameplay") {
          this.stage.snapCamera();
        }
      },
    });
  }

  private hillShot(): TrailerScene {
    const descent = scoutDescent(this.scout);
    let path: StreetPath | null = null;
    return this.shot({
      duration: 2600,
      id: "hill-descent",
      run: () => {
        if (!path) {
          return;
        }
        const { car } = this.stage;
        this.drive(path.at(path.project(car.position) + 18), 45);
      },
      setup: () => {
        if (!descent) {
          throw new Error("No safe downhill run");
        }
        this.reset(0.38, { kind: "gameplay" });
        path = new StreetPath(this.scout, descent.edge, descent.dir);
        const start = path.at(Math.max(6, descent.edge.len - 135));
        this.spawn(start.x, start.z, Math.atan2(start.tx, start.tz), 30);
        this.stage.snapCamera();
      },
    });
  }

  private bridgeShot(): TrailerScene {
    const gate = scoutGoldenGate(this.scout);
    let startZ = 0;
    return this.shot({
      duration: 4000,
      id: "golden-gate",
      run: (t) => {
        if (!gate) {
          return;
        }
        this.drive({ x: gate.x, z: startZ - 140 }, 6);
        this.camera(
          new THREE.Vector3(gate.x - 19, gate.deckY + 8 + ease(t / 6000) * 2, startZ - 42),
          new THREE.Vector3(gate.x, gate.deckY + 2.4, startZ - 17),
          46,
        );
      },
      setup: () => {
        if (!gate) {
          throw new Error("Golden Gate deck unavailable");
        }
        this.reset(0.4, { kind: "roadside" });
        startZ = gate.rampTopZ - 46;
        this.spawn(gate.x, startZ, Math.PI, 6);
      },
    });
  }

  /** The original Twin Peaks goodbye: rise above the ridge first, then
   * open the view toward the bay while the taxi continues along the road. */
  private vistaShot(): TrailerScene {
    let path: StreetPath | null = null;
    let bay = 1;
    let speed = 17;
    let wallHit = false;
    return this.shot({
      duration: 4200,
      id: "twin-peaks-vista",
      reveal: () => {
        const st = this.stage;
        // A manual-ready hold can let distant traffic reach the summit.
        st.traffic.reset(
          { gx: st.city.gridX(st.car.position.x), gz: st.city.gridZ(st.car.position.z) },
          32,
        );
      },
      run: (t, dt) => {
        if (!path) {
          return;
        }
        const { car } = this.stage;
        if (!this.preparing) {
          wallHit ||= car.wallContact;
          if (t > 4080 && wallHit) {
            throw new Error("Collision during Twin Peaks pullback");
          }
        }
        this.drive(path.at(path.project(car.position) + 12), speed);
        this.cameraYaw += angle(car.heading - this.cameraYaw) * Math.min(1, dt * 0.0022);
        const fx = Math.sin(this.cameraYaw);
        const fz = Math.cos(this.cameraYaw);
        const lift = ease(t / 2600);
        const open = ease(t / 4200);
        const back = 11 + 45 * lift;
        const left = bay * (3.5 + 5 * open);
        const ahead = 9 + 121 * open;
        const aimLeft = bay * (-3 + 23 * open);
        const p = car.position;
        const x = p.x - fx * back + fz * left;
        const z = p.z - fz * back - fx * left;
        this.camera(
          new THREE.Vector3(
            x,
            Math.max(p.y + 3.2 + 29.8 * lift, this.scout.heightAt(x, z) + 1.4),
            z,
          ),
          new THREE.Vector3(
            p.x + fx * ahead + fz * aimLeft,
            p.y + 1 - 6 * open,
            p.z + fz * ahead - fx * aimLeft,
          ),
          58 - 4 * open,
        );
      },
      setup: () => {
        const marks = landmarkMarkers(this.stage.city.network);
        const summit = marks.find((mark) => mark.name === "the Twin Peaks overlook");
        if (!summit) {
          throw new Error("Twin Peaks overlook unavailable");
        }
        const run = scoutRunNear(this.scout, summit.x, summit.z, {
          minHalf: 3,
          minLen: 45,
          radius: 70,
        });
        if (!run) {
          throw new Error("No driveable Twin Peaks summit road");
        }
        this.reset(0.43, { kind: "roadside" });
        path = new StreetPath(this.scout, run.edge, run.dir);
        // Begin on the straight summit climb, past the tight entrance bend
        // and its parked cars. Leave room to finish on this same road.
        const startDistance = 18;
        const start = path.at(startDistance);
        const mid = path.at(run.edge.len * 0.5);
        const beyond = marks.find((mark) => mark.name === "Fort Point") ?? summit;
        bay = (beyond.x - mid.x) * mid.tz - (beyond.z - mid.z) * mid.tx >= 0 ? 1 : -1;
        speed = Math.min(17, (run.edge.len - startDistance - 8) / 4.2);
        this.spawn(start.x, start.z, Math.atan2(start.tx, start.tz), speed, 32);
        wallHit = false;
      },
    });
  }
}

export const startTrailer = (game: GameScene, captureFrame: () => HTMLCanvasElement): void => {
  const director = new Director(game);
  runTrailer({
    captureFrame,
    clock: director.clock,
    onGesture: () => director.unlockAudio(),
    scenes: director.scenes(),
  });
  document.querySelector("#trailer-plate")?.remove();
};
