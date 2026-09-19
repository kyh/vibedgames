// Tumbling chunks thrown out when a crate, barrel or rock breaks. One
// InstancedMesh of unit cubes; each chunk is a slot in a ring buffer with its
// own position, spin and lifetime, composed into the instance matrix per frame.
import * as THREE from "three";
import { clamp, rand } from "../utils";

interface DebrisChunk {
  life: number;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  rx: number;
  ry: number;
  rz: number;
  wx: number;
  wy: number;
  wz: number;
  s: number;
}

const GRAVITY = 19;
// Seconds over which a dying chunk shrinks to nothing.
const SHRINK_TIME = 0.4;

const scratchMatrix = new THREE.Matrix4();
const scratchQuat = new THREE.Quaternion();
const scratchPos = new THREE.Vector3();
const scratchScale = new THREE.Vector3();
const scratchEuler = new THREE.Euler();
const scratchColor = new THREE.Color();

const makeChunk = (): DebrisChunk => ({
  life: 0,
  rx: 0,
  ry: 0,
  rz: 0,
  s: 0.1,
  vx: 0,
  vy: 0,
  vz: 0,
  wx: 0,
  wy: 0,
  wz: 0,
  x: 0,
  y: 0,
  z: 0,
});

/** Advance one chunk by `dt`, bouncing it off the ground. */
const integrateChunk = (chunk: DebrisChunk, dt: number): void => {
  chunk.life -= dt;
  chunk.vy -= GRAVITY * dt;
  chunk.x += chunk.vx * dt;
  chunk.y += chunk.vy * dt;
  chunk.z += chunk.vz * dt;
  const floor = chunk.s * 0.5;
  if (chunk.y < floor) {
    chunk.y = floor;
    chunk.vy *= -0.38;
    chunk.vx *= 0.6;
    chunk.vz *= 0.6;
    chunk.wx *= 0.5;
    chunk.wy *= 0.5;
    chunk.wz *= 0.5;
  }
  chunk.rx += chunk.wx * dt;
  chunk.ry += chunk.wy * dt;
  chunk.rz += chunk.wz * dt;
};

export class DebrisField {
  readonly cap: number;
  readonly mesh: THREE.InstancedMesh;
  private readonly data: DebrisChunk[];
  private cursor: number;

  constructor(scene: THREE.Scene, cap: number) {
    this.cap = cap;
    this.mesh = new THREE.InstancedMesh(
      new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshStandardMaterial({ color: 0xff_ff_ff, roughness: 0.85 }),
      cap,
    );
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    this.mesh.frustumCulled = false;
    this.data = [];
    for (let i = 0; i < cap; i += 1) {
      this.data.push(makeChunk());
      this.mesh.setMatrixAt(i, scratchMatrix.makeScale(0, 0, 0));
      this.mesh.setColorAt(i, scratchColor.set(0xff_ff_ff));
    }
    this.cursor = 0;
    scene.add(this.mesh);
  }

  spawn(x: number, y: number, z: number, color: THREE.ColorRepresentation, count: number): void {
    for (let n = 0; n < count; n += 1) {
      const slot = this.cursor;
      this.cursor = (slot + 1) % this.cap;
      const chunk = this.data[slot];
      if (!chunk) {
        continue;
      }
      const angle = Math.random() * 6.28;
      const speed = rand(1.2, 4.2);
      chunk.life = rand(1.6, 2.6);
      chunk.x = x + rand(-0.3, 0.3);
      chunk.y = y + rand(-0.2, 0.4);
      chunk.z = z + rand(-0.3, 0.3);
      chunk.vx = Math.cos(angle) * speed;
      chunk.vy = rand(3, 7);
      chunk.vz = Math.sin(angle) * speed;
      chunk.rx = rand(0, 6);
      chunk.ry = rand(0, 6);
      chunk.rz = rand(0, 6);
      chunk.wx = rand(-9, 9);
      chunk.wy = rand(-9, 9);
      chunk.wz = rand(-9, 9);
      chunk.s = rand(0.12, 0.27);
      // Vary the lightness so a pile of chunks does not read as one flat colour.
      scratchColor.set(color).offsetHSL(0, 0, rand(-0.06, 0.06));
      this.mesh.setColorAt(slot, scratchColor);
    }
    if (this.mesh.instanceColor) {
      this.mesh.instanceColor.needsUpdate = true;
    }
  }

  update(dt: number): void {
    let touched = false;
    for (let i = 0; i < this.cap; i += 1) {
      const chunk = this.data[i];
      if (!chunk || chunk.life <= 0) {
        continue;
      }
      touched = true;
      integrateChunk(chunk, dt);
      const scale = chunk.life <= 0 ? 0 : chunk.s * clamp(chunk.life / SHRINK_TIME, 0, 1);
      scratchEuler.set(chunk.rx, chunk.ry, chunk.rz);
      scratchQuat.setFromEuler(scratchEuler);
      scratchMatrix.compose(
        scratchPos.set(chunk.x, chunk.y, chunk.z),
        scratchQuat,
        scratchScale.set(scale, scale, scale),
      );
      this.mesh.setMatrixAt(i, scratchMatrix);
    }
    if (touched) {
      this.mesh.instanceMatrix.needsUpdate = true;
    }
  }
}
