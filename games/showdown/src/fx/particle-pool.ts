// A fixed-capacity ring of billboard point sprites. Every particle lives in
// flat typed arrays that back the geometry attributes directly, so emitting is
// a handful of array writes and the per-frame update touches no objects. The
// cursor wraps: once the pool is full the oldest particle is overwritten.
import * as THREE from "three";

// oxlint-disable-next-line no-inline-comments -- the /* glsl */ tag must sit on the template line for editor shader highlighting
const PARTICLE_VERT = /* glsl */ `
  attribute vec4 aColor;
  attribute float aSize;
  uniform float uScale;
  varying vec4 vColor;
  void main() {
    vColor = aColor;
    vec4 mv = modelViewMatrix * vec4( position, 1.0 );
    gl_Position = projectionMatrix * mv;
    gl_PointSize = aSize * uScale / max( 0.1, - mv.z );
  }`;

// oxlint-disable-next-line no-inline-comments -- the /* glsl */ tag must sit on the template line for editor shader highlighting
const PARTICLE_FRAG = /* glsl */ `
  uniform float uDim;
  varying vec4 vColor;
  void main() {
    float d = length( gl_PointCoord - 0.5 );
    float a = smoothstep( 0.5, 0.12, d ) * vColor.a;
    if ( a < 0.004 ) discard;
    gl_FragColor = vec4( vColor.rgb * uDim, a );
  }`;

// Particles that bounce never sink below this height, so they stay visible
// above the ground plane instead of z-fighting with it.
const FLOOR_Y = 0.03;

export class ParticlePool {
  cap: number;
  cursor: number;
  additive: boolean;
  pos: Float32Array;
  col: Float32Array;
  size: Float32Array;
  vel: Float32Array;
  life: Float32Array;
  maxLife: Float32Array;
  size0: Float32Array;
  size1: Float32Array;
  alpha: Float32Array;
  drag: Float32Array;
  grav: Float32Array;
  uniforms: { uDim: { value: number }; uScale: { value: number } };
  material: THREE.ShaderMaterial;
  points: THREE.Points;
  private readonly positionAttr: THREE.BufferAttribute;
  private readonly colorAttr: THREE.BufferAttribute;
  private readonly sizeAttr: THREE.BufferAttribute;

  constructor(scene: THREE.Scene, cap: number, additive: boolean) {
    this.cap = cap;
    this.cursor = 0;
    this.additive = additive;
    this.pos = new Float32Array(cap * 3);
    this.col = new Float32Array(cap * 4);
    this.size = new Float32Array(cap);
    this.vel = new Float32Array(cap * 3);
    this.life = new Float32Array(cap);
    this.maxLife = new Float32Array(cap);
    this.size0 = new Float32Array(cap);
    this.size1 = new Float32Array(cap);
    this.alpha = new Float32Array(cap);
    this.drag = new Float32Array(cap);
    this.grav = new Float32Array(cap);
    const geometry = new THREE.BufferGeometry();
    this.positionAttr = new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage);
    this.colorAttr = new THREE.BufferAttribute(this.col, 4).setUsage(THREE.DynamicDrawUsage);
    this.sizeAttr = new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute("position", this.positionAttr);
    geometry.setAttribute("aColor", this.colorAttr);
    geometry.setAttribute("aSize", this.sizeAttr);
    this.uniforms = { uDim: { value: 1 }, uScale: { value: 600 } };
    this.material = new THREE.ShaderMaterial({
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      depthWrite: false,
      fragmentShader: PARTICLE_FRAG,
      transparent: true,
      uniforms: this.uniforms,
      vertexShader: PARTICLE_VERT,
    });
    this.points = new THREE.Points(geometry, this.material);
    this.points.frustumCulled = false;
    // Additive glow draws after smoke so it always reads on top of it.
    this.points.renderOrder = additive ? 8 : 7;
    scene.add(this.points);
  }

  emit(
    x: number,
    y: number,
    z: number,
    vx: number,
    vy: number,
    vz: number,
    life: number,
    size0: number,
    size1: number,
    r: number,
    g: number,
    b: number,
    alpha = 1,
    drag = 1.5,
    grav = 0,
  ): void {
    const i = this.cursor;
    this.cursor = (i + 1) % this.cap;
    this.pos[i * 3] = x;
    this.pos[i * 3 + 1] = y;
    this.pos[i * 3 + 2] = z;
    this.vel[i * 3] = vx;
    this.vel[i * 3 + 1] = vy;
    this.vel[i * 3 + 2] = vz;
    this.life[i] = life;
    this.maxLife[i] = life;
    this.size0[i] = size0;
    this.size1[i] = size1;
    this.col[i * 4] = r;
    this.col[i * 4 + 1] = g;
    this.col[i * 4 + 2] = b;
    this.alpha[i] = alpha;
    this.drag[i] = drag;
    this.grav[i] = grav;
  }

  update(dt: number): void {
    const { pos, vel, life, maxLife, size, size0, size1, col, alpha, drag, grav } = this;
    for (let i = 0; i < this.cap; i += 1) {
      if ((life[i] ?? 0) <= 0) {
        size[i] = 0;
        continue;
      }
      const remaining = (life[i] ?? 0) - dt;
      life[i] = remaining;
      const t = 1 - Math.max(0, remaining) / (maxLife[i] ?? 1);
      const decay = Math.exp(-(drag[i] ?? 0) * dt);
      const gravity = grav[i] ?? 0;
      const velX = (vel[i * 3] ?? 0) * decay;
      let velY = (vel[i * 3 + 1] ?? 0) * decay - gravity * dt;
      const velZ = (vel[i * 3 + 2] ?? 0) * decay;
      let posY = (pos[i * 3 + 1] ?? 0) + velY * dt;
      // Falling particles bounce off the ground, losing most of their energy.
      if (posY < FLOOR_Y && gravity > 0) {
        posY = FLOOR_Y;
        velY *= -0.35;
      }
      vel[i * 3] = velX;
      vel[i * 3 + 1] = velY;
      vel[i * 3 + 2] = velZ;
      pos[i * 3] = (pos[i * 3] ?? 0) + velX * dt;
      pos[i * 3 + 1] = posY;
      pos[i * 3 + 2] = (pos[i * 3 + 2] ?? 0) + velZ * dt;
      const from = size0[i] ?? 0;
      const to = size1[i] ?? 0;
      size[i] = remaining <= 0 ? 0 : from + (to - from) * t;
      col[i * 4 + 3] = (alpha[i] ?? 0) * (1 - t * t);
    }
    this.positionAttr.needsUpdate = true;
    this.colorAttr.needsUpdate = true;
    this.sizeAttr.needsUpdate = true;
  }
}
