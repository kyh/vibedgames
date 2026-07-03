import type { RigidBody } from "@dimforge/rapier3d-compat";
import * as THREE from "three";

import type { ModelCache } from "../assets/loader";
import { modelUrl } from "../assets/manifest";
import type { PhysicsWorld } from "../physics/physics-world";
import type { ParkedSpec } from "../world/furniture";

// Parked cars at the curb. Each is an individual mesh (three frustum-culls it,
// so only nearby ones draw) plus a kinematic Rapier body that stays exactly put
// until the taxi rams it — then it goes dynamic and bounces/tumbles like a
// wreck. No static collision box, so the taxi shoves through instead of walling
// off. Punted cars settle where they land (parked cars don't respawn).

const BODY_LIFT = 0.8; // body centre above the mesh origin (wheels)
const HIT_RADIUS = 2.6;
const OFFSET = new THREE.Vector3();

type Parked = { mesh: THREE.Object3D; body: RigidBody; hit: boolean };

export class ParkedCars {
  readonly group = new THREE.Group();
  private cars: Parked[] = [];
  private tmp = new THREE.Quaternion();

  constructor(
    cache: ModelCache,
    specs: readonly ParkedSpec[],
    private physics: PhysicsWorld,
    heightAt: (x: number, z: number) => number,
  ) {
    for (const s of specs) {
      const mesh = cache.instance(modelUrl("cars", s.model));
      const y = heightAt(s.x, s.z);
      mesh.position.set(s.x, y, s.z);
      mesh.rotation.y = s.yaw;
      mesh.castShadow = true;
      this.group.add(mesh);
      const body = this.physics.createParkedBody(s.x, y + BODY_LIFT, s.z, s.yaw);
      this.cars.push({ mesh, body, hit: false });
    }
  }

  // The taxi rammed near (x,z): punt the closest parked car it's touching.
  // `nx,nz` is the taxi→car contact normal; `impact` the closing speed.
  punt(x: number, z: number, nx: number, nz: number, impact: number): boolean {
    let best: Parked | null = null;
    let bestD = HIT_RADIUS * HIT_RADIUS;
    for (const c of this.cars) {
      const dx = c.mesh.position.x - x;
      const dz = c.mesh.position.z - z;
      const d2 = dx * dx + dz * dz;
      if (d2 < bestD) {
        bestD = d2;
        best = c;
      }
    }
    if (!best) return false;
    if (!best.hit) {
      this.physics.makeDynamic(best.body);
      best.hit = true;
    }
    const shove = Math.max(impact * 0.9, 3.5);
    const v = best.body.linvel();
    best.body.setLinvel(
      { x: v.x * 0.3 + nx * shove, y: Math.max(v.y, Math.min(4, impact * 0.16)), z: v.z * 0.3 + nz * shove },
      true,
    );
    return true;
  }

  // After the physics step: punted cars follow their bodies (parked ones don't
  // move, so their mesh transform is already correct — skip them).
  sync(): void {
    for (const c of this.cars) {
      if (!c.hit) continue;
      const t = c.body.translation();
      const r = c.body.rotation();
      this.tmp.set(r.x, r.y, r.z, r.w);
      c.mesh.quaternion.copy(this.tmp);
      OFFSET.set(0, BODY_LIFT, 0).applyQuaternion(this.tmp);
      c.mesh.position.set(t.x - OFFSET.x, t.y - OFFSET.y, t.z - OFFSET.z);
    }
  }
}
