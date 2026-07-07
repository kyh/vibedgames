import RAPIER from "@dimforge/rapier3d-compat";
import * as THREE from "three";

import type { PhysicsWorld } from "../physics/physics-world";
import type { CarInput } from "./car";

// Physics-driven car on Rapier's DynamicRayCastVehicleController — a port of
// icurtis1/raycast-vehicle (cannon-es) onto our stack: the chassis is a rigid
// body, each wheel a suspension raycast that applies engine, brake and
// steering forces. All arcade "assists" from the reference are here:
// anti-wheelie, airborne tilt clamp, corner-lift damping, grip load cap,
// landing grip fade, upright assist, jump buffering. Tunables live in
// `params` and can be edited live (?tune=1 panel).
//
// Units: ours (1u ≈ 1m), gravity 30 (arcade — snappier than 9.82), speeds in
// u/s to match the rest of the game (CAR.maxSpeed 30, boostSpeed 44).

export type VehicleParams = {
  // engine
  engineForce: number;
  boostMultiplier: number;
  cruiseSpeed: number; // top speed on throttle alone (u/s)
  maxSpeed: number; // top speed while boosting
  reverseFactor: number;
  // steering
  maxSteer: number;
  steerSpeed: number;
  steerSpeedFalloff: number;
  // brakes
  brakeForce: number;
  handbrakeForce: number;
  // handbrake drift: rear grip multiplier while held
  handbrakeGrip: number;
  // jump
  jumpImpulse: number;
  jumpCooldown: number;
  jumpBufferTime: number;
  airborneGravityScale: number;
  // suspension / tires
  suspensionStiffness: number;
  suspensionRestLength: number;
  maxSuspensionTravel: number;
  frictionSlip: number;
  dampingRelaxation: number;
  dampingCompression: number;
  // chassis
  mass: number;
  angularDamping: number;
  inertiaScale: number; // pitch/roll inertia multiplier (harder to flip)
  // assists
  antiWheelie: boolean;
  tiltClampAirborne: number; // max pitch/roll spin (rad/s) while airborne
  uprightAssist: boolean;
  cornerLiftDamping: number;
  gripLoadCap: number;
  landingGripTime: number;
  landingGripFactor: number;
};

