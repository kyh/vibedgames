// Fireflies drift around the bushes after dark. They are a single Points draw:
// the vertex shader wanders each one on its own phase and blinks it, and the
// fragment shader fades the whole swarm in with the night level.
import * as THREE from "three";
import { rand } from "../utils";
import type { World } from "../world/world";

const COUNT = 90;

// oxlint-disable-next-line no-inline-comments -- the /* glsl */ tag must sit on the template line for editor shader highlighting
const FIREFLY_VERT = /* glsl */ `
        attribute float aPhase;
        uniform float uTime; uniform float uScale;
        varying float vBlink;
        void main() {
          vec3 p = position;
          p.x += sin( uTime * 0.6 + aPhase ) * 0.7 + sin( uTime * 1.3 + aPhase * 2.0 ) * 0.25;
          p.y += sin( uTime * 0.9 + aPhase * 1.7 ) * 0.3;
          p.z += cos( uTime * 0.5 + aPhase * 1.3 ) * 0.7;
          vBlink = pow( clamp( 0.5 + 0.5 * sin( uTime * 2.2 + aPhase * 5.0 ), 0.0, 1.0 ), 3.0 );
          vec4 mv = modelViewMatrix * vec4( p, 1.0 );
          gl_Position = projectionMatrix * mv;
          gl_PointSize = ( 0.1 + vBlink * 0.12 ) * uScale / max( 0.1, - mv.z );
        }`;

// oxlint-disable-next-line no-inline-comments -- the /* glsl */ tag must sit on the template line for editor shader highlighting
const FIREFLY_FRAG = /* glsl */ `
        uniform float uNight;
        varying float vBlink;
        void main() {
          float d = length( gl_PointCoord - 0.5 );
          float a = smoothstep( 0.5, 0.0, d );
          gl_FragColor = vec4( vec3( 1.6, 2.4, 0.5 ) * ( 0.4 + vBlink * 3.0 ), a * a * uNight );
        }`;

const scratchMatrix = new THREE.Matrix4();
const scratchPos = new THREE.Vector3();

export interface FireflyUniforms {
  uNight: { value: number };
  uScale: { value: number };
  uTime: { value: number };
}

export interface FireflySwarm {
  points: THREE.Points;
  material: THREE.ShaderMaterial;
  uniforms: FireflyUniforms;
}

/**
 * Scatter fireflies near random bush instances (or anywhere on the map when
 * the world has no bushes) and build the Points that draws them.
 */
export const createFireflies = (world: World): FireflySwarm => {
  const bushes = world.meshes.bush;
  const positions = new Float32Array(COUNT * 3);
  const phases = new Float32Array(COUNT);
  for (let i = 0; i < COUNT; i += 1) {
    if (bushes && bushes.count > 0) {
      bushes.getMatrixAt(Math.floor(Math.random() * bushes.count), scratchMatrix);
      scratchPos.setFromMatrixPosition(scratchMatrix);
    } else {
      scratchPos.set(rand(-18, 18), 0, rand(-18, 18));
    }
    positions[i * 3] = scratchPos.x + rand(-1.4, 1.4);
    positions[i * 3 + 1] = world.heightAt(scratchPos.x, scratchPos.z) + rand(0.5, 1.9);
    positions[i * 3 + 2] = scratchPos.z + rand(-1.4, 1.4);
    phases[i] = Math.random() * 100;
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("aPhase", new THREE.BufferAttribute(phases, 1));
  // Left un-annotated: an inferred literal satisfies the material's uniform map,
  // and it still matches FireflyUniforms structurally for the swarm.
  const uniforms = {
    uNight: { value: 0 },
    uScale: { value: 600 },
    uTime: { value: 0 },
  };
  const material = new THREE.ShaderMaterial({
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    fragmentShader: FIREFLY_FRAG,
    transparent: true,
    uniforms,
    vertexShader: FIREFLY_VERT,
  });
  const points = new THREE.Points(geometry, material);
  points.frustumCulled = false;
  points.renderOrder = 9;
  return { material, points, uniforms };
};
