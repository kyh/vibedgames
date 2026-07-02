// Grounded character locomotion for a Y-up / -Z-forward world (Three.js canonical).
// Produces a per-frame movement *intent* you either commit directly (no physics) or
// pass through the kinematic resolver and then commit the resolved result.
// Approach inspired by GameBlocks (https://github.com/xt4d/GameBlocks).

import { Vector3 } from "three";
import { clamp, smoothingAlpha, smoothToward } from "./math";

const EPS = 1e-6;
const EPS_SQ = EPS * EPS;

// ---------------------------------------------------------------------------
// Orientation frame helpers (Y-up, yaw=0 faces -Z, +yaw turns left / CCW seen
// from above). These are the axis conventions that most often get inverted when
// re-derived from prose — keep them here as the single source of truth.
// ---------------------------------------------------------------------------

export interface Frame {
  forward: Vector3;
  right: Vector3;
  up: Vector3;
}

/** Unit forward direction for a yaw/pitch. yaw=0,pitch=0 → (0, 0, -1). */
export function yawPitchToForward(yaw: number, pitch = 0, target = new Vector3()): Vector3 {
  const cp = Math.cos(pitch);
  return target.set(-Math.sin(yaw) * cp, Math.sin(pitch), -Math.cos(yaw) * cp);
}

/** Unit right direction for a yaw. yaw=0 → (1, 0, 0). */
export function yawToRight(yaw: number, target = new Vector3()): Vector3 {
  return target.set(Math.cos(yaw), 0, -Math.sin(yaw));
}

/** Orthonormal basis for a yaw/pitch(/roll) orientation. */
export function orientationFrame(yaw: number, pitch = 0, roll = 0): Frame {
  const forward = yawPitchToForward(yaw, pitch).normalize();
  const right = yawToRight(yaw).normalize();
  const up = new Vector3().crossVectors(right, forward).normalize();
  if (roll) {
    right.applyAxisAngle(forward, roll).normalize();
    up.applyAxisAngle(forward, roll).normalize();
  }
  return { forward, right, up };
}

/** Yaw that faces the given world direction along the ground plane. Inverse of yawPitchToForward. */
export function forwardToYaw(forward: Vector3): number {
  if (forward.x * forward.x + forward.z * forward.z < EPS_SQ) return 0;
  return Math.atan2(-forward.x, -forward.z);
}

function flattenUnit(value: Vector3, target = new Vector3()): Vector3 {
  target.set(value.x, 0, value.z);
  const lengthSq = target.lengthSq();
  return lengthSq > EPS_SQ ? target.multiplyScalar(1 / Math.sqrt(lengthSq)) : target.set(0, 0, 0);
}

// ---------------------------------------------------------------------------
// Character controller
// ---------------------------------------------------------------------------

export interface CharacterConfig {
  walkSpeed: number;
  sprintSpeed: number;
  crouchSpeed: number;
  /** Smoothing lag (seconds) for accelerating, decelerating, and mid-air control. */
  accelLag: number;
  decelLag: number;
  airAccelLag: number;
  /** Smoothing lag for turning toward a `facing` direction. 0 = snap. */
  turnLag: number;
  gravity: number;
  jumpVelocity: number;
  maxFallSpeed: number;
  pitchMin: number;
  pitchMax: number;
}

export const DEFAULT_CHARACTER_CONFIG: CharacterConfig = {
  walkSpeed: 6,
  sprintSpeed: 9,
  crouchSpeed: 3.2,
  accelLag: 0.04,
  decelLag: 0.05,
  airAccelLag: 0.11,
  turnLag: 0,
  gravity: 9.81,
  jumpVelocity: 8.5,
  maxFallSpeed: 55,
  pitchMin: -1.45,
  pitchMax: 1.45,
};

export interface PlanInput {
  /** World-space horizontal direction to move (need not be unit; zero = stop). */
  moveDirection?: Vector3;
  /** Optional world-space direction to turn toward (used when you aren't setting yaw directly). */
  facing?: Vector3;
  sprint?: boolean;
  crouch?: boolean;
  jump?: boolean;
  /** Absolute yaw to adopt this frame. Defaults to the current yaw. */
  yaw?: number;
  /** Absolute pitch (clamped). Defaults to the current pitch. */
  pitch?: number;
  deltaSeconds: number;
}

export interface MovementIntent {
  startPosition: Vector3;
  desiredDelta: Vector3;
  position: Vector3;
  velocity: Vector3;
  grounded: boolean;
  yaw: number;
  pitch: number;
  deltaSeconds: number;
}

/** Collision outcome from the kinematic resolver, fed back into `commit`. */
export interface ResolvedMovement {
  position: Vector3;
  velocity: Vector3;
  correctedDelta: Vector3;
  grounded: boolean;
}

