import * as THREE from "three";

import { CAR } from "../shared/constants";
import type { Car } from "../vehicle/car";
import type { WheelSurface } from "../world/land-class";
import { FLAME_HOT, clampAxisToCone } from "./boost-plume";
import type { Fx, FxTier } from "./particles";
import { TIER_FX } from "./particles";
import { scorchTint } from "./skids";
import type { SkidMarks } from "./skids";
import { TIER_COLORS, tierColor } from "./tier";
import type { DriftTrails } from "./trails";
import {
  isPavedSurface,
  readTireContact,
  SURFACE_FX,
  TireEmissionClock,
  tireThrow,
} from "./surface-fx";

const SPARK_INHERIT = 0.68;
const SPARK_THROW_BACK = 2;
const SPARK_THROW_OUT = 1.6;
const JET_INHERIT = 0.66;
const PROMO_BURST = [0, 22, 46] as const;
const PULSE_R0 = 0.35;
const PULSE_R1 = 3.1;
const PULSE_LIFE = 0.3;
const PULSE_THICKNESS = 0.05;
const PULSE_INTENSITY = 0.95;
const EXHAUST_BACK = 1.9;
const EXHAUST_SIDE = 0.55;
const EXHAUST_UP = 0.5;
const PLUME_ROOT_BIAS = 0.2;
const PLUME_AXIS_UP = 0.1;
const PLUME_AXIS_SLIP = 0.5;
const BURN_RAMP = 0.9;
const BURN_FLOOR = 0.32;
const IGNITE_DEDUPE = 0.24;

interface RearContacts {
  grounded: boolean;
  left: WheelSurface | null;
  paved: boolean;
  right: WheelSurface | null;
}

const trailKind: (car: Car) => 0 | 1 | 2 = (car) => {
  if (car.isBoosting || car.driftTier === 2) {
    return 2;
  }

  return car.driftTier === 1 ? 1 : 0;
};

export class VehicleFxRig {
  private sparkCarry = 0;
  private jetCarry = 0;
  private jetSide = 1;
  private pulseClock = 0;
  private readonly leftTire = new TireEmissionClock();
  private readonly rightTire = new TireEmissionClock();
  private readonly leftContact = new THREE.Vector3();
  private readonly rightContact = new THREE.Vector3();
  private readonly throwDirection = { x: 0, y: 0, z: 0 };
  private prevTier: FxTier = 0;
  private prevBoosting = false;
  private igniteCooldown = 0;
  private boostTime = 0;
  private lastSkid: { lx: number; lz: number; rx: number; rz: number } | null = null;

  private ax = 0;
  private ay = 0;
  private az = 0;
  private px = 0;
  private py = 0;
  private pz = 0;
  private readonly forward = new THREE.Vector3();
  private readonly left = new THREE.Vector3();
  private readonly up = new THREE.Vector3();
  private readonly tmpColor = new THREE.Color();
  private readonly tmpHot = new THREE.Color();
  private readonly tmpScorch = new THREE.Color();
  private readonly cone = { x: 0, y: 0, z: -1 };
  private readonly dir = { speed: 0, x: 0, z: 0 };
  private readonly contacts: RearContacts = {
    grounded: false,
    left: null,
    paved: false,
    right: null,
  };

  private readonly fx: Fx;
  private readonly getTrails: () => DriftTrails | null;
  private readonly getSkids: () => SkidMarks | null;

  constructor(fx: Fx, getTrails: () => DriftTrails | null, getSkids: () => SkidMarks | null) {
    this.fx = fx;
    this.getTrails = getTrails;
    this.getSkids = getSkids;
  }

