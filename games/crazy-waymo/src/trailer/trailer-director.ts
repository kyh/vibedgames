// City action reel. Real roads, physics, fleet and existing NPC dialogue.
// Gameplay cuts keep the game's chase rig/HUD; every other cut frames the car
// through an authored lens (see Lens) with depth of field on the subject.
// Title cards and music are added in the edit, not here.
import * as THREE from "three";
import type { PlayerMap } from "@vibedgames/multiplayer";
import type { GameScene, TrailerStage } from "../scenes/game-scene";
import type { TrafficCar } from "../game/traffic-car";
import type { TrafficQuip } from "../fx/speech-bubbles";
import { setGradeLens } from "../render/grade";
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
/** Staged rival footprint (remote cars draw at 1.12×): along-road, across-road. */
const PACK_LENGTH = 4.8;
const PACK_WIDTH = 2.9;
/** Body centre above the car's road-level origin; every lens aims here. */
const SUBJECT_LIFT = 0.8;

/**
 * Where the camera sits. Offsets are in the car's frame (forward along its
 * smoothed heading, `side` positive to the car's left) except `tripod`, which
 * is anchored once from the car's first pose and then only pans. `blur` is the
 * depth-of-field disc at infinity in 1080p pixels; focus follows the car.
 */
type Lens =
  | { kind: "game" }
  | { kind: "custom"; blur?: number }
  | {
      kind: "chase";
      /** Show the gameplay HUD: a player-eye chase, closer than the game rig. */
      hud?: boolean;
      back: number;
      up: number;
      side: number;
      fov: number;
      aimUp?: number;
      aimAhead?: number;
      blur?: number;
      lag?: number;
    }
  | {
      kind: "lead";
      ahead: number;
      up: number;
      side: number;
      fov: number;
      blur?: number;
      lag?: number;
    }
  | {
      kind: "parallel";
      side: number;
      up: number;
      lead: number;
      fov: number;
      blur?: number;
      lag?: number;
    }
  | {
      kind: "orbit";
      radius: number;
      up: number;
      from: number;
      rate: number;
      fov: number;
      blur?: number;
    }
  | { kind: "tripod"; ahead: number; side: number; up: number; fov: number; blur?: number }
  | { kind: "drone"; height: number; back: number; fov: number; blur?: number };
type View = Lens;
interface CityShot {
  id: string;
  landmark: string;
  phase: number;
  seconds: number;
  view: Lens;
  radius?: number;
  /** Start beyond an obstruction, measured along the selected road. */
  start?: number;
  /** Cruise limit for tighter streets, in world units per second. */
  speedCap?: number;
  /** Hold boost for this many ms from the start of the take. */
  boostMs?: number;
  minHalf?: number;
  /** Robotaxis from other companies riding alongside (visual remote cars). */
  pack?: readonly PackCar[];
  /** Player lane change (overtake): lateral offset eased in over `ms` from `at`. */
  lane?: { at: number; ms: number; to: number };
  /** Parked cars staged across the player's line, `ahead` units from the start. */
  plow?: { ahead: number; count: number; spacing: number };
}
interface PackCar {
  skin: string;
  /** Lateral offset from the player's line, positive = player's left. */
  lane: number;
  /** Along-road offset from the player, positive = ahead. */
  gap: number;
  /** Extra along-road speed relative to the player, u/s (overtakes). */
  surge?: number;
  /** Lane-change amplitude, units; the rival swings across over ~1.8s. */
  sway?: number;
}
type DriftState =
  | { kind: "approach" }
  | { kind: "arming" }
  | { kind: "sliding"; since: number }
  | { kind: "exit"; since: number };
interface DriftShot {
  id: string;
  corner: number;
  view:
    | Lens
    | { kind: "roadside"; up?: number; fov?: number; blur?: number }
    /** Low on the exit leg, `dist` past the corner: the slide comes at the lens. */
    | { kind: "exit"; dist: number; side: number; up: number; fov: number; blur?: number };
  seconds: number;
  approach: number;
  quip: TrafficQuip | null;
  phase?: number;
}

