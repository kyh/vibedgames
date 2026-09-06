import * as THREE from "three";

import { BoostPlume, FxRings } from "./boost-plume";
import { REINHARD_GLSL } from "./reinhard";
import { GRIND_COLOR } from "./tier";
import { SURFACE_FX, type LooseProfile, type MatterRecipe, type PavedSurface } from "./surface-fx";
import { WaterFx, type WaterSprayKind } from "./water-fx";

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
};

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
  varying float vGrain;
  void main() {
    vec2 d = gl_PointCoord - vec2(0.5);
    float r = dot(d, d);
    if (r > 0.25) discard;
    float soft = smoothstep(0.25, 0.0, r);
    float chip = 1.0 - smoothstep(0.29, 0.35, abs(d.x) + abs(d.y) * 0.7);
    soft = mix(soft, chip, vGrain);
    vec3 color = mix(vColor * 0.35, vColor, pow(vAlpha, 0.6));
    float topLit = smoothstep(0.78, 0.18, gl_PointCoord.y);
    // Ceiling keeps a stack of overlapping lit puffs from blowing out to a
    // single white-yellow mass under the post S-curve.
    color *= min(uAmbient + uSunTint * topLit, vec3(1.0));
    gl_FragColor = vec4(color, vAlpha * vAlpha * soft);
  }
`;
// Sparks: intensities are authored pre-shoulder (hot FX 2.2-3.4) and the
// max-channel Reinhard shoulder is the LAST op — stacked grains asymptote
// toward their own hue instead of washing to white, and a lone core still
// clears the day bloom gate. The hot-core desat only whitens the pinprick
// centre (0.45, never 1.0 — a fully white core reads as fireflies with no
// hue). uFxGain is the day-weighted governor: at night the bloom cut drops to
// 0.85 and un-scaled 2-3x grains would flood the frame.
const FRAG_SPARKS = `
  uniform float uFxGain;
  varying float vAlpha;
  varying vec3 vColor;
  ${REINHARD_GLSL}
  void main() {
    vec2 d = gl_PointCoord - vec2(0.5);
    float r = dot(d, d);
    if (r > 0.25) discard;
    float soft = smoothstep(0.25, 0.0, r);
    vec3 color = mix(vColor * 0.35, vColor, pow(vAlpha, 0.6));
    // Hot core confined to the inner ~35% radius — r is SQUARED distance, so
    // a wider ramp would cover most of the sprite and every spark would
    // render as a fat white splat instead of a pinprick.
    float core = pow(smoothstep(0.03, 0.0, r), 2.0);
    float mx = max(color.r, max(color.g, color.b));
    color = mix(color, vec3(mx), core * 0.45);
    color = reinhardClip(color * uFxGain);
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
  private chan: Float32Array;
  private grain: Float32Array;
  private vel: Float32Array;
  private grav: Float32Array;
  private drag: Float32Array;
  private cursor = 0;
  private wasEmpty = false;
  private mat: THREE.ShaderMaterial;
  private scaleUniform = { value: typeof window === "undefined" ? 1 : window.innerHeight };

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
    this.chan = new Float32Array(n);
    this.grain = new Float32Array(n);
    this.vel = new Float32Array(n * 3);
    this.grav = new Float32Array(n);
    this.drag = new Float32Array(n);

    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(this.pos, 3));
    geo.setAttribute("aColor", new THREE.BufferAttribute(this.col, 3));
    geo.setAttribute("aSize", new THREE.BufferAttribute(this.size, 1));
    geo.setAttribute("aLife", new THREE.BufferAttribute(this.life, 1));
    geo.setAttribute("aMax", new THREE.BufferAttribute(this.max, 1));
    geo.setAttribute("aChannel", new THREE.BufferAttribute(this.chan, 1));
    geo.setAttribute("aGrain", new THREE.BufferAttribute(this.grain, 1));
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
    const intensity = o.intensity ?? 1;
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
    geo.getAttribute("aChannel").needsUpdate = true;
    geo.getAttribute("aGrain").needsUpdate = true;
  }
}

export type FxTier = 0 | 1 | 2;

