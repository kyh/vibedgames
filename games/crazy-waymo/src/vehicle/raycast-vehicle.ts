import { ColliderDesc, RigidBodyDesc } from "#rapier";
import type { DynamicRayCastVehicleController, RigidBody } from "#rapier";
import * as THREE from "three";

import type { PhysicsWorld } from "../physics/physics-world";
import type { CarInput } from "./car";
import { Flotation } from "./flotation";
import type { WaterSampler } from "../world/water";

export interface VehicleParams {
  engineForce: number;
  boostMultiplier: number;
  cruiseSpeed: number;
  maxSpeed: number;
  reverseFactor: number;
  maxSteer: number;
  steerSpeed: number;
  highSpeedSteer: number;
  brakeDecel: number;
  brakeRamp: number;
  slideAngle: number;
  arcMin: number;
  arcMax: number;
  driftDecay: number;
  turbo1T: number;
  turbo2T: number;
  turbo1Boost: number;
  turbo2Boost: number;
  airborneGravityScale: number;
  suspensionStiffness: number;
  suspensionRestLength: number;
  maxSuspensionTravel: number;
  frictionSlip: number;
  dampingRelaxation: number;
  dampingCompression: number;
  mass: number;
  angularDamping: number;
  inertiaScale: number;
  antiWheelie: boolean;
  tiltClampAirborne: number;
  uprightAssist: boolean;
  cornerLiftDamping: number;
  gripLoadCap: number;
  landingGripTime: number;
  landingGripFactor: number;
}

export const DEFAULT_VEHICLE_PARAMS: VehicleParams = {
  engineForce: 3000,
  boostMultiplier: 1.8,
  cruiseSpeed: 30,
  maxSpeed: 44,
  reverseFactor: 0.6,
  maxSteer: 0.4,
  steerSpeed: 2,
  highSpeedSteer: 0.24,
  brakeDecel: 26,
  brakeRamp: 0.35,
  slideAngle: 0.42,
  arcMin: 1.1,
  arcMax: 2.6,
  driftDecay: 2,
  turbo1T: 0.8,
  turbo2T: 1.7,
  turbo1Boost: 12,
  turbo2Boost: 20,
  airborneGravityScale: 1.4,
  suspensionStiffness: 62,
  suspensionRestLength: 0.55,
  maxSuspensionTravel: 0.42,
  frictionSlip: 7.8,
  dampingRelaxation: 3.5,
  dampingCompression: 4.4,
  mass: 250,
  angularDamping: 0.4,
  inertiaScale: 3,
  antiWheelie: true,
  tiltClampAirborne: 4,
  uprightAssist: true,
  cornerLiftDamping: 0.7,
  gripLoadCap: 2,
  landingGripTime: 0.35,
  landingGripFactor: 0.4,
};

const GRAVITY = 30;
const HALF = { x: 0.78, y: 0.28, z: 1.32 };
const WHEEL_RADIUS = 0.36;
const WHEEL_CONNECTION = { x: 0.72, y: 0.12, z: 1.12 };

const UP = new THREE.Vector3(0, 1, 0);

type PedalMode = "brake" | "coast" | "drift" | "drive" | "reverse";

const pedalMode: (
  inDrift: boolean,
  pedalDown: boolean,
  gas: boolean,
  fwdSpeed: number,
  cruiseSpeed: number,
) => PedalMode = (inDrift, pedalDown, gas, fwdSpeed, cruiseSpeed) => {
  if (inDrift) {
    return "drift";
  }

  if (pedalDown && fwdSpeed > 0.5) {
    return "brake";
  }

  if (pedalDown && fwdSpeed > -cruiseSpeed * 0.4) {
    return "reverse";
  }

  return gas ? "drive" : "coast";
};

export class RaycastVehicle {
  readonly chassis: RigidBody;
  readonly controller: DynamicRayCastVehicleController;
  readonly params: VehicleParams;
  private readonly flotation: Flotation;

  private currentSteer = 0;
  private airborneTime = 0;
  private gripRecoveryT = 1;
  private brakeInput = 0;
  private brakeHeldT = 0;
  private driftDir: 0 | 1 | -1 = 0;
  private driftChargeT = 0;
  private turboFired: 0 | 1 | 2 = 0;
  private stuckT = 0;
  private boosting = false;
  private throttle = 0;

