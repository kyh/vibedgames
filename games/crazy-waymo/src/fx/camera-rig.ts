import * as THREE from "three";

import { CAMERA, CAR } from "../shared/constants";
import type { Car } from "../vehicle/car";
import type { CeilingIndex, SolidIndex } from "../world/solid-index";

/** Follow inputs only; the rig does not own or step the vehicle. */
type ChaseTarget = Pick<
  Car,
  "heading" | "position" | "forwardSpeed" | "slip" | "velAngle" | "speed" | "steer" | "isBoosting"
>;

const lerpAngle = (a: number, b: number, t: number) => {
  let d = ((b - a + Math.PI) % (Math.PI * 2)) - Math.PI;

  if (d < -Math.PI) {
    d += Math.PI * 2;
  }

  return a + d * t;
};

const DESIGN_ASPECT = 16 / 9;
const MAX_VERTICAL_FOV = 96;
const GROUND_CLEARANCE = 0.65;
const MIN_HILL_BOOM = 8.5;

const verticalFovFor = (designFov: number, aspect: number) => {
  if (aspect >= DESIGN_ASPECT) {
    return designFov;
  }

  const halfH = Math.tan(THREE.MathUtils.degToRad(designFov) / 2) * DESIGN_ASPECT;

  return Math.min(MAX_VERTICAL_FOV, THREE.MathUtils.radToDeg(2 * Math.atan(halfH / aspect)));
};

const capFor = (soffit: number, carY: number, camY: number) => {
  const open = camY + CAMERA.ceilingRelease;

  if (soffit === Infinity) {
    return open;
  }

  return Math.min(open, Math.max(carY + CAMERA.ceilingFloor, soffit - CAMERA.ceilingClear));
};

export class ChaseCamera {
  readonly camera: THREE.PerspectiveCamera;
  private designFov = CAMERA.fov;
  private camYaw = 0;
  private look = new THREE.Vector3();
  private shake = 0;
  private shakeT = 0;
  private shakeOff = new THREE.Vector3();
  private ceilings: CeilingIndex | null = null;
  private groundAt: ((x: number, z: number, referenceY: number) => number) | null = null;
  private ceilY = Infinity;
  private ceilCap = Infinity;
  private scrFwd = new THREE.Vector2();
  private scrPerp = new THREE.Vector2();
  private scrDesired = new THREE.Vector3();
  private scrLook = new THREE.Vector3();

  constructor(aspect: number) {
    this.camera = new THREE.PerspectiveCamera(
      verticalFovFor(CAMERA.fov, aspect),
      aspect,
      0.3,
      2000,
    );
  }

  resize(aspect: number) {
    this.camera.aspect = aspect;
    this.camera.fov = verticalFovFor(this.designFov, aspect);
    this.camera.updateProjectionMatrix();
  }

  addTrauma(amount: number) {
    this.shake = Math.min(1, this.shake + amount);
  }

  /** Overhead structure to keep the camera under; arrives once the world has. */
  setCeilings(ceilings: CeilingIndex) {
    this.ceilings = ceilings;
  }

  /** Same road/terrain surface the vehicle follows, including hillside terraces. */
  setGround(groundAt: (x: number, z: number, referenceY: number) => number) {
    this.groundAt = groundAt;
  }

  snapTo(car: Pick<Car, "heading" | "position">) {
    this.camYaw = car.heading;
    const fwd = new THREE.Vector2(Math.sin(this.camYaw), Math.cos(this.camYaw));
    const x = car.position.x - fwd.x * CAMERA.distance;
    const z = car.position.z - fwd.y * CAMERA.distance;
    const soffit = this.ceilingOver(x, z, car.position.y);
    this.ceilY = soffit;
    this.ceilCap = capFor(soffit, car.position.y, car.position.y + CAMERA.height);
    this.camera.position.set(x, Math.min(car.position.y + CAMERA.height, this.ceilCap), z);
    this.clearGround(car.position.y);
    this.look.set(car.position.x, car.position.y + CAMERA.lookHeight, car.position.z);
    this.camera.lookAt(this.look);
  }

  private ceilingOver(x: number, z: number, carY: number) {
    if (!this.ceilings) {
      return Infinity;
    }

    return this.ceilings.ceilingAt(x, z, carY + CAMERA.ceilingProbe);
  }

