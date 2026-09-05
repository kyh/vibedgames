import * as THREE from "three";

import { WORLD_H, WORLD_HALF_X, WORLD_HALF_Z, WORLD_W } from "../shared/constants";
import type { GroundBlend, GroundBlendAt } from "../world/ground";
import { lowDetailSurfaces } from "../world/roads";

export const TERRAIN_BLEND_SIZE = 512;
export const TERRAIN_BLEND_BYTES = TERRAIN_BLEND_SIZE * TERRAIN_BLEND_SIZE * 4;
const BARE_SAND = { sandStart: 0.72, sandFull: 0.98, turfStart: 0.02, turfFull: 0.12 };

/** Dune scrub uses turf detail even when loose sand still governs tire FX. */
export function bareSandWeight(blend: Readonly<GroundBlend>): number {
  return (
    THREE.MathUtils.smoothstep(blend.sand, BARE_SAND.sandStart, BARE_SAND.sandFull) *
    (1 - THREE.MathUtils.smoothstep(blend.turf, BARE_SAND.turfStart, BARE_SAND.turfFull))
  );
}

/** RGBA stores turf/sand/stone/loose, not color. Row zero is the north (-Z). */
export function createTerrainBlendTexture(blendAt: GroundBlendAt): THREE.DataTexture {
  const data = new Uint8Array(TERRAIN_BLEND_BYTES);
  const blend = { turf: 0, sand: 0, stone: 0, loose: 0 };
  for (let row = 0; row < TERRAIN_BLEND_SIZE; row++) {
    const z = ((row + 0.5) / TERRAIN_BLEND_SIZE) * WORLD_H - WORLD_HALF_Z;
    for (let column = 0; column < TERRAIN_BLEND_SIZE; column++) {
      const x = ((column + 0.5) / TERRAIN_BLEND_SIZE) * WORLD_W - WORLD_HALF_X;
      blendAt(x, z, blend);
      const offset = (row * TERRAIN_BLEND_SIZE + column) * 4;
      data[offset] = Math.round(blend.turf * 255);
      data[offset + 1] = Math.round(blend.sand * 255);
      data[offset + 2] = Math.round(blend.stone * 255);
      data[offset + 3] = Math.round(blend.loose * 255);
    }
  }
  const texture = new THREE.DataTexture(data, TERRAIN_BLEND_SIZE, TERRAIN_BLEND_SIZE);
  texture.name = "terrain-material-weights";
  texture.colorSpace = THREE.NoColorSpace;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = false;
  texture.flipY = false;
  texture.needsUpdate = true;
  return texture;
}

const TERRAIN_COMMON = /* glsl */ `
uniform sampler2D uTerrainBlend;
varying vec3 vTerrainPos;
varying vec3 vTerrainNormal;
float tmHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float tmNoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(tmHash(i), tmHash(i + vec2(1.0, 0.0)), u.x),
    mix(tmHash(i + vec2(0.0, 1.0)), tmHash(i + 1.0), u.x), u.y);
}
// Running-bond parcels. Fixed world-width seams fade before they alias.
vec2 tmCells(vec2 p, vec2 size, float px, float seamWidth) {
  vec2 g = p / size;
  float row = floor(g.y);
  g.x += tmHash(vec2(row, 13.0)) * 2.7;
  vec2 edge = min(fract(g), 1.0 - fract(g)) * size;
  float seam = (1.0 - smoothstep(0.0, seamWidth + px, min(edge.x, edge.y)))
    * (1.0 - smoothstep(seamWidth * 2.0, seamWidth * 7.0, px));
  return vec2(tmHash(floor(g)) - 0.5, seam);
}
`;

