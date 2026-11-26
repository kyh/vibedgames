import * as THREE from "three";

import {
  cellKey,
  COLORS,
  PELLET_BOB_AMP,
  PELLET_BOB_FREQ,
  PELLET_RADIUS,
} from "../shared/constants";

export interface PelletCell {
  col: number;
  row: number;
  phase: number;
}

const f = (n: number) => (Number.isInteger(n) ? `${n}.0` : String(n));

export class PelletField {
  private readonly mesh: THREE.InstancedMesh;
  private live: PelletCell[] = [];
  private readonly index = new Map<string, number>();
  private readonly dummy = new THREE.Object3D();
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
          `#include <begin_vertex>\ntransformed.y += sin(uTime * ${f(PELLET_BOB_FREQ)} + aPhase) * ${f(PELLET_BOB_AMP)};`,
        );
    };

    mat.customProgramCacheKey = () => "pellet-bob";
    this.mesh = new THREE.InstancedMesh(geo, mat, capacity);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    scene.add(this.mesh);
  }

  get count() {
    return this.live.length;
  }

  /** Pellets still on the board. */
  get cells() {
    return this.live;
  }

  reset(cells: readonly PelletCell[]) {
    this.live = cells.map((c) => ({ ...c }));
    this.index.clear();

    for (const [i, p] of this.live.entries()) {
      this.index.set(cellKey(p.col, p.row), i);
      this.writeSlot(i, p);
    }

    this.commit();
  }

  /** Remove the pellet at a cell. Returns false if the cell has none. */
  collect(col: number, row: number) {
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
  update(t: number) {
    this.time.value = t;
  }

  private writeSlot(i: number, p: PelletCell) {
    this.dummy.position.set(p.col, 0, p.row);
    this.dummy.updateMatrix();
    this.mesh.setMatrixAt(i, this.dummy.matrix);
    this.phase.setX(i, p.phase);
  }

  private commit() {
    this.mesh.count = this.live.length;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.phase.needsUpdate = true;
  }
}
