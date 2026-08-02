import * as THREE from "three";

import { CAR } from "../shared/constants";
import type { Car } from "../vehicle/car";
import { FLAME_HOT, clampAxisToCone } from "./boost-plume";
import type { Fx, FxTier } from "./particles";
import { TIER_FX } from "./particles";
import { scorchTint } from "./skids";
import type { SkidMarks } from "./skids";
import { TIER_COLORS, tierColor } from "./tier";
import type { DriftTrails } from "./trails";

// Sparks visibly slip from the contact patch but stay within ~1.5 m of it.
const SPARK_INHERIT = 0.68;
const SPARK_THROW_BACK = 2.0; // m/s backwards out of the patch
const SPARK_THROW_OUT = 1.6; // m/s away from the turn
const JET_INHERIT = 0.66;
// Promotion burst counts per wheel, indexed by the tier being entered.
const PROMO_BURST = [0, 22, 46] as const;
// Top-tier ground-ring pulse (rate lives in TIER_FX).
const PULSE_R0 = 0.35;
const PULSE_R1 = 3.1;
const PULSE_LIFE = 0.3;
const PULSE_THICKNESS = 0.05;
const PULSE_INTENSITY = 0.95;
// Exhaust rig: rear corners of the SUV body, matching game-scene's
// exhaustFlash anchors, with the plume root biased further back so the ribbon
// mouth hides behind the bumper.
const EXHAUST_BACK = 1.9;
const EXHAUST_SIDE = 0.55;
const EXHAUST_UP = 0.5;
const PLUME_ROOT_BIAS = 0.2;
const PLUME_AXIS_UP = 0.1;
const PLUME_AXIS_SLIP = 0.5; // rad of slip -> lateral axis lean (cone-clamped)
const BURN_RAMP = 0.9; // s to full flame
const BURN_FLOOR = 0.32; // a fresh boost still shows a real tongue
const IGNITE_DEDUPE = 0.24; // s — item-boost + release can land the same frame

// Rear-wheel FX rig: the drift/boost ground effects that hang off the rear
// axle — light-ribbon trails, tier-channel sparks, tire smoke, scorch skids,
// the boost plume pose and the ignition/promotion ring stacks. Extracted from
// the game-scene god object: everything here derives from (car, dt) plus the
// FX systems.
export class VehicleFxRig {
  private sparkCarry = 0;
  private jetCarry = 0;
  private jetSide = 1;
  private pulseClock = 0;
  private puffAccum = 0;
  private kickAccum = 0;
  private prevTier: FxTier = 0;
  private prevBoosting = false;
  private igniteCooldown = 0;
  private boostTime = 0;
  // Last stamped rear-wheel points — each frame extends the streak from here,
  // so marks stay continuous at any speed (per-frame quads read as dashes).
  private lastSkid: { lx: number; lz: number; rx: number; rz: number } | null = null;

  // Scratch: rear-axle frame, recomputed once per update.
  private ax = 0;
  private az = 0;
  private px = 0;
  private pz = 0;
  private tmpColor = new THREE.Color();
  private tmpHot = new THREE.Color();
  private tmpScorch = new THREE.Color();
  private cone = { x: 0, y: 0, z: -1 };
  private dir = { x: 0, z: 0, speed: 0 };

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

    // Promotion: every channel peaks on the raise frame — the in-flight
    // shower recolors, the ring/pool/flares/scorch all spawn in this call.
    const tier: FxTier = drifting ? car.driftTier : 0;
    if (tier > this.prevTier && drifting && !car.airborne) this.firePromotion(car, tier);
    this.prevTier = tier;

    // Boost ignition: rising isBoosting edge covers pad/item boosts too;
    // miniBoostFired flags the drift-release turbo. Deduped — both can land
    // on the same frame.
    this.igniteCooldown = Math.max(0, this.igniteCooldown - dt);
    const ignite = (car.isBoosting && !this.prevBoosting) || car.miniBoostFired;
    this.prevBoosting = car.isBoosting;
    if (ignite && this.igniteCooldown <= 0) {
      this.igniteCooldown = IGNITE_DEDUPE;
      this.fireIgnition(car);
    }
    this.drivePlume(dt, car, fwdX, fwdZ);

