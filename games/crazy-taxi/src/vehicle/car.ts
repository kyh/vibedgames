import * as THREE from "three";

import type { ModelCache } from "../assets/loader";
import { modelUrl, PLAYER_CAR } from "../assets/manifest";
import { CAR, ROAD_Y } from "../shared/constants";
import type { Solid } from "../world/city";
import { slopeQuaternion } from "../world/terrain";

export type CarInput = {
  readonly throttle: number; // -1 brake/reverse, 0, +1 gas
  readonly steer: number; // -1 left .. +1 right
  readonly drift: boolean;
  readonly boost: boolean;
};

// What the car drives on: the terrain height field, possibly overridden by
// flat structures (pier decks). CityModel implements this.
export type Surface = {
  heightAt(x: number, z: number): number;
  normalInto(out: THREE.Vector3, x: number, z: number): THREE.Vector3;
};

// The Kenney car's body faces +Z, which matches our heading-0 forward (sin,cos),
// so no yaw offset is needed. (π here makes it drive rear-first.)
const MODEL_YAW_OFFSET = 0;
const COLLIDE_RADIUS = 1.05;
const WHEEL_RADIUS = 0.35;
const UP = new THREE.Vector3(0, 1, 0);
const X_AXIS = new THREE.Vector3(1, 0, 0);

export class Car {
  readonly object3D: THREE.Group;
  private body: THREE.Object3D;
  private wheels: { node: THREE.Object3D; front: boolean }[] = [];
  readonly position = new THREE.Vector3();
  private velocity = new THREE.Vector2(); // world XZ
  heading = 0; // yaw; forward = (sin, cos)
  boostMeter: number = CAR.boostMax;
  private driftSustain = 0; // seconds the current drift has lasted
  isDrifting = false;
  isBoosting = false;
  lastWallHit = 0; // impact speed of the last collision this frame (for fx)
  lastWallNormal = new THREE.Vector2(); // normal of the last wall contact
  wallContact = false; // touching a wall this frame (scrape detection)
  miniBoostFired = false; // true on the frame a charged drift is released
  boostDenied = false; // boost pressed with an empty meter (edge, one frame)
  private boostArmed = true; // hysteresis: off at 0.5, re-arms at 15
  private boostHeldPrev = false;
  // --- Airtime (hill jumps) ---
  airborne = false;
  airTime = 0; // seconds of the current/last flight
  justLanded = 0; // landing impact speed (v/s), one frame only
  private yVel = 0;
  private vyGround = 0; // vertical rate while following the ground
  // --- Feel exposures (fx / camera / audio read these) ---
  slip = 0; // signed angle between velocity and heading (radians)
  private roll = 0; // visual body lean
  private pitch = 0; // visual dive/squat
  private squash = 0; // landing suspension squash (1 = full)
  private steerSmoothed = 0; // ramped steering input
  private wheelSpin = 0;
  private surface: Surface | null = null;
  private scratchN = new THREE.Vector3();
  // Chassis attitude is slerped toward its target: smooths terrain-normal
  // jitter into suspension feel, and blends launches/landings.
  private targetQuat = new THREE.Quaternion();
  private pitchQuat = new THREE.Quaternion();

  constructor(cache: ModelCache) {
    this.object3D = new THREE.Group();
    // Hero scale: the taxi reads slightly larger than traffic so it owns the frame.
    this.object3D.scale.setScalar(1.12);
    this.body = cache.instance(modelUrl("cars", PLAYER_CAR));
    this.body.traverse((c) => {
      if (c.name.startsWith("wheel")) {
        this.wheels.push({ node: c, front: c.name.includes("front") });
      }
    });
    this.object3D.add(this.body);
  }

