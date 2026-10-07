import * as THREE from "three";

// TOON PASS (2026-10): the cel-shaded "toy city" look. Global edits to
// three's physical lighting chunks, so every MeshStandardMaterial in the game
// — kit GLBs, baked parcels, roads, landmarks, cars, the shader-patched
// terrain and facades that still include these chunks — picks it up with no
// per-material work and NO world rebake (albedo stays as baked; the pop
// happens at shade time).
//
// 1. Banded sun, DIFFUSE ONLY. The sun's diffuse N·L goes through a soft
//    two-band ramp: a crisp terminator, a flat lit plateau, and a lifted
//    shade band (TOON_FLOOR of the key, the way a toon gradient map's dark
//    texel works) so the form-shade side keeps its chroma instead of falling
//    to the cold fill alone. The floor reads the UNSHADOWED key, so cast
//    shadows sit on the same band as form shade. Specular keeps the true N·L — banding it boosted
//    the GGX lobe by ~1/N·L at the terminator into fireflies.
// 2. Sun only. lights_fragment_begin raises a flag around the directional
//    loop; point and spot lamps keep their physical falloff (a banded lamp
//    pool is a flat cream slab).
// 3. Low-sun fade. At dawn/dusk the key grazes the ground (N·L ≈ 0.07 on
//    flat road), right inside the ramp's steep middle, where it amplifies
//    every terrain and peel normal into blotches. The ramp fades out between
//    TOON_FADE_LO and TOON_FADE_HI of sun elevation (sine), so golden hour
//    and sunset keep stock Lambert.
// 4. Candy albedo: a vibrance push on the material's own colour before any
//    light touches it — strongest on the drab, near-grey albedos (concrete,
//    stucco) and gentlest on already-loud paint. Doing it here instead of in
//    post means the sky, fog and emissives keep their own chroma, and phones
//    (no post chain) get it too.
//
// Cast shadows stay exactly where they were: the lit step uses the shadowed
// light, the floor the unshadowed one (captured right after
// getDirectionalLightInfo, before the shadow multiply).
//
// Idempotent — guarded on a marker IN the chunk, so a hot reload that resets
// this module cannot stack a second patch on the already-patched chunks. Like
// installAerialFog it must run before the first program compiles, so
// GameScene installs it as one of its first construction steps.

// Ramp: terminator centre and half-width in N·L, the shade band as a fraction
// of the key, and how much of the hard band replaces Lambert.
const TOON_EDGE = 0.08;
const TOON_SOFT = 0.06;
const TOON_FLOOR = 0.3;
const TOON_MIX = 0.85;
// Sun elevation (sine) over which the ramp fades in: ~6° to ~17°.
const TOON_FADE_LO = 0.1;
const TOON_FADE_HI = 0.3;
// Albedo vibrance: saturation gain at zero chroma, falling to none at full.
const TOON_VIBRANCE = 0.42;
// Pastel lift: a small brighten so pushed colours land candy, not muddy.
const TOON_LIFT = 1.06;

const MARKER = "/* toon-pass */";

const f = (n: number): string => n.toFixed(4);

// oxlint-disable-next-line no-inline-comments -- the /* glsl */ tag must sit on the template line for editor shader highlighting
const TOON_PARS = /* glsl */ `${MARKER}
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
// lights_fragment_begin is shared with the Lambert/Phong/Toon programs, which
// never include the physical pars that declare the toon globals — every write
// is fenced to the standard/physical programs.
const STD = (glsl: string): string => `\n\t#ifdef STANDARD\n\t${glsl}\n\t#endif`;

// PHONE GRADE. Phones skip the post chain (render/post.ts), so they never got
// the grade's saturation or its violet-shadow / warm-highlight split. Three's
// CustomToneMapping hook runs at the end of every material's fragment, so
// main.ts selects it on the no-composer path and the phone frame gets ACES
// (bit-for-bit three's) plus a mild version of the same look — no extra pass,
// no extra bandwidth. The desktop composer renders to float targets, where
// three never applies material tone mapping, so this stub stays inert there.
const CUSTOM_TONE_STUB = "vec3 CustomToneMapping( vec3 color ) { return color; }";
// oxlint-disable-next-line no-inline-comments -- the /* glsl */ tag must sit on the template line for editor shader highlighting
const TOON_TONE_MAPPING = /* glsl */ `vec3 CustomToneMapping( vec3 color ) {
	vec3 c = ACESFilmicToneMapping( color );
	float l = dot( c, vec3( 0.2126, 0.7152, 0.0722 ) );
	c = mix( vec3( l ), c, 1.12 );
	c *= mix( vec3( 1.0 ), vec3( 0.95, 0.94, 1.07 ), ( 1.0 - smoothstep( 0.0, 0.5, l ) ) * 0.6 );
	c *= mix( vec3( 1.0 ), vec3( 1.05, 1.01, 0.93 ), smoothstep( 0.45, 1.0, l ) * 0.5 );
	return clamp( c, 0.0, 1.0 );
}`;

// Each patch fails soft to stock shading (loudly) if three moved the chunk.
const patchPars = (src: string): string | null => {
  const at = src.indexOf(DIRECT_SIG);
  const diffuse = at === -1 ? -1 : src.indexOf(DIFFUSE_LINE, at);
  if (diffuse === -1) {
    return null;
  }
  return `${src.slice(0, at)}${TOON_PARS}${src.slice(at, diffuse)}${TOON_DIFFUSE_LINE}${src.slice(diffuse + DIFFUSE_LINE.length)}`;
};

const patchBegin = (src: string): string | null => {
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

export const installToonShading = (): void => {
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
