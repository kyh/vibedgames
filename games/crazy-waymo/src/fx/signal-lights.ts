import * as THREE from "three";

import { ROAD_TILE } from "../shared/constants";
import { controlArms, junctionControl, signalGreen } from "../world/junction-control";
import type { RoadNetwork } from "../world/network";

const ARM_REACH = 0.7;
const HEAD_H = 4.38;
const LAMP_PITCH = 0.24;
const LAMP_SIZE = 0.42;
const GREEN = new THREE.Color(0x2e_cc_4e);
const RED = new THREE.Color(0xe6_3a_28);

type HeightAt = (x: number, z: number) => number;

export class SignalLights {
  readonly mesh: THREE.InstancedMesh;
  private readonly nodes: Int32Array;
  private readonly txs: Float32Array;
  private readonly tzs: Float32Array;
  private readonly xs: Float32Array;
  private readonly ys: Float32Array;
  private readonly zs: Float32Array;
  private readonly states: Int8Array;
  private readonly count: number;

  constructor(network: RoadNetwork, heightAt: HeightAt) {
    interface Spot {
      x: number;
      y: number;
      z: number;
      node: number;
      tx: number;
      tz: number;
    }

    const spots: Spot[] = [];

    for (let n = 0; n < network.nodes.length; n += 1) {
      if (junctionControl(network, n) !== "signal") {
        continue;
      }

      const node = network.nodes[n];

      if (!node) {
        continue;
      }

      for (const a of controlArms(network, n)) {
        const px = a.px + a.tx * 4.6 + a.tz * (a.half + 1.2);
        const pz = a.pz + a.tz * 4.6 - a.tx * (a.half + 1.2);
        const hit = network.nearest(px, pz, ROAD_TILE * 1.4);

        if (hit !== null && hit.dist < hit.edge.half + 0.3) {
          continue;
        }

        const dl = Math.hypot(node[0] - px, node[1] - pz) || 1;
        const dirX = (node[0] - px) / dl;
        const dirZ = (node[1] - pz) / dl;
        spots.push({
          node: n,
          tx: a.tx,
          tz: a.tz,
          x: px + dirX * ARM_REACH,
          y: heightAt(px, pz) + HEAD_H,
          z: pz + dirZ * ARM_REACH,
        });
      }
    }

    this.count = spots.length;
    this.nodes = new Int32Array(this.count);
    this.txs = new Float32Array(this.count);
    this.tzs = new Float32Array(this.count);
    this.xs = new Float32Array(this.count);
    this.ys = new Float32Array(this.count);
    this.zs = new Float32Array(this.count);
    this.states = new Int8Array(this.count).fill(-1);

    const geo = new THREE.BoxGeometry(LAMP_SIZE, LAMP_SIZE, LAMP_SIZE);
    const mat = new THREE.MeshBasicMaterial({ color: 0xff_ff_ff, toneMapped: false });
    this.mesh = new THREE.InstancedMesh(geo, mat, this.count);
    this.mesh.frustumCulled = false;
    const m4 = new THREE.Matrix4();

    for (let i = 0; i < this.count; i += 1) {
      const s = spots[i];

      if (!s) {
        continue;
      }

      this.nodes[i] = s.node;
      this.txs[i] = s.tx;
      this.tzs[i] = s.tz;
      this.xs[i] = s.x;
      this.ys[i] = s.y;
      this.zs[i] = s.z;
      m4.makeTranslation(s.x, s.y + LAMP_PITCH, s.z);
      this.mesh.setMatrixAt(i, m4);
      this.mesh.setColorAt(i, RED);
    }

    this.mesh.instanceMatrix.needsUpdate = true;
  }

  private readonly m4 = new THREE.Matrix4();
  update(t: number) {
    let dirty = false;

    for (let i = 0; i < this.count; i += 1) {
      const green = signalGreen(this.nodes[i] ?? 0, this.txs[i] ?? 0, this.tzs[i] ?? 0, t);
      const state = green ? 1 : 0;

      if (this.states[i] === state) {
        continue;
      }

      this.states[i] = state;
      this.mesh.setColorAt(i, green ? GREEN : RED);
      this.m4.makeTranslation(
        this.xs[i] ?? 0,
        (this.ys[i] ?? 0) + (green ? -LAMP_PITCH : LAMP_PITCH),
        this.zs[i] ?? 0,
      );
      this.mesh.setMatrixAt(i, this.m4);
      this.mesh.instanceMatrix.addUpdateRange(i * 16, 16);
      this.mesh.instanceColor?.addUpdateRange(i * 3, 3);
      dirty = true;
    }

    if (dirty) {
      if (this.mesh.instanceColor) {
        this.mesh.instanceColor.needsUpdate = true;
      }

      this.mesh.instanceMatrix.needsUpdate = true;
    }
  }

  dispose() {
    this.mesh.geometry.dispose();

    if (Array.isArray(this.mesh.material)) {
      for (const m of this.mesh.material) {
        m.dispose();
      }
    } else {
      this.mesh.material.dispose();
    }

    this.mesh.dispose();
  }
}
