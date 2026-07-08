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
  // steering — the front wheels ARE the turn (pure tire physics)
  maxSteer: number;
  steerSpeed: number;
  highSpeedSteer: number; // steer-lock fraction kept at cruise (agile slow, stable fast)
  // brake — ONE pedal (↓/S/Space), applied to the REAR wheels like a handbrake
  // pull (Sega arcade style: the brake IS the drift tool). Braking cuts the
  // rear tires to driftGrip so brake+steer steps the tail out, while a capped
  // yaw assist rotates toward the steered direction — and at zero steer that
  // same assist damps yaw, so straight-line braking stays straight. Pure tire
  // drift alone grips-or-spins; the capped assist is the one arcade cheat.
  brakeForce: number;
  driftGrip: number; // rear-tire grip while braking (< 1 breaks the tail loose)
  driftYawRate: number; // yaw rate (rad/s) the drift rotates toward at full steer
  driftAssist: number; // how hard yaw converges to that target (gain)
  driftMaxSlip: number; // slip angle (rad) the drift holds — it slides, never spins
  driftBrakeFade: number; // brake bite kept at full drift (hold Space through a corner)
  brakeRamp: number; // seconds of holding for the bite to build to full — a tap
  // or a drift-entry press only ever feathers; a held straight brake anchors.
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
  engineForce: 3000,
  boostMultiplier: 1.8,
  cruiseSpeed: 30,
  maxSpeed: 44,
  reverseFactor: 0.6,
  maxSteer: 0.45,
  steerSpeed: 2,
  highSpeedSteer: 0.3,
  brakeForce: 3200,
  driftGrip: 0.45,
  driftYawRate: 2.4,
  driftAssist: 8,
  driftMaxSlip: 0.6,
  driftBrakeFade: 0.06,
  brakeRamp: 0.3,
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
  private airborneTime = 0;
  private gripRecoveryT = 1;
  private brakeInput = 0;
  private brakeHeldT = 0; // seconds the brake has been held (drives the bite ramp)
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

  get airTimeSeconds(): number {
    return this.airborneTime;
  }

  // Per-render-frame: read input into control state (cheap, idempotent).
  setControls(input: CarInput, boosting: boolean): void {
    this.throttle = input.throttle;
    this.brakeInput = input.brake;
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
    const fwd = this.forwardDir(this.v);
    const vel = this.velocity(this.v2);
    const fwdSpeed = vel.dot(fwd);
    const speedFrac = THREE.MathUtils.clamp(Math.abs(fwdSpeed) / p.cruiseSpeed, 0, 1);
    // Signed slip: angle from the nose to the velocity (about +Y). Positive
    // yaw rotates the nose so slip shrinks when they share a sign.
    const slipAng = Math.atan2(vel.x * fwd.z - vel.z * fwd.x, vel.x * fwd.x + vel.z * fwd.z);
    // How engaged the drift is while braking (0 = straight-line anchor,
    // 1 = full slide): steering intent, or a chassis that is already sideways
    // (so centering the wheel mid-slide doesn't snap the anchor back on).
    const braking = this.brakeInput > 0.05 && fwdSpeed > 0.5;
    const driftEngage = braking
      ? Math.max(
          Math.abs(this.steerInput),
          THREE.MathUtils.clamp(Math.abs(slipAng) / p.driftMaxSlip, 0, 1),
        )
      : 0;
    // Brake pressure ramps in over brakeRamp seconds of HOLDING — a tap or a
    // brake-then-turn-in press only ever feathers (Mario-Kart drift entry
    // costs nothing), while a held straight brake builds to the full anchor.
    this.brakeHeldT = this.brakeInput > 0.05 ? this.brakeHeldT + dt : 0;
    const brakeBuild = braking ? Math.min(1, this.brakeHeldT / p.brakeRamp) : 0;

    // --- Steering: the front wheels ARE the turn now (pure tire physics). The
    // lock eases at speed so the car is agile in town and stable at cruise — a
    // right-angle corner at speed wants the handbrake to break the rear loose. ---
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

    // --- Engine (rear-wheel drive, cruise/boost speed caps). The brake pedal
    // doubles as reverse once the car has (near) stopped, racing-game style. ---
    const speedCap = this.boosting ? p.maxSpeed : p.cruiseSpeed;
    // Straight-line braking overrides gas (racing-game standard — otherwise
    // engine vs brake nearly cancel and the pedal feels dead mid-drive), but
    // the cut fades back in with drift engagement so gas+brake+steer POWERS
    // through the corner. Gas stays commanded; releasing Space relaunches.
    let force = 0;
    if (this.throttle > 0.05 && fwdSpeed < speedCap) {
      // Engine hands off along the same curves: full drive while drifting or
      // before the brake pressure builds, cut once the straight anchor is on.
      const driveScale = braking ? Math.max(driftEngage, 1 - brakeBuild) : 1;
      force = p.engineForce * (this.boosting ? p.boostMultiplier : 1) * this.throttle * driveScale;
    } else if (this.brakeInput > 0.05 && this.throttle <= 0.05 && fwdSpeed <= 0.5) {
      force = -p.engineForce * p.reverseFactor * this.brakeInput; // reverse
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

    // --- Brake: rear-biased, like a handbrake yank — the rear locks and (with
    // the grip cut below) brake+steer breaks the tail into the drift. The
    // fronts carry a smaller share so braking still bites when the rear axle
    // unloads (downhill, crests) — Rapier's wheel brake is friction-limited,
    // and SF is all downhills. The bite fades toward driftBrakeFade as the
    // drift engages: straight Space = full anchor, Space held through a
    // corner = a feather that carries speed. No pedals at all = light coast. ---
    const coast = this.throttle <= 0.05 && this.brakeInput <= 0.05 ? 14 : 0;
    const bite = braking
      ? p.brakeForce *
        this.brakeInput *
        brakeBuild *
        THREE.MathUtils.lerp(1, p.driftBrakeFade, driftEngage)
      : 0;
    this.controller.setWheelBrake(0, coast + bite * 0.4);
    this.controller.setWheelBrake(1, coast + bite * 0.4);
    this.controller.setWheelBrake(2, coast + bite);
    this.controller.setWheelBrake(3, coast + bite);

    // --- Assists ---
    const grounded = this.groundedWheels();
    if (grounded === 0) this.airborneTime += dt;
    else {
      if (this.airborneTime > 0.15) this.gripRecoveryT = 0; // just landed
      this.airborneTime = 0;
      this.gripRecoveryT += dt;
    }

    // Natural grip: load cap + landing fade-in + the brake's rear slide (the
    // drift — cutting the rear tires' grip steps the tail out).
    const staticLoad = (p.mass * GRAVITY) / 4;
    const landingBlend = THREE.MathUtils.clamp(this.gripRecoveryT / p.landingGripTime, 0, 1);
    const landingScale = p.landingGripFactor + (1 - p.landingGripFactor) * landingBlend;
    for (let i = 0; i < 4; i++) {
      const load = Math.max(this.controller.wheelSuspensionForce(i) ?? staticLoad, staticLoad);
      const loadScale = Math.min(1, (p.gripLoadCap * staticLoad) / load);
      let slip = p.frictionSlip * loadScale * landingScale;
      if (this.brakeInput > 0.05 && (i === 2 || i === 3)) slip *= p.driftGrip; // rear breaks loose
      this.controller.setWheelFrictionSlip(i, slip);
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

    // Unstick assist: a pedal held but beached (barely moving, uneven wheel
    // contact) — give a small nudge along the pedal's direction so players
    // never sit trapped on a curb lip or a wreck.
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

    // Drift assist (the brake's one thin cheat): while braking at speed, drive
    // the yaw toward a steer-proportional, CAPPED target. The rear-grip cut
    // above lets the velocity keep sliding, so brake+steer reads as a
    // controlled drift, and at zero steer the same assist damps yaw, so
    // straight-line braking tracks true. The SLIP cap is what makes it a
    // drift and never a spin: as the nose swings away from the velocity, any
    // yaw command that would deepen the slip fades to nothing at driftMaxSlip
    // — the car holds that slide angle — while counter-steer (which shrinks
    // the slip) always keeps full authority.
    if (this.brakeInput > 0.05 && Math.abs(fwdSpeed) > 4) {
      const av = this.chassis.angvel();
      const dir = fwdSpeed >= 0 ? 1 : -1;
      let targetYaw = -this.steerInput * p.driftYawRate * dir;
      if (slipAng * targetYaw < 0) {
        targetYaw *= THREE.MathUtils.clamp(1 - Math.abs(slipAng) / p.driftMaxSlip, 0, 1);
      }
      const gain = Math.min(1, dt * p.driftAssist);
      this.chassis.setAngvel({ x: av.x, y: av.y + (targetYaw - av.y) * gain, z: av.z }, true);
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
