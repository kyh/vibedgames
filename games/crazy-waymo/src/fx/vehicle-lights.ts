import * as THREE from "three";

import { GlowLayer } from "./glow-layer";

/** What this pass needs off a traffic car. `TrafficCar` satisfies it. */
export interface LitVehicle {
  readonly position: THREE.Vector3;
  readonly object3D: THREE.Object3D;
  readonly wrecked: boolean;
}

const CAR_BUDGET = 110;
const GLOW_RANGE = 420;

const LAMP_SIDE = 0.62;
const HEAD_FWD = 1.6;
const HEAD_UP = 0.55;
const TAIL_FWD = -1.7;
const TAIL_UP = 0.62;
const POOL_FWD = 5.2;
const HEAD_SIZE = 1.4;
const TAIL_SIZE = 0.8;
const POOL_SIZE = 9;
const POOL_LIFT = 0.09;

const HEAD_COLOR = new THREE.Color(0xff_f1_cf);
const TAIL_COLOR = new THREE.Color(0xff_3a_22);
const POOL_COLOR = new THREE.Color(0xff_dc_a6);

const HALO_ALPHA = 0.6;
const POOL_ALPHA = 0.3;
const HALO_GAIN = 3.2;
const POOL_GAIN = 1.7;

const FORWARD = new THREE.Vector3(0, 0, 1);
const SIDES: readonly number[] = [-1, 1];

export class VehicleLights {
  readonly group = new THREE.Group();
  private intensity = { value: 0 };
  private time = { value: 0 };
  private halo: GlowLayer;
  private pool: GlowLayer;
  private fwd = new THREE.Vector3();
  private right = new THREE.Vector3();
  private up = new THREE.Vector3();
  private picks: { d2: number; car: LitVehicle }[] = [];

  constructor() {
    this.halo = new GlowLayer({
      alpha: HALO_ALPHA,
      capacity: CAR_BUDGET * 4,
      gain: HALO_GAIN,
      intensity: this.intensity,
      kind: "halo",
      time: this.time,
    });
    this.pool = new GlowLayer({
      alpha: POOL_ALPHA,
      capacity: CAR_BUDGET,
      gain: POOL_GAIN,
      intensity: this.intensity,
      kind: "pool",
      time: this.time,
    });
    this.group.add(this.halo.mesh);
    this.group.add(this.pool.mesh);
    this.group.visible = false;
  }

  setIntensity(night: number) {
    this.intensity.value = night;
    this.group.visible = night > 0.01;
  }

  update(cars: readonly LitVehicle[], camX: number, camZ: number) {
    if (!this.group.visible) {
      return;
    }

    const { picks } = this;
    picks.length = 0;
    const rangeSq = GLOW_RANGE * GLOW_RANGE;

    for (const car of cars) {
      if (car.wrecked) {
        continue;
      }

      const dx = car.position.x - camX;
      const dz = car.position.z - camZ;
      const d2 = dx * dx + dz * dz;

      if (d2 < rangeSq) {
        picks.push({ car, d2 });
      }
    }

    if (picks.length > CAR_BUDGET) {
      picks.sort((a, b) => a.d2 - b.d2);
      picks.length = CAR_BUDGET;
    }

    this.halo.begin();
    this.pool.begin();

    for (const { car } of picks) {
      const q = car.object3D.quaternion;
      const fwd = this.fwd.copy(FORWARD).applyQuaternion(q);
      const right = this.right.set(1, 0, 0).applyQuaternion(q);
      const up = this.up.set(0, 1, 0).applyQuaternion(q);
      const p = car.position;

      for (const side of SIDES) {
        this.halo.push(
          p.x + fwd.x * HEAD_FWD + right.x * LAMP_SIDE * side + up.x * HEAD_UP,
          p.y + fwd.y * HEAD_FWD + right.y * LAMP_SIDE * side + up.y * HEAD_UP,
          p.z + fwd.z * HEAD_FWD + right.z * LAMP_SIDE * side + up.z * HEAD_UP,
          HEAD_COLOR,
          HEAD_SIZE,
        );
        // oxlint-disable-next-line unicorn/prefer-single-call -- GlowLayer.push takes one light per call, not an array element
        this.halo.push(
          p.x + fwd.x * TAIL_FWD + right.x * LAMP_SIDE * side + up.x * TAIL_UP,
          p.y + fwd.y * TAIL_FWD + right.y * LAMP_SIDE * side + up.y * TAIL_UP,
          p.z + fwd.z * TAIL_FWD + right.z * LAMP_SIDE * side + up.z * TAIL_UP,
          TAIL_COLOR,
          TAIL_SIZE,
        );
      }

      this.pool.push(
        p.x + fwd.x * POOL_FWD + up.x * POOL_LIFT,
        p.y + fwd.y * POOL_FWD + up.y * POOL_LIFT,
        p.z + fwd.z * POOL_FWD + up.z * POOL_LIFT,
        POOL_COLOR,
        POOL_SIZE,
        0,
        up,
      );
    }

    this.halo.commit();
    this.pool.commit();
  }
}
