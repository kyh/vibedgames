// Unlit per-face cube shading — the reference's matte look, re-typed clean
// (no @ts-ignore, no `as ShaderMaterial`). No scene lights: depth reads from
// shading each face by its normal (top brightest, sides mid, front/back
// darkest) plus a thin dark edge ink. One base colour in, a readable 3D cube
// out. ShaderMaterials sharing source share the compiled program, so a
// material-per-cube is cheap.

import { Color, ShaderMaterial } from "three";

// oxlint-disable-next-line no-inline-comments -- /* glsl */ tags the literal for editor highlighting
const VERTEX = /* glsl */ `
  varying vec3 vNormal;
  varying vec2 vUv;
  void main() {
    vNormal = normal;
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

// oxlint-disable-next-line no-inline-comments -- /* glsl */ tags the literal for editor highlighting
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
    // Filter the ink boundary at the rendered pixel width, including grazing views.
    vec2 toEdge = min(vUv, 1.0 - vUv);
    float edgeDistance = min(toEdge.x, toEdge.y);
    float pixelWidth = max(fwidth(edgeDistance), 0.0001);
    float face = smoothstep(uEdge - pixelWidth * 0.5, uEdge + pixelWidth * 0.5, edgeDistance);
    color = mix(uEdgeColor, color, face);
    gl_FragColor = vec4(color, 1.0);
    #include <colorspace_fragment>
  }
`;

const EDGE_COLOR = new Color(0x0a_0b_12);

export const makeCubeMaterial = (colorHex: number): ShaderMaterial =>
  new ShaderMaterial({
    fragmentShader: FRAGMENT,
    uniforms: {
      uBright: { value: 1 },
      uColor: { value: new Color(colorHex) },
      uEdge: { value: 0.055 },
      uEdgeColor: { value: EDGE_COLOR.clone() },
    },
    vertexShader: VERTEX,
  });

/** Shaded material for the active (falling) slab — slightly brighter so it
 *  pops against the locked stack. */
export const makeActiveMaterial = (colorHex: number): ShaderMaterial => {
  const m = makeCubeMaterial(colorHex);
  const u = m.uniforms.uBright;
  if (u) {
    u.value = 1.18;
  }
  return m;
};
