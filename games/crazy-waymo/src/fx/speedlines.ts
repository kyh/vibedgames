import * as THREE from "three";

// Anime-style speed lines: additive streaks in a torus around the camera's
// forward axis, rushing past at high speed. The whole system fades in above
// FADE_START of top speed and is fully hidden below it. One LineSegments,
// zero allocation per frame.
//
// Lines live in camera space: the object copies the camera's transform each
// frame and the streaks slide along local +Z (toward/behind the camera),
// respawning ahead once they pass behind.

const COUNT = 36;
const RADIUS_MIN = 5;
const RADIUS_MAX = 10;
const AHEAD_MIN = 10; // spawn distance ahead of the camera (local -Z)
const AHEAD_MAX = 25;
const BASE_ALPHA = 0.2;
const FADE_START = 0.75; // speedFrac where lines begin to appear
const FADE_FULL = 0.9; // fully visible here

export class SpeedLines {
  readonly object3D: THREE.Object3D;
  private positions: Float32Array;
  private posAttr: THREE.BufferAttribute;
  private mat: THREE.LineBasicMaterial;
  // Per-line state: head z (local, negative = ahead), ring angle, radius, length jitter.
  private headZ = new Float32Array(COUNT);
  private angle = new Float32Array(COUNT);
  private radius = new Float32Array(COUNT);
  private lenJitter = new Float32Array(COUNT);

  constructor() {
    this.positions = new Float32Array(COUNT * 2 * 3);
    for (let i = 0; i < COUNT; i++) {
      this.respawn(i, -(AHEAD_MIN + Math.random() * (AHEAD_MAX - AHEAD_MIN)));
    }

    const geo = new THREE.BufferGeometry();
    this.posAttr = new THREE.BufferAttribute(this.positions, 3);
    geo.setAttribute("position", this.posAttr);
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);

    this.mat = new THREE.LineBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const lines = new THREE.LineSegments(geo, this.mat);
    lines.frustumCulled = false;
    lines.visible = false;
    lines.renderOrder = 10; // over world transparents
    this.object3D = lines;
  }

  update(dt: number, camera: THREE.PerspectiveCamera, speedFrac: number): void {
    const fade = THREE.MathUtils.clamp((speedFrac - FADE_START) / (FADE_FULL - FADE_START), 0, 1);
    this.mat.opacity = BASE_ALPHA * fade;
    this.object3D.visible = fade > 0;
    if (fade <= 0) return; // kill invisible work

    // Ride the camera.
    this.object3D.position.copy(camera.position);
    this.object3D.quaternion.copy(camera.quaternion);

    const stretch = 1 + speedFrac * 3;
    const zSpeed = 20 + speedFrac * 60; // how fast streaks rush past
    for (let i = 0; i < COUNT; i++) {
      let z = (this.headZ[i] ?? -AHEAD_MIN) + zSpeed * dt;
      if (z > 1) {
        // Fully behind the camera: recycle ahead at a fresh ring position.
        this.respawn(i, -AHEAD_MAX + Math.random() * 5);
        z = this.headZ[i] ?? -AHEAD_MAX;
      } else {
        this.headZ[i] = z;
      }
      const a = this.angle[i] ?? 0;
      const r = this.radius[i] ?? RADIUS_MIN;
      const x = Math.cos(a) * r;
      const y = Math.sin(a) * r;
      const len = (0.8 + (this.lenJitter[i] ?? 0)) * stretch;
      const p = i * 6;
      this.positions[p] = x;
      this.positions[p + 1] = y;
      this.positions[p + 2] = z;
      this.positions[p + 3] = x;
      this.positions[p + 4] = y;
      this.positions[p + 5] = z + len; // tail trails toward the camera
    }
    this.posAttr.needsUpdate = true;
  }

  private respawn(i: number, z: number): void {
    this.headZ[i] = z;
    this.angle[i] = Math.random() * Math.PI * 2;
    this.radius[i] = RADIUS_MIN + Math.random() * (RADIUS_MAX - RADIUS_MIN);
    this.lenJitter[i] = Math.random() * 0.8;
  }
}
