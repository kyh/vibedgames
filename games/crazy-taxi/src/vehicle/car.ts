import * as THREE from "three";

import type { ModelCache } from "../assets/loader";
import { modelUrl, PLAYER_CAR } from "../assets/manifest";
import { CAR, ROAD_Y } from "../shared/constants";
import type { Solid } from "../world/city";
import type { Terrain } from "../world/terrain";

const UP = new THREE.Vector3(0, 1, 0);

export type CarInput = {
  readonly throttle: number; // -1 brake/reverse, 0, +1 gas
  readonly steer: number; // -1 left .. +1 right
  readonly drift: boolean;
  readonly boost: boolean;
};

// The Kenney car's body faces +Z, which matches our heading-0 forward (sin,cos),
// so no yaw offset is needed. (π here makes it drive rear-first.)
const MODEL_YAW_OFFSET = 0;
const COLLIDE_RADIUS = 1.05;

export class Car {
  readonly object3D: THREE.Group;
  private body: THREE.Object3D;
  readonly position = new THREE.Vector3();
  private velocity = new THREE.Vector2(); // world XZ
  heading = 0; // yaw; forward = (sin, cos)
  boostMeter: number = CAR.boostMax;
  private driftSustain = 0; // seconds the current drift has lasted
  isDrifting = false;
  isBoosting = false;
  lastWallHit = 0; // impact speed of the last collision this frame (for fx)
  miniBoostFired = false; // true on the frame a charged drift is released
  private roll = 0; // visual body lean
  private pitch = 0; // visual dive/squat
  private steerSmoothed = 0; // ramped steering input
  private terrain: Terrain | null = null;
  private scratchN = new THREE.Vector3();
  private tiltQ = new THREE.Quaternion();
  private yawQ = new THREE.Quaternion();

  constructor(cache: ModelCache) {
    this.object3D = new THREE.Group();
    this.body = cache.instance(modelUrl("cars", PLAYER_CAR));
    this.object3D.add(this.body);
  }

  setTerrain(t: Terrain): void {
    this.terrain = t;
  }

  get speed(): number {
    return this.velocity.length();
  }
  get forwardSpeed(): number {
    return this.velocity.x * Math.sin(this.heading) + this.velocity.y * Math.cos(this.heading);
  }
  // Heading of the velocity vector (for the drift-swing camera); null when slow.
  get velAngle(): number | null {
    return this.speed > 0.5 ? Math.atan2(this.velocity.x, this.velocity.y) : null;
  }

  reset(x: number, z: number, yaw: number): void {
    this.position.set(x, ROAD_Y, z);
    this.velocity.set(0, 0);
    this.heading = yaw;
    this.boostMeter = CAR.boostMax;
    this.driftSustain = 0;
    this.isDrifting = false;
    this.isBoosting = false;
    this.roll = 0;
    this.pitch = 0;
    this.steerSmoothed = 0;
    this.syncTransform();
  }

  addBoost(amount: number): void {
    this.boostMeter = Math.min(CAR.boostMax, this.boostMeter + amount);
  }

