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
  // 0..1 scale on the day bloom gain (sparks pool only). Hot FX — drift
  // sparks, boost flame, crash bursts — glow at 1; inert debris like sand and
  // grass flecks opts out at 0, or every off-road run reads as a fire.
  bloomGain?: number;
};

// vAlpha = remaining life fraction (1 at birth -> 0 at death).
// uGrow selects the size ramp: 0 = shrink over life (sparks: 1.4 -> 0.6),
// 1 = grow over life (smoke: 0.7 -> 1.5).
const VERT = `
  attribute float aLife;
  attribute float aMax;
  attribute float aSize;
  attribute vec3 aColor;
  attribute float aGain;
  uniform float uScale;
  uniform float uGrow;
  varying float vAlpha;
  varying vec3 vColor;
  varying float vGain;
  void main() {
    vColor = aColor;
    vGain = aGain;
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
// Smoke is LIT: the top of each puff catches uSunTint, the underside sits in
// uAmbient shade — the vertical gradient across the point sprite is what makes
// a flat point read as a volume, and it's what lets golden-hour smoke go
// orange instead of staying flat grey.
const FRAG_SMOKE = `
  uniform vec3 uSunTint;
  uniform vec3 uAmbient;
  varying float vAlpha;
  varying vec3 vColor;
  void main() {
    vec2 d = gl_PointCoord - vec2(0.5);
    float r = dot(d, d);
    if (r > 0.25) discard;
    float soft = smoothstep(0.25, 0.0, r);
    vec3 color = mix(vColor * 0.35, vColor, pow(vAlpha, 0.6));
    float topLit = smoothstep(0.78, 0.18, gl_PointCoord.y);
    // Ceiling keeps a stack of overlapping lit puffs from blowing out to a
    // single white-yellow mass under the post S-curve.
    color *= min(uAmbient + uSunTint * topLit, vec3(1.0));
    gl_FragColor = vec4(color, vAlpha * vAlpha * soft);
  }
`;
// Sparks: uGain boosts the CENTER of the sprite only (skirt stays at 1x, so a
// gained spark reads white-hot core + colored halo, not a blob). By day the
// bloom threshold sits at 6.5 pre-tonemap while spark colors peak ~1 — the
// gain is what lets a day drift spark cross the cut and glow like the night
// lamp halos do.
const FRAG_SPARKS = `
  uniform float uGain;
  varying float vAlpha;
  varying vec3 vColor;
  varying float vGain;
  void main() {
    vec2 d = gl_PointCoord - vec2(0.5);
    float r = dot(d, d);
    if (r > 0.25) discard;
    float soft = smoothstep(0.25, 0.0, r);
    vec3 color = mix(vColor * 0.35, vColor, pow(vAlpha, 0.6));
    // Hot core confined to the inner ~35% radius — r is SQUARED distance, so
    // the earlier 1-4r ramp still covered most of the sprite and every gained
    // spark rendered as a fat additive splat instead of a pinprick.
    float core = pow(smoothstep(0.03, 0.0, r), 2.0);
    color *= 1.0 + (uGain - 1.0) * core * vGain;
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
  private gain: Float32Array;
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
    frag: string,
    extraUniforms: Record<string, THREE.IUniform>,
  ) {
    this.pos = new Float32Array(n * 3);
    this.col = new Float32Array(n * 3);
    this.size = new Float32Array(n);
    this.life = new Float32Array(n);
    this.max = new Float32Array(n);
    this.gain = new Float32Array(n);
    this.vel = new Float32Array(n * 3);
    this.grav = new Float32Array(n);
    this.drag = new Float32Array(n);

    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(this.pos, 3));
    geo.setAttribute("aColor", new THREE.BufferAttribute(this.col, 3));
    geo.setAttribute("aSize", new THREE.BufferAttribute(this.size, 1));
    geo.setAttribute("aLife", new THREE.BufferAttribute(this.life, 1));
    geo.setAttribute("aMax", new THREE.BufferAttribute(this.max, 1));
    geo.setAttribute("aGain", new THREE.BufferAttribute(this.gain, 1));
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);

    this.mat = new THREE.ShaderMaterial({
      uniforms: { uScale: this.scaleUniform, uGrow: { value: grow ? 1 : 0 }, ...extraUniforms },
      vertexShader: VERT,
      fragmentShader: frag,
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
      this.gain[i] = o.bloomGain ?? 1;
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
    geo.getAttribute("aGain").needsUpdate = true;
  }
}

