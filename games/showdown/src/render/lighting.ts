// Time-of-day lighting: a sun/moon key light with a camera-fitted shadow
// frustum, hemisphere + fill lights, an image-based environment, the street
// lanterns (spot lights recycled between the nearest lamps each frame), and a
// small pool of point lights handed out to the brightest transient requests
// (bullets, bombs, loot). Everything is driven by one clock, `time` (hours).
import * as THREE from "three";
import { LAMP } from "../config";
import type { Quality } from "../config";
import { clamp, lerp, smoothstep } from "../utils";
import type { Pipeline } from "./pipeline";

/** Sampled lighting parameters for the current hour. */
export interface LightingState {
  envI: number;
  exp: number;
  fill: THREE.Color;
  fillI: number;
  ground: THREE.Color;
  hemiI: number;
  sat: number;
  sky: THREE.Color;
  sun: THREE.Color;
  sunI: number;
  vig: number;
}

interface RawKeyframe {
  envI: number;
  exp: number;
  fill: number;
  fillI: number;
  ground: number;
  h: number;
  hemiI: number;
  sat: number;
  sky: number;
  sun: number;
  sunI: number;
  vig: number;
}

interface Keyframe extends LightingState {
  h: number;
}

/** A transient light request queued for this frame. */
export interface LightRequest {
  b: number;
  distance: number;
  g: number;
  intensity: number;
  r: number;
  score: number;
  x: number;
  y: number;
  z: number;
}

/** Where a lantern stands (what the world's lantern pass produces). */
export interface LampPosition {
  x: number;
  z: number;
}

/** A lantern with its per-frame distance to the focus and a flicker phase. */
export interface Lamp extends LampPosition {
  d: number;
  phase: number;
}

type ScalarKey = "envI" | "exp" | "fillI" | "hemiI" | "sat" | "sunI" | "vig";

const SCALAR_KEYS: readonly ScalarKey[] = ["sunI", "hemiI", "fillI", "envI", "exp", "sat", "vig"];

// Deep night: no sun, cool blue sky bounce, heavy vignette.
const NIGHT_KEY = {
  envI: 0.09,
  exp: 1.2,
  fill: 0x5f_7f_e0,
  fillI: 0.2,
  ground: 0x17_1d_44,
  hemiI: 0.6,
  sat: 1.08,
  sky: 0x3f_5c_d0,
  sun: 0xff_ff_ff,
  sunI: 0,
  vig: 0.46,
};

// Full daylight: warm white sun, bright sky bounce.
const DAY_KEY = {
  envI: 0.26,
  exp: 0.98,
  fill: 0xdd_e8_ff,
  fillI: 0.42,
  ground: 0xb0_8e_60,
  hemiI: 0.8,
  sat: 1.12,
  sky: 0xbf_dc_ff,
  sun: 0xff_f0_d8,
  sunI: 4.6,
  vig: 0.28,
};

const RAW_KEYS: readonly RawKeyframe[] = [
  { h: 0, ...NIGHT_KEY },
  { h: 4.9, ...NIGHT_KEY },
  {
    envI: 0.18,
    exp: 1.12,
    fill: 0xb0_a0_e0,
    fillI: 0.26,
    ground: 0x6a_4a_4a,
    h: 6.1,
    hemiI: 0.62,
    sat: 1.12,
    sky: 0x9a_8f_d6,
    sun: 0xff_7a_3a,
    sunI: 2.6,
    vig: 0.36,
  },
  {
    envI: 0.22,
    exp: 1,
    fill: 0xcf_e0_ff,
    fillI: 0.36,
    ground: 0x94_78_5c,
    h: 7.6,
    hemiI: 0.72,
    sat: 1.12,
    sky: 0xb4_ce_ff,
    sun: 0xff_b8_77,
    sunI: 4,
    vig: 0.3,
  },
  { h: 10.5, ...DAY_KEY },
  { h: 15, ...DAY_KEY },
  {
    envI: 0.22,
    exp: 1,
    fill: 0xc8_d0_ff,
    fillI: 0.36,
    ground: 0x9c_70_50,
    h: 17.2,
    hemiI: 0.7,
    sat: 1.16,
    sky: 0xa9_b8_ff,
    sun: 0xff_a5_52,
    sunI: 4.7,
    vig: 0.32,
  },
  {
    envI: 0.19,
    exp: 1.06,
    fill: 0xa8_a0_e8,
    fillI: 0.3,
    ground: 0x70_48_48,
    h: 18.4,
    hemiI: 0.66,
    sat: 1.18,
    sky: 0x8d_86_da,
    sun: 0xff_6e_2c,
    sunI: 4.4,
    vig: 0.36,
  },
  {
    envI: 0.17,
    exp: 1.2,
    fill: 0x80_88_e0,
    fillI: 0.28,
    ground: 0x36_30_5a,
    h: 19.2,
    hemiI: 0.72,
    sat: 1.1,
    sky: 0x66_72_c8,
    sun: 0xff_5a_2a,
    sunI: 2.6,
    vig: 0.4,
  },
  { h: 20.3, ...NIGHT_KEY },
  { h: 24, ...NIGHT_KEY },
];

