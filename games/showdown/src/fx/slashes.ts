import * as THREE from "three";
import { clamp } from "../utils";

const SEGMENTS = 36;
const CAPACITY = 18;

interface Slash {
  mesh: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;
  age: number;
  life: number;
  radius: number;
  arc: number;
  width: number;
  followTime: number;
}

/** Short, directional ribbons: a blade sweep reads differently from a spell blast. */
export class SlashPool {
  private readonly slashes: Slash[] = [];
  private cursor = 0;

  constructor(scene: THREE.Scene) {
    for (let slot = 0; slot < CAPACITY; slot += 1) {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute(
        "position",
        new THREE.BufferAttribute(new Float32Array((SEGMENTS + 1) * 6), 3),
      );
      const indices: number[] = [];
      for (let i = 0; i < SEGMENTS; i += 1) {
        const a = i * 2;
        indices.push(a, a + 1, a + 3, a, a + 3, a + 2);
      }
      geometry.setIndex(indices);
      const mesh = new THREE.Mesh(
        geometry,
        new THREE.MeshBasicMaterial({
          blending: THREE.AdditiveBlending,
          depthWrite: false,
          side: THREE.DoubleSide,
          transparent: true,
        }),
      );
      mesh.visible = false;
      mesh.frustumCulled = false;
      mesh.userData.noAO = true;
      scene.add(mesh);
      this.slashes.push({ age: 0, arc: 0, followTime: 0, life: 0, mesh, radius: 0, width: 0 });
    }
  }

  spawn(
    x: number,
    y: number,
    z: number,
    angle: number,
    radius: number,
    arc: number,
    color: THREE.Color,
    big: boolean,
    followTime: number,
  ): void {
    const slash = this.slashes[this.cursor];
    this.cursor = (this.cursor + 1) % CAPACITY;
    if (!slash) {
      return;
    }
    slash.radius = radius;
    slash.arc = arc;
    slash.width = big ? 0.25 : 0.17;
    slash.age = 0;
    slash.followTime = clamp(followTime, 0.04, 0.3);
    slash.life = slash.followTime + (big ? 0.22 : 0.16);
    slash.mesh.position.set(x, y, z);
    slash.mesh.rotation.y = angle;
    slash.mesh.scale.setScalar(1);
    slash.mesh.material.color.copy(color).multiplyScalar(big ? 2 : 1.4);
    slash.mesh.material.opacity = 0.95;
    slash.mesh.visible = true;
    SlashPool.updateRibbon(slash);
  }

  update(dt: number): void {
    for (const slash of this.slashes) {
      if (!slash.mesh.visible) {
        continue;
      }
      slash.age += dt;
      const t = clamp(slash.age / slash.life, 0, 1);
      SlashPool.updateRibbon(slash);
      const fade = clamp((slash.age - slash.followTime) / (slash.life - slash.followTime), 0, 1);
      slash.mesh.material.opacity = (1 - fade) * (1 - fade) * 0.95;
      slash.mesh.visible = t < 1;
    }
  }

  private static updateRibbon(slash: Slash): void {
    const positions = slash.mesh.geometry.getAttribute("position");
    const travelTime = slash.followTime;
    const progress = clamp(slash.age / travelTime, 0, 1);
    const dissolve = clamp((slash.age - travelTime) / (slash.life - travelTime), 0, 1);
    // The sword arrives at the centre on contact, then cleaves right to left.
    const head = -(slash.arc / 2) * (1 - (1 - progress) ** 2);
    const tail = slash.arc / 2 - dissolve * slash.arc * 0.8;
    for (let i = 0; i <= SEGMENTS; i += 1) {
      const t = i / SEGMENTS;
      const theta = tail + (head - tail) * t;
      const width = Math.sin(t * Math.PI) ** 0.7 * slash.width;
      const inner = slash.radius * (1 - width);
      positions.setXYZ(
        i * 2,
        Math.sin(theta) * inner,
        0.07 * Math.sin(theta),
        Math.cos(theta) * inner,
      );
      positions.setXYZ(
        i * 2 + 1,
        Math.sin(theta) * slash.radius,
        0.07 * Math.sin(theta),
        Math.cos(theta) * slash.radius,
      );
    }
    positions.needsUpdate = true;
  }
}
