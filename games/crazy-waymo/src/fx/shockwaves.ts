import * as THREE from "three";

// Boost-ignition shockwave: a flat expanding ring at road level. Small pool;
// fire() recycles the oldest.
const RING_POOL = 4;
const RING_LIFE = 0.38;

export class Shockwaves {
  readonly group = new THREE.Group();
  private rings: { mesh: THREE.Mesh; mat: THREE.MeshBasicMaterial; age: number }[] = [];

  constructor() {
    const geo = new THREE.RingGeometry(0.82, 1, 40);
    geo.rotateX(-Math.PI / 2);
    for (let i = 0; i < RING_POOL; i += 1) {
      const mat = new THREE.MeshBasicMaterial({
        blending: THREE.AdditiveBlending,
        color: 0xff_ff_ff,
        depthWrite: false,
        opacity: 0,
        side: THREE.DoubleSide,
        transparent: true,
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.visible = false;
      mesh.renderOrder = 3;
      this.group.add(mesh);
      this.rings.push({ age: RING_LIFE, mat, mesh });
    }
  }

  fire(x: number, y: number, z: number, color: number): void {
    let [oldest] = this.rings;
    for (const r of this.rings) {
      if (oldest === undefined || r.age > oldest.age) {
        oldest = r;
      }
    }
    if (!oldest) {
      return;
    }
    oldest.age = 0;
    oldest.mesh.position.set(x, y + 0.12, z);
    oldest.mat.color.setHex(color);
    oldest.mesh.visible = true;
  }

  update(dt: number): void {
    for (const r of this.rings) {
      if (r.age >= RING_LIFE) {
        if (r.mesh.visible) {
          r.mesh.visible = false;
        }
        continue;
      }
      r.age += dt;
      const t = Math.min(1, r.age / RING_LIFE);
      // fast start, soft finish
      const ease = 1 - (1 - t) * (1 - t);
      const scale = 1.2 + ease * 8.5;
      r.mesh.scale.set(scale, 1, scale);
      r.mat.opacity = 0.85 * (1 - t);
    }
  }
}
