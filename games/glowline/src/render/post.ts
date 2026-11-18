// The desktop post chain: scene → bloom → grade → output.
//
// Bloom is thresholded high so only paint, lamps and signs bleed; that bleed
// is how paint throws its colour onto the kerb and barriers beside it. The
// grade is the look: cool shadows, warm highlights, a soft vignette.
//
// There is no screen-space ambient occlusion here on purpose: on the long
// flat triangles of a road it shaded every other triangle. Contact darkening
// is built into the scene instead (see `scenery.ts`), which also works on
// phones, where this chain does not run.

import * as THREE from "three";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { ShaderPass } from "three/addons/postprocessing/ShaderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";

const GRADE = {
  fragmentShader: `
    uniform sampler2D tDiffuse;
    varying vec2 vUv;
    void main() {
      vec4 texel = texture2D(tDiffuse, vUv);
      vec3 col = texel.rgb;
      float luma = dot(col, vec3(0.2126, 0.7152, 0.0722));
      // Split tone: cool the shadows, warm the highlights.
      col += vec3(-0.012, 0.004, 0.022) * (1.0 - smoothstep(0.0, 0.35, luma));
      col *= mix(vec3(1.0), vec3(1.05, 1.0, 0.94), smoothstep(0.35, 1.0, luma));
      // A little more saturation and contrast than the tone map leaves.
      col = mix(vec3(luma), col, 1.14);
      col = (col - 0.18) * 1.07 + 0.18;
      // Vignette: darker, slightly cooler corners.
      vec2 q = vUv - 0.5;
      float edge = smoothstep(0.38, 0.95, length(q * vec2(1.0, 0.82)) * 1.35);
      col *= 1.0 - edge * 0.42;
      gl_FragColor = vec4(max(col, 0.0), texel.a);
    }
  `,
  uniforms: { tDiffuse: { value: null } },
  vertexShader: `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
};

export const buildPost = (
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  camera: THREE.PerspectiveCamera,
): EffectComposer => {
  const size = renderer.getSize(new THREE.Vector2());
  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  composer.addPass(new UnrealBloomPass(size, 0.2, 0.4, 0.985));
  composer.addPass(new ShaderPass(GRADE));
  composer.addPass(new OutputPass());
  return composer;
};