// Drift-tier FX ladder — tiers are three DIFFERENT effects sharing a palette,
// not one effect re-hued: rate and core size escalate, the top tier adds the
// vertical ember jet (shape change) and the 6.5 Hz ground-ring pulse (rhythm
// change — nothing else in the game beats). Hue itself comes from fx/tier.ts
// via the live channel. rate = grains/s/wheel; sizes in point-sprite units.
// Intensities sit just over the 1.6 day gate: each grain glows, but only the
// dense center of the shower fuses. 2.25+ made EVERY grain a bloom kernel and
// the whole spray read as one fireball at chase distance (measured, golden
// hour) — the shower must stay grains, not a glow sprite.
// Steady-state grains stay UNDER the 1.6 day bloom gate — a drift holds a
// tight arc, so 0.4-0.7s of emissions pile into a few square metres and any
// per-grain bloom fuses the pile into one fireball (measured, golden hour,
// donut test). Only one-frame moments (promotion, ignition) may cross the
// gate; the held shower reads as sparks, not glow.
export const TIER_FX = [
  { rate: 34, core: 0.22, coreInt: 1.25, halo: 0.35, haloInt: 0.8, jet: 0, pulse: 0 },
  { rate: 56, core: 0.28, coreInt: 1.35, halo: 0.45, haloInt: 0.8, jet: 0, pulse: 0 },
  { rate: 84, core: 0.34, coreInt: 1.45, halo: 0.55, haloInt: 0.8, jet: 30, pulse: 6.5 },
] as const;

// Day-weighted additive governor floor: authored 2.2-3.4 radiances are tuned
// against the ~1.6 DAY bloom gate; the night gate sits at 0.85 with a coupled
// emissive budget (window 1.1 / lamp 0.9 / headlight 1.6), so FX scale toward
// this floor after dark instead of out-shining every lamp pool.
const NIGHT_FX_SCALE = 0.55;

// High-level effects used by the game.
export class Fx {
  // Defaults approximate noon so the first frames before setLighting look sane.
  private smokeSun = { value: new THREE.Color(0.78, 0.72, 0.6) };
  private smokeAmbient = { value: new THREE.Color(0.55, 0.6, 0.65) };
  // Shared additive governor (sparks, rings, plume): mix(NIGHT_FX_SCALE, 1, day).
  private fxGain = { value: 1 };
  // Live tier channel — rewritten per frame; a promotion recolors every
  // channel grain already in flight, that frame, for three floats.
  private tierCol = { value: new THREE.Color(GRIND_COLOR) };
  readonly smoke = new ParticleField(420, THREE.NormalBlending, true, FRAG_SMOKE, {
    uSunTint: this.smokeSun,
    uAmbient: this.smokeAmbient,
    uTierCol: { value: new THREE.Color(1, 1, 1) },
  }); // grows over life
  readonly sparks = new ParticleField(500, THREE.AdditiveBlending, false, FRAG_SPARKS, {
    uFxGain: this.fxGain,
    uTierCol: this.tierCol,
  }); // shrinks over life
  readonly plume = new BoostPlume(this.fxGain);
  readonly rings = new FxRings(this.fxGain);
  readonly water = new WaterFx((x, y, z, strength, velX, velZ, kind) =>
    this.waterSpray(x, y, z, strength, velX, velZ, kind),
  );
  private tmp = new THREE.Color();
  private white = new THREE.Color(1, 1, 1);
  private tmpDir = { x: 0, y: 0, z: 0 };
  private waterDirection = { x: 0, y: 0, z: 0 };
  private waterSprayOptions: EmitOpts = {
    count: 0,
    color: new THREE.Color(0.84, 0.94, 1),
    speed: 0,
    spread: 0,
    up: 0,
    size: 0,
    life: 0,
    gravity: 12,
    drag: 1.8,
    dir: this.waterDirection,
    dirSpeed: 1,
  };