/** Hour-keyed lighting keyframes, colours resolved once at module load. */
export const TIME_KEYS: readonly Keyframe[] = RAW_KEYS.map((raw) => ({
  ...raw,
  fill: new THREE.Color(raw.fill),
  ground: new THREE.Color(raw.ground),
  sky: new THREE.Color(raw.sky),
  sun: new THREE.Color(raw.sun),
}));

const MOON_COLOR = new THREE.Color(0x86_a8_ff);
const MOON_INTENSITY = 1.35;
// Colour-grade tint blended in as night falls: cool shadows, lifted blues.
const NIGHT_TINT = new THREE.Color(0.74, 0.88, 1.26);
const LAMP_COLOR = new THREE.Color(0xff_b5_60);
const LAMP_INTENSITY = 46;
const LAMP_DECAY = 2;
// How far along its direction the key light sits from the shadow centre.
const KEY_DISTANCE = 60;
// Lantern spot lights that may cast shadows (the first N slots).
const LAMP_SHADOW_SLOTS = 4;
const LAMP_SLOT_COUNT = 8;
const REQUEST_CAPACITY = 96;
// Rays past this length never meet the ground in view; clamp them so a
// horizon-grazing corner cannot blow the shadow frustum up.
const CORNER_REACH = 90;
// Screen corners (NDC) plus the top/bottom edge midpoints, whose average is
// the shadow centre.
const SCREEN_CORNERS: readonly (readonly [number, number])[] = [
  [-1, -1],
  [1, -1],
  [1, 1],
  [-1, 1],
  [0, -1],
  [0, 1],
];

const SCRATCH_OFFSET = new THREE.Vector3();
const SCRATCH_MATRIX = new THREE.Matrix4();
const SCRATCH_RIGHT = new THREE.Vector3();
const SCRATCH_UP = new THREE.Vector3();
const ORIGIN = new THREE.Vector3();
const WORLD_UP = new THREE.Vector3(0, 1, 0);
const RAYCASTER = new THREE.Raycaster();
const NDC = new THREE.Vector2();
const GROUND_PLANE = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
const HIT = new THREE.Vector3();
const CENTER = new THREE.Vector3();

const CONE_VERTEX = `
        varying vec3 vN; varying vec3 vView; varying float vH;
        void main() {
          vH = uv.y;
          vec4 mv = modelViewMatrix * vec4( position, 1.0 );
          vN = normalize( normalMatrix * normal );
          vView = normalize( - mv.xyz );
          gl_Position = projectionMatrix * mv;
        }`;

const CONE_FRAGMENT = `
        uniform vec3 uColor; uniform float uStrength;
        varying vec3 vN; varying vec3 vView; varying float vH;
        void main() {
          float facing = abs( dot( normalize( vN ), normalize( vView ) ) );
          float edge = smoothstep( 0.0, 0.9, facing );
          // clamp first: pow() of a slightly negative interpolant is NaN, and one NaN
          // pixel is smeared across the whole frame by the bloom blur
          float h = clamp( vH, 0.0, 1.0 );
          float fall = pow( h, 2.4 ) * 0.9 + 0.035 * h;
          gl_FragColor = vec4( uColor * uStrength * edge * fall, 1.0 );
        }`;

