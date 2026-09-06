import * as THREE from "three";

import { STREET_SURFACE_MAX } from "../world/roads";

// Streetlights that actually GLOW at night: two instanced draws over every
// lamp head the furniture pass placed —
//   1. a view-space billboard halo at the lamp head, and
//   2. a flat warm pool of light on the pavement under it.
// Both fade with one uIntensity uniform (the day-night lamp factor), fade out
// with camera distance (far lamps otherwise read as noise floating over the
// fog), and depth-test so buildings occlude them.

// The two layers were the wrong way round. Measured downtown at midnight, the
// pavement pools were invisible on asphalt (POOL_ALPHA 0.2 over a 8u quad reads
// as nothing) while the head halos rendered as fat opaque yellow spheres larger
// than the pier sheds they stood on. "Warm pools against cool shadow" is the
// whole night brief, and the pool is the half that carries it: the pool got
// bigger and much stronger, the halo smaller and softer.
const HALO_SIZE = 1.7; // world units, quad edge
const POOL_SIZE = 17;
// The pool spans asphalt AND the curb/sidewalk the lamp stands on, so it has
// to clear the tallest draped street layer (roads.ts STREET_SURFACE_MAX) the
// same way fares.ts GROUND_RING_LIFT and skids.ts SKID_LIFT do. Sitting below
// it, the quads are depth-rejected by the kerb and each pool reads as a
// crescent that stops dead at a straight line along the sidewalk.
//
// The lift alone was not enough, and it never could be: the pool is a FLAT quad
// 8.5u in radius drawn on a city with 42% streets. On any real SF grade the
// uphill half of every pool sat inside the road and was depth-rejected — the
// measured symptom was a 6x alpha boost changing nothing in a SoMa frame with
// 18 lamps inside 150u, while lifting the same quads 1.5u lit them all. The
// depth-space bias is the fix that scales with the slope; the world lift only
// has to cover the curb now, so it can stay small enough to keep the pool
// visually welded to the pavement at chase-camera height.
const POOL_LIFT = STREET_SURFACE_MAX + 0.06;
const HALO_ALPHA = 0.5;
const POOL_ALPHA = 0.62;
// Emissive gain on the lamp colour. Pre-tonemap linear, additive layers write
// colour*alpha, so a plain 0..1 colour can never break the bloom threshold no
// matter how opaque it is — a lamp pool topped out around 0.44 against a night
// cut of 0.62 (render/post.ts) and every source in the city rendered as a flat
// decal with no bleed. HDR colour is what makes a lamp a LIGHT.
const HALO_GAIN = 3.4;
const POOL_GAIN = 2.1;
const FADE_NEAR = 380; // camera distance where lamps start to fade
const FADE_FAR = 650;

export type LampHead = {
  readonly x: number;
  readonly y: number; // world height of the lamp head
  readonly z: number;
  // Height of the pavement AS RENDERED under the lamp (the terraced drive
  // surface, not the raw height field) — the pool is drawn flat at this Y, so
  // a raw-field value detaches it by the terrace delta on every steep street.
  readonly ground: number;
};

/** Soft radial gradient blob, generated at boot — no asset fetch. */
function gradientTexture(stops: readonly (readonly [number, number])[]): THREE.CanvasTexture {
  const size = 128;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (ctx) {
    const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    for (const [at, a] of stops) g.addColorStop(at, `rgba(255,255,255,${a})`);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, size, size);
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.NoColorSpace;
  return tex;
}

// A compact emitter with a faint skirt. A half-bright disc out to 35% of the
// radius turned every lamp into bokeh even when the camera was in focus.
export function radialGlowTexture(): THREE.CanvasTexture {
  return gradientTexture([
    [0, 1],
    [0.08, 0.9],
    [0.22, 0.3],
    [0.5, 0.06],
    [1, 0],
  ]);
}

// The pavement pool wants the opposite shape: a small hot centre directly under
// the lamp and a long, fast-decaying tail, i.e. roughly inverse-square. The
// halo's broad 0.5-at-35% skirt spread across a 17u quad reads as a uniform
// warm haze on the asphalt — a fog, not a light with a source above it.
export function poolGlowTexture(): THREE.CanvasTexture {
  return gradientTexture([
    [0, 1],
    [0.12, 0.86],
    [0.32, 0.34],
    [0.62, 0.09],
    [1, 0],
  ]);
}

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

type Layer = { mesh: THREE.Mesh; geo: THREE.InstancedBufferGeometry };

type LayerSpec = {
  readonly vert: string;
  readonly tex: THREE.CanvasTexture;
  readonly color: number;
  readonly gain: number;
  readonly size: number;
  readonly alpha: number;
  /** Ground-hugging layers bias their depth to survive the street's slope. */
  readonly ground: boolean;
};

