// Bayer 8x8 ordered-dither post pass. The scene renders into a low-res
// target (DITHER_PIXEL css px per texel), then a fullscreen quad quantizes
// luminance to pure 2-tone ink-on-paper: anything darker than the paper
// tone dissolves into the dither pattern, so every alpha fade in the scene
// (goal flash, shadow, trail) becomes speckle for free. uInvert swaps the
// two tones for a 1-flash on big moments.

import * as THREE from "three";

import { BG, DITHER_PIXEL, INK, VIGNETTE_INNER, VIGNETTE_STRENGTH } from "../shared/constants";

// Classic Bayer 8x8 threshold matrix (values 0-63, row-major).
// prettier-ignore
const BAYER_8 = [
   0, 32,  8, 40,  2, 34, 10, 42,
  48, 16, 56, 24, 50, 18, 58, 26,
  12, 44,  4, 36, 14, 46,  6, 38,
  60, 28, 52, 20, 62, 30, 54, 22,
   3, 35, 11, 43,  1, 33,  9, 41,
  51, 19, 59, 27, 49, 17, 57, 25,
  15, 47,  7, 39, 13, 45,  5, 37,
  63, 31, 55, 23, 61, 29, 53, 21,
];

const VERTEX = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

const FRAGMENT = /* glsl */ `
varying vec2 vUv;
uniform sampler2D uScene;
uniform sampler2D uBayer;
uniform vec2 uSize;
uniform vec3 uInk;
uniform vec3 uPaper;
uniform float uBgLum;
uniform float uInvert;
uniform float uVignette;
uniform float uVigInner;

void main() {
  vec2 texel = floor(vUv * uSize) + 0.5;
  vec3 c = texture2D(uScene, texel / uSize).rgb;
  float lum = dot(c, vec3(0.299, 0.587, 0.114));
  // Edge vignette: pull luminance down toward the frame past uVigInner so the
  // bright paper field doesn't bleed to the borders. The falloff dithers into a
  // speckle frame for free — no extra geometry or pass. dist: 0 center → 1 corner.
  float dist = length(vUv - 0.5) * 1.41421356;
  lum *= 1.0 - uVignette * smoothstep(uVigInner, 1.0, dist);
  // Remap so the paper tone is exactly 1.0 — the empty background stays
  // clean paper and only darker-than-paper pixels dither toward ink.
  float t = clamp(lum / uBgLum, 0.0, 1.0);
  float threshold = texture2D(uBayer, texel / 8.0).r;
  float ink = t < threshold ? 1.0 : 0.0;
  ink = abs(ink - uInvert);
  gl_FragColor = vec4(mix(uPaper, uInk, ink), 1.0);
}
`;

function bayerTexture(): THREE.DataTexture {
  const data = new Uint8Array(64);
  for (let i = 0; i < 64; i++) {
    const v = BAYER_8[i] ?? 0;
    data[i] = Math.round(((v + 0.5) / 64) * 255);
  }
  const tex = new THREE.DataTexture(data, 8, 8, THREE.RedFormat, THREE.UnsignedByteType);
  tex.minFilter = THREE.NearestFilter;
  tex.magFilter = THREE.NearestFilter;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.needsUpdate = true;
  return tex;
}

/** Hex color as raw sRGB components (skips the linear working-space
 *  conversion) so the shader's direct-to-canvas output matches the CSS hex. */
function rawColor(hex: number): THREE.Color {
  return new THREE.Color().setHex(hex, THREE.LinearSRGBColorSpace);
}

/** Luminance of a hex color in the linear working space — the space the
 *  scene actually renders in, so it matches what the shader samples. */
function linearLuminance(hex: number): number {
  const c = new THREE.Color(hex);
  return 0.299 * c.r + 0.587 * c.g + 0.114 * c.b;
}

export class DitherPass {
  private readonly target: THREE.WebGLRenderTarget;
  private readonly quadScene = new THREE.Scene();
  private readonly quadCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly uSize: THREE.IUniform<THREE.Vector2>;
  private readonly uInvert: THREE.IUniform<number>;

  constructor(width: number, height: number) {
    const w = Math.max(1, Math.floor(width / DITHER_PIXEL));
    const h = Math.max(1, Math.floor(height / DITHER_PIXEL));
    this.target = new THREE.WebGLRenderTarget(w, h, {
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
    });
    this.uSize = { value: new THREE.Vector2(w, h) };
    this.uInvert = { value: 0 };

    const material = new THREE.ShaderMaterial({
      uniforms: {
        uScene: { value: this.target.texture },
        uBayer: { value: bayerTexture() },
        uSize: this.uSize,
        uInvert: this.uInvert,
        uInk: { value: rawColor(INK) },
        uPaper: { value: rawColor(BG) },
        uBgLum: { value: linearLuminance(BG) },
        uVignette: { value: VIGNETTE_STRENGTH },
        uVigInner: { value: VIGNETTE_INNER },
      },
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      depthTest: false,
      depthWrite: false,
    });
    this.quadScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material));
  }

  setSize(width: number, height: number): void {
    const w = Math.max(1, Math.floor(width / DITHER_PIXEL));
    const h = Math.max(1, Math.floor(height / DITHER_PIXEL));
    this.target.setSize(w, h);
    this.uSize.value.set(w, h);
  }

  setInverted(on: boolean): void {
    this.uInvert.value = on ? 1 : 0;
  }

  render(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera): void {
    renderer.setRenderTarget(this.target);
    renderer.render(scene, camera);
    renderer.setRenderTarget(null);
    renderer.render(this.quadScene, this.quadCamera);
  }
}