export const DEFAULT_VEHICLE_PARAMS: VehicleParams = {
  engineForce: 4600,
  boostMultiplier: 1.8,
  cruiseSpeed: 30,
  maxSpeed: 44,
  reverseFactor: 0.6,
  maxSteer: 0.55,
  steerSpeed: 6,
  steerSpeedFalloff: 0.42, // fraction of maxSteer left at top speed (keyboard)
  brakeForce: 5200,
  handbrakeForce: 400,
  handbrakeGrip: 0.42,
  jumpImpulse: 3200,
  jumpCooldown: 0.5,
  jumpBufferTime: 0.18,
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
// Chassis collider half-extents (visual body ≈ 1.8 × 4.0 at hero scale) —
// slightly shorter than the visuals so the wheels meet ramps first.
const HALF = { x: 0.78, y: 0.28, z: 1.32 };
const WHEEL_RADIUS = 0.36;
// slightly inside the visual corners, rays start above the axle line
const WHEEL_CONNECTION = { x: 0.72, y: 0.12, z: 1.12 };

const UP = new THREE.Vector3(0, 1, 0);

export class RaycastVehicle {
  readonly chassis: RAPIER.RigidBody;
  readonly controller: RAPIER.DynamicRayCastVehicleController;
  readonly params: VehicleParams;

  private currentSteer = 0;
  private jumpBufferT = 0;
  private jumpCooldownT = 0;
  private airborneTime = 0;
  private gripRecoveryT = 1;
  private handbrake = false;
  private stuckT = 0;
  private boosting = false;
  private throttle = 0;

  // scratch
  private q = new THREE.Quaternion();
  private v = new THREE.Vector3();
  private v2 = new THREE.Vector3();

  constructor(
    private readonly physics: PhysicsWorld,
    x: number,
    y: number,
    z: number,
    yaw: number,
  ) {
    const world = physics.raw();
    const p = DEFAULT_VEHICLE_PARAMS;
    this.params = { ...p };
    this.chassis = world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(x, y, z)
        .setRotation({ x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) })
        .setAngularDamping(p.angularDamping)
        .setCcdEnabled(true),
    );
    // Rounded corners (the reference uses corner spheres for the same reason):
    // the chassis slides over curb lips and debris instead of catching.
    world.createCollider(
      RAPIER.ColliderDesc.roundCuboid(HALF.x - 0.12, HALF.y - 0.1, HALF.z - 0.12, 0.12)
        .setFriction(0.25)
        .setMass(0.001),
      this.chassis,
    );
    // Custom mass properties: pitch/roll inertia scaled up (harder to flip),
    // yaw left natural so steering response stays sharp.
    const m = p.mass;
    const ix = ((m / 12) * (4 * HALF.y * HALF.y + 4 * HALF.z * HALF.z)) * p.inertiaScale;
    const iy = (m / 12) * (4 * HALF.x * HALF.x + 4 * HALF.z * HALF.z);
    const iz = ((m / 12) * (4 * HALF.x * HALF.x + 4 * HALF.y * HALF.y)) * p.inertiaScale;
    this.chassis.setAdditionalMassProperties(
      m,
      { x: 0, y: -0.25, z: 0 }, // low centre of mass
      { x: ix, y: iy, z: iz },
      { x: 0, y: 0, z: 0, w: 1 },
      true,
    );

    this.controller = world.createVehicleController(this.chassis);
    this.controller.indexUpAxis = 1;
    this.controller.setIndexForwardAxis = 2;
    const dirCs = { x: 0, y: -1, z: 0 };
    const axleCs = { x: -1, y: 0, z: 0 };
    const c = WHEEL_CONNECTION;
    const corners = [
      { x: -c.x, y: c.y, z: c.z }, // FL
      { x: c.x, y: c.y, z: c.z }, // FR
      { x: -c.x, y: c.y, z: -c.z }, // RL
      { x: c.x, y: c.y, z: -c.z }, // RR
    ];
    for (const corner of corners) {
      this.controller.addWheel(corner, dirCs, axleCs, p.suspensionRestLength, WHEEL_RADIUS);
    }
    for (let i = 0; i < 4; i++) this.applyWheelParams(i);
  }

  applyWheelParams(i: number): void {
    const p = this.params;
    this.controller.setWheelSuspensionStiffness(i, p.suspensionStiffness);
    this.controller.setWheelSuspensionRestLength(i, p.suspensionRestLength);
    this.controller.setWheelMaxSuspensionTravel(i, p.maxSuspensionTravel);
    this.controller.setWheelSuspensionCompression(i, p.dampingCompression);
    this.controller.setWheelSuspensionRelaxation(i, p.dampingRelaxation);
    this.controller.setWheelFrictionSlip(i, p.frictionSlip);
    this.controller.setWheelMaxSuspensionForce(i, 120000);
  }

  get position(): RAPIER.Vector {
    return this.chassis.translation();
  }

  quaternion(out: THREE.Quaternion): THREE.Quaternion {
    const r = this.chassis.rotation();
    return out.set(r.x, r.y, r.z, r.w);
  }

  velocity(out: THREE.Vector3): THREE.Vector3 {
    const v = this.chassis.linvel();
    return out.set(v.x, v.y, v.z);
  }

  get speed(): number {
    const v = this.chassis.linvel();
    return Math.hypot(v.x, v.y, v.z);
  }

  groundedWheels(): number {
    let n = 0;
    for (let i = 0; i < 4; i++) if (this.controller.wheelIsInContact(i)) n++;
    return n;
  }

  wheelVisual(i: number): { steering: number; rotation: number; suspension: number } {
    return {
      steering: this.controller.wheelSteering(i) ?? 0,
      rotation: this.controller.wheelRotation(i) ?? 0,
      suspension: this.controller.wheelSuspensionLength(i) ?? this.params.suspensionRestLength,
    };
  }

  get isHandbraking(): boolean {
    return this.handbrake;
  }
  get airTimeSeconds(): number {
    return this.airborneTime;
  }

  requestJump(): void {
    this.jumpBufferT = this.params.jumpBufferTime;
  }

  // Per-render-frame: read input into control state (cheap, idempotent).
  setControls(input: CarInput, boosting: boolean): void {
    this.throttle = input.throttle;
    this.handbrake = input.drift;
    this.boosting = boosting;
  }

  teleport(x: number, y: number, z: number, yaw: number): void {
    this.chassis.setTranslation({ x, y, z }, true);
    this.chassis.setRotation({ x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) }, true);
    this.chassis.setLinvel({ x: 0, y: 0, z: 0 }, true);
    this.chassis.setAngvel({ x: 0, y: 0, z: 0 }, true);
    this.currentSteer = 0;
  }

  forwardDir(out: THREE.Vector3): THREE.Vector3 {
    this.quaternion(this.q);
    return out.set(0, 0, 1).applyQuaternion(this.q);
  }

  // One fixed physics step: controls → forces → assists → vehicle update.
  // Called from inside PhysicsWorld's fixed-step loop so suspension math
  // always runs at FIXED_DT, exactly like the reference.
  fixedStep(dt: number): void {
    const p = this.params;
    this.jumpCooldownT = Math.max(0, this.jumpCooldownT - dt);
    this.jumpBufferT = Math.max(0, this.jumpBufferT - dt);

    // --- Steering with smoothing + speed falloff (digital keyboard input
    // needs gentler lock at speed or every drift snaps into a spin) ---
    const speedFrac = THREE.MathUtils.clamp(this.speed / p.maxSpeed, 0, 1);
    const steerScale = THREE.MathUtils.lerp(1, p.steerSpeedFalloff, speedFrac);
    const target = -this.steerInput * p.maxSteer * steerScale;
    const steerDelta = p.steerSpeed * dt;
    this.currentSteer = THREE.MathUtils.clamp(
      target,
      this.currentSteer - steerDelta,
      this.currentSteer + steerDelta,
    );
    this.controller.setWheelSteering(0, this.currentSteer);
    this.controller.setWheelSteering(1, this.currentSteer);

    // --- Engine (rear-wheel drive, cruise/boost speed caps) ---
    const fwd = this.forwardDir(this.v);
    const vel = this.velocity(this.v2);
    const fwdSpeed = vel.dot(fwd);
    const speedCap = this.boosting ? p.maxSpeed : p.cruiseSpeed;
    let force = 0;
    if (this.throttle > 0.05 && fwdSpeed < speedCap) {
      force = p.engineForce * (this.boosting ? p.boostMultiplier : 1) * this.throttle;
    } else if (this.throttle < -0.05) {
      const movingForward = fwdSpeed > 0.5;
      force = movingForward ? 0 : p.engineForce * p.reverseFactor * this.throttle;
    }
    // Anti-wheelie: forward force scales with front-axle load so the car
    // can't torque onto its rear bumper; the floor keeps ramps climbable.
    if (force > 0 && p.antiWheelie) {
      const frontLoad =
        (this.controller.wheelSuspensionForce(0) ?? 0) +
        (this.controller.wheelSuspensionForce(1) ?? 0);
      const nominalAxle = (p.mass * GRAVITY) / 2;
      force *= THREE.MathUtils.clamp(frontLoad / (nominalAxle * 0.4), 0.35, 1);
    }
    this.controller.setWheelEngineForce(2, force);
    this.controller.setWheelEngineForce(3, force);

    // --- Brakes ---
    let brake = 0;
    if (this.throttle < -0.05 && fwdSpeed > 0.5) brake = p.brakeForce;
    if (Math.abs(this.throttle) <= 0.05) brake = 60; // gentle engine braking
    for (let i = 0; i < 4; i++) this.controller.setWheelBrake(i, brake);
    if (this.handbrake) {
      this.controller.setWheelBrake(2, p.handbrakeForce);
      this.controller.setWheelBrake(3, p.handbrakeForce);
    }

    // --- Assists ---
    const grounded = this.groundedWheels();
    if (grounded === 0) this.airborneTime += dt;
    else {
      if (this.airborneTime > 0.15) this.gripRecoveryT = 0; // just landed
      this.airborneTime = 0;
      this.gripRecoveryT += dt;
    }

    // Natural grip: load cap + landing fade-in + handbrake rear slide.
    const staticLoad = (p.mass * GRAVITY) / 4;
    const landingBlend = THREE.MathUtils.clamp(this.gripRecoveryT / p.landingGripTime, 0, 1);
    const landingScale = p.landingGripFactor + (1 - p.landingGripFactor) * landingBlend;
    for (let i = 0; i < 4; i++) {
      const load = Math.max(this.controller.wheelSuspensionForce(i) ?? staticLoad, staticLoad);
      const loadScale = Math.min(1, (p.gripLoadCap * staticLoad) / load);
      let slip = p.frictionSlip * loadScale * landingScale;
      if (this.handbrake && i >= 2) slip *= p.handbrakeGrip; // rear slide = drift
      this.controller.setWheelFrictionSlip(i, slip);
    }

    // Jump (buffered + cooldown, only when a wheel touches ground).
    if (this.jumpBufferT > 0 && this.jumpCooldownT <= 0 && grounded > 0) {
      this.chassis.applyImpulse({ x: 0, y: p.jumpImpulse, z: 0 }, true);
      this.jumpCooldownT = p.jumpCooldown;
      this.jumpBufferT = 0;
    }

    // Extra gravity while airborne so arcs stay snappy (forces are cleared
    // and re-applied every fixed step).
    this.chassis.resetForces(true);
    if (grounded === 0 && p.airborneGravityScale > 1) {
      this.chassis.addForce(
        { x: 0, y: -(p.airborneGravityScale - 1) * GRAVITY * p.mass, z: 0 },
        true,
      );
    }

    // Airborne tilt clamp: cap pitch/roll spin only when fully airborne.
    if (grounded === 0 && p.tiltClampAirborne > 0) {
      this.clampLocalTilt(p.tiltClampAirborne);
    }

    // Corner-lift damping: partially grounded = an obstacle is levering the
    // car — bleed pitch/roll spin so the lifted corner settles.
    if (grounded > 0 && grounded < 4 && p.cornerLiftDamping < 1) {
      this.scaleLocalTilt(p.cornerLiftDamping);
    }

    // Upright assist: past ~40° of tilt, torque back toward flat and bleed
    // pitch/roll spin — never fights fast intentional ramp driving.
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

    // Unstick assist: throttle held but beached (barely moving, uneven wheel
    // contact) — give a small forward+up nudge so players never sit trapped
    // on a curb lip or a wreck.
    if (Math.abs(this.throttle) > 0.5 && this.speed < 1.2 && grounded > 0 && grounded < 4) {
      this.stuckT += dt;
      if (this.stuckT > 0.9) {
        const f = this.forwardDir(this.v);
        const sign = this.throttle > 0 ? 1 : -1;
        this.chassis.applyImpulse(
          { x: f.x * sign * p.mass * 4, y: p.mass * 3, z: f.z * sign * p.mass * 4 },
          true,
        );
        this.stuckT = 0;
      }
    } else {
      this.stuckT = 0;
    }

    this.controller.updateVehicle(dt);
  }

  steerInput = 0;

  private clampLocalTilt(maxSpin: number): void {
    this.quaternion(this.q);
    const av = this.chassis.angvel();
    this.v.set(av.x, av.y, av.z).applyQuaternion(this.q.clone().invert());
    this.v.x = THREE.MathUtils.clamp(this.v.x, -maxSpin, maxSpin);
    this.v.z = THREE.MathUtils.clamp(this.v.z, -maxSpin, maxSpin);
    this.v.applyQuaternion(this.q);
    this.chassis.setAngvel({ x: this.v.x, y: this.v.y, z: this.v.z }, true);
  }

  private scaleLocalTilt(f: number): void {
    this.quaternion(this.q);
    const av = this.chassis.angvel();
    this.v.set(av.x, av.y, av.z).applyQuaternion(this.q.clone().invert());
    this.v.x *= f;
    this.v.z *= f;
    this.v.applyQuaternion(this.q);
    this.chassis.setAngvel({ x: this.v.x, y: this.v.y, z: this.v.z }, true);
  }

  dispose(): void {
    this.physics.raw().removeVehicleController(this.controller);
    this.physics.raw().removeRigidBody(this.chassis);
  }
}
