import * as THREE from "three";

import { BoostPlume } from "./boost-plume";
import { FxRings } from "./fx-rings";
import { ParticleField } from "./particle-field";
import type { EmitOpts } from "./particle-field";
import { REINHARD_GLSL } from "./reinhard";
import { GRIND_COLOR } from "./tier";
import { SURFACE_FX } from "./surface-fx";
import type { LooseProfile, MatterRecipe, PavedSurface } from "./surface-fx";
import { WaterFx } from "./water-fx";
import type { WaterSprayKind } from "./water-fx";

const FRAG_SMOKE = `
  uniform vec3 uSunTint;
  uniform vec3 uAmbient;
  varying float vAlpha;
  varying vec3 vColor;
  varying float vGrain;
  void main() {
    vec2 d = gl_PointCoord - vec2(0.5);
    float r = dot(d, d);
    // Shrink with life: the disc radius (squared) follows sqrt(alpha), and a
    // crisp disc tops out at ~70% of the sprite — a hard-edged full-size
    // sprite reads twice as big as the soft one it replaced.
    float lensFade = smoothstep(3.0, 9.0, 1.0 / gl_FragCoord.w);
    float radius = 0.1 * clamp(sqrt(vAlpha) * 1.15, 0.0, 1.0) * lensFade;
    if (r > radius) discard;
    float aa = fwidth(r) * 1.5;
    float disc = 1.0 - smoothstep(radius - aa, radius, r);
    float chip = 1.0 - smoothstep(0.29, 0.35, abs(d.x) + abs(d.y) * 0.7);
    float shape = mix(disc, chip, vGrain);
    // Cartoon smoke is cream, not grey: the surface tint is lifted toward
    // paper white (debris chips keep their own colour).
    vec3 base = mix(vColor, vec3(1.0), 0.35 * (1.0 - vGrain));
    vec3 color = mix(base * 0.35, base, pow(vAlpha, 0.6));
    // Two flat bands: the whole puff takes the scene light once (so night
    // smoke still darkens), then a lit cap above a tilted terminator and a
    // lavender-shaded belly below — a cel shadow, not a grey falloff. The
    // ceiling keeps stacked puffs from blowing out under the post S-curve.
    float cap = smoothstep(-0.03, 0.03, -d.y - d.x * 0.35 + 0.04);
    color *= min(uAmbient + uSunTint, vec3(1.0));
    color *= mix(vec3(0.78, 0.76, 0.9), vec3(1.0), cap);
    // Rim: the outer ring a step darker — the puff's own ink line.
    color *= mix(1.0, 0.8, smoothstep(radius * 0.66, radius * 0.82, r) * (1.0 - vGrain));
    gl_FragColor = vec4(color, shape);
  }
`;

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

export type FxTier = 0 | 1 | 2;

export const TIER_FX = [
  { core: 0.22, coreInt: 1.25, halo: 0.35, haloInt: 0.8, jet: 0, pulse: 0, rate: 34 },
  { core: 0.28, coreInt: 1.35, halo: 0.45, haloInt: 0.8, jet: 0, pulse: 0, rate: 56 },
  { core: 0.34, coreInt: 1.45, halo: 0.55, haloInt: 0.8, jet: 30, pulse: 6.5, rate: 84 },
] as const;

const NIGHT_FX_SCALE = 0.55;

export class Fx {
  private readonly smokeSun = { value: new THREE.Color(0.78, 0.72, 0.6) };
  private readonly smokeAmbient = { value: new THREE.Color(0.55, 0.6, 0.65) };
  private readonly fxGain = { value: 1 };
  private readonly tierCol = { value: new THREE.Color(GRIND_COLOR) };
  readonly smoke = new ParticleField(420, THREE.NormalBlending, true, FRAG_SMOKE, {
    uAmbient: this.smokeAmbient,
    uSunTint: this.smokeSun,
    uTierCol: { value: new THREE.Color(1, 1, 1) },
  });
  readonly sparks = new ParticleField(500, THREE.AdditiveBlending, false, FRAG_SPARKS, {
    uFxGain: this.fxGain,
    uTierCol: this.tierCol,
  });
  readonly plume = new BoostPlume(this.fxGain);
  readonly rings = new FxRings(this.fxGain);
  readonly water = new WaterFx((x, y, z, strength, velX, velZ, kind) => {
    this.waterSpray(x, y, z, strength, velX, velZ, kind);
  });
  private readonly tmp = new THREE.Color();
  private readonly white = new THREE.Color(1, 1, 1);
  private readonly tmpDir = { x: 0, y: 0, z: 0 };
  private readonly waterDirection = { x: 0, y: 0, z: 0 };
  private readonly waterSprayOptions: EmitOpts = {
    color: new THREE.Color(0.84, 0.94, 1),
    count: 0,
    dir: this.waterDirection,
    dirSpeed: 1,
    drag: 1.8,
    gravity: 12,
    life: 0,
    size: 0,
    speed: 0,
    spread: 0,
    up: 0,
  };