    if (drifting || car.isBoosting || brakingHard) this.emitSmoke(dt, car, surface);
    if ((drifting && !car.airborne) || brakingHard) this.stampSkids(car, drifting);
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
    const y = car.position.y;
    this.fx.kickup(this.ax + this.px * 0.7, y, this.az + this.pz * 0.7, surface, power);
    this.fx.kickup(this.ax - this.px * 0.7, y, this.az - this.pz * 0.7, surface, power);
  }

  // Rear-wheel light ribbons: drift slides, charged drifts and boost runs each
  // get their own color; fast grip-cornering leaves a faint streak too.
  private emitTrails(car: Car, drifting: boolean): void {
    const trails = this.getTrails();
    if (!trails || car.airborne) return;
    const cornering = Math.abs(car.slip) > 0.12 && car.speed > 20;
    if (!drifting && !car.isBoosting && !cornering) return;
    // Ribbon color follows the mini-turbo tier: white grind → blue → orange.
    const kind = car.isBoosting || car.driftTier === 2 ? 2 : car.driftTier === 1 ? 1 : 0;
    const strength = Math.min(1, car.speed / CAR.maxSpeed);
    trails.emit(0, this.ax + this.px * 0.7, this.az + this.pz * 0.7, car.heading, kind, strength);
    trails.emit(1, this.ax - this.px * 0.7, this.az - this.pz * 0.7, car.heading, kind, strength);
  }

  // Steady tier shower off the rear wheels. Escalation is SHAPE, not hue:
  // TIER_FX raises rate and core size per tier; the top tier adds the
  // vertical ember jet and the 6.5 Hz ground-ring pulse. Hue rides the live
  // channel (fx.setTierChannel) so grains already in the air repaint on
  // promotion.
  private emitSparks(dt: number, car: Car): void {
    const tier = car.driftTier;
    const t = TIER_FX[tier];
    this.fx.setTierChannel(tierColor(tier));
    const y = car.position.y + 0.25;

    this.sparkCarry += dt * t.rate;
    let n = Math.floor(this.sparkCarry);
    this.sparkCarry -= n;
    n = Math.min(n, 10); // hitch guard: never dump a stalled frame's backlog
    if (n > 0) {
      // Thrown backwards + away from the turn, inheriting most of the car's
      // velocity so the cone swings with the drift angle.
      const outSign = car.slip >= 0 ? -1 : 1;
      const dx =
        car.velX * SPARK_INHERIT -
        Math.sin(car.heading) * SPARK_THROW_BACK +
        this.px * outSign * SPARK_THROW_OUT;
      const dz =
        car.velZ * SPARK_INHERIT -
        Math.cos(car.heading) * SPARK_THROW_BACK +
        this.pz * outSign * SPARK_THROW_OUT;
      const speed = Math.hypot(dx, dz);
      const inv = speed > 1e-4 ? 1 / speed : 0;
      this.dir.x = dx * inv;
      this.dir.z = dz * inv;
      this.dir.speed = speed;
      // Outside wheel throws harder than the inside one.
      const outerLeft = outSign > 0;
      const nl = Math.max(1, Math.round(n * (outerLeft ? 1.25 : 0.75)));
      const nr = Math.max(1, Math.round(n * (outerLeft ? 0.75 : 1.25)));
      this.fx.driftShower(
        this.ax + this.px * 0.8,
        y,
        this.az + this.pz * 0.8,
        tier,
        nl,
        this.dir.x,
        this.dir.z,
        this.dir.speed,
      );
      this.fx.driftShower(
        this.ax - this.px * 0.8,
        y,
        this.az - this.pz * 0.8,
        tier,
        nr,
        this.dir.x,
        this.dir.z,
        this.dir.speed,
      );
    }

    if (t.jet > 0) {
      this.jetCarry += dt * t.jet;
      const nj = Math.min(Math.floor(this.jetCarry), 6);
      this.jetCarry -= Math.floor(this.jetCarry);
      if (nj > 0) {
        this.jetSide = -this.jetSide;
        this.fx.emberJet(
          this.ax + this.px * 0.8 * this.jetSide,
          y,
          this.az + this.pz * 0.8 * this.jetSide,
          nj,
          car.velX * JET_INHERIT,
          car.velZ * JET_INHERIT,
        );
      }
    } else {
      this.jetCarry = 0;
    }

    if (t.pulse > 0) {
      this.pulseClock += dt;
      const interval = 1 / t.pulse;
      if (this.pulseClock >= interval) {
        this.pulseClock -= interval;
        this.tmpColor.set(tierColor(tier));
        this.fx.rings.spawn(
          car.position.x,
          car.position.y + 0.12,
          car.position.z,
          PULSE_R0,
          PULSE_R1,
          PULSE_LIFE,
          PULSE_THICKNESS,
          this.tmpColor,
          PULSE_INTENSITY,
          0.95,
          car.velX,
          car.velZ,
          1.8,
        );
      }
    } else {
      this.pulseClock = 0;
    }
  }

  // Tier promotion — burst + recolor + ring + pool + air flares + scorch, all
  // in one call so they crest on the same frame.
  private firePromotion(car: Car, tier: FxTier): void {
    this.fx.setTierChannel(tierColor(tier)); // repaints the in-flight shower too
    const y = car.position.y;
    const burst = PROMO_BURST[tier];
    const skids = this.getSkids();
    scorchTint(this.tmpColor.set(tierColor(tier)), this.tmpScorch);
    const fwdX = Math.sin(car.heading);
    const fwdZ = Math.cos(car.heading);
    for (const s of [-1, 1] as const) {
      const wx = this.ax + this.px * 0.8 * s;
      const wz = this.az + this.pz * 0.8 * s;
      this.fx.promotionBurst(wx, y + 0.3, wz, tier, burst, car.velX * 0.5, car.velZ * 0.5);
      this.fx.promotionFlare(
        this.ax + this.px * 0.72 * s,
        y + 0.9,
        this.az + this.pz * 0.72 * s,
        tier,
      );
      // One hot scorch kiss under each patch, wider than the running streak.
      skids?.stampSegment(
        wx - fwdX * 0.45,
        wz - fwdZ * 0.45,
        wx + fwdX * 0.45,
        wz + fwdZ * 0.45,
        0.5 + 0.1 * tier,
        this.tmpScorch,
        0.4 + 0.14 * tier,
      );
    }
    this.tmpColor.set(tierColor(tier));
    this.fx.rings.spawn(
      car.position.x,
      y + 0.12,
      car.position.z,
      0.6,
      2.6 + 2.0 * tier,
      0.22 + 0.04 * tier,
      0.06,
      this.tmpColor,
      0.75 + 0.42 * tier,
      0.9,
      car.velX,
      car.velZ,
      1.6,
    );
    this.fx.promotionPool(car.position.x, y, car.position.z, tier, car.velX, car.velZ);
  }

  // Boost ignition: three staggered ground-plane rings (never travel-facing —
  // road-plane from a chase rig reads as a fast edge-on ellipse). The violet
  // accent is the release color reserved by fx/tier.ts; the y+1.05 overtaking
  // front sweeps PAST the lens. The plume spike and game-scene's exhaust
  // flash land on the same frame.
  private fireIgnition(car: Car): void {
    const tier = car.miniTurboTier;
    const x = car.position.x;
    const y = car.position.y;
    const z = car.position.z;
    this.tmpColor.set(TIER_COLORS[2]);
    this.fx.rings.spawn(
      x,
      y + 0.3,
      z,
      0.9,
      7.5 + 2.2 * tier,
      0.34,
      0.055,
      this.tmpColor,
      1.55 + 0.45 * tier,
      0.9,
      car.velX,
      car.velZ,
      1.4,
    );
    this.tmpHot.set(FLAME_HOT);
    this.fx.rings.spawn(
      x,
      y + 0.52,
      z,
      0.5,
      4.8,
      0.24,
      0.075,
      this.tmpHot,
      1.25,
      0.9,
      car.velX,
      car.velZ,
      1.5,
    );
    this.tmpColor.set(TIER_COLORS[2]);
    this.fx.rings.spawn(
      x,
      y + 1.05,
      z,
      2.2,
      9.5 + 2.0 * tier,
      0.2,
      0.035,
      this.tmpColor,
      0.95 + 0.42 * tier,
      0.9,
      car.velX,
      car.velZ,
      1.2,
    );
    this.fx.plume.ignite(0.45 + 0.25 * tier);
    // Sustained sheath keeps the color of the tier that was released; the
    // violet stays reserved for the release moment itself.
    this.tmpColor.set(tier === 1 ? TIER_COLORS[0] : TIER_COLORS[1]);
    this.fx.plume.setTint(this.tmpColor);
  }

  // Plume pose runs every frame: burnTarget 0 lets the ribbon ease out and
  // hide when the boost ends. The axis leans with slip but is clamped into
  // the 18-degree cone about straight-back — the cone, not the length, keeps
  // the flame behind the car.
  private drivePlume(dt: number, car: Car, fwdX: number, fwdZ: number): void {
    if (car.isBoosting) this.boostTime += dt;
    else this.boostTime = 0;
    const burn = car.isBoosting ? Math.min(1, Math.max(BURN_FLOOR, this.boostTime / BURN_RAMP)) : 0;
    const bx = car.position.x - fwdX * (EXHAUST_BACK + PLUME_ROOT_BIAS);
    const bz = car.position.z - fwdZ * (EXHAUST_BACK + PLUME_ROOT_BIAS);
    const y = car.position.y + EXHAUST_UP;
    const lat = Math.max(-0.45, Math.min(0.45, car.slip * PLUME_AXIS_SLIP));
    let axx = -fwdX + this.px * lat;
    let axy = PLUME_AXIS_UP;
    let axz = -fwdZ + this.pz * lat;
    const al = Math.hypot(axx, axy, axz);
    axx /= al;
    axy /= al;
    axz /= al;
    clampAxisToCone(axx, axy, axz, -fwdX, 0, -fwdZ, this.cone);
    this.fx.plume.drive(
      bx - fwdZ * EXHAUST_SIDE,
      y,
      bz + fwdX * EXHAUST_SIDE,
      bx + fwdZ * EXHAUST_SIDE,
      y,
      bz - fwdX * EXHAUST_SIDE,
      this.cone.x,
      this.cone.y,
      this.cone.z,
      burn,
    );
  }

  private emitSmoke(dt: number, car: Car, surface: "road" | "grass" | "sand" | "concrete"): void {
    this.puffAccum += dt;
    if (this.puffAccum < 0.03) return;
    this.puffAccum = 0;
    const y = car.position.y;
    this.fx.driftPuff(this.ax + this.px * 0.7, y, this.az + this.pz * 0.7, car.isBoosting, surface);
    this.fx.driftPuff(this.ax - this.px * 0.7, y, this.az - this.pz * 0.7, car.isBoosting, surface);
  }

  // Drift streaks scorch in the tier's hue (via the multiply-decal tint);
  // straight-line braking keeps plain rubber.
  private stampSkids(car: Car, drifting: boolean): void {
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
      if (drifting) {
        scorchTint(this.tmpColor.set(tierColor(car.driftTier)), this.tmpScorch);
        skids.stampSegment(last.lx, last.lz, now.lx, now.lz, 0.7, this.tmpScorch);
        skids.stampSegment(last.rx, last.rz, now.rx, now.rz, 0.7, this.tmpScorch);
      } else {
        skids.stampSegment(last.lx, last.lz, now.lx, now.lz);
        skids.stampSegment(last.rx, last.rz, now.rx, now.rz);
      }
    }
    this.lastSkid = now;
  }
}
