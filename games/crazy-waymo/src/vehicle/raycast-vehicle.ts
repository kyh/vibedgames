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
  // brake — ONE pedal (↓/S/Space). Straight = a plain progressive brake:
  // a CAPPED deceleration applied in velocity space (Rapier wheel-brake
  // torque is bang-bang — any bite that matters locks the wheels and tire
  // friction dumps 60+ u/s², an anchor, not a racing brake). Pressure ramps
  // in over brakeRamp seconds, so a tap or a brake-then-turn-in press only
  // feathers. Pedal + steer = DRIFT (see below) — the drift never brakes.
  brakeDecel: number; // u/s² at full pressure
  brakeRamp: number;
  // drift — Mario Kart architecture: a committed STATE, not emergent tire
  // slip. Entering (pedal + steer at speed) locks a direction; the state then
  // OWNS yaw and the planar velocity direction each step — the nose holds
  // slideAngle INTO the corner while the velocity sweeps an arc whose rate
  // steering only tightens (arcMax) or widens (arcMin). Speed barely decays.
  // Holding the drift charges a mini-turbo: tier 1 at turbo1T seconds, tier 2
  // at turbo2T; releasing fires a forward impulse (turbo1/2Boost). Rapier
  // keeps suspension/collisions/hills the whole time.
  slideAngle: number; // rad the nose points inside the velocity arc — the LOOK
  arcMin: number; // arc rate (rad/s) steering fully AWAY from the drift
  arcMax: number; // arc rate (rad/s) steering fully INTO the drift
  driftDecay: number; // u/s speed bled while drifting (≈0 = MK speed hold)
  turbo1T: number; // seconds of drift to arm mini-turbo tier 1
  turbo2T: number; // seconds of drift to arm tier 2
  turbo1Boost: number; // release impulse (u/s) at tier 1
  turbo2Boost: number; // release impulse (u/s) at tier 2
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
  // Normal steering is deliberately mild (MK rule: corners should make you
  // WANT the drift) — lane changes and sweepers only.
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
  // Drift state: 0 = idle, ±1 = committed direction (sign of steer at entry).
  private driftDir: 0 | 1 | -1 = 0;
  private driftChargeT = 0; // seconds the current drift has been held
  private turboFired: 0 | 1 | 2 = 0; // latched on release; consumed by Car
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

  // --- Drift state (Mario Kart): scene + Car read these for FX/scoring ---
  get isDrifting(): boolean {
    return this.driftDir !== 0;
  }
  get driftDirection(): 0 | 1 | -1 {
    return this.driftDir;
  }
  // 0 charging → 1 tier-1 armed → 2 tier-2 armed
  get driftTier(): 0 | 1 | 2 {
    if (this.driftDir === 0) return 0;
    if (this.driftChargeT >= this.params.turbo2T) return 2;
    if (this.driftChargeT >= this.params.turbo1T) return 1;
    return 0;
  }
  get driftCharge01(): number {
    return this.driftDir === 0 ? 0 : Math.min(1, this.driftChargeT / this.params.turbo1T);
  }
  // One-shot: the tier of the mini-turbo fired on the release this frame.
  consumeMiniTurbo(): 0 | 1 | 2 {
    const t = this.turboFired;
    this.turboFired = 0;
    return t;
  }

  // Per-render-frame: read input into control state (cheap, idempotent).
  setControls(input: CarInput, boosting: boolean): void {
    // Boosting pins the throttle open, so NOS alone launches from a standstill.
    this.throttle = boosting ? 1 : input.throttle;
    this.brakeInput = input.brake;
    this.boosting = boosting;
  }

  teleport(x: number, y: number, z: number, yaw: number): void {
    this.chassis.setTranslation({ x, y, z }, true);
    this.chassis.setRotation({ x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) }, true);
    this.chassis.setLinvel({ x: 0, y: 0, z: 0 }, true);
    this.chassis.setAngvel({ x: 0, y: 0, z: 0 }, true);
    this.currentSteer = 0;
    this.driftDir = 0;
    this.driftChargeT = 0;
    this.turboFired = 0;
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
    const startPlanarSpeed = Math.hypot(vel.x, vel.z); // pre-tire, for the drift's speed hold
    const speedFrac = THREE.MathUtils.clamp(Math.abs(fwdSpeed) / p.cruiseSpeed, 0, 1);

    // ONE pedal state per step, Mario Kart style, priority top-down:
    //   drift   — the state machine owns the car; pedals sit out entirely
    //   brake   — rolling forward with the pedal down: capped velocity decel
    //   reverse — pedal down at (near) standstill: the parking move. Beats the
    //             gas, so a thumb parked on the touch GAS pedal can't block it.
    //   drive   — gas (or boost, which pins the throttle open)
    //   coast   — nothing held: a light roll-off
    const gas = this.throttle > 0.05;
    const pedalDown = this.brakeInput > 0.05;
    const mode = this.driftDir !== 0
      ? "drift"
      : pedalDown && fwdSpeed > 0.5
        ? "brake"
        : pedalDown && fwdSpeed > -p.cruiseSpeed * 0.4
          ? "reverse"
          : gas
            ? "drive"
            : "coast";
    const drifting = mode === "drift";
    // Brake pressure ramps in over brakeRamp seconds of HOLDING — a tap or a
    // brake-then-turn-in press only ever feathers, while a held straight
    // brake builds to the full stop.
    this.brakeHeldT = pedalDown ? this.brakeHeldT + dt : 0;
    const brakeBuild = mode === "brake" ? Math.min(1, this.brakeHeldT / p.brakeRamp) : 0;

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

    // --- Engine (rear-wheel drive, cruise/boost speed caps). Gas stays
    // commanded while braking — it fades with brake pressure and snaps back
    // the moment the pedal lifts, so a brake release relaunches instantly. ---
    const speedCap = this.boosting ? p.maxSpeed : p.cruiseSpeed;
    let force = 0;
    if ((mode === "drive" || mode === "brake") && gas && fwdSpeed < speedCap) {
      force =
        p.engineForce * (this.boosting ? p.boostMultiplier : 1) * this.throttle * (1 - brakeBuild);
    } else if (mode === "reverse") {
      force = -p.engineForce * p.reverseFactor * this.brakeInput;
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

    // --- Wheels never carry the stop (torque brakes lock and anchor-halt
    // the car) — braking decel is applied in velocity space after
    // updateVehicle below. Coasting rolls off gently. ---
    const coast = mode === "coast" ? 14 : 0;
    for (let i = 0; i < 4; i++) this.controller.setWheelBrake(i, coast);

    // --- Assists ---
    const grounded = this.groundedWheels();
    if (grounded === 0) this.airborneTime += dt;
    else {
      if (this.airborneTime > 0.15) this.gripRecoveryT = 0; // just landed
      this.airborneTime = 0;
      this.gripRecoveryT += dt;
    }

    // Natural grip: load cap + landing fade-in. While DRIFTING the tires drop
    // to a token grip so the tire sim can't fight the state's velocity — the
    // slide is scripted, the wheels just roll and hold suspension.
    const staticLoad = (p.mass * GRAVITY) / 4;
    const landingBlend = THREE.MathUtils.clamp(this.gripRecoveryT / p.landingGripTime, 0, 1);
    const landingScale = p.landingGripFactor + (1 - p.landingGripFactor) * landingBlend;
    for (let i = 0; i < 4; i++) {
      const load = Math.max(this.controller.wheelSuspensionForce(i) ?? staticLoad, staticLoad);
      const loadScale = Math.min(1, (p.gripLoadCap * staticLoad) / load);
      this.controller.setWheelFrictionSlip(
        i,
        drifting ? 0.4 : p.frictionSlip * loadScale * landingScale,
      );
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

    // --- Drift state machine (Mario Kart) ---
    // ENTER: pedal + real steer at speed, on the ground. The steer sign at
    // entry commits the drift direction for its whole life. The brake ramp
    // resets at every boundary so the pedal re-arms as a fresh press.
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
      // RELEASE: the payoff — fire the mini-turbo for the tier reached.
      const tier = this.driftTier;
      if (tier > 0) {
        const boost = tier === 2 ? p.turbo2Boost : p.turbo1Boost;
        const f = this.forwardDir(this.v);
        this.chassis.applyImpulse(
          { x: f.x * boost * p.mass, y: 0, z: f.z * boost * p.mass },
          true,
        );
        this.turboFired = tier;
      }
      this.driftDir = 0;
      this.driftChargeT = 0;
      this.brakeHeldT = 0;
    } else if (fwdSpeed < 8 || this.airborneTime > 0.4) {
      // BROKEN: crashed, stalled, or flew off a hill — the charge is lost.
      this.driftDir = 0;
      this.driftChargeT = 0;
      this.brakeHeldT = 0;
    }
    if (this.driftDir !== 0) this.driftChargeT += dt;

    this.controller.updateVehicle(dt);

    // ACTIVE drift, written AFTER updateVehicle so it is the last word on the
    // planar velocity — updateVehicle applies tire impulses IMMEDIATELY (not
    // in world.step), and letting them land after our write bled ~12 u/s of
    // drift speed per second. The state owns yaw and the velocity DIRECTION:
    // the nose holds slideAngle inside the corner (the drift look), steering
    // only tightens/widens the arc, speed decays only by driftDecay. Magnitude
    // is re-read every step, so collisions (world.step) still cost real speed
    // and gravity/suspension stay Rapier's.
    if (this.driftDir !== 0) {
      const dir = this.driftDir;
      const into = (this.steerInput * dir + 1) / 2; // 0 counter .. 1 full into
      const arcRate = THREE.MathUtils.lerp(p.arcMin, p.arcMax, into);
      const av = this.chassis.angvel();
      this.chassis.setAngvel({ x: av.x, y: -dir * arcRate, z: av.z }, true);

      const f = this.forwardDir(this.v);
      const noseHeading = Math.atan2(f.x, f.z);
      const lv = this.chassis.linvel();
      const cur = Math.atan2(lv.x, lv.z);
      const target = noseHeading + dir * p.slideAngle; // velocity trails outside the nose
      const delta = ((target - cur + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
      const heading = cur + delta * Math.min(1, dt * 9);
      // Magnitude from the step's START (before updateVehicle's tire impulses
      // shaved it — conserving the post-tire value bled ~18 u/s of drift), so
      // only driftDecay and real collisions (world.step, read next step) cost
      // speed.
      const speed = Math.max(0, startPlanarSpeed - p.driftDecay * dt);
      this.chassis.setLinvel(
        { x: Math.sin(heading) * speed, y: lv.y, z: Math.cos(heading) * speed },
        true,
      );
    } else if (mode === "brake" && grounded > 0) {
      // Straight-line brake: shave planar speed at a capped rate along the
      // velocity's own direction (racing-game decel, never an anchor).
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
