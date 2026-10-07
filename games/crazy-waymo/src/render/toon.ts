import * as THREE from "three";

// TOON PASS (2026-10): the cel-shaded "toy city" look. Two global edits to
// three's physical lighting chunks, so every MeshStandardMaterial in the game
// — kit GLBs, baked parcels, roads, landmarks, cars, the shader-patched
// terrain and facades that still include these chunks — picks it up with no
// per-material work and NO world rebake (albedo stays as baked; the pop
// happens at shade time).
//
// 1. Banded sun: the direct term's N·L goes through a soft two-band ramp —
//    a crisp terminator into a flat lit plateau, with a sliver of Lambert left
//    in so a round thing (tree blob, car roof) still reads round. Shadows are
//    multiplied into directLight.color before this runs, so cast shadows stay
//    exactly where they were; only the shading on the form changes.
// 2. Candy albedo: a vibrance push on the material's own colour before any
//    light touches it — strongest on the drab, near-grey albedos (concrete,
//    stucco, asphalt) and gentlest on already-loud paint, so the city reads
//    like painted toys without the saturated stuff going neon. Doing it here
//    instead of in post means the sky, fog and emissives keep their own
//    chroma.
//
// Idempotent; like installAerialFog it must run before the first program
// compiles (chunks are resolved at compile time), so GameScene installs it
// as one of its first construction steps.

// Ramp: terminator centre and half-width in N·L, and how much of the hard
// band replaces Lambert (1 = pure two-tone).
const TOON_EDGE = 0.1;
const TOON_SOFT = 0.07;
const TOON_MIX = 0.82;
// Albedo vibrance: saturation gain at zero chroma, falling to none at full.
const TOON_VIBRANCE = 0.42;
// Pastel lift: a small brighten so pushed colours land candy, not muddy.
const TOON_LIFT = 1.06;

const f = (n: number): string => n.toFixed(4);

// oxlint-disable-next-line no-inline-comments -- the /* glsl */ tag must sit on the template line for editor shader highlighting
const TOON_PARS = /* glsl */ `
float toonRamp( const in float nl ) {
	float band = smoothstep( ${f(TOON_EDGE - TOON_SOFT)}, ${f(TOON_EDGE + TOON_SOFT)}, nl );
	return mix( nl, band, ${f(TOON_MIX)} );
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
const DIRECT_NL = "float dotNL = saturate( dot( geometryNormal, directLight.direction ) );";

let installed = false;

const patchDirect = (src: string): string => {
  const at = src.indexOf(DIRECT_SIG);
  const nl = at === -1 ? -1 : src.indexOf(DIRECT_NL, at);
  if (nl === -1) {
    // three moved the chunk: fail soft to stock shading, loudly in dev.
    console.warn("[toon] RE_Direct_Physical shape changed — toon ramp not installed");
    return src;
  }
  const head = src.slice(0, at);
  const body = src.slice(at, nl);
  const tail = src.slice(nl + DIRECT_NL.length);
  return `${head}${TOON_PARS}${body}float dotNL = toonRamp( saturate( dot( geometryNormal, directLight.direction ) ) );${tail}`;
};

export const installToonShading = (): void => {
  if (installed) {
    return;
  }
  installed = true;
  const chunks = THREE.ShaderChunk;
  chunks.lights_physical_pars_fragment = patchDirect(chunks.lights_physical_pars_fragment);
  if (chunks.lights_physical_pars_fragment.includes("toonAlbedo")) {
    chunks.lights_physical_fragment = `diffuseColor.rgb = toonAlbedo( diffuseColor.rgb );\n${chunks.lights_physical_fragment}`;
  }
};
