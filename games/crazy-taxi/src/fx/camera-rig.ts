import * as THREE from "three";

import { CAMERA, CAR } from "../shared/constants";
import type { Car } from "../vehicle/car";
import type { Solid } from "../world/city";

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
  private shakeOff = new THREE.Vector3();

  constructor(aspect: number) {
    this.camera = new THREE.PerspectiveCamera(CAMERA.fov, aspect, 0.1, 2000);
  }

  resize(aspect: number): void {
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }

  addTrauma(amount: number): void {
    this.shake = Math.min(1, this.shake + amount);
  }

  snapTo(car: Car): void {
    this.camYaw = car.heading;
    const fwd = new THREE.Vector2(Math.sin(this.camYaw), Math.cos(this.camYaw));
    this.camera.position.set(
      car.position.x - fwd.x * CAMERA.distance,
      car.position.y + CAMERA.height,
      car.position.z - fwd.y * CAMERA.distance,
    );
    this.look.set(car.position.x, car.position.y + CAMERA.lookHeight, car.position.z);
    this.camera.lookAt(this.look);
  }

  update(dt: number, car: Car, solids: readonly Solid[]): void {
    // Drift swing: bias the follow yaw toward the velocity direction during a
    // slide so the camera lags to the outside and you see the taxi's flank.
    let targetYaw = car.heading;
    const vh = car.velAngle;
    if (vh !== null) {
      let slip = ((vh - car.heading + Math.PI) % (Math.PI * 2)) - Math.PI;
      if (slip < -Math.PI) slip += Math.PI * 2;
      targetYaw = car.heading + THREE.MathUtils.clamp(slip, -CAMERA.driftSwing, CAMERA.driftSwing);
    }
    this.camYaw = lerpAngle(this.camYaw, targetYaw, Math.min(1, CAMERA.yawLerp * dt));
    const fwd = new THREE.Vector2(Math.sin(this.camYaw), Math.cos(this.camYaw));

    const desired = new THREE.Vector3(
      car.position.x - fwd.x * CAMERA.distance,
      car.position.y + CAMERA.height,
      car.position.z - fwd.y * CAMERA.distance,
    );
    this.avoidClip(car.position, desired, solids);
    this.camera.position.lerp(desired, Math.min(1, CAMERA.posLerp * dt));

    const speedFrac = THREE.MathUtils.clamp(car.speed / CAR.maxSpeed, 0, 1);
    const la = CAMERA.lookAhead + CAMERA.lookAheadSpeed * speedFrac;
    const lookTarget = new THREE.Vector3(
      car.position.x + fwd.x * la,
      car.position.y + CAMERA.lookHeight,
      car.position.z + fwd.y * la,
    );
    this.look.lerp(lookTarget, Math.min(1, CAMERA.aimLerp * dt));

    // Trauma-based shake (quadratic falloff feels punchier than linear).
    this.shake = Math.max(0, this.shake - dt * 1.7);
    const s = this.shake * this.shake;
    this.shakeOff.set(
      (Math.random() - 0.5) * s * 2.2,
      (Math.random() - 0.5) * s * 1.6,
      (Math.random() - 0.5) * s * 2.2,
    );
    this.camera.position.add(this.shakeOff);

    this.camera.lookAt(this.look);

    // Speed FOV: widen as we approach top/boost speed for a rush.
    const frac = THREE.MathUtils.clamp(car.speed / CAR.boostSpeed, 0, 1);
    const targetFov = THREE.MathUtils.lerp(CAMERA.fov, CAMERA.fovBoost, frac);
    this.camera.fov += (targetFov - this.camera.fov) * Math.min(1, dt * 4);
    this.camera.updateProjectionMatrix();
  }

  // March from the car to the desired camera spot; if the line crosses a
  // building footprint, pull the camera in so it never buries into a facade.
  private avoidClip(carPos: THREE.Vector3, desired: THREE.Vector3, solids: readonly Solid[]): void {
    const dx = desired.x - carPos.x;
    const dy = desired.y - carPos.y;
    const dz = desired.z - carPos.z;
    const steps = 12;
    let t = 1;
    for (let i = 1; i <= steps; i++) {
      const f = i / steps;
      const px = carPos.x + dx * f;
      const pz = carPos.z + dz * f;
      let hit = false;
      for (const s of solids) {
        if (px > s.minX && px < s.maxX && pz > s.minZ && pz < s.maxZ) {
          hit = true;
          break;
        }
      }
      if (hit) {
        t = Math.max(0.28, (i - 1) / steps);
        break;
      }
    }
    desired.set(
      carPos.x + dx * t,
      Math.max(CAMERA.minHeight, carPos.y + dy * t),
      carPos.z + dz * t,
    );
  }
}