  addTo(scene: THREE.Scene) {
    const smokeMat = this.smoke.points.material;

    if (!Array.isArray(smokeMat)) {
      smokeMat.depthWrite = true;
    }

    scene.add(this.smoke.points);
    scene.add(this.sparks.points);
    scene.add(this.plume.mesh);
    scene.add(this.rings.mesh);
    scene.add(this.water.mesh);
  }
  setScale(px: number) {
    this.smoke.setScale(px);
    this.sparks.setScale(px);
  }

  private fxDim = 1;

  setFxDim(dim: number) {
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
  ) {
    this.smokeSun.value.copy(sun).multiplyScalar(sunIntensity * 0.26);
    this.smokeAmbient.value.copy(ambient).multiplyScalar(ambientIntensity).addScalar(0.12);
    this.fxDay = Math.min(1, Math.max(0, day));
    this.fxGain.value = (NIGHT_FX_SCALE + (1 - NIGHT_FX_SCALE) * this.fxDay) * this.fxDim;
    this.water.setDay(this.fxDay);
  }

  /** Repaint the live tier channel (drift grains, jet, promotion layers). */
  setTierChannel(css: string) {
    this.tierCol.value.set(css);
  }

  driftPuff(x: number, y: number, z: number, boosting: boolean, surface: PavedSurface = "road") {
    const profile = SURFACE_FX[surface];
    this.tmp.setRGB(profile.color.r, profile.color.g, profile.color.b);
    this.smoke.emit(x, y + 0.3, z, {
      color: this.tmp,
      count: 2,
      drag: 2.4,
      gravity: -1.2,
      life: 0.6,
      size: 1.9,
      speed: 1,
      spread: 1.2,
      up: 1.5,
    });

    if (boosting) {
      this.tmp.setHSL(0.08, 1, 0.6);
      this.sparks.emit(x, y + 0.3, z, {
        color: this.tmp,
        count: 2,
        drag: 3,
        gravity: 0,
        intensity: 1.4,
        life: 0.35,
        size: 0.4,
        speed: 5,
        spread: 1,
        up: 0.5,
      });
    }
  }

  driftShower(
    x: number,
    y: number,
    z: number,
    tier: FxTier,
    count: number,
    dx: number,
    dz: number,
    dirSpeed: number,
  ) {
    const t = TIER_FX[tier];
    this.tmpDir.x = dx;
    this.tmpDir.y = 0;
    this.tmpDir.z = dz;
    this.sparks.emit(x, y, z, {
      channel: true,
      color: this.white,
      count,
      dir: this.tmpDir,
      dirSpeed,
      drag: 1.5,
      gravity: 14,
      intensity: t.coreInt,
      life: 0.4,
      size: t.core,
      speed: 4.6 + 1.3 * tier,
      spread: 1.2,
      up: 2.5 + 0.5 * tier,
    });
    this.sparks.emit(x, y + 0.12, z, {
      channel: true,
      color: this.white,
      count: Math.max(1, Math.trunc(count / 2)),
      dir: this.tmpDir,
      dirSpeed: dirSpeed * 0.7,
      drag: 2.4,
      gravity: 2,
      intensity: t.haloInt,
      life: 0.3,
      size: t.halo,
      speed: 1.5,
      spread: 0.9,
      up: 1.2,
    });

    if (Math.random() < 0.6) {
      this.sparks.emit(x, y + 0.05, z, {
        channel: true,
        color: this.white,
        count: 1,
        dir: this.tmpDir,
        dirSpeed: dirSpeed * 0.9,
        drag: 6,
        gravity: 0,
        intensity: 1.45,
        life: 0.12,
        size: 2.3 + 0.4 * tier,
        speed: 0.2,
        spread: 0.2,
        up: 0.2,
      });
    }
  }

  emberJet(x: number, y: number, z: number, count: number, ix: number, iz: number) {
    this.tmpDir.x = ix;
    this.tmpDir.y = 0;
    this.tmpDir.z = iz;
    this.sparks.emit(x, y, z, {
      channel: true,
      color: this.white,
      count,
      dir: this.tmpDir,
      dirSpeed: 1,
      drag: 0.55,
      gravity: 11,
      intensity: 1.5,
      life: 0.7,
      size: 0.16,
      speed: 0.4,
      spread: 1.5,
      up: 6.2,
    });
  }

