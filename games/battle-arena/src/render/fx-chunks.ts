// 3D debris chunks — spinning box shards for prop breaks / heavy impacts.
// One InstancedMesh (one draw call), free-list pooled like fx-particles.
// Chunks arc under gravity, bounce once on the floor, then shrink out.
import * as THREE from "three";

const MAX_CHUNKS = 64;
const GRAVITY = -26;
const BOUNCE = 0.35; // velocity kept on the floor bounce
const FLOOR_Y = 0.09;

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
  bounced: boolean;
};

export class ChunkPool {
  private mesh: THREE.InstancedMesh;
  private free: number[] = [];
  private active: Chunk[] = [];
  private dummy = new THREE.Object3D();
  private color = new THREE.Color();

  constructor(scene: THREE.Scene) {
    const geo = new THREE.BoxGeometry(1, 0.6, 0.7);
    const mat = new THREE.MeshStandardMaterial({ roughness: 0.9, metalness: 0 });
    this.mesh = new THREE.InstancedMesh(geo, mat, MAX_CHUNKS);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    scene.add(this.mesh);
    // park every instance at zero scale — an untouched identity matrix would
    // render a stray unit box at the origin on the first burst
    this.dummy.position.set(0, -100, 0);
    this.dummy.scale.setScalar(0.0001);
    this.dummy.updateMatrix();
    for (let i = MAX_CHUNKS - 1; i >= 0; i--) {
      this.free.push(i);
      this.mesh.setMatrixAt(i, this.dummy.matrix);
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
        y: 0.5 + Math.random() * 0.5,
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
      if (c.y < FLOOR_Y && c.vy < 0) {
        c.y = FLOOR_Y;
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
      this.dummy.rotation.set(c.rx, 0, c.rz);
      this.dummy.scale.setScalar(c.size * shrink);
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
    (this.mesh.material as THREE.Material).dispose();
    this.mesh.removeFromParent();
    this.mesh.dispose();
  }
}