  setSurface(s: Surface): void {
    this.surface = s;
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
  get steer(): number {
    return this.steerSmoothed;
  }
  // 0..1 — how close the current drift is to arming the release boost.
  get driftCharge(): number {
    return Math.min(1, this.driftSustain / 0.5);
  }

  reset(x: number, z: number, yaw: number): void {
    this.position.set(x, ROAD_Y, z);
    this.velocity.set(0, 0);
    this.heading = yaw;
    this.boostMeter = CAR.boostMax;
    this.driftSustain = 0;
    this.isDrifting = false;
    this.isBoosting = false;
    this.airborne = false;
    this.airTime = 0;
    this.justLanded = 0;
    this.yVel = 0;
    this.vyGround = 0;
    this.slip = 0;
    this.roll = 0;
    this.pitch = 0;
    this.steerSmoothed = 0;
    if (this.surface) this.position.y = this.surface.heightAt(x, z) + ROAD_Y;
    this.syncTransform(1, true);
  }

  addBoost(amount: number): void {
    this.boostMeter = Math.min(CAR.boostMax, this.boostMeter + amount);
  }

  update(dt: number, input: CarInput, solids: readonly Solid[]): void {
    this.lastWallHit = 0;
    this.wallContact = false;
    this.miniBoostFired = false;
    this.justLanded = 0;
    this.boostDenied = false;
    const fwd = new THREE.Vector2(Math.sin(this.heading), Math.cos(this.heading));
    const perp = new THREE.Vector2(fwd.y, -fwd.x);

    let vForward = this.velocity.dot(fwd);
    const vLateral = this.velocity.dot(perp);

    // --- Longitudinal ---
    // Boost hysteresis: cut out when the meter empties and stay off until it
    // rebuilds — without this the trickle refill flaps boost on/off at ~15Hz.
    if (this.boostMeter <= 0.5) this.boostArmed = false;
    else if (this.boostMeter >= 15) this.boostArmed = true;
    const boostHeld = input.boost && input.throttle > 0;
    const wantBoost = boostHeld && this.boostArmed;
    // Denied feedback fires once per press, not once per frame.
    this.boostDenied = boostHeld && !this.boostArmed && !this.boostHeldPrev;
    this.boostHeldPrev = boostHeld;
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

    // Slope gravity — crawl up SF hills, plunge down them (not while flying).
    if (this.surface && !this.airborne) {
      const n = this.surface.normalInto(this.scratchN, this.position.x, this.position.z);
      const ny = Math.max(n.y, 0.05);
      const slope = (-n.x / ny) * Math.sin(this.heading) + (-n.z / ny) * Math.cos(this.heading);
      vForward -= CAR.slopeGravity * slope * dt;
      vForward = THREE.MathUtils.clamp(vForward, -CAR.reverseMax * 1.5, topSpeed * 1.35);
    }

    if (wantBoost) this.boostMeter = Math.max(0, this.boostMeter - CAR.boostDrain * dt);
    else this.boostMeter = Math.min(CAR.boostMax, this.boostMeter + CAR.boostRefill * dt);

    // --- Steering ---
    const absF = Math.abs(vForward);
    // Slip: how far the velocity vector points away from the nose. Drifting
    // "counts" (score, smoke, screech, charge) only with real slip — holding
    // the button on a straight is just a low-grip setting, not a drift.
    const va = this.velAngle;
    this.slip =
      va === null ? 0 : ((va - this.heading + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
    const physicsDrift = input.drift && absF > CAR.driftMinSpeed && !this.airborne;
    this.isDrifting =
      physicsDrift && (Math.abs(this.slip) > CAR.driftMinSlip || Math.abs(this.steerSmoothed) > 0.35);
    const speedFrac = THREE.MathUtils.clamp(absF / CAR.maxSpeed, 0, 1);
    let authority = THREE.MathUtils.lerp(1, CAR.turnSpeedFalloff, speedFrac);
    if (this.airborne) authority *= CAR.airSteerFactor;
    const startFade = THREE.MathUtils.clamp(absF / 3, 0, 1); // no spin-in-place
    const driftMul = physicsDrift ? CAR.driftTurnBoost : 1;
    const dir = vForward >= 0 ? 1 : -1;
    this.steerSmoothed += (input.steer - this.steerSmoothed) * Math.min(1, dt / CAR.steerRamp);
    // Subtract: with the chase cam looking along +forward, increasing heading
    // veers screen-left, so steer-right (+1) must decrease heading.
    this.heading -= this.steerSmoothed * CAR.turnRate * authority * startFade * driftMul * dir * dt;

    if (this.isDrifting) this.driftSustain += dt;
    else if (!physicsDrift) {
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
    const grip = this.airborne ? 0.4 : physicsDrift ? CAR.gripDrift : CAR.gripNormal;
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

    // --- Vertical: follow the ground until it falls away faster than gravity
    // could pull us — then go ballistic and fly the hill crest. ---
    if (this.surface) {
      const g = this.surface.heightAt(this.position.x, this.position.z) + ROAD_Y;
      if (this.airborne) {
        this.yVel -= CAR.gravity * dt;
        this.position.y += this.yVel * dt;
        this.airTime += dt;
        if (this.position.y <= g) {
          this.justLanded = Math.max(0, -this.yVel);
          this.squash = Math.min(1, 0.45 + this.justLanded * 0.035);
          this.position.y = g;
          this.airborne = false;
          this.yVel = 0;
          this.vyGround = 0;
        }
      } else {
        const prevY = this.position.y;
        const safeDt = Math.max(dt, 1e-4);
        const vyNeeded = (g - prevY) / safeDt; // rate the ground demands this frame
        const groundAccel = (vyNeeded - this.vyGround) / safeDt;
        // Launch when following the ground would need us to accelerate downward
        // harder than gravity can pull (crest falling away under the wheels).
        if (groundAccel < -(CAR.gravity + 8) && this.speed > CAR.minAirSpeed) {
          this.airborne = true;
          this.airTime = 0;
          // Cap the launch pop — a steep crest at boost speed shouldn't put
          // the taxi into orbit.
          this.yVel = Math.min(this.vyGround, CAR.maxLaunchVy) - CAR.gravity * dt;
          this.position.y = Math.max(g, prevY + this.yVel * dt);
        } else {
          this.position.y = g;
          this.vyGround = THREE.MathUtils.clamp(vyNeeded, -40, 40);
        }
      }
    }

    // --- Visual lean (roll into turns, dive under braking, squat on throttle) ---
    const targetRoll = -input.steer * speedFrac * (physicsDrift ? 0.34 : 0.18);
    this.roll += (targetRoll - this.roll) * Math.min(1, dt * 10);
    const targetPitch = input.throttle < 0 && vForward > 1 ? 0.05 : input.throttle > 0 ? -0.025 : 0;
    this.pitch += (targetPitch - this.pitch) * Math.min(1, dt * 8);
    this.squash = Math.max(0, this.squash - dt * 5.5); // springs back ~180ms

    // --- Wheels: spin with speed, fronts steer ---
    this.wheelSpin += (vForward / WHEEL_RADIUS) * dt;
    for (const w of this.wheels) {
      w.node.rotation.x = this.wheelSpin;
      if (w.front) w.node.rotation.y = this.steerSmoothed * -0.42;
    }

    this.syncTransform(dt);
  }

  private resolveCollisions(solids: readonly Solid[]): void {
    for (const s of solids) {
      // Airborne taxis fly clean over height-capped obstacles (traffic).
      if (s.maxY !== undefined && this.position.y > s.maxY) continue;
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
      this.wallContact = true;
      this.lastWallNormal.set(nx, nz);
      const vn = this.velocity.x * nx + this.velocity.y * nz;
      if (vn < 0) {
        const impact = -vn;
        if (impact > this.lastWallHit) this.lastWallHit = impact;
        this.velocity.x -= (1 + CAR.bounce) * vn * nx;
        this.velocity.y -= (1 + CAR.bounce) * vn * nz;
      }
    }
  }

  // `snap = true` (resets) copies the target attitude instead of blending.
  private syncTransform(dt: number, snap = false): void {
    if (this.surface && !this.airborne) {
      const n = this.surface.normalInto(this.scratchN, this.position.x, this.position.z);
      slopeQuaternion(this.targetQuat, this.heading + MODEL_YAW_OFFSET, n);
    } else if (this.airborne) {
      // The nose follows the flight arc: up off the crest, down as it falls.
      slopeQuaternion(this.targetQuat, this.heading + MODEL_YAW_OFFSET, UP);
      const arc = THREE.MathUtils.clamp(
        Math.atan2(-this.yVel, Math.max(this.speed, 8)),
        -0.5,
        0.6,
      );
      this.pitchQuat.setFromAxisAngle(X_AXIS, arc);
      this.targetQuat.multiply(this.pitchQuat);
    } else {
      slopeQuaternion(this.targetQuat, this.heading + MODEL_YAW_OFFSET, UP);
    }
    // Slerp instead of snapping — terrain-normal jitter becomes suspension
    // travel; launches and landings blend instead of popping.
    if (snap) this.object3D.quaternion.copy(this.targetQuat);
    else {
      const rate = this.airborne ? 6 : 13;
      this.object3D.quaternion.slerp(this.targetQuat, Math.min(1, dt * rate));
    }
    this.object3D.position.copy(this.position);
    this.body.rotation.z = this.roll;
    this.body.rotation.x = this.pitch;
    // Landing squash: volume-conserving squish that springs back.
    const sq = this.squash;
    this.body.scale.set(1 + 0.12 * sq, 1 - 0.26 * sq, 1 + 0.12 * sq);
  }
}