  promotionBurst(
    x: number,
    y: number,
    z: number,
    tier: FxTier,
    count: number,
    ix: number,
    iz: number,
  ) {
    this.tmpDir.x = ix;
    this.tmpDir.y = 0;
    this.tmpDir.z = iz;
    this.sparks.emit(x, y, z, {
      channel: true,
      color: this.white,
      count,
      dir: this.tmpDir,
      dirSpeed: 1,
      drag: 1.1,
      gravity: 13,
      intensity: 3,
      life: 0.62,
      size: 0.6 + 0.12 * tier,
      speed: 6.5,
      spread: 1.4,
      up: 3.2,
    });
    this.sparks.emit(x, y + 0.2, z, {
      channel: true,
      color: this.white,
      count: Math.max(1, Math.trunc(count / 2)),
      dir: this.tmpDir,
      dirSpeed: 0.6,
      drag: 2.5,
      gravity: 2,
      intensity: 1.75,
      life: 0.4,
      size: 1.7,
      speed: 3,
      spread: 1.2,
      up: 1.6,
    });
  }

  promotionFlare(x: number, y: number, z: number, tier: FxTier) {
    this.sparks.emit(x, y, z, {
      channel: true,
      color: this.white,
      count: 1,
      drag: 4.5,
      gravity: -0.5,
      intensity: 1.3 + 0.3 * tier,
      life: 0.3,
      size: 2 + 1 * tier,
      speed: 0.3,
      spread: 0.2,
      up: 0.2,
    });
  }

  promotionPool(x: number, y: number, z: number, tier: FxTier, ix: number, iz: number) {
    this.tmpDir.x = ix;
    this.tmpDir.y = 0;
    this.tmpDir.z = iz;
    this.sparks.emit(x, y + 0.15, z, {
      channel: true,
      color: this.white,
      count: 1,
      dir: this.tmpDir,
      dirSpeed: 0.75,
      drag: 5,
      gravity: 0,
      intensity: 0.95 + 0.16 * tier,
      life: 0.34,
      size: 4.2 + 1.2 * tier,
      speed: 0,
      spread: 0.1,
      up: 0.05,
    });
  }

  exhaustFlame(x: number, y: number, z: number, dirX: number, dirZ: number) {
    const len = Math.hypot(dirX, dirZ);
    const inv = len > 0.0001 ? 1 / len : 0;
    this.tmpDir.x = dirX * inv;
    this.tmpDir.y = 0;
    this.tmpDir.z = dirZ * inv;
    this.tmp.setHSL(0.09, 0.6, 0.72);
    this.sparks.emit(x, y, z, {
      color: this.tmp,
      count: 1,
      dir: this.tmpDir,
      dirSpeed: 10,
      drag: 2.5,
      gravity: 0,
      intensity: 2.8,
      life: 0.14,
      size: 0.8,
      speed: 0.4,
      spread: 0.2,
      up: 0.2,
    });
    this.tmp.setHSL(0.06, 1, 0.5);
    this.sparks.emit(x, y, z, {
      color: this.tmp,
      count: 1,
      dir: this.tmpDir,
      dirSpeed: 9,
      drag: 2.5,
      gravity: 0,
      intensity: 2.4,
      life: 0.18,
      size: 1.25,
      speed: 0.6,
      spread: 0.3,
      up: 0.3,
    });
    this.tmp.setHSL(0.02, 1, 0.42);
    this.sparks.emit(x, y, z, {
      color: this.tmp,
      count: 1,
      dir: this.tmpDir,
      dirSpeed: 7.5,
      drag: 2.2,
      gravity: 0,
      intensity: 1.8,
      life: 0.22,
      size: 1.5,
      speed: 0.7,
      spread: 0.4,
      up: 0.35,
    });
  }

