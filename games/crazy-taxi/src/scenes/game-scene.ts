import * as THREE from "three";
import { Sky } from "three/addons/objects/Sky.js";

import { ModelCache } from "../assets/loader";
import { allModelUrls } from "../assets/manifest";
import { ChaseCamera } from "../fx/camera-rig";
import { SmashCones } from "../fx/cones";
import { Debris } from "../fx/debris";
import { Fx } from "../fx/particles";
import { Sfx } from "../fx/sfx";
import { SkidMarks } from "../fx/skids";
import { SpeedLines } from "../fx/speedlines";
import { FareManager, type FareEvent, tierColor, tierPayMult } from "../game/fares";
import { GameState } from "../game/state";
import { Traffic } from "../game/traffic";
import { InputState } from "../input/keyboard";
import { CAR, FARE, GRID, MPH_FACTOR, WORLD_SIZE } from "../shared/constants";
import { Rng } from "../shared/rng";
import type { GameMode } from "../shared/types";
import { Hud } from "../ui/hud";
import { setupTouch } from "../ui/touch";
import { Car } from "../vehicle/car";
import { CityModel, type Solid } from "../world/city";
import { districtAt } from "../world/sf-map";

const HALF_PI = Math.PI / 2;
// Afternoon sun direction (matches the Sky shader); the shadow light sits along it.
const SUN_DIR = new THREE.Vector3().setFromSphericalCoords(
  1,
  THREE.MathUtils.degToRad(90 - 32),
  THREE.MathUtils.degToRad(150),
);
const SUN_OFFSET = SUN_DIR.clone().multiplyScalar(90);
const NEAR_MISS_MIN = 2.8; // above the contact zone so a hit isn't also a "near miss"
const NEAR_MISS_MAX = 4.6;
const NEAR_MISS_SPEED = 22;
const CRASH_THRESHOLD = 7;
const COUNTDOWN_STEP = 0.45; // seconds per 3-2-1 beat
const BEST_KEY = "crazy-taxi:best";
const HINT_DRIFT_KEY = "crazy-taxi:hint-drift";
const HINT_BOOST_KEY = "crazy-taxi:hint-boost";

// Crazy-Taxi-style license classes; give the score a name and a next target.
const RANKS: readonly { min: number; rank: string }[] = [
  { min: 12000, rank: "S" },
  { min: 8000, rank: "A" },
  { min: 5000, rank: "B" },
  { min: 3000, rank: "C" },
  { min: 1500, rank: "D" },
  { min: 0, rank: "E" },
];

function rankFor(score: number): { rank: string; next: string | null; nextAt: number } {
  for (let i = 0; i < RANKS.length; i++) {
    const r = RANKS[i];
    if (r && score >= r.min) {
      const above = RANKS[i - 1];
      return { rank: r.rank, next: above ? above.rank : null, nextAt: above ? above.min : 0 };
    }
  }
  return { rank: "E", next: "D", nextAt: 1500 };
}

// localStorage throws in some embeds (sandboxed iframes, blocked cookies,
// private modes). The game must boot and run without persistence.
function storageGet(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}
function storageSet(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Blocked store just loses persistence — never the run.
  }
}

function readBest(): number {
  const raw = storageGet(BEST_KEY);
  const n = raw === null ? 0 : Number(raw);
  return Number.isFinite(n) ? n : 0;
}

export class GameScene {
  readonly scene = new THREE.Scene();
  private rig: ChaseCamera;
  private cache = new ModelCache();
  private input = new InputState();
  private hud = new Hud();
  private fx = new Fx();
  private sfx = new Sfx();
  private state = new GameState();

  private city: CityModel | null = null;
  private car: Car | null = null;
  private fares: FareManager | null = null;
  private traffic: Traffic | null = null;
  private skids: SkidMarks | null = null;
  private debris: Debris | null = null;
  private speedLines = new SpeedLines();
  private cones: SmashCones | null = null;

  private sun = new THREE.DirectionalLight(0xfff2d8, 2.0);
  private sky: Sky;
  private mode: GameMode = { kind: "loading", progress: 0 };
  private titleT = 0;
  private lowBeepAt = -1;
  private puffAccum = 0;
  private flameAccum = 0;
  private skidDist = 0;
  private scrapeFrames = 0;
  private wasBoosting = false;
  private wasCharged = false;
  private paused = false;
  private outro = -1; // >=0: slow-mo time-up sting is running
  private countdownShown = -1;
  private camFrom = new THREE.Vector3();
  private hintDriftShown = storageGet(HINT_DRIFT_KEY) !== null;
  private hintBoostShown = storageGet(HINT_BOOST_KEY) !== null;
  private turnHold = 0;
  // Reused per-frame collision set: static city solids + mutable traffic boxes
  // (same object refs live in allSolids, so we mutate in place, never realloc).
  private trafficBoxes: {
    minX: number;
    maxX: number;
    minZ: number;
    maxZ: number;
    maxY: number;
  }[] = [];
  private allSolids: Solid[] = [];
  private hitStop = 0; // brief sim freeze for crash impact
  private spawn = { x: 0, z: 0, yaw: 0, gx: 0, gz: 0 };
  private lastDistrict = "";
  private scrArrow = new THREE.Vector3();
  // When true (set by DEV debug hooks only) the game stops driving the camera,
  // so an external tool can park it anywhere for inspection.
  freecam = false;

