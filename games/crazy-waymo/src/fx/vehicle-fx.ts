import { CAR } from "../shared/constants";
import type { Car } from "../vehicle/car";
import type { Fx } from "./particles";
import type { SkidMarks } from "./skids";
import type { DriftTrails } from "./trails";

// Rear-wheel FX rig: the drift/boost ground effects that hang off the rear
// axle — light-ribbon trails, tier-colored sparks, tire smoke, rubber skid
// segments. Extracted from the game-scene god object: everything here derives
// from (car, dt) plus the three FX systems, and the four emitters previously
// quadruplicated the same axle math inline.
export class VehicleFxRig {
  private sparkAccum = 0;
  private puffAccum = 0;
  private kickAccum = 0;
  // Last stamped rear-wheel points — each frame extends the streak from here,
  // so marks stay continuous at any speed (per-frame quads read as dashes).
  private lastSkid: { lx: number; lz: number; rx: number; rz: number } | null = null;

  // Scratch: rear-axle frame, recomputed once per update.
  private ax = 0;
  private az = 0;
  private px = 0;
  private pz = 0;

  constructor(
    private readonly fx: Fx,
    private readonly getTrails: () => DriftTrails | null,
    private readonly getSkids: () => SkidMarks | null,
  ) {}

  /** All ground FX for one frame. `drifting` is the scene's slip-gated flag;
   *  `brakingHard` mirrors the drift look for straight-line hard braking;
   *  `surface` switches the off-road kick-up (grass clumps, sand spray). */
  update(
    dt: number,
    car: Car,
    drifting: boolean,
    brakingHard: boolean,
    surface: "road" | "grass" | "sand" | "concrete" = "road",
  ): void {
    const fwdX = Math.sin(car.heading);
    const fwdZ = Math.cos(car.heading);
    this.ax = car.position.x - fwdX * 1.6; // rear axle centre
    this.az = car.position.z - fwdZ * 1.6;
    this.px = -fwdZ; // axle direction (perpendicular to heading)
    this.pz = fwdX;

    if (drifting || car.isBoosting || brakingHard) this.emitSmoke(dt, car);
    if ((drifting && !car.airborne) || brakingHard) this.stampSkids();
    else this.lastSkid = null; // next streak starts fresh, not joined to this one
    this.emitTrails(car, drifting);
    if (drifting && !car.airborne) this.emitSparks(dt, car);
    if ((surface === "grass" || surface === "sand") && !car.airborne && car.speed > 9) {
      this.emitKickup(dt, car, surface);
    }
  }

  // Off-road wheels tear up the ground: steady debris spray off the rear
  // axle, denser with speed — the terrain-change tell the asphalt never has.
  private emitKickup(dt: number, car: Car, surface: "grass" | "sand"): void {
    this.kickAccum += dt;
    const cadence = car.speed > 25 ? 0.05 : 0.09;
    if (this.kickAccum < cadence) return;
    this.kickAccum = 0;
    const power = 1.6 + Math.min(2.2, car.speed * 0.05);
    this.fx.kickup(this.ax + this.px * 0.7, this.az + this.pz * 0.7, surface, power);
    this.fx.kickup(this.ax - this.px * 0.7, this.az - this.pz * 0.7, surface, power);
  }

  // Rear-wheel light ribbons: drift slides, charged drifts and boost runs each
  // get their own color; fast grip-cornering leaves a faint streak too.
  private emitTrails(car: Car, drifting: boolean): void {
    const trails = this.getTrails();
    if (!trails || car.airborne) return;
    const cornering = Math.abs(car.slip) > 0.12 && car.speed > 20;
    if (!drifting && !car.isBoosting && !cornering) return;
    // Ribbon color follows the mini-turbo tier: white grind → cyan → orange.
    const kind = car.isBoosting || car.driftTier === 2 ? 2 : car.driftTier === 1 ? 1 : 0;
    const strength = Math.min(1, car.speed / CAR.maxSpeed);
    trails.emit(0, this.ax + this.px * 0.7, this.az + this.pz * 0.7, car.heading, kind, strength);
    trails.emit(1, this.ax - this.px * 0.7, this.az - this.pz * 0.7, car.heading, kind, strength);
  }

  // Mario-Kart drift sparks: a steady spray off the rear wheels while the
  // drift holds, colored by the charge tier — yellow grind → blue (tier 1
  // armed) → orange (tier 2 armed). The tier-up moments themselves flare in
  // the scene's update loop.
  private emitSparks(dt: number, car: Car): void {
    this.sparkAccum += dt;
    if (this.sparkAccum < 0.05) return;
    this.sparkAccum = 0;
    const tier = car.driftTier;
    const hue = tier === 2 ? 0.07 : tier === 1 ? 0.58 : 0.13;
    const power = 2.6 + tier * 1.2;
    this.fx.burst(this.ax + this.px * 0.8, 0.35, this.az + this.pz * 0.8, hue, 2 + tier, power);
    this.fx.burst(this.ax - this.px * 0.8, 0.35, this.az - this.pz * 0.8, hue, 2 + tier, power);
  }

  private emitSmoke(dt: number, car: Car): void {
    this.puffAccum += dt;
    if (this.puffAccum < 0.03) return;
    this.puffAccum = 0;
    const charged = car.driftCharge >= 1 && car.isDrifting;
    this.fx.driftPuff(this.ax + this.px * 0.7, this.az + this.pz * 0.7, car.isBoosting, charged);
    this.fx.driftPuff(this.ax - this.px * 0.7, this.az - this.pz * 0.7, car.isBoosting, charged);
  }

  private stampSkids(): void {
    const skids = this.getSkids();
    if (!skids) return;
    const now = {
      lx: this.ax + this.px * 0.7,
      lz: this.az + this.pz * 0.7,
      rx: this.ax - this.px * 0.7,
      rz: this.az - this.pz * 0.7,
    };
    const last = this.lastSkid;
    if (last) {
      const d = Math.hypot(now.lx - last.lx, now.lz - last.lz);
      if (d > 4) {
        this.lastSkid = now; // teleport/lag spike — restart the streak
        return;
      }
      if (d < 0.3) return; // too short to matter; wait for more travel
      skids.stampSegment(last.lx, last.lz, now.lx, now.lz);
      skids.stampSegment(last.rx, last.rz, now.rx, now.rz);
    }
    this.lastSkid = now;
  }
}
