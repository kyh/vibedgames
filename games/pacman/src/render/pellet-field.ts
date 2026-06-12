import * as THREE from "three";

import {
  cellKey,
  COLORS,
  PELLET_BOB_AMP,
  PELLET_BOB_FREQ,
  PELLET_RADIUS,
} from "../shared/constants";

// All pearl pellets live in ONE InstancedMesh — the bigger maze holds ~350
// of them, which would otherwise be ~350 draw calls. Power hearts are few
// and stay individual meshes in the scene. Collection swap-removes a slot;
// update() rewrites matrices each frame for the gentle bob (same pattern as
// FxPool).

export type PelletCell = { col: number; row: number; phase: number };

export class PelletField {
  private mesh: THREE.InstancedMesh;
  private live: PelletCell[] = [];
  /** cellKey → index into `live`. */
  private index = new Map<string, number>();
  private dummy = new THREE.Object3D();

  constructor(scene: THREE.Scene, capacity: number) {
    const geo = new THREE.SphereGeometry(PELLET_RADIUS, 12, 10);
    const mat = new THREE.MeshStandardMaterial({
      color: COLORS.pellet,
      emissive: COLORS.pelletGlow,
      emissiveIntensity: 0.35,
      roughness: 0.4,
    });
    this.mesh = new THREE.InstancedMesh(geo, mat, capacity);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    scene.add(this.mesh);
  }

  get count(): number {
    return this.live.length;
  }

  reset(cells: ReadonlyArray<PelletCell>): void {
    this.live = cells.map((c) => ({ ...c }));
    this.index.clear();
    this.live.forEach((p, i) => this.index.set(cellKey(p.col, p.row), i));
  }

  /** Remove the pellet at a cell. Returns false if the cell has none. */
  collect(col: number, row: number): boolean {
    const key = cellKey(col, row);
    const i = this.index.get(key);
    if (i === undefined) return false;
    const last = this.live[this.live.length - 1];
    if (last !== undefined && i < this.live.length - 1) {
      this.live[i] = last;
      this.index.set(cellKey(last.col, last.row), i);
    }
    this.live.pop();
    this.index.delete(key);
    return true;
  }

  /** Rewrite instance matrices for the per-cell bob. Call once per frame. */
  update(t: number): void {
    this.live.forEach((p, i) => {
      this.dummy.position.set(
        p.col,
        Math.sin(t * PELLET_BOB_FREQ + p.phase) * PELLET_BOB_AMP,
        p.row,
      );
      this.dummy.updateMatrix();
      this.mesh.setMatrixAt(i, this.dummy.matrix);
    });
    this.mesh.count = this.live.length;
    this.mesh.instanceMatrix.needsUpdate = true;
  }
}