  private q = new THREE.Quaternion();
  private v = new THREE.Vector3();
  private v2 = new THREE.Vector3();

  private readonly physics: Pick<PhysicsWorld, "raw">;

  constructor(physics: Pick<PhysicsWorld, "raw">, x: number, y: number, z: number, yaw: number) {
    this.physics = physics;
    const world = physics.raw();
    const p = DEFAULT_VEHICLE_PARAMS;
    this.params = { ...p };
    this.chassis = world.createRigidBody(
      RigidBodyDesc.dynamic()
        .setTranslation(x, y, z)
        .setRotation({ w: Math.cos(yaw / 2), x: 0, y: Math.sin(yaw / 2), z: 0 })
        .setAngularDamping(p.angularDamping)
        .setCcdEnabled(true),
    );
    this.flotation = new Flotation(this.chassis);
    world.createCollider(
      ColliderDesc.roundCuboid(HALF.x - 0.12, HALF.y - 0.1, HALF.z - 0.12, 0.12)
        .setFriction(0.25)
        .setMass(0.001),
      this.chassis,
    );
    const m = p.mass;
    const ix = (m / 12) * (4 * HALF.y * HALF.y + 4 * HALF.z * HALF.z) * p.inertiaScale;
    const iy = (m / 12) * (4 * HALF.x * HALF.x + 4 * HALF.z * HALF.z);
    const iz = (m / 12) * (4 * HALF.x * HALF.x + 4 * HALF.y * HALF.y) * p.inertiaScale;
    this.chassis.setAdditionalMassProperties(
      m,
      { x: 0, y: -0.25, z: 0 },
      { x: ix, y: iy, z: iz },
      { w: 1, x: 0, y: 0, z: 0 },
      true,
    );

    this.controller = world.createVehicleController(this.chassis);
    this.controller.indexUpAxis = 1;
    this.controller.setIndexForwardAxis = 2;
    const dirCs = { x: 0, y: -1, z: 0 };
    const axleCs = { x: -1, y: 0, z: 0 };
    const c = WHEEL_CONNECTION;

    const corners = [
      { x: -c.x, y: c.y, z: c.z },
      { x: c.x, y: c.y, z: c.z },
      { x: -c.x, y: c.y, z: -c.z },
      { x: c.x, y: c.y, z: -c.z },
    ];

    for (const corner of corners) {
      this.controller.addWheel(corner, dirCs, axleCs, p.suspensionRestLength, WHEEL_RADIUS);
    }

    for (let i = 0; i < 4; i += 1) {
      this.applyWheelParams(i);
    }
  }

  applyWheelParams(i: number) {
    const p = this.params;
    this.controller.setWheelSuspensionStiffness(i, p.suspensionStiffness);
    this.controller.setWheelSuspensionRestLength(i, p.suspensionRestLength);
    this.controller.setWheelMaxSuspensionTravel(i, p.maxSuspensionTravel);
    this.controller.setWheelSuspensionCompression(i, p.dampingCompression);
    this.controller.setWheelSuspensionRelaxation(i, p.dampingRelaxation);
    this.controller.setWheelFrictionSlip(i, p.frictionSlip);
    this.controller.setWheelMaxSuspensionForce(i, 120_000);
  }

  get position() {
    return this.chassis.translation();
  }

  quaternion(out: THREE.Quaternion) {
    const r = this.chassis.rotation();

    return out.set(r.x, r.y, r.z, r.w);
  }

  velocity(out: THREE.Vector3) {
    const v = this.chassis.linvel();

    return out.set(v.x, v.y, v.z);
  }

  get speed() {
    const v = this.chassis.linvel();

    return Math.hypot(v.x, v.y, v.z);
  }

  get waterContact() {
    return this.flotation.waterContact;
  }

  setWaterSampler(sampler: WaterSampler | null) {
    this.flotation.setSampler(sampler);
  }

  groundedWheels() {
    let n = 0;

    for (let i = 0; i < 4; i += 1) {
      if (this.controller.wheelIsInContact(i)) {
        n += 1;
      }
    }

    return n;
  }

  wheelVisual(i: number) {
    return {
      rotation: this.controller.wheelRotation(i) ?? 0,
      steering: this.controller.wheelSteering(i) ?? 0,
      suspension: this.controller.wheelSuspensionLength(i) ?? this.params.suspensionRestLength,
    };
  }

