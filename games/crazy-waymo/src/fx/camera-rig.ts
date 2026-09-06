import * as THREE from "three";

import { CAMERA, CAR } from "../shared/constants";
import type { Car } from "../vehicle/car";
import type { CeilingIndex, SolidIndex } from "../world/solid-index";

/** Follow inputs only; the rig does not own or step the vehicle. */
type ChaseTarget = Pick<
  Car,
  "heading" | "position" | "forwardSpeed" | "slip" | "velAngle" | "speed" | "steer" | "isBoosting"
>;

function lerpAngle(a: number, b: number, t: number): number {
  let d = ((b - a + Math.PI) % (Math.PI * 2)) - Math.PI;
  if (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}

/** The aspect CAMERA.fov was framed for. Wider than this keeps the authored
 *  vertical angle; narrower gets the Hor+ treatment below. */
const DESIGN_ASPECT = 16 / 9;
/** Ceiling on the widened vertical angle. A portrait phone would otherwise
 *  solve past 130°, which fisheyes the hood and stretches the kerbs. */
const MAX_VERTICAL_FOV = 96;
// Clears the near plane and a small amount of camera shake on steep streets.
const GROUND_CLEARANCE = 0.65;
// Terrain can raise the eye far above the authored boom. Reclaim some of that
// distance horizontally before accepting a small taxi in an aerial frame.
const MIN_HILL_BOOM = 8.5;

/**
 * Hor+ framing. THREE's `fov` is the VERTICAL angle, so holding it fixed makes
 * a portrait phone see roughly a third of the lateral view a 16:9 screen does
 * — cross traffic arrives with no warning and a speech bubble sized for
 * desktop spills off both edges. Solve the vertical angle back from the
 * horizontal one the design aspect gets instead.
 */
function verticalFovFor(designFov: number, aspect: number): number {
  if (aspect >= DESIGN_ASPECT) return designFov;
  const halfH = Math.tan(THREE.MathUtils.degToRad(designFov) / 2) * DESIGN_ASPECT;
  return Math.min(MAX_VERTICAL_FOV, THREE.MathUtils.radToDeg(2 * Math.atan(halfH / aspect)));
}

export class ChaseCamera {
  readonly camera: THREE.PerspectiveCamera;
  /** The 16:9 vertical angle the speed-FOV ease works in — the camera's own
   *  `fov` is this run through verticalFovFor and is not a valid input. */
  private designFov = CAMERA.fov;
  private camYaw = 0;
  private look = new THREE.Vector3();
  private shake = 0;
  private shakeT = 0; // summed-sine phase (framerate-independent shake)
  private shakeOff = new THREE.Vector3();
  // Overhead structure the clip march found this frame (world y of the lowest
  // soffit over the car), and the eased cap the camera is actually held under.
  // Null index = the harvest has not landed yet; the rig runs uncapped.
  private ceilings: CeilingIndex | null = null;
  private groundAt: ((x: number, z: number, referenceY: number) => number) | null = null;
  private ceilY = Infinity;
  private ceilCap = Infinity;
  // Per-frame scratch — update() runs hot, never allocate in it.
  private scrFwd = new THREE.Vector2();
  private scrPerp = new THREE.Vector2();
  private scrDesired = new THREE.Vector3();
  private scrLook = new THREE.Vector3();

  constructor(aspect: number) {
    // The 0.3 near plane stays within the terrain/soffit clearance and gives
    // the draped road layers enough depth precision on long straights.
    this.camera = new THREE.PerspectiveCamera(
      verticalFovFor(CAMERA.fov, aspect),
      aspect,
      0.3,
      2000,
    );
  }

  resize(aspect: number): void {
    this.camera.aspect = aspect;
    this.camera.fov = verticalFovFor(this.designFov, aspect);
    this.camera.updateProjectionMatrix();
  }

  addTrauma(amount: number): void {
    this.shake = Math.min(1, this.shake + amount);
  }

  /** Overhead structure to keep the camera under; arrives once the world has. */
  setCeilings(ceilings: CeilingIndex): void {
    this.ceilings = ceilings;
  }

  /** Same road/terrain surface the vehicle follows, including hillside terraces. */
  setGround(groundAt: (x: number, z: number, referenceY: number) => number): void {
    this.groundAt = groundAt;
  }

  snapTo(car: Pick<Car, "heading" | "position">): void {
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
    this.clearGround(car.position.y);
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

  update(dt: number, car: ChaseTarget, solids: SolidIndex): void {
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
    const authoredDistance = Math.hypot(distance, height);
    for (let attempt = 0; attempt < 3; attempt++) {
      const dx = desired.x - car.position.x;
      const dz = desired.z - car.position.z;
      const rise = desired.y - car.position.y;
      const horizontal = Math.hypot(dx, dz);
      const stretch = Math.hypot(horizontal, rise) / authoredDistance;
      if (rise <= height + 0.1 || horizontal <= MIN_HILL_BOOM || stretch <= 1.03) break;
      const shorter = Math.max(MIN_HILL_BOOM, horizontal / stretch);
      desired.set(
        car.position.x + (dx * shorter) / horizontal,
        car.position.y + height,
        car.position.z + (dz * shorter) / horizontal,
      );
      // Re-test the complete shorter sightline, including soffits. Shortening
      // the original lifted vector alone can put its midpoint inside a crest.
      this.avoidClip(car.position, desired, solids);
    }
    this.camera.position.lerp(desired, Math.min(1, CAMERA.posLerp * dt));

    // Look ahead along the camera yaw, biased into the corner being steered.
    // A lifted, shorter boom looking the original 12u ahead pushes the taxi
    // below a phone's bottom edge. Bring the aim nearer by the same proportion;
    // reading the eased eye (not the target) preserves a continuous transition.
    const eyeRise = this.camera.position.y - car.position.y;
    const eyeRun = Math.hypot(
      this.camera.position.x - car.position.x,
      this.camera.position.z - car.position.z,
    );
    const hillAim = THREE.MathUtils.lerp(
      1,
      THREE.MathUtils.clamp((height * eyeRun) / (Math.max(height, eyeRise) * distance), 0.25, 1),
      THREE.MathUtils.smoothstep(eyeRise - height, 0, 1),
    );
    const la = (CAMERA.lookAhead + CAMERA.lookAheadSpeed * speedFrac) * hillAim;
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
    // Follow lag and trauma are applied after avoidClip. The final position
    // needs the same floor guarantee or a downhill cut puts the near plane
    // inside the hill even while the desired position is clear.
    this.clearGround(car.position.y);

    this.camera.lookAt(this.look);

    // Roll AFTER lookAt (which re-levels the camera): drift tilts the horizon,
    // trauma adds a rotational jitter — this is what makes shake feel physical.
    const rollShake = (Math.sin(t * 47) + Math.sin(t * 89) * 0.5) * 0.035 * s;
    const driftRoll = movingForward ? THREE.MathUtils.clamp(car.slip, -1, 1) * 0.045 : 0;
    this.camera.rotateZ(rollShake + driftRoll);

    // Speed FOV: kick wide fast, recover slow — boost hits like a gear change.
    // Eased in DESIGN space so the rush reads the same on every aspect; the
    // Hor+ solve is applied on the way to the camera.
    const frac = THREE.MathUtils.clamp(car.speed / CAR.boostSpeed, 0, 1);
    const targetFov =
      THREE.MathUtils.lerp(CAMERA.fov, CAMERA.fovBoost, frac) + (car.isBoosting ? 4 : 0);
    const fovRate = targetFov > this.designFov ? 10 : 3;
    this.designFov += (targetFov - this.designFov) * Math.min(1, dt * fovRate);
    this.camera.fov = verticalFovFor(this.designFov, this.camera.aspect);
    this.camera.updateProjectionMatrix();
  }

  private clearGround(carY: number): void {
    const p = this.camera.position;
    const floor = this.groundAt?.(p.x, p.z, Math.max(carY, p.y));
    if (floor === undefined || !Number.isFinite(floor)) return;
    // A reported deck above the current overhead cap is a ceiling, not the
    // road beneath this camera. Keep the existing underpass constraint.
    if (floor >= this.ceilY) return;
    const ceiling = this.ceilY === Infinity ? Infinity : this.ceilCap;
    p.y = Math.max(p.y, Math.min(floor + GROUND_CLEARANCE, ceiling));
  }

  // March from the car to the desired camera spot; if the line crosses a
  // building footprint, pull the camera in so it never buries into a facade.
  // The same march reads the ceiling index — one walk, two answers, and taking
  // the MINIMUM soffit over the whole segment is what buys the transition: the
  // car enters a viaduct's shadow ~0.4s before the camera trailing it does, so
  // the duck is always finished by the time the camera arrives.
  private avoidClip(carPos: THREE.Vector3, desired: THREE.Vector3, solids: SolidIndex): void {
    const dx = desired.x - carPos.x;
    // See the body, not the wheel contact point. A ray from the asphalt
    // falsely demands a steep lift at its first sample; under a low soffit
    // that lift is impossible and retracts the camera into the taxi's roof.
    const originY = carPos.y + CAMERA.lookHeight;
    let endY = desired.y;
    const dz = desired.z - carPos.z;
    const steps = 12;
    let t = 1;
    let soffit = this.ceilingOver(carPos.x, carPos.z, carPos.y);
    for (let i = 1; i <= steps; i++) {
      const f = i / steps;
      const px = carPos.x + dx * f;
      const pz = carPos.z + dz * f;
      const rayY = originY + (endY - originY) * f;
      if (solids.hitAt(px, pz, rayY)) {
        t = Math.max(0.28, (i - 1) / steps);
        break;
      }
      const c = this.ceilingOver(px, pz, carPos.y);
      if (c < soffit) soffit = c;
      const floor = this.groundAt?.(px, pz, Math.max(carPos.y, rayY));
      if (floor !== undefined && floor < c && rayY < floor + GROUND_CLEARANCE) {
        // Lift the complete sightline over the crest. Pulling all the way
        // toward the taxi on a downhill made its roof fill the frame.
        const clearY = originY + (floor + GROUND_CLEARANCE - originY) / f;
        if (clearY < soffit - CAMERA.ceilingClear) {
          endY = Math.max(endY, clearY);
        } else {
          t = Math.max(0.16, (i - 1) / steps);
          break;
        }
      }
    }
    this.ceilY = soffit;
    desired.set(
      carPos.x + dx * t,
      Math.max(CAMERA.minHeight, originY + (endY - originY) * t),
      carPos.z + dz * t,
    );
  }
}
