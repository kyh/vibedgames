// A motion-trail ribbon that traces a weapon's blade through whatever animation
// is playing. Each frame (while active) it samples the blade's base + tip in
// world space and appends a segment; the ribbon is a triangle strip between
// consecutive segments, fading head→tail. Because it follows the ACTUAL animated
// weapon, the VFX lines up with every swing clip for free.
import * as THREE from "three";

const MAX_SEG = 20; // ring-buffer length (segments retained)
const FADE_MS = 200; // how long a segment lingers after it's laid down
const TIP_EXT = 0.85; // extend the blade tip past the model so the arc reads bigger
const BASE_EXT = 0.25; // and drop the inner edge a touch below the grip for width

export class WeaponTrail {
  readonly mesh: THREE.Mesh;
  private geom: THREE.BufferGeometry;
  private posAttr: THREE.BufferAttribute;
  private colAttr: THREE.BufferAttribute;
  private segs: { bx: number; by: number; bz: number; tx: number; ty: number; tz: number; t: number }[] = [];
  private activeUntil = 0;
  private readonly baseLocal: THREE.Vector3;
  private readonly tipLocal: THREE.Vector3;
  private readonly color: THREE.Color;
  private readonly v = new THREE.Vector3();

  constructor(weapon: THREE.Object3D, color: number) {
    // push the head color into HDR (>1) so the blade streak blooms
    this.color = new THREE.Color(color).multiplyScalar(1.6);
    // blade segment in the weapon's LOCAL space — compute before it's parented to
    // a bone, so the box is local (handle at one end, tip at the other).
    const box = new THREE.Box3().setFromObject(weapon);
    const size = new THREE.Vector3();
    box.getSize(size);
    const ctr = new THREE.Vector3();
    box.getCenter(ctr);
    const axis: "x" | "y" | "z" = size.x >= size.y && size.x >= size.z ? "x" : size.y >= size.z ? "y" : "z";
    this.baseLocal = ctr.clone();
    this.tipLocal = ctr.clone();
    // extend the segment past the actual blade so the swept ribbon reads as a
    // big arc, not just the blade's thin edge
    const half = (box.max[axis] - box.min[axis]) / 2;
    this.baseLocal[axis] = ctr[axis] - half * (1 + BASE_EXT);
    this.tipLocal[axis] = ctr[axis] + half * (1 + TIP_EXT);

    this.geom = new THREE.BufferGeometry();
    this.posAttr = new THREE.BufferAttribute(new Float32Array(MAX_SEG * 2 * 3), 3).setUsage(THREE.DynamicDrawUsage);
    this.colAttr = new THREE.BufferAttribute(new Float32Array(MAX_SEG * 2 * 3), 3).setUsage(THREE.DynamicDrawUsage);
    this.geom.setAttribute("position", this.posAttr);
    this.geom.setAttribute("color", this.colAttr);
    const idx: number[] = [];
    for (let i = 0; i < MAX_SEG - 1; i++) {
      const a = i * 2;
      const b = i * 2 + 1;
      const c = (i + 1) * 2;
      const d = (i + 1) * 2 + 1;
      idx.push(a, b, c, b, d, c);
    }
    this.geom.setIndex(idx);
    this.geom.setDrawRange(0, 0);
    const mat = new THREE.MeshBasicMaterial({
      vertexColors: true,
      transparent: true,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    this.mesh = new THREE.Mesh(this.geom, mat);
    this.mesh.frustumCulled = false;
    this.weapon = weapon;
  }

  private weapon: THREE.Object3D;

  /** Begin trailing for the next `durMs` of animation. */
  emit(now: number, durMs: number): void {
    this.activeUntil = now + durMs;
  }

  /** Sample the blade (while active) and rebuild the ribbon. */
  update(now: number, _dt: number): void {
    if (now < this.activeUntil) {
      this.weapon.updateWorldMatrix(true, false);
      const m = this.weapon.matrixWorld;
      this.v.copy(this.baseLocal).applyMatrix4(m);
      const bx = this.v.x;
      const by = this.v.y;
      const bz = this.v.z;
      this.v.copy(this.tipLocal).applyMatrix4(m);
      this.segs.push({ bx, by, bz, tx: this.v.x, ty: this.v.y, tz: this.v.z, t: now });
      if (this.segs.length > MAX_SEG) this.segs.shift();
    }
    // retire segments older than the fade window
    while (this.segs.length && now - this.segs[0]!.t > FADE_MS) this.segs.shift();

    const n = this.segs.length;
    if (n < 2) {
      this.geom.setDrawRange(0, 0);
      return;
    }
    const pos = this.posAttr.array as Float32Array;
    const col = this.colAttr.array as Float32Array;
    for (let i = 0; i < n; i++) {
      const s = this.segs[i]!;
      const k = Math.max(0, 1 - (now - s.t) / FADE_MS); // brightness: new→bright, old→black
      const o = i * 6;
      pos[o] = s.bx;
      pos[o + 1] = s.by;
      pos[o + 2] = s.bz;
      pos[o + 3] = s.tx;
      pos[o + 4] = s.ty;
      pos[o + 5] = s.tz;
      const r = this.color.r * k;
      const g = this.color.g * k;
      const b = this.color.b * k;
      col[o] = r;
      col[o + 1] = g;
      col[o + 2] = b;
      col[o + 3] = r;
      col[o + 4] = g;
      col[o + 5] = b;
    }
    this.posAttr.needsUpdate = true;
    this.colAttr.needsUpdate = true;
    this.geom.setDrawRange(0, (n - 1) * 6); // 6 indices per quad
  }

  dispose(): void {
    this.geom.dispose();
    (this.mesh.material as THREE.Material).dispose();
  }
}
