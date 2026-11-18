// Draws the pickup field: orbs that bob and spin, item boxes that tumble,
// blots as dark wet puddles, and paint bombs in flight. Everything is pooled
// or instanced; a taken pickup is scaled to nothing until it comes back.

import * as THREE from "three";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";

import { BLOT_RADIUS, BOMB_FLIGHT } from "../shared/constants";
import type { Field } from "../sim/pickups";
import { softDisc } from "./textures";

/** A paint bomb in the air. */
export interface Bomb {
  by: string;
  color: THREE.Color;
  fromX: number;
  fromZ: number;
  toX: number;
  toZ: number;
  /** Scene clock at the throw. */
  t0: number;
}

const SCRATCH = new THREE.Object3D();
const MAX_BLOTS = 16;
const MAX_BOMBS = 6;

const questionMark = (): THREE.CanvasTexture => {
  const canvas = document.createElement("canvas");
  canvas.width = 128;
  canvas.height = 128;
  const ctx = canvas.getContext("2d");
  if (ctx) {
    const fill = ctx.createLinearGradient(0, 0, 128, 128);
    fill.addColorStop(0, "#ff5fa2");
    fill.addColorStop(0.5, "#ffd23f");
    fill.addColorStop(1, "#2fe6ff");
    ctx.fillStyle = fill;
    ctx.fillRect(0, 0, 128, 128);
    ctx.strokeStyle = "rgba(255,255,255,0.9)";
    ctx.lineWidth = 8;
    ctx.strokeRect(6, 6, 116, 116);
    ctx.fillStyle = "#101018";
    ctx.font = "italic 900 96px 'Chakra Petch', 'Arial Black', sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("?", 62, 70);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
};

export class PickupView {
  readonly group = new THREE.Group();
  private readonly orbs: THREE.InstancedMesh;
  private readonly halos: THREE.InstancedMesh;
  private readonly boxes: THREE.InstancedMesh;
  private readonly blots: THREE.Mesh[] = [];
  private readonly bombs: THREE.Mesh[] = [];
  private readonly disposables: { dispose: () => void }[] = [];

  constructor(field: Field) {
    const disc = softDisc();
    const mark = questionMark();
    const orbMaterial = new THREE.MeshStandardMaterial({
      color: "#ffe7a3",
      emissive: "#ffb629",
      emissiveIntensity: 0.7,
      metalness: 0.6,
      roughness: 0.25,
    });
    const haloMaterial = new THREE.MeshBasicMaterial({
      blending: THREE.AdditiveBlending,
      color: "#3a2808",
      depthWrite: false,
      map: disc,
      transparent: true,
    });
    const boxMaterial = new THREE.MeshStandardMaterial({
      emissive: "#ffffff",
      emissiveIntensity: 0.55,
      emissiveMap: mark,
      map: mark,
      metalness: 0.1,
      roughness: 0.3,
    });
    this.orbs = new THREE.InstancedMesh(
      new THREE.TorusGeometry(0.42, 0.15, 8, 18),
      orbMaterial,
      field.orbs.length,
    );
    this.halos = new THREE.InstancedMesh(
      new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2),
      haloMaterial,
      field.orbs.length + field.boxes.length,
    );
    this.boxes = new THREE.InstancedMesh(
      new RoundedBoxGeometry(1.35, 1.35, 1.35, 3, 0.18),
      boxMaterial,
      field.boxes.length,
    );
    this.orbs.castShadow = true;
    this.boxes.castShadow = true;
    this.halos.renderOrder = 3;
    for (const mesh of [this.orbs, this.halos, this.boxes]) {
      mesh.frustumCulled = false;
      this.disposables.push(mesh.geometry);
      this.group.add(mesh);
    }
    this.disposables.push(disc, mark, orbMaterial, haloMaterial, boxMaterial);

    const puddle = new THREE.CircleGeometry(BLOT_RADIUS, 20).rotateX(-Math.PI / 2);
    const ink = new THREE.MeshStandardMaterial({
      color: "#07070c",
      metalness: 0.4,
      polygonOffset: true,
      polygonOffsetFactor: -4,
      roughness: 0.05,
    });
    for (let i = 0; i < MAX_BLOTS; i += 1) {
      const blot = new THREE.Mesh(puddle, ink);
      blot.visible = false;
      blot.position.y = 0.04;
      blot.receiveShadow = true;
      this.blots.push(blot);
      this.group.add(blot);
    }
    const shell = new THREE.SphereGeometry(0.6, 14, 10);
    for (let i = 0; i < MAX_BOMBS; i += 1) {
      const bomb = new THREE.Mesh(shell, new THREE.MeshBasicMaterial({ toneMapped: false }));
      bomb.visible = false;
      this.bombs.push(bomb);
      this.disposables.push(bomb.material);
      this.group.add(bomb);
    }
    this.disposables.push(puddle, ink, shell);
  }

  update(field: Field, bombs: readonly Bomb[], time: number): void {
    let halo = 0;
    const ring = (x: number, z: number, size: number): void => {
      SCRATCH.position.set(x, 0.05, z);
      SCRATCH.rotation.set(0, 0, 0);
      SCRATCH.scale.set(size, 1, size);
      SCRATCH.updateMatrix();
      this.halos.setMatrixAt(halo, SCRATCH.matrix);
      halo += 1;
    };
    for (const [i, orb] of field.orbs.entries()) {
      const here = time >= orb.until;
      SCRATCH.position.set(orb.x, 1 + Math.sin(time * 3 + i) * 0.14, orb.z);
      SCRATCH.rotation.set(0, time * 2.6 + i, 0);
      SCRATCH.scale.setScalar(here ? 1 : 0);
      SCRATCH.updateMatrix();
      this.orbs.setMatrixAt(i, SCRATCH.matrix);
      ring(orb.x, orb.z, here ? 3 : 0);
    }
    for (const [i, box] of field.boxes.entries()) {
      // Pop back in with a little overshoot.
      const back = Math.min(1, Math.max(0, (time - box.until) * 3));
      const scale = time >= box.until ? 0.6 + 0.4 * back + Math.sin(back * Math.PI) * 0.12 : 0;
      SCRATCH.position.set(box.x, 1.25 + Math.sin(time * 2 + i * 1.7) * 0.12, box.z);
      // Spin upright, so the mark on each face reads the right way up.
      SCRATCH.rotation.set(0, time * 1.3 + i * 2, 0);
      SCRATCH.scale.setScalar(scale);
      SCRATCH.updateMatrix();
      this.boxes.setMatrixAt(i, SCRATCH.matrix);
      ring(box.x, box.z, scale > 0 ? 4.4 : 0);
    }
    this.orbs.instanceMatrix.needsUpdate = true;
    this.boxes.instanceMatrix.needsUpdate = true;
    this.halos.instanceMatrix.needsUpdate = true;

    for (const [i, mesh] of this.blots.entries()) {
      const blot = field.blots[i];
      mesh.visible = blot !== undefined;
      if (blot) {
        mesh.position.set(blot.x, 0.04, blot.z);
        // Dries up over its last two seconds.
        mesh.scale.setScalar(Math.min(1, Math.max(0.05, (blot.until - time) / 2)));
      }
    }
    for (const [i, mesh] of this.bombs.entries()) {
      const bomb = bombs[i];
      mesh.visible = bomb !== undefined;
      if (bomb) {
        const k = Math.min(1, (time - bomb.t0) / BOMB_FLIGHT);
        mesh.position.set(
          bomb.fromX + (bomb.toX - bomb.fromX) * k,
          1 + Math.sin(k * Math.PI) * 7,
          bomb.fromZ + (bomb.toZ - bomb.fromZ) * k,
        );
        if (!Array.isArray(mesh.material) && mesh.material instanceof THREE.MeshBasicMaterial) {
          mesh.material.color.copy(bomb.color).multiplyScalar(1.6);
        }
      }
    }
  }

  dispose(): void {
    this.group.removeFromParent();
    for (const item of this.disposables) {
      item.dispose();
    }
  }
}