  /** All ground FX for one frame. `drifting` is the scene's slip-gated flag;
   *  `brakingHard` mirrors the drift look for straight-line hard braking;
   *  `surfaceAt` samples each contact independently, including its deck height. */
  update(
    dt: number,
    car: Car,
    drifting: boolean,
    brakingHard: boolean,
    surfaceAt: (x: number, z: number, y: number) => WheelSurface,
  ) {
    const water = car.waterContact;
    this.fx.water.contact(
      dt,
      water,
      car.position.x,
      car.position.y,
      car.position.z,
      car.velX,
      car.velZ,
    );
    const floating = water.kind === "floating";
    const q = car.object3D.quaternion;
    const forward = this.forward.set(0, 0, 1).applyQuaternion(q);
    const left = this.left.set(-1, 0, 0).applyQuaternion(q);
    this.up.set(0, 1, 0).applyQuaternion(q);
    this.ax = car.position.x - forward.x * 1.6;
    this.ay = car.position.y - forward.y * 1.6;
    this.az = car.position.z - forward.z * 1.6;
    this.px = left.x;
    this.py = left.y;
    this.pz = left.z;

    this.readContacts(car, floating, surfaceAt);
    const { grounded, left: leftSurface, paved, right: rightSurface } = this.contacts;

    const tier: FxTier = drifting && !floating ? car.driftTier : 0;

    if (tier > this.prevTier && drifting && grounded) {
      this.firePromotion(car, tier, paved);
    }

    this.prevTier = tier;

    this.igniteCooldown = Math.max(0, this.igniteCooldown - dt);
    const ignite = (car.isBoosting && !this.prevBoosting) || car.miniBoostFired;
    this.prevBoosting = car.isBoosting;

    if (ignite && this.igniteCooldown <= 0) {
      this.igniteCooldown = IGNITE_DEDUPE;
      this.fireIgnition(car);
    }

    this.drivePlume(dt, car);

    const stressed = drifting || car.isBoosting || brakingHard;
    const power = tireThrow(car.velX, car.velZ, this.throwDirection);
    this.emitTire(dt, car, this.leftTire, this.leftContact, leftSurface, stressed, power);
    this.emitTire(dt, car, this.rightTire, this.rightContact, rightSurface, stressed, power);

    if (paved && (drifting || brakingHard)) {
      this.stampSkids(car, drifting);
    } else {
      this.lastSkid = null;
    }

    this.emitTrails(car, drifting, paved);

    if (drifting && paved) {
      this.emitSparks(dt, car);
    } else {
      this.sparkCarry = 0;
      this.jetCarry = 0;
      this.pulseClock = 0;
    }
  }

  private readContacts(
    car: Car,
    floating: boolean,
    surfaceAt: (x: number, z: number, y: number) => WheelSurface,
  ) {
    this.leftContact.set(this.ax + this.px * 0.7, this.ay + this.py * 0.7, this.az + this.pz * 0.7);
    this.rightContact.set(
      this.ax - this.px * 0.7,
      this.ay - this.py * 0.7,
      this.az - this.pz * 0.7,
    );
    const controller = car.physicsVehicle?.controller ?? null;

    const leftGrounded =
      !floating && readTireContact(controller, 2, !car.airborne, this.leftContact);

    const rightGrounded =
      !floating && readTireContact(controller, 3, !car.airborne, this.rightContact);

    const leftSurface = leftGrounded
      ? surfaceAt(this.leftContact.x, this.leftContact.z, this.leftContact.y)
      : null;

    const rightSurface = rightGrounded
      ? surfaceAt(this.rightContact.x, this.rightContact.z, this.rightContact.y)
      : null;

    this.contacts.left = leftSurface;
    this.contacts.right = rightSurface;
    this.contacts.paved =
      leftSurface !== null &&
      rightSurface !== null &&
      isPavedSurface(leftSurface) &&
      isPavedSurface(rightSurface);
    this.contacts.grounded = leftGrounded || rightGrounded;
  }

  private emitTire(
    dt: number,
    car: Car,
    clock: TireEmissionClock,
    point: THREE.Vector3,
    surface: WheelSurface | null,
    stressed: boolean,
    power: number,
  ) {
    const bursts = clock.step(dt, surface, car.speed, stressed);

    if (surface === null) {
      return;
    }

    for (let i = 0; i < bursts; i += 1) {
      if (isPavedSurface(surface)) {
        this.fx.driftPuff(point.x, point.y, point.z, car.isBoosting, surface);
      } else {
        this.fx.kickup(point.x, point.y, point.z, SURFACE_FX[surface], this.throwDirection, power);
      }
    }
  }

  private emitTrails(car: Car, drifting: boolean, pavedContact: boolean) {
    const trails = this.getTrails();

    if (!trails) {
      return;
    }

    const cornering = Math.abs(car.slip) > 0.12 && car.speed > 20;

    if (!pavedContact || (!drifting && !car.isBoosting && !cornering)) {
      trails.break();

      return;
    }

    const kind = trailKind(car);
    const strength = Math.min(1, car.speed / CAR.maxSpeed);
    trails.emit(0, this.ax + this.px * 0.7, this.az + this.pz * 0.7, car.heading, kind, strength);
    trails.emit(1, this.ax - this.px * 0.7, this.az - this.pz * 0.7, car.heading, kind, strength);
  }

