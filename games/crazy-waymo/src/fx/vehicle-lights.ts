import * as THREE from "three";

import { GlowLayer } from "./beacon-lights";

// Headlights and tail lights for the traffic fleet. Only the player's taxi had
// any before, so after dark the city's cars read as parked scenery drifting
// through the streets.
//
// Two additive instanced draws, both rewritten each frame from whichever cars
// are near enough to matter: a billboard layer (two white beams forward, two
// red lamps aft) and a flat pool of light thrown on the road ahead. The pool is
// what actually sells a headlight at chase-camera height — the halo alone reads
// as a floating dot.
//
// Cost is bounded by CAR_BUDGET, not by fleet size: cars are taken nearest-
// first inside GLOW_RANGE, so a dense downtown block costs the same as an empty
// avenue, and in daylight the whole thing is skipped (group hidden, no upload).

/** What this pass needs off a traffic car. `TrafficCar` satisfies it. */
export type LitVehicle = {
  readonly position: THREE.Vector3;
  readonly object3D: THREE.Object3D;
  readonly wrecked: boolean;
};

const CAR_BUDGET = 110; // cars lit per frame, nearest first
// Traffic is the only MOVING light the city has, and from Twin Peaks or the bay
// a string of them crawling down an avenue is what makes the place read as
// inhabited rather than as a lit model. 240u cut that off inside one district;
// the lamps around them already fade at 650 (fx/lamp-glow.ts), so matching that
// costs one more sort and no extra draw call.
const GLOW_RANGE = 420;

// Local offsets, in the car's own frame: +Z is forward (the same convention
// world/terrain.ts slopeQuaternion and the traffic mover use).
const LAMP_SIDE = 0.62;
const HEAD_FWD = 1.6;
const HEAD_UP = 0.55;
const TAIL_FWD = -1.7;
const TAIL_UP = 0.62;
const POOL_FWD = 5.2; // where the beam lands on the road
const HEAD_SIZE = 1.4;
const TAIL_SIZE = 0.8;
const POOL_SIZE = 9;
const POOL_LIFT = 0.09; // over the asphalt, under the kerb paint

const HEAD_COLOR = new THREE.Color(0xfff1cf);
const TAIL_COLOR = new THREE.Color(0xff3a22);
const POOL_COLOR = new THREE.Color(0xffdca6);

const HALO_ALPHA = 0.6;
const POOL_ALPHA = 0.3;
// See fx/lamp-glow.ts: additive layers need HDR colour, not more alpha, to
// clear the night bloom cut. Head lamps run hotter than their own road pool —
// looking INTO oncoming traffic is the shot this is for.
const HALO_GAIN = 3.2;
const POOL_GAIN = 1.7;

const FORWARD = new THREE.Vector3(0, 0, 1);
const SIDES: readonly number[] = [-1, 1];

export class VehicleLights {
  readonly group = new THREE.Group();
  private intensity = { value: 0 };
  /** Vehicle lamps never blink, so this stays at zero — the layer needs it. */
  private time = { value: 0 };
  private halo: GlowLayer;
  private pool: GlowLayer;
  // Scratch — update runs every frame.
  private fwd = new THREE.Vector3();
  private right = new THREE.Vector3();
  private picks: { d2: number; car: LitVehicle }[] = [];

  constructor() {
    this.halo = new GlowLayer({
      capacity: CAR_BUDGET * 4,
      kind: "halo",
      alpha: HALO_ALPHA,
      gain: HALO_GAIN,
      intensity: this.intensity,
      time: this.time,
    });
    this.pool = new GlowLayer({
      capacity: CAR_BUDGET,
      kind: "pool",
      alpha: POOL_ALPHA,
      gain: POOL_GAIN,
      intensity: this.intensity,
      time: this.time,
    });
    this.group.add(this.halo.mesh);
    this.group.add(this.pool.mesh);
    this.group.visible = false;
  }

  setIntensity(night: number): void {
    this.intensity.value = night;
    this.group.visible = night > 0.01;
  }

  update(cars: readonly LitVehicle[], camX: number, camZ: number): void {
    if (!this.group.visible) return;
    const picks = this.picks;
    picks.length = 0;
    const rangeSq = GLOW_RANGE * GLOW_RANGE;
    for (const car of cars) {
      if (car.wrecked) continue; // a wreck's lights are out
      const dx = car.position.x - camX;
      const dz = car.position.z - camZ;
      const d2 = dx * dx + dz * dz;
      if (d2 < rangeSq) picks.push({ d2, car });
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
      // Right-hand lateral in the ground plane; a car on a hill still wants its
      // lamps level across the body, not tipped with the slope normal.
      const right = this.right.set(fwd.z, 0, -fwd.x).normalize();
      const p = car.position;
      for (const side of SIDES) {
        this.halo.push(
          p.x + fwd.x * HEAD_FWD + right.x * LAMP_SIDE * side,
          p.y + HEAD_UP,
          p.z + fwd.z * HEAD_FWD + right.z * LAMP_SIDE * side,
          HEAD_COLOR,
          HEAD_SIZE,
        );
        this.halo.push(
          p.x + fwd.x * TAIL_FWD + right.x * LAMP_SIDE * side,
          p.y + TAIL_UP,
          p.z + fwd.z * TAIL_FWD + right.z * LAMP_SIDE * side,
          TAIL_COLOR,
          TAIL_SIZE,
        );
      }
      this.pool.push(
        p.x + fwd.x * POOL_FWD,
        p.y + POOL_LIFT,
        p.z + fwd.z * POOL_FWD,
        POOL_COLOR,
        POOL_SIZE,
      );
    }
    this.halo.commit();
    this.pool.commit();
  }
}
