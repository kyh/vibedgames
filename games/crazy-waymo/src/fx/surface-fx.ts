import type { DynamicRayCastVehicleController } from "@dimforge/rapier3d-compat";

import type { WheelSurface } from "../world/land-class";

type Tint = Readonly<{ r: number; g: number; b: number }>;
export type PavedSurface = Extract<WheelSurface, "road" | "concrete">;
export type MatterRecipe = Readonly<{
  color: Tint;
  count: number;
  size: number;
  life: number;
  up: number;
  spread: number;
  gravity: number;
  drag: number;
}>;
type PavedProfile = Readonly<{ kind: "paved"; color: Tint; rate: number; minSpeed: number }>;
export type LooseProfile = Readonly<{
  kind: "loose";
  rate: number;
  minSpeed: number;
  dust: MatterRecipe;
  debris: MatterRecipe;
}>;

// Shared normal-blend pool: no extra draw call. At max cadence both tires keep
// fewer than 80 live particles; dust stays below 0.4 s and 0.75u authored size.
export const SURFACE_FX_MAX_RATE = 18;
export const SURFACE_FX_MAX_BURSTS = 2;
type SurfaceProfiles = {
  readonly [Surface in WheelSurface]: Surface extends PavedSurface ? PavedProfile : LooseProfile;
};
export const SURFACE_FX = {
  road: { kind: "paved", color: { r: 0.72, g: 0.72, b: 0.72 }, rate: 30, minSpeed: 3 },
  concrete: { kind: "paved", color: { r: 0.76, g: 0.76, b: 0.72 }, rate: 30, minSpeed: 3 },
  grass: {
    kind: "loose",
    rate: 10,
    minSpeed: 3.5,
    dust: {
      color: { r: 0.36, g: 0.31, b: 0.21 },
      count: 1,
      size: 0.7,
      life: 0.3,
      up: 0.65,
      spread: 0.45,
      gravity: 0.5,
      drag: 3.6,
    },
    debris: {
      color: { r: 0.27, g: 0.38, b: 0.12 },
      count: 3,
      size: 0.22,
      life: 0.38,
      up: 2.1,
      spread: 1.1,
      gravity: 12,
      drag: 2.3,
    },
  },
  sand: {
    kind: "loose",
    rate: 14,
    minSpeed: 3,
    dust: {
      color: { r: 0.62, g: 0.53, b: 0.36 },
      count: 2,
      size: 0.68,
      life: 0.36,
      up: 2.2,
      spread: 1.1,
      gravity: 0.3,
      drag: 2.6,
    },
    debris: {
      color: { r: 0.54, g: 0.43, b: 0.27 },
      count: 2,
      size: 0.12,
      life: 0.28,
      up: 1.4,
      spread: 1.5,
      gravity: 10,
      drag: 2.6,
    },
  },
  dirt: {
    kind: "loose",
    rate: 12,
    minSpeed: 3.5,
    dust: {
      color: { r: 0.42, g: 0.29, b: 0.17 },
      count: 2,
      size: 0.72,
      life: 0.36,
      up: 1.8,
      spread: 0.75,
      gravity: 0,
      drag: 3.5,
    },
    debris: {
      color: { r: 0.29, g: 0.2, b: 0.12 },
      count: 2,
      size: 0.2,
      life: 0.35,
      up: 1.8,
      spread: 0.85,
      gravity: 12,
      drag: 2.4,
    },
  },
  gravel: {
    kind: "loose",
    rate: 11,
    minSpeed: 4,
    dust: {
      color: { r: 0.47, g: 0.44, b: 0.38 },
      count: 1,
      size: 0.65,
      life: 0.28,
      up: 0.5,
      spread: 0.6,
      gravity: 0.6,
      drag: 4,
    },
    debris: {
      color: { r: 0.35, g: 0.34, b: 0.31 },
      count: 3,
      size: 0.18,
      life: 0.36,
      up: 2.2,
      spread: 1.3,
      gravity: 15,
      drag: 1.4,
    },
  },
  rock: {
    kind: "loose",
    rate: 6,
    minSpeed: 6,
    dust: {
      color: { r: 0.43, g: 0.43, b: 0.4 },
      count: 1,
      size: 0.5,
      life: 0.23,
      up: 0.4,
      spread: 0.35,
      gravity: 0.6,
      drag: 4,
    },
    debris: {
      color: { r: 0.3, g: 0.31, b: 0.29 },
      count: 1,
      size: 0.14,
      life: 0.27,
      up: 1.3,
      spread: 0.7,
      gravity: 14,
      drag: 1.5,
    },
  },
} satisfies SurfaceProfiles;

export function isPavedSurface(surface: WheelSurface): surface is PavedSurface {
  return surface === "road" || surface === "concrete";
}

/** Per-wheel cadence. A lost contact or changed material cannot bank a burst. */
export class TireEmissionClock {
  private previous: WheelSurface | null = null;
  private carry = 0;

  step(dt: number, surface: WheelSurface | null, speed: number, stressed: boolean): number {
    if (surface !== this.previous) this.carry = 0;
    this.previous = surface;
    const profile = surface === null ? null : SURFACE_FX[surface];
    const moving = Math.abs(speed);
    if (
      !profile ||
      !Number.isFinite(dt) ||
      dt <= 0 ||
      !Number.isFinite(moving) ||
      moving < profile.minSpeed ||
      (profile.kind === "paved" && !stressed)
    ) {
      this.carry = 0;
      return 0;
    }
    const rate =
      profile.kind === "paved"
        ? profile.rate
        : Math.min(
            SURFACE_FX_MAX_RATE,
            profile.rate * Math.min(1.25, 0.5 + moving / 36) * (stressed ? 1.2 : 1),
          );
    this.carry += Math.min(dt, 0.1) * rate;
    const bursts = Math.floor(this.carry);
    this.carry -= bursts;
    return Math.min(SURFACE_FX_MAX_BURSTS, bursts);
  }
}

type ContactPoint = { x: number; y: number; z: number };
type WheelContacts = Pick<
  DynamicRayCastVehicleController,
  "wheelIsInContact" | "wheelContactPoint"
>;

/** Use immediate ray contacts, not Car.airborne's 120ms crest grace period. */
export function readTireContact(
  controller: WheelContacts | null,
  index: 2 | 3,
  fallbackGrounded: boolean,
  point: ContactPoint,
): boolean {
  if (!controller) return fallbackGrounded;
  return controller.wheelIsInContact(index) && controller.wheelContactPoint(index, point) !== null;
}

/** Throw against actual travel, so reverse and sideways slides tear correctly. */
export function tireThrow(
  velX: number,
  velZ: number,
  out: { x: number; y: number; z: number },
): number {
  const speed = Math.hypot(velX, velZ);
  const inv = speed > 0.001 ? 1 / speed : 0;
  out.x = -velX * inv;
  out.y = 0;
  out.z = -velZ * inv;
  return Math.min(3.8, 1.4 + speed * 0.055);
}
