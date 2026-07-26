import * as THREE from "three";

import { WORLD_H, WORLD_W } from "../shared/constants";

// Aerial perspective + a staged marine layer, installed by REPLACING three's
// four fog ShaderChunks. Every fogged material in the scene — the built-in
// standard materials the city is batched with, the ocean, the custom
// ambient-life shaders — resolves those chunks at program-compile time, so one
// patch re-grades the whole world with no per-material plumbing and no rebake.
//
// Why the chunks and not uniforms: three's renderer only feeds `fogColor`,
// `fogNear` and `fogFar` through to a material's fog uniforms. Any extra
// uniform we declared would read 0 on every built-in material. The layer
// geometry is fixed world data (SF does not move), so it bakes into the shader
// as constants and costs nothing to feed.
//
// Two effects, both driven off the fragment's WORLD position:
//
//  1. HEIGHT-ATTENUATED HAZE. Flat distance fog put every SF hill above ~30u
//     beyond the fog-far plane: the ridgeline dissolved from the districts that
//     should see it, and from the Twin Peaks summit the city below was 100%
//     haze. Real haze pools in the low air, so the attenuation is the geometric
//     mean of the density at the fragment and at the camera — both low (driving
//     downtown) keeps today's grading exactly, one of them high (a summit, a
//     ridgeline against the sky) thins it to a readable veil.
//
//  2. THE GOLDEN GATE MARINE LAYER. Karl pours through the strait and sits over
//     Ocean Beach and the Sunset; the rest of the city can be clear. A pair of
//     ellipses over the Gate and the north-shore bay spill, plus a band down the
//     western shore, add fog on top of the base grade — and because the volume
//     has a TOP, cresting a hill lifts you clear of it and you look down on the
//     bank instead of driving through it.

// --- Height grading -------------------------------------------------------
// Haze is full strength below HAZE_BASE and e-folds away over HAZE_SCALE above
// it: Nob Hill's crest (~43u) keeps about half, Twin Peaks (~106u) almost none.
const HAZE_BASE = 18;
const HAZE_SCALE = 34;
// Never let the attenuation go all the way to zero — a razor-sharp 1.5km
// ridgeline reads as a cardboard cut-out.
const HAZE_AMOUNT = 0.86;

// --- Marine layer ---------------------------------------------------------
const MARINE_TOP = 40; // world height the bank thins out at
const MARINE_SOFT = 20; // vertical softness of that top edge
const MARINE_STRENGTH = 0.58; // most fog the bank can add over the base grade
const MARINE_NEAR = 30; // it never fogs the car's own bumper
const MARINE_FAR = 420;

const toX = (u: number): number => (u - 0.5) * WORLD_W;
const toZ = (v: number): number => (v - 0.5) * WORLD_H;

// The strait itself (runs east-west under the bridge) and the spill east along
// the north shore into the bay. Ellipse half-axes in world units.
const GATE_X = toX(0.27);
const GATE_Z = toZ(0.035);
const GATE_RX = 540;
const GATE_RZ = 300;
const BAY_X = toX(0.47);
const BAY_Z = toZ(0.055);
const BAY_RX = 640;
const BAY_RZ = 260;
// Ocean Beach / the Sunset: full bank at the surf line, gone by the ridge.
const WEST_FULL_X = toX(0.1);
const WEST_NONE_X = toX(0.32);
// The Sunset gets the tail of the bank, not the heart of it — the Gate is the
// star, and burying half the map in white costs more than it buys.
const WEST_WEIGHT = 0.55;

const f = (n: number): string => n.toFixed(2);

let installed = false;

/**
 * Replace three's fog chunks with the aerial-perspective versions. Idempotent,
 * and must run before the first program compiles (the chunks are resolved
 * then) — GameScene calls it as its first construction step.
 */