  update(dt: number, car: ChaseTarget, solids: SolidIndex) {
    const movingForward = car.forwardSpeed > 0.5;
    let targetYaw = car.heading;
    const slip = THREE.MathUtils.clamp(car.slip, -CAMERA.driftSwing, CAMERA.driftSwing);
    const vh = car.velAngle;

    if (vh !== null && movingForward) {
      targetYaw = car.heading + slip;
    }

    this.camYaw = lerpAngle(this.camYaw, targetYaw, Math.min(1, CAMERA.yawLerp * dt));
    const fwd = this.scrFwd.set(Math.sin(this.camYaw), Math.cos(this.camYaw));
    const perp = this.scrPerp.set(fwd.y, -fwd.x);

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

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const dx = desired.x - car.position.x;
      const dz = desired.z - car.position.z;
      const rise = desired.y - car.position.y;
      const horizontal = Math.hypot(dx, dz);
      const stretch = Math.hypot(horizontal, rise) / authoredDistance;

      if (rise <= height + 0.1 || horizontal <= MIN_HILL_BOOM || stretch <= 1.03) {
        break;
      }

      const shorter = Math.max(MIN_HILL_BOOM, horizontal / stretch);
      desired.set(
        car.position.x + (dx * shorter) / horizontal,
        car.position.y + height,
        car.position.z + (dz * shorter) / horizontal,
      );
      this.avoidClip(car.position, desired, solids);
    }

    this.camera.position.lerp(desired, Math.min(1, CAMERA.posLerp * dt));

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

    const cap = capFor(this.ceilY, car.position.y, this.camera.position.y);

    if (!Number.isFinite(this.ceilCap)) {
      this.ceilCap = cap;
    }

    const rate = cap < this.ceilCap ? CAMERA.ceilingDuckRate : CAMERA.ceilingRiseRate;
    this.ceilCap += (cap - this.ceilCap) * Math.min(1, rate * dt);

    if (this.camera.position.y > this.ceilCap) {
      this.camera.position.y = this.ceilCap;
    }

    this.clearGround(car.position.y);

    this.camera.lookAt(this.look);

    const rollShake = (Math.sin(t * 47) + Math.sin(t * 89) * 0.5) * 0.035 * s;
    const driftRoll = movingForward ? THREE.MathUtils.clamp(car.slip, -1, 1) * 0.045 : 0;
    this.camera.rotateZ(rollShake + driftRoll);

    const frac = THREE.MathUtils.clamp(car.speed / CAR.boostSpeed, 0, 1);

    const targetFov =
      THREE.MathUtils.lerp(CAMERA.fov, CAMERA.fovBoost, frac) + (car.isBoosting ? 4 : 0);

    const fovRate = targetFov > this.designFov ? 10 : 3;
    this.designFov += (targetFov - this.designFov) * Math.min(1, dt * fovRate);
    this.camera.fov = verticalFovFor(this.designFov, this.camera.aspect);
    this.camera.updateProjectionMatrix();
  }

  private clearGround(carY: number) {
    const p = this.camera.position;
    const floor = this.groundAt?.(p.x, p.z, Math.max(carY, p.y));

    if (floor === undefined || !Number.isFinite(floor)) {
      return;
    }

    if (floor >= this.ceilY) {
      return;
    }

    const ceiling = this.ceilY === Infinity ? Infinity : this.ceilCap;
    p.y = Math.max(p.y, Math.min(floor + GROUND_CLEARANCE, ceiling));
  }

  private avoidClip(carPos: THREE.Vector3, desired: THREE.Vector3, solids: SolidIndex) {
    const dx = desired.x - carPos.x;
    const originY = carPos.y + CAMERA.lookHeight;
    let endY = desired.y;
    const dz = desired.z - carPos.z;
    const steps = 12;
    let t = 1;
    let soffit = this.ceilingOver(carPos.x, carPos.z, carPos.y);

    for (let i = 1; i <= steps; i += 1) {
      const f = i / steps;
      const px = carPos.x + dx * f;
      const pz = carPos.z + dz * f;
      const rayY = originY + (endY - originY) * f;

      if (solids.hitAt(px, pz, rayY)) {
        t = Math.max(0.28, (i - 1) / steps);
        break;
      }

      const c = this.ceilingOver(px, pz, carPos.y);

      if (c < soffit) {
        soffit = c;
      }

      const floor = this.groundAt?.(px, pz, Math.max(carPos.y, rayY));

      if (floor !== undefined && floor < c && rayY < floor + GROUND_CLEARANCE) {
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