const TERRAIN_COLOR = /* glsl */ `
// One semantic fetch. All derivatives run outside material-dependent branches.
vec2 tmWp = vTerrainPos.xz;
vec2 tmUv = (tmWp + vec2(${WORLD_HALF_X.toFixed(1)}, ${WORLD_HALF_Z.toFixed(1)}))
  / vec2(${WORLD_W.toFixed(1)}, ${WORLD_H.toFixed(1)});
vec4 tmWeight = texture2D(uTerrainBlend, tmUv);
float tmBareSand = smoothstep(${BARE_SAND.sandStart}, ${BARE_SAND.sandFull}, tmWeight.g)
  * (1.0 - smoothstep(${BARE_SAND.turfStart}, ${BARE_SAND.turfFull}, tmWeight.r));
float tmPaved = max(0.0, 1.0 - dot(tmWeight, vec4(1.0)));
float tmGravel = min(1.0, min(tmWeight.b, tmWeight.a) * 3.3333);
float tmRock = max(0.0, tmWeight.b - tmGravel * 0.7);
vec2 tmPixel = fwidth(tmWp);
float tmPx = max(tmPixel.x, tmPixel.y);
float tmBroad = tmNoise(tmWp * 0.055);
float tmClump = tmNoise(tmWp * 0.72 + tmBroad * 2.0);
float tmClumpFade = 1.0 - smoothstep(0.45, 1.4, tmPx);
float tmGrainFade = 1.0 - smoothstep(0.05, 0.22, tmPx);
float tmGrain = 0.0;
#ifdef TERRAIN_FULL
  // Smooth, domain-shifted grain. A hash of floored world coordinates made
  // each close-up grass sample a tiny square, especially after the grade.
  tmGrain = (tmNoise(tmWp * 4.5 + vec2(tmClump, tmBroad) * 2.0) - 0.5) * tmGrainFade;
#endif
float tmRipplePhase = dot(tmWp, vec2(7.1, 4.2)) + tmBroad * 7.0 + tmClump * 2.6;
float tmRipple = sin(tmRipplePhase)
  * (1.0 - smoothstep(0.9, 2.8, fwidth(tmRipplePhase)));
float tmStrataPhase = vTerrainPos.y * 3.2 + tmWp.x * 0.8 + tmBroad * 3.0;
float tmStrata = sin(tmStrataPhase)
  * (1.0 - smoothstep(0.9, 2.8, fwidth(tmStrataPhase)));
float tmClumps = (smoothstep(0.28, 0.76, tmClump) - 0.5) * tmClumpFade;
float tmSoil = smoothstep(0.58, 0.78, tmBroad)
  * smoothstep(0.48, 0.76, tmClump) * tmClumpFade;
vec2 tmParcel = tmCells(tmWp + tmBroad * 2.0, vec2(8.0, 12.5), tmPx, 0.19);
float tmBlock = tmHash(floor(tmWp / vec2(55.0, 47.0))) - 0.5;
float tmTurfValue = tmClumps * 0.31 + tmGrain * 0.12 - tmSoil * 0.22;
float tmSandValue = tmGrain * 0.075;
float tmStoneValue = tmClumps * 0.18 + tmGrain * 0.24;
float tmLooseValue = tmClumps * 0.22 + tmGrain * 0.12;
float tmPavedValue = tmParcel.x * 0.15 - tmParcel.y * 0.08 + tmBlock * 0.14;
float tmVariation = dot(tmWeight, vec4(tmTurfValue, tmSandValue, tmStoneValue, tmLooseValue))
  + tmPaved * tmPavedValue + tmRock * tmStrata * 0.085 + tmBareSand * tmRipple * 0.035;
// A coarse baked vertex can bleed neighboring turf into a narrow beach. The
// semantic bare-sand mask restores its sandy chroma while retaining luminance.
float tmSandLum = dot(diffuseColor.rgb, vec3(0.2126, 0.7152, 0.0722));
diffuseColor.rgb = mix(diffuseColor.rgb, tmSandLum * vec3(1.13, 1.0, 0.72), tmBareSand * 0.7);
diffuseColor.rgb *= 1.0 + tmVariation + (tmBroad - 0.5) * 0.13;
// Soil only changes turf's character. Golden grass stays golden, without sand bands.
diffuseColor.rgb *= mix(vec3(1.0), vec3(1.08, 0.88, 0.7), tmSoil * tmWeight.r * 0.6);
diffuseColor.rgb *= 1.0 - smoothstep(0.03, 0.5,
  1.0 - clamp(vTerrainNormal.y, 0.0, 1.0)) * 0.08;
// Sand touching sea level is smoother; inland golden slopes cannot enter this term.
float tmWet = tmBareSand * (1.0 - smoothstep(0.1, 1.65, vTerrainPos.y));
float tmRelief = tmWeight.r * tmClumps * 0.045 + tmBareSand * tmRipple * 0.006
  + tmWeight.b * tmClumps * 0.028 + tmRock * tmStrata * 0.018
  + tmWeight.a * tmClumps * 0.025;
`;

// Screen-space surface gradient, using Three's view-space normal. The relief
// is centimetres, never displacement; phone materials omit this work entirely.
const TERRAIN_NORMAL = /* glsl */ `
#ifdef TERRAIN_FULL
  vec3 tmDx = dFdx(-vViewPosition), tmDy = dFdy(-vViewPosition);
  vec3 tmR1 = cross(tmDy, normal), tmR2 = cross(normal, tmDx);
  float tmDet = dot(tmDx, tmR1) * faceDirection;
  vec3 tmGradient = sign(tmDet) * (dFdx(tmRelief) * tmR1 + dFdy(tmRelief) * tmR2);
  normal = normalize(abs(tmDet) * normal - tmGradient + normal * 0.000001);
#endif
`;

/** One shared ground material for live and baked tiles. It owns its sole texture. */
export function createTerrainMaterial(blendAt: GroundBlendAt): THREE.MeshStandardMaterial {
  const texture = createTerrainBlendTexture(blendAt);
  const lowDetail = lowDetailSurfaces();
  const material = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    vertexColors: true,
    roughness: 1,
  });
  material.name = "semantic-terrain";
  material.customProgramCacheKey = () => `semantic-terrain-v2-${lowDetail ? "phone" : "full"}`;
  material.addEventListener("dispose", () => texture.dispose());
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uTerrainBlend = { value: texture };
    shader.vertexShader = shader.vertexShader
      .replace(
        "#include <common>",
        "#include <common>\nvarying vec3 vTerrainPos;\nvarying vec3 vTerrainNormal;",
      )
      .replace(
        "#include <begin_vertex>",
        `#include <begin_vertex>
vTerrainPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
vTerrainNormal = normalize(mat3(modelMatrix) * objectNormal);`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        `#include <common>\n${lowDetail ? "" : "#define TERRAIN_FULL 1"}\n${TERRAIN_COMMON}`,
      )
      .replace("#include <color_fragment>", `#include <color_fragment>\n${TERRAIN_COLOR}`)
      .replace(
        "#include <roughnessmap_fragment>",
        `#include <roughnessmap_fragment>
roughnessFactor = clamp(roughnessFactor - tmWet * 0.28 - tmWeight.b * 0.055, 0.7, 1.0);`,
      )
      .replace(
        "#include <normal_fragment_maps>",
        `#include <normal_fragment_maps>\n${TERRAIN_NORMAL}`,
      );
  };
  return material;
}
