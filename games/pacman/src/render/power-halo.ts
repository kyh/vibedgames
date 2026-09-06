import * as THREE from "three";

import { COLORS, FLOOR_Y, SCARED_MS, SCARED_WARN_MS } from "../shared/constants";

const SEGMENTS = 80;

/** Two fixed floor meshes. The arc reads the existing power clock, never owns one. */
export class PowerHalo {
  private group = new THREE.Group();
  private arcGeometry = new THREE.RingGeometry(0.6, 0.69, SEGMENTS, 1, Math.PI / 2);
  private arcMaterial = new THREE.MeshBasicMaterial({
    color: COLORS.power,
    transparent: true,
    opacity: 0.9,
    depthWrite: false,
    side: THREE.DoubleSide,
  });

  constructor(scene: THREE.Scene) {
    const track = new THREE.Mesh(
      new THREE.RingGeometry(0.59, 0.7, SEGMENTS),
      new THREE.MeshBasicMaterial({
        color: COLORS.power,
        transparent: true,
        opacity: 0.18,
        depthWrite: false,
        side: THREE.DoubleSide,
      }),
    );
    const arc = new THREE.Mesh(this.arcGeometry, this.arcMaterial);
    arc.position.z = 0.002;
    this.group.add(track, arc);
    this.group.rotation.x = -Math.PI / 2;
    this.group.visible = false;
    scene.add(this.group);
  }

  update(x: number, z: number, remainingMs: number): void {
    this.group.visible = remainingMs > 0;
    if (!this.group.visible) return;
    this.group.position.set(x, FLOOR_Y + 0.025, z);
    const fraction = Math.min(1, remainingMs / SCARED_MS);
    this.arcGeometry.setDrawRange(0, Math.ceil(fraction * SEGMENTS) * 6);
    // A steady, stronger final segment; no extra flash or oscillating timer.
    this.arcMaterial.color.setHex(remainingMs <= SCARED_WARN_MS ? COLORS.heartGlow : COLORS.power);
  }
}
