// Bush tiles are clumps of thirteen instanced grass blades: nine on a jittered
// 3×3 lattice plus four loose ones. The standard material is patched so the
// blades sway in the wind, bend away from nearby brawlers (`uPushers`) and
// screen-door fade around the local player (`uReveal`) so hiding in a bush
// never hides you from yourself.
import * as THREE from "three";

import { TILE } from "../config";
import type { TileCoord } from "./grid";
import {
  GRID,
  GRID_HALF,
  gridIndex,
  SCRATCH_COLOR,
  SCRATCH_EULER,
  SCRATCH_MATRIX,
  SCRATCH_POSITION,
  SCRATCH_QUATERNION,
  SCRATCH_SCALE,
} from "./grid";

/** Blades per bush tile. */
export const BLADES_PER_BUSH = 13;

export interface GrassUniforms {
  uTime: THREE.IUniform<number>;
  /** xy = world XZ, z = radius, w = strength; one slot per brawler. */
  uPushers: THREE.IUniform<THREE.Vector4[]>;
  /** xy = world XZ of the local player, w > 0.5 enables the fade. */
  uReveal: THREE.IUniform<THREE.Vector4>;
}

export const makeGrassUniforms = (): GrassUniforms => ({
  uPushers: { value: Array.from({ length: 8 }, () => new THREE.Vector4(0, 0, 1, 0)) },
  uReveal: { value: new THREE.Vector4(0, 0, 0, 0) },
  uTime: { value: 0 },
});

// oxlint-disable-next-line no-inline-comments -- the /* glsl */ tag must sit on the template line for editor shader highlighting
const GRASS_VERT_HEAD = /* glsl */ `#include <common>
uniform float uTime;
uniform vec4 uPushers[ 8 ];
varying float vBladeH;
varying vec3 vBladeWorld;`;

// oxlint-disable-next-line no-inline-comments -- the /* glsl */ tag must sit on the template line for editor shader highlighting
const GRASS_VERT_PROJECT = /* glsl */ `
          vec4 mvPosition = vec4( transformed, 1.0 );
          #ifdef USE_INSTANCING
            mvPosition = instanceMatrix * mvPosition;
            vec3 rootW = ( instanceMatrix * vec4( 0.0, 0.0, 0.0, 1.0 ) ).xyz;
          #else
            vec3 rootW = vec3( 0.0 );
          #endif
          float bladeH = clamp( position.y, 0.0, 1.0 );
          float bend = bladeH * bladeH;
          float w1 = sin( uTime * 1.7 + rootW.x * 0.9 + rootW.z * 0.6 );
          float w2 = sin( uTime * 2.9 + rootW.x * 1.7 - rootW.z * 1.3 );
          vec2 sway = vec2( w1 * 0.07 + w2 * 0.03, w2 * 0.045 );
          for ( int i = 0; i < 8; i ++ ) {
            vec4 pusher = uPushers[ i ];
            vec2 away = rootW.xz - pusher.xy;
            float dist = length( away );
            float f = ( 1.0 - smoothstep( 0.0, pusher.z, dist ) ) * pusher.w;
            sway += ( away / max( dist, 0.001 ) ) * f * 0.5;
          }
          mvPosition.xz += sway * bend;
          mvPosition.y -= length( sway ) * bend * 0.4;
          vBladeH = bladeH;
          vBladeWorld = mvPosition.xyz;
          mvPosition = modelViewMatrix * mvPosition;
          gl_Position = projectionMatrix * mvPosition;`;

// oxlint-disable-next-line no-inline-comments -- the /* glsl */ tag must sit on the template line for editor shader highlighting
const GRASS_FRAG_HEAD = /* glsl */ `#include <common>
uniform vec4 uReveal;
varying float vBladeH;
varying vec3 vBladeWorld;`;