  get airTimeSeconds() {
    return this.airborneTime;
  }

  get isDrifting() {
    return this.driftDir !== 0;
  }
  get driftDirection() {
    return this.driftDir;
  }
  get driftTier() {
    if (this.driftDir === 0) {
      return 0;
    }

    if (this.driftChargeT >= this.params.turbo2T) {
      return 2;
    }

    if (this.driftChargeT >= this.params.turbo1T) {
      return 1;
    }

    return 0;
  }
  get driftCharge01() {
    return this.driftDir === 0 ? 0 : Math.min(1, this.driftChargeT / this.params.turbo1T);
  }
  consumeMiniTurbo() {
    const t = this.turboFired;
    this.turboFired = 0;

    return t;
  }

  setControls(input: CarInput, boosting: boolean) {
    this.throttle = boosting ? 1 : input.throttle;
    this.brakeInput = input.brake;
    this.boosting = boosting;
  }

  teleport(x: number, y: number, z: number, yaw: number) {
    this.flotation.reset();
    this.chassis.setTranslation({ x, y, z }, true);
    this.chassis.setRotation({ w: Math.cos(yaw / 2), x: 0, y: Math.sin(yaw / 2), z: 0 }, true);
    this.chassis.setLinvel({ x: 0, y: 0, z: 0 }, true);
    this.chassis.setAngvel({ x: 0, y: 0, z: 0 }, true);
    this.currentSteer = 0;
    this.driftDir = 0;
    this.driftChargeT = 0;
    this.turboFired = 0;
  }

  forwardDir(out: THREE.Vector3) {
    this.quaternion(this.q);

    return out.set(0, 0, 1).applyQuaternion(this.q);
  }

  fixedStep(dt: number) {
    if (this.flotation.step(dt, this.throttle, this.brakeInput, this.steerInput, this.boosting)) {
      this.waterStep(dt);

      return;
    }

    const p = this.params;
    const fwd = this.forwardDir(this.v);
    const vel = this.velocity(this.v2);
    const fwdSpeed = vel.dot(fwd);
    const startPlanarSpeed = Math.hypot(vel.x, vel.z);
    const speedFrac = THREE.MathUtils.clamp(Math.abs(fwdSpeed) / p.cruiseSpeed, 0, 1);

    const gas = this.throttle > 0.05;
    const pedalDown = this.brakeInput > 0.05;
    const mode = pedalMode(this.driftDir !== 0, pedalDown, gas, fwdSpeed, p.cruiseSpeed);
    const drifting = mode === "drift";
    this.brakeHeldT = pedalDown ? this.brakeHeldT + dt : 0;
    const brakeBuild = mode === "brake" ? Math.min(1, this.brakeHeldT / p.brakeRamp) : 0;

    const steerLimit = p.maxSteer * THREE.MathUtils.lerp(1, p.highSpeedSteer, speedFrac);
    const target = -this.steerInput * steerLimit;
    const steerDelta = p.steerSpeed * dt;
    this.currentSteer = THREE.MathUtils.clamp(
      target,
      this.currentSteer - steerDelta,
      this.currentSteer + steerDelta,
    );
    this.controller.setWheelSteering(0, this.currentSteer);
    this.controller.setWheelSteering(1, this.currentSteer);

    this.applyEngine(mode, gas, fwdSpeed, brakeBuild);

    const coast = mode === "coast" ? 14 : 0;

    for (let i = 0; i < 4; i += 1) {
      this.controller.setWheelBrake(i, coast);
    }

    const grounded = this.groundedWheels();
    const holding = mode === "coast" && grounded >= 2 && startPlanarSpeed < 0.8;

    if (grounded === 0) {
      this.airborneTime += dt;
    } else {
      if (this.airborneTime > 0.15) {
        this.gripRecoveryT = 0;
      }

      this.airborneTime = 0;
      this.gripRecoveryT += dt;
    }

    this.applyGrip(drifting);
    this.applyAirborneForces(grounded);
    this.applyUprightAssist(dt);
    this.applyUnstick(dt, grounded);
    this.updateDriftState(dt, fwdSpeed, grounded);

    this.controller.updateVehicle(dt);

    this.applyPostStepVelocity(dt, mode, grounded, holding, startPlanarSpeed, brakeBuild);
  }