  update(dt: number, input: CarInput, solids: readonly Solid[]): void {
    this.lastWallHit = 0;
    this.miniBoostFired = false;
    const fwd = new THREE.Vector2(Math.sin(this.heading), Math.cos(this.heading));
    const perp = new THREE.Vector2(fwd.y, -fwd.x);

    let vForward = this.velocity.dot(fwd);
    const vLateral = this.velocity.dot(perp);

    // --- Longitudinal ---
    const wantBoost = input.boost && this.boostMeter > 1 && input.throttle > 0;
    this.isBoosting = wantBoost;
    const topSpeed = wantBoost ? CAR.boostSpeed : CAR.maxSpeed;
    if (input.throttle > 0) {
      vForward += CAR.accel * dt;
    } else if (input.throttle < 0) {
      if (vForward > 0.5) vForward -= CAR.brakeDecel * dt;
      else vForward = Math.max(vForward - CAR.reverseAccel * dt, -CAR.reverseMax);
    } else {
      const drop = CAR.coastDecel * dt;
      vForward = vForward > 0 ? Math.max(0, vForward - drop) : Math.min(0, vForward + drop);
    }
    vForward = THREE.MathUtils.clamp(vForward, -CAR.reverseMax, topSpeed);

    // Slope gravity — crawl up SF hills, plunge down them (can overspeed downhill).
    if (this.terrain) {
      const n = this.terrain.normalInto(this.scratchN, this.position.x, this.position.z);
      const ny = Math.max(n.y, 0.05);
      const slope = (-n.x / ny) * Math.sin(this.heading) + (-n.z / ny) * Math.cos(this.heading);
      vForward -= CAR.slopeGravity * slope * dt;
      vForward = THREE.MathUtils.clamp(vForward, -CAR.reverseMax * 1.5, topSpeed * 1.35);
    }

    if (wantBoost) this.boostMeter = Math.max(0, this.boostMeter - CAR.boostDrain * dt);
    else this.boostMeter = Math.min(CAR.boostMax, this.boostMeter + CAR.boostRefill * dt);

    // --- Steering ---
    const absF = Math.abs(vForward);
    const canDrift = input.drift && absF > CAR.driftMinSpeed;
    this.isDrifting = canDrift;
    const speedFrac = THREE.MathUtils.clamp(absF / CAR.maxSpeed, 0, 1);
    const authority = THREE.MathUtils.lerp(1, CAR.turnSpeedFalloff, speedFrac);
    const startFade = THREE.MathUtils.clamp(absF / 3, 0, 1); // no spin-in-place
    const driftMul = canDrift ? CAR.driftTurnBoost : 1;
    const dir = vForward >= 0 ? 1 : -1;
    this.steerSmoothed += (input.steer - this.steerSmoothed) * Math.min(1, dt / CAR.steerRamp);
    // Subtract: with the chase cam looking along +forward, increasing heading
    // veers screen-left, so steer-right (+1) must decrease heading.
    this.heading -= this.steerSmoothed * CAR.turnRate * authority * startFade * driftMul * dir * dt;

    if (canDrift) this.driftSustain += dt;
    else {
      if (this.driftSustain > 0.5) {
        this.addBoost(CAR.boostPerDrift);
        vForward = Math.min(topSpeed, vForward + CAR.miniBoostImpulse); // slingshot out of a drift
        this.miniBoostFired = true;
      }
      this.driftSustain = 0;
    }

    // --- Reassemble velocity; low grip while drifting keeps the slide ---
    const nf = new THREE.Vector2(Math.sin(this.heading), Math.cos(this.heading));
    const np = new THREE.Vector2(nf.y, -nf.x);
    const grip = canDrift ? CAR.gripDrift : CAR.gripNormal;
    const latRetain = Math.exp(-grip * dt);
    this.velocity
      .copy(nf)
      .multiplyScalar(vForward)
      .addScaledVector(np, vLateral * latRetain);

    // --- Integrate + collide, sub-stepped so high speed can't tunnel walls ---
    let remaining = dt;
    while (remaining > 1e-5) {
      const sp = this.velocity.length();
      const stepDt = sp > 1e-4 ? Math.min(remaining, 0.5 / sp) : remaining;
      this.position.x += this.velocity.x * stepDt;
      this.position.z += this.velocity.y * stepDt;
      this.resolveCollisions(solids);
      remaining -= stepDt;
    }

    // --- Visual lean (roll into turns, dive under braking, squat on throttle) ---
    const targetRoll = -input.steer * speedFrac * (canDrift ? 0.34 : 0.18);
    this.roll += (targetRoll - this.roll) * Math.min(1, dt * 10);
    const targetPitch = input.throttle < 0 && vForward > 1 ? 0.05 : input.throttle > 0 ? -0.025 : 0;
    this.pitch += (targetPitch - this.pitch) * Math.min(1, dt * 8);
    this.syncTransform();
  }

  private resolveCollisions(solids: readonly Solid[]): void {
    for (const s of solids) {
      const cx = THREE.MathUtils.clamp(this.position.x, s.minX, s.maxX);
      const cz = THREE.MathUtils.clamp(this.position.z, s.minZ, s.maxZ);
      const dx = this.position.x - cx;
      const dz = this.position.z - cz;
      const d2 = dx * dx + dz * dz;
      if (d2 >= COLLIDE_RADIUS * COLLIDE_RADIUS) continue;

      let nx: number;
      let nz: number;
      let pen: number;
      if (d2 > 1e-6) {
        const d = Math.sqrt(d2);
        nx = dx / d;
        nz = dz / d;
        pen = COLLIDE_RADIUS - d;
      } else {
        // Center inside the box — push out along the nearest face.
        const toLeft = this.position.x - s.minX;
        const toRight = s.maxX - this.position.x;
        const toTop = this.position.z - s.minZ;
        const toBot = s.maxZ - this.position.z;
        const m = Math.min(toLeft, toRight, toTop, toBot);
        if (m === toLeft) {
          nx = -1;
          nz = 0;
        } else if (m === toRight) {
          nx = 1;
          nz = 0;
        } else if (m === toTop) {
          nx = 0;
          nz = -1;
        } else {
          nx = 0;
          nz = 1;
        }
        pen = COLLIDE_RADIUS + m;
      }

      this.position.x += nx * pen;
      this.position.z += nz * pen;
      const vn = this.velocity.x * nx + this.velocity.y * nz;
      if (vn < 0) {
        const impact = -vn;
        if (impact > this.lastWallHit) this.lastWallHit = impact;
        this.velocity.x -= (1 + CAR.bounce) * vn * nx;
        this.velocity.y -= (1 + CAR.bounce) * vn * nz;
      }
    }
  }

  private syncTransform(): void {
    if (this.terrain) {
      this.position.y = this.terrain.heightAt(this.position.x, this.position.z) + ROAD_Y;
      const n = this.terrain.normalInto(this.scratchN, this.position.x, this.position.z);
      const tilt = this.tiltQ.setFromUnitVectors(UP, n);
      const spin = this.yawQ.setFromAxisAngle(n, this.heading + MODEL_YAW_OFFSET);
      this.object3D.quaternion.copy(spin).multiply(tilt);
      this.object3D.position.copy(this.position);
    } else {
      this.object3D.position.copy(this.position);
      this.object3D.rotation.y = this.heading + MODEL_YAW_OFFSET;
    }
    this.body.rotation.z = this.roll;
    this.body.rotation.x = this.pitch;
  }
}