const SKY_VERTEX = `varying vec3 vDir; void main() { vDir = normalize( position ); gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 ); }`;

const SKY_FRAGMENT = `
          varying vec3 vDir;
          void main() {
            float y = normalize( vDir ).y;
            vec3 zenith = vec3( 0.34, 0.55, 1.0 ) * 1.15;
            vec3 horizon = vec3( 1.0, 0.93, 0.82 ) * 1.25;
            vec3 floorC = vec3( 0.62, 0.47, 0.30 ) * 0.55;
            vec3 c = y > 0.0 ? mix( horizon, zenith, pow( y, 0.55 ) ) : mix( horizon * 0.7, floorC, pow( - y, 0.4 ) );
            gl_FragColor = vec4( c, 1.0 );
          }`;

/** Index into a list whose bounds the caller has already established. */
const at = <T>(list: readonly T[], index: number): T => {
  const item = list[index];
  if (item === undefined) {
    throw new RangeError(`index ${index} out of range`);
  }
  return item;
};

/** Which keyframe segment an hour falls in (the last segment absorbs 24h). */
const segmentFor = (hour: number): number => {
  let index = 0;
  while (index < TIME_KEYS.length - 2 && hour >= at(TIME_KEYS, index + 1).h) {
    index += 1;
  }
  return index;
};

/** Interpolate the keyframe table at `hour` into `out`. */
const sampleKeyframes = (hour: number, out: LightingState): LightingState => {
  const index = segmentFor(hour);
  const from = at(TIME_KEYS, index);
  const to = at(TIME_KEYS, index + 1);
  const t = clamp((hour - from.h) / (to.h - from.h), 0, 1);
  out.sun.lerpColors(from.sun, to.sun, t);
  out.sky.lerpColors(from.sky, to.sky, t);
  out.ground.lerpColors(from.ground, to.ground, t);
  out.fill.lerpColors(from.fill, to.fill, t);
  for (const key of SCALAR_KEYS) {
    out[key] = lerp(from[key], to[key], t);
  }
  return out;
};

const makeRequest = (): LightRequest => ({
  b: 1,
  distance: 4,
  g: 1,
  intensity: 0,
  r: 1,
  score: 0,
  x: 0,
  y: 0,
  z: 0,
});

/**
 * Where the four screen corners and the top/bottom edge midpoints land on
 * the ground plane, so the shadow frustum can be fitted to what is visible.
 */
const projectScreenCorners = (camera: THREE.Camera): THREE.Vector3[] => {
  const corners: THREE.Vector3[] = [];
  for (const [x, y] of SCREEN_CORNERS) {
    NDC.set(x, y);
    RAYCASTER.setFromCamera(NDC, camera);
    const hit = RAYCASTER.ray.intersectPlane(GROUND_PLANE, HIT);
    if (hit && RAYCASTER.ray.origin.distanceTo(hit) < CORNER_REACH) {
      corners.push(hit.clone());
    } else {
      corners.push(
        RAYCASTER.ray.origin.clone().addScaledVector(RAYCASTER.ray.direction, CORNER_REACH).setY(0),
      );
    }
  }
  return corners;
};

export class Lighting {
  readonly scene: THREE.Scene;
  readonly pipeline: Pipeline;
  /** Hour of day, 0–24. */
  time = 15.4;
  /** 0 by day, 1 at night; drives lamps, tint and emissives. */
  night = 0;
  /** 1 by day, 0.36 at night; how much ambient light the scene gets. */
  ambientLevel = 1;
  readonly state: LightingState = {
    envI: 0.5,
    exp: 1,
    fill: new THREE.Color(),
    fillI: 0,
    ground: new THREE.Color(),
    hemiI: 1,
    sat: 1,
    sky: new THREE.Color(),
    sun: new THREE.Color(),
    sunI: 0,
    vig: 0.3,
  };
  /** Direction the key light shines from (towards the light). */
  readonly keyDir = new THREE.Vector3(0, 1, 0);
  /** Half-extent of the sun shadow frustum, in metres. */
  shadowRadius = 20;
  tier = 1;
  mapSize = 4096;
  pcss = false;
  readonly key: THREE.DirectionalLight;
  readonly fill: THREE.DirectionalLight;
  readonly hemi: THREE.HemisphereLight;
  readonly envTarget: THREE.WebGLRenderTarget;
  readonly pool: THREE.PointLight[] = [];
  readonly requests: LightRequest[] = [];
  requestCount = 0;
  readonly focus = new THREE.Vector3();
  lamps: Lamp[] = [];
  readonly lampSlots: THREE.SpotLight[] = [];
  readonly lampShadowSlots = LAMP_SHADOW_SLOTS;
  lampGlass: THREE.MeshStandardMaterial | null = null;
  readonly cones: THREE.Mesh[] = [];
  readonly coneMaterial: THREE.ShaderMaterial;
  private readonly coneStrength: THREE.IUniform<number> = { value: 0 };
  private readonly background: THREE.Color;