  boostFlash(x: number, y: number, z: number, dirX: number, dirZ: number, hue: number) {
    const len = Math.hypot(dirX, dirZ);
    const inv = len > 0.0001 ? 1 / len : 0;
    this.tmpDir.x = dirX * inv;
    this.tmpDir.y = 0.12;
    this.tmpDir.z = dirZ * inv;
    this.tmp.setHSL(hue, 0.55, 0.85);
    this.sparks.emit(x, y, z, {
      color: this.tmp,
      count: 3,
      dir: this.tmpDir,
      dirSpeed: 13,
      drag: 2.2,
      gravity: 0,
      intensity: 3,
      life: 0.16,
      size: 1.5,
      speed: 0.5,
      spread: 0.25,
      up: 0.3,
    });
    this.tmp.setHSL(hue, 1, 0.55);
    this.sparks.emit(x, y, z, {
      color: this.tmp,
      count: 4,
      dir: this.tmpDir,
      dirSpeed: 11,
      drag: 2,
      gravity: 0,
      intensity: 2.6,
      life: 0.24,
      size: 1.9,
      speed: 0.9,
      spread: 0.5,
      up: 0.4,
    });
    this.tmp.setHSL(hue, 1, 0.62);
    this.sparks.emit(x, y, z, {
      color: this.tmp,
      count: 6,
      dir: this.tmpDir,
      dirSpeed: 5,
      drag: 1.4,
      gravity: 6,
      intensity: 2.4,
      life: 0.35,
      size: 0.7,
      speed: 4.5,
      spread: 1.2,
      up: 1.4,
    });
  }

  kickup(
    x: number,
    y: number,
    z: number,
    profile: LooseProfile,
    direction: { x: number; y: number; z: number },
    power: number,
  ) {
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
  ) {
    const options = this.waterSprayOptions;
    const entry = kind === "entry";
    const wake = kind === "wake";
    const surfaceCount = wake ? 1 : 4;
    const surfaceUp = wake ? 0.9 : 1.4;
    options.count = entry ? 5 + Math.round(strength * 15) : surfaceCount;
    options.speed = entry ? 0.8 + strength * 2 : 0.3;
    options.spread = entry ? 0.8 : 0.4;
    options.up = entry ? 1.7 + strength * 4 : surfaceUp;
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
  ) {
    const { color } = recipe;
    this.tmp.setRGB(color.r, color.g, color.b);
    const lift = grain ? 0.16 : 0.2 + recipe.size * 0.8;
    this.smoke.emit(x, y + lift, z, {
      color: this.tmp,
      count: recipe.count,
      dir: direction,
      dirSpeed: power * (grain ? 1 : 0.55),
      drag: recipe.drag,
      grain,
      gravity: recipe.gravity,
      life: recipe.life,
      size: recipe.size,
      speed: 0,
      spread: recipe.spread,
      up: recipe.up,
    });
  }

  dustRing(x: number, y: number, z: number, count: number) {
    this.tmp.setHSL(0.09, 0.14, 0.66);

    for (let i = 0; i < count; i += 1) {
      const ang = (i / count) * Math.PI * 2;
      this.tmpDir.x = Math.cos(ang);
      this.tmpDir.y = 0;
      this.tmpDir.z = Math.sin(ang);
      this.smoke.emit(x, y, z, {
        color: this.tmp,
        count: 1,
        dir: this.tmpDir,
        dirSpeed: 7,
        drag: 3,
        gravity: -0.6,
        life: 0.5,
        size: 2.2,
        speed: 0,
        spread: 0,
        up: 1,
      });
    }
  }

  scrapeSparks(x: number, y: number, z: number, nx: number, nz: number) {
    const len = Math.hypot(nx, nz);
    const inv = len > 0.0001 ? 1 / len : 0;
    this.tmpDir.x = nx * inv;
    this.tmpDir.y = 0.25;
    this.tmpDir.z = nz * inv;
    this.tmp.setHSL(0.13, 1, 0.6);
    this.sparks.emit(x, y, z, {
      color: this.tmp,
      count: 2 + (Math.random() < 0.5 ? 1 : 0),
      dir: this.tmpDir,
      dirSpeed: 4.5,
      drag: 2,
      gravity: 5,
      intensity: 2.3,
      life: 0.25,
      size: 0.8,
      speed: 2,
      spread: 0.8,
      up: 0.6,
    });
  }

  burst(x: number, y: number, z: number, hue: number, count: number, power: number) {
    for (let i = 0; i < count; i += 1) {
      this.tmp.setHSL((hue + Math.random() * 0.12) % 1, 0.9, 0.6);
      this.sparks.emit(x, y, z, {
        color: this.tmp,
        count: 1,
        drag: 1.1,
        gravity: 9,
        intensity: 2.2,
        life: 0.6 + Math.random() * 0.5,
        size: 1.3,
        speed: power * (0.5 + Math.random()),
        spread: 1,
        up: power * 0.7,
      });
    }
  }

  update(dt: number) {
    this.smoke.update(dt);
    this.sparks.update(dt);
    this.plume.update(dt);
    this.rings.update(dt);
    this.water.update(dt);
  }
}