  private waterStep(dt: number) {
    this.driftDir = 0;
    this.driftChargeT = 0;
    this.turboFired = 0;
    this.airborneTime = 0;
    this.gripRecoveryT = 1;
    this.stuckT = 0;

    for (let i = 0; i < 4; i += 1) {
      this.controller.setWheelEngineForce(i, 0);
      this.controller.setWheelBrake(i, 0);
      this.controller.setWheelFrictionSlip(i, 0.8);
    }

    this.controller.updateVehicle(dt);
  }

  private applyEngine(mode: PedalMode, gas: boolean, fwdSpeed: number, brakeBuild: number) {
    const p = this.params;
    const speedCap = this.boosting ? p.maxSpeed : p.cruiseSpeed;
    let force = 0;

    if ((mode === "drive" || mode === "brake") && gas && fwdSpeed < speedCap) {
      force =
        p.engineForce * (this.boosting ? p.boostMultiplier : 1) * this.throttle * (1 - brakeBuild);
    } else if (mode === "reverse") {
      force = -p.engineForce * p.reverseFactor * this.brakeInput;
    }

    if (force > 0 && p.antiWheelie) {
      const frontLoad =
        (this.controller.wheelSuspensionForce(0) ?? 0) +
        (this.controller.wheelSuspensionForce(1) ?? 0);

      const nominalAxle = (p.mass * GRAVITY) / 2;
      force *= THREE.MathUtils.clamp(frontLoad / (nominalAxle * 0.4), 0.35, 1);
    }

    this.controller.setWheelEngineForce(2, force);
    this.controller.setWheelEngineForce(3, force);
  }

  private applyGrip(drifting: boolean) {
    const p = this.params;
    const staticLoad = (p.mass * GRAVITY) / 4;
    const landingBlend = THREE.MathUtils.clamp(this.gripRecoveryT / p.landingGripTime, 0, 1);
    const landingScale = p.landingGripFactor + (1 - p.landingGripFactor) * landingBlend;

    for (let i = 0; i < 4; i += 1) {
      const load = Math.max(this.controller.wheelSuspensionForce(i) ?? staticLoad, staticLoad);
      const loadScale = Math.min(1, (p.gripLoadCap * staticLoad) / load);
      this.controller.setWheelFrictionSlip(
        i,
        drifting ? 0.4 : p.frictionSlip * loadScale * landingScale,
      );
    }
  }

  private applyAirborneForces(grounded: number) {
    const p = this.params;
    this.chassis.resetForces(true);

    if (grounded === 0 && p.airborneGravityScale > 1) {
      this.chassis.addForce(
        { x: 0, y: -(p.airborneGravityScale - 1) * GRAVITY * p.mass, z: 0 },
        true,
      );
    }

    if (grounded === 0 && p.tiltClampAirborne > 0) {
      this.clampLocalTilt(p.tiltClampAirborne);
    }

    if (grounded > 0 && grounded < 4 && p.cornerLiftDamping < 1) {
      this.scaleLocalTilt(p.cornerLiftDamping);
    }
  }

  private applyUprightAssist(dt: number) {
    const p = this.params;

    if (p.uprightAssist) {
      this.quaternion(this.q);
      const bodyUp = this.v.copy(UP).applyQuaternion(this.q);

      if (bodyUp.y < 0.75) {
        const speedFade = THREE.MathUtils.clamp(1 - (this.speed - 8) / 8, 0, 1);

        if (speedFade > 0) {
          const axis = this.v2.crossVectors(bodyUp, UP);
          this.chassis.applyTorqueImpulse(
            {
              x: axis.x * p.mass * 5.5 * speedFade * dt * 60,
              y: 0,
              z: axis.z * p.mass * 5.5 * speedFade * dt * 60,
            },
            true,
          );
        }

        this.scaleLocalTilt(0.88);
      }
    }
  }

  private applyUnstick(dt: number, grounded: number) {
    const p = this.params;
    const pedal = this.throttle > 0.5 || this.brakeInput > 0.5;

    if (pedal && this.speed < 1.2 && grounded > 0 && grounded < 4) {
      this.stuckT += dt;

      if (this.stuckT > 0.9) {
        const f = this.forwardDir(this.v);
        const sign = this.throttle > 0.5 ? 1 : -1;
        this.chassis.applyImpulse(
          { x: f.x * sign * p.mass * 4, y: p.mass * 3, z: f.z * sign * p.mass * 4 },
          true,
        );
        this.stuckT = 0;
      }
    } else {
      this.stuckT = 0;
    }
  }

