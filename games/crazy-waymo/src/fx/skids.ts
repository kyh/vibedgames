import * as THREE from "three";

// Tire skid marks: a single mesh holding a ring buffer of dark quads stamped
// onto the road. One draw call, zero allocation per stamp, per-quad age fade.
//
// Quads use an RGBA vertex color attribute (three.js enables vertex alpha when
// the color attribute has itemSize 4), so fading is a buffer write, not a
// material change. Inactive quads are degenerate (all verts at origin).

const MAX_QUADS = 600;
const LIFE = 10; // seconds until a mark fully fades
const HALF_W = 0.14; // 0.28u wide
const HALF_L = 0.25; // ~0.5u long
const LIFT = 0.035; // above terrain, under polygonOffset the road can't z-fight

export class SkidMarks {
  readonly mesh: THREE.Mesh;
  private positions: Float32Array;
  private colors: Float32Array;
  private posAttr: THREE.BufferAttribute;
  private colAttr: THREE.BufferAttribute;
  private age = new Float32Array(MAX_QUADS); // -1 = inactive
  private baseAlpha = new Float32Array(MAX_QUADS);
  private cursor = 0;
  private activeCount = 0;

  constructor(private heightAt: (x: number, z: number) => number) {
    this.age.fill(-1);
    this.positions = new Float32Array(MAX_QUADS * 4 * 3);
    this.colors = new Float32Array(MAX_QUADS * 4 * 4); // RGBA, starts all-zero

    const index = new Uint16Array(MAX_QUADS * 6);
    for (let q = 0; q < MAX_QUADS; q++) {
      const v = q * 4;
      const t = q * 6;
      index[t] = v;
      index[t + 1] = v + 2;
      index[t + 2] = v + 1;
      index[t + 3] = v + 2;
      index[t + 4] = v + 3;
      index[t + 5] = v + 1;
    }

    const geo = new THREE.BufferGeometry();
    this.posAttr = new THREE.BufferAttribute(this.positions, 3);
    this.colAttr = new THREE.BufferAttribute(this.colors, 4);
    geo.setAttribute("position", this.posAttr);
    geo.setAttribute("color", this.colAttr);
    geo.setIndex(new THREE.BufferAttribute(index, 1));
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);

    const mat = new THREE.MeshBasicMaterial({
      color: 0xffffff, // vertex colors carry the (near-black) tint
      vertexColors: true,
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
      side: THREE.DoubleSide,
    });
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.frustumCulled = false;
  }

  // Stamp one dark quad aligned to `yaw` (forward = (sin yaw, cos yaw)) at
  // terrain height + LIFT. Ring buffer: the oldest mark is overwritten.
  stamp(x: number, z: number, yaw: number, alpha = 0.55): void {
    const q = this.cursor;
    this.cursor = (this.cursor + 1) % MAX_QUADS;
    if ((this.age[q] ?? -1) < 0) this.activeCount++;
    this.age[q] = 0;
    this.baseAlpha[q] = alpha;

    const fx = Math.sin(yaw) * HALF_L;
    const fz = Math.cos(yaw) * HALF_L;
    const rx = Math.cos(yaw) * HALF_W;
    const rz = -Math.sin(yaw) * HALF_W;

    const p = q * 4 * 3;
    // Vertex order: back-left, back-right, front-left, front-right.
    this.writeVert(p, x - fx - rx, z - fz - rz);
    this.writeVert(p + 3, x - fx + rx, z - fz + rz);
    this.writeVert(p + 6, x + fx - rx, z + fz - rz);
    this.writeVert(p + 9, x + fx + rx, z + fz + rz);
    this.posAttr.needsUpdate = true;

    this.writeQuadColor(q, alpha);
    this.colAttr.needsUpdate = true;
  }

  update(dt: number): void {
    if (this.activeCount === 0) return;
    let dirty = false;
    for (let q = 0; q < MAX_QUADS; q++) {
      const a = this.age[q] ?? -1;
      if (a < 0) continue;
      const next = a + dt;
      this.age[q] = next;
      const fade = 1 - next / LIFE;
      if (fade <= 0) {
        this.age[q] = -1;
        this.activeCount--;
        this.writeQuadColor(q, 0);
      } else {
        this.writeQuadColor(q, (this.baseAlpha[q] ?? 0) * fade);
      }
      dirty = true;
    }
    if (dirty) this.colAttr.needsUpdate = true;
  }

  private writeVert(offset: number, x: number, z: number): void {
    this.positions[offset] = x;
    this.positions[offset + 1] = this.heightAt(x, z) + LIFT;
    this.positions[offset + 2] = z;
  }

  private writeQuadColor(q: number, alpha: number): void {
    const c = q * 4 * 4;
    for (let v = 0; v < 4; v++) {
      const o = c + v * 4;
      this.colors[o] = 0.03;
      this.colors[o + 1] = 0.03;
      this.colors[o + 2] = 0.035;
      this.colors[o + 3] = alpha;
    }
  }
}
