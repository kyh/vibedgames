import * as THREE from "three";

import { STREET_SURFACE_MAX } from "../world/roads";

const HALO_SIZE = 1.7;
const POOL_SIZE = 17;
const POOL_LIFT = STREET_SURFACE_MAX + 0.06;
const HALO_ALPHA = 0.5;
const POOL_ALPHA = 0.62;
const HALO_GAIN = 3.4;
const POOL_GAIN = 2.1;
const FADE_NEAR = 380;
const FADE_FAR = 650;

export interface LampHead {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly ground: number;
}

const gradientTexture = (stops: readonly (readonly [number, number])[]) => {
  const size = 128;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");

  if (ctx) {
    const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);

    for (const [at, a] of stops) {
      g.addColorStop(at, `rgba(255,255,255,${a})`);
    }

    ctx.fillStyle = g;
    ctx.fillRect(0, 0, size, size);
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.NoColorSpace;

  return tex;
};

export const radialGlowTexture = () =>
  gradientTexture([
    [0, 1],
    [0.08, 0.9],
    [0.22, 0.3],
    [0.5, 0.06],
    [1, 0],
  ]);

export const poolGlowTexture = () =>
  gradientTexture([
    [0, 1],
    [0.12, 0.86],
    [0.32, 0.34],
    [0.62, 0.09],
    [1, 0],
  ]);

const HALO_VERT = `
  attribute vec3 aCenter;
  uniform float uSize;
  varying vec2 vUv;
  varying float vFade;
  void main() {
    vUv = uv;
    float d = distance(cameraPosition, aCenter);
    vFade = 1.0 - smoothstep(${FADE_NEAR.toFixed(1)}, ${FADE_FAR.toFixed(1)}, d);
    vec4 view = viewMatrix * vec4(aCenter, 1.0);
    view.xy += position.xy * uSize;
    gl_Position = projectionMatrix * view;
  }
`;

const POOL_VERT = `
  attribute vec3 aCenter;
  uniform float uSize;
  varying vec2 vUv;
  varying float vFade;
  void main() {
    vUv = uv;
    float d = distance(cameraPosition, aCenter);
    vFade = 1.0 - smoothstep(${FADE_NEAR.toFixed(1)}, ${FADE_FAR.toFixed(1)}, d);
    vec3 world = aCenter + vec3(position.x * uSize, 0.0, -position.y * uSize);
    gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
  }
`;

const FRAG = `
  uniform sampler2D uMap;
  uniform vec3 uColor;
  uniform float uIntensity;
  uniform float uAlpha;
  varying vec2 vUv;
  varying float vFade;
  void main() {
    float a = texture2D(uMap, vUv).a * uAlpha * uIntensity * vFade;
    if (a < 0.003) discard;
    gl_FragColor = vec4(uColor, a);
  }
`;

interface Layer {
  mesh: THREE.Mesh;
  geo: THREE.InstancedBufferGeometry;
}

interface LayerSpec {
  readonly vert: string;
  readonly tex: THREE.CanvasTexture;
  readonly color: number;
  readonly gain: number;
  readonly size: number;
  readonly alpha: number;
  readonly ground: boolean;
}

const buildLayer = (
  attr: THREE.InstancedBufferAttribute,
  count: number,
  spec: LayerSpec,
  intensity: { value: number },
) => {
  const quad = new THREE.PlaneGeometry(1, 1);
  const geo = new THREE.InstancedBufferGeometry();
  geo.index = quad.index;
  geo.setAttribute("position", quad.getAttribute("position"));
  geo.setAttribute("uv", quad.getAttribute("uv"));
  geo.setAttribute("aCenter", attr);
  geo.instanceCount = count;

  const mat = new THREE.ShaderMaterial({
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    fragmentShader: FRAG,
    polygonOffset: spec.ground,
    polygonOffsetFactor: -4,
    polygonOffsetUnits: -8,
    transparent: true,
    uniforms: {
      uAlpha: { value: spec.alpha },
      uColor: { value: new THREE.Color(spec.color).multiplyScalar(spec.gain) },
      uIntensity: intensity,
      uMap: { value: spec.tex },
      uSize: { value: spec.size },
    },
    vertexShader: spec.vert,
  });

  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = 6;

  return { geo, mesh };
};

export interface LampGlowBudget {
  readonly cap: number;
  readonly poolScale: number;
}

const NEAR_REFRESH_S = 0.5;

