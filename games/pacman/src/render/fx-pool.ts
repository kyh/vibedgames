import * as THREE from "three";

import { COLORS, FLOOR_Y, GHOST_COLORS, GRID_COLS, GRID_ROWS } from "../shared/constants";
import { buildHeartGeometry } from "./heart";

// Pooled 3D VFX (vfx skill rules, adapted for a CREAM world): additive
// sparkles white-out on light backgrounds, so every burst here is opaque
// instanced geometry that fades by SHRINKING to zero instead of alpha.
// Three instanced systems (puffs / hearts / confetti) = three draw calls,
// plus a handful of pooled transparent floor rings and one ambient Points
// cloud. Everything is allocated once; explosions just recycle slots.

/** Hard caps — slots recycle oldest-first when a burst overflows the pool. */
const MAX_PUFFS = 160;
const MAX_HEARTS = 28;
const MAX_CONFETTI = 140;
const MAX_RINGS = 5;
const MOTE_COUNT = 70;

/** Puffs pop to full size in the first 18% of life, then ease-shrink to 0. */
const POP_PORTION = 0.18;
const PUFF_DRAG = 2.6;
/** Gentle buoyancy — cute puffs float up, they don't fall. */
const PUFF_LIFT = 0.55;

const HEART_RISE = 1.1;
const HEART_WOBBLE_FREQ = 7;
const HEART_WOBBLE_AMP = 0.35;
const HEART_SPIN = 3.2;

const CONFETTI_GRAVITY = -3.2;
const CONFETTI_DRAG = 0.4;
/** Confetti dies just above the floor plane so it never z-fights it. */
const CONFETTI_FLOOR_Y = FLOOR_Y + 0.03;

const RING_DUR_MS = 420;

type Span = { px: number; py: number; pz: number; vx: number; vy: number; vz: number };

type Puff = Span & { age: number; life: number; size: number; color: THREE.Color };

type Heart = Span & { age: number; life: number; size: number; phase: number };

type Confetti = Span & {
  age: number;
  life: number;
  size: number;
  color: THREE.Color;
  axis: THREE.Vector3;
  spin: number;
  angle: number;
};

type Ring = { mesh: THREE.Mesh; mat: THREE.MeshBasicMaterial; bornAt: number; r1: number };

export type BurstOpts = {
  speed?: number;
  lift?: number;
  lifeMin?: number;
  lifeMax?: number;
  sizeMin?: number;
  sizeMax?: number;
};

export class FxPool {
  private puffMesh: THREE.InstancedMesh;
  private heartMesh: THREE.InstancedMesh;
  private confettiMesh: THREE.InstancedMesh;
  private puffs: Puff[] = [];
  private hearts: Heart[] = [];
  private confetti: Confetti[] = [];
  private rings: Ring[] = [];
  private motes: THREE.Points;
  private moteVel: Float32Array;
  private dummy = new THREE.Object3D();
  private elapsed = 0;

  constructor(scene: THREE.Scene) {
    this.puffMesh = makeInstanced(new THREE.SphereGeometry(0.5, 10, 8), MAX_PUFFS);
    this.heartMesh = makeInstanced(buildHeartGeometry(1), MAX_HEARTS, COLORS.power);
    this.confettiMesh = makeInstanced(new THREE.BoxGeometry(1, 0.25, 0.6), MAX_CONFETTI);
    scene.add(this.puffMesh, this.heartMesh, this.confettiMesh);

    for (let i = 0; i < MAX_RINGS; i++) {
      const mat = new THREE.MeshBasicMaterial({
        color: COLORS.power,
        transparent: true,
        opacity: 0,
        depthWrite: false,
        side: THREE.DoubleSide,
      });
      const mesh = new THREE.Mesh(new THREE.RingGeometry(0.82, 1, 48), mat);
      mesh.rotation.x = -Math.PI / 2;
      mesh.visible = false;
      scene.add(mesh);
      this.rings.push({ mesh, mat, bornAt: -1, r1: 1 });
    }

    const { points, velocities } = makeMotes();
    this.motes = points;
    this.moteVel = velocities;
    scene.add(this.motes);
  }

  /** Soft round burst — the workhorse (pellet pops, ghost poofs, dust). */
  puff(at: THREE.Vector3, count: number, color: number, opts: BurstOpts = {}): void {
    const speed = opts.speed ?? 1.4;
    for (let i = 0; i < count; i++) {
      if (this.puffs.length >= MAX_PUFFS) this.puffs.shift();
      const dir = randomUnit();
      const v = speed * (0.5 + Math.random() * 0.5);
      this.puffs.push({
        px: at.x,
        py: at.y,
        pz: at.z,
        vx: dir.x * v,
        vy: Math.abs(dir.y) * v * 0.7 + (opts.lift ?? 0.4),
        vz: dir.z * v,
        age: 0,
        life: rand(opts.lifeMin ?? 0.35, opts.lifeMax ?? 0.6),
        size: rand(opts.sizeMin ?? 0.1, opts.sizeMax ?? 0.22),
        color: new THREE.Color(color).offsetHSL(0, 0, (Math.random() - 0.5) * 0.06),
      });
    }
  }

