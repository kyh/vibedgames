import * as THREE from "three";

export interface EmitOpts {
  count: number;
  color: THREE.Color;
  speed: number;
  // lateral velocity spread
  spread: number;
  // upward bias
  up: number;
  size: number;
  life: number;
  gravity: number;
  drag: number;
  // Optional directional term: final velocity = radial term + dir * dirSpeed.
  dir?: { x: number; y: number; z: number };
  dirSpeed?: number;
  // HDR multiplier on color before additive blending. Hot FX author 2.2-3.4
  // so a lone grain clears the ~1.6 day bloom gate through the max-channel
  // Reinhard shoulder; inert debris (sand, grass flecks) stays at 1 and never
  // blooms — no separate opt-out needed.
  intensity?: number;
  // Tier channel: the grain's color is uTierCol * intensity, re-read every
  // frame — a tier promotion repaints grains already in the air (sparks only).
  channel?: boolean;
  // Inert chips share the lit, normal-blend pool but keep a sharp silhouette.
  grain?: boolean;
}

// vAlpha = remaining life fraction (1 at birth -> 0 at death).
// uGrow selects the size ramp: 0 = shrink over life (sparks: 1.4 -> 0.6),
// 1 = grow over life (smoke: 0.7 -> 1.5).
const VERT = `
  attribute float aLife;
  attribute float aMax;
  attribute float aSize;
  attribute vec3 aColor;
  attribute float aChannel;
  attribute float aGrain;
  uniform float uScale;
  uniform float uGrow;
  uniform vec3 uTierCol;
  varying float vAlpha;
  varying vec3 vColor;
  varying float vGrain;
  void main() {
    vGrain = aGrain;
    vColor = aColor * mix(vec3(1.0), uTierCol, aChannel);
    vAlpha = clamp(aLife / max(aMax, 0.0001), 0.0, 1.0);
    float shrinkRamp = mix(0.6, 1.4, vAlpha);
    float growRamp = mix(1.5, 0.7, vAlpha);
    float ramp = mix(shrinkRamp, growRamp, uGrow * (1.0 - aGrain));
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mv;
    gl_PointSize = (aLife <= 0.0) ? 0.0 : aSize * ramp * uScale / max(-mv.z, 0.1);
  }
`;

/** Queue `count` items from `first` for the next upload (ranges accumulate). */
const mark = (attr: THREE.BufferAttribute, first: number, count: number): void => {
  attr.addUpdateRange(first * attr.itemSize, count * attr.itemSize);
  attr.needsUpdate = true;
};

export class ParticleField {
  readonly points: THREE.Points;
  private n: number;
  private pos: Float32Array;
  private col: Float32Array;
  private size: Float32Array;
  private life: Float32Array;
  private max: Float32Array;
  private chan: Float32Array;
  private grain: Float32Array;
  private vel: Float32Array;
  private grav: Float32Array;
  private drag: Float32Array;
  private cursor = 0;
  private mat: THREE.ShaderMaterial;
  private readonly posAttr: THREE.BufferAttribute;
  private readonly lifeAttr: THREE.BufferAttribute;
  // aColor, aSize, aMax, aChannel, aGrain only change in emit()
  private readonly emitAttrs: readonly THREE.BufferAttribute[];
  private scaleUniform = { value: typeof window === "undefined" ? 1 : window.innerHeight };

  constructor(
    n: number,
    blending: THREE.Blending,
    grow: boolean,
    frag: string,
    extraUniforms: Record<string, THREE.IUniform>,
  ) {
    this.n = n;
    this.pos = new Float32Array(n * 3);
    this.col = new Float32Array(n * 3);
    this.size = new Float32Array(n);
    this.life = new Float32Array(n);
    this.max = new Float32Array(n);
    this.chan = new Float32Array(n);
    this.grain = new Float32Array(n);
    this.vel = new Float32Array(n * 3);
    this.grav = new Float32Array(n);
    this.drag = new Float32Array(n);

    const geo = new THREE.BufferGeometry();
    this.posAttr = new THREE.BufferAttribute(this.pos, 3);
    this.lifeAttr = new THREE.BufferAttribute(this.life, 1);
    const colAttr = new THREE.BufferAttribute(this.col, 3);
    const sizeAttr = new THREE.BufferAttribute(this.size, 1);
    const maxAttr = new THREE.BufferAttribute(this.max, 1);
    const chanAttr = new THREE.BufferAttribute(this.chan, 1);
    const grainAttr = new THREE.BufferAttribute(this.grain, 1);
    this.emitAttrs = [colAttr, sizeAttr, maxAttr, chanAttr, grainAttr];
    for (const a of [this.posAttr, this.lifeAttr, ...this.emitAttrs]) {
      a.setUsage(THREE.DynamicDrawUsage);
    }
    geo.setAttribute("position", this.posAttr);
    geo.setAttribute("aColor", colAttr);
    geo.setAttribute("aSize", sizeAttr);
    geo.setAttribute("aLife", this.lifeAttr);
    geo.setAttribute("aMax", maxAttr);
    geo.setAttribute("aChannel", chanAttr);
    geo.setAttribute("aGrain", grainAttr);
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);

