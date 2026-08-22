// The column of light a smite, an ultimate or a respawn stands up in.
//
// Approach ported from the Elemental Sandbox VFX sandbox (MIT, Copyright (c)
// 2026 mohamedachrefelouafi) —
// https://github.com/achrefelouafi/LinearAbiltyCastingThreeJS
//
// The trick is the weighting, and it is worth being explicit about why:
//
//   SHELL — rim-weighted, so the sheath reads as HOLLOW and its silhouette
//           edges are the brightest part of it.
//   CORE  — the opposite weighting: brightest where the view ray runs down the
//           barrel and the path through the tube is longest. That is what makes
//           the middle read as a solid rod rather than as a cylinder with a lit
//           outline.
//
// Rim-weighted outside, axis-weighted inside, both faces of the tube adding:
// that is a volume integral, cheaply. The sandbox spends six meshes on this;
// we fold it into one double-sided additive tube, because at our camera
// distance the passes it separates land inside a couple of pixels of each other
// and the draw calls buy nothing.
import * as THREE from "three";
import { NOISE_GLSL } from "./fx-noise";

const VERT = /* glsl */ `
varying vec2 vUv;
varying vec3 vN;
varying vec3 vV;
void main() {
  vUv = uv;
  vN = normalize(normalMatrix * normal);
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vV = normalize(-mv.xyz);
  gl_Position = projectionMatrix * mv;
}`;

const FRAG = /* glsl */ `
uniform float uTime;
uniform vec3  uCore;
uniform vec3  uShell;
uniform float uOpacity;
uniform float uSeed;
varying vec2 vUv;
varying vec3 vN;
varying vec3 vV;

${NOISE_GLSL}

void main() {
  float ndv = abs(dot(normalize(vN), normalize(vV)));
  float rim  = pow(1.0 - ndv, 1.7);  // hollow sheath
  float axis = pow(ndv, 1.5);        // solid rod down the barrel

  // Ribbons spiralling around the column. Banded rather than smooth so they
  // read as discrete coils against the flat-shaded arena instead of as a soft
  // gradient the bloom pass will erase.
  float coil = bands(0.5 + 0.5 * sin((vUv.x * 3.0 - vUv.y * 5.0) * 6.2831 - uTime * 5.0), 3.0);
  // Shock discs racing UP the column, away from the ground it stands in.
  float disc = smoothstep(0.75, 1.0, fract(vUv.y * 2.5 - uTime * 1.6));
  float churn = 0.75 + 0.25 * fbm2(vec3(vUv * vec2(4.0, 2.5), uTime * 0.5 + uSeed));

  // Thickest where it meets the floor, and gone entirely before the top cap.
  // A beam has a source; and if its far end still has alpha, the tube's own
  // silhouette closes into a hard-edged cone and the whole thing stops reading
  // as light and starts reading as a solid.
  float taper = mix(1.0, 0.4, smoothstep(0.0, 0.8, vUv.y));
  float cap = 1.0 - smoothstep(0.62, 1.0, vUv.y);
  float foot = 1.0 - smoothstep(0.0, 0.3, vUv.y);

  vec3 color = mix(uShell, uCore, axis * axis);
  color += uCore * (coil * 0.3 + disc * 0.55 + foot * 0.8);

  // Weighted toward the rod down the middle: an evenly-lit tube is fog, and
  // reads milky rather than hot.
  float alpha = (rim * 0.42 + axis * 1.05) * churn * taper * cap * uOpacity;
  alpha += disc * 0.22 * taper * cap * uOpacity;
  if (alpha < 0.004) discard;
  gl_FragColor = vec4(color * (1.0 + axis * 1.4), min(alpha, 1.0));
}`;

export type BeamMaterial = THREE.ShaderMaterial & {
  setColor(core: number, shell: number): void;
  setOpacity(o: number): void;
  reseed(): void;
};

export function createBeamMaterial(clock: { value: number }): BeamMaterial {
  const uniforms = {
    uTime: clock,
    uCore: { value: new THREE.Color(0xffffff) },
    uShell: { value: new THREE.Color(0xff8040) },
    uOpacity: { value: 0.8 },
    uSeed: { value: 0 },
  };
  const mat = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: VERT,
    fragmentShader: FRAG,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
  });

  return Object.assign(mat, {
    setColor: (core: number, shell: number) => {
      uniforms.uCore.value.setHex(core);
      uniforms.uShell.value.setHex(shell);
    },
    setOpacity: (o: number) => {
      uniforms.uOpacity.value = o;
    },
    reseed: () => {
      uniforms.uSeed.value = Math.random() * 50;
    },
  });
}
