// 3D debris chunks — spinning shards for prop breaks / heavy impacts.
// One InstancedMesh (one draw call), free-list pooled like fx-particles.
// Chunks arc under gravity, bounce once on the floor, then shrink out.
import * as THREE from "three";
import { terrainHeight } from "../data/terrain";
import { createRockGeometry } from "./fx-geometry";

const MAX_CHUNKS = 64;
const GRAVITY = -26;
const BOUNCE = 0.35; // velocity kept on the floor bounce
const FLOOR_Y = 0.09; // rest height above the LOCAL ground (see terrainHeight)

type Chunk = {
  idx: number;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  rx: number; // Euler spin state
  rz: number;
  spinX: number;
  spinZ: number;
  life: number;
  maxLife: number;
  size: number;
  squashY: number; // per-shard aspect — one mesh, no two chips the same shape
  squashZ: number;
  bounced: boolean;
};

export class ChunkPool {
  private mesh: THREE.InstancedMesh;
  private free: number[] = [];
  private active: Chunk[] = [];
  private dummy = new THREE.Object3D();
  private color = new THREE.Color();

  constructor(scene: THREE.Scene) {
    // A chipped, cut lump rather than a box: at subdivision 0 it is 20 flat
    // faces — no more expensive than the box was — but it tumbles like broken
    // matter instead of flashing a clean rectangle at the camera every spin.
    const geo = createRockGeometry({
      seed: 12,
      detail: 0,
      lumpiness: 0.34,
      roughness: 0.3,
      cuts: 4,
      cutDepth: 0.3,
      craters: 0,
    });
    const mat = new THREE.MeshStandardMaterial({
      roughness: 0.9,
      metalness: 0,
      flatShading: true,
    });
    this.mesh = new THREE.InstancedMesh(geo, mat, MAX_CHUNKS);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    scene.add(this.mesh);
    // park every instance at zero scale — an untouched identity matrix would
    // render a stray unit shard at the origin on the first burst
    this.dummy.position.set(0, -100, 0);
    this.dummy.scale.setScalar(0.0001);
    this.dummy.updateMatrix();
    // instanceColor is allocated here rather than on the first burst: setColorAt
    // adds USE_INSTANCING_COLOR to the program, and doing that lazily recompiles
    // the shader mid-fight (see Fx.warm).
    const white = new THREE.Color(0xffffff);
    for (let i = MAX_CHUNKS - 1; i >= 0; i--) {
      this.free.push(i);
      this.mesh.setMatrixAt(i, this.dummy.matrix);
      this.mesh.setColorAt(i, white);
    }
  }

  /** Burst `n` shards at (x,z) in `color` (a wood/stone matter tint). */
  burst(x: number, z: number, n: number, color: number, speed = 5): void {
    this.color.setHex(color);
    for (let i = 0; i < n; i++) {
      const idx = this.free.pop();
      if (idx === undefined) return; // saturated — drop
      const a = Math.random() * Math.PI * 2;
      const spd = speed * (0.5 + Math.random());
      const c: Chunk = {
        idx,
        x: x + (Math.random() - 0.5) * 0.4,
        y: terrainHeight(x, z) + 0.5 + Math.random() * 0.5,
        z: z + (Math.random() - 0.5) * 0.4,
        vx: Math.cos(a) * spd,
        vy: 4 + Math.random() * 5,
        vz: Math.sin(a) * spd,
        rx: Math.random() * Math.PI,
        rz: Math.random() * Math.PI,
        spinX: (Math.random() - 0.5) * 14,
        spinZ: (Math.random() - 0.5) * 14,
        life: 0,
        maxLife: 0.9 + Math.random() * 0.5,
        size: 0.16 + Math.random() * 0.2,
        squashY: 0.55 + Math.random() * 0.7,
        squashZ: 0.7 + Math.random() * 0.6,
        bounced: false,
      };
      this.active.push(c);
      // slight per-shard tint variance so the pile doesn't read flat
      const v = 0.85 + Math.random() * 0.3;
      this.mesh.setColorAt(idx, this.color.clone().multiplyScalar(v));
    }
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }

  update(dt: number): void {
    if (this.active.length === 0 && this.mesh.count === 0) return;
    for (let i = this.active.length - 1; i >= 0; i--) {
      const c = this.active[i]!;
      c.life += dt;
      if (c.life >= c.maxLife) {
        this.free.push(c.idx);
        this.dummy.position.set(0, -100, 0);
        this.dummy.scale.setScalar(0.0001);
        this.dummy.updateMatrix();
        this.mesh.setMatrixAt(c.idx, this.dummy.matrix);
        const last = this.active[this.active.length - 1]!;
        this.active[i] = last;
        this.active.pop();
        continue;
      }
      c.vy += GRAVITY * dt;
      c.x += c.vx * dt;
      c.y += c.vy * dt;
      c.z += c.vz * dt;
      // per-frame local floor: chunks knocked off the plateau fall to the plaza
      const floorY = terrainHeight(c.x, c.z) + FLOOR_Y;
      if (c.y < floorY && c.vy < 0) {
        c.y = floorY;
        if (c.bounced) {
          c.vy = 0;
          c.vx *= 0.8;
          c.vz *= 0.8;
          c.spinX *= 0.5;
          c.spinZ *= 0.5;
        } else {
          c.bounced = true;
          c.vy = -c.vy * BOUNCE;
          c.vx *= 0.6;
          c.vz *= 0.6;
        }
      }
      c.rx += c.spinX * dt;
      c.rz += c.spinZ * dt;
      // shrink out over the last 30% of life
      const t = c.life / c.maxLife;
      const shrink = t > 0.7 ? 1 - (t - 0.7) / 0.3 : 1;
      this.dummy.position.set(c.x, c.y, c.z);
      this.dummy.rotation.set(c.rx, c.rx * 0.7, c.rz);
      const sz = c.size * shrink;
      this.dummy.scale.set(sz, sz * c.squashY, sz * c.squashZ);
      this.dummy.updateMatrix();
      this.mesh.setMatrixAt(c.idx, this.dummy.matrix);
    }
    // indices are sparse (free-list), so draw the full range while anything
    // lives and nothing at all when idle
    this.mesh.count = this.active.length > 0 ? MAX_CHUNKS : 0;
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    const material = this.mesh.material;
    if (Array.isArray(material)) for (const m of material) m.dispose();
    else material.dispose();
    this.mesh.removeFromParent();
    this.mesh.dispose();
  }
}