  private emitSparks(dt: number, car: Car) {
    const tier = car.driftTier;
    const t = TIER_FX[tier];
    this.fx.setTierChannel(tierColor(tier));
    const y = this.ay + 0.25;

    this.sparkCarry += dt * t.rate;
    let n = Math.floor(this.sparkCarry);
    this.sparkCarry -= n;
    n = Math.min(n, 10);

    if (n > 0) {
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
      const outerLeft = outSign > 0;
      const nl = Math.max(1, Math.round(n * (outerLeft ? 1.25 : 0.75)));
      const nr = Math.max(1, Math.round(n * (outerLeft ? 0.75 : 1.25)));
      this.fx.driftShower(
        this.ax + this.px * 0.8,
        y + this.py * 0.8,
        this.az + this.pz * 0.8,
        tier,
        nl,
        this.dir.x,
        this.dir.z,
        this.dir.speed,
      );
      this.fx.driftShower(
        this.ax - this.px * 0.8,
        y - this.py * 0.8,
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

  private firePromotion(car: Car, tier: FxTier, paved: boolean) {
    this.fx.setTierChannel(tierColor(tier));
    const { y } = car.position;
    const burst = PROMO_BURST[tier];
    const skids = paved ? this.getSkids() : null;
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
      2.6 + 2 * tier,
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

  private fireIgnition(car: Car) {
    const tier = car.miniTurboTier;
    const { x } = car.position;
    const { y } = car.position;
    const { z } = car.position;
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
      9.5 + 2 * tier,
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
    this.tmpColor.set(tier === 1 ? TIER_COLORS[0] : TIER_COLORS[1]);
    this.fx.plume.setTint(this.tmpColor);
  }

  private drivePlume(dt: number, car: Car) {
    if (car.isBoosting) {
      this.boostTime += dt;
    } else {
      this.boostTime = 0;
    }

    const spd = Math.hypot(car.velX, car.velZ);
    const spdScale = 0.4 + 0.6 * Math.min(1, Math.max(0, (spd - 3) / 11));

    const burn = car.isBoosting
      ? Math.min(1, Math.max(BURN_FLOOR, this.boostTime / BURN_RAMP)) * spdScale
      : 0;

    const fwd = this.forward;
    const { up } = this;
    const back = EXHAUST_BACK + PLUME_ROOT_BIAS;
    const bx = car.position.x - fwd.x * back + up.x * EXHAUST_UP;
    const by = car.position.y - fwd.y * back + up.y * EXHAUST_UP;
    const bz = car.position.z - fwd.z * back + up.z * EXHAUST_UP;
    const lat = Math.max(-0.45, Math.min(0.45, car.slip * PLUME_AXIS_SLIP));
    let axx = -fwd.x + this.px * lat + up.x * PLUME_AXIS_UP;
    let axy = -fwd.y + this.py * lat + up.y * PLUME_AXIS_UP;
    let axz = -fwd.z + this.pz * lat + up.z * PLUME_AXIS_UP;
    const al = Math.hypot(axx, axy, axz);
    axx /= al;
    axy /= al;
    axz /= al;
    clampAxisToCone(axx, axy, axz, -fwd.x, -fwd.y, -fwd.z, this.cone);
    this.fx.plume.drive(
      bx + this.px * EXHAUST_SIDE,
      by + this.py * EXHAUST_SIDE,
      bz + this.pz * EXHAUST_SIDE,
      bx - this.px * EXHAUST_SIDE,
      by - this.py * EXHAUST_SIDE,
      bz - this.pz * EXHAUST_SIDE,
      this.cone.x,
      this.cone.y,
      this.cone.z,
      burn,
    );
  }

  private stampSkids(car: Car, drifting: boolean) {
    const skids = this.getSkids();

    if (!skids) {
      return;
    }

    const now = {
      lx: this.leftContact.x,
      lz: this.leftContact.z,
      rx: this.rightContact.x,
      rz: this.rightContact.z,
    };

    const last = this.lastSkid;

    if (last) {
      const d = Math.hypot(now.lx - last.lx, now.lz - last.lz);

      if (d > 4) {
        this.lastSkid = now;

        return;
      }

      if (d < 0.3) {
        return;
      }

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
