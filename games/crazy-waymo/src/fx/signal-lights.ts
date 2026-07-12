import * as THREE from "three";

import { ROAD_TILE } from "../shared/constants";
import { controlArms, junctionControl, signalGreen } from "../world/junction-control";
import type { RoadNetwork } from "../world/network";

// Live traffic-signal lamps. The KayKit signal poles are baked static
// geometry, so the lamp state rides on top as a runtime InstancedMesh of
// small emissive boxes — one per signal head, snapped to where the pole's
// arm holds the housing. Colors flip on the SAME junction-control cycle the
// traffic AI obeys, so what the player sees is what the cars do.

// Head placement relative to the pole base, derived from the kk-trafficlight
// model (bbox x -0.135..0.04 at height 0.73, scaled to 5u tall in furniture):
// the arm reaches ~0.9u from the base toward the junction, housing ~4.4u up.
const ARM_REACH = 0.7;
const HEAD_H = 4.38;
// The lit box sits where the matching housing lamp is: top when red,
// bottom when green (the housing's lamp pitch at furniture's 5u scale).
const LAMP_PITCH = 0.24;
const LAMP_SIZE = 0.42;
const GREEN = new THREE.Color(0x2ecc4e);
const RED = new THREE.Color(0xe63a28);

type HeightAt = (x: number, z: number) => number;

export class SignalLights {
  readonly mesh: THREE.InstancedMesh;
  private readonly nodes: Int32Array;
  private readonly txs: Float32Array; // approach tangent (outward) per lamp
  private readonly tzs: Float32Array;
  private readonly xs: Float32Array; // head anchor (housing centre)
  private readonly ys: Float32Array;
  private readonly zs: Float32Array;
  private readonly states: Int8Array; // -1 unset, 0 red, 1 green
  private readonly count: number;

  constructor(network: RoadNetwork, heightAt: HeightAt) {
    type Spot = { x: number; y: number; z: number; node: number; tx: number; tz: number };
    const spots: Spot[] = [];
    for (let n = 0; n < network.nodes.length; n++) {
      if (junctionControl(network, n) !== "signal") continue;
      const node = network.nodes[n];
      if (!node) continue;
      for (const a of controlArms(network, n)) {
        // Mirror furniture.ts placement exactly (pole on the right of the
        // approach, past the crosswalk) including its skip-on-asphalt test —
        // a lamp with no pole under it floats.
        const px = a.px + a.tx * 4.6 + a.tz * (a.half + 1.2);
        const pz = a.pz + a.tz * 4.6 - a.tx * (a.half + 1.2);
        const hit = network.nearest(px, pz, ROAD_TILE * 1.4);
        if (hit !== null && hit.dist < hit.edge.half + 0.3) continue;
        const dl = Math.hypot(node[0] - px, node[1] - pz) || 1;
        const dirX = (node[0] - px) / dl;
        const dirZ = (node[1] - pz) / dl;
        spots.push({
          x: px + dirX * ARM_REACH,
          y: heightAt(px, pz) + HEAD_H,
          z: pz + dirZ * ARM_REACH,
          node: n,
          tx: a.tx,
          tz: a.tz,
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
    // Basic material: the lamp is a light source — full brightness day and
    // night, no tone-mapped dimming.
    const mat = new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false });
    this.mesh = new THREE.InstancedMesh(geo, mat, this.count);
    this.mesh.frustumCulled = false;
    const m4 = new THREE.Matrix4();
    for (let i = 0; i < this.count; i++) {
      const s = spots[i];
      if (!s) continue;
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

  // Flip lamps to match the signal cycle at time t (the traffic sim clock):
  // color changes AND the box slides to the matching housing lamp (top red,
  // bottom green). Buffers only re-upload when at least one lamp changed.
  private readonly m4 = new THREE.Matrix4();
  update(t: number): void {
    let dirty = false;
    for (let i = 0; i < this.count; i++) {
      const green = signalGreen(this.nodes[i] ?? 0, this.txs[i] ?? 0, this.tzs[i] ?? 0, t);
      const state = green ? 1 : 0;
      if (this.states[i] === state) continue;
      this.states[i] = state;
      this.mesh.setColorAt(i, green ? GREEN : RED);
      this.m4.makeTranslation(
        this.xs[i] ?? 0,
        (this.ys[i] ?? 0) + (green ? -LAMP_PITCH : LAMP_PITCH),
        this.zs[i] ?? 0,
      );
      this.mesh.setMatrixAt(i, this.m4);
      dirty = true;
    }
    if (dirty) {
      if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
      this.mesh.instanceMatrix.needsUpdate = true;
    }
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    if (Array.isArray(this.mesh.material)) {
      for (const m of this.mesh.material) m.dispose();
    } else {
      this.mesh.material.dispose();
    }
    this.mesh.dispose();
  }
}