  private updateDriftState(dt: number, fwdSpeed: number, grounded: number) {
    const p = this.params;

    if (this.driftDir === 0) {
      if (
        this.brakeInput > 0.05 &&
        Math.abs(this.steerInput) > 0.25 &&
        fwdSpeed > 12 &&
        grounded >= 2
      ) {
        this.driftDir = this.steerInput > 0 ? 1 : -1;
        this.driftChargeT = 0;
        this.brakeHeldT = 0;
      }
    } else if (this.brakeInput <= 0.05) {
      const tier = this.driftTier;

      if (tier > 0) {
        const boost = tier === 2 ? p.turbo2Boost : p.turbo1Boost;
        const f = this.forwardDir(this.v);
        this.chassis.applyImpulse({ x: f.x * boost * p.mass, y: 0, z: f.z * boost * p.mass }, true);
        this.turboFired = tier;
      }

      this.driftDir = 0;
      this.driftChargeT = 0;
      this.brakeHeldT = 0;
    } else if (fwdSpeed < 8 || this.airborneTime > 0.4) {
      this.driftDir = 0;
      this.driftChargeT = 0;
      this.brakeHeldT = 0;
    }

    if (this.driftDir !== 0) {
      this.driftChargeT += dt;
    }
  }

  private applyPostStepVelocity(
    dt: number,
    mode: PedalMode,
    grounded: number,
    holding: boolean,
    startPlanarSpeed: number,
    brakeBuild: number,
  ) {
    const p = this.params;

    if (this.driftDir !== 0) {
      const dir = this.driftDir;
      const into = (this.steerInput * dir + 1) / 2;
      const arcRate = THREE.MathUtils.lerp(p.arcMin, p.arcMax, into);
      const av = this.chassis.angvel();
      this.chassis.setAngvel({ x: av.x, y: -dir * arcRate, z: av.z }, true);

      const f = this.forwardDir(this.v);
      const noseHeading = Math.atan2(f.x, f.z);
      const lv = this.chassis.linvel();
      const cur = Math.atan2(lv.x, lv.z);
      const target = noseHeading + dir * p.slideAngle;
      const delta = ((target - cur + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
      const heading = cur + delta * Math.min(1, dt * 9);
      const speed = Math.max(0, startPlanarSpeed - p.driftDecay * dt);
      this.chassis.setLinvel(
        { x: Math.sin(heading) * speed, y: lv.y, z: Math.cos(heading) * speed },
        true,
      );
    } else if (holding) {
      const lv = this.chassis.linvel();
      this.chassis.setLinvel({ x: 0, y: lv.y, z: 0 }, true);
    } else if (mode === "brake" && grounded > 0) {
      const lv = this.chassis.linvel();
      const planar = Math.hypot(lv.x, lv.z);

      if (planar > 0.01) {
        const next = Math.max(0, planar - p.brakeDecel * this.brakeInput * brakeBuild * dt);
        const k = next / planar;
        this.chassis.setLinvel({ x: lv.x * k, y: lv.y, z: lv.z * k }, true);
      }
    }
  }

  steerInput = 0;

  private clampLocalTilt(maxSpin: number) {
    this.quaternion(this.q);
    const av = this.chassis.angvel();
    this.v.set(av.x, av.y, av.z).applyQuaternion(this.q.clone().invert());
    this.v.x = THREE.MathUtils.clamp(this.v.x, -maxSpin, maxSpin);
    this.v.z = THREE.MathUtils.clamp(this.v.z, -maxSpin, maxSpin);
    this.v.applyQuaternion(this.q);
    this.chassis.setAngvel({ x: this.v.x, y: this.v.y, z: this.v.z }, true);
  }

  private scaleLocalTilt(f: number) {
    this.quaternion(this.q);
    const av = this.chassis.angvel();
    this.v.set(av.x, av.y, av.z).applyQuaternion(this.q.clone().invert());
    this.v.x *= f;
    this.v.z *= f;
    this.v.applyQuaternion(this.q);
    this.chassis.setAngvel({ x: this.v.x, y: this.v.y, z: this.v.z }, true);
  }

  dispose() {
    this.physics.raw().removeVehicleController(this.controller);
    this.physics.raw().removeRigidBody(this.chassis);
  }
}
