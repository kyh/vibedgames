import * as THREE from "three";

// Streetlights that actually GLOW at night: two instanced draws over every
// lamp head the furniture pass placed —
//   1. a view-space billboard halo at the lamp head, and
//   2. a flat warm pool of light on the pavement under it.
// Both fade with one uIntensity uniform (the day-night lamp factor), fade out
// with camera distance (far lamps otherwise read as noise floating over the
// fog), and depth-test so buildings occlude them.

const HALO_SIZE = 2.6; // world units, quad edge
const POOL_SIZE = 10;
const HALO_ALPHA = 0.6;
const POOL_ALPHA = 0.34;
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

function buildLayer(
  centers: Float32Array,
  count: number,
  vert: string,
  tex: THREE.CanvasTexture,
  color: number,
  size: number,
  alpha: number,
  intensity: { value: number },
): THREE.Mesh {
  const quad = new THREE.PlaneGeometry(1, 1);
  const geo = new THREE.InstancedBufferGeometry();
  geo.index = quad.index;
  geo.setAttribute("position", quad.getAttribute("position"));
  geo.setAttribute("uv", quad.getAttribute("uv"));
  geo.setAttribute("aCenter", new THREE.InstancedBufferAttribute(centers, 3));
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
  return mesh;
}

export class LampGlow {
  readonly group = new THREE.Group();
  private intensity = { value: 0 };

  constructor(heads: readonly LampHead[]) {
    if (heads.length === 0) return;
    const tex = radialGlowTexture();
    const haloCenters = new Float32Array(heads.length * 3);
    const poolCenters = new Float32Array(heads.length * 3);
    for (let i = 0; i < heads.length; i++) {
      const h = heads[i];
      if (!h) continue;
      haloCenters.set([h.x, h.y, h.z], i * 3);
      poolCenters.set([h.x, h.ground + 0.09, h.z], i * 3);
    }
    this.group.add(
      buildLayer(haloCenters, heads.length, HALO_VERT, tex, 0xffcf8a, HALO_SIZE, HALO_ALPHA, this.intensity),
    );
    this.group.add(
      buildLayer(poolCenters, heads.length, POOL_VERT, tex, 0xffc57a, POOL_SIZE, POOL_ALPHA, this.intensity),
    );
    this.group.visible = false;
  }

  setIntensity(f: number): void {
    this.intensity.value = f;
    this.group.visible = f > 0.01; // skip both draws entirely in daylight
  }
}