function buildLayer(
  attr: THREE.InstancedBufferAttribute,
  count: number,
  spec: LayerSpec,
  intensity: { value: number },
): Layer {
  const quad = new THREE.PlaneGeometry(1, 1);
  const geo = new THREE.InstancedBufferGeometry();
  geo.index = quad.index;
  geo.setAttribute("position", quad.getAttribute("position"));
  geo.setAttribute("uv", quad.getAttribute("uv"));
  geo.setAttribute("aCenter", attr);
  geo.instanceCount = count;
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uMap: { value: spec.tex },
      uColor: { value: new THREE.Color(spec.color).multiplyScalar(spec.gain) },
      uSize: { value: spec.size },
      uAlpha: { value: spec.alpha },
      uIntensity: intensity,
    },
    vertexShader: spec.vert,
    fragmentShader: FRAG,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    polygonOffset: spec.ground,
    polygonOffsetFactor: -4,
    polygonOffsetUnits: -8,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false; // instances span the whole map
  mesh.renderOrder = 6;
  return { mesh, geo };
}

// Mobile: only the `cap` lamps nearest the camera get glow quads (rewritten on
// a slow cadence, amortized like the ParkedCars culling); the light pools also
// shrink. Desktop passes null and keeps every lamp, statically, as before.
export type LampGlowBudget = {
  readonly cap: number;
  readonly poolScale: number;
};

const NEAR_REFRESH_S = 0.5;

type CappedState = {
  readonly heads: readonly LampHead[];
  readonly haloArr: Float32Array;
  readonly poolArr: Float32Array;
  readonly haloAttr: THREE.InstancedBufferAttribute;
  readonly poolAttr: THREE.InstancedBufferAttribute;
  readonly halo: Layer;
  readonly pool: Layer;
  readonly cap: number;
  timer: number;
};

export class LampGlow {
  readonly group = new THREE.Group();
  private intensity = { value: 0 };
  private capped: CappedState | null = null;

  constructor(heads: readonly LampHead[], budget: LampGlowBudget | null = null) {
    if (heads.length === 0) return;
    const tex = radialGlowTexture();
    const cap = budget && heads.length > budget.cap ? budget.cap : 0;
    const n = cap > 0 ? cap : heads.length;
    const haloCenters = new Float32Array(n * 3);
    const poolCenters = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const h = heads[i];
      if (!h) continue;
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
        vert: HALO_VERT,
        tex,
        color: 0xffcf8a,
        gain: HALO_GAIN,
        size: HALO_SIZE,
        alpha: HALO_ALPHA,
        ground: false,
      },
      this.intensity,
    );
    const pool = buildLayer(
      poolAttr,
      n,
      {
        vert: POOL_VERT,
        tex: poolGlowTexture(),
        color: 0xffb865,
        gain: POOL_GAIN,
        size: poolSize,
        alpha: POOL_ALPHA,
        ground: true,
      },
      this.intensity,
    );
    this.group.add(halo.mesh);
    this.group.add(pool.mesh);
    this.group.visible = false;
    if (cap > 0) {
      this.capped = {
        heads,
        haloArr: haloCenters,
        poolArr: poolCenters,
        haloAttr,
        poolAttr,
        halo,
        pool,
        cap,
        timer: 0,
      };
    }
  }

  setIntensity(f: number): void {
    this.intensity.value = f;
    this.group.visible = f > 0.01; // skip both draws entirely in daylight
  }

  // Capped mode only: every ~0.5s pick the lamps nearest the camera and
  // rewrite the instance centers. Beyond FADE_FAR they're invisible anyway,
  // so only candidates inside the fade radius compete for the budget.
  updateNear(camX: number, camZ: number, dt: number): void {
    const c = this.capped;
    if (!c || !this.group.visible) return;
    c.timer -= dt;
    if (c.timer > 0) return;
    c.timer = NEAR_REFRESH_S;
    const picks: { d2: number; i: number }[] = [];
    const farSq = FADE_FAR * FADE_FAR;
    for (let i = 0; i < c.heads.length; i++) {
      const h = c.heads[i];
      if (!h) continue;
      const dx = h.x - camX;
      const dz = h.z - camZ;
      const d2 = dx * dx + dz * dz;
      if (d2 < farSq) picks.push({ d2, i });
    }
    picks.sort((a, b) => a.d2 - b.d2);
    const n = Math.min(c.cap, picks.length);
    for (let k = 0; k < n; k++) {
      const p = picks[k];
      const h = p ? c.heads[p.i] : undefined;
      if (!h) continue;
      c.haloArr.set([h.x, h.y, h.z], k * 3);
      c.poolArr.set([h.x, h.ground + POOL_LIFT, h.z], k * 3);
    }
    c.halo.geo.instanceCount = n;
    c.pool.geo.instanceCount = n;
    c.haloAttr.needsUpdate = true;
    c.poolAttr.needsUpdate = true;
  }
}
