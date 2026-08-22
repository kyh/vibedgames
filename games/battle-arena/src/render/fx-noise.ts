// Shared GLSL noise chunk for the procedural spell materials (ice, bolt, beam,
// fissures). Injected as a string so every material compiles against the same
// source and the driver's shader cache gets a hit instead of a recompile.
//
// `snoise` is Ashima Arts / Stefan Gustavson simplex noise (MIT). The library
// shape and the ridged/fbm helpers come from the Elemental Sandbox VFX sandbox
// (MIT, Copyright (c) 2026 mohamedachrefelouafi) —
// https://github.com/achrefelouafi/LinearAbiltyCastingThreeJS
//
// `fbm2` is ours: two octaves instead of three or four. The toon grade wants
// broad flat masses, and the extra octaves only add high-frequency grain that
// the bloom pass then smears into mush at our camera distance.
export const NOISE_GLSL = /* glsl */ `
#ifndef VG_NOISE_INCLUDED
#define VG_NOISE_INCLUDED

vec3 vgMod289v3(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 vgMod289v4(vec4 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 vgPermute(vec4 x) { return vgMod289v4(((x * 34.0) + 1.0) * x); }
vec4 vgTaylorInvSqrt(vec4 r) { return 1.79284291400159 - 0.85373472095314 * r; }

float nhash11(float p) {
  p = fract(p * 0.1031);
  p *= p + 33.33;
  p *= p + p;
  return fract(p);
}

float nhash13(vec3 p3) {
  p3 = fract(p3 * 0.1031);
  p3 += dot(p3, p3.zyx + 31.32);
  return fract((p3.x + p3.y) * p3.z);
}

float snoise(vec3 v) {
  const vec2 C = vec2(1.0 / 6.0, 1.0 / 3.0);
  const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);

  vec3 i  = floor(v + dot(v, C.yyy));
  vec3 x0 = v - i + dot(i, C.xxx);

  vec3 g = step(x0.yzx, x0.xyz);
  vec3 l = 1.0 - g;
  vec3 i1 = min(g.xyz, l.zxy);
  vec3 i2 = max(g.xyz, l.zxy);

  vec3 x1 = x0 - i1 + C.xxx;
  vec3 x2 = x0 - i2 + C.yyy;
  vec3 x3 = x0 - D.yyy;

  i = vgMod289v3(i);
  vec4 p = vgPermute(vgPermute(vgPermute(
             i.z + vec4(0.0, i1.z, i2.z, 1.0))
           + i.y + vec4(0.0, i1.y, i2.y, 1.0))
           + i.x + vec4(0.0, i1.x, i2.x, 1.0));

  float n_ = 0.142857142857;
  vec3 ns = n_ * D.wyz - D.xzx;

  vec4 j = p - 49.0 * floor(p * ns.z * ns.z);

  vec4 x_ = floor(j * ns.z);
  vec4 y_ = floor(j - 7.0 * x_);

  vec4 x = x_ * ns.x + ns.yyyy;
  vec4 y = y_ * ns.x + ns.yyyy;
  vec4 h = 1.0 - abs(x) - abs(y);

  vec4 b0 = vec4(x.xy, y.xy);
  vec4 b1 = vec4(x.zw, y.zw);

  vec4 s0 = floor(b0) * 2.0 + 1.0;
  vec4 s1 = floor(b1) * 2.0 + 1.0;
  vec4 sh = -step(h, vec4(0.0));

  vec4 a0 = b0.xzyw + s0.xzyw * sh.xxyy;
  vec4 a1 = b1.xzyw + s1.xzyw * sh.zzww;

  vec3 p0 = vec3(a0.xy, h.x);
  vec3 p1 = vec3(a0.zw, h.y);
  vec3 p2 = vec3(a1.xy, h.z);
  vec3 p3 = vec3(a1.zw, h.w);

  vec4 norm = vgTaylorInvSqrt(vec4(dot(p0, p0), dot(p1, p1), dot(p2, p2), dot(p3, p3)));
  p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;

  vec4 m = max(0.6 - vec4(dot(x0, x0), dot(x1, x1), dot(x2, x2), dot(x3, x3)), 0.0);
  m = m * m;
  return 42.0 * dot(m * m, vec4(dot(p0, x0), dot(p1, x1), dot(p2, x2), dot(p3, x3)));
}

/** Two octaves — the toon default. Broad masses, no grain. */
float fbm2(vec3 p) {
  return 0.65 * snoise(p) + 0.35 * snoise(p * 2.03 + vec3(17.3, 5.1, 9.7));
}

/** Ridged multifractal — sharp filaments; cracks, seams, arcs. */
float ridged(vec3 p) {
  float v = 0.0;
  float a = 0.5;
  for (int i = 0; i < 3; i++) {
    v += a * (1.0 - abs(snoise(p)));
    p *= 2.06;
    a *= 0.5;
  }
  return v;
}

/**
 * Zero-crossing sheet of an fbm field: a thin, branching, forked line — what a
 * real fracture looks like. Drives lava seams and ice cracks alike.
 */
float seam(vec3 p, float width) {
  return 1.0 - smoothstep(0.0, width, abs(fbm2(p)));
}

/**
 * Posterise to N bands. The toon grade's workhorse: it turns a smooth shader
 * gradient into the flat stepped masses the KayKit models are lit with, so the
 * spell FX and the characters read as the same material world.
 */
float bands(float x, float n) {
  // The top bucket has to be clamped: at x == 1 the floor lands on n, and the
  // result leaves 0..1 (4/3 at n = 4). Callers use this as a mix factor and as
  // a brightness multiplier, so overshoot shows up as blown-out facets.
  return min(floor(clamp(x, 0.0, 1.0) * n), n - 1.0) / max(n - 1.0, 1.0);
}

#endif
`;
