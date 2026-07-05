// A stylized slash ribbon that traces a weapon's blade through whatever
// animation is playing — the Gabriel Aguiar sword-slash treatment (panned
// noise + alpha erosion + hot HDR leading edge) applied to a swept surface
// that follows the REAL animated blade, so the arc spans the entire swing.
//
// Each frame (while active) it samples the blade's base + tip in world space
// and appends a segment; the ribbon is a triangle strip between consecutive
// segments. The shader gets per-vertex (age, across) coordinates: `age` drives
// the erosion dissolve, `across` shapes the crescent cross-section with a
// white-hot edge at the blade line.
import * as THREE from "three";

const MAX_SEG = 28; // raw blade samples retained (one per render frame)
const SUBDIV = 4; // spline subdivisions between samples — the strip stays a smooth
//                   continuous curve even when a fast spin sweeps 20°+ per frame
const MAX_ROWS = (MAX_SEG - 1) * SUBDIV + 1;
const FADE_MS = 260; // how long a sample lingers — the visible arc length
const TIP_EXT = 1.1; // extend the blade tip past the model so the arc reads bigger
const BASE_FRAC = 0.34; // ribbon starts this far up the weapon — the BLADE only, never the handle

/** Per-weapon override for blades whose bbox longest-axis heuristic degenerates
 *  (2H/hammer heads are wider than the shaft). `axis` = the swing axis of the
 *  blade in the weapon's local space; `base` = fraction of the weapon's length
 *  where the ribbon starts (0 = grip butt — keep it past the handle); `tip` =
 *  extension past the tip (× half-length); optional `opacity` bumps peak alpha. */
export type TrailOverride = { axis: "x" | "y" | "z"; base: number; tip: number; opacity?: number };

const VERT = /* glsl */ `
attribute float aAge;    // 0 fresh → 1 expired
attribute float aAcross; // 0 base edge → 1 blade tip edge
varying float vAge;
varying float vAcross;
varying float vAlong;    // arc-length coordinate for the panning noise
attribute float aAlong;
void main() {
  vAge = aAge;
  vAcross = aAcross;
  vAlong = aAlong;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const FRAG = /* glsl */ `