export interface CharacterState {
  position: Vector3;
  velocity: Vector3;
  grounded: boolean;
  yaw: number;
  pitch: number;
  frame: Frame;
}

export interface CharacterInit {
  position?: Vector3;
  velocity?: Vector3;
  yaw?: number;
  pitch?: number;
  grounded?: boolean;
}

export class CharacterController {
  readonly config: CharacterConfig;
  readonly position = new Vector3();
  readonly velocity = new Vector3();
  yaw = 0;
  pitch = 0;
  grounded = true;

  constructor(config: Partial<CharacterConfig> = {}) {
    this.config = { ...DEFAULT_CHARACTER_CONFIG, ...config };
  }

  setState(init: CharacterInit): this {
    if (init.position) this.position.copy(init.position);
    if (init.velocity) this.velocity.copy(init.velocity);
    if (init.yaw !== undefined) this.yaw = init.yaw;
    if (init.pitch !== undefined)
      this.pitch = clamp(init.pitch, this.config.pitchMin, this.config.pitchMax);
    if (init.grounded !== undefined) this.grounded = init.grounded;
    return this;
  }

  /** Compute the movement this frame. Does NOT mutate the controller — call `commit`. */
  plan(input: PlanInput): MovementIntent {
    const cfg = this.config;
    const dt = input.deltaSeconds;
    const startPosition = this.position.clone();
    const moveDir = flattenUnit(input.moveDirection ?? new Vector3());
    const hasInput = moveDir.lengthSq() > EPS_SQ;
    const targetSpeed = input.crouch
      ? cfg.crouchSpeed
      : input.sprint
        ? cfg.sprintSpeed
        : cfg.walkSpeed;
    const target = moveDir.multiplyScalar(targetSpeed);

    const velocity = this.velocity.clone();
    let grounded = this.grounded;
    const lag = hasInput ? (grounded ? cfg.accelLag : cfg.airAccelLag) : cfg.decelLag;
    velocity.x = smoothToward(velocity.x, target.x, lag, dt);
    velocity.z = smoothToward(velocity.z, target.z, lag, dt);

    if (grounded) {
      velocity.y = 0;
      if (input.jump && !input.crouch) {
        velocity.y = cfg.jumpVelocity;
        grounded = false;
      }
    }
    if (!grounded) {
      velocity.y = Math.max(velocity.y - cfg.gravity * dt, -cfg.maxFallSpeed);
    }

    let yaw = input.yaw ?? this.yaw;
    if (input.facing) {
      const targetYaw = forwardToYaw(flattenUnit(input.facing));
      const delta = Math.atan2(Math.sin(targetYaw - yaw), Math.cos(targetYaw - yaw));
      yaw += delta * smoothingAlpha(cfg.turnLag, dt);
    }
    const pitch = clamp(input.pitch ?? this.pitch, cfg.pitchMin, cfg.pitchMax);

    const desiredDelta = velocity.clone().multiplyScalar(dt);
    return {
      startPosition,
      desiredDelta,
      position: startPosition.clone().add(desiredDelta),
      velocity,
      grounded,
      yaw,
      pitch,
      deltaSeconds: dt,
    };
  }

  /**
   * Apply an intent to the controller. Pass `resolved` when the intent went through
   * the kinematic resolver; omit it for physics-free movement.
   */
  commit(intent: MovementIntent, resolved?: ResolvedMovement): CharacterState {
    const position = (resolved?.position ?? intent.position).clone();
    const velocity = (resolved?.velocity ?? intent.velocity).clone();
    const correctedDelta = resolved?.correctedDelta ?? intent.desiredDelta;
    let grounded = resolved?.grounded ?? intent.grounded;

    // A ceiling clipped the upward move: cancel the remaining upward velocity.
    if (intent.desiredDelta.y > correctedDelta.y + 1e-5 && velocity.y > 0) velocity.y = 0;
    // Still rising into a jump this frame: stay airborne even if the probe says grounded.
    if (!intent.grounded && intent.velocity.y > 0) grounded = false;
    // Landed: drop residual downward velocity so the character doesn't sink.
    if (grounded && velocity.y < 0) velocity.y = 0;

    this.position.copy(position);
    this.velocity.copy(velocity);
    this.grounded = grounded;
    this.yaw = intent.yaw;
    this.pitch = intent.pitch;
    return this.state();
  }

  state(): CharacterState {
    return {
      position: this.position.clone(),
      velocity: this.velocity.clone(),
      grounded: this.grounded,
      yaw: this.yaw,
      pitch: this.pitch,
      frame: orientationFrame(this.yaw, this.pitch),
    };
  }
}
