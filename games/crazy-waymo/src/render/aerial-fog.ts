import * as THREE from "three";

import { MARINE_COLOR_GLSL, MARINE_GLSL } from "./marine-profile";

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
// Height-attenuated aerial haze preserves the distant hill silhouettes. The
// marine bank integrates coastal density along the viewing ray, so an object
// beyond the bank still fades through it. Its low lid lets hilltops emerge.

// --- Height grading -------------------------------------------------------
// Haze is full strength below HAZE_BASE and e-folds away over HAZE_SCALE above
// it: Nob Hill's crest (~43u) keeps about a third, Twin Peaks (~110u) a tenth.
// The scale was 34 and the amount 0.86 until the vista pass — from the Twin
// Peaks summit that still left ~0.30 of linear fog on downtown at 1400u, which
// tone-maps to a white ghost. Both knobs are gated on ALTITUDE (the camera's
// and the fragment's), so tightening them cannot touch the chase-cam grade:
// at y < HAZE_BASE both terms are 1 and the base fog passes through untouched.
// Exported because the long-range landmark silhouette (render/far-terrain.ts)
// is drawn by a shader of its own and has to age into the distance on exactly
// this curve — a stand-in graded on a second set of numbers announces itself
// the moment the real geometry hands over.
export const HAZE_BASE = 18;
export const HAZE_SCALE = 26;
// Never let the attenuation go all the way to zero — a razor-sharp 1.5km
// ridgeline reads as a cardboard cut-out. 0.95 left a 5% floor, which is close
// enough to nothing that every elevated view had NO depth cue at all: the far
// city sat at the same value and the same chroma as the near city and the
// vistas read flat. Now that the fog color is a saturated blue rather than a
// near-white (see day-night.ts), a 18% floor TINTS the distance instead of
// ghosting it, which is the aerial perspective those views were missing.
export const HAZE_AMOUNT = 0.82;

// --- Dual-rate mix (the painter's aerial perspective) ---------------------
// A surface loses its HUE before it loses its VALUE: chroma converges onto the
// haze FOG_CHROMA_RATE times faster than the plain fog lerp converges
// brightness. A single-rate lerp keeps a far facade reading as saturated
// cardboard right up until it vanishes; with the drain, a distant ridge is
// mostly desaturated while still holding its value step, so the silhouette
// ladder survives. The caps are the residuals: FOG_MAX leaves 8% of the
// surface in the mix so backdrop planes never fuse into one sheet, and
// FOG_CHROMA_MAX leaves a whisper of the surface's own hue at full drain.
const FOG_CHROMA_RATE = 1.85;
const FOG_CHROMA_MAX = 0.96;
const FOG_MAX = 0.92;

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

	${MARINE_GLSL}
	${MARINE_COLOR_GLSL}

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

	// Marine scattering already drains hue when it blends onto neutral fog.
	// Applying the aerial chroma multiplier to it again erased bridge orange.
	float chromaFog = min(fogFactor * ${f(FOG_CHROMA_RATE)}, ${f(FOG_CHROMA_MAX)});
	float marineFog = 0.0;
	#ifdef FOG_EXP2
		marineFog = sfMarineOpacity(cameraPosition, vFogWorld);
	#else
		// The editor's deliberately distant fog plane means clear inspection.
		if (fogNear < 2000.0) marineFog = sfMarineOpacity(cameraPosition, vFogWorld);
	#endif
	// The ray's accumulated bank also controls its tint. An inland surface
	// seen through the bank must converge on the same color as the horizon.
	vec3 hazeColor = mix(fogColor, sfMarineColor(fogColor), smoothstep(0.0, 0.6, marineFog));
	fogFactor = min(fogFactor + marineFog * (1.0 - fogFactor), ${f(FOG_MAX)});

	// Dual-rate mix (see FOG_CHROMA_RATE): first rotate the fragment onto the
	// haze's chromaticity at its OWN luminance, then converge value at the
	// base rate — hue drains faster than brightness at every distance.
	float hazeLum = max( dot( hazeColor, vec3( 0.2126, 0.7152, 0.0722 ) ), 1e-4 );
	vec3 drained = hazeColor * ( dot( gl_FragColor.rgb, vec3( 0.2126, 0.7152, 0.0722 ) ) / hazeLum );
	gl_FragColor.rgb = mix( mix( gl_FragColor.rgb, drained, chromaFog ), hazeColor, fogFactor );

#endif
`;
}
