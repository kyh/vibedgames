// Pooled expanding shockwave rings, flat on the table plane. Scale eases
// out (cubic) while opacity falls linearly — through the dither pass the
// fading ring reads as a widening band of speckle. Reserve the big spawn
// for goals; the small one marks paddle contact.

import * as THREE from "three";

import { INK } from "../shared/constants";

export interface RingOptions {
  x: number;
  y: number;
  /** Starting scale (the ring's outer radius in world units). */
  from: number;
  /** Final scale, reached with a cubic ease-out as life ends. */
  to: number;
  /** Expansion time in seconds. */
  life: number;
  /** Starting opacity; fades linearly to 0 over life. */
  opacity: number;
}

interface Ring {
  mesh: THREE.Mesh;
  material: THREE.MeshBasicMaterial;
  age: number;
  life: number;
  from: number;
  to: number;
  opacity: number;
}

export class RingPool {
  private readonly rings: Ring[] = [];

  constructor(scene: THREE.Scene, max = 4) {
    const geometry = new THREE.RingGeometry(0.82, 1, 48);
    for (let i = 0; i < max; i += 1) {
      const material = new THREE.MeshBasicMaterial({
        color: INK,
        depthWrite: false,
        opacity: 0,
        transparent: true,
      });
      const mesh = new THREE.Mesh(geometry, material);
      mesh.visible = false;
      scene.add(mesh);
      this.rings.push({ age: 0, from: 0, life: 1, material, mesh, opacity: 0, to: 1 });
    }
  }

  spawn(opts: RingOptions): void {
    const ring = this.rings.find((r) => !r.mesh.visible) ?? this.rings[0];
    if (!ring) {
      return;
    }
    ring.mesh.visible = true;
    ring.mesh.position.set(opts.x, opts.y, 0.015);
    ring.mesh.scale.setScalar(opts.from);
    ring.age = 0;
    ring.life = opts.life;
    ring.from = opts.from;
    ring.to = opts.to;
    ring.opacity = opts.opacity;
    ring.material.opacity = opts.opacity;
  }

  update(dt: number): void {
    for (const ring of this.rings) {
      if (!ring.mesh.visible) {
        continue;
      }
      ring.age += dt;
      const p = Math.min(1, ring.age / ring.life);
      if (p >= 1) {
        ring.mesh.visible = false;
        ring.material.opacity = 0;
        continue;
      }
      const eased = 1 - (1 - p) ** 3;
      ring.mesh.scale.setScalar(ring.from + (ring.to - ring.from) * eased);
      ring.material.opacity = ring.opacity * (1 - p);
    }
  }
}
