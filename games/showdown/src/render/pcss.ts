import { ShaderChunk } from "three";
import { LAMP } from "../config";

const PCSS_SHADOW_CHUNK = `

		#define PCSS_SUN_DEPTH_SOFTNESS ${(120 * 0.085 * 0.5).toFixed(4)}
		#define PCSS_SUN_MAX_WORLD ${(0.2).toFixed(4)}
		#define PCSS_LAMP_NEAR ${LAMP.near.toFixed(4)}
		#define PCSS_LAMP_FAR ${LAMP.far.toFixed(4)}
		#define PCSS_LAMP_MAX_UV ${(0.022).toFixed(4)}
		#define PCSS_NOISE_PERIOD ${(64).toFixed(1)}

		float pcssNoise( vec2 p ) {

			return fract( 52.9829189 * fract( dot( p, vec2( 0.06711056, 0.00583715 ) ) ) );

		}

		vec2 pcssDisk( int i, float n, float phi ) {

			float r = sqrt( ( float( i ) + 0.5 ) / n );
			float theta = float( i ) * 2.399963229728653 + phi;
			return vec2( cos( theta ), sin( theta ) ) * r;

		}

		float pcssLinearDepth( float z ) {

			return PCSS_LAMP_NEAR * PCSS_LAMP_FAR / ( PCSS_LAMP_FAR - z * ( PCSS_LAMP_FAR - PCSS_LAMP_NEAR ) );

		}

		float getShadow( sampler2D shadowMap, vec2 shadowMapSize, float shadowIntensity, float shadowBias, float shadowRadius, vec4 shadowCoord ) {

			float shadow = 1.0;

			shadowCoord.xyz /= shadowCoord.w;
			shadowCoord.z += shadowBias;

			bool inFrustum = shadowCoord.x >= 0.0 && shadowCoord.x <= 1.0 && shadowCoord.y >= 0.0 && shadowCoord.y <= 1.0;
			bool frustumTest = inFrustum && shadowCoord.z <= 1.0;

			if ( frustumTest ) {

				float packed = abs( shadowRadius );
				float tier = floor( packed );
				float param = packed - tier;
				bool persp = shadowRadius < 0.0;

				int nSearch = 8 + int( tier ) * 4;
				int nFilter = 10 + int( tier ) * 8;
				float fSearch = float( nSearch );
				float fFilter = float( nFilter );

				float zR = shadowCoord.z;
				float texel = 1.0 / shadowMapSize.x;
				float maxRadius = persp ? PCSS_LAMP_MAX_UV : PCSS_SUN_MAX_WORLD * param * 0.1;
				// Rotate the sample disk per shadow-map texel, not per screen pixel. A
				// screen-space pattern slides over the world whenever the camera pans, and
				// every penumbra shimmers. The pattern repeats every PCSS_NOISE_PERIOD
				// texels and the shadow frustum only ever moves in whole periods (see
				// Lighting.fitShadow), so the grain stays glued to the ground.
				vec2 grainCell = mod( floor( shadowCoord.xy * shadowMapSize ), PCSS_NOISE_PERIOD );
				float phi = pcssNoise( grainCell ) * 6.28318530718;

				// 1. blocker search: average depth of whatever sits between us and the light

				float blockerSum = 0.0;
				float blockers = 0.0;

				for ( int i = 0; i < 20; i ++ ) {

					if ( i >= nSearch ) break;
					float d = textureLod( shadowMap, shadowCoord.xy + pcssDisk( i, fSearch, phi ) * maxRadius, 0.0 ).r;
					if ( d < zR ) { blockerSum += d; blockers += 1.0; }

				}

				if ( blockers >= fSearch ) {

					shadow = 0.0; // deep umbra, skip the filter

				} else if ( blockers > 0.5 ) {

					// 2. penumbra width grows with the blocker -> receiver distance

					float zB = blockerSum / blockers;
					float radius;

					if ( persp ) {

						float lR = pcssLinearDepth( zR );
						float lB = pcssLinearDepth( zB );
						radius = ( lR - lB ) / ( lB * lR ) * param;

					} else {

						radius = ( zR - zB ) * PCSS_SUN_DEPTH_SOFTNESS * param * 0.1;

					}

					radius = clamp( radius, texel * 1.25, maxRadius );

					// 3. variable-width percentage-closer filter

					float lit = 0.0;

					for ( int i = 0; i < 34; i ++ ) {

						if ( i >= nFilter ) break;
						lit += step( zR, textureLod( shadowMap, shadowCoord.xy + pcssDisk( i, fFilter, phi + 1.7 ) * radius, 0.0 ).r );

					}

					shadow = lit / fFilter;

				}

			}

			return mix( 1.0, shadow, shadowIntensity );

		}

`;

interface ChunkRange {
  end: number;
  start: number;
}

const VSM_BRANCH = "#elif defined( SHADOWMAP_TYPE_VSM )";
const GET_SHADOW_SIGNATURE = "float getShadow( sampler2D shadowMap";

const findVsmBranch = (source: string) => {
  const branchAt = source.indexOf(VSM_BRANCH);

  if (branchAt === -1) {
    return;
  }

  const DIRECTIVE = /#[ \t]*(?<word>ifdef|ifndef|if|elif|else|endif)\b/gu;
  DIRECTIVE.lastIndex = branchAt + 5;
  let depth = 0;
  let start = -1;
  let match = DIRECTIVE.exec(source);

  while (match !== null) {
    const word = match.groups?.word;

    if (word === "if" || word === "ifdef" || word === "ifndef") {
      depth += 1;
    } else if (word === "endif") {
      if (depth === 0) {
        if (start === -1) {
          return;
        }

        return source.slice(start, match.index).includes(GET_SHADOW_SIGNATURE)
          ? { end: match.index, start }
          : undefined;
      }

      depth -= 1;
    } else if (word === "else" && depth === 0 && start < 0) {
      const lineEnd = source.indexOf("\n", match.index);
      start = lineEnd === -1 ? match.index + match[0].length : lineEnd;
    }

    match = DIRECTIVE.exec(source);
  }

  return;
};

const patchSpotAttenuation = () => {
  const original = "getDistanceAttenuation( lightDistance, spotLight.distance, spotLight.decay )";
  const clamped = `getDistanceAttenuation( max( lightDistance, ${LAMP.nearClamp.toFixed(2)} ), spotLight.distance, spotLight.decay )`;
  const chunk = ShaderChunk.lights_pars_begin;

  if (chunk.includes(original)) {
    ShaderChunk.lights_pars_begin = chunk.replace(original, clamped);
  } else {
    console.warn("[pipeline] spot light chunk changed - lamps keep plain inverse-square falloff");
  }
};

let installed: boolean | undefined;

export const installPcssShadows = () => {
  if (installed !== undefined) {
    return installed;
  }

  patchSpotAttenuation();
  const source = ShaderChunk.shadowmap_pars_fragment;
  const range = findVsmBranch(source);

  if (range) {
    ShaderChunk.shadowmap_pars_fragment = `${source.slice(0, range.start)}\n${PCSS_SHADOW_CHUNK}\n\t${source.slice(range.end)}`;
    installed = true;

    return true;
  }

  console.warn("[pipeline] shadow chunk layout changed - falling back to hardware PCF shadows");
  installed = false;

  return false;
};