export type FxSurface = "road" | "grass" | "sand" | "concrete";

// High-level effects used by the game.
export class Fx {
  // Defaults approximate noon so the first frames before setLighting look sane.
  private smokeSun = { value: new THREE.Color(0.78, 0.72, 0.6) };
  private smokeAmbient = { value: new THREE.Color(0.55, 0.6, 0.65) };
  private sparkGain = { value: 1 };
  readonly smoke = new ParticleField(420, THREE.NormalBlending, true, FRAG_SMOKE, {
    uSunTint: this.smokeSun,
    uAmbient: this.smokeAmbient,
  }); // grows over life
  readonly sparks = new ParticleField(500, THREE.AdditiveBlending, false, FRAG_SPARKS, {
    uGain: this.sparkGain,
  }); // shrinks over life
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

  // Per-frame lighting feed from the day-night rig. `day` = 1 - lamp factor.
  // Sun scale 0.26: a golden key (1.9 int) lands the puff's lit top around
  // parity with its albedo and the shaded base at ~0.5x — volume without the
  // stack of puffs clipping toward white (the post S-curve + vibrance sit on
  // top of whatever leaves here; 0.45 read as a fireball).
  // Ambient floor 0.12 keeps night smoke readable against the dark ground.
  // Spark gain tops out at x3.5 — deliberately UNDER the 6.5 day bloom cut.
  // Cores at ~3.4 ACES-clip to a white-hot center on their own; pushing them
  // past the cut instead (an earlier x7) fed every 20Hz spark trail into the
  // bloom pyramid and a plain grind drift read as a chain of fireballs. Only
  // spots where several sparks overlap now cross the cut, which is a glint,
  // not a flood. At night the cut is 0.85 and gain MUST return to 1.
  setLighting(
    sun: THREE.Color,
    sunIntensity: number,
    ambient: THREE.Color,
    ambientIntensity: number,
    day: number,
  ): void {
    this.smokeSun.value.copy(sun).multiplyScalar(sunIntensity * 0.26);
    this.smokeAmbient.value.copy(ambient).multiplyScalar(ambientIntensity).addScalar(0.12);
    this.sparkGain.value = 1 + 2.5 * Math.min(1, Math.max(0, day));
  }

