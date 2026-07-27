import * as THREE from "three";

import { CAMERA, CAR } from "../shared/constants";
import type { Car } from "../vehicle/car";
import type { CeilingIndex, SolidIndex } from "../world/solid-index";

function lerpAngle(a: number, b: number, t: number): number {
  let d = ((b - a + Math.PI) % (Math.PI * 2)) - Math.PI;
  if (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}

export class ChaseCamera {
  readonly camera: THREE.PerspectiveCamera;
  private camYaw = 0;
  private look = new THREE.Vector3();
  private shake = 0;
  private shakeT = 0; // summed-sine phase (framerate-independent shake)
  private shakeOff = new THREE.Vector3();
  // Overhead structure the clip march found this frame (world y of the lowest
  // soffit over the car), and the eased cap the camera is actually held under.
  // Null index = the harvest has not landed yet; the rig runs uncapped.
  private ceilings: CeilingIndex | null = null;
  private ceilY = Infinity;
  private ceilCap = Infinity;
  // Per-frame scratch — update() runs hot, never allocate in it.
  private scrFwd = new THREE.Vector2();
  private scrPerp = new THREE.Vector2();
  private scrDesired = new THREE.Vector3();
  private scrLook = new THREE.Vector3();

  constructor(aspect: number) {
    // near 0.3 (not 0.1): the chase cam never gets closer than ~2u to any
    // surface (avoidClip + minHeight), and tripling near triples depth-buffer
    // precision everywhere — the draped road layers stop shimmering at the
    // far end of long straights.
    this.camera = new THREE.PerspectiveCamera(CAMERA.fov, aspect, 0.3, 2000);
  }

  resize(aspect: number): void {
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }

  addTrauma(amount: number): void {
    this.shake = Math.min(1, this.shake + amount);
  }

  /** Overhead structure to keep the camera under; arrives once the world has. */
  setCeilings(ceilings: CeilingIndex): void {
    this.ceilings = ceilings;
  }

  snapTo(car: Car): void {
    this.camYaw = car.heading;
    const fwd = new THREE.Vector2(Math.sin(this.camYaw), Math.cos(this.camYaw));
    const x = car.position.x - fwd.x * CAMERA.distance;
    const z = car.position.z - fwd.y * CAMERA.distance;
    // Snapping is a cut, so the cap lands at its target instead of easing in —
    // otherwise a respawn under a viaduct starts the run inside the deck.
    const soffit = this.ceilingOver(x, z, car.position.y);
    this.ceilY = soffit;
    this.ceilCap = this.capFor(soffit, car.position.y, car.position.y + CAMERA.height);
    this.camera.position.set(x, Math.min(car.position.y + CAMERA.height, this.ceilCap), z);
    this.look.set(car.position.x, car.position.y + CAMERA.lookHeight, car.position.z);
    this.camera.lookAt(this.look);
  }

  /** Lowest soffit over (x, z) that the car is genuinely underneath. */
  private ceilingOver(x: number, z: number, carY: number): number {
    if (!this.ceilings) return Infinity;
    return this.ceilings.ceilingAt(x, z, carY + CAMERA.ceilingProbe);
  }

  /**
   * World y the camera may not exceed. Under open sky it parks just above
   * wherever the camera already is, so the ease has a short constant distance
   * to travel in both directions instead of chasing infinity.
   */
  private capFor(soffit: number, carY: number, camY: number): number {
    const open = camY + CAMERA.ceilingRelease;
    if (soffit === Infinity) return open;
    return Math.min(open, Math.max(carY + CAMERA.ceilingFloor, soffit - CAMERA.ceilingClear));
  }

  update(dt: number, car: Car, solids: SolidIndex): void {
    // Drift swing: bias the follow yaw toward the velocity direction during a
    // slide so the camera lags to the outside and you see the taxi's flank.
    // Forward motion only: in reverse the velocity opposes the heading, so
    // slip saturates at ±π and its SIGN flips with every wiggle — unfenced it
    // judders the camera between the two swing extremes (and rocks the
    // horizon via driftRoll below).
    const movingForward = car.forwardSpeed > 0.5;
    let targetYaw = car.heading;
    const slip = THREE.MathUtils.clamp(car.slip, -CAMERA.driftSwing, CAMERA.driftSwing);
    const vh = car.velAngle;
    if (vh !== null && movingForward) targetYaw = car.heading + slip;
    this.camYaw = lerpAngle(this.camYaw, targetYaw, Math.min(1, CAMERA.yawLerp * dt));
    const fwd = this.scrFwd.set(Math.sin(this.camYaw), Math.cos(this.camYaw));
    const perp = this.scrPerp.set(fwd.y, -fwd.x);

    // Speed crouch: at full tilt the camera drops lower and hangs farther back —
    // a lower horizon reads faster.
    const speedFrac = THREE.MathUtils.clamp(car.speed / CAR.maxSpeed, 0, 1);
    const height = THREE.MathUtils.lerp(CAMERA.height, CAMERA.height - 1.1, speedFrac);
    const distance = THREE.MathUtils.lerp(CAMERA.distance, CAMERA.distance + 1.5, speedFrac);

    const desired = this.scrDesired.set(
      car.position.x - fwd.x * distance,
      car.position.y + height,
      car.position.z - fwd.y * distance,
    );
    this.avoidClip(car.position, desired, solids);
    this.camera.position.lerp(desired, Math.min(1, CAMERA.posLerp * dt));

    // Look ahead along the camera yaw, biased into the corner being steered.
    const la = CAMERA.lookAhead + CAMERA.lookAheadSpeed * speedFrac;
    const steerBias = car.steer * -4.5;
    const lookTarget = this.scrLook.set(
      car.position.x + fwd.x * la + perp.x * steerBias,
      car.position.y + CAMERA.lookHeight,
      car.position.z + fwd.y * la + perp.y * steerBias,
    );
    this.look.lerp(lookTarget, Math.min(1, CAMERA.aimLerp * dt));

    // Trauma shake: summed sines (framerate-independent), quadratic falloff.
    this.shake = Math.max(0, this.shake - dt * 1.7);
    this.shakeT += dt;
    const s = this.shake * this.shake;
    const t = this.shakeT;
    this.shakeOff.set(
      (Math.sin(t * 31) + Math.sin(t * 57) * 0.6) * s * 0.5,
      (Math.sin(t * 43) + Math.sin(t * 71) * 0.6) * s * 0.35,
      (Math.sin(t * 37) + Math.sin(t * 61) * 0.6) * s * 0.5,
    );
    this.camera.position.add(this.shakeOff);

    // Overhead clamp, applied to the FINAL position rather than to `desired`:
    // posLerp is a ~0.2s follow, far too slow to get out of a soffit the car
    // has already passed under. The ease lives in the cap itself instead.
    const cap = this.capFor(this.ceilY, car.position.y, this.camera.position.y);
    if (!Number.isFinite(this.ceilCap)) this.ceilCap = cap; // first frame of a fresh rig
    const rate = cap < this.ceilCap ? CAMERA.ceilingDuckRate : CAMERA.ceilingRiseRate;
    this.ceilCap += (cap - this.ceilCap) * Math.min(1, rate * dt);
    if (this.camera.position.y > this.ceilCap) this.camera.position.y = this.ceilCap;

    this.camera.lookAt(this.look);

    // Roll AFTER lookAt (which re-levels the camera): drift tilts the horizon,
    // trauma adds a rotational jitter — this is what makes shake feel physical.
    const rollShake = (Math.sin(t * 47) + Math.sin(t * 89) * 0.5) * 0.035 * s;
    const driftRoll = movingForward ? THREE.MathUtils.clamp(car.slip, -1, 1) * 0.045 : 0;
    this.camera.rotateZ(rollShake + driftRoll);

    // Speed FOV: kick wide fast, recover slow — boost hits like a gear change.
    const frac = THREE.MathUtils.clamp(car.speed / CAR.boostSpeed, 0, 1);
    const targetFov =
      THREE.MathUtils.lerp(CAMERA.fov, CAMERA.fovBoost, frac) + (car.isBoosting ? 4 : 0);
    const fovRate = targetFov > this.camera.fov ? 10 : 3;
    this.camera.fov += (targetFov - this.camera.fov) * Math.min(1, dt * fovRate);
    this.camera.updateProjectionMatrix();
  }

  // March from the car to the desired camera spot; if the line crosses a
  // building footprint, pull the camera in so it never buries into a facade.
  // The same march reads the ceiling index — one walk, two answers, and taking
  // the MINIMUM soffit over the whole segment is what buys the transition: the
  // car enters a viaduct's shadow ~0.4s before the camera trailing it does, so
  // the duck is always finished by the time the camera arrives.
  private avoidClip(carPos: THREE.Vector3, desired: THREE.Vector3, solids: SolidIndex): void {
    const dx = desired.x - carPos.x;
    const dy = desired.y - carPos.y;
    const dz = desired.z - carPos.z;
    const steps = 12;
    let t = 1;
    let soffit = this.ceilingOver(carPos.x, carPos.z, carPos.y);
    for (let i = 1; i <= steps; i++) {
      const f = i / steps;
      const px = carPos.x + dx * f;
      const pz = carPos.z + dz * f;
      if (solids.hitAt(px, pz)) {
        t = Math.max(0.28, (i - 1) / steps);
        break;
      }
      const c = this.ceilingOver(px, pz, carPos.y);
      if (c < soffit) soffit = c;
    }
    this.ceilY = soffit;
    desired.set(
      carPos.x + dx * t,
      Math.max(CAMERA.minHeight, carPos.y + dy * t),
      carPos.z + dz * t,
    );
  }
}