  constructor(aspect: number) {
    this.rig = new ChaseCamera(aspect);

    // Atmospheric sky + sun.
    const sky = new Sky();
    sky.scale.setScalar(12000);
    const su = sky.material.uniforms;
    const setU = (name: string, value: number): void => {
      const u = su[name];
      if (u) u.value = value;
    };
    setU("turbidity", 8);
    setU("rayleigh", 1.8);
    setU("mieCoefficient", 0.005);
    setU("mieDirectionalG", 0.85);
    const sunU = su.sunPosition;
    if (sunU && sunU.value instanceof THREE.Vector3) sunU.value.copy(SUN_DIR);
    this.scene.add(sky);
    this.sky = sky;

    this.scene.fog = new THREE.Fog(0xbcd7ea, WORLD_SIZE * 0.75, WORLD_SIZE * 2.3);

    const hemi = new THREE.HemisphereLight(0xbfe0ff, 0x4a4a3e, 0.35);
    this.scene.add(hemi);
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.08));

    this.sun.position.copy(SUN_OFFSET);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.camera.near = 1;
    this.sun.shadow.camera.far = 260;
    const sc = this.sun.shadow.camera;
    sc.left = -58;
    sc.right = 58;
    sc.top = 58;
    sc.bottom = -58;
    sc.updateProjectionMatrix();
    this.sun.shadow.bias = -0.0005;
    this.sun.shadow.normalBias = 0.04;
    this.scene.add(this.sun);
    this.scene.add(this.sun.target);

    // Ocean surrounding the island (reflects the sky via scene.environment).
    const ocean = new THREE.Mesh(
      new THREE.PlaneGeometry(9000, 9000),
      new THREE.MeshStandardMaterial({ color: 0x3573a4, roughness: 0.32, metalness: 0.3 }),
    );
    ocean.rotation.x = -HALF_PI;
    ocean.position.y = -0.5;
    this.scene.add(ocean);

    this.fx.addTo(this.scene);
    this.scene.add(this.speedLines.object3D);
    setupTouch(this.input);
    this.hud.onCta(() => this.handleStartPress());
    this.hud.onMute(() => this.toggleMute());
  }

  get camera(): THREE.PerspectiveCamera {
    return this.rig.camera;
  }

  // Bake a sky environment map so PBR materials (ocean, glass, paint) pick up
  // subtle sky reflections. Called once from main after the renderer exists.
  applyEnvironment(renderer: THREE.WebGLRenderer): void {
    const pmrem = new THREE.PMREMGenerator(renderer);
    const tmp = new THREE.Scene();
    tmp.add(this.sky);
    const rt = pmrem.fromScene(tmp);
    this.scene.environment = rt.texture;
    this.scene.environmentIntensity = 0.32; // the HDR sky is bright; keep fill subtle
    this.scene.add(this.sky); // move the sky back into the live scene
    pmrem.dispose();
  }

  async load(): Promise<void> {
    await this.cache.preload(allModelUrls(), (frac) => {
      this.mode = { kind: "loading", progress: frac };
      this.hud.setLoading(frac);
    });
    const city = new CityModel(this.cache);
    this.scene.add(city.group);
    this.city = city;

    this.spawn = this.computeSpawn(city);
    const car = new Car(this.cache);
    car.setSurface(city);
    this.scene.add(car.object3D);
    car.reset(this.spawn.x, this.spawn.z, this.spawn.yaw);
    this.car = car;

    this.traffic = new Traffic(this.cache, city, {
      avoid: { gx: this.spawn.gx, gz: this.spawn.gz },
      avoidR: 4,
    });
    this.scene.add(this.traffic.group);
    this.trafficBoxes = this.traffic.cars.map(() => ({
      minX: 0,
      maxX: 0,
      minZ: 0,
      maxZ: 0,
      maxY: 0,
    }));
    this.allSolids = city.solids.concat(this.trafficBoxes);

    this.fares = new FareManager(this.cache, city);
    this.scene.add(this.fares.group);

    this.skids = new SkidMarks((x, z) => city.heightAt(x, z));
    this.scene.add(this.skids.mesh);
    this.debris = new Debris(this.cache, (x, z) => city.heightAt(x, z));
    this.scene.add(this.debris.group);
    this.cones = new SmashCones(this.cache, city, new Rng(777));
    this.scene.add(this.cones.mesh);

    this.rig.snapTo(car);
    this.hud.hideLoading();
    this.toTitle();
  }

  resize(aspect: number, scalePx: number): void {
    this.rig.resize(aspect);
    this.fx.setScale(scalePx);
  }

  private toTitle(): void {
    this.mode = { kind: "title" };
    this.hud.hideFareCard();
    this.hud.setArrow(false, 0, 0, 0);
    this.hud.setTimer(FARE.startTime, false);
    this.hud.setVignette(0);
    this.hud.setCombo(1, 0);
    const best = readBest();
    this.hud.showBanner({
      title: "CRAZY TAXI",
      sub: "Pick up fares, beat the clock, drive like a maniac.",
      stats: best > 0 ? `BEST $${best.toLocaleString("en-US")}` : "Every drop-off buys you more time.",
      cta: "PRESS ENTER TO DRIVE",
    });
  }

  private handleStartPress(): void {
    if (this.mode.kind === "title" || this.mode.kind === "gameover") this.start();
  }

  private toggleMute(): void {
    this.sfx.setMuted(!this.sfx.muted);
    this.hud.setMuted(this.sfx.muted);
  }

  private start(): void {
    const car = this.car;
    const fares = this.fares;
    if (!car || !fares) return;
    this.sfx.ensure();
    this.sfx.startMusic();
    this.state.reset();
    this.hud.resetScore(0);
    car.reset(this.spawn.x, this.spawn.z, this.spawn.yaw);
    this.traffic?.reset({ gx: this.spawn.gx, gz: this.spawn.gz }, 4);
    fares.reset(car.position.x, car.position.z);
    this.cones?.reset();
    this.hud.hideBanner();
    this.hud.setPaused(false);
    // A fresh dashboard through the countdown — no stale timer/fares/combo.
    this.hud.setTimer(FARE.startTime, false);
    this.hud.setFares(0);
    this.hud.setCombo(1, 0);
    this.hud.hideFareCard();
    this.hud.setArrow(false, 0, 0, 0);
    this.hud.setVignette(0);
    this.paused = false;
    this.outro = -1;
    this.hitStop = 0;
    this.lowBeepAt = -1;
    this.lastDistrict = "";
    this.countdownShown = -1;
    this.camFrom.copy(this.rig.camera.position);
    this.mode = { kind: "countdown", t: 0 };
  }

  // Nearest road cell to the centre, facing an open road direction.
  private computeSpawn(city: CityModel): {
    x: number;
    z: number;
    yaw: number;
    gx: number;
    gz: number;
  } {
    const c = (GRID - 1) / 2;
    let bg = { gx: Math.round(c), gz: Math.round(c) };
    let bd = Infinity;
    for (const rc of city.roadCells) {
      const d = Math.abs(rc.gx - c) + Math.abs(rc.gz - c);
      if (d < bd) {
        bd = d;
        bg = { gx: rc.gx, gz: rc.gz };
      }
    }
    const isRoad = (gx: number, gz: number): boolean => city.plan.cells[gx]?.[gz] === "road";
    let yaw = 0;
    if (isRoad(bg.gx, bg.gz + 1)) yaw = 0;
    else if (isRoad(bg.gx, bg.gz - 1)) yaw = Math.PI;
    else if (isRoad(bg.gx + 1, bg.gz)) yaw = HALF_PI;
    else if (isRoad(bg.gx - 1, bg.gz)) yaw = -HALF_PI;
    return { x: city.worldX(bg.gx), z: city.worldZ(bg.gz), yaw, gx: bg.gx, gz: bg.gz };
  }

  // DEV-only: drop the taxi at the road cell nearest to normalized map coords
  // (u,v) — snapped onto a road, yaw aligned to an open road direction nearest
  // the requested one, so scripted drives don't start nose-first into a lot.
  debugTeleport(u: number, v: number, yaw: number): void {
    const car = this.car;
    const city = this.city;
    if (!car || !city) return;
    const x = (u - 0.5) * WORLD_SIZE;
    const z = (v - 0.5) * WORLD_SIZE;
    let best: { gx: number; gz: number } | null = null;
    let bd = Infinity;
    for (const rc of city.roadCells) {
      const cx = city.worldX(rc.gx);
      const cz = city.worldZ(rc.gz);
      const d = (cx - x) * (cx - x) + (cz - z) * (cz - z);
      if (d < bd) {
        bd = d;
        best = rc;
      }
    }
    if (!best) return;
    const isRoad = (gx: number, gz: number): boolean => city.plan.cells[gx]?.[gz] === "road";
    const options: { yaw: number; open: boolean }[] = [
      { yaw: 0, open: isRoad(best.gx, best.gz + 1) },
      { yaw: Math.PI, open: isRoad(best.gx, best.gz - 1) },
      { yaw: HALF_PI, open: isRoad(best.gx + 1, best.gz) },
      { yaw: -HALF_PI, open: isRoad(best.gx - 1, best.gz) },
    ];
    let bestYaw = yaw;
    let bestDiff = Infinity;
    for (const o of options) {
      if (!o.open) continue;
      const diff = Math.abs(((o.yaw - yaw + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
      if (diff < bestDiff) {
        bestDiff = diff;
        bestYaw = o.yaw;
      }
    }
    car.reset(city.worldX(best.gx), city.worldZ(best.gz), bestYaw);
    this.rig.snapTo(car);
  }

  // DEV-only: force the run clock (endgame testing).
  debugSetTime(seconds: number): void {
    this.state.timeLeft = seconds;
  }

  // DEV-only: live car state for headless verification.
  debugProbe(): {
    x: number;
    z: number;
    y: number;
    speed: number;
    heading: number;
    airborne: boolean;
    drifting: boolean;
    boosting: boolean;
    carrying: boolean;
    objective: { u: number; v: number } | null;
  } | null {
    const car = this.car;
    if (!car) return null;
    const obj = this.fares?.objective() ?? null;
    return {
      x: car.position.x,
      z: car.position.z,
      y: car.position.y,
      speed: car.speed,
      heading: car.heading,
      airborne: car.airborne,
      drifting: car.isDrifting,
      boosting: car.isBoosting,
      carrying: this.fares?.carryingInfo() !== null && this.fares !== null,
      objective: obj
        ? { u: obj.pos.x / WORLD_SIZE + 0.5, v: obj.pos.z / WORLD_SIZE + 0.5 }
        : null,
    };
  }

  update(dt: number): void {
    if (this.input.consumeStart()) this.handleStartPress();
    // Single read — calling consumeRestart() twice would clear the one-shot flag
    // before the second branch could see it. R restarts from any state.
    if (this.input.consumeRestart()) this.start();
    if (this.input.consumeMute()) this.toggleMute();
    if (this.input.consumePause() && this.mode.kind === "playing") {
      this.paused = !this.paused;
      this.hud.setPaused(this.paused);
      if (this.paused) this.silenceLoops();
    }
    if (this.input.consumeBlur() && this.mode.kind === "playing" && !this.paused) {
      this.paused = true;
      this.hud.setPaused(true);
      this.silenceLoops();
    }

    this.hud.update(dt);
    this.fx.update(dt);
    this.skids?.update(dt);
    this.debris?.update(dt);
    this.cones?.update(dt);

    switch (this.mode.kind) {
      case "loading":
        break;
      case "title":
        this.updateTitle(dt);
        break;
      case "countdown":
        this.updateCountdown(this.mode, dt);
        break;
      case "playing":
        if (!this.paused) this.updatePlaying(dt);
        break;
      case "gameover":
        this.updateTitle(dt);
        break;
    }
  }

  private silenceLoops(): void {
    this.sfx.stopEngine();
    this.sfx.setScreech(0, 0);
    this.sfx.setScrape(false);
    this.sfx.setBoostLoop(false);
  }

  private updateTitle(dt: number): void {
    this.titleT += dt;
    const car = this.car;
    if (!car) return;
    if (this.freecam) {
      this.updateSun();
      return;
    }
    // High, slow orbit — above the rooftops so facades can't swallow the shot.
    const r = 30;
    const a = this.titleT * 0.2;
    this.rig.camera.position.set(
      car.position.x + Math.cos(a) * r,
      car.position.y + 17,
      car.position.z + Math.sin(a) * r,
    );
    this.rig.camera.lookAt(car.position.x, car.position.y + 1.0, car.position.z);
    this.speedLines.update(dt, this.rig.camera, 0); // fade out leftover streaks
    this.updateSun();
  }

  // 3-2-1-GO: the camera swoops from the title orbit into the chase pose while
  // the numbers count down; holding gas through GO pays launch-control boost.
  private updateCountdown(mode: { kind: "countdown"; t: number }, dt: number): void {
    const car = this.car;
    if (!car) return;
    mode.t += dt;
    const total = COUNTDOWN_STEP * 3;
    const step = Math.min(2, Math.floor(mode.t / COUNTDOWN_STEP));
    if (step !== this.countdownShown) {
      this.countdownShown = step;
      this.hud.showCountdown(String(3 - step), false);
      this.sfx.countdown();
    }
    // Swoop: ease from the orbit pose into the chase pose.
    const f = THREE.MathUtils.smoothstep(Math.min(1, mode.t / total), 0, 1);
    const fwd = new THREE.Vector2(Math.sin(car.heading), Math.cos(car.heading));
    const chase = new THREE.Vector3(
      car.position.x - fwd.x * 17,
      car.position.y + 10.5,
      car.position.z - fwd.y * 17,
    );
    this.rig.camera.position.lerpVectors(this.camFrom, chase, f);
    this.rig.camera.lookAt(car.position.x, car.position.y + 1.6, car.position.z);
    this.updateSun();

    if (mode.t >= total) {
      this.hud.showCountdown("GO!", true);
      this.sfx.go();
      this.rig.snapTo(car);
      if (this.input.carInput().throttle > 0) {
        car.addBoost(25);
        this.hud.announceMinor("LAUNCH BOOST!", "#ffd147");
      }
      this.mode = { kind: "playing" };
    }
  }

  private updatePlaying(dt: number): void {
    const car = this.car;
    const city = this.city;
    const fares = this.fares;
    const traffic = this.traffic;
    if (!car || !city || !fares || !traffic) return;

    // Time-up outro: 1.2s of slow-mo before the banner so the ending lands.
    if (this.outro >= 0) {
      this.outro -= dt;
      dt *= 0.35;
      if (this.outro <= 0) {
        this.endRun();
        return;
      }
    }

    // Hit-stop: freeze the sim for a beat after a hard crash so the blow lands.
    // Camera/HUD keep running on real time so it reads as impact, not a stutter.
    if (this.hitStop > 0) {
      this.hitStop = Math.max(0, this.hitStop - dt);
      this.rig.update(dt, car, city.solids);
      this.updateSun();
      this.updateHud(car, fares);
      return;
    }

    const input = this.input.carInput();

    // Refresh the moving traffic boxes in place (allSolids shares these refs).
    for (let i = 0; i < traffic.cars.length; i++) {
      const c = traffic.cars[i];
      const b = this.trafficBoxes[i];
      if (!c || !b) continue;
      b.minX = c.position.x - 1.05;
      b.maxX = c.position.x + 1.05;
      b.minZ = c.position.z - 1.25;
      b.maxZ = c.position.z + 1.25;
      b.maxY = c.position.y + 1.9; // jumpable: airborne taxis clear the roof
    }

    car.update(dt, input, this.allSolids);
    traffic.update(dt, city, car.position.x, car.position.z, car.heading);
    this.handleNearMiss(car, traffic);
    this.handleHonks(traffic);
    this.handleCones(car);

    // The run is over during the outro — no fare events, no combo ticking.
    if (this.outro < 0) {
      const ev = fares.update(dt, car);
      this.handleFareEvent(ev);
      this.state.update(dt, fares.carryingInfo() !== null);
    }

    // Drift: score + screech + smoke + skid marks (slip-gated in the car).
    const drifting = car.isDrifting && car.speed > 8;
    if (drifting) this.state.addDrift(dt);
    else this.state.endDrift();
    const slipAmt = Math.min(1, Math.abs(car.slip) / 0.6);
    // During the outro the farewell skid owns the screech channel.
    if (this.outro < 0) {
      this.sfx.setScreech(
        drifting && !car.airborne ? Math.max(0.25, slipAmt) : 0,
        car.speed / CAR.maxSpeed,
      );
    }
    if (drifting || car.isBoosting) this.emitDriftSmoke(dt, car);
    if (drifting && !car.airborne) this.stampSkids(car, dt);

    // Drift charge tell: sparks turn cyan + a blip the moment the boost arms.
    const charged = car.driftCharge >= 1 && drifting;
    if (charged && !this.wasCharged) this.sfx.driftArm();
    this.wasCharged = charged;

    // Drift-release slingshot — the signature skill move — gets its own payoff.
    if (car.miniBoostFired) {
      this.sfx.boost();
      this.rig.addTrauma(0.18);
      this.hud.flash("#ffd147", 0.16);
      this.fx.burst(car.position.x, 0.6, car.position.z, 0.08, 8, 7);
      this.hud.showCombo("DRIFT BOOST!");
    }

    // Boost package: ignition one-shot + loop + flames + camera kick.
    if (car.isBoosting && !this.wasBoosting) {
      this.sfx.boost();
      this.rig.addTrauma(0.12);
    }
    this.wasBoosting = car.isBoosting;
    this.sfx.setBoostLoop(car.isBoosting);
    if (car.isBoosting) {
      this.flameAccum += dt;
      if (this.flameAccum >= 0.05) {
        this.flameAccum = 0;
        const bx = car.position.x - Math.sin(car.heading) * 1.9;
        const bz = car.position.z - Math.cos(car.heading) * 1.9;
        this.fx.exhaustFlame(
          bx,
          car.position.y + 0.5,
          bz,
          -Math.sin(car.heading),
          -Math.cos(car.heading),
        );
      }
    }
    if (car.boostDenied) {
      this.sfx.denied();
      this.hud.boostDenied();
    }

    this.sfx.setEngine(
      Math.min(1, car.speed / CAR.boostSpeed),
      input.throttle,
      car.isBoosting,
      car.airborne,
    );

    // Landing package: squash (in the car), dust ring, thud, shake, air pay.
    if (car.justLanded > 0) {
      this.fx.dustRing(car.position.x, car.position.y + 0.15, car.position.z, 10);
      this.sfx.landThud(Math.min(1, car.justLanded / 12));
      this.rig.addTrauma(Math.min(0.45, 0.15 + car.justLanded * 0.015));
      if (car.airTime > 0.45) {
        const pts = this.state.landAir(car.airTime);
        this.hud.announceMinor(`AIR ${car.airTime.toFixed(1)}s +$${pts}`, "#8fd9ff");
      }
    }

    // Wall contact: crash / scrape / curb-tap, in descending order of drama.
    if (car.lastWallHit > CRASH_THRESHOLD) {
      const impact = car.lastWallHit;
      const p = Math.min(1, (impact - CRASH_THRESHOLD) / 20);
      this.rig.addTrauma(0.35 + p * 0.5);
      this.hud.flash("#ffffff", 0.25 + p * 0.3);
      this.fx.burst(car.position.x, 1, car.position.z, 0.07, 10, 6 + p * 8);
      this.sfx.crash(impact);
      this.debris?.burst(
        car.position.x,
        car.position.z,
        car.lastWallNormal.x,
        car.lastWallNormal.y,
        impact,
      );
      if (this.skids) {
        for (let i = 0; i < 4; i++) {
          this.skids.stamp(
            car.position.x + (Math.random() - 0.5) * 1.6,
            car.position.z + (Math.random() - 0.5) * 1.6,
            car.heading,
            0.5,
          );
        }
      }
      if (impact > 12) {
        this.hitStop = THREE.MathUtils.clamp(0.04 + (impact - 12) * 0.004, 0.04, 0.13);
      }
    } else if (car.lastWallHit > 2) {
      this.sfx.thud();
      this.rig.addTrauma(0.06);
    }
    // Scrape loop: grinding along a wall below crash speed.
    if (car.wallContact && car.lastWallHit <= CRASH_THRESHOLD && car.speed > 7) {
      this.scrapeFrames = Math.min(this.scrapeFrames + 1, 10);
    } else {
      this.scrapeFrames = Math.max(this.scrapeFrames - 1, 0);
    }
    const scraping = this.scrapeFrames >= 2;
    this.sfx.setScrape(scraping);
    if (scraping && Math.random() < 0.4) {
      this.fx.scrapeSparks(
        car.position.x - car.lastWallNormal.x * 0.9,
        car.position.y + 0.5,
        car.position.z - car.lastWallNormal.y * 0.9,
        car.lastWallNormal.x,
        car.lastWallNormal.y,
      );
    }

    // One-time teach toasts for the two skill verbs.
    if (!this.hintDriftShown) {
      this.turnHold = Math.abs(input.steer) > 0.5 && car.speed > 30 ? this.turnHold + dt : 0;
      if (this.turnHold > 0.8) {
        this.hintDriftShown = true;
        storageSet(HINT_DRIFT_KEY, "1");
        this.hud.announceMinor("HOLD SPACE TO DRIFT", "#ffd147");
      }
    }
    if (!this.hintBoostShown && car.boostMeter >= CAR.boostMax) {
      this.hintBoostShown = true;
      storageSet(HINT_BOOST_KEY, "1");
      this.hud.announceMinor("SHIFT — BOOST!", "#ffd147");
    }

    // Announce the SF neighborhood as the taxi crosses into it.
    const dist = districtAt(city.gridX(car.position.x), city.gridZ(car.position.z));
    if (dist.name !== this.lastDistrict) {
      this.lastDistrict = dist.name;
      this.hud.showDistrict(dist.name);
    }

    if (!this.freecam) {
      this.rig.update(dt, car, city.solids);
      // Keep the camera above the terrain (hills can rise behind the car).
      const cam = this.rig.camera;
      const minY = city.heightAt(cam.position.x, cam.position.z) + 2.5;
      if (cam.position.y < minY) cam.position.y = minY;
    }
    this.speedLines.update(dt, this.rig.camera, car.speed / CAR.boostSpeed);
    this.hud.setVignette(THREE.MathUtils.clamp((car.speed - 45) / 40, 0, 1) * 0.6);
    this.updateSun();
    this.updateHud(car, fares);

    if (this.state.timeLeft <= 10) {
      const sec = Math.ceil(this.state.timeLeft);
      if (sec !== this.lowBeepAt && sec > 0) {
        this.lowBeepAt = sec;
        this.sfx.beep();
      }
    }

    if (this.state.timedOut && this.outro < 0) {
      this.outro = 1.2;
      this.silenceLoops();
      this.sfx.setScreech(1, 1); // one long farewell skid
    }
  }

  private emitDriftSmoke(dt: number, car: Car): void {
    this.puffAccum += dt;
    if (this.puffAccum < 0.03) return;
    this.puffAccum = 0;
    const fx = Math.sin(car.heading);
    const fz = Math.cos(car.heading);
    const rx = car.position.x - fx * 1.6;
    const rz = car.position.z - fz * 1.6;
    const px = -fz;
    const pz = fx;
    const charged = car.driftCharge >= 1 && car.isDrifting;
    this.fx.driftPuff(rx + px * 0.7, rz + pz * 0.7, car.isBoosting, charged);
    this.fx.driftPuff(rx - px * 0.7, rz - pz * 0.7, car.isBoosting, charged);
  }

  private stampSkids(car: Car, dt: number): void {
    const skids = this.skids;
    if (!skids) return;
    // Distance-based stamping: a mark every ~0.55u of travel per rear wheel.
    this.skidDist += car.speed * dt;
    if (this.skidDist < 0.55) return;
    this.skidDist = 0;
    const fx = Math.sin(car.heading);
    const fz = Math.cos(car.heading);
    const rx = car.position.x - fx * 1.6;
    const rz = car.position.z - fz * 1.6;
    const px = -fz;
    const pz = fx;
    skids.stamp(rx + px * 0.7, rz + pz * 0.7, car.heading);
    skids.stamp(rx - px * 0.7, rz - pz * 0.7, car.heading);
  }

  private handleCones(car: Car): void {
    const cones = this.cones;
    if (!cones) return;
    const vx = Math.sin(car.heading) * car.speed;
    const vz = Math.cos(car.heading) * car.speed;
    const hits = cones.tryHit(car.position.x, car.position.z, vx, vz);
    if (hits > 0) {
      let cash = 0;
      for (let i = 0; i < hits; i++) cash += this.state.smash();
      this.hud.announceMinor(`SMASH +$${cash}`, "#ffb64d");
      this.sfx.thud();
      this.fx.burst(car.position.x, 0.8, car.position.z, 0.07, 5, 4);
    }
  }

  private handleHonks(traffic: Traffic): void {
    for (const c of traffic.cars) {
      if (!c.wantsHonk) continue;
      c.wantsHonk = false;
      this.sfx.honk(this.panFor(c.position));
    }
  }

  // Which ear should hear an event at this world position?
  private panFor(pos: THREE.Vector3): number {
    const cam = this.rig.camera;
    const right = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 0);
    const rel = new THREE.Vector3().subVectors(pos, cam.position);
    return THREE.MathUtils.clamp(rel.dot(right) / 14, -1, 1);
  }

  private handleFareEvent(ev: FareEvent): void {
    const car = this.car;
    const city = this.city;
    if (ev.kind === "pickup") {
      this.sfx.pickup();
      this.fx.burst(ev.pos.x, 1.2, ev.pos.z, 0.5, 10, 5);
      const destName = city ? districtAt(ev.dest.gx, ev.dest.gz).name : "";
      this.hud.showCombo(destName ? `TO ${destName.toUpperCase()}!` : "GO GO GO!");
      if (car) car.addBoost(20);
    } else if (ev.kind === "dropoff") {
      const reward = this.state.dropoff(ev.tiles, ev.rideTime, tierPayMult(ev.tier));
      this.sfx.dropoff(reward.combo);
      this.fx.burst(ev.pos.x, 1.2, ev.pos.z, 0.3, 26, 9);
      this.hud.flashTimeBonus(reward.timeBonus);
      this.hud.flash("#6bff8e", 0.22);
      this.rig.addTrauma(0.25);
      // Itemized receipt: fare, then tip, then combo — each earns its beat.
      const lines: { text: string; color: string }[] = [
        { text: `FARE $${reward.fare}`, color: "#ffffff" },
      ];
      if (reward.tip > 0) lines.push({ text: `TIP $${reward.tip} SPEEDY!`, color: "#6bff8e" });
      if (reward.combo > 1) lines.push({ text: `${reward.combo}× COMBO`, color: "#ffd147" });
      if (reward.overflowCash > 0)
        lines.push({ text: `TIME FULL +$${reward.overflowCash}`, color: "#8fd9ff" });
      this.hud.showReceipt(lines);
      this.hud.showCombo(`+$${reward.gross}`);
      if (car) car.addBoost(30);
    } else if (ev.kind === "bail") {
      this.state.bail();
      this.sfx.denied();
      this.hud.flash("#ff5a52", 0.2);
      this.hud.announceMinor("PASSENGER BAILED!", "#ff5a52");
    }
  }

  private handleNearMiss(car: Car, traffic: Traffic): void {
    if (car.speed < NEAR_MISS_SPEED) return;
    if (car.lastWallHit > 0) return; // a crash this frame isn't a near miss
    for (const c of traffic.cars) {
      if (c.missCooldown > 0) continue;
      const dx = car.position.x - c.position.x;
      const dz = car.position.z - c.position.z;
      const d = Math.hypot(dx, dz);
      if (d >= NEAR_MISS_MIN && d <= NEAR_MISS_MAX) {
        c.missCooldown = 2.6; // long enough that tailgating can't farm it
        const speedFrac = car.speed / CAR.boostSpeed;
        const pts = this.state.nearMiss(speedFrac);
        car.addBoost(CAR.boostPerNearMiss);
        this.fx.burst(c.position.x, 1, c.position.z, 0.5, 6, 4);
        const insane = speedFrac > 0.8;
        this.hud.announceMinor(
          insane ? `INSANE! +$${pts}` : `NEAR MISS +$${pts}`,
          insane ? "#ff8a3c" : "#aee3ff",
        );
        this.sfx.nearMiss(this.panFor(c.position));
      }
    }
  }

  private updateSun(): void {
    // Shadows follow the camera in freecam so any inspected spot is lit.
    const anchor = this.freecam ? this.rig.camera.position : this.car?.position;
    if (!anchor) return;
    this.sun.position.copy(anchor).add(SUN_OFFSET);
    this.sun.target.position.copy(anchor);
    this.sun.target.updateMatrixWorld();
  }

  private updateHud(car: Car, fares: FareManager): void {
    this.hud.setTimer(this.state.timeLeft, this.state.timeLeft <= 10);
    this.hud.setScore(this.state.displayScore);
    this.hud.setFares(this.state.fares);
    this.hud.setSpeed(car.speed * MPH_FACTOR);
    this.hud.setBoost(car.boostMeter / CAR.boostMax);
    this.hud.setCombo(this.state.combo, this.state.comboTimer / FARE.comboWindow);

    const carrying = fares.carryingInfo();
    if (carrying) {
      const city = this.city;
      const name = city ? districtAt(carrying.dest.gx, carrying.dest.gz).name : "";
      const distM = Math.hypot(car.position.x - carrying.pos.x, car.position.z - carrying.pos.z);
      const pay = Math.round(
        (FARE.baseFare + FARE.farePerTile * carrying.tiles) * tierPayMult(carrying.tier),
      );
      const accent = `#${tierColor(carrying.tier).toString(16).padStart(6, "0")}`;
      this.hud.setFareCard(`TO ${name.toUpperCase()} →`, distM, `FARE $${pay} + TIP`, accent);
      this.hud.setPatience(fares.patienceFrac());
      this.projectArrow(carrying.pos, "#49e0ff");
      return;
    }
    const next = fares.nearestWaiting(car.position.x, car.position.z);
    if (!next) {
      this.hud.hideFareCard();
      this.hud.setArrow(false, 0, 0, 0);
      return;
    }
    const dist = Math.hypot(car.position.x - next.pos.x, car.position.z - next.pos.z);
    const tag = next.tier === "short" ? "$" : next.tier === "medium" ? "$$" : "$$$";
    const accent = `#${tierColor(next.tier).toString(16).padStart(6, "0")}`;
    this.hud.setFareCard("PICK UP FARE", dist, `${tag} RIDE →`, accent);
    this.hud.setPatience(null);
    this.projectArrow(next.pos, accent);
  }

  private projectArrow(target: THREE.Vector3, color: string): void {
    const ndc = this.scrArrow.copy(target).project(this.rig.camera);
    const behind = ndc.z > 1;
    let x = ndc.x;
    let y = ndc.y;
    if (behind) {
      x = -x;
      y = -y;
    }
    const onScreen = !behind && x > -0.92 && x < 0.92 && y > -0.92 && y < 0.92;
    if (onScreen) {
      this.hud.setArrow(false, 0, 0, 0);
      return;
    }
    const m = 0.86;
    const cx = THREE.MathUtils.clamp(x, -m, m);
    const cy = THREE.MathUtils.clamp(y, -m, m);
    const sx = (cx * 0.5 + 0.5) * window.innerWidth;
    const sy = (-cy * 0.5 + 0.5) * window.innerHeight;
    const dx = sx - window.innerWidth / 2;
    const dy = sy - window.innerHeight / 2;
    const rot = Math.atan2(dx, -dy);
    this.hud.setArrow(true, sx - 32, sy - 32, rot, color);
  }

  private endRun(): void {
    this.silenceLoops();
    this.sfx.stopMusic();
    this.sfx.gameOver();
    this.hud.hideFareCard();
    this.hud.setArrow(false, 0, 0, 0);
    this.hud.setVignette(0);
    this.hud.setPatience(null);
    this.outro = -1;
    const score = this.state.displayScore;
    const best = readBest();
    const isBest = score > best;
    if (isBest) {
      storageSet(BEST_KEY, String(score));
      this.sfx.fanfare();
    }
    const { rank, next, nextAt } = rankFor(score);
    const tease = next ? ` · next: CLASS ${next} at $${nextAt.toLocaleString("en-US")}` : "";
    this.mode = { kind: "gameover", score, fares: this.state.fares };
    this.hud.showBanner({
      title: isBest ? "NEW BEST!" : "TIME'S UP!",
      sub: `$${score.toLocaleString("en-US")} — CLASS ${rank} LICENSE`,
      stats: `${this.state.fares} fares · best drift ${this.state.bestDrift.toFixed(1)}s · best air ${this.state.bestAir.toFixed(1)}s${tease}`,
      cta: "PRESS ENTER TO RETRY",
    });
  }
}