  addTo(scene: THREE.Scene): void {
    scene.add(this.smoke.points);
    scene.add(this.sparks.points);
    scene.add(this.plume.mesh);
    scene.add(this.rings.mesh);
    scene.add(this.water.mesh);
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
  /** Extra multiplier on the additive governor. Trailer cameras park metres
   *  from the spark shower — screen coverage the gameplay chase never sees —
   *  and at that range the stack fuses into a blob no per-grain tuning can
   *  fix. Scenes dim the whole pool instead; gameplay leaves it at 1. */
  private fxDim = 1;

  setFxDim(dim: number): void {
    this.fxDim = Math.min(1, Math.max(0, dim));
    this.fxGain.value = (NIGHT_FX_SCALE + (1 - NIGHT_FX_SCALE) * this.fxDay) * this.fxDim;
  }

  private fxDay = 1;

  setLighting(
    sun: THREE.Color,
    sunIntensity: number,
    ambient: THREE.Color,
    ambientIntensity: number,
    day: number,
  ): void {
    this.smokeSun.value.copy(sun).multiplyScalar(sunIntensity * 0.26);
    this.smokeAmbient.value.copy(ambient).multiplyScalar(ambientIntensity).addScalar(0.12);
    this.fxDay = Math.min(1, Math.max(0, day));
    this.fxGain.value = (NIGHT_FX_SCALE + (1 - NIGHT_FX_SCALE) * this.fxDay) * this.fxDim;
    this.water.setDay(this.fxDay);
  }

  /** Repaint the live tier channel (drift grains, jet, promotion layers). */
  setTierChannel(css: string): void {
    this.tierCol.value.set(css);
  }

  // Paved tires smoke under stress. Loose ground uses kickup exclusively, so
  // drifting through sand cannot stack a second rubber-smoke cloud on it.
  driftPuff(
    x: number,
    y: number,
    z: number,
    boosting: boolean,
    surface: PavedSurface = "road",
  ): void {
    const profile = SURFACE_FX[surface];
    this.tmp.setRGB(profile.color.r, profile.color.g, profile.color.b);
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
    // Boost-only ember kiss in the smoke. The drift-charge spark read belongs
    // to the tier shower (driftShower) — a second charged emission here at
    // smoke cadence stacked ~300 sprites/s on the same spot and fused into a
    // fireball no shower tuning could fix (isolated by hiding the pool).
    if (boosting) {
      this.tmp.setHSL(0.08, 1, 0.6);
      this.sparks.emit(x, y + 0.3, z, {
        count: 2,
        color: this.tmp,
        intensity: 1.4,
        speed: 5,
        spread: 1,
        up: 0.5,
        size: 0.4,
        life: 0.35,
        gravity: 0,
        drag: 3,
      });
    }
  }

  // Drift spark shower — the steady per-wheel spray. Three layers per call:
  // hot cores (thrown along `dir`, the inherited-velocity + backward-throw
  // vector precomputed by the rig), a colored halo cloud carrying the
  // silhouette at chase distance, and an intermittent contact-patch lamp so
  // every frame of a slide has SOME light at the tyre.
  driftShower(
    x: number,
    y: number,
    z: number,
    tier: FxTier,
    count: number,
    dx: number,
    dz: number,
    dirSpeed: number,
  ): void {
    const t = TIER_FX[tier];
    this.tmpDir.x = dx;
    this.tmpDir.y = 0;
    this.tmpDir.z = dz;
    this.sparks.emit(x, y, z, {
      count,
      color: this.white,
      channel: true,
      intensity: t.coreInt,
      speed: 4.6 + 1.3 * tier,
      spread: 1.2,
      up: 2.5 + 0.5 * tier,
      size: t.core,
      life: 0.4,
      gravity: 14,
      drag: 1.5,
      dir: this.tmpDir,
      dirSpeed,
    });
    this.sparks.emit(x, y + 0.12, z, {
      count: Math.max(1, count >> 1),
      color: this.white,
      channel: true,
      intensity: t.haloInt,
      speed: 1.5,
      spread: 0.9,
      up: 1.2,
      size: t.halo,
      life: 0.3,
      gravity: 2,
      drag: 2.4,
      dir: this.tmpDir,
      dirSpeed: dirSpeed * 0.7,
    });
    if (Math.random() < 0.6) {
      this.sparks.emit(x, y + 0.05, z, {
        count: 1,
        color: this.white,
        channel: true,
        intensity: 1.45,
        speed: 0.2,
        spread: 0.2,
        up: 0.2,
        size: 2.3 + 0.4 * tier,
        life: 0.12,
        gravity: 0,
        drag: 6,
        dir: this.tmpDir,
        dirSpeed: dirSpeed * 0.9,
      });
    }
  }

  // Top-tier vertical ember jet: long life + low drag makes it a standing
  // column — a STATE the eye can hold onto, not a stream of events.
  emberJet(x: number, y: number, z: number, count: number, ix: number, iz: number): void {
    this.tmpDir.x = ix;
    this.tmpDir.y = 0;
    this.tmpDir.z = iz;
    this.sparks.emit(x, y, z, {
      count,
      color: this.white,
      channel: true,
      intensity: 1.5,
      speed: 0.4,
      spread: 1.5,
      up: 6.2,
      size: 0.16,
      life: 0.7,
      gravity: 11,
      drag: 0.55,
      dir: this.tmpDir,
      dirSpeed: 1,
    });
  }

  // Tier-promotion burst at one wheel: fast stretch-read cores + a colored
  // glow shell. All on the live channel so the burst and the recolored shower
  // land as one event.
  promotionBurst(
    x: number,
    y: number,
    z: number,
    tier: FxTier,
    count: number,
    ix: number,
    iz: number,
  ): void {
    this.tmpDir.x = ix;
    this.tmpDir.y = 0;
    this.tmpDir.z = iz;
    this.sparks.emit(x, y, z, {
      count,
      color: this.white,
      channel: true,
      intensity: 3.0,
      speed: 6.5,
      spread: 1.4,
      up: 3.2,
      size: 0.6 + 0.12 * tier,
      life: 0.62,
      gravity: 13,
      drag: 1.1,
      dir: this.tmpDir,
      dirSpeed: 1,
    });
    this.sparks.emit(x, y + 0.2, z, {
      count: Math.max(1, count >> 1),
      color: this.white,
      channel: true,
      intensity: 1.75,
      speed: 3,
      spread: 1.2,
      up: 1.6,
      size: 1.7,
      life: 0.4,
      gravity: 2,
      drag: 2.5,
      dir: this.tmpDir,
      dirSpeed: 0.6,
    });
  }

  // Air flare: one soft glow at rear-deck height — puts the promotion in the
  // AIR where the chase camera actually looks.
  promotionFlare(x: number, y: number, z: number, tier: FxTier): void {
    this.sparks.emit(x, y, z, {
      count: 1,
      color: this.white,
      channel: true,
      intensity: 1.3 + 0.3 * tier,
      speed: 0.3,
      spread: 0.2,
      up: 0.2,
      size: 2.0 + 1.0 * tier,
      life: 0.3,
      gravity: -0.5,
      drag: 4.5,
    });
  }

  // Ground flash pool under the car on promotion — pops at birth (the alpha
  // curve peaks on frame 1) so every promotion channel crests the same frame.
  promotionPool(x: number, y: number, z: number, tier: FxTier, ix: number, iz: number): void {
    this.tmpDir.x = ix;
    this.tmpDir.y = 0;
    this.tmpDir.z = iz;
    this.sparks.emit(x, y + 0.15, z, {
      count: 1,
      color: this.white,
      channel: true,
      intensity: 0.95 + 0.16 * tier,
      speed: 0,
      spread: 0.1,
      up: 0.05,
      size: 4.2 + 1.2 * tier,
      life: 0.34,
      gravity: 0,
      drag: 5,
      dir: this.tmpDir,
      dirSpeed: 0.75,
    });
  }

  // Boost exhaust support cone: hot flame tongues shot backwards along
  // (dirX, dirZ) UNDER the ribbon plume — the particulate the rigid mesh
  // can't do (root kisses, cooling wisps). Call per frame while boosting.
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
      intensity: 2.8,
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
      intensity: 2.4,
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
      intensity: 1.8,
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
  // from each exhaust plus a spray of hot flecks — the particulate half of
  // the ignition stack (the ground rings + plume spike fire alongside it).
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
      intensity: 3.0,
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
      intensity: 2.6,
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
      intensity: 2.4,
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

  // Coherent low dust + short ballistic flecks. Both are normal-blend matter;
  // they never borrow the additive drift channel or grow a glowing wake.
  kickup(
    x: number,
    y: number,
    z: number,
    profile: LooseProfile,
    direction: { x: number; y: number; z: number },
    power: number,
  ): void {
    this.emitMatter(x, y, z, profile.dust, direction, power, false);
    this.emitMatter(x, y, z, profile.debris, direction, power, true);
  }

  private waterSpray(
    x: number,
    y: number,
    z: number,
    strength: number,
    velX: number,
    velZ: number,
    kind: WaterSprayKind,
  ): void {
    const options = this.waterSprayOptions;
    const entry = kind === "entry";
    const wake = kind === "wake";
    options.count = entry ? 5 + Math.round(strength * 15) : wake ? 1 : 4;
    options.speed = entry ? 0.8 + strength * 2 : 0.3;
    options.spread = entry ? 0.8 : 0.4;
    options.up = entry ? 1.7 + strength * 4 : wake ? 0.9 : 1.4;
    options.size = entry ? 0.16 + strength * 0.1 : 0.13;
    options.life = entry ? 0.35 + strength * 0.28 : 0.3;
    this.waterDirection.x = velX * 0.2;
    this.waterDirection.z = velZ * 0.2;
    this.smoke.emit(x, y, z, options);
  }

  private emitMatter(
    x: number,
    y: number,
    z: number,
    recipe: MatterRecipe,
    direction: { x: number; y: number; z: number },
    power: number,
    grain: boolean,
  ): void {
    const color = recipe.color;
    this.tmp.setRGB(color.r, color.g, color.b);
    // Camera-facing dust needs room above the contact plane: a low centre
    // clips its soft circle into a hard horizontal stripe. Chips stay low.
    const lift = grain ? 0.16 : 0.2 + recipe.size * 0.8;
    this.smoke.emit(x, y + lift, z, {
      count: recipe.count,
      color: this.tmp,
      speed: 0,
      spread: recipe.spread,
      up: recipe.up,
      size: recipe.size,
      life: recipe.life,
      gravity: recipe.gravity,
      drag: recipe.drag,
      dir: direction,
      dirSpeed: power * (grain ? 1 : 0.55),
      grain,
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
      intensity: 2.3,
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
        intensity: 2.2,
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
    this.plume.update(dt);
    this.rings.update(dt);
    this.water.update(dt);
  }
}
