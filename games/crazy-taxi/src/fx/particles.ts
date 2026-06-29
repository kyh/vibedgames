import * as THREE from "three";

type EmitOpts = {
  count: number;
  color: THREE.Color;
  speed: number;
  spread: number; // lateral velocity spread
  up: number; // upward bias
  size: number;
  life: number;
  gravity: number;
  drag: number;
};

const VERT = `
  attribute float aLife;
  attribute float aMax;
  attribute float aSize;
  attribute vec3 aColor;
  uniform float uScale;
  varying float vAlpha;
  varying vec3 vColor;
  void main() {
    vColor = aColor;
    vAlpha = clamp(aLife / max(aMax, 0.0001), 0.0, 1.0);
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mv;
    gl_PointSize = (aLife <= 0.0) ? 0.0 : aSize * uScale / max(-mv.z, 0.1);
  }
`;
const FRAG = `
  varying float vAlpha;
  varying vec3 vColor;
  void main() {
    vec2 d = gl_PointCoord - vec2(0.5);
    float r = dot(d, d);
    if (r > 0.25) discard;
    float soft = smoothstep(0.25, 0.0, r);
    gl_FragColor = vec4(vColor, vAlpha * soft);
  }
`;

class ParticleField {
  readonly points: THREE.Points;
  private pos: Float32Array;
  private col: Float32Array;
  private size: Float32Array;
  private life: Float32Array;
  private max: Float32Array;
  private vel: Float32Array;
  private grav: Float32Array;
  private drag: Float32Array;
  private cursor = 0;
  private mat: THREE.ShaderMaterial;
  private scaleUniform = { value: window.innerHeight };

  constructor(
    private n: number,
    blending: THREE.Blending,
  ) {
    this.pos = new Float32Array(n * 3);
    this.col = new Float32Array(n * 3);
    this.size = new Float32Array(n);
    this.life = new Float32Array(n);
    this.max = new Float32Array(n);
    this.vel = new Float32Array(n * 3);
    this.grav = new Float32Array(n);
    this.drag = new Float32Array(n);

    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(this.pos, 3));
    geo.setAttribute("aColor", new THREE.BufferAttribute(this.col, 3));
    geo.setAttribute("aSize", new THREE.BufferAttribute(this.size, 1));
    geo.setAttribute("aLife", new THREE.BufferAttribute(this.life, 1));
    geo.setAttribute("aMax", new THREE.BufferAttribute(this.max, 1));
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);

    this.mat = new THREE.ShaderMaterial({
      uniforms: { uScale: this.scaleUniform },
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
      blending,
    });
    this.points = new THREE.Points(geo, this.mat);
    this.points.frustumCulled = false;
  }

  setScale(px: number): void {
    this.scaleUniform.value = px;
  }

  emit(x: number, y: number, z: number, o: EmitOpts): void {
    for (let k = 0; k < o.count; k++) {
      const i = this.cursor;
      this.cursor = (this.cursor + 1) % this.n;
      this.pos[i * 3] = x;
      this.pos[i * 3 + 1] = y;
      this.pos[i * 3 + 2] = z;
      const ang = Math.random() * Math.PI * 2;
      const sp = o.speed * (0.4 + Math.random() * 0.6);
      this.vel[i * 3] = Math.cos(ang) * o.spread + Math.cos(ang) * sp;
      this.vel[i * 3 + 1] = o.up * (0.5 + Math.random());
      this.vel[i * 3 + 2] = Math.sin(ang) * o.spread + Math.sin(ang) * sp;
      this.col[i * 3] = o.color.r;
      this.col[i * 3 + 1] = o.color.g;
      this.col[i * 3 + 2] = o.color.b;
      this.size[i] = o.size * (0.7 + Math.random() * 0.6);
      this.life[i] = o.life;
      this.max[i] = o.life;
      this.grav[i] = o.gravity;
      this.drag[i] = o.drag;
    }
  }

  update(dt: number): void {
    for (let i = 0; i < this.n; i++) {
      const life = this.life[i] ?? 0;
      if (life <= 0) continue;
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
    const geo = this.points.geometry;
    geo.getAttribute("position").needsUpdate = true;
    geo.getAttribute("aColor").needsUpdate = true;
    geo.getAttribute("aSize").needsUpdate = true;
    geo.getAttribute("aLife").needsUpdate = true;
  }
}

// High-level effects used by the game.
export class Fx {
  readonly smoke = new ParticleField(420, THREE.NormalBlending);
  readonly sparks = new ParticleField(500, THREE.AdditiveBlending);
  private tmp = new THREE.Color();

  addTo(scene: THREE.Scene): void {
    scene.add(this.smoke.points);
    scene.add(this.sparks.points);
  }
  setScale(px: number): void {
    this.smoke.setScale(px);
    this.sparks.setScale(px);
  }

  driftPuff(x: number, z: number, boosting: boolean): void {
    this.tmp.setHSL(0, 0, boosting ? 0.85 : 0.72);
    this.smoke.emit(x, 0.3, z, {
      count: 2,
      color: this.tmp,
      speed: 1.0,
      spread: 1.2,
      up: 1.5,
      size: 1.9,
      life: 0.6,
      gravity: -1.2,
      drag: 2.4,
    });
    if (boosting) {
      this.tmp.setHSL(0.08, 1, 0.6);
      this.sparks.emit(x, 0.3, z, {
        count: 3,
        color: this.tmp,
        speed: 5,
        spread: 1,
        up: 0.5,
        size: 1.1,
        life: 0.35,
        gravity: 0,
        drag: 3,
      });
    }
  }

  burst(x: number, y: number, z: number, hue: number, count: number, power: number): void {
    for (let i = 0; i < count; i++) {
      this.tmp.setHSL((hue + Math.random() * 0.12) % 1, 0.9, 0.6);
      this.sparks.emit(x, y, z, {
        count: 1,
        color: this.tmp,
        speed: power * (0.5 + Math.random()),
        spread: 1,
        up: power * 0.7,
        size: 1.3,
        life: 0.6 + Math.random() * 0.5,
        gravity: 9,
        drag: 1.1,
      });
    }
  }

  update(dt: number): void {
    this.smoke.update(dt);
    this.sparks.update(dt);
  }
}
