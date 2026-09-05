import * as THREE from "three";

import type { WaterContact } from "../vehicle/water-contact";

const CAPACITY = 24;
const SEGMENTS = 20;
const ROWS = SEGMENTS + 1;
const VERTICES = ROWS * 3;
const INDICES = SEGMENTS * 12;
const WATER_LIFT = 0.06;

export type WaterSprayKind = "entry" | "wake" | "exit";
type Spray = (
  x: number,
  y: number,
  z: number,
  strength: number,
  velX: number,
  velZ: number,
  kind: WaterSprayKind,
) => void;

type Wave = {
  kind: "ripple" | "wake";
  x: number;
  y: number;
  z: number;
  dx: number;
  dz: number;
  age: number;
  life: number;
  radius: number;
  spread: number;
  alpha: number;
};

/** One normal-blend foam draw. Fixed slots and thin strips keep both allocation
 * and transparent coverage small; dormant cars keep no water draw alive. */
export class WaterFx {
  readonly mesh: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;
  private waves: Wave[] = Array.from({ length: CAPACITY }, () => ({
    kind: "ripple",
    x: 0,
    y: 0,
    z: 0,
    dx: 0,
    dz: 1,
    age: 0,
    life: 0,
    radius: 0,
    spread: 0,
    alpha: 0,
  }));
  private positions = new THREE.BufferAttribute(new Float32Array(CAPACITY * VERTICES * 3), 3);
  private colors = new THREE.BufferAttribute(new Float32Array(CAPACITY * VERTICES * 4), 4);
  private cursor = 0;
  private wet = false;
  private wakeCarry = 0;
  private rippleCarry = 0;
  private lastX = 0;
  private lastZ = 0;
  private lastWaterY = 0;

  constructor(private readonly spray: Spray) {
    const geometry = new THREE.BufferGeometry();
    this.positions.setUsage(THREE.DynamicDrawUsage);
    this.colors.setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute("position", this.positions);
    geometry.setAttribute("color", this.colors);
    const indices = new Uint16Array(CAPACITY * INDICES);
    let n = 0;
    for (let wave = 0; wave < CAPACITY; wave++) {
      for (let row = 0; row < SEGMENTS; row++) {
        for (let strip = 0; strip < 2; strip++) {
          const a = wave * VERTICES + row * 3 + strip;
          indices[n++] = a;
          indices[n++] = a + 3;
          indices[n++] = a + 1;
          indices[n++] = a + 1;
          indices[n++] = a + 3;
          indices[n++] = a + 4;
        }
      }
    }
    geometry.setIndex(new THREE.BufferAttribute(indices, 1));
    geometry.setDrawRange(0, 0);
    this.mesh = new THREE.Mesh(
      geometry,
      new THREE.MeshBasicMaterial({
        color: 0xf0faff,
        vertexColors: true,
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
        forceSinglePass: true,
      }),
    );
    this.mesh.name = "vehicle-water-foam";
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 1;
    this.mesh.visible = false;
  }

  setDay(day: number): void {
    const light = 0.3 + Math.min(1, Math.max(0, day)) * 0.7;
    this.mesh.material.color.setRGB(light * 0.92, light * 0.97, light);
  }