const tele = (fov: number, blur: number) => ({ blur, fov });

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
  private lensYaw = 0;
  private lensAnchor: THREE.Vector3 | null = null;
  private readonly lensEye = new THREE.Vector3();
  private readonly lensAim = new THREE.Vector3();
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
    this.lensAnchor = null;
    st.setScriptedInput(NEUTRAL);
    st.setFreecam(view.kind !== "game");
    st.setFakePlayers(null);
    setGradeLens(null);
    const override = Number(new URLSearchParams(window.location.search).get("phase"));
    st.setDayPhase(override > 0 ? override : phase);
    st.setFxDim(0.6);
    st.cones.reset();
    st.restoreParked();
    st.fares.setTrailerHold(true);
    st.setCommentary(!this.clean);
    st.traffic.setHoldRecycle(true);
    st.state.reset();
    st.hud.resetScore(0);
    st.car.boostMeter = 100;
    const hud =
      (view.kind === "game" || (view.kind === "chase" && view.hud === true)) && !this.clean;
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
    this.lensYaw = yaw;
    this.launchSpeed = speed;
  }

  private drive(target: Point, speed: number, boost = false): void {
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
    const brake = boost ? 0 : clamp((excess - 1.5) * 0.18, 0, 0.8);
    this.stage.setScriptedInput({
      boost,
      brake,
      steer: clamp(
        -error * 2.2,
        brake > 0.05 || boost ? -0.25 : -1,
        brake > 0.05 || boost ? 0.25 : 1,
      ),
      throttle: boost ? 1 : clamp(-excess * 0.45, 0, 1),
    });
  }

  private assertRoad(id: string): void {
    if (this.preparing) {
      return;
    }
    const { car, city } = this.stage;
    const road = city.network.nearest(car.position.x, car.position.z, 12);
    if (car.wallContact || !road || road.dist > road.edge.half - 0.5) {
      throw new Error(
        `Unsafe route in ${id} at ${car.position.x.toFixed(1)}, ${car.position.z.toFixed(1)}`,
      );
    }
  }

  private camera(eye: THREE.Vector3, target: THREE.Vector3, fov: number, blur = 0): void {
    const { camera } = this.stage;
    camera.position.copy(eye);
    camera.lookAt(target);
    if (camera.fov !== fov) {
      camera.fov = fov;
      camera.updateProjectionMatrix();
    }
    camera.updateMatrixWorld(true);
    const car = this.stage.car.position;
    const focus = Math.hypot(eye.x - car.x, eye.y - car.y - SUBJECT_LIFT, eye.z - car.z);
    setGradeLens(blur > 0 ? { blur, focus, streaks: 0 } : { blur: 0, focus, streaks: 0.35 });
  }

  /** Place the camera for an authored lens. dt in ms. */
  private frame(lens: Lens, t: number, dt: number): void {
    if (lens.kind === "game" || lens.kind === "custom") {
      return;
    }
    const { car } = this.stage;
    const p = car.position;
    const lag = "lag" in lens && lens.lag !== undefined ? lens.lag : 5;
    this.lensYaw += angle(car.heading - this.lensYaw) * (1 - Math.exp((-dt / 1000) * lag));
    const fx = Math.sin(this.lensYaw);
    const fz = Math.cos(this.lensYaw);
    // Left of travel, matching track()'s side convention.
    const lx = fz;
    const lz = -fx;
    const eye = this.lensEye;
    const aim = this.lensAim.set(p.x, p.y + SUBJECT_LIFT, p.z);
    switch (lens.kind) {
      case "chase": {
        eye.set(
          p.x - fx * lens.back + lx * lens.side,
          p.y + lens.up,
          p.z - fz * lens.back + lz * lens.side,
        );
        const ahead = lens.aimAhead ?? 3;
        aim.set(p.x + fx * ahead, p.y + (lens.aimUp ?? SUBJECT_LIFT), p.z + fz * ahead);
        break;
      }
      case "lead": {
        eye.set(
          p.x + fx * lens.ahead + lx * lens.side,
          p.y + lens.up,
          p.z + fz * lens.ahead + lz * lens.side,
        );
        aim.set(p.x - fx * 1.2, p.y + SUBJECT_LIFT, p.z - fz * 1.2);
        break;
      }
      case "parallel": {
        eye.set(
          p.x + fx * lens.lead + lx * lens.side,
          p.y + lens.up,
          p.z + fz * lens.lead + lz * lens.side,
        );
        aim.set(p.x + fx * lens.lead * 0.4, p.y + SUBJECT_LIFT, p.z + fz * lens.lead * 0.4);
        break;
      }
      case "orbit": {
        if (!this.lensAnchor) {
          this.lensAnchor = new THREE.Vector3(car.heading, 0, 0);
        }
        const a = this.lensAnchor.x + lens.from + lens.rate * (t / 1000);
        eye.set(p.x + Math.sin(a) * lens.radius, p.y + lens.up, p.z + Math.cos(a) * lens.radius);
        break;
      }
      case "tripod": {
        if (!this.lensAnchor) {
          const h = car.heading;
          const x = p.x + Math.sin(h) * lens.ahead + Math.cos(h) * lens.side;
          const z = p.z + Math.cos(h) * lens.ahead - Math.sin(h) * lens.side;
          this.lensAnchor = new THREE.Vector3(x, this.scout.heightAt(x, z) + lens.up, z);
        }
        eye.copy(this.lensAnchor);
        break;
      }
      case "drone": {
        eye.set(p.x - fx * lens.back, p.y + lens.height, p.z - fz * lens.back);
        break;
      }
      default: {
        break;
      }
    }
    eye.y = Math.max(eye.y, this.scout.heightAt(eye.x, eye.z) + 0.35);
    this.camera(eye, aim, lens.fov, lens.blur ?? 0);
  }

  private track(
    view: { back: number; up: number; side: number; fov: number },
    t: number,
    dt: number,
  ): void {
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
  private shot(scene: TrailerScene, lens?: Lens): TrailerScene {
    const view = lens ?? { kind: "custom" };
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
          this.frame(view, t, dt);
        };
      },
      setup: async () => {
        this.pending = null;
        this.fault = null;
        await scene.setup();
        if (view.kind === "game") {
          this.stage.snapCamera();
        }
        this.preparing = true;
        body?.(0, 0);
        this.frame(view, 0, 1000);
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
        this.stage.setFakePlayers(null);
        setGradeLens(null);
        scene.teardown?.();
      },
    };
  }

  /** Every take, by id. Keys are alphabetical (lint); the playback order for
   * the default cut lives in `SCENE_ORDER` below. `?scene=a,b` plays a subset. */
  private catalog() {
    return {
      "boost-sun": () =>
        this.cityShot({
          boostMs: 2000,
          id: "boost-sun",
          landmark: "the Ferry Building",
          minHalf: 6,
          phase: 0.43,
          radius: 300,
          seconds: 3,
          speedCap: 34,
          view: { kind: "parallel", lag: 6, lead: 2.5, side: 6.5, up: 0.9, ...tele(42, 4) },
        }),
      "bridge-lead": () =>
        this.bridgeSprintShot("bridge-lead", {
          ahead: 7.5,
          kind: "lead",
          lag: 5,
          side: 1.6,
          up: 1.2,
          ...tele(34, 4),
        }),
      "bridge-sprint": () => this.bridgeSprintShot("bridge-sprint", { kind: "custom" }),
      "downtown-low": () =>
        this.cityShot({
          id: "downtown-low",
          landmark: "the Transamerica Pyramid",
          minHalf: 3,
          phase: 0.37,
          radius: 260,
          seconds: 3.5,
          speedCap: 22,
          view: {
            aimAhead: 18,
            aimUp: 6,
            back: 5.5,
            kind: "chase",
            lag: 4,
            side: 1.2,
            up: 0.7,
            ...tele(58, 2),
          },
        }),
      "dragon-gate": () =>
        this.cityShot({
          id: "dragon-gate",
          landmark: "the Dragon Gate",
          phase: 0.38,
          radius: 120,
          seconds: 3.5,
          speedCap: 16,
          view: { ahead: 12, kind: "lead", lag: 3, side: 1.2, up: 1.4, ...tele(40, 5) },
        }),
      "drift-at-lens": () =>
        this.driftShot({
          approach: 34,
          corner: 1,
          id: "drift-at-lens",
          phase: 0.37,
          quip: null,
          seconds: 3.8,
          view: { blur: 4, dist: 16, fov: 44, kind: "exit", side: 1.5, up: 0.7 },
        }),
      "drift-at-lens-2": () =>
        this.driftShot({
          approach: 34,
          corner: 2,
          id: "drift-at-lens-2",
          phase: 0.38,
          quip: null,
          seconds: 3.6,
          view: { blur: 4, dist: 18, fov: 40, kind: "exit", side: -1.5, up: 0.8 },
        }),
      "drift-drone": () =>
        this.driftShot({
          approach: 40,
          corner: 1,
          id: "drift-drone",
          phase: 0.37,
          quip: null,
          seconds: 3.8,
          view: { back: 4, fov: 42, height: 26, kind: "drone" },
        }),
      "drift-game": () =>
        this.driftShot({
          approach: 40,
          corner: 1,
          id: "drift-game",
          phase: 0.37,
          quip: null,
          seconds: 3.8,
          view: {
            aimAhead: 7,
            aimUp: 1.1,
            back: 6.8,
            fov: 56,
            hud: true,
            kind: "chase",
            lag: 6,
            side: 0,
            up: 2.3,
          },
        }),
      "drift-golden": () =>
        this.driftShot({
          approach: 34,
          corner: 3,
          id: "drift-golden",
          phase: 0.42,
          quip: null,
          seconds: 3.6,
          view: { from: -2.2, kind: "orbit", radius: 8, rate: 0.5, up: 1.3, ...tele(42, 6) },
        }),
      "drift-low": () =>
        this.driftShot({
          approach: 36,
          corner: 2,
          id: "drift-low",
          phase: 0.38,
          quip: null,
          seconds: 3.6,
          view: { blur: 5, fov: 34, kind: "roadside", up: 0.6 },
        }),
      "drift-orbit": () =>
        this.driftShot({
          approach: 34,
          corner: 0,
          id: "drift-orbit",
          phase: 0.37,
          quip: null,
          seconds: 3.6,
          view: { from: 1.9, kind: "orbit", radius: 7.5, rate: -0.55, up: 1.6, ...tele(40, 6) },
        }),
      "embarcadero-side": () =>
        this.cityShot({
          id: "embarcadero-side",
          landmark: "the Ferry Building",
          phase: 0.38,
          radius: 260,
          seconds: 4,
          speedCap: 24,
          view: { kind: "parallel", lag: 3, lead: 1.5, side: -7.5, up: 1.3, ...tele(32, 6) },
        }),
      "fleet-comment": () =>
        this.driftShot({
          approach: 36,
          corner: 0,
          id: "fleet-comment",
          quip: "spreadsheet",
          seconds: 4,
          view: { kind: "roadside" },
        }),
      "golden-gate": () => this.bridgeShot(),
      "hill-chase": () =>
        this.hillShot(
          "hill-chase",
          { back: 5.2, kind: "chase", lag: 7, side: 0.6, up: 1, ...tele(52, 3) },
          0.38,
        ),
      "hill-lead": () =>
        this.hillShot(
          "hill-lead",
          { ahead: 8, kind: "lead", lag: 4, side: -1.2, up: 1, ...tele(30, 7) },
          0.3,
        ),
      "jump-front": () =>
        this.jumpShot("jump-front", {
          ahead: 9,
          kind: "lead",
          lag: 8,
          side: 1.4,
          up: 0.9,
          ...tele(46, 3),
        }),
      "jump-under": () =>
        this.jumpShot("jump-under", {
          ahead: 30,
          kind: "tripod",
          side: 2.6,
          up: 0.25,
          ...tele(48, 3),
        }),
      "lidar-close": () =>
        this.cityShot({
          id: "lidar-close",
          landmark: "the Ferry Building",
          phase: 0.37,
          radius: 220,
          seconds: 4,
          speedCap: 16,
          view: {
            aimAhead: 2,
            aimUp: 1.5,
            back: 3.6,
            kind: "chase",
            lag: 3,
            side: 1.7,
            up: 2.05,
            ...tele(38, 9),
          },
        }),
      "night-chase": () =>
        this.cityShot({
          id: "night-chase",
          landmark: "the Ferry Building",
          phase: 0.585,
          radius: 220,
          seconds: 4,
          speedCap: 26,
          view: { back: 4.4, kind: "chase", lag: 5, side: 1, up: 1.05, ...tele(46, 6) },
        }),
      "night-drift": () =>
        this.driftShot({
          approach: 34,
          corner: 0,
          id: "night-drift",
          phase: 0.68,
          quip: null,
          seconds: 3.6,
          view: { from: 1.2, kind: "orbit", radius: 7.5, rate: -0.5, up: 1.4, ...tele(40, 5) },
        }),
      "night-game": () =>
        this.cityShot({
          id: "night-game",
          landmark: "the Ferry Building",
          phase: 0.68,
          radius: 260,
          seconds: 4,
          speedCap: 28,
          view: {
            aimAhead: 7,
            aimUp: 1.1,
            back: 6.8,
            fov: 56,
            hud: true,
            kind: "chase",
            lag: 6,
            side: 0,
            up: 2.3,
          },
        }),
      "night-skyline": () =>
        this.cityShot({
          id: "night-skyline",
          landmark: "the Ferry Building",
          phase: 0.68,
          radius: 260,
          seconds: 4,
          speedCap: 22,
          view: { kind: "parallel", lag: 3, lead: 1.5, side: 7.5, up: 1.3, ...tele(34, 5) },
        }),
      "night-whip": () =>
        this.cityShot({
          id: "night-whip",
          landmark: "the Ferry Building",
          minHalf: 6,
          phase: 0.68,
          radius: 260,
          seconds: 3,
          speedCap: 32,
          view: { ahead: 32, kind: "tripod", side: 3.2, up: 0.6, ...tele(40, 6) },
        }),
      "pack-drone": () =>
        this.cityShot({
          id: "pack-drone",
          landmark: "the Ferry Building",
          minHalf: 7,
          pack: [
            { gap: 6, lane: 3.4, skin: "cybercab", surge: 0.6 },
            { gap: -8, lane: -0.3, skin: "zoox" },
            { gap: -3, lane: -3.2, skin: "lyft" },
          ],
          phase: 0.3,
          radius: 320,
          seconds: 4.5,
          speedCap: 26,
          view: { back: 10, fov: 44, height: 20, kind: "drone" },
        }),
      "pack-lead": () =>
        this.cityShot({
          id: "pack-lead",
          landmark: "the Ferry Building",
          minHalf: 7,
          pack: [
            { gap: -7, lane: 3.4, skin: "cybercab" },
            { gap: -13, lane: -0.3, skin: "zoox" },
            { gap: -4, lane: -3.2, skin: "cruise", surge: 1.2 },
          ],
          phase: 0.3,
          radius: 320,
          seconds: 4.5,
          speedCap: 26,
          view: { ahead: 13, kind: "lead", lag: 3, side: 0.5, up: 1.5, ...tele(30, 5) },
        }),
      "pack-side": () =>
        this.cityShot({
          id: "pack-side",
          landmark: "the Ferry Building",
          minHalf: 7,
          pack: [
            { gap: 3, lane: 3.3, skin: "zoox", surge: 0.8 },
            { gap: -6, lane: 3.3, skin: "cybercab" },
          ],
          phase: 0.3,
          radius: 320,
          seconds: 4.5,
          speedCap: 26,
          view: { kind: "parallel", lag: 3, lead: 0, side: -6.5, up: 1.1, ...tele(36, 5) },
        }),
      "pack-weave": () =>
        this.cityShot({
          id: "pack-weave",
          landmark: "the Ferry Building",
          minHalf: 7,
          pack: [
            { gap: -9, lane: 3.2, skin: "cybercab", surge: 5, sway: 2.2 },
            { gap: -4, lane: -3.2, skin: "zoox", surge: 3 },
            { gap: -15, lane: 0, skin: "cruise", surge: 6, sway: 1.8 },
          ],
          phase: 0.3,
          radius: 320,
          seconds: 4.5,
          speedCap: 26,
          view: { back: 7, kind: "chase", lag: 4, side: 1.5, up: 1.5, ...tele(40, 3) },
        }),
      "painted-ladies": () =>
        this.cityShot({
          id: "painted-ladies",
          landmark: "the Painted Ladies",
          phase: 0.38,
          radius: 120,
          seconds: 3.5,
          speedCap: 18,
          view: { kind: "parallel", lag: 3, lead: 3, side: 8, up: 1.6, ...tele(36, 5) },
        }),
      "passenger-run": () => this.passengerShot("passenger-run", { kind: "game" }),
      "passenger-tripod": () =>
        this.passengerShot(
          "passenger-tripod",
          { ahead: 34, kind: "tripod", side: 4.5, up: 1.2, ...tele(36, 6) },
          0.3,
        ),
      "plow-chase": () =>
        this.cityShot({
          boostMs: 3000,
          id: "plow-chase",
          landmark: "the Ferry Building",
          minHalf: 6,
          phase: 0.3,
          plow: { ahead: 44, count: 4, spacing: 4.4 },
          radius: 260,
          seconds: 3,
          speedCap: 30,
          view: { kind: "parallel", lag: 5, lead: 3, side: 7, up: 1.4, ...tele(40, 4) },
        }),
      "plow-close": () =>
        this.cityShot({
          boostMs: 3000,
          id: "plow-close",
          landmark: "the Ferry Building",
          minHalf: 6,
          phase: 0.3,
          plow: { ahead: 46, count: 4, spacing: 4.4 },
          radius: 260,
          seconds: 3,
          speedCap: 30,
          view: { ahead: 53, kind: "tripod", side: 7.5, up: 0.7, ...tele(50, 3) },
        }),
      "plow-drone": () =>
        this.cityShot({
          boostMs: 3000,
          id: "plow-drone",
          landmark: "the Ferry Building",
          minHalf: 6,
          phase: 0.3,
          plow: { ahead: 44, count: 4, spacing: 4.4 },
          radius: 260,
          seconds: 3,
          speedCap: 30,
          view: { back: 9, fov: 48, height: 14, kind: "drone" },
        }),
      "plow-game": () =>
        this.cityShot({
          boostMs: 3000,
          id: "plow-game",
          landmark: "the Ferry Building",
          minHalf: 6,
          phase: 0.3,
          plow: { ahead: 44, count: 4, spacing: 4.4 },
          radius: 260,
          seconds: 3,
          speedCap: 30,
          view: {
            aimAhead: 7,
            aimUp: 1.1,
            back: 6.8,
            fov: 56,
            hud: true,
            kind: "chase",
            lag: 6,
            side: 0,
            up: 2.3,
          },
        }),
      "plow-tripod": () =>
        this.cityShot({
          boostMs: 3000,
          id: "plow-tripod",
          landmark: "the Ferry Building",
          minHalf: 6,
          phase: 0.3,
          plow: { ahead: 48, count: 4, spacing: 4.4 },
          radius: 260,
          seconds: 3,
          speedCap: 30,
          view: { ahead: 64, kind: "tripod", side: 4.5, up: 0.9, ...tele(40, 4) },
        }),
      "race-game": () =>
        this.cityShot({
          id: "race-game",
          landmark: "the Ferry Building",
          minHalf: 7,
          pack: [
            { gap: 11, lane: 0, skin: "cruise", surge: -1.4 },
            { gap: 1, lane: -3.8, skin: "zoox", surge: 0.6, sway: 0.3 },
            { gap: -7, lane: -3.8, skin: "uber", surge: 1.4, sway: 0.3 },
            { gap: -2, lane: 3.8, skin: "cybercab", surge: 0.9, sway: 0.3 },
            { gap: 7, lane: 3.8, skin: "lyft", surge: -1, sway: 0.3 },
          ],
          phase: 0.3,
          radius: 320,
          seconds: 4.5,
          speedCap: 24,
          view: {
            aimAhead: 7,
            aimUp: 1.1,
            back: 6.8,
            fov: 56,
            hud: true,
            kind: "chase",
            lag: 6,
            side: 0,
            up: 2.3,
          },
        }),
      "race-lead": () =>
        this.cityShot({
          id: "race-lead",
          landmark: "the Ferry Building",
          minHalf: 7,
          pack: [
            { gap: 16, lane: 0, skin: "cruise", surge: 0 },
            { gap: 1, lane: -3.8, skin: "zoox", surge: 0.6, sway: 0.3 },
            { gap: -7, lane: -3.8, skin: "uber", surge: 1.4, sway: 0.3 },
            { gap: -2, lane: 3.8, skin: "cybercab", surge: 0.9, sway: 0.3 },
            { gap: 7, lane: 3.8, skin: "lyft", surge: -1, sway: 0.3 },
          ],
          phase: 0.3,
          radius: 320,
          seconds: 4.5,
          speedCap: 24,
          view: { ahead: 7.5, kind: "lead", lag: 3, side: -1.2, up: 1.9, ...tele(44, 3) },
        }),
      "twin-peaks-vista": () => this.vistaShot(),
      "whip-by": () =>
        this.cityShot({
          id: "whip-by",
          landmark: "the Ferry Building",
          minHalf: 6,
          phase: 0.3,
          radius: 260,
          seconds: 3,
          speedCap: 32,
          view: { ahead: 40, kind: "tripod", side: 3.2, up: 0.55, ...tele(40, 5) },
        }),
    };
  }

  /** The default cut, in playback order. `catalog()`'s own key order is
   * alphabetical (lint), so this is the only source of narrative sequence:
   * intro (morning, close/slow) → drop one (drifts, air, speed) → fares →
   * friends (other companies' robotaxis) → night → finale. */
  private static readonly SCENE_ORDER = [
    "lidar-close",
    "hill-lead",
    "embarcadero-side",
    "whip-by",
    "drift-orbit",
    "drift-drone",
    "drift-low",
    "jump-under",
    "hill-chase",
    "boost-sun",
    "painted-ladies",
    "downtown-low",
    "dragon-gate",
    "plow-tripod",
    "plow-chase",
    "plow-close",
    "drift-at-lens",
    "drift-at-lens-2",
    "jump-front",
    "plow-drone",
    "pack-weave",
    "passenger-run",
    "passenger-tripod",
    "fleet-comment",
    "pack-lead",
    "pack-drone",
    "pack-side",
    "night-chase",
    "night-whip",
    "bridge-sprint",
    "bridge-lead",
    "golden-gate",
    "drift-golden",
    "twin-peaks-vista",
  ] as const;

  scenes(): TrailerScene[] {
    const catalog = this.catalog();
    const isSceneId = (id: string): id is keyof typeof catalog => id in catalog;
    const pick = new URLSearchParams(window.location.search).get("scene");
    const ids = pick ? pick.split(",") : Director.SCENE_ORDER;
    return ids.map((id) => {
      if (!isSceneId(id)) {
        throw new Error(`Unknown trailer scene ${id}`);
      }
      return catalog[id]();
    });
  }

  private passengerShot(id: string, view: Lens, phase = 0.34): TrailerScene {
    let path: StreetPath | null = null;
    let boardedAt: number | null = null;
    return this.shot(
      {
        duration: 10_000,
        id,
        run: (t) => {
          if (!path) {
            return;
          }
          const st = this.stage;
          this.assertRoad("passenger-run");
          if (st.fares.carryingInfo() && boardedAt === null) {
            boardedAt = t;
          }
          const s = path.project(st.car.position);
          const next = path.at(s + 8);
          const objective = st.fares.objective();
          let speed = boardedAt === null ? 10 : 24;
          if (boardedAt !== null && t - boardedAt < 700) {
            speed = 5;
          }
          if (objective) {
            const along =
              (objective.pos.x - st.car.position.x) * next.tx +
              (objective.pos.z - st.car.position.z) * next.tz;
            if (along < 18 && along > -5) {
              const across =
                (objective.pos.x - next.x) * next.tz - (objective.pos.z - next.z) * next.tx;
              const shift = across - Math.sign(across) * 2.5;
              next.x += next.tz * shift;
              next.z -= next.tx * shift;
              speed = Math.min(speed, 6);
            }
          }
          if (st.state.fares > 0) {
            speed = 22;
          }
          this.drive(next, speed);
          if (t > 9850 && (boardedAt === null || st.state.fares !== 1)) {
            throw new Error("Passenger take did not complete a real fare");
          }
        },
        setup: () => {
          const st = this.stage;
          this.reset(phase, view);
          const mark = landmarkMarkers(st.city.network).find(
            (m) => m.name === "the Ferry Building",
          );
          if (!mark) {
            throw new Error("Missing Ferry Building");
          }
          const run = scoutRunNear(this.scout, mark.x, mark.z, {
            minHalf: 4,
            minLen: 130,
            radius: 220,
          });
          if (!run) {
            throw new Error("No passenger street");
          }
          path = new StreetPath(this.scout, run.edge, run.dir);
          const cellAt = (s: number) => {
            const p = path?.at(s);
            if (!p) {
              throw new Error("Passenger path unavailable");
            }
            const [cell] = st.city.roadCells.toSorted(
              (a, b) =>
                Math.hypot(st.city.worldX(a.gx) - p.x, st.city.worldZ(a.gz) - p.z) -
                Math.hypot(st.city.worldX(b.gx) - p.x, st.city.worldZ(b.gz) - p.z),
            );
            if (!cell) {
              throw new Error("No passenger curb");
            }
            return cell;
          };
          const start = path.at(12);
          this.spawn(start.x, start.z, Math.atan2(start.tx, start.tz), 10);
          st.fares.stageTrailerFare(cellAt(32), cellAt(105), "short");
          boardedAt = null;
        },
      },
      view,
    );
  }

  private jumpShot(id: string, view: Lens): TrailerScene {
    let longestAir = 0;
    let landed = false;
    return this.shot(
      {
        duration: 1450,
        id,
        run: (t) => {
          const { car } = this.stage;
          this.assertRoad(id);
          longestAir = Math.max(longestAir, car.airTime);
          if (car.justLanded && longestAir > 0.45) {
            landed = true;
          }
          const error = angle(-Math.PI / 2 - car.heading);
          if (!this.preparing) {
            this.stage.setScriptedInput({
              boost: t < 450,
              brake: 0,
              steer: clamp(-error * 2.2, -0.3, 0.3),
              throttle: 1,
            });
          }
          if (t > 1400 && (!landed || longestAir < 0.45)) {
            throw new Error(`Nob Hill take missing hangtime/landing: ${longestAir.toFixed(2)}s`);
          }
        },
        setup: () => {
          this.reset(0.34, view);
          // Measured westbound Nob Hill brow. Its short curvature launches the
          // normal suspension; the broad hill scout averages this crest away.
          this.spawn(448.25, -838.5, -Math.PI / 2, 38);
          longestAir = 0;
          landed = false;
        },
      },
      view,
    );
  }

  private cityShot(spec: CityShot): TrailerScene {
    let path: StreetPath | null = null;
    let speed = 12;
    let packFrom = 0;
    const startPosition = new THREE.Vector3();
    const publishPack = (t: number): void => {
      if (!path || !spec.pack) {
        return;
      }
      const { car } = this.stage;
      const along = path.project(car.position);
      const here = path.at(along);
      const playerLane = (car.position.x - here.x) * here.tz - (car.position.z - here.z) * here.tx;
      // Rivals are visual only, so separation is enforced here: a rival that
      // would overlap the player or an earlier rival is pushed to the next lane.
      const placed: { s: number; lane: number }[] = [{ lane: playerLane, s: 0 }];
      const players: PlayerMap = {};
      for (const [i, member] of spec.pack.entries()) {
        const s = member.gap + ((member.surge ?? 0) * (t - packFrom)) / 1000;
        let lane = member.lane + (member.sway ?? 0) * Math.sin((t - packFrom) / 520 + i * 1.7);
        for (const other of placed) {
          if (Math.abs(s - other.s) < PACK_LENGTH && Math.abs(lane - other.lane) < PACK_WIDTH) {
            lane = other.lane + Math.sign(member.lane - other.lane || 1) * PACK_WIDTH;
          }
        }
        placed.push({ lane, s });
        const p = path.at(along + s);
        const x = p.x + p.tz * lane;
        const z = p.z - p.tx * lane;
        const id = `trailer-${i}`;
        players[id] = {
          id,
          state: {
            h: Math.atan2(p.tx, p.tz),
            msg: "",
            msgAt: 0,
            skin: member.skin,
            x,
            y: this.scout.heightAt(x, z),
            z,
          },
        };
      }
      this.stage.setFakePlayers(players);
    };
    return this.shot(
      {
        duration: spec.seconds * 1000,
        id: spec.id,
        run: (t) => {
          if (!path) {
            return;
          }
          const { car } = this.stage;
          if (!spec.plow) {
            this.assertRoad(spec.id);
          }
          const s = path.project(car.position);
          const next = path.at(s + 7 + car.speed * 0.3);
          if (spec.lane) {
            const shift = spec.lane.to * ease((t - spec.lane.at) / spec.lane.ms);
            next.x += next.tz * shift;
            next.z -= next.tx * shift;
          }
          const boost = spec.boostMs !== undefined && t < spec.boostMs;
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
          this.drive(next, targetSpeed, boost && targetSpeed === speed);
          publishPack(t);
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
          const cruise = spec.boostMs === undefined ? (spec.speedCap ?? 0) : 44;
          const run = scoutRunNear(this.scout, mark.x, mark.z, {
            minHalf: spec.minHalf ?? 4,
            minLen: Math.max(65, cruise * spec.seconds + (spec.start ?? 8) + 16),
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
          this.spawn(
            start.x,
            start.z,
            Math.atan2(start.tx, start.tz),
            speed,
            spec.pack || spec.plow ? 12 : 3,
          );
          if (spec.plow) {
            // A wall across the road: the car cannot line up a gap.
            const row = path.at(startDistance + spec.plow.ahead);
            const half = ((spec.plow.count - 1) * spec.plow.spacing) / 2;
            st.stageParkedRow(
              row.x + row.tz * half,
              row.z - row.tx * half,
              -row.tz,
              row.tx,
              spec.plow.count,
              spec.plow.spacing,
            );
          }
          startPosition.copy(st.car.position);
          packFrom = 0;
        },
      },
      spec.view,
    );
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
        if (!commented && t - state.since >= 300 && witness && spec.quip) {
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
    const lens: Lens =
      spec.view.kind === "roadside" || spec.view.kind === "exit" ? { kind: "custom" } : spec.view;
    return this.shot(
      {
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
          if (spec.view.kind === "exit") {
            const v = spec.view;
            const ox = outgoing.tx * v.dist + outgoing.tz * v.side;
            const oz = outgoing.tz * v.dist - outgoing.tx * v.side;
            const ex = corner.x + ox;
            const ez = corner.z + oz;
            this.camera(
              new THREE.Vector3(ex, this.scout.heightAt(ex, ez) + v.up, ez),
              new THREE.Vector3(car.position.x, car.position.y + SUBJECT_LIFT, car.position.z),
              v.fov,
              v.blur ?? 0,
            );
          }
          if (spec.view.kind === "roadside") {
            this.camera(
              new THREE.Vector3(
                eyeX,
                this.scout.heightAt(eyeX, eyeZ) + (spec.view.up ?? 3.2),
                eyeZ,
              ),
              new THREE.Vector3(car.position.x, car.position.y + 1, car.position.z),
              spec.view.fov ?? 58,
              spec.view.blur ?? 0,
            );
          }
        },
        setup: () => {
          this.reset(spec.phase ?? 0.34, lens);
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
        },
      },
      lens,
    );
  }

  private hillShot(id: string, view: Lens, phase: number): TrailerScene {
    const descent = scoutDescent(this.scout);
    let path: StreetPath | null = null;
    return this.shot(
      {
        duration: 2600,
        id,
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
          this.reset(phase, view);
          path = new StreetPath(this.scout, descent.edge, descent.dir);
          const start = path.at(Math.max(6, descent.edge.len - 135));
          this.spawn(start.x, start.z, Math.atan2(start.tx, start.tz), 30);
        },
      },
      view,
    );
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
        this.reset(0.4, { kind: "custom" });
        startZ = gate.rampTopZ - 46;
        this.spawn(gate.x, startZ, Math.PI, 6);
      },
    });
  }

  private bridgeSprintShot(id: string, lens: Lens): TrailerScene {
    const gate = scoutGoldenGate(this.scout);
    const startZ = gate ? gate.rampTopZ - 4 : 0;
    const deck = gate
      ? this.stage.city
          .getDecks()
          .find(
            (d) =>
              d.y2 === undefined &&
              Math.abs(d.y - gate.deckY) < 0.1 &&
              gate.x > d.minX + 1.4 &&
              gate.x < d.maxX - 1.4 &&
              startZ < d.maxZ &&
              startZ - 176 >= d.minZ + 12,
          )
      : undefined;
    const tracking = { back: 10, fov: 68, side: 0.7, up: 3.2 };
    return this.shot(
      {
        duration: 4000,
        id,
        run: (t, dt) => {
          if (!gate || !deck) {
            return;
          }
          const { car } = this.stage;
          if (!this.preparing) {
            const p = car.position;
            if (
              car.wallContact ||
              car.airborne ||
              p.x < deck.minX + 1.4 ||
              p.x > deck.maxX - 1.4 ||
              p.z < deck.minZ + 12 ||
              p.z > deck.maxZ ||
              Math.abs(p.y - deck.y) > 2
            ) {
              throw new Error("Unsafe Golden Gate sprint");
            }
            const error = angle(Math.atan2(gate.x - p.x, -24) - car.heading);
            this.stage.setScriptedInput({
              boost: t < 1400,
              brake: 0,
              steer: clamp(-error * 2.2, -0.3, 0.3),
              throttle: 1,
            });
            if (t > 3900 && (startZ - p.z < 120 || car.speed < 28)) {
              throw new Error("Golden Gate sprint did not maintain speed");
            }
          }
          if (lens.kind === "custom") {
            this.track(tracking, t, dt);
          }
        },
        setup: () => {
          if (!gate || !deck) {
            throw new Error("No clear Golden Gate deck for a full-speed sprint");
          }
          this.reset(0.38, lens);
          this.spawn(gate.x, startZ, Math.PI, 30);
        },
      },
      lens,
    );
  }

  /** Rise above Twin Peaks, then open toward the downtown skyline. */
  private vistaShot(): TrailerScene {
    let path: StreetPath | null = null;
    let bay = 1;
    let speed = 17;
    let wallHit = false;
    const skylineEye = new THREE.Vector3();
    const skylineTarget = new THREE.Vector3();
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
        const eye = new THREE.Vector3(
          x,
          Math.max(p.y + 3.2 + 29.8 * lift, this.scout.heightAt(x, z) + 1.4),
          z,
        ).lerp(skylineEye, open);
        const streetDirection = new THREE.Vector3(
          p.x + fx * ahead + fz * aimLeft,
          p.y + 1 - 6 * open,
          p.z + fz * ahead - fx * aimLeft,
        )
          .sub(eye)
          .normalize();
        const skylineDirection = skylineTarget.clone().sub(eye).normalize();
        const aim = eye
          .clone()
          .add(streetDirection.lerp(skylineDirection, open).multiplyScalar(150));
        this.camera(eye, aim, 58 - 10 * open);
      },
      setup: () => {
        const marks = landmarkMarkers(this.stage.city.network);
        const summit = marks.find((mark) => mark.name === "the Twin Peaks overlook");
        if (!summit) {
          throw new Error("Twin Peaks overlook unavailable");
        }
        const salesforce = marks.find((mark) => mark.name === "Salesforce Tower");
        const pyramid = marks.find((mark) => mark.name === "the Transamerica Pyramid");
        if (!salesforce || !pyramid) {
          throw new Error("Downtown skyline landmarks unavailable");
        }
        skylineEye.set(
          summit.x - 106,
          this.scout.heightAt(summit.x, summit.z) + 55.3,
          summit.z + 114,
        );
        skylineTarget.set(
          (salesforce.x + pyramid.x) / 2,
          (this.scout.heightAt(salesforce.x, salesforce.z) +
            this.scout.heightAt(pyramid.x, pyramid.z)) /
            2 +
            45,
          (salesforce.z + pyramid.z) / 2,
        );
        const run = scoutRunNear(this.scout, summit.x, summit.z, {
          minHalf: 3,
          minLen: 45,
          radius: 70,
        });
        if (!run) {
          throw new Error("No driveable Twin Peaks summit road");
        }
        this.reset(0.43, { kind: "custom" });
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