  constructor(scene: THREE.Scene, pipeline: Pipeline) {
    this.scene = scene;
    this.pipeline = pipeline;

    const key = new THREE.DirectionalLight(0xff_ff_ff, 3);
    key.name = "key";
    key.castShadow = true;
    key.shadow.mapSize.set(this.mapSize, this.mapSize);
    key.shadow.camera.near = 1;
    key.shadow.camera.far = 121;
    key.shadow.bias = -0.00035;
    key.shadow.normalBias = 0.028;
    scene.add(key, key.target);
    this.key = key;

    const fill = new THREE.DirectionalLight(0xdd_e8_ff, 0.4);
    fill.position.set(2.5, 9, 10);
    scene.add(fill);
    this.fill = fill;

    const hemi = new THREE.HemisphereLight(0xcf_e4_ff, 0xa8_8e_68, 1.2);
    scene.add(hemi);
    this.hemi = hemi;

    this.background = new THREE.Color(0x0b_0e_1a);
    this.envTarget = this.buildEnvironment();

    for (let i = 0; i < REQUEST_CAPACITY; i += 1) {
      this.requests.push(makeRequest());
    }

    this.coneMaterial = new THREE.ShaderMaterial({
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      fragmentShader: CONE_FRAGMENT,
      side: THREE.DoubleSide,
      transparent: true,
      uniforms: { uColor: { value: LAMP_COLOR.clone() }, uStrength: this.coneStrength },
      vertexShader: CONE_VERTEX,
    });
    this.buildLampSlots(LAMP_SLOT_COUNT);
    this.setTime(this.time);
  }

  /** Bake a gradient sky into a PMREM so PBR surfaces get sky reflections. */
  private buildEnvironment(): THREE.WebGLRenderTarget {
    const skyScene = new THREE.Scene();
    const dome = new THREE.Mesh(
      new THREE.SphereGeometry(10, 32, 16),
      new THREE.ShaderMaterial({
        fragmentShader: SKY_FRAGMENT,
        side: THREE.BackSide,
        vertexShader: SKY_VERTEX,
      }),
    );
    skyScene.add(dome);
    const pmrem = new THREE.PMREMGenerator(this.pipeline.renderer);
    const target = pmrem.fromScene(skyScene, 0.03);
    this.scene.environment = target.texture;
    pmrem.dispose();
    dome.geometry.dispose();
    dome.material.dispose();
    this.scene.background = this.background;
    return target;
  }

  applyQuality(quality: Quality): void {
    this.tier = quality.tier;
    this.pcss = this.pipeline.usingPCSS;
    if (this.mapSize !== quality.shadowMap) {
      this.mapSize = quality.shadowMap;
      this.key.shadow.mapSize.set(quality.shadowMap, quality.shadowMap);
      if (this.key.shadow.map) {
        this.key.shadow.map.dispose();
        this.key.shadow.map = null;
      }
    }
    this.setPoolSize(quality.poolLights);
    for (const [index, slot] of this.lampSlots.entries()) {
      const wantsShadow = quality.lampShadows && index < this.lampShadowSlots;
      if (slot.castShadow !== wantsShadow) {
        slot.castShadow = wantsShadow;
      }
      if (slot.shadow.mapSize.x !== quality.lampMap) {
        slot.shadow.mapSize.set(quality.lampMap, quality.lampMap);
        if (slot.shadow.map) {
          slot.shadow.map.dispose();
          slot.shadow.map = null;
        }
      }
    }
    this.updateShadowParams();
  }

