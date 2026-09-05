import type RAPIER from "@dimforge/rapier3d-compat";
import type { WaterSampler } from "../world/water";
import { DRY_WATER_CONTACT, type FloatingWaterContact, type WaterContact } from "./water-contact";

const FLOAT_CENTER = 0.42;
const GRAVITY = 30;

/** Arcade boat assist on the existing dynamic chassis. The world still owns
 * collisions and fixed stepping; no teleports, extra bodies or surface mesh
 * raycasts. Spring buoyancy and drag settle the hull at the rendered waterline. */
export class Flotation {
  private sampler: WaterSampler | null = null;
  private active = false;
  private readonly contact = {
    kind: "floating",
    waterY: 0,
    immersion: 0,
    entrySpeed: 0,
    entryVerticalSpeed: 0,
  } satisfies FloatingWaterContact;

  constructor(private readonly chassis: RAPIER.RigidBody) {}

  get waterContact(): WaterContact {
    return this.active ? this.contact : DRY_WATER_CONTACT;
  }

  setSampler(sampler: WaterSampler | null): void {
    this.sampler = sampler;
    this.reset();
  }

  reset(): void {
    this.active = false;
  }

  step(dt: number, throttle: number, brake: number, steer: number, boost: boolean): boolean {
    const body = this.chassis;
    const pos = body.translation();
    const waterY = this.sampler?.waterHeightAt(pos.x, pos.z) ?? null;
    // A pier or bridge taxi stays far above this interval. Hysteresis lets
    // shallow shore contact lift the hull smoothly before tires take over.
    if (waterY === null || pos.y > waterY + (this.active ? 1.15 : 0.55)) {
      this.active = false;
      return false;
    }
    let lv = body.linvel();
    if (!this.active) {
      this.active = true;
      this.contact.entrySpeed = Math.hypot(lv.x, lv.z);
      this.contact.entryVerticalSpeed = Math.max(0, -lv.y);
      // A fluid entry sheds vertical impact energy immediately. Without it
      // a high fall travels through several metres of water before buoyancy
      // can respond. Keep horizontal momentum for the splash/skimming entry.
      if (lv.y < -5) {
        body.setLinvel({ x: lv.x, y: -5, z: lv.z }, true);
        lv = body.linvel();
      }
    }
    this.contact.waterY = waterY;
    this.contact.immersion = Math.min(1, Math.max(0, (waterY + 0.8 - pos.y) / 0.8));

    const mass = body.mass();
    const lift = Math.max(
      0,
      Math.min(100, GRAVITY + (waterY + FLOAT_CENTER - pos.y) * 48 - lv.y * 14),
    );
    const q = body.rotation();
    // Quaternion basis columns, projected onto the water plane.
    let fx = 2 * (q.x * q.z + q.w * q.y);
    let fz = 1 - 2 * (q.x * q.x + q.y * q.y);
    const length = Math.hypot(fx, fz);
    if (length > 0.01) {
      fx /= length;
      fz /= length;
    } else {
      fx = 0;
      fz = 1;
    }
    const forward = lv.x * fx + lv.z * fz;
    const lateral = lv.x * fz - lv.z * fx;
    const braking = brake > 0.05 && forward > 0.5;
    const reverse = brake > 0.05 && !braking;
    const desired = reverse ? -5 * brake : (boost ? 12 : 8) * throttle;
    const speedError = desired - forward;
    // Entering from a fast road must shed momentum within a small lake.
    // Fluid drag brakes either travel direction harder than the motor can
    // accelerate; ordinary throttle remains gentle and steering stays useful.
    const accelerationLimit = speedError * forward < 0 ? 24 : 7;
    const passiveDeceleration = Math.min(24, Math.max(0, forward) * 1.8);
    const acceleration = braking
      ? -Math.min(Math.max(passiveDeceleration, 18 * brake), Math.max(0, forward) / dt)
      : Math.max(-accelerationLimit, Math.min(accelerationLimit, speedError * 1.8));
    const sideDrag = lateral * Math.min(4, 1 / dt);
    body.resetForces(true);
    body.addForce(
      {
        x: mass * (fx * acceleration - fz * sideDrag),
        y: mass * lift,
        z: mass * (fz * acceleration + fx * sideDrag),
      },
      true,
    );

    // A damped upright hull keeps pitch/roll impacts physical while steering
    // remains usable at low speed. Reverse uses the same rearward rudder sign.
    const upX = 2 * (q.x * q.y - q.w * q.z);
    const upZ = 2 * (q.y * q.z + q.w * q.x);
    const av = body.angvel();
    const damping = Math.exp(-6 * dt);
    const yaw = -steer * Math.min(1.1, 0.3 + Math.abs(forward) * 0.1) * (forward < -0.25 ? -1 : 1);
    const blend = 1 - Math.exp(-4 * dt);
    body.setAngvel(
      {
        x: av.x * damping - upZ * 8 * dt,
        y: av.y + (yaw - av.y) * blend,
        z: av.z * damping + upX * 8 * dt,
      },
      true,
    );
    return true;
  }
}
