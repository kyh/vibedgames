import * as THREE from "three";

import { FLOOR_Y } from "../shared/constants";
import { CIRCUIT_CELLS, CIRCUIT_GOAL, circuitPearlRemaining } from "../shared/pearl-circuit";
import type { CircuitRun } from "../shared/pearl-circuit";

/** Bounded quiet gold floor rings. One owned draw call; no motion, collision or RNG. */
export class CircuitMarkers {
  private readonly geometry = new THREE.RingGeometry(0.29, 0.35, 32);
  private readonly material = new THREE.MeshBasicMaterial({
    color: 0xbf963b,
    transparent: true,
    opacity: 0.68,
    depthWrite: false,
  });
  private readonly mesh = new THREE.InstancedMesh(this.geometry, this.material, CIRCUIT_GOAL);
  private readonly dummy = new THREE.Object3D();
  private lastMask = 0;
  private disposed = false;

  constructor(scene: THREE.Scene) {
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.count = 0;
    this.mesh.visible = false;
    this.mesh.frustumCulled = false;
    this.dummy.rotation.x = -Math.PI / 2;
    scene.add(this.mesh);
  }

  get count(): number {
    return this.mesh.count;
  }

  /** Only a changed pickup mask rewrites transforms; repeated frame sync is free. */
  sync(run: CircuitRun | null): void {
    if (this.disposed) return;
    const mask = run?.kind === "running" ? run.remainingMask : 0;
    if (mask === this.lastMask) return;
    this.lastMask = mask;
    let count = 0;
    if (run) {
      for (let index = 0; index < CIRCUIT_CELLS.length; index++) {
        const cell = CIRCUIT_CELLS[index];
        if (!cell || !circuitPearlRemaining(run, index)) continue;
        this.dummy.position.set(cell.col, FLOOR_Y + 0.018, cell.row);
        this.dummy.updateMatrix();
        this.mesh.setMatrixAt(count++, this.dummy.matrix);
      }
    }
    this.mesh.count = count;
    this.mesh.visible = count > 0;
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.mesh.count = 0;
    this.mesh.removeFromParent();
    this.mesh.dispose();
    this.geometry.dispose();
    this.material.dispose();
  }
}