  /** Physical contact is authoritative: no altitude guess, airborne grace, or
   * wheel ray can create a splash above a bridge. Motion owns the wake axis. */
  contact(
    dt: number,
    contact: WaterContact,
    x: number,
    y: number,
    z: number,
    velX: number,
    velZ: number,
  ): void {
    const speed = Math.hypot(velX, velZ);
    const dx = speed > 0.01 ? velX / speed : 0;
    const dz = speed > 0.01 ? velZ / speed : 1;
    if (contact.kind === "dry") {
      // Respawning on land does not leave a fountain at the new spawn point.
      if (this.wet && Math.hypot(x - this.lastX, z - this.lastZ) < 8 + speed * dt) {
        this.pair(x, Math.max(y, this.lastWaterY) + 0.15, z, dx, dz, 0.25, velX, velZ, "exit");
      }
      this.wet = false;
      this.wakeCarry = 0;
      this.rippleCarry = 0;
      return;
    }

    if (!this.wet) {
      const strength = Math.min(
        1,
        0.12 + (contact.entrySpeed + contact.entryVerticalSpeed * 2) / 32,
      );
      this.pair(x, contact.waterY + 0.2, z, dx, dz, strength, velX, velZ, "entry");
      this.spawn("ripple", x, contact.waterY, z, dx, dz, 0.9, 1.5 + strength * 2.2, 1.3, 0.4);
      this.wet = true;
    }
    this.lastX = x;
    this.lastZ = z;
    this.lastWaterY = contact.waterY;

    // Discard hitch backlog. Six small wake stamps/s is sufficient at the
    // floating speed cap; idle water gets only a gentle 1.5-second ripple.
    const step = Math.min(Math.max(dt, 0), 0.1);
    if (speed > 1.2) {
      this.rippleCarry = 0;
      this.wakeCarry += step * Math.min(6, speed * 0.7);
      if (this.wakeCarry >= 1) {
        this.wakeCarry %= 1;
        const strength = Math.min(1, speed / 14);
        const wx = x - dx * 1.15;
        const wz = z - dz * 1.15;
        this.spawn(
          "wake",
          wx,
          contact.waterY,
          wz,
          dx,
          dz,
          0.85,
          1.4 + strength,
          1.6,
          0.36 + strength * 0.16,
        );
        this.pair(x, contact.waterY + 0.12, z, dx, dz, strength, velX, velZ, "wake");
      }
    } else {
      this.wakeCarry = 0;
      this.rippleCarry += step;
      if (this.rippleCarry >= 1.5) {
        this.rippleCarry %= 1.5;
        this.spawn("ripple", x, contact.waterY, z, dx, dz, 1, 1.3, 1.5, 0.18);
      }
    }
  }

  private pair(
    x: number,
    y: number,
    z: number,
    dx: number,
    dz: number,
    strength: number,
    velX: number,
    velZ: number,
    kind: WaterSprayKind,
  ): void {
    this.spray(x - dz * 0.85, y, z + dx * 0.85, strength, velX, velZ, kind);
    this.spray(x + dz * 0.85, y, z - dx * 0.85, strength, velX, velZ, kind);
  }

  private spawn(
    kind: Wave["kind"],
    x: number,
    y: number,
    z: number,
    dx: number,
    dz: number,
    radius: number,
    spread: number,
    life: number,
    alpha: number,
  ): void {
    const wave = this.waves[this.cursor];
    if (!wave) return;
    this.cursor = (this.cursor + 1) % CAPACITY;
    wave.kind = kind;
    wave.x = x;
    wave.y = y + WATER_LIFT;
    wave.z = z;
    wave.dx = dx;
    wave.dz = dz;
    wave.age = 0;
    wave.life = life;
    wave.radius = radius;
    wave.spread = spread;
    wave.alpha = alpha;
  }

  update(dt: number): void {
    let live = 0;
    for (const wave of this.waves) {
      if (wave.age >= wave.life) continue;
      wave.age += Math.max(0, dt);
      if (wave.age >= wave.life) continue;
      const age = wave.age / wave.life;
      const radius = wave.radius + wave.spread * age;
      const alpha = wave.alpha * (1 - age) ** 2 * Math.min(1, wave.age / 0.12);
      const thickness = 0.07 + age * 0.16;
      for (let row = 0; row < ROWS; row++) {
        const t = row / SEGMENTS;
        const across = t * 2 - 1;
        const angle = t * Math.PI * 2;
        const along = wave.kind === "ripple" ? Math.cos(angle) : -0.2 - 0.9 * across * across;
        const side = wave.kind === "ripple" ? Math.sin(angle) : across;
        const edgeFade = wave.kind === "ripple" ? 1 : Math.min(1, (1 - Math.abs(across)) * 4);
        for (let edge = 0; edge < 3; edge++) {
          const offset = (edge - 1) * thickness;
          const localAlong = along * radius + (wave.kind === "ripple" ? along : -1) * offset;
          const localSide = side * radius + (wave.kind === "ripple" ? side * offset : 0);
          const vertex = live * VERTICES + row * 3 + edge;
          this.positions.setXYZ(
            vertex,
            wave.x + wave.dx * localAlong - wave.dz * localSide,
            wave.y,
            wave.z + wave.dz * localAlong + wave.dx * localSide,
          );
          this.colors.setXYZW(vertex, 1, 1, 1, edge === 1 ? alpha * edgeFade : 0);
        }
      }
      live++;
    }
    this.mesh.geometry.setDrawRange(0, live * INDICES);
    this.mesh.visible = live > 0;
    if (live > 0) {
      this.positions.needsUpdate = true;
      this.colors.needsUpdate = true;
    }
  }
}
