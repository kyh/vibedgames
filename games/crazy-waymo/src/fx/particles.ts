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
  // Optional directional term: final velocity = radial term + dir * dirSpeed.
  dir?: { x: number; y: number; z: number };
  dirSpeed?: number;
};

// vAlpha = remaining life fraction (1 at birth -> 0 at death).
// uGrow selects the size ramp: 0 = shrink over life (sparks: 1.4 -> 0.6),
// 1 = grow over life (smoke: 0.7 -> 1.5).
const VERT = `
  attribute float aLife;
  attribute float aMax;
  attribute float aSize;
  attribute vec3 aColor;
  uniform float uScale;
  uniform float uGrow;
  varying float vAlpha;
  varying vec3 vColor;
  void main() {
    vColor = aColor;
    vAlpha = clamp(aLife / max(aMax, 0.0001), 0.0, 1.0);
    float shrinkRamp = mix(0.6, 1.4, vAlpha);
    float growRamp = mix(1.5, 0.7, vAlpha);
    float ramp = mix(shrinkRamp, growRamp, uGrow);
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mv;
    gl_PointSize = (aLife <= 0.0) ? 0.0 : aSize * ramp * uScale / max(-mv.z, 0.1);
  }
`;
// Color cools toward death (hot core early, dark residue late); alpha is
// fast-in-slow-out (vAlpha^2 spends most of the life dim, popping at birth).
const FRAG = `
  varying float vAlpha;
  varying vec3 vColor;
  void main() {
    vec2 d = gl_PointCoord - vec2(0.5);
    float r = dot(d, d);
    if (r > 0.25) discard;
    float soft = smoothstep(0.25, 0.0, r);
    vec3 color = mix(vColor * 0.35, vColor, pow(vAlpha, 0.6));
    gl_FragColor = vec4(color, vAlpha * vAlpha * soft);
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
  private wasEmpty = false;
  private mat: THREE.ShaderMaterial;
  private scaleUniform = { value: window.innerHeight };

  constructor(
    private n: number,
    blending: THREE.Blending,
    grow: boolean,
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
      uniforms: { uScale: this.scaleUniform, uGrow: { value: grow ? 1 : 0 } },
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
    const dir = o.dir;
    const ds = o.dirSpeed ?? 0;
    const dx = dir ? dir.x * ds : 0;
    const dy = dir ? dir.y * ds : 0;
    const dz = dir ? dir.z * ds : 0;
    for (let k = 0; k < o.count; k++) {
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
    let alive = 0;
    for (let i = 0; i < this.n; i++) {
      const life = this.life[i] ?? 0;
      if (life <= 0) continue;
      alive++;
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
    // One idle frame still uploads (to clear the last dying particle), then rest.
    if (alive === 0 && this.wasEmpty) return;
    this.wasEmpty = alive === 0;
    const geo = this.points.geometry;
    geo.getAttribute("position").needsUpdate = true;
    geo.getAttribute("aColor").needsUpdate = true;
    geo.getAttribute("aSize").needsUpdate = true;
    geo.getAttribute("aLife").needsUpdate = true;
    geo.getAttribute("aMax").needsUpdate = true;
  }
}

// High-level effects used by the game.
export class Fx {
  readonly smoke = new ParticleField(420, THREE.NormalBlending, true); // grows over life
  readonly sparks = new ParticleField(500, THREE.AdditiveBlending, false); // shrinks over life
  private tmp = new THREE.Color();
  private tmpDir = { x: 0, y: 0, z: 0 };

  addTo(scene: THREE.Scene): void {
    scene.add(this.smoke.points);
    scene.add(this.sparks.points);
  }
  setScale(px: number): void {
    this.smoke.setScale(px);
    this.sparks.setScale(px);
  }

  // Tire smoke while drifting. `charged` is the Mario-Kart mini-turbo tell:
  // sparks turn cyan and the count jumps 2 -> 5.
  driftPuff(x: number, z: number, boosting: boolean, charged = false): void {
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
    if (boosting || charged) {
      this.tmp.setHSL(charged ? 0.55 : 0.08, 1, 0.6);
      this.sparks.emit(x, 0.3, z, {
        count: charged ? 5 : 2,
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

  // Boost exhaust: hot flame tongues shot backwards along (dirX, dirZ).
  // Call per frame while boosting; one white-hot core + orange tails.
  exhaustFlame(x: number, y: number, z: number, dirX: number, dirZ: number): void {
    const len = Math.hypot(dirX, dirZ);
    const inv = len > 0.0001 ? 1 / len : 0;
    this.tmpDir.x = dirX * inv;
    this.tmpDir.y = 0;
    this.tmpDir.z = dirZ * inv;
    // White-hot core — small and fast, or additive stacking blows out.
    this.tmp.setHSL(0.09, 0.6, 0.72);
    this.sparks.emit(x, y, z, {
      count: 1,
      color: this.tmp,
      speed: 0.4,
      spread: 0.2,
      up: 0.2,
      size: 0.8,
      life: 0.14,
      gravity: 0,
      drag: 2.5,
      dir: this.tmpDir,
      dirSpeed: 10,
    });
    // Orange tongue.
    this.tmp.setHSL(0.06, 1, 0.5);
    this.sparks.emit(x, y, z, {
      count: 1,
      color: this.tmp,
      speed: 0.6,
      spread: 0.3,
      up: 0.3,
      size: 1.0,
      life: 0.18,
      gravity: 0,
      drag: 2.5,
      dir: this.tmpDir,
      dirSpeed: 9,
    });
  }

  // Landing dust: a ring of warm-gray puffs pushed outward at evenly spaced
  // fixed angles (coherent shape beats a noisy swarm).
  dustRing(x: number, y: number, z: number, count: number): void {
    this.tmp.setHSL(0.09, 0.14, 0.66);
    for (let i = 0; i < count; i++) {
      const ang = (i / count) * Math.PI * 2;
      this.tmpDir.x = Math.cos(ang);
      this.tmpDir.y = 0;
      this.tmpDir.z = Math.sin(ang);
      this.smoke.emit(x, y, z, {
        count: 1,
        color: this.tmp,
        speed: 0,
        spread: 0,
        up: 1,
        size: 2.2,
        life: 0.5,
        gravity: -0.6,
        drag: 3,
        dir: this.tmpDir,
        dirSpeed: 7,
      });
    }
  }

  // Wall-grind sparks biased along the wall normal (nx, nz). Small and short:
  // a continuous scrape tell, not an impact.
  scrapeSparks(x: number, y: number, z: number, nx: number, nz: number): void {
    const len = Math.hypot(nx, nz);
    const inv = len > 0.0001 ? 1 / len : 0;
    this.tmpDir.x = nx * inv;
    this.tmpDir.y = 0.25;
    this.tmpDir.z = nz * inv;
    this.tmp.setHSL(0.13, 1, 0.6);
    this.sparks.emit(x, y, z, {
      count: 2 + (Math.random() < 0.5 ? 1 : 0),
      color: this.tmp,
      speed: 2,
      spread: 0.8,
      up: 0.6,
      size: 0.8,
      life: 0.25,
      gravity: 5,
      drag: 2,
      dir: this.tmpDir,
      dirSpeed: 4.5,
    });
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
