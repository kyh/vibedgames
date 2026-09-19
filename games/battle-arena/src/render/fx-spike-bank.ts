// One instanced bank behind the spike pool: BANK_SIZE crystals of a single
// geometry, parked below the floor, handed out through a free list.
import * as THREE from "three";

export const BANK_SIZE = 96;

/** One InstancedMesh plus its free list. */
export class Bank {
  readonly mesh: THREE.InstancedMesh;
  readonly free: number[] = [];
  readonly birth: THREE.InstancedBufferAttribute;
  live = 0;
  /** Slots ever handed out since the bank last emptied — the upload/draw prefix. */
  highWater = 0;

  constructor(scene: THREE.Scene, geo: THREE.BufferGeometry, mat: THREE.Material) {
    const seeds = new Float32Array(BANK_SIZE);
    for (let i = 0; i < BANK_SIZE; i += 1) {
      seeds[i] = Math.random() * 100;
    }
    geo.setAttribute("aSeed", new THREE.InstancedBufferAttribute(seeds, 1));
    this.birth = new THREE.InstancedBufferAttribute(new Float32Array(BANK_SIZE), 1);
    this.birth.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute("aBirth", this.birth);

    this.mesh = new THREE.InstancedMesh(geo, mat, BANK_SIZE);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    // No castShadow: the arena's shadow map is baked once and never re-rendered
    // (View sets shadowMap.autoUpdate = false), so a transient eruption could
    // never appear in it — flagging it only risks a depth-program compile.
    this.mesh.receiveShadow = true;
    scene.add(this.mesh);

    const parked = new THREE.Object3D();
    parked.position.set(0, -100, 0);
    parked.scale.setScalar(0.0001);
    parked.updateMatrix();
    const white = new THREE.Color(0xff_ff_ff);
    for (let i = BANK_SIZE - 1; i >= 0; i -= 1) {
      this.free.push(i);
      this.mesh.setMatrixAt(i, parked.matrix);
      // Allocating instanceColor NOW, not on the first spawn: setColorAt adds
      // USE_INSTANCING_COLOR to the program, and doing that lazily throws away
      // the prewarm and recompiles the shader mid-fight.
      this.mesh.setColorAt(i, white);
    }
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.mesh.removeFromParent();
    this.mesh.dispose();
  }
}