uniform vec3 uColor;
uniform float uOpacity;
varying float vAge;
varying float vAcross;
varying float vAlong;
float hash21(vec2 p){ p = fract(p*vec2(234.34,435.345)); p += dot(p,p+34.23); return fract(p.x*p.y); }
float vnoise(vec2 p){
  vec2 i = floor(p); vec2 f = fract(p); f = f*f*(3.0-2.0*f);
  float a = hash21(i), b = hash21(i+vec2(1,0)), c = hash21(i+vec2(0,1)), d = hash21(i+vec2(1,1));
  return mix(mix(a,b,f.x), mix(c,d,f.x), f.y);
}
void main() {
  // CRESCENT taper: the inner edge climbs toward the tip line as the surface
  // ages, so the arc is full-width at the blade and narrows to a POINT at the
  // tail — one solid crescent silhouette.
  // near-LINEAR narrowing from the blade to the tail — the crescent thins
  // steadily and ends in a long sharp point (an eased cut keeps the band fat
  // until the end, which reads as a round blob, not an angle)
  float cut = 1.05 * pow(vAge, 0.85);
  float body = smoothstep(cut, cut + 0.34, vAcross); // crisp at the blade line — no outer feather
  // SOLID surface — any along-arc noise reads as fan-blade striping on a fast
  // spin. Noise only roughs up the tail edge so the fade-out stays organic.
  float n = vnoise(vec2(vAlong * 1.5, vAcross * 2.0));
  float tail = 1.0 - smoothstep(0.78, 1.0, vAge + (n - 0.5) * 0.08); // alpha holds — the GEOMETRIC point defines the end
  // NORMAL blending keeps the champ color TRUE (additive summed toward white
  // over the bright floor); the blade line alone runs HDR so bloom catches it
  float edge = smoothstep(0.8, 0.98, vAcross);
  vec3 c = mix(uColor, vec3(1.0), edge * 0.4) * (0.9 + 0.8 * edge * (1.0 - vAge));
  float a = body * tail * (1.0 - 0.4 * vAge) * uOpacity;
  if (a < 0.004) discard;
  gl_FragColor = vec4(c, a);
}`;

// depth prepass: identical coverage math, writes no color — just claims the
// front-most surface so fold-over layers behind it are culled by depth test
const FRAG_DEPTH = /* glsl */ `
uniform float uOpacity;
varying float vAge;
varying float vAcross;
varying float vAlong;
float hash21(vec2 p){ p = fract(p*vec2(234.34,435.345)); p += dot(p,p+34.23); return fract(p.x*p.y); }
float vnoise(vec2 p){
  vec2 i = floor(p); vec2 f = fract(p); f = f*f*(3.0-2.0*f);
  float a = hash21(i), b = hash21(i+vec2(1,0)), c = hash21(i+vec2(0,1)), d = hash21(i+vec2(1,1));
  return mix(mix(a,b,f.x), mix(c,d,f.x), f.y);
}
void main() {
  float cut = 1.05 * pow(vAge, 0.85);
  float body = smoothstep(cut, cut + 0.34, vAcross);
  float n = vnoise(vec2(vAlong * 1.5, vAcross * 2.0));
  float tail = 1.0 - smoothstep(0.78, 1.0, vAge + (n - 0.5) * 0.08);
  float a = body * tail * (1.0 - 0.4 * vAge) * uOpacity;
  if (a < 0.05) discard; // near-invisible texels must not claim depth
  gl_FragColor = vec4(0.0);
}`;

// CENTRIPETAL Catmull-Rom (Barry-Goldman) for one scalar channel. Uniform CR
// overshoots badly when samples are irregularly spaced (frame-time jitter at
// low fps) — the tip edge loops back on itself in-plane and the doubled
// translucency reads as comb teeth. Centripetal parameterization provably
// never loops or cusps inside a segment.
function crCentripetal(p0: number, p1: number, p2: number, p3: number, t: number, k0: number, k1: number, k2: number): number {
  const t1 = k0;
  const t2 = k0 + k1;
  const t3 = k0 + k1 + k2;
  const tt = t1 + t * k1;
  const a1 = p0 + ((p1 - p0) * (tt - 0)) / t1;
  const a2 = p1 + ((p2 - p1) * (tt - t1)) / k1;
  const a3 = p2 + ((p3 - p2) * (tt - t2)) / k2;
  const b1 = a1 + ((a2 - a1) * (tt - 0)) / t2;
  const b2 = a2 + ((a3 - a2) * (tt - t1)) / (t3 - t1);
  return b1 + ((b2 - b1) * (tt - t1)) / k1;
}

export class WeaponTrail {
  /** Add/remove THIS from the scene — holds the depth prepass + color pass. */
  readonly mesh: THREE.Group;
  private matPre: THREE.ShaderMaterial;
  private matColor: THREE.ShaderMaterial;
  private geom: THREE.BufferGeometry;
  private posAttr: THREE.BufferAttribute;
  private ageAttr: THREE.BufferAttribute;
  private acrossAttr: THREE.BufferAttribute;
  private alongAttr: THREE.BufferAttribute;
  private segs: { bx: number; by: number; bz: number; tx: number; ty: number; tz: number; t: number; s: number }[] = [];
  private arc = 0; // accumulated arc length (drives the panning coordinate)
  private activeUntil = 0;
  // RENDER-time clock (ms, advances on the hit-stop-scaled render dt). The sim
  // clock only ticks at 30Hz — stamping segment ages with it quantizes the
  // fade/taper into 33ms cohorts that render as a hard sawtooth staircase.
  private clock = 0;
  private readonly baseLocal: THREE.Vector3;
  private readonly tipLocal: THREE.Vector3;
  private readonly v = new THREE.Vector3();

  constructor(weapon: THREE.Object3D, color: number, override?: TrailOverride) {
    // blade segment in the weapon's LOCAL space — compute before it's parented to
    // a bone, so the box is local (handle at one end, tip at the other).
    const box = new THREE.Box3().setFromObject(weapon);
    const size = new THREE.Vector3();
    box.getSize(size);
    const ctr = new THREE.Vector3();
    box.getCenter(ctr);
    // an override forces the swing axis (the bbox heuristic picks the widest axis,
    // which is wrong for hammer heads); otherwise pick the longest bbox axis.
    const axis: "x" | "y" | "z" = override ? override.axis : size.x >= size.y && size.x >= size.z ? "x" : size.y >= size.z ? "y" : "z";
    const baseFrac = override ? override.base : BASE_FRAC;
    const tipExt = override ? override.tip : TIP_EXT;
    this.baseLocal = ctr.clone();
    this.tipLocal = ctr.clone();
    // inner edge starts partway up the weapon (blade only — a ribbon rooted at
    // the grip reads as the HANDLE glowing); tip extends past the blade so the
    // swept arc reads bigger than the model
    const half = (box.max[axis] - box.min[axis]) / 2;
    this.baseLocal[axis] = box.min[axis] + half * 2 * baseFrac;
    this.tipLocal[axis] = ctr[axis] + half * (1 + tipExt);

    this.geom = new THREE.BufferGeometry();
    this.posAttr = new THREE.BufferAttribute(new Float32Array(MAX_ROWS * 2 * 3), 3).setUsage(THREE.DynamicDrawUsage);
    this.ageAttr = new THREE.BufferAttribute(new Float32Array(MAX_ROWS * 2), 1).setUsage(THREE.DynamicDrawUsage);
    this.acrossAttr = new THREE.BufferAttribute(new Float32Array(MAX_ROWS * 2), 1).setUsage(THREE.DynamicDrawUsage);
    this.alongAttr = new THREE.BufferAttribute(new Float32Array(MAX_ROWS * 2), 1).setUsage(THREE.DynamicDrawUsage);
    this.geom.setAttribute("position", this.posAttr);
    this.geom.setAttribute("aAge", this.ageAttr);
    this.geom.setAttribute("aAcross", this.acrossAttr);
    this.geom.setAttribute("aAlong", this.alongAttr);
    const idx: number[] = [];
    for (let i = 0; i < MAX_ROWS - 1; i++) {
      const a = i * 2;
      const b = i * 2 + 1;
      const c = (i + 1) * 2;
      const d = (i + 1) * 2 + 1;
      idx.push(a, b, c, b, d, c);
    }
    this.geom.setIndex(idx);
    this.geom.setDrawRange(0, 0);
    // Two-pass rendering so the ribbon can twist through 3D following the real
    // blade WITHOUT self-overlap artifacts: pass 1 writes only the front-most
    // depth, pass 2 draws color — hidden fold layers fail the depth test, so
    // every pixel composites exactly ONE layer. (The classic fix for
    // self-overlapping transparent trails.)
    const uniforms = {
      uColor: { value: new THREE.Color(color) },
      uOpacity: { value: override?.opacity ?? 0.5 },
    };
    this.matPre = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG_DEPTH,
      uniforms,
      transparent: true, // sorts with the transparent pass
      side: THREE.DoubleSide,
      depthWrite: true,
      colorWrite: false,
    });
    this.matColor = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms,
      transparent: true,
      blending: THREE.NormalBlending, // additive washes to white over a lit floor
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    const pre = new THREE.Mesh(this.geom, this.matPre);
    pre.renderOrder = 1;
    pre.frustumCulled = false;
    const color3 = new THREE.Mesh(this.geom, this.matColor);
    color3.renderOrder = 2;
    color3.frustumCulled = false;
    this.mesh = new THREE.Group();
    this.mesh.add(pre, color3);
    this.weapon = weapon;
  }

  private weapon: THREE.Object3D;

  /** Begin trailing for the next `durMs` of animation. */
  emit(durMs: number): void {
    this.activeUntil = this.clock + durMs;
  }

  /** Sample the blade (while active) and rebuild the ribbon. `dt` is the
   *  hit-stop-scaled render delta — the trail freezes with the rest of the fx. */
  update(dt: number): void {
    this.clock += dt * 1000;
    const now = this.clock;
    if (now < this.activeUntil) {
      this.weapon.updateWorldMatrix(true, false);
      const m = this.weapon.matrixWorld;
      this.v.copy(this.baseLocal).applyMatrix4(m);
      const bx = this.v.x;
      const by = this.v.y;
      const bz = this.v.z;
      this.v.copy(this.tipLocal).applyMatrix4(m);
      const tx = this.v.x;
      const ty = this.v.y;
      const tz = this.v.z;
      // pan coordinate advances with actual tip travel — noise streaks stay
      // glued to the arc instead of swimming
      const prev = this.segs[this.segs.length - 1];
      if (prev) this.arc += Math.hypot(tx - prev.tx, ty - prev.ty, tz - prev.tz) * 0.22;
      this.segs.push({ bx, by, bz, tx, ty, tz, t: now, s: this.arc });
      if (this.segs.length > MAX_SEG) this.segs.shift();
    }
    // retire segments older than the fade window
    while (this.segs.length && now - this.segs[0]!.t > FADE_MS) this.segs.shift();

    const n = this.segs.length;
    if (n < 2) {
      this.geom.setDrawRange(0, 0);
      return;
    }
    // Catmull-Rom through the raw samples: a fast swing can sweep 20°+ between
    // frames, and a straight quad per frame reads as a fan of disconnected
    // petals. Subdividing along the spline keeps the crescent one smooth sheet.
    const pos = this.posAttr.array as Float32Array;
    const age = this.ageAttr.array as Float32Array;
    const across = this.acrossAttr.array as Float32Array;
    const along = this.alongAttr.array as Float32Array;
    let row = 0;
    const segs = this.segs;
    const putRow = (bx: number, by: number, bz: number, tx: number, ty: number, tz: number, a: number, s: number): void => {
      const o = row * 6;
      pos[o] = bx;
      pos[o + 1] = by;
      pos[o + 2] = bz;
      pos[o + 3] = tx;
      pos[o + 4] = ty;
      pos[o + 5] = tz;
      const o2 = row * 2;
      age[o2] = a;
      age[o2 + 1] = a;
      across[o2] = 0;
      across[o2 + 1] = 1;
      along[o2] = s;
      along[o2 + 1] = s;
      row++;
    };
    const cr = crCentripetal;
    const aOldest = Math.max(0.25, Math.min(1, (now - segs[0]!.t) / FADE_MS));
    // 3-tap smoothing of the control points before splining — swing clips pump
    // the blade radius slightly every pose sample, and Catmull-Rom faithfully
    // reproduces each wobble as a radial ridge on fast spins
    const sm = (i: number): { bx: number; by: number; bz: number; tx: number; ty: number; tz: number; t: number; s: number } => {
      const p = segs[Math.max(0, i - 1)]!;
      const c = segs[Math.min(n - 1, Math.max(0, i))]!;
      const q = segs[Math.min(n - 1, i + 1)]!;
      return {
        bx: (p.bx + 2 * c.bx + q.bx) / 4,
        by: (p.by + 2 * c.by + q.by) / 4,
        bz: (p.bz + 2 * c.bz + q.bz) / 4,
        tx: (p.tx + 2 * c.tx + q.tx) / 4,
        ty: (p.ty + 2 * c.ty + q.ty) / 4,
        tz: (p.tz + 2 * c.tz + q.tz) / 4,
        t: c.t,
        s: c.s,
      };
    };
    for (let i = 0; i < n - 1; i++) {
      const s0 = sm(i - 1);
      const s1 = sm(i);
      const s2 = sm(i + 1);
      const s3 = sm(i + 2);
      // ages NORMALIZED against the oldest surviving row: when the sample cap
      // trims the tail early (hit-stop slows the clock but sampling continues),
      // raw ages never reach 1 and the taper stops mid-band — a blunt chord
      // instead of a point. Normalizing pins the taper's point to the strip end.
      const a1 = Math.min(1, (now - s1.t) / FADE_MS) / aOldest;
      const a2 = Math.min(1, (now - s2.t) / FADE_MS) / aOldest;
      // centripetal knots from tip travel (√distance), shared by every channel
      const k0 = Math.max(0.02, Math.sqrt(Math.hypot(s1.tx - s0.tx, s1.ty - s0.ty, s1.tz - s0.tz)));
      const k1 = Math.max(0.02, Math.sqrt(Math.hypot(s2.tx - s1.tx, s2.ty - s1.ty, s2.tz - s1.tz)));
      const k2 = Math.max(0.02, Math.sqrt(Math.hypot(s3.tx - s2.tx, s3.ty - s2.ty, s3.tz - s2.tz)));
      const steps = i === n - 2 ? SUBDIV + 1 : SUBDIV; // include the final head row
      for (let k = 0; k < steps; k++) {
        const t = k / SUBDIV;
        putRow(
          cr(s0.bx, s1.bx, s2.bx, s3.bx, t, k0, k1, k2),
          cr(s0.by, s1.by, s2.by, s3.by, t, k0, k1, k2),
          cr(s0.bz, s1.bz, s2.bz, s3.bz, t, k0, k1, k2),
          cr(s0.tx, s1.tx, s2.tx, s3.tx, t, k0, k1, k2),
          cr(s0.ty, s1.ty, s2.ty, s3.ty, t, k0, k1, k2),
          cr(s0.tz, s1.tz, s2.tz, s3.tz, t, k0, k1, k2),
          Math.min(1, Math.max(0, a1 + (a2 - a1) * t)), // linear normalized age — monotonic, no overshoot flicker
          s1.s + (s2.s - s1.s) * t,
        );
      }
    }
    this.posAttr.needsUpdate = true;
    this.ageAttr.needsUpdate = true;
    this.acrossAttr.needsUpdate = true;
    this.alongAttr.needsUpdate = true;
    this.geom.setDrawRange(0, (row - 1) * 6); // 6 indices per quad row
  }

  dispose(): void {
    this.geom.dispose();
    this.matPre.dispose();
    this.matColor.dispose();
  }
}