  /**
   * Shadow softness. Under PCSS `radius` encodes the tier plus the light
   * size relative to the frustum (sun) or, negated, the lamp's angular size
   * (spots); under plain PCF it is just a blur width.
   */
  updateShadowParams(): void {
    const lampSize = LAMP.size / (4 * Math.tan(LAMP.angle));
    if (this.pcss) {
      this.key.shadow.radius = this.tier + clamp(10 / (this.shadowRadius * 2), 0.001, 0.999);
      const lampTier = Math.max(0, this.tier - 1);
      for (const slot of this.lampSlots) {
        slot.shadow.radius = -(lampTier + lampSize);
      }
    } else {
      this.key.shadow.radius = 2.5;
      for (const slot of this.lampSlots) {
        slot.shadow.radius = 2;
      }
    }
  }

  setPoolSize(size: number): void {
    while (this.pool.length < size) {
      const light = new THREE.PointLight(0xff_ff_ff, 0, 5, 2);
      light.position.set(0, -50, 0);
      this.scene.add(light);
      this.pool.push(light);
    }
    while (this.pool.length > size) {
      const light = this.pool.pop();
      if (light) {
        this.scene.remove(light);
        light.dispose();
      }
    }
  }

  buildLampSlots(count: number): void {
    for (let i = 0; i < count; i += 1) {
      const slot = new THREE.SpotLight(LAMP_COLOR, 0, LAMP.far, LAMP.angle, 0.55, LAMP_DECAY);
      slot.position.set(0, LAMP.height, 0);
      slot.castShadow = i < this.lampShadowSlots;
      slot.shadow.mapSize.set(1024, 1024);
      slot.shadow.camera.near = LAMP.near;
      slot.shadow.camera.far = LAMP.far;
      slot.shadow.bias = -0.0009;
      slot.shadow.normalBias = 0.03;
      slot.shadow.autoUpdate = false;
      this.scene.add(slot, slot.target);
      this.lampSlots.push(slot);
    }
  }

  /** Register the world's lanterns: one glow cone each, shared glass material. */
  setLamps(lanterns: readonly LampPosition[], glass: THREE.MeshStandardMaterial | null): void {
    for (const cone of this.cones) {
      this.scene.remove(cone);
    }
    this.cones.length = 0;
    this.lamps = lanterns.map((lantern) => ({
      d: 0,
      phase: Math.random() * 10,
      x: lantern.x,
      z: lantern.z,
    }));
    this.lampGlass = glass;
    const height = LAMP.height - 0.12;
    const geometry = new THREE.ConeGeometry(
      Math.tan(LAMP.angle * 0.8) * height,
      height,
      40,
      1,
      true,
    );
    geometry.translate(0, height / 2, 0);
    for (const lamp of this.lamps) {
      const cone = new THREE.Mesh(geometry, this.coneMaterial);
      cone.position.set(lamp.x, 0, lamp.z);
      cone.userData.noAO = true;
      cone.renderOrder = 5;
      this.scene.add(cone);
      this.cones.push(cone);
    }
  }

  setTime(hour: number): void {
    this.time = ((hour % 24) + 24) % 24;
    this.applyTime();
  }

  sample(hour: number): LightingState {
    return sampleKeyframes(hour, this.state);
  }

