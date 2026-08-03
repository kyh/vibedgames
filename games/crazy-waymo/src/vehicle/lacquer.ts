import * as THREE from "three";

import { rimGlsl } from "./sun-rim";

// Two-lobe lacquer for the player-class clearcoat bodies: the base coat
// carries a fine 6mm-ish "dimple" normal field, the clearcoat carries its OWN
// longer-wave orange-peel at an incommensurate tile — two disagreeing
// highlights is what reads as lacquer instead of clay. A coat-roughness map
// hazes the flanks while the crown stays near-mirror, and a chroma-clamped
// env response keeps the paint hue in charge of its own reflections across
// the whole day-night sweep.
//
// All maps are canvas-baked once at boot from a deterministic LCG, in a
// single 256px tile per map (kit UVs are palette lookups, so the shader
// samples these by an object-space box projection instead of mesh uv).

// Tile sizes in body units (~metres). 0.167 and 0.588 share no small factor,
// so the two peel fields never phase-lock.
export const PAINT_TILE = 0.167;
export const COAT_TILE = 0.588;
// Tangent-space tilt applied to each sampled peel normal (base ~2 deg,
// coat ~7 deg — the coat lobe is the visible one, by design).
export const PAINT_NORMAL_SCALE = 0.1;
export const COAT_NORMAL_SCALE = 0.12;
// Coat roughness span. The reference ran 0.026..0.086; the floor is raised to
// 0.04 because waymo's env cube is a 64px gradient and a nearer-mirror coat
// resolves its banding.
export const COAT_ROUGH_MIN = 0.04;
export const COAT_ROUGH_MAX = 0.086;
// Env response (dimensionless ratios — exposure-independent): energy dims
// head-on and brightens at grazing (a real Fresnel ramp), while the
// reflection keeps LUMINANCE and gives up CHROMA so a violet sunset cannot
// out-vote the pigment. Fresnel direction matters: brightening at grazing is
// lacquer, the inverse is terracotta.
export const PAINT_ENV_FACE_SCALE = 0.82;
export const PAINT_ENV_GRAZE_SCALE = 1.3;
export const PAINT_ENV_FACE_CHROMA = 0.45;
export const PAINT_ENV_GRAZE_CHROMA = 0.26;
export const PAINT_ENV_POWER = 3.0;

const TEX_SIZE = 256;
// Slope gain applied when the height fields become normal maps — sets how
// much of the [-1,1] tangent range each map uses before the *_NORMAL_SCALE.
const BASE_SOBEL_GAIN = 3.0;
const COAT_SOBEL_GAIN = 5.0;
const SWIRL_COUNT = 46;
const SWIRL_ALPHA = 0.13;

function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

// Seamless value noise: bilinear-smoothstep interpolation of a wrapped random
// lattice. `cells` must divide `size`.
function addNoise(
  field: Float32Array,
  size: number,
  cells: number,
  amp: number,
  rand: () => number,
): void {
  const lattice = new Float32Array(cells * cells);
  for (let i = 0; i < lattice.length; i++) lattice[i] = rand() * 2 - 1;
  const step = size / cells;
  for (let y = 0; y < size; y++) {
    const cy = Math.floor(y / step);
    const fy = THREE.MathUtils.smoothstep((y - cy * step) / step, 0, 1);
    const y0 = cy % cells;
    const y1 = (cy + 1) % cells;
    for (let x = 0; x < size; x++) {
      const cx = Math.floor(x / step);
      const fx = THREE.MathUtils.smoothstep((x - cx * step) / step, 0, 1);
      const x0 = cx % cells;
      const x1 = (cx + 1) % cells;
      const a = lattice[y0 * cells + x0] ?? 0;
      const b = lattice[y0 * cells + x1] ?? 0;
      const c = lattice[y1 * cells + x0] ?? 0;
      const d = lattice[y1 * cells + x1] ?? 0;
      const v = a + (b - a) * fx + (c - a + (d - c) * fx - (b - a) * fx) * fy;
      const idx = y * size + x;
      field[idx] = (field[idx] ?? 0) + v * amp;
    }
  }
}