// oxlint-disable-next-line no-inline-comments -- the /* glsl */ tag must sit on the template line for editor shader highlighting
const GRASS_FRAG_COLOR = /* glsl */ `#include <color_fragment>
          // dark roots, bright tips: fake occlusion + translucency
          diffuseColor.rgb *= mix( 0.4, 1.3, vBladeH );
          if ( uReveal.w > 0.5 ) {
            // screen-door fade so you can see your own brawler while hiding
            float fade = smoothstep( 0.55, 1.55, distance( vBladeWorld.xz, uReveal.xy ) );
            float n = fract( 52.9829189 * fract( dot( gl_FragCoord.xy, vec2( 0.06711056, 0.00583715 ) ) ) );
            if ( n > mix( 0.3, 1.01, fade ) ) discard;
          }`;

/** A single blade: a squashed cone whose tip curls over with height. */
export const buildBladeGeometry = (): THREE.BufferGeometry => {
  const geometry = new THREE.ConeGeometry(0.2, 1, 5, 3);
  geometry.translate(0, 0.5, 0);
  const { position } = geometry.attributes;
  if (position) {
    for (let i = 0; i < position.count; i += 1) {
      const y = position.getY(i);
      position.setX(i, position.getX(i) + y * y * 0.2);
      position.setZ(i, position.getZ(i) * 0.5);
    }
  }
  geometry.computeVertexNormals();
  return geometry;
};

export const makeGrassMaterial = (uniforms: GrassUniforms): THREE.MeshStandardMaterial => {
  const material = new THREE.MeshStandardMaterial({
    color: 0xff_ff_ff,
    metalness: 0,
    roughness: 0.78,
  });
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", GRASS_VERT_HEAD)
      .replace("#include <project_vertex>", GRASS_VERT_PROJECT);
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", GRASS_FRAG_HEAD)
      .replace("#include <color_fragment>", GRASS_FRAG_COLOR);
  };
  return material;
};

export const collectBushTiles = (tiles: Uint8Array): TileCoord[] => {
  const bushes: TileCoord[] = [];
  for (let y = 0; y < GRID; y += 1) {
    for (let x = 0; x < GRID; x += 1) {
      if (tiles[gridIndex(x, y)] === TILE.BUSH) {
        bushes.push([x, y]);
      }
    }
  }
  return bushes;
};

/**
 * Fills `mesh` with blades for every bush tile and records each tile's
 * `[firstInstance, count]` pair in `bushRange` so a bush can be cleared later.
 */
export const populateBushes = (
  mesh: THREE.InstancedMesh,
  bushes: TileCoord[],
  bushRange: Int32Array,
  rng: () => number,
): void => {
  let cursor = 0;
  for (const [tx, ty] of bushes) {
    bushRange[gridIndex(tx, ty) * 2] = cursor;
    bushRange[gridIndex(tx, ty) * 2 + 1] = BLADES_PER_BUSH;
    for (let blade = 0; blade < BLADES_PER_BUSH; blade += 1) {
      const u = blade < 9 ? (blade % 3) / 3 + 1 / 6 : rng();
      const v = blade < 9 ? Math.floor(blade / 3) / 3 + 1 / 6 : rng();
      const x = tx - GRID_HALF + u + (rng() - 0.5) * 0.22;
      const z = ty - GRID_HALF + v + (rng() - 0.5) * 0.22;
      const size = 0.85 + rng() * 0.5;
      SCRATCH_EULER.set((rng() - 0.5) * 0.3, rng() * 6.28, (rng() - 0.5) * 0.3);
      SCRATCH_QUATERNION.setFromEuler(SCRATCH_EULER);
      SCRATCH_MATRIX.compose(
        SCRATCH_POSITION.set(x, -0.03, z),
        SCRATCH_QUATERNION,
        SCRATCH_SCALE.set(size * 1.15, size * (0.95 + rng() * 0.35), size * 1.15),
      );
      mesh.setMatrixAt(cursor, SCRATCH_MATRIX);
      SCRATCH_COLOR.setHSL(0.27 + rng() * 0.06, 0.55 + rng() * 0.15, 0.36 + rng() * 0.1);
      mesh.setColorAt(cursor, SCRATCH_COLOR);
      cursor += 1;
    }
  }
  mesh.frustumCulled = false;
};
