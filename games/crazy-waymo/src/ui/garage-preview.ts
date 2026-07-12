import * as THREE from "three";

import type { ModelCache } from "../assets/loader";
import { ROBOTAXI_SKINS, buildSkinBody } from "../vehicle/car";

// Showroom previews for the garage cards: one tiny offscreen renderer shared
// by every card, one turntable (car + podium) per skin. Each card's <canvas>
// gets a snapshot at the rest pose; the hovered card spins like a display
// model. Renders only happen while the garage is open and something changed,
// so this costs nothing during normal driving.
const VIEW_W = 100;
const VIEW_H = 64;
const REST_ANGLE = -0.65; // three-quarter view
const SPIN_RATE = 1.7; // rad/s while hovered

type Slot = { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D };

export class GaragePreview {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera: THREE.PerspectiveCamera;
  private readonly turntables = new Map<string, THREE.Group>();
  private readonly camDist = new Map<string, number>();
  private slots = new Map<string, Slot>();
  private hovered: string | null = null;
  private angle = REST_ANGLE;

  constructor(cache: ModelCache) {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    this.renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
    this.renderer.setSize(Math.round(VIEW_W * dpr), Math.round(VIEW_H * dpr), false);
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.camera = new THREE.PerspectiveCamera(30, VIEW_W / VIEW_H, 0.1, 60);

    this.scene.add(new THREE.HemisphereLight(0xe8f0ff, 0x33373f, 1.15));
    const key = new THREE.DirectionalLight(0xffffff, 2.1);
    key.position.set(2.5, 4, 3);
    this.scene.add(key);
    const rim = new THREE.DirectionalLight(0x8fb4ff, 0.7);
    rim.position.set(-3, 2, -2.5);
    this.scene.add(rim);

    const podiumMat = new THREE.MeshStandardMaterial({
      color: 0x272d3a,
      roughness: 0.45,
      metalness: 0.35,
    });
    for (const sk of ROBOTAXI_SKINS) {
      const body = buildSkinBody(cache, sk);
      const box = new THREE.Box3().setFromObject(body);
      const size = box.getSize(new THREE.Vector3());
      const center = box.getCenter(new THREE.Vector3());
      const turntable = new THREE.Group();
      body.position.set(-center.x, -box.min.y, -center.z);
      turntable.add(body);
      const podR = Math.max(size.x, size.z) * 0.62;
      const podium = new THREE.Mesh(new THREE.CylinderGeometry(podR, podR * 1.07, 0.14, 36), podiumMat);
      podium.position.y = -0.07;
      turntable.add(podium);
      turntable.visible = false;
      this.scene.add(turntable);
      this.turntables.set(sk.id, turntable);
      const maxDim = Math.max(size.x, size.y * 1.4, size.z);
      this.camDist.set(sk.id, maxDim * 2.15);
    }
  }

  // Delegated hover tracking; call once on the garage container.
  bind(container: HTMLElement): void {
    container.addEventListener("pointermove", (e) => {
      const card = e.target instanceof Element ? e.target.closest("[data-skin]") : null;
      this.setHovered(card instanceof HTMLElement ? (card.dataset["skin"] ?? null) : null);
    });
    container.addEventListener("pointerleave", () => this.setHovered(null));
  }

  // Re-grab the card canvases after renderGarage rewrites innerHTML.
  attach(container: HTMLElement): void {
    this.slots = new Map();
    for (const canvas of container.querySelectorAll("canvas.gprev")) {
      if (!(canvas instanceof HTMLCanvasElement)) continue;
      const id = canvas.dataset["prev"];
      if (!id || !this.turntables.has(id)) continue;
      canvas.width = this.renderer.domElement.width;
      canvas.height = this.renderer.domElement.height;
      const ctx = canvas.getContext("2d");
      if (!ctx) continue;
      this.slots.set(id, { canvas, ctx });
      this.renderInto(id, REST_ANGLE);
    }
  }

  update(dt: number): void {
    if (!this.hovered) return;
    this.angle += dt * SPIN_RATE;
    this.renderInto(this.hovered, this.angle);
  }

  private setHovered(id: string | null): void {
    if (id === this.hovered) return;
    const prev = this.hovered;
    this.hovered = id;
    this.angle = REST_ANGLE;
    // Park the card we just left back at the showroom pose.
    if (prev) this.renderInto(prev, REST_ANGLE);
  }

  private renderInto(id: string, angle: number): void {
    const turntable = this.turntables.get(id);
    const slot = this.slots.get(id);
    const dist = this.camDist.get(id);
    if (!turntable || !slot || dist === undefined) return;
    turntable.visible = true;
    turntable.rotation.y = angle;
    this.camera.position.set(0, dist * 0.42, dist);
    this.camera.lookAt(0, 0.62, 0);
    this.renderer.render(this.scene, this.camera);
    turntable.visible = false;
    slot.ctx.clearRect(0, 0, slot.canvas.width, slot.canvas.height);
    slot.ctx.drawImage(this.renderer.domElement, 0, 0);
  }
}
