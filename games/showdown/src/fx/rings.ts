// Expanding shockwave rings laid flat on the ground. Additive, so several can
// overlap around a big blast without muddying each other.
import * as THREE from "three";
import { clamp } from "../utils";

interface Ring {
  mesh: THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>;
  t: number;
  T: number;
  r: number;
}

const POOL = 10;

export class RingPool {
  private readonly rings: Ring[] = [];
  private cursor = 0;

  constructor(scene: THREE.Scene) {
    const geometry = new THREE.RingGeometry(0.82, 1, 64).rotateX(-Math.PI / 2);
    for (let i = 0; i < POOL; i += 1) {
      const mesh = new THREE.Mesh(
        geometry,
        new THREE.MeshBasicMaterial({
          blending: THREE.AdditiveBlending,
          color: 0xff_ff_ff,
          depthWrite: false,
          opacity: 0,
          transparent: true,
        }),
      );
      mesh.visible = false;
      mesh.renderOrder = 6;
      mesh.userData.noAO = true;
      scene.add(mesh);
      this.rings.push({ T: 0, mesh, r: 1, t: 0 });
    }
  }

  spawn(
    x: number,
    z: number,
    radius: number,
    color: THREE.Color,
    duration = 0.4,
    brightness = 3,
  ): void {
    const ring = this.rings[this.cursor];
    this.cursor = (this.cursor + 1) % this.rings.length;
    if (!ring) {
      return;
    }
    ring.t = 0;
    ring.T = duration;
    ring.r = radius;
    ring.mesh.visible = true;
    ring.mesh.position.set(x, 0.09, z);
    ring.mesh.material.color.copy(color).multiplyScalar(brightness);
  }

  update(dt: number): void {
    for (const ring of this.rings) {
      if (!ring.mesh.visible) {
        continue;
      }
      ring.t += dt;
      const t = clamp(ring.t / ring.T, 0, 1);
      // Ease-out: the ring races outward and then coasts.
      const eased = 1 - (1 - t) * (1 - t);
      ring.mesh.scale.setScalar(0.2 + eased * ring.r);
      ring.mesh.material.opacity = (1 - t) * 0.9;
      if (t >= 1) {
        ring.mesh.visible = false;
      }
    }
  }
}