  // Tire smoke while drifting. `charged` is the Mario-Kart mini-turbo tell:
  // sparks turn cyan and the count jumps 2 -> 5. Smoke is tinted by the
  // surface being torn up (same colors as kickup, so the two systems agree):
  // road keeps grey rubber-smoke, off-road throws that surface's dust.
  driftPuff(
    x: number,
    y: number,
    z: number,
    boosting: boolean,
    charged = false,
    surface: FxSurface = "road",
  ): void {
    if (surface === "grass") this.tmp.setRGB(0.42, 0.36, 0.24);
    else if (surface === "sand") this.tmp.setRGB(0.66, 0.57, 0.41);
    else if (surface === "concrete") this.tmp.setRGB(0.8, 0.8, 0.78);
    else this.tmp.setHSL(0, 0, boosting ? 0.85 : 0.72);
    this.smoke.emit(x, y + 0.3, z, {
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
      this.sparks.emit(x, y + 0.3, z, {
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
      size: 1.25,
      life: 0.18,
      gravity: 0,
      drag: 2.5,
      dir: this.tmpDir,
      dirSpeed: 9,
    });
    // Deep-orange wisp trailing the tongue — gives the cone its taper.
    this.tmp.setHSL(0.02, 1, 0.42);
    this.sparks.emit(x, y, z, {
      count: 1,
      color: this.tmp,
      speed: 0.7,
      spread: 0.4,
      up: 0.35,
      size: 1.5,
      life: 0.22,
      gravity: 0,
      drag: 2.2,
      dir: this.tmpDir,
      dirSpeed: 7.5,
    });
  }

  // Boost ignition pop (the Mario Kart read): a fat one-shot flame tongue
  // from each exhaust plus a spray of hot flecks. Replaces the old expanding
  // ground shockwave — boosts read from the pipes, not the pavement.
  boostFlash(x: number, y: number, z: number, dirX: number, dirZ: number, hue: number): void {
    const len = Math.hypot(dirX, dirZ);
    const inv = len > 0.0001 ? 1 / len : 0;
    this.tmpDir.x = dirX * inv;
    this.tmpDir.y = 0.12;
    this.tmpDir.z = dirZ * inv;
    this.tmp.setHSL(hue, 0.55, 0.85); // near-white core
    this.sparks.emit(x, y, z, {
      count: 3,
      color: this.tmp,
      speed: 0.5,
      spread: 0.25,
      up: 0.3,
      size: 1.5,
      life: 0.16,
      gravity: 0,
      drag: 2.2,
      dir: this.tmpDir,
      dirSpeed: 13,
    });
    this.tmp.setHSL(hue, 1, 0.55); // colored tongue
    this.sparks.emit(x, y, z, {
      count: 4,
      color: this.tmp,
      speed: 0.9,
      spread: 0.5,
      up: 0.4,
      size: 1.9,
      life: 0.24,
      gravity: 0,
      drag: 2.0,
      dir: this.tmpDir,
      dirSpeed: 11,
    });
    this.tmp.setHSL(hue, 1, 0.62); // scatter flecks
    this.sparks.emit(x, y, z, {
      count: 6,
      color: this.tmp,
      speed: 4.5,
      spread: 1.2,
      up: 1.4,
      size: 0.7,
      life: 0.35,
      gravity: 6,
      drag: 1.4,
      dir: this.tmpDir,
      dirSpeed: 5,
    });
  }

  // Off-road kick-up (the Mario Kart read): soft OPAQUE dust puffs in the
  // surface's own color carry the effect; a few bright flecks (torn grass /
  // sand grains) ride on top. The old version was all additive embers — off-
  // road looked like the car was on fire, not tearing up ground.
  kickup(x: number, y: number, z: number, surface: "grass" | "sand", power: number): void {
    if (surface === "grass")
      this.tmp.setRGB(0.42, 0.36, 0.24); // dry-dirt brown
    // Beach tan, kept well under the old 0.82: the lit-smoke shader and the
    // post S-curve sit on top now, and a bright tan stack read as fire.
    else this.tmp.setRGB(0.66, 0.57, 0.41);
    this.smoke.emit(x, y + 0.25, z, {
      count: 2,
      color: this.tmp,
      speed: power * 0.55,
      spread: 0.9,
      up: 1.6 + power * 0.3,
      size: 1.6 + power * 0.25,
      life: 0.55,
      gravity: -0.8,
      drag: 2.6,
    });
    if (surface === "grass") this.tmp.setHSL(0.29, 0.8, 0.42);
    else this.tmp.setHSL(0.11, 0.7, 0.68);
    this.sparks.emit(x, y + 0.3, z, {
      count: 2,
      color: this.tmp,
      speed: power * (0.6 + Math.random() * 0.5),
      spread: 1,
      up: power * 0.8,
      size: 0.8,
      life: 0.5,
      gravity: 9,
      drag: 1.2,
      bloomGain: 0,
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