// Faint polish-swirl arc strokes composited into a height field via canvas.
// Returns the field unchanged when no 2d context exists (headless boots).
function addSwirls(field: Float32Array, size: number, rand: () => number): Float32Array {
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return field;
  const img = ctx.createImageData(size, size);
  for (let i = 0; i < field.length; i++) {
    const v = Math.round(THREE.MathUtils.clamp((field[i] ?? 0) * 0.5 + 0.5, 0, 1) * 255);
    img.data[i * 4] = v;
    img.data[i * 4 + 1] = v;
    img.data[i * 4 + 2] = v;
    img.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  ctx.globalAlpha = SWIRL_ALPHA;
  ctx.strokeStyle = "#ffffff";
  for (let i = 0; i < SWIRL_COUNT; i++) {
    ctx.lineWidth = 1.8 + rand() * 1.6;
    const r = size * (0.1 + rand() * 0.45);
    const a0 = rand() * Math.PI * 2;
    ctx.beginPath();
    ctx.arc(rand() * size, rand() * size, r, a0, a0 + 0.5 + rand() * 1.6);
    ctx.stroke();
  }
  const out = ctx.getImageData(0, 0, size, size);
  for (let i = 0; i < field.length; i++) {
    field[i] = ((out.data[i * 4] ?? 128) / 255) * 2 - 1;
  }
  return field;
}

function makeTexture(data: Uint8Array, size: number): THREE.DataTexture {
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  return tex;
}

// Wrapped central-difference slopes -> tangent-space normal map.
function normalMapFrom(field: Float32Array, size: number, gain: number): THREE.DataTexture {
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    const yn = (y + size - 1) % size;
    const yp = (y + 1) % size;
    for (let x = 0; x < size; x++) {
      const xn = (x + size - 1) % size;
      const xp = (x + 1) % size;
      const dx = ((field[y * size + xp] ?? 0) - (field[y * size + xn] ?? 0)) * 0.5 * gain;
      const dy = ((field[yp * size + x] ?? 0) - (field[yn * size + x] ?? 0)) * 0.5 * gain;
      const inv = 1 / Math.hypot(dx, dy, 1);
      const o = (y * size + x) * 4;
      data[o] = Math.round((-dx * inv * 0.5 + 0.5) * 255);
      data[o + 1] = Math.round((-dy * inv * 0.5 + 0.5) * 255);
      data[o + 2] = Math.round((inv * 0.5 + 0.5) * 255);
      data[o + 3] = 255;
    }
  }
  return makeTexture(data, size);
}

function grayMapFrom(field: Float32Array, size: number): THREE.DataTexture {
  const data = new Uint8Array(size * size * 4);
  for (let i = 0; i < field.length; i++) {
    const v = Math.round(THREE.MathUtils.clamp((field[i] ?? 0) * 0.5 + 0.5, 0, 1) * 255);
    data[i * 4] = v;
    data[i * 4 + 1] = v;
    data[i * 4 + 2] = v;
    data[i * 4 + 3] = 255;
  }
  return makeTexture(data, size);
}

type LacquerMaps = {
  readonly baseNormal: THREE.DataTexture;
  readonly coatNormal: THREE.DataTexture;
  readonly coatRough: THREE.DataTexture;
};

let baked: LacquerMaps | null = null;

function lacquerMaps(): LacquerMaps {
  if (baked) return baked;
  // Base coat: ~6mm dimple (8px at the 167mm tile) + a finer half-amp octave
  // + polish swirls.
  const rand = lcg(0x5eed_ca11);
  const base = new Float32Array(TEX_SIZE * TEX_SIZE);
  addNoise(base, TEX_SIZE, 32, 0.6, rand);
  addNoise(base, TEX_SIZE, 64, 0.25, rand);
  addSwirls(base, TEX_SIZE, rand);
  // Clearcoat: long-wave spray flow plus a ~19mm orange-peel octave (8px at
  // the 588mm tile), summed into ONE height so both share a slope field.
  const coat = new Float32Array(TEX_SIZE * TEX_SIZE);
  addNoise(coat, TEX_SIZE, 4, 0.36, rand);
  addNoise(coat, TEX_SIZE, 32, 0.39, rand);
  // Coat roughness: panel-sized sweeps, not grain — smaller cells read as a
  // dirt map.
  const rough = new Float32Array(TEX_SIZE * TEX_SIZE);
  addNoise(rough, TEX_SIZE, 4, 0.8, rand);
  addNoise(rough, TEX_SIZE, 8, 0.3, rand);
  baked = {
    baseNormal: normalMapFrom(base, TEX_SIZE, BASE_SOBEL_GAIN),
    coatNormal: normalMapFrom(coat, TEX_SIZE, COAT_SOBEL_GAIN),
    coatRough: grayMapFrom(rough, TEX_SIZE),
  };
  return baked;
}

const LUMA = "vec3( 0.2126, 0.7152, 0.0722 )";

const LACQUER_PARS = /* glsl */ `
#include <common>
uniform sampler2D uPeelBase;
uniform sampler2D uPeelCoat;
uniform sampler2D uCoatRough;
varying vec3 vLacquerPos;
varying vec3 vLacquerN;
vec2 lacquerUv( const in float tile ) {
	vec3 a = abs( vLacquerN );
	vec2 p = a.y > max( a.x, a.z ) ? vLacquerPos.xz : ( a.x > a.z ? vLacquerPos.zy : vLacquerPos.xy );
	return p / tile;
}
mat3 lacquerTangentFrame( vec3 eye_pos, vec3 surf_norm, vec2 uv ) {
	vec3 q0 = dFdx( eye_pos.xyz );
	vec3 q1 = dFdy( eye_pos.xyz );
	vec2 st0 = dFdx( uv.st );
	vec2 st1 = dFdy( uv.st );
	vec3 N = surf_norm;
	vec3 q1perp = cross( q1, N );
	vec3 q0perp = cross( N, q0 );
	vec3 T = q1perp * st0.x + q0perp * st1.x;
	vec3 B = q1perp * st0.y + q0perp * st1.y;
	float det = max( dot( T, T ), dot( B, B ) );
	float scale = ( det == 0.0 ) ? 0.0 : inversesqrt( det );
	return mat3( T * scale, B * scale, N );
}
`;

