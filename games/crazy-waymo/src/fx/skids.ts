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
// The asphalt drape sits at terrain + 0.07 (ASPHALT_LIFT) — marks must clear
// the road SURFACE, not the terrain, or the road overlays them at distance.
const LIFT = 0.1;

export class SkidMarks {
  readonly mesh: THREE.Mesh;
  private positions: Float32Array;
  private colors: Float32Array;
  private births: Float32Array;
  private posAttr: THREE.BufferAttribute;
  private colAttr: THREE.BufferAttribute;
  private birthAttr: THREE.BufferAttribute;
  private cursor = 0;
  private time = 0;
  private timeU = { value: 0 };

  constructor(private heightAt: (x: number, z: number) => number) {
    this.positions = new Float32Array(MAX_QUADS * 4 * 3);
    this.colors = new Float32Array(MAX_QUADS * 4 * 4); // RGBA, starts all-zero
    this.births = new Float32Array(MAX_QUADS * 4);

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
    this.birthAttr = new THREE.BufferAttribute(this.births, 1);
    geo.setAttribute("position", this.posAttr);
    geo.setAttribute("color", this.colAttr);
    geo.setAttribute("aBirth", this.birthAttr);
    geo.setIndex(new THREE.BufferAttribute(index, 1));
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);

    const mat = new THREE.MeshBasicMaterial({
      color: 0xffffff, // vertex colors carry the (near-black) tint
      vertexColors: true,
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -3,
      polygonOffsetUnits: -4,
      side: THREE.DoubleSide,
    });
    // Age fade runs on the GPU: each vertex carries its stamp time and the
    // shader compares it to a clock uniform — update() advances ONE float
    // instead of rewriting (and re-uploading) the whole color buffer every
    // frame. Same curve as before: linear alpha over LIFE seconds.
    const timeU = this.timeU;
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uTime = timeU;
      shader.vertexShader = shader.vertexShader
        .replace(
          "#include <common>",
          "#include <common>\nattribute float aBirth;\nvarying float vBirth;",
        )
        .replace("#include <begin_vertex>", "#include <begin_vertex>\nvBirth = aBirth;");
      shader.fragmentShader = shader.fragmentShader
        .replace(
          "#include <common>",
          "#include <common>\nuniform float uTime;\nvarying float vBirth;",
        )
        .replace(
          "#include <color_fragment>",
          `#include <color_fragment>\n\tdiffuseColor.a *= clamp(1.0 - (uTime - vBirth) / ${LIFE.toFixed(1)}, 0.0, 1.0);`,
        );
    };
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.frustumCulled = false;
  }

  // Stamp one dark quad aligned to `yaw` (forward = (sin yaw, cos yaw)) at
  // terrain height + LIFT. Ring buffer: the oldest mark is overwritten.
  stamp(x: number, z: number, yaw: number, alpha = 0.7): void {
    const fx = Math.sin(yaw) * HALF_L;
    const fz = Math.cos(yaw) * HALF_L;
    this.stampSegment(x - fx, z - fz, x + fx, z + fz, alpha);
  }

  // Stamp a quad spanning (x0,z0) → (x1,z1) — consecutive segments share
  // their endpoints, so a braking line reads continuous, never dashed.
  stampSegment(x0: number, z0: number, x1: number, z1: number, alpha = 0.7): void {
    const dx = x1 - x0;
    const dz = z1 - z0;
    if (dx * dx + dz * dz < 0.002) return;
    const yaw = Math.atan2(dx, dz);
    const q = this.cursor;
    this.cursor = (this.cursor + 1) % MAX_QUADS;

    const rx = Math.cos(yaw) * HALF_W;
    const rz = -Math.sin(yaw) * HALF_W;

    const p = q * 4 * 3;
    // Vertex order: back-left, back-right, front-left, front-right.
    this.writeVert(p, x0 - rx, z0 - rz);
    this.writeVert(p + 3, x0 + rx, z0 + rz);
    this.writeVert(p + 6, x1 - rx, z1 - rz);
    this.writeVert(p + 9, x1 + rx, z1 + rz);
    this.posAttr.needsUpdate = true;

    const b = q * 4;
    this.births[b] = this.time;
    this.births[b + 1] = this.time;
    this.births[b + 2] = this.time;
    this.births[b + 3] = this.time;
    this.birthAttr.needsUpdate = true;

    this.writeQuadColor(q, alpha);
    this.colAttr.needsUpdate = true;
  }

  update(dt: number): void {
    // The fade is computed per-fragment from (uTime - birth) — expired quads
    // clamp to alpha 0 on the GPU and just sit in the ring until overwritten.
    this.time += dt;
    this.timeU.value = this.time;
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
