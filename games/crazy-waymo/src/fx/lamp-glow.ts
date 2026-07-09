import * as THREE from "three";

// Streetlights that actually GLOW at night: two instanced draws over every
// lamp head the furniture pass placed —
//   1. a view-space billboard halo at the lamp head, and
//   2. a flat warm pool of light on the pavement under it.
// Both fade with one uIntensity uniform (the day-night lamp factor), fade out
// with camera distance (far lamps otherwise read as noise floating over the
// fog), and depth-test so buildings occlude them.

const HALO_SIZE = 2.6; // world units, quad edge
const POOL_SIZE = 8;
const HALO_ALPHA = 0.5;
const POOL_ALPHA = 0.2;
const FADE_NEAR = 380; // camera distance where lamps start to fade
const FADE_FAR = 650;

export type LampHead = {
  readonly x: number;
  readonly y: number; // world height of the lamp head
  readonly z: number;
  readonly ground: number; // world height of the pavement under it
};

// Soft radial gradient blob, generated at boot — no asset fetch.
export function radialGlowTexture(): THREE.CanvasTexture {
  const size = 128;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (ctx) {
    const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    g.addColorStop(0, "rgba(255,255,255,1)");
    g.addColorStop(0.35, "rgba(255,255,255,0.5)");
    g.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, size, size);
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.NoColorSpace;
  return tex;
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

function buildLayer(
  attr: THREE.InstancedBufferAttribute,
  count: number,
  vert: string,
  tex: THREE.CanvasTexture,
  color: number,
  size: number,
  alpha: number,
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
      uMap: { value: tex },
      uColor: { value: new THREE.Color(color) },
      uSize: { value: size },
      uAlpha: { value: alpha },
      uIntensity: intensity,
    },
    vertexShader: vert,
    fragmentShader: FRAG,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
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
      poolCenters.set([h.x, h.ground + 0.09, h.z], i * 3);
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
      HALO_VERT,
      tex,
      0xffcf8a,
      HALO_SIZE,
      HALO_ALPHA,
      this.intensity,
    );
    const pool = buildLayer(
      poolAttr,
      n,
      POOL_VERT,
      tex,
      0xffc57a,
      poolSize,
      POOL_ALPHA,
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
      c.poolArr.set([h.x, h.ground + 0.09, h.z], k * 3);
    }
    c.halo.geo.instanceCount = n;
    c.pool.geo.instanceCount = n;
    c.haloAttr.needsUpdate = true;
    c.poolAttr.needsUpdate = true;
  }
}