    this.mat = new THREE.ShaderMaterial({
      blending,
      depthWrite: false,
      fragmentShader: frag,
      transparent: true,
      uniforms: { uGrow: { value: grow ? 1 : 0 }, uScale: this.scaleUniform, ...extraUniforms },
      vertexShader: VERT,
    });
    this.points = new THREE.Points(geo, this.mat);
    this.points.frustumCulled = false;
  }

  setScale(px: number): void {
    this.scaleUniform.value = px;
  }

  emit(x: number, y: number, z: number, o: EmitOpts): void {
    const { dir } = o;
    const ds = o.dirSpeed ?? 0;
    const dx = dir ? dir.x * ds : 0;
    const dy = dir ? dir.y * ds : 0;
    const dz = dir ? dir.z * ds : 0;
    const intensity = o.intensity ?? 1;
    const first = this.cursor;
    for (let k = 0; k < o.count; k += 1) {
      const i = this.cursor;
      this.cursor = (this.cursor + 1) % this.n;
      this.pos[i * 3] = x;
      this.pos[i * 3 + 1] = y;
      this.pos[i * 3 + 2] = z;
      const ang = Math.random() * Math.PI * 2;
      const sp = o.speed * (0.4 + Math.random() * 0.6);
      this.vel[i * 3] = Math.cos(ang) * o.spread + Math.cos(ang) * sp + dx;
      this.vel[i * 3 + 1] = o.up * (0.5 + Math.random()) + dy;
      this.vel[i * 3 + 2] = Math.sin(ang) * o.spread + Math.sin(ang) * sp + dz;
      this.col[i * 3] = o.color.r * intensity;
      this.col[i * 3 + 1] = o.color.g * intensity;
      this.col[i * 3 + 2] = o.color.b * intensity;
      this.size[i] = o.size * (0.7 + Math.random() * 0.6);
      this.life[i] = o.life;
      this.max[i] = o.life;
      this.chan[i] = o.channel ? 1 : 0;
      this.grain[i] = o.grain ? 1 : 0;
      this.grav[i] = o.gravity;
      this.drag[i] = o.drag;
    }
    // Upload from here, not from update(): the game emits after the fields
    // tick, and a burst has to show on the frame it fires. A ring wrap just
    // sends the whole pool once.
    const wrapped = first + o.count > this.n;
    const start = wrapped ? 0 : first;
    const count = wrapped ? this.n : o.count;
    if (count === 0) {
      return;
    }
    mark(this.posAttr, start, count);
    mark(this.lifeAttr, start, count);
    for (const a of this.emitAttrs) {
      mark(a, start, count);
    }
  }

  update(dt: number): void {
    // Touched span: every particle that was alive going in, including the
    // ones that die this step — their aLife <= 0 is what hides them.
    let lo = this.n;
    let hi = -1;
    for (let i = 0; i < this.n; i += 1) {
      const life = this.life[i] ?? 0;
      if (life <= 0) {
        continue;
      }
      lo = Math.min(lo, i);
      hi = i;
      this.life[i] = life - dt;
      const dragF = Math.exp(-(this.drag[i] ?? 0) * dt);
      const b = i * 3;
      const vx = (this.vel[b] ?? 0) * dragF;
      const vy = (this.vel[b + 1] ?? 0) * dragF - (this.grav[i] ?? 0) * dt;
      const vz = (this.vel[b + 2] ?? 0) * dragF;
      this.vel[b] = vx;
      this.vel[b + 1] = vy;
      this.vel[b + 2] = vz;
      this.pos[b] = (this.pos[b] ?? 0) + vx * dt;
      this.pos[b + 1] = (this.pos[b + 1] ?? 0) + vy * dt;
      this.pos[b + 2] = (this.pos[b + 2] ?? 0) + vz * dt;
    }
    if (hi < lo) {
      return;
    }
    mark(this.posAttr, lo, hi - lo + 1);
    mark(this.lifeAttr, lo, hi - lo + 1);
  }
}