  /** Push the sampled keyframe into the lights, environment and exposure. */
  applyTime(): void {
    const hour = this.time;
    const state = this.sample(hour);
    // Sun arc: rises at 6, sets at 19.
    const arc = ((hour - 6) / 13) * Math.PI;
    const elevation = Math.sin(arc);
    const sunUp = hour > 6 && hour < 19 ? smoothstep(0, 0.2, elevation) : 0;
    const moonUp = Math.max(smoothstep(19.15, 20.2, hour), 1 - smoothstep(4.7, 5.7, hour));
    if (sunUp > 0.0005) {
      this.keyDir
        .set(Math.cos(arc), Math.max(elevation * 0.85, 0.17), -(0.22 + 0.3 * elevation))
        .normalize();
      this.key.color.copy(state.sun);
      this.key.intensity = state.sunI * sunUp;
    } else {
      // The moon drifts slowly across the night sky.
      const drift = (hour > 12 ? hour - 20 : hour + 4) * 0.06;
      this.keyDir.set(0.55 - drift, 0.78, -0.5).normalize();
      this.key.color.copy(MOON_COLOR);
      this.key.intensity = MOON_INTENSITY * moonUp;
    }
    this.hemi.color.copy(state.sky);
    this.hemi.groundColor.copy(state.ground);
    this.hemi.intensity = state.hemiI;
    this.fill.color.copy(state.fill);
    this.fill.intensity = state.fillI;
    this.scene.environmentIntensity = state.envI;
    this.background.copy(state.sky).multiplyScalar(0.18);
    this.pipeline.renderer.toneMappingExposure = state.exp;
    this.night = Math.max(smoothstep(18.5, 19.55, hour), 1 - smoothstep(5.4, 6.3, hour));
    this.ambientLevel = lerp(1, 0.36, this.night);
  }

  /** Queue a transient point light; the brightest nearby ones get a real light. */
  addLight(
    x: number,
    y: number,
    z: number,
    color: THREE.Color,
    intensity: number,
    distance = 5,
  ): void {
    if (this.requestCount >= this.requests.length || intensity <= 0.01) {
      return;
    }
    const request = at(this.requests, this.requestCount);
    this.requestCount += 1;
    request.x = x;
    request.y = y;
    request.z = z;
    request.r = color.r;
    request.g = color.g;
    request.b = color.b;
    request.intensity = intensity;
    request.distance = distance;
  }

  /** Hand the pool's point lights to the highest-scoring requests. */
  assignPool(): void {
    const count = this.requestCount;
    const { focus, requests } = this;
    for (let i = 0; i < count; i += 1) {
      const request = at(requests, i);
      const dx = request.x - focus.x;
      const dz = request.z - (focus.z - 2);
      request.score = request.intensity / (1 + (dx * dx + dz * dz) * 0.03);
    }
    // Partial selection sort: only the first `used` slots need ordering.
    const used = Math.min(this.pool.length, count);
    for (let i = 0; i < used; i += 1) {
      let best = i;
      for (let j = i + 1; j < count; j += 1) {
        if (at(requests, j).score > at(requests, best).score) {
          best = j;
        }
      }
      if (best !== i) {
        const swapped = at(requests, i);
        requests[i] = at(requests, best);
        requests[best] = swapped;
      }
    }
    for (const [index, light] of this.pool.entries()) {
      if (index < used) {
        const request = at(requests, index);
        light.position.set(request.x, request.y, request.z);
        light.color.setRGB(request.r, request.g, request.b);
        light.intensity = request.intensity;
        light.distance = request.distance;
      } else {
        light.intensity = 0;
      }
    }
    this.requestCount = 0;
  }

  /** Recycle the spot-light slots onto the lanterns nearest the focus. */
  updateLamps(elapsed: number): void {
    const { night } = this;
    const lit = night > 0.002;
    for (const slot of this.lampSlots) {
      if (slot.castShadow && slot.shadow.map === null) {
        slot.shadow.needsUpdate = true;
      }
    }
    if (this.lampGlass) {
      this.lampGlass.emissiveIntensity = 0.15 + night * 4.2;
    }
    this.coneStrength.value = night * 0.6;
    for (const cone of this.cones) {
      cone.visible = lit;
    }
    if (!lit || this.lamps.length === 0) {
      for (const slot of this.lampSlots) {
        slot.intensity = 0;
        slot.shadow.autoUpdate = false;
      }
      return;
    }
    const { focus } = this;
    for (const lamp of this.lamps) {
      lamp.d = Math.hypot(lamp.x - focus.x, lamp.z - (focus.z - 2));
    }
    this.lamps = this.lamps.toSorted((a, b) => a.d - b.d);
    for (const [index, slot] of this.lampSlots.entries()) {
      const lamp = this.lamps[index];
      if (!lamp) {
        slot.intensity = 0;
        slot.shadow.autoUpdate = false;
        continue;
      }
      const reach = 1 - smoothstep(19, 25, lamp.d);
      const flicker =
        1 +
        Math.sin(elapsed * 7 + lamp.phase) * 0.006 +
        Math.sin(elapsed * 17 + lamp.phase * 3) * 0.004;
      slot.position.set(lamp.x, LAMP.height - 0.52, lamp.z);
      slot.target.position.set(lamp.x, 0, lamp.z);
      slot.target.updateMatrixWorld();
      slot.intensity = LAMP_INTENSITY * night * reach * flicker;
      if (slot.castShadow) {
        slot.shadow.intensity = 1 - smoothstep(10.5, 14.5, lamp.d);
        slot.shadow.autoUpdate = slot.intensity > 0.01 && slot.shadow.intensity > 0.005;
      }
    }
  }