interface CappedState {
  readonly heads: readonly LampHead[];
  readonly haloArr: Float32Array;
  readonly poolArr: Float32Array;
  readonly haloAttr: THREE.InstancedBufferAttribute;
  readonly poolAttr: THREE.InstancedBufferAttribute;
  readonly halo: Layer;
  readonly pool: Layer;
  readonly cap: number;
  timer: number;
}

export class LampGlow {
  readonly group = new THREE.Group();
  private readonly intensity = { value: 0 };
  private readonly capped: CappedState | null = null;

  constructor(heads: readonly LampHead[], budget: LampGlowBudget | null = null) {
    if (heads.length === 0) {
      return;
    }

    const tex = radialGlowTexture();
    const cap = budget && heads.length > budget.cap ? budget.cap : 0;
    const n = cap > 0 ? cap : heads.length;
    const haloCenters = new Float32Array(n * 3);
    const poolCenters = new Float32Array(n * 3);

    for (let i = 0; i < n; i += 1) {
      const h = heads[i];

      if (!h) {
        continue;
      }

      haloCenters.set([h.x, h.y, h.z], i * 3);
      poolCenters.set([h.x, h.ground + POOL_LIFT, h.z], i * 3);
    }

    const haloAttr = new THREE.InstancedBufferAttribute(haloCenters, 3);
    const poolAttr = new THREE.InstancedBufferAttribute(poolCenters, 3);

    if (cap > 0) {
      haloAttr.setUsage(THREE.DynamicDrawUsage);
      poolAttr.setUsage(THREE.DynamicDrawUsage);
    }

    const poolSize = POOL_SIZE * (budget ? budget.poolScale : 1);

    const halo = buildLayer(
      haloAttr,
      n,
      {
        alpha: HALO_ALPHA,
        color: 0xff_cf_8a,
        gain: HALO_GAIN,
        ground: false,
        size: HALO_SIZE,
        tex,
        vert: HALO_VERT,
      },
      this.intensity,
    );

    const pool = buildLayer(
      poolAttr,
      n,
      {
        alpha: POOL_ALPHA,
        color: 0xff_b8_65,
        gain: POOL_GAIN,
        ground: true,
        size: poolSize,
        tex: poolGlowTexture(),
        vert: POOL_VERT,
      },
      this.intensity,
    );

    this.group.add(halo.mesh);
    this.group.add(pool.mesh);
    this.group.visible = false;

    if (cap > 0) {
      this.capped = {
        cap,
        halo,
        haloArr: haloCenters,
        haloAttr,
        heads,
        pool,
        poolArr: poolCenters,
        poolAttr,
        timer: 0,
      };
    }
  }

  setIntensity(f: number) {
    this.intensity.value = f;
    this.group.visible = f > 0.01;
  }

  updateNear(camX: number, camZ: number, dt: number) {
    const c = this.capped;

    if (!c || !this.group.visible) {
      return;
    }

    c.timer -= dt;

    if (c.timer > 0) {
      return;
    }

    c.timer = NEAR_REFRESH_S;
    const picks: { d2: number; i: number }[] = [];
    const farSq = FADE_FAR * FADE_FAR;

    for (let i = 0; i < c.heads.length; i += 1) {
      const h = c.heads[i];

      if (!h) {
        continue;
      }

      const dx = h.x - camX;
      const dz = h.z - camZ;
      const d2 = dx * dx + dz * dz;

      if (d2 < farSq) {
        picks.push({ d2, i });
      }
    }

    picks.sort((a, b) => a.d2 - b.d2);
    const n = Math.min(c.cap, picks.length);

    for (let k = 0; k < n; k += 1) {
      const p = picks[k];
      const h = p ? c.heads[p.i] : undefined;

      if (!h) {
        continue;
      }

      c.haloArr.set([h.x, h.y, h.z], k * 3);
      c.poolArr.set([h.x, h.ground + POOL_LIFT, h.z], k * 3);
    }

    c.halo.geo.instanceCount = n;
    c.pool.geo.instanceCount = n;
    c.haloAttr.clearUpdateRanges();
    c.haloAttr.addUpdateRange(0, n * 3);
    c.haloAttr.needsUpdate = true;
    c.poolAttr.clearUpdateRanges();
    c.poolAttr.addUpdateRange(0, n * 3);
    c.poolAttr.needsUpdate = true;
  }
}
