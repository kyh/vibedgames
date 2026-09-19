// Scorch marks stamped on the ground. A small ring of flat quads sharing one
// blob texture; each stamp lingers for a while and then fades out.
import * as THREE from "three";
import { clamp } from "../utils";
import { conformGroundGeometry, terrainHeight } from "../world/terrain";
import { buildBlobShadowTexture } from "./textures";

interface Decal {
  mesh: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  life: number;
}

const POOL = 18;
// Seconds a stamp stays before it starts fading.
const LIFE = 14;
// Seconds of fade-out at the end of a stamp's life.
const FADE = 4;

export class DecalPool {
  private readonly decals: Decal[] = [];
  private cursor = 0;

  constructor(scene: THREE.Scene) {
    const map = buildBlobShadowTexture();
    for (let i = 0; i < POOL; i += 1) {
      const mesh = new THREE.Mesh(
        new THREE.PlaneGeometry(1, 1, 8, 8).rotateX(-Math.PI / 2),
        new THREE.MeshBasicMaterial({
          color: 0,
          depthWrite: false,
          map,
          opacity: 0,
          transparent: true,
        }),
      );
      mesh.visible = false;
      mesh.renderOrder = 1;
      // Flat quads hugging the ground would darken the AO pass around them.
      mesh.userData.noAO = true;
      scene.add(mesh);
      this.decals.push({ life: 0, mesh });
    }
  }

  stamp(x: number, z: number, radius: number): void {
    const decal = this.decals[this.cursor];
    this.cursor = (this.cursor + 1) % this.decals.length;
    if (!decal) {
      return;
    }
    decal.life = LIFE;
    decal.mesh.visible = true;
    // Each slot sits a hair higher than the last so overlapping stamps never z-fight.
    decal.mesh.position.set(x, terrainHeight(x, z) + 0.022 + this.cursor * 8e-4, z);
    decal.mesh.rotation.y = Math.random() * 6.28;
    decal.mesh.scale.set(radius * 1.9, 1, radius * 1.9);
    conformGroundGeometry(decal.mesh.geometry, x, z, radius * 1.9, decal.mesh.rotation.y);
  }

  update(dt: number): void {
    for (const decal of this.decals) {
      if (decal.life <= 0) {
        continue;
      }
      decal.life -= dt;
      decal.mesh.material.opacity = clamp(decal.life / FADE, 0, 1) * 0.55;
      if (decal.life <= 0) {
        decal.mesh.visible = false;
      }
    }
  }
}
