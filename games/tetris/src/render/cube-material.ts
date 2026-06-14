// Unlit per-face cube shading — the reference's matte look, re-typed clean
// (no @ts-ignore, no `as ShaderMaterial`). No scene lights: depth reads from
// shading each face by its normal (top brightest, sides mid, front/back
// darkest) plus a thin dark edge ink. One base colour in, a readable 3D cube
// out. ShaderMaterials sharing source share the compiled program, so a
// material-per-cube is cheap.

import { Color, ShaderMaterial } from "three";

const VERTEX = /* glsl */ `
  varying vec3 vNormal;
  varying vec2 vUv;
  void main() {
    vNormal = normal;
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const FRAGMENT = /* glsl */ `
  varying vec3 vNormal;
  varying vec2 vUv;
  uniform vec3 uColor;
  uniform vec3 uEdgeColor;
  uniform float uEdge;
  uniform float uBright;
  void main() {
    vec3 n = abs(vNormal);
    float shade = 0.66;            // front/back
    if (n.y > 0.5) shade = 1.0;    // top/bottom
    else if (n.x > 0.5) shade = 0.82; // left/right
    vec3 color = uColor * shade * uBright;
    if (vUv.x < uEdge || vUv.x > 1.0 - uEdge || vUv.y < uEdge || vUv.y > 1.0 - uEdge) {
      color = uEdgeColor;
    }
    gl_FragColor = vec4(color, 1.0);
    #include <colorspace_fragment>
  }
`;

const EDGE_COLOR = new Color(0x0a0b12);

export function makeCubeMaterial(colorHex: number): ShaderMaterial {
  return new ShaderMaterial({
    uniforms: {
      uColor: { value: new Color(colorHex) },
      uEdgeColor: { value: EDGE_COLOR.clone() },
      uEdge: { value: 0.055 },
      uBright: { value: 1.0 },
    },
    vertexShader: VERTEX,
    fragmentShader: FRAGMENT,
  });
}

/** Shaded material for the active (falling) slab — slightly brighter so it
 *  pops against the locked stack. */
export function makeActiveMaterial(colorHex: number): ShaderMaterial {
  const m = makeCubeMaterial(colorHex);
  const u = m.uniforms.uBright;
  if (u) u.value = 1.18;
  return m;
}