  /** Rising pink hearts — power pickups and eaten ghosts (healthcare!). */
  heartBurst(at: THREE.Vector3, count: number): void {
    for (let i = 0; i < count; i++) {
      if (this.hearts.length >= MAX_HEARTS) this.hearts.shift();
      const ang = Math.random() * Math.PI * 2;
      const v = 0.5 + Math.random() * 0.9;
      this.hearts.push({
        px: at.x,
        py: at.y,
        pz: at.z,
        vx: Math.cos(ang) * v * 0.6,
        vy: HEART_RISE * (0.75 + Math.random() * 0.5),
        vz: Math.sin(ang) * v * 0.6,
        age: 0,
        life: rand(0.7, 1.1),
        size: rand(0.12, 0.22),
        phase: Math.random() * Math.PI * 2,
      });
    }
  }

  /** Pastel confetti rain over the whole maze (win celebration). */
  confettiRain(count: number): void {
    const palette = [COLORS.power, COLORS.pacman, ...GHOST_COLORS];
    for (let i = 0; i < count; i++) {
      if (this.confetti.length >= MAX_CONFETTI) this.confetti.shift();
      this.confetti.push({
        px: Math.random() * GRID_COLS,
        py: 4 + Math.random() * 3.5,
        pz: Math.random() * GRID_ROWS,
        vx: (Math.random() - 0.5) * 0.8,
        vy: -0.3 - Math.random() * 0.6,
        vz: (Math.random() - 0.5) * 0.8,
        age: 0,
        life: rand(2.4, 4),
        size: rand(0.07, 0.13),
        color: new THREE.Color(palette[Math.floor(Math.random() * palette.length)] ?? 0xffffff),
        axis: randomUnit(),
        spin: rand(2, 7) * (Math.random() < 0.5 ? -1 : 1),
        angle: Math.random() * Math.PI * 2,
      });
    }
  }

  /** Expanding floor ring, Cubic.Out, fades over RING_DUR_MS. */
  ring(x: number, z: number, r1: number, color: number): void {
    const slot =
      this.rings.find((r) => r.bornAt < 0) ??
      this.rings.reduce((a, b) => (a.bornAt <= b.bornAt ? a : b));
    slot.bornAt = this.elapsed;
    slot.r1 = r1;
    slot.mat.color.setHex(color);
    slot.mesh.position.set(x, FLOOR_Y + 0.02, z);
    slot.mesh.visible = true;
  }

  update(dt: number): void {
    this.elapsed += dt;
    this.updatePuffs(dt);
    this.updateHearts(dt);
    this.updateConfetti(dt);
    this.updateRings();
    this.updateMotes(dt);
  }

  // ---- per-system integration ------------------------------------------------

  private updatePuffs(dt: number): void {
    const drag = Math.max(0, 1 - PUFF_DRAG * dt);
    this.puffs = this.puffs.filter((p) => (p.age += dt) < p.life);
    const mesh = this.puffMesh;
    this.puffs.forEach((p, i) => {
      p.vx *= drag;
      p.vz *= drag;
      p.vy = p.vy * drag + PUFF_LIFT * dt;
      p.px += p.vx * dt;
      p.py += p.vy * dt;
      p.pz += p.vz * dt;
      const s = p.size * scaleCurve(p.age / p.life);
      this.dummy.position.set(p.px, p.py, p.pz);
      this.dummy.rotation.set(0, 0, 0);
      this.dummy.scale.setScalar(Math.max(s, 1e-4));
      this.dummy.updateMatrix();
      mesh.setMatrixAt(i, this.dummy.matrix);
      mesh.setColorAt(i, p.color);
    });
    commit(mesh, this.puffs.length);
  }

  private updateHearts(dt: number): void {
    this.hearts = this.hearts.filter((h) => (h.age += dt) < h.life);
    const mesh = this.heartMesh;
    this.hearts.forEach((h, i) => {
      h.px += (h.vx + Math.sin(this.elapsed * HEART_WOBBLE_FREQ + h.phase) * HEART_WOBBLE_AMP) * dt;
      h.py += h.vy * dt;
      h.pz += h.vz * dt;
      const s = h.size * scaleCurve(h.age / h.life);
      this.dummy.position.set(h.px, h.py, h.pz);
      this.dummy.rotation.set(0, h.phase + this.elapsed * HEART_SPIN, 0);
      this.dummy.scale.setScalar(Math.max(s, 1e-4));
      this.dummy.updateMatrix();
      mesh.setMatrixAt(i, this.dummy.matrix);
    });
    commit(mesh, this.hearts.length);
  }

