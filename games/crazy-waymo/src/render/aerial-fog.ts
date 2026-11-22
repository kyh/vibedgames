import * as THREE from "three";

import { MARINE_COLOR_GLSL, MARINE_GLSL } from "./marine-profile";

export const HAZE_BASE = 18;
export const HAZE_SCALE = 26;
export const HAZE_AMOUNT = 0.82;

const FOG_CHROMA_RATE = 1.4;
const FOG_CHROMA_MAX = 0.96;
const FOG_MAX = 0.92;

const f = (n: number) => n.toFixed(2);

let installed = false;

/**
 * Replace three's fog chunks with the aerial-perspective versions. Idempotent,
 * and must run before the first program compiles (the chunks are resolved
 * then) — GameScene calls it as its first construction step.
 */
export const installAerialFog = () => {
  if (installed) {
    return;
  }

  installed = true;

  THREE.ShaderChunk.fog_vertex = `
#ifdef USE_FOG
	vFogDepth = - mvPosition.z;
	vFogWorld = cameraPosition + mvPosition.xyz * mat3( viewMatrix );
	vFogCamHaze = exp( - max( 0.0, cameraPosition.y - ${f(HAZE_BASE)} ) / ${f(HAZE_SCALE)} );
#endif
`;

  THREE.ShaderChunk.fog_pars_vertex = `
#ifdef USE_FOG
	varying float vFogDepth;
	varying vec3 vFogWorld;
	varying float vFogCamHaze;
#endif
`;

  THREE.ShaderChunk.fog_pars_fragment = `
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

  THREE.ShaderChunk.fog_fragment = `
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
};