const BASE_PEEL = /* glsl */ `
#include <normal_fragment_maps>
{
	vec2 peelUv = lacquerUv( ${PAINT_TILE.toFixed(4)} );
	vec3 peelN = texture2D( uPeelBase, peelUv ).xyz * 2.0 - 1.0;
	peelN.xy *= ${PAINT_NORMAL_SCALE.toFixed(4)};
	normal = normalize( lacquerTangentFrame( - vViewPosition, normal, peelUv ) * peelN );
}
`;

const COAT_PEEL = /* glsl */ `
#include <clearcoat_normal_fragment_maps>
#ifdef USE_CLEARCOAT
{
	vec2 coatUv = lacquerUv( ${COAT_TILE.toFixed(4)} );
	vec3 coatN = texture2D( uPeelCoat, coatUv ).xyz * 2.0 - 1.0;
	coatN.xy *= ${COAT_NORMAL_SCALE.toFixed(4)};
	clearcoatNormal = normalize( lacquerTangentFrame( - vViewPosition, clearcoatNormal, coatUv ) * coatN );
}
#endif
`;

// Overrides the include's uniform clearcoatRoughness; geometryRoughness (the
// derivative anti-alias term) is re-added because the assignment drops it.
const COAT_ROUGH = /* glsl */ `
#include <lights_physical_fragment>
#ifdef USE_CLEARCOAT
material.clearcoatRoughness = min( mix( ${COAT_ROUGH_MIN.toFixed(4)}, ${COAT_ROUGH_MAX.toFixed(4)}, texture2D( uCoatRough, lacquerUv( ${COAT_TILE.toFixed(4)} ) ).g ) + geometryRoughness, 1.0 );
#endif
`;

const ENV_RESPONSE = /* glsl */ `
{
	float envF = pow( 1.0 - saturate( dot( geometryNormal, geometryViewDir ) ), ${PAINT_ENV_POWER.toFixed(2)} );
	float envScale = mix( ${PAINT_ENV_FACE_SCALE.toFixed(2)}, ${PAINT_ENV_GRAZE_SCALE.toFixed(2)}, envF );
	float envChroma = mix( ${PAINT_ENV_FACE_CHROMA.toFixed(2)}, ${PAINT_ENV_GRAZE_CHROMA.toFixed(2)}, envF );
	radiance = mix( vec3( dot( radiance, ${LUMA} ) ), radiance, envChroma ) * envScale;
	#ifdef USE_CLEARCOAT
	clearcoatRadiance = mix( vec3( dot( clearcoatRadiance, ${LUMA} ) ), clearcoatRadiance, envChroma ) * envScale;
	#endif
}
#include <lights_fragment_end>
`;

/**
 * Inject the two-lobe lacquer + env response + sun rim into a fresh
 * player-class clearcoat clone. The material's own clearcoatRoughness value
 * becomes dead — the baked map drives it.
 */
export function applyLacquer(m: THREE.MeshPhysicalMaterial, rimStrength: number): void {
  const maps = lacquerMaps();
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uPeelBase = { value: maps.baseNormal };
    shader.uniforms.uPeelCoat = { value: maps.coatNormal };
    shader.uniforms.uCoatRough = { value: maps.coatRough };
    shader.vertexShader = shader.vertexShader
      .replace(
        "#include <common>",
        "#include <common>\nvarying vec3 vLacquerPos;\nvarying vec3 vLacquerN;",
      )
      .replace(
        "#include <beginnormal_vertex>",
        "#include <beginnormal_vertex>\n\tvLacquerN = objectNormal;",
      )
      .replace("#include <begin_vertex>", "#include <begin_vertex>\n\tvLacquerPos = transformed;");
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", LACQUER_PARS)
      .replace("#include <normal_fragment_maps>", BASE_PEEL)
      .replace("#include <clearcoat_normal_fragment_maps>", COAT_PEEL)
      .replace("#include <lights_physical_fragment>", COAT_ROUGH)
      .replace("#include <lights_fragment_end>", ENV_RESPONSE)
      .replace("#include <opaque_fragment>", rimGlsl(rimStrength));
  };
  const key = `waymo-lacquer|rim:${rimStrength.toFixed(2)}`;
  m.customProgramCacheKey = () => key;
}