  private updateConfetti(dt: number): void {
    const drag = Math.max(0, 1 - CONFETTI_DRAG * dt);
    this.confetti = this.confetti.filter((c) => (c.age += dt) < c.life && c.py > CONFETTI_FLOOR_Y);
    const mesh = this.confettiMesh;
    this.confetti.forEach((c, i) => {
      c.vy += CONFETTI_GRAVITY * dt;
      c.vx *= drag;
      c.vy *= drag;
      c.vz *= drag;
      c.px += c.vx * dt;
      c.py += c.vy * dt;
      c.pz += c.vz * dt;
      c.angle += c.spin * dt;
      // Shrink only in the last 25% of life so flakes don't visibly pop out.
      const t = c.age / c.life;
      const s = c.size * (t > 0.75 ? 1 - (t - 0.75) / 0.25 : 1);
      this.dummy.position.set(c.px, c.py, c.pz);
      this.dummy.quaternion.setFromAxisAngle(c.axis, c.angle);
      this.dummy.scale.setScalar(Math.max(s, 1e-4));
      this.dummy.updateMatrix();
      mesh.setMatrixAt(i, this.dummy.matrix);
      mesh.setColorAt(i, c.color);
    });
    commit(mesh, this.confetti.length);
  }

  private updateRings(): void {
    for (const r of this.rings) {
      if (r.bornAt < 0) continue;
      const t = ((this.elapsed - r.bornAt) * 1000) / RING_DUR_MS;
      if (t >= 1) {
        r.bornAt = -1;
        r.mesh.visible = false;
        continue;
      }
      const eased = 1 - Math.pow(1 - t, 3);
      const radius = 0.15 + (r.r1 - 0.15) * eased;
      r.mesh.scale.setScalar(radius);
      r.mat.opacity = 0.55 * (1 - t);
    }
  }

  private updateMotes(dt: number): void {
    const pos = this.motes.geometry.getAttribute("position");
    if (!(pos instanceof THREE.BufferAttribute)) return;
    const arr = pos.array;
    if (!(arr instanceof Float32Array)) return;
    for (let i = 0; i < MOTE_COUNT; i++) {
      const x = (arr[i * 3] ?? 0) + (this.moteVel[i * 2] ?? 0) * dt;
      arr[i * 3] = x < 0 ? GRID_COLS : x > GRID_COLS ? 0 : x;
      const y = (arr[i * 3 + 1] ?? 0) + (this.moteVel[i * 2 + 1] ?? 0) * dt;
      arr[i * 3 + 1] = y > 2.8 ? 0.15 : y;
    }
    pos.needsUpdate = true;
  }
}

// ---- helpers --------------------------------------------------------------------

function makeInstanced(
  geo: THREE.BufferGeometry,
  cap: number,
  color = 0xffffff,
): THREE.InstancedMesh {
  const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.7 });
  const mesh = new THREE.InstancedMesh(geo, mat, cap);
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  mesh.count = 0;
  mesh.frustumCulled = false;
  return mesh;
}

function commit(mesh: THREE.InstancedMesh, count: number): void {
  mesh.count = count;
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
}

/** Pop in fast (overshoot a touch), then fast-in-slow-out shrink to zero. */
function scaleCurve(t: number): number {
  if (t < POP_PORTION) {
    const u = t / POP_PORTION;
    return 1.08 * (1 - (1 - u) * (1 - u));
  }
  const u = (t - POP_PORTION) / (1 - POP_PORTION);
  return 1.08 * (1 - u * u * (3 - 2 * u));
}

/** Ambient dust motes drifting up through the maze air — quiet, constant. */
function makeMotes(): { points: THREE.Points; velocities: Float32Array } {
  const positions = new Float32Array(MOTE_COUNT * 3);
  const velocities = new Float32Array(MOTE_COUNT * 2); // [vx, vy] per mote
  for (let i = 0; i < MOTE_COUNT; i++) {
    positions[i * 3] = Math.random() * GRID_COLS;
    positions[i * 3 + 1] = 0.15 + Math.random() * 2.5;
    positions[i * 3 + 2] = Math.random() * GRID_ROWS;
    velocities[i * 2] = (Math.random() - 0.5) * 0.08;
    velocities[i * 2 + 1] = 0.06 + Math.random() * 0.1;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  // Blush-tinted: white motes measure ~0 contrast against the cream fog.
  const mat = new THREE.PointsMaterial({
    color: 0xf2a9bf,
    size: 0.06,
    map: softDotTexture(),
    transparent: true,
    opacity: 0.5,
    depthWrite: false,
    sizeAttenuation: true,
  });
  const points = new THREE.Points(geo, mat);
  points.frustumCulled = false;
  return { points, velocities };
}

function softDotTexture(): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = 32;
  canvas.height = 32;
  const ctx = canvas.getContext("2d");
  if (ctx) {
    const grad = ctx.createRadialGradient(16, 16, 0, 16, 16, 16);
    grad.addColorStop(0, "rgba(255,255,255,1)");
    grad.addColorStop(0.6, "rgba(255,255,255,0.4)");
    grad.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 32, 32);
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function randomUnit(): THREE.Vector3 {
  const v = new THREE.Vector3(Math.random() * 2 - 1, Math.random() * 2 - 1, Math.random() * 2 - 1);
  return v.lengthSq() < 1e-6 ? v.set(0, 1, 0) : v.normalize();
}

function rand(min: number, max: number): number {
  return min + Math.random() * (max - min);
}
