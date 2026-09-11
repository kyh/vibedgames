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
// and stay individual meshes in the scene. Collection swap-removes a slot.
//
// The bob runs in the vertex shader from a per-instance phase and a time
// uniform, so the instance buffer is uploaded when the board changes and
// never per frame: rewriting and re-uploading every matrix each frame is
// the one thing this scene did that the Pixel 10's PowerVR driver did not
// survive, and it was 350 matrix writes a frame for nothing.

export interface PelletCell {
  col: number;
  row: number;
  phase: number;
}

const f = (n: number): string => (Number.isInteger(n) ? `${n}.0` : String(n));

export class PelletField {
  private mesh: THREE.InstancedMesh;
  private live: PelletCell[] = [];
  /** cellKey → index into `live`. */
  private index = new Map<string, number>();
  private dummy = new THREE.Object3D();
  private readonly phase: THREE.InstancedBufferAttribute;
  private readonly time = { value: 0 };

  constructor(scene: THREE.Scene, capacity: number) {
    const geo = new THREE.SphereGeometry(PELLET_RADIUS, 12, 10);
    this.phase = new THREE.InstancedBufferAttribute(new Float32Array(capacity), 1);
    geo.setAttribute("aPhase", this.phase);
    const mat = new THREE.MeshStandardMaterial({
      color: COLORS.pellet,
      emissive: COLORS.pelletGlow,
      emissiveIntensity: 0.35,
      roughness: 0.4,
    });
    const { time } = this;
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uTime = time;
      shader.vertexShader = shader.vertexShader
        .replace(
          "#include <common>",
          "#include <common>\nattribute float aPhase;\nuniform float uTime;",
        )
        .replace(
          "#include <begin_vertex>",
          // Instance-local: the instance matrix is a pure translation, so a
          // local y offset is a world y offset.
          `#include <begin_vertex>\ntransformed.y += sin(uTime * ${f(PELLET_BOB_FREQ)} + aPhase) * ${f(PELLET_BOB_AMP)};`,
        );
    };
    mat.customProgramCacheKey = () => "pellet-bob";
    this.mesh = new THREE.InstancedMesh(geo, mat, capacity);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    scene.add(this.mesh);
  }

  get count(): number {
    return this.live.length;
  }

  reset(cells: readonly PelletCell[]): void {
    this.live = cells.map((c) => ({ ...c }));
    this.index.clear();
    for (const [i, p] of this.live.entries()) {
      this.index.set(cellKey(p.col, p.row), i);
      this.writeSlot(i, p);
    }
    this.commit();
  }

  /** Remove the pellet at a cell. Returns false if the cell has none. */
  collect(col: number, row: number): boolean {
    const key = cellKey(col, row);
    const i = this.index.get(key);
    if (i === undefined) {
      return false;
    }
    const last = this.live.at(-1);
    if (last !== undefined && i < this.live.length - 1) {
      this.live[i] = last;
      this.index.set(cellKey(last.col, last.row), i);
      this.writeSlot(i, last);
    }
    this.live.pop();
    this.index.delete(key);
    this.commit();
    return true;
  }

  /** Advance the bob clock. Nothing is uploaded. */
  update(t: number): void {
    this.time.value = t;
  }

  private writeSlot(i: number, p: PelletCell): void {
    this.dummy.position.set(p.col, 0, p.row);
    this.dummy.updateMatrix();
    this.mesh.setMatrixAt(i, this.dummy.matrix);
    this.phase.setX(i, p.phase);
  }

  private commit(): void {
    this.mesh.count = this.live.length;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.phase.needsUpdate = true;
  }
}
