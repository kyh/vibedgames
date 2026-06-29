import * as THREE from "three";
import { Sky } from "three/addons/objects/Sky.js";

import { ModelCache } from "../assets/loader";
import { allModelUrls } from "../assets/manifest";
import { ChaseCamera } from "../fx/camera-rig";
import { Fx } from "../fx/particles";
import { Sfx } from "../fx/sfx";
import { FareManager, type FareEvent } from "../game/fares";
import { GameState } from "../game/state";
import { Traffic } from "../game/traffic";
import { InputState } from "../input/keyboard";
import { CAR, FARE, GRID, MPH_FACTOR, WORLD_SIZE } from "../shared/constants";
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

  private sun = new THREE.DirectionalLight(0xfff2d8, 2.0);
  private sky: Sky;
  private mode: GameMode = { kind: "loading", progress: 0 };
  private titleT = 0;
  private lowBeepAt = -1;
  private puffAccum = 0;
  // Reused per-frame collision set: static city solids + mutable traffic boxes
  // (same object refs live in allSolids, so we mutate in place, never realloc).
  private trafficBoxes: { minX: number; maxX: number; minZ: number; maxZ: number }[] = [];
  private allSolids: Solid[] = [];
  private hitStop = 0; // brief sim freeze for crash impact
  private spawn = { x: 0, z: 0, yaw: 0, gx: 0, gz: 0 };
  private lastDistrict = "";

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

    this.scene.fog = new THREE.Fog(0xaecee8, WORLD_SIZE * 0.7, WORLD_SIZE * 2.1);

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
      new THREE.MeshStandardMaterial({ color: 0x205886, roughness: 0.16, metalness: 0.55 }),
    );
    ocean.rotation.x = -HALF_PI;
    ocean.position.y = -0.5;
    this.scene.add(ocean);

    this.fx.addTo(this.scene);
    setupTouch(this.input);
    this.hud.onCta(() => this.handleStartPress());
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
    car.setTerrain(city.terrain);
    this.scene.add(car.object3D);
    car.reset(this.spawn.x, this.spawn.z, this.spawn.yaw);
    this.car = car;

    this.traffic = new Traffic(this.cache, city, {
      avoid: { gx: this.spawn.gx, gz: this.spawn.gz },
      avoidR: 4,
    });
    this.scene.add(this.traffic.group);
    this.trafficBoxes = this.traffic.cars.map(() => ({ minX: 0, maxX: 0, minZ: 0, maxZ: 0 }));
    this.allSolids = city.solids.concat(this.trafficBoxes);

    this.fares = new FareManager(this.cache, city);
    this.scene.add(this.fares.group);

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
    this.hud.showBanner({
      title: "CRAZY TAXI",
      sub: "Pick up fares, beat the clock, drive like a maniac.",
      stats: "Every drop-off buys you more time.",
      cta: "PRESS ENTER TO DRIVE",
    });
  }

  private handleStartPress(): void {
    if (this.mode.kind === "title" || this.mode.kind === "gameover") this.start();
  }

  private start(): void {
    const car = this.car;
    const fares = this.fares;
    if (!car || !fares) return;
    this.sfx.ensure();
    this.state.reset();
    car.reset(this.spawn.x, this.spawn.z, this.spawn.yaw);
    this.traffic?.reset({ gx: this.spawn.gx, gz: this.spawn.gz }, 4);
    fares.reset(car.position.x, car.position.z);
    this.rig.snapTo(car);
    this.hud.hideBanner();
    this.lowBeepAt = -1;
    this.lastDistrict = "";
    this.mode = { kind: "playing" };
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

  update(dt: number): void {
    if (this.input.consumeStart()) this.handleStartPress();
    // Single read — calling consumeRestart() twice would clear the one-shot flag
    // before the second branch could see it. R restarts from any state.
    if (this.input.consumeRestart()) this.start();

    this.fx.update(dt);

    switch (this.mode.kind) {
      case "loading":
        break;
      case "title":
        this.updateTitle(dt);
        break;
      case "playing":
        this.updatePlaying(dt);
        break;
      case "gameover":
        this.updateTitle(dt);
        break;
    }
  }

  private updateTitle(dt: number): void {
    this.titleT += dt;
    const car = this.car;
    if (!car) return;
    const r = 21;
    const a = this.titleT * 0.22;
    this.rig.camera.position.set(
      car.position.x + Math.cos(a) * r,
      car.position.y + 11,
      car.position.z + Math.sin(a) * r,
    );
    this.rig.camera.lookAt(car.position.x, car.position.y + 1.0, car.position.z);
    this.updateSun();
  }

  private updatePlaying(dt: number): void {
    const car = this.car;
    const city = this.city;
    const fares = this.fares;
    const traffic = this.traffic;
    if (!car || !city || !fares || !traffic) return;

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
    }

    car.update(dt, input, this.allSolids);
    traffic.update(dt, city);
    this.handleNearMiss(car, traffic);

    const ev = fares.update(dt, car);
    this.handleFareEvent(ev);

    this.state.update(dt);

    // Drift: score + screech + smoke.
    const drifting = car.isDrifting && car.speed > 8;
    if (drifting) this.state.addDrift(dt);
    else this.state.endDrift();
    this.sfx.setScreech(drifting);
    if (drifting || car.isBoosting) this.emitDriftSmoke(dt, car);

    // Drift-release slingshot — the signature skill move — gets its own payoff.
    if (car.miniBoostFired) {
      this.sfx.boost();
      this.rig.addTrauma(0.18);
      this.hud.flash("#ffd147", 0.16);
      this.fx.burst(car.position.x, 0.6, car.position.z, 0.08, 8, 7);
      this.hud.showCombo("DRIFT BOOST!");
    }

    this.sfx.setEngine(Math.min(1, car.speed / CAR.boostSpeed), input.throttle, car.isBoosting);

    if (car.lastWallHit > CRASH_THRESHOLD) {
      const p = Math.min(1, (car.lastWallHit - CRASH_THRESHOLD) / 20);
      this.rig.addTrauma(0.35 + p * 0.5);
      this.hud.flash("#ffffff", 0.25 + p * 0.3);
      this.fx.burst(car.position.x, 1, car.position.z, 0.07, 10, 6 + p * 8);
      this.sfx.crash(car.lastWallHit);
      if (car.lastWallHit > 16) this.hitStop = 0.07; // hit-stop only on hard hits
    }

    // Announce the SF neighborhood as the taxi crosses into it.
    const dist = districtAt(city.gridX(car.position.x), city.gridZ(car.position.z));
    if (dist.name !== this.lastDistrict) {
      this.lastDistrict = dist.name;
      this.hud.showDistrict(dist.name);
    }

    this.rig.update(dt, car, city.solids);
    // Keep the camera above the terrain (hills can rise behind the car).
    const cam = this.rig.camera;
    const minY = city.terrain.heightAt(cam.position.x, cam.position.z) + 2.5;
    if (cam.position.y < minY) cam.position.y = minY;
    this.updateSun();
    this.updateHud(car, fares);

    if (this.state.timeLeft <= 10) {
      const sec = Math.ceil(this.state.timeLeft);
      if (sec !== this.lowBeepAt && sec > 0) {
        this.lowBeepAt = sec;
        this.sfx.beep();
      }
    }

    if (this.state.timedOut) this.endRun();
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
    this.fx.driftPuff(rx + px * 0.7, rz + pz * 0.7, car.isBoosting);
    this.fx.driftPuff(rx - px * 0.7, rz - pz * 0.7, car.isBoosting);
  }

  private handleFareEvent(ev: FareEvent): void {
    const car = this.car;
    if (ev.kind === "pickup") {
      this.sfx.pickup();
      this.fx.burst(ev.pos.x, 1.2, ev.pos.z, 0.5, 10, 5);
      this.hud.showCombo("GO GO GO!");
      if (car) car.addBoost(20);
    } else if (ev.kind === "dropoff") {
      const reward = this.state.dropoff(ev.tiles, ev.rideTime);
      this.sfx.dropoff(reward.combo);
      this.fx.burst(ev.pos.x, 1.2, ev.pos.z, 0.3, 26, 9);
      this.hud.flashTimeBonus(reward.timeBonus);
      this.hud.flash("#6bff8e", 0.22);
      this.rig.addTrauma(0.25);
      const tag =
        reward.combo > 1 ? `${reward.combo}× COMBO  +$${reward.gross}` : `+$${reward.gross}`;
      this.hud.showCombo(tag);
      if (car) car.addBoost(30);
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
        c.missCooldown = 1.4;
        const pts = this.state.nearMiss();
        car.addBoost(CAR.boostPerNearMiss);
        this.fx.burst(c.position.x, 1, c.position.z, 0.5, 6, 4);
        this.hud.showCombo(`NEAR MISS +${pts}`);
        this.sfx.nearMiss();
      }
    }
  }

  private updateSun(): void {
    const car = this.car;
    if (!car) return;
    this.sun.position.copy(car.position).add(SUN_OFFSET);
    this.sun.target.position.copy(car.position);
    this.sun.target.updateMatrixWorld();
  }

  private updateHud(car: Car, fares: FareManager): void {
    this.hud.setTimer(this.state.timeLeft, this.state.timeLeft <= 10);
    this.hud.setScore(this.state.displayScore);
    this.hud.setFares(this.state.fares);
    this.hud.setSpeed(car.speed * MPH_FACTOR);
    this.hud.setBoost(car.boostMeter / CAR.boostMax);

    const obj = fares.objective();
    if (!obj) {
      this.hud.hideFareCard();
      this.hud.setArrow(false, 0, 0, 0);
      return;
    }
    const dist = Math.hypot(car.position.x - obj.pos.x, car.position.z - obj.pos.z);
    if (obj.kind === "seek") this.hud.setFareCard("PICK UP FARE", dist, "NEW RIDE →");
    else {
      const reward = FARE.baseFare + FARE.farePerTile * obj.tiles;
      this.hud.setFareCard("DROP OFF →", dist, `FARE $${reward}+`);
    }
    this.projectArrow(obj.pos);
  }

  private projectArrow(target: THREE.Vector3): void {
    const ndc = target.clone().project(this.rig.camera);
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
    this.hud.setArrow(true, sx - 32, sy - 32, rot);
  }

  private endRun(): void {
    this.sfx.setScreech(false);
    this.sfx.setEngine(0, 0, false);
    this.sfx.gameOver();
    this.hud.hideFareCard();
    this.hud.setArrow(false, 0, 0, 0);
    this.mode = {
      kind: "gameover",
      score: this.state.displayScore,
      fares: this.state.fares,
    };
    this.hud.showBanner({
      title: "TIME'S UP!",
      sub: `You earned $${this.state.displayScore.toLocaleString("en-US")}`,
      stats: `${this.state.fares} fares delivered · best drift ${this.state.bestDrift.toFixed(1)}s`,
      cta: "PRESS ENTER TO RETRY",
    });
  }
}
