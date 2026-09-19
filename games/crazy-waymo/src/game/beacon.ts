import * as THREE from "three";

import { GROUND_RING_LIFT, tierColor } from "./fare-tier";
import type { FareTier } from "./fare-tier";

// Floating $-tag above each pickup beam — the tier legend, in-world. One
// shared canvas texture + sprite material per tier (never disposed).
const TAG_TEXT = { long: "$$$", medium: "$$", short: "$" } satisfies Record<FareTier, string>;
const tagMaterials = new Map<FareTier, THREE.SpriteMaterial>();
const tagMaterial = (tier: FareTier): THREE.SpriteMaterial => {
  const cached = tagMaterials.get(tier);
  if (cached) {
    return cached;
  }
  const canvas = document.createElement("canvas");
  canvas.width = 192;
  canvas.height = 96;
  const ctx = canvas.getContext("2d");
  if (ctx) {
    ctx.font = "900 60px ui-monospace, 'SF Mono', Menlo, monospace";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.lineWidth = 10;
    ctx.lineJoin = "round";
    ctx.strokeStyle = "rgba(10, 8, 20, 0.9)";
    ctx.strokeText(TAG_TEXT[tier], 96, 52);
    ctx.fillStyle = `#${tierColor(tier).toString(16).padStart(6, "0")}`;
    ctx.fillText(TAG_TEXT[tier], 96, 52);
  }
  const mat = new THREE.SpriteMaterial({
    depthWrite: false,
    map: new THREE.CanvasTexture(canvas),
    transparent: true,
  });
  tagMaterials.set(tier, mat);
  return mat;
};

export class Beacon {
  readonly group = new THREE.Group();
  private pillar: THREE.Mesh;
  private ring: THREE.Mesh;
  private mat: THREE.MeshBasicMaterial;
  private ringMat: THREE.MeshBasicMaterial;
  private tag: THREE.Sprite | null = null;
  private t = 0;

  constructor(color: number, tagTier?: FareTier) {
    this.mat = new THREE.MeshBasicMaterial({
      blending: THREE.AdditiveBlending,
      color,
      depthWrite: false,
      opacity: 0.32,
      transparent: true,
    });
    this.pillar = new THREE.Mesh(new THREE.CylinderGeometry(0.6, 0.6, 16, 12, 1, true), this.mat);
    this.pillar.position.y = 8;
    this.group.add(this.pillar);

    this.ringMat = new THREE.MeshBasicMaterial({
      color,
      depthWrite: false,
      opacity: 0.85,
      side: THREE.DoubleSide,
      transparent: true,
    });
    this.ring = new THREE.Mesh(new THREE.RingGeometry(2, 2.5, 28), this.ringMat);
    this.ring.rotation.x = -Math.PI / 2;
    this.ring.position.y = GROUND_RING_LIFT;
    this.group.add(this.ring);

    if (tagTier) {
      this.tag = new THREE.Sprite(tagMaterial(tagTier));
      this.tag.scale.set(4.2, 2.1, 1);
      this.tag.position.y = 6.5;
      this.group.add(this.tag);
    }
  }

  setColor(color: number): void {
    this.mat.color.setHex(color);
    this.ringMat.color.setHex(color);
  }
  setPos(x: number, y: number, z: number): void {
    this.group.position.set(x, y, z);
  }
  setVisible(v: boolean): void {
    this.group.visible = v;
  }
  // Beacons are created per fare — free the GPU resources when one retires.
  dispose(): void {
    this.pillar.geometry.dispose();
    this.ring.geometry.dispose();
    this.mat.dispose();
    this.ringMat.dispose();
  }
  update(dt: number): void {
    this.t += dt;
    const pulse = 0.5 + 0.5 * Math.sin(this.t * 3);
    this.mat.opacity = 0.2 + pulse * 0.25;
    this.ring.rotation.z += dt * 1.5;
    const rs = 1 + pulse * 0.12;
    this.ring.scale.set(rs, rs, rs);
    if (this.tag) {
      this.tag.position.y = 6.5 + Math.sin(this.t * 2) * 0.35;
    }
  }
}
