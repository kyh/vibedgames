import * as THREE from "three";

const TOON_EDGE = 0.08;
const TOON_SOFT = 0.06;
const TOON_FLOOR = 0.3;
const TOON_MIX = 0.85;
const TOON_FADE_LO = 0.1;
const TOON_FADE_HI = 0.3;
const TOON_VIBRANCE = 0.42;
const TOON_LIFT = 1.06;

const MARKER = "/* toon-pass */";

const f = (n: number) => n.toFixed(4);

const TOON_PARS = `${MARKER}
float toonSun = 0.0;
vec3 toonUnshadowed = vec3( 0.0 );
// Diffuse irradiance for one direct light. The shade floor is taken from the
// light BEFORE its shadow multiply and only the lit step above it from the
// shadowed light, so a cast shadow and an away-facing side land on the SAME
// band (two tones, not three), inside the shadow frustum and outside it.
vec3 toonDiffuseIrradiance( const in vec3 n, const in vec3 l, const in vec3 shadowed ) {
	float nl = dot( n, l );
	vec3 lambert = saturate( nl ) * shadowed;
	if ( toonSun < 0.5 ) return lambert;
	float lit = smoothstep( ${f(TOON_EDGE - TOON_SOFT)}, ${f(TOON_EDGE + TOON_SOFT)}, nl );
	vec3 band = ${f(TOON_FLOOR)} * toonUnshadowed + ( 1.0 - ${f(TOON_FLOOR)} ) * lit * shadowed;
	vec3 upView = normalize( ( viewMatrix * vec4( 0.0, 1.0, 0.0, 0.0 ) ).xyz );
	float fade = smoothstep( ${f(TOON_FADE_LO)}, ${f(TOON_FADE_HI)}, dot( l, upView ) );
	return mix( lambert, band, ${f(TOON_MIX)} * fade );
}
vec3 toonAlbedo( const in vec3 c ) {
	float hi = max( c.r, max( c.g, c.b ) );
	float lo = min( c.r, min( c.g, c.b ) );
	float chroma = hi > 1e-4 ? ( hi - lo ) / hi : 0.0;
	float l = dot( c, vec3( 0.2126, 0.7152, 0.0722 ) );
	vec3 v = mix( vec3( l ), c, 1.0 + ${f(TOON_VIBRANCE)} * ( 1.0 - chroma ) );
	return max( v, 0.0 ) * ${f(TOON_LIFT)};
}
`;

const DIRECT_SIG = "void RE_Direct_Physical(";

const DIFFUSE_LINE =
  "reflectedLight.directDiffuse += irradiance * BRDF_Lambert( material.diffuseContribution ) * ( 1.0 - F );";

const TOON_DIFFUSE_LINE =
  "reflectedLight.directDiffuse += toonDiffuseIrradiance( geometryNormal, directLight.direction, directLight.color ) * BRDF_Lambert( material.diffuseContribution ) * ( 1.0 - F );";

const DIR_LOOP = "#if ( NUM_DIR_LIGHTS > 0 ) && defined( RE_Direct )";
const DIR_INFO = "getDirectionalLightInfo( directionalLight, directLight );";
const LOOP_END = "#pragma unroll_loop_end";
const STD = (glsl: string) => `\n\t#ifdef STANDARD\n\t${glsl}\n\t#endif`;

const CUSTOM_TONE_STUB = "vec3 CustomToneMapping( vec3 color ) { return color; }";

const TOON_TONE_MAPPING = `vec3 CustomToneMapping( vec3 color ) {
	vec3 c = ACESFilmicToneMapping( color );
	float l = dot( c, vec3( 0.2126, 0.7152, 0.0722 ) );
	c = mix( vec3( l ), c, 1.12 );
	c *= mix( vec3( 1.0 ), vec3( 0.95, 0.94, 1.07 ), ( 1.0 - smoothstep( 0.0, 0.5, l ) ) * 0.6 );
	c *= mix( vec3( 1.0 ), vec3( 1.05, 1.01, 0.93 ), smoothstep( 0.45, 1.0, l ) * 0.5 );
	return clamp( c, 0.0, 1.0 );
}`;

const patchPars = (src: string) => {
  const at = src.indexOf(DIRECT_SIG);
  const diffuse = at === -1 ? -1 : src.indexOf(DIFFUSE_LINE, at);

  if (diffuse === -1) {
    return null;
  }

  return `${src.slice(0, at)}${TOON_PARS}${src.slice(at, diffuse)}${TOON_DIFFUSE_LINE}${src.slice(diffuse + DIFFUSE_LINE.length)}`;
};

const patchBegin = (src: string) => {
  const loop = src.indexOf(DIR_LOOP);
  const info = loop === -1 ? -1 : src.indexOf(DIR_INFO, loop);
  const end = info === -1 ? -1 : src.indexOf(LOOP_END, info);

  if (end === -1) {
    return null;
  }

  const open = loop + DIR_LOOP.length;
  const afterInfo = info + DIR_INFO.length;
  const close = end + LOOP_END.length;

  return [
    src.slice(0, open),
    STD("toonSun = 1.0;"),
    src.slice(open, afterInfo),
    STD("toonUnshadowed = directLight.color;"),
    src.slice(afterInfo, close),
    STD("toonSun = 0.0;"),
    src.slice(close),
  ].join("");
};

export const installToonShading = () => {
  const chunks = THREE.ShaderChunk;

  if (chunks.lights_physical_pars_fragment.includes(MARKER)) {
    return;
  }

  const pars = patchPars(chunks.lights_physical_pars_fragment);
  const begin = patchBegin(chunks.lights_fragment_begin);

  if (pars === null || begin === null) {
    console.warn("[toon] three's lighting chunks changed shape — toon pass not installed");

    return;
  }

  chunks.tonemapping_pars_fragment = chunks.tonemapping_pars_fragment.replace(
    CUSTOM_TONE_STUB,
    TOON_TONE_MAPPING,
  );
  chunks.lights_physical_pars_fragment = pars;
  chunks.lights_fragment_begin = begin;
  chunks.lights_physical_fragment = `diffuseColor.rgb = toonAlbedo( diffuseColor.rgb );\n${chunks.lights_physical_fragment}`;
};