export function installAerialFog(): void {
  if (installed) return;
  installed = true;

  // World position without a modelMatrix: the view transform is rigid, so the
  // camera-space position rotates back with the transpose of its rotation.
  // Doing it this way means batched, instanced and skinned meshes all work —
  // `mvPosition` is already in scope wherever three includes <fog_vertex>.
  THREE.ShaderChunk.fog_vertex = /* glsl */ `
#ifdef USE_FOG
	vFogDepth = - mvPosition.z;
	vFogWorld = cameraPosition + mvPosition.xyz * mat3( viewMatrix );
	vFogCamHaze = exp( - max( 0.0, cameraPosition.y - ${f(HAZE_BASE)} ) / ${f(HAZE_SCALE)} );
#endif
`;

  THREE.ShaderChunk.fog_pars_vertex = /* glsl */ `
#ifdef USE_FOG
	varying float vFogDepth;
	varying vec3 vFogWorld;
	varying float vFogCamHaze;
#endif
`;

  THREE.ShaderChunk.fog_pars_fragment = /* glsl */ `
#ifdef USE_FOG

	uniform vec3 fogColor;
	varying float vFogDepth;
	varying vec3 vFogWorld;
	varying float vFogCamHaze;

	#ifdef FOG_EXP2
		uniform float fogDensity;
	#else
		uniform float fogNear;
		uniform float fogFar;
	#endif

	// 1 inside an ellipse, 0 outside, smooth across the rim.
	float sfEllipse( vec2 p, vec2 c, vec2 r ) {
		return 1.0 - smoothstep( 0.55, 1.0, length( ( p - c ) / r ) );
	}

	// How much marine layer sits at this world point: a vertical slab capped at
	// MARINE_TOP, intersected with the Gate / bay / western-shore footprint.
	float sfMarine( vec3 w ) {
		float lid = 1.0 - smoothstep( ${f(MARINE_TOP - MARINE_SOFT)}, ${f(MARINE_TOP)}, w.y );
		float gate = sfEllipse( w.xz, vec2( ${f(GATE_X)}, ${f(GATE_Z)} ), vec2( ${f(GATE_RX)}, ${f(GATE_RZ)} ) );
		float bay = sfEllipse( w.xz, vec2( ${f(BAY_X)}, ${f(BAY_Z)} ), vec2( ${f(BAY_RX)}, ${f(BAY_RZ)} ) );
		float west = ( 1.0 - smoothstep( ${f(WEST_FULL_X)}, ${f(WEST_NONE_X)}, w.x ) ) * ${f(WEST_WEIGHT)};
		return lid * max( max( gate, bay ), west );
	}

#endif
`;

  THREE.ShaderChunk.fog_fragment = /* glsl */ `
#ifdef USE_FOG

	#ifdef FOG_EXP2
		float fogFactor = 1.0 - exp( - fogDensity * fogDensity * vFogDepth * vFogDepth );
	#else
		float fogFactor = smoothstep( fogNear, fogFar, vFogDepth );
	#endif

	// Aerial perspective: the haze a ray collects is set by the air it crossed,
	// so weight the base grade by the density at BOTH ends of it.
	float fragHaze = exp( - max( 0.0, vFogWorld.y - ${f(HAZE_BASE)} ) / ${f(HAZE_SCALE)} );
	fogFactor *= mix( 1.0, sqrt( fragHaze * vFogCamHaze ), ${f(HAZE_AMOUNT)} );

	float marine = sfMarine( vFogWorld );
	float marineFog = marine * ${f(MARINE_STRENGTH)}
		* smoothstep( ${f(MARINE_NEAR)}, ${f(MARINE_FAR)}, vFogDepth );
	// Karl is whiter than the ambient haze, but only as bright as the hour
	// allows — scaled by the day's fog color so night stays night.
	float lit = max( fogColor.r, max( fogColor.g, fogColor.b ) );
	vec3 marineColor = vec3( 0.93, 0.95, 0.97 ) * ( 0.22 + 0.78 * lit );
	vec3 hazeColor = mix( fogColor, marineColor, marine * 0.85 );

	fogFactor = clamp( fogFactor + marineFog * ( 1.0 - fogFactor ), 0.0, 1.0 );
	gl_FragColor.rgb = mix( gl_FragColor.rgb, hazeColor, fogFactor );

#endif
`;
}