  /**
   * Fit the sun shadow frustum to the visible ground and snap its centre to
   * shadow-map texels so the shadows don't shimmer as the camera pans.
   */
  fitShadow(camera: THREE.Camera): void {
    const corners = projectScreenCorners(camera);
    CENTER.copy(at(corners, 4)).add(at(corners, 5)).multiplyScalar(0.5);
    let reach = 0;
    for (let i = 0; i < 4; i += 1) {
      reach = Math.max(reach, CENTER.distanceTo(at(corners, i)));
    }
    const wanted = clamp(Math.ceil(reach + 3.5), 12, 46);
    // Grow immediately, shrink only with hysteresis, so the frustum stays put.
    if (wanted > this.shadowRadius || wanted < this.shadowRadius - 3) {
      this.shadowRadius = wanted;
      this.updateShadowParams();
    }
    const radius = this.shadowRadius;
    const shadowCamera = this.key.shadow.camera;
    if (shadowCamera.right !== radius) {
      shadowCamera.left = -radius;
      shadowCamera.right = radius;
      shadowCamera.top = radius;
      shadowCamera.bottom = -radius;
      shadowCamera.updateProjectionMatrix();
    }
    SCRATCH_MATRIX.lookAt(
      SCRATCH_OFFSET.copy(this.keyDir).multiplyScalar(KEY_DISTANCE),
      ORIGIN,
      WORLD_UP,
    );
    SCRATCH_RIGHT.setFromMatrixColumn(SCRATCH_MATRIX, 0);
    SCRATCH_UP.setFromMatrixColumn(SCRATCH_MATRIX, 1);
    // Snap in light space, in steps of 64 texels.
    const step = ((2 * radius) / this.mapSize) * 64;
    const alongRight = CENTER.dot(SCRATCH_RIGHT);
    const alongUp = CENTER.dot(SCRATCH_UP);
    CENTER.addScaledVector(SCRATCH_RIGHT, Math.round(alongRight / step) * step - alongRight);
    CENTER.addScaledVector(SCRATCH_UP, Math.round(alongUp / step) * step - alongUp);
    this.key.target.position.copy(CENTER);
    this.key.position.copy(CENTER).addScaledVector(this.keyDir, KEY_DISTANCE);
    this.key.target.updateMatrixWorld();
    this.key.updateMatrixWorld();
    this.fill.target.position.copy(CENTER);
    this.fill.position.set(CENTER.x + 2.5, 9, CENTER.z + 10);
    this.fill.target.updateMatrixWorld();
    if (!this.fill.target.parent) {
      this.scene.add(this.fill.target);
    }
  }

  /** Force the next `fitShadow` to refit from scratch (e.g. after a camera cut). */
  resetShadowFit(): void {
    this.shadowRadius = 0;
  }

  update(
    dt: number,
    elapsed: number,
    camera: THREE.Camera,
    focus: THREE.Vector3,
    paused = false,
  ): void {
    this.focus.copy(focus);
    this.fitShadow(camera);
    this.updateLamps(elapsed);
    if (!paused) {
      this.assignPool();
    }
    const { grade } = this.pipeline;
    if (grade) {
      const saturation = grade.uniforms.uSaturation;
      if (saturation) {
        saturation.value = this.state.sat;
      }
      const vignette = grade.uniforms.uVignette;
      if (vignette) {
        vignette.value = this.state.vig;
      }
      const tint = grade.uniforms.uTint;
      if (tint && tint.value instanceof THREE.Color) {
        tint.value.setRGB(1, 1, 1).lerp(NIGHT_TINT, this.night);
      }
    }
  }
}
