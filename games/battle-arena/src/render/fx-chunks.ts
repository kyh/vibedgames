import * as THREE from "three";
import { terrainHeight } from "../data/terrain";
import { uploadPrefix } from "./buffer-upload";
import { createRockGeometry } from "./fx-geometry";

const MAX_CHUNKS = 64;
const GRAVITY = -26;
const BOUNCE = 0.35;
const FLOOR_Y = 0.09;

interface Chunk {
  idx: number;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  rx: number;
  rz: number;
  spinX: number;
  spinZ: number;
  life: number;
  maxLife: number;
  size: number;
  squashY: number;
  squashZ: number;
  bounced: boolean;
}

export class ChunkPool {
  private readonly mesh: THREE.InstancedMesh;
  private readonly free: number[] = [];
  private active: Chunk[] = [];
  private highWater = 0;
  private readonly dummy = new THREE.Object3D();
  private readonly color = new THREE.Color();

  constructor(scene: THREE.Scene) {
    const geo = createRockGeometry({
      craters: 0,
      cutDepth: 0.3,
      cuts: 4,
      detail: 0,
      lumpiness: 0.34,
      roughness: 0.3,
      seed: 12,
    });

    const mat = new THREE.MeshStandardMaterial({
      flatShading: true,
      metalness: 0,
      roughness: 0.9,
    });

    this.mesh = new THREE.InstancedMesh(geo, mat, MAX_CHUNKS);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    scene.add(this.mesh);
    this.dummy.position.set(0, -100, 0);
    this.dummy.scale.setScalar(0.0001);
    this.dummy.updateMatrix();
    const white = new THREE.Color(0xff_ff_ff);

    for (let i = MAX_CHUNKS - 1; i >= 0; i -= 1) {
      this.free.push(i);
      this.mesh.setMatrixAt(i, this.dummy.matrix);
      this.mesh.setColorAt(i, white);
    }
  }

  /** Burst `n` shards at (x,z) in `color` (a wood/stone matter tint). */
  burst(x: number, z: number, n: number, color: number, speed = 5) {
    this.color.setHex(color);

    for (let i = 0; i < n; i += 1) {
      const idx = this.free.pop();

      if (idx === undefined) {
        return;
      }

      if (idx >= this.highWater) {
        this.highWater = idx + 1;
      }

      const a = Math.random() * Math.PI * 2;
      const spd = speed * (0.5 + Math.random());

      const c: Chunk = {
        bounced: false,
        idx,
        life: 0,
        maxLife: 0.9 + Math.random() * 0.5,
        rx: Math.random() * Math.PI,
        rz: Math.random() * Math.PI,
        size: 0.16 + Math.random() * 0.2,
        spinX: (Math.random() - 0.5) * 14,
        spinZ: (Math.random() - 0.5) * 14,
        squashY: 0.55 + Math.random() * 0.7,
        squashZ: 0.7 + Math.random() * 0.6,
        vx: Math.cos(a) * spd,
        vy: 4 + Math.random() * 5,
        vz: Math.sin(a) * spd,
        x: x + (Math.random() - 0.5) * 0.4,
        y: terrainHeight(x, z) + 0.5 + Math.random() * 0.5,
        z: z + (Math.random() - 0.5) * 0.4,
      };

      this.active.push(c);
      const v = 0.85 + Math.random() * 0.3;
      this.mesh.setColorAt(idx, this.color.clone().multiplyScalar(v));
    }

    if (this.mesh.instanceColor) {
      uploadPrefix(this.mesh.instanceColor, this.highWater * 3);
    }
  }

  update(dt: number) {
    if (this.active.length === 0 && this.mesh.count === 0) {
      return;
    }

    for (let i = this.active.length - 1; i >= 0; i -= 1) {
      const c = this.active[i];

      if (!c) {
        continue;
      }

      c.life += dt;

      if (c.life >= c.maxLife) {
        this.free.push(c.idx);
        this.dummy.position.set(0, -100, 0);
        this.dummy.scale.setScalar(0.0001);
        this.dummy.updateMatrix();
        this.mesh.setMatrixAt(c.idx, this.dummy.matrix);
        const last = this.active.at(-1);

        if (last) {
          this.active[i] = last;
        }

        this.active.pop();
        continue;
      }

      c.vy += GRAVITY * dt;
      c.x += c.vx * dt;
      c.y += c.vy * dt;
      c.z += c.vz * dt;
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
      const t = c.life / c.maxLife;
      const shrink = t > 0.7 ? 1 - (t - 0.7) / 0.3 : 1;
      this.dummy.position.set(c.x, c.y, c.z);
      this.dummy.rotation.set(c.rx, c.rx * 0.7, c.rz);
      const sz = c.size * shrink * 0.5;
      this.dummy.scale.set(sz, sz * c.squashY, sz * c.squashZ);
      this.dummy.updateMatrix();
      this.mesh.setMatrixAt(c.idx, this.dummy.matrix);
    }

    const n = this.highWater;
    this.mesh.count = this.active.length > 0 ? n : 0;
    uploadPrefix(this.mesh.instanceMatrix, n * 16);

    if (this.active.length === 0) {
      this.highWater = 0;
    }
  }

  clear() {
    for (const chunk of this.active) {
      chunk.life = chunk.maxLife;
    }

    this.update(0);
  }

  dispose() {
    this.mesh.geometry.dispose();
    const { material } = this.mesh;

    if (Array.isArray(material)) {
      for (const m of material) {
        m.dispose();
      }
    } else {
      material.dispose();
    }

    this.mesh.removeFromParent();
    this.mesh.dispose();
  }
}
