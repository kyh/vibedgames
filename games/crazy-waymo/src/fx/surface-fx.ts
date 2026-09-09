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
  concrete: { color: { b: 0.72, g: 0.76, r: 0.76 }, kind: "paved", minSpeed: 3, rate: 30 },
  dirt: {
    debris: {
      color: { b: 0.12, g: 0.2, r: 0.29 },
      count: 2,
      drag: 2.4,
      gravity: 12,
      life: 0.35,
      size: 0.2,
      spread: 0.85,
      up: 1.8,
    },
    dust: {
      color: { b: 0.17, g: 0.29, r: 0.42 },
      count: 2,
      drag: 3.5,
      gravity: 0,
      life: 0.36,
      size: 0.72,
      spread: 0.75,
      up: 1.8,
    },
    kind: "loose",
    minSpeed: 3.5,
    rate: 12,
  },
  grass: {
    debris: {
      color: { b: 0.12, g: 0.38, r: 0.27 },
      count: 3,
      drag: 2.3,
      gravity: 12,
      life: 0.38,
      size: 0.22,
      spread: 1.1,
      up: 2.1,
    },
    dust: {
      color: { b: 0.21, g: 0.31, r: 0.36 },
      count: 1,
      drag: 3.6,
      gravity: 0.5,
      life: 0.3,
      size: 0.7,
      spread: 0.45,
      up: 0.65,
    },
    kind: "loose",
    minSpeed: 3.5,
    rate: 10,
  },
  gravel: {
    debris: {
      color: { b: 0.31, g: 0.34, r: 0.35 },
      count: 3,
      drag: 1.4,
      gravity: 15,
      life: 0.36,
      size: 0.18,
      spread: 1.3,
      up: 2.2,
    },
    dust: {
      color: { b: 0.38, g: 0.44, r: 0.47 },
      count: 1,
      drag: 4,
      gravity: 0.6,
      life: 0.28,
      size: 0.65,
      spread: 0.6,
      up: 0.5,
    },
    kind: "loose",
    minSpeed: 4,
    rate: 11,
  },
  road: { color: { b: 0.72, g: 0.72, r: 0.72 }, kind: "paved", minSpeed: 3, rate: 30 },
  rock: {
    debris: {
      color: { b: 0.29, g: 0.31, r: 0.3 },
      count: 1,
      drag: 1.5,
      gravity: 14,
      life: 0.27,
      size: 0.14,
      spread: 0.7,
      up: 1.3,
    },
    dust: {
      color: { b: 0.4, g: 0.43, r: 0.43 },
      count: 1,
      drag: 4,
      gravity: 0.6,
      life: 0.23,
      size: 0.5,
      spread: 0.35,
      up: 0.4,
    },
    kind: "loose",
    minSpeed: 6,
    rate: 6,
  },
  sand: {
    debris: {
      color: { b: 0.27, g: 0.43, r: 0.54 },
      count: 2,
      drag: 2.6,
      gravity: 10,
      life: 0.28,
      size: 0.12,
      spread: 1.5,
      up: 1.4,
    },
    dust: {
      color: { b: 0.36, g: 0.53, r: 0.62 },
      count: 2,
      drag: 2.6,
      gravity: 0.3,
      life: 0.36,
      size: 0.68,
      spread: 1.1,
      up: 2.2,
    },
    kind: "loose",
    minSpeed: 3,
    rate: 14,
  },
} satisfies SurfaceProfiles;

export const isPavedSurface = (surface: WheelSurface): surface is PavedSurface =>
  surface === "road" || surface === "concrete";

/** Per-wheel cadence. A lost contact or changed material cannot bank a burst. */
export class TireEmissionClock {
  private previous: WheelSurface | null = null;
  private carry = 0;

  step(dt: number, surface: WheelSurface | null, speed: number, stressed: boolean): number {
    if (surface !== this.previous) {
      this.carry = 0;
    }
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

interface ContactPoint {
  x: number;
  y: number;
  z: number;
}
type WheelContacts = Pick<
  DynamicRayCastVehicleController,
  "wheelIsInContact" | "wheelContactPoint"
>;

/** Use immediate ray contacts, not Car.airborne's 120ms crest grace period. */
export const readTireContact = (
  controller: WheelContacts | null,
  index: 2 | 3,
  fallbackGrounded: boolean,
  point: ContactPoint,
): boolean => {
  if (!controller) {
    return fallbackGrounded;
  }
  return controller.wheelIsInContact(index) && controller.wheelContactPoint(index, point) !== null;
};

/** Throw against actual travel, so reverse and sideways slides tear correctly. */
export const tireThrow = (
  velX: number,
  velZ: number,
  out: { x: number; y: number; z: number },
): number => {
  const speed = Math.hypot(velX, velZ);
  const inv = speed > 0.001 ? 1 / speed : 0;
  out.x = -velX * inv;
  out.y = 0;
  out.z = -velZ * inv;
  return Math.min(3.8, 1.4 + speed * 0.055);
};
