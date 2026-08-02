import * as THREE from "three";

import { isCoarsePointer } from "./quality";

// World-space material breakup + specular AA for the batched city surfaces —
// the kart-racer "three scales per surface" doctrine, ported texture-free.
//
// Runtime-only: one onBeforeCompile injection on the SHARED materials, so it
// covers live AND baked worlds with no rebake and zero extra draw calls. It
// never touches material.color (world-bin round-trips identify road materials
// BY colour — see roads.ts roadCollapseTarget) and never clones a material.
//
// What it adds, per fragment:
//   1. A macro field pair — two decorrelated value-noise fields sampled on a
//      world plane, periods at a non-integer ratio (x0.319) so they never
//      re-phase. Field A drives a warm/cool HUE-ONLY drift (sun-bleached vs
//      unbleached), field B a small value band. Kills the "one flat sheet"
//      read on asphalt and kit facades. Albedo-space multiplication, so every
//      hour of the day-night cycle grades it correctly for free.
//   2. A third decorrelated field cutting roughness — metre-scale sheen
//      variation that a raking sun reads as surface, applied at the SLOW
//      period so the far field never converges on one constant roughness
//      (the uniform-plastic-sheet tell).
//   3. Distance settle: field B fades over settleNear..settleFar so the fine
//      band cannot shimmer at range; the slow fields carry the distance.
//   4. dFdx-variance specular AA + a per-family roughness floor — three's own
//      geometryRoughness term at unit gain is not enough under a low warm sun
//      against a blue zenith (aliased speculars sparkle orange/cyan); the
//      extra gained term plus the floor is what kills the rainbow glitter on
//      distant facades.
//
// Phones render this too (no post composer there), so the coarse-pointer
// build compiles a reduced variant: one macro tap (hue drift) plus floor +
// specAA — same compile-time device-class gate as roads.ts lowDetailSurfaces.
// (The runtime perf-governor tier can't gate a compiled shader; if a runtime
// rung is ever wanted here it needs a uniform driven from main.ts onApply.)
//
// Reference constants ran at exposure 1.05 pinned to golden hour with a
// +-0.30 albedo band; amplitudes below are re-derived for this game's 0.62
// exposure, existing street-paint variety and the "felt, not read" +-10%
// surface doctrine.

export type BreakupConfig = {
  /** Macro field A world period (m) — also the roughness field's period. */
  readonly period: number;
  /** Blend weight of the warm/cool hue-only drift (field A). */
  readonly hueAmp: number;
  /** Value band amplitude (field B, period x MACRO_PERIOD_RATIO); settles out. */
  readonly valueAmp: number;
  /** Roughness cut depth of the decorrelated field (0..amp glossier patches). */
  readonly roughAmp: number;
  /** Per-family hard floor, applied before the specular-AA add. */
  readonly roughFloor: number;
  /** Warm drift endpoint, read as a per-channel RATIO (max channel -> 1). */
  readonly warm: number;
  /** Cool drift endpoint, same encoding. */
  readonly cool: number;
  /** Distance band over which field B fades to the mean. */
  readonly settleNear: number;
  readonly settleFar: number;
  /** Scale on the dFdx-variance term (1 = reference strength). */
  readonly specAA: number;
};

/** Non-integer period ratio between the two macro fields — they never re-phase. */
export const MACRO_PERIOD_RATIO = 0.319;
/** Extra gain on the dFdx normal-variance term, over three's own unit term. */
export const SPEC_AA_GAIN = 1.6;
/** Cap on the variance add — past this it is fog, not anti-aliasing. */
export const SPEC_AA_CAP = 0.42;

// The collapsed street material (asphalt + walk + kerb share one shader).
// Period matches the reference tarmac macro; amplitudes sit inside the road
// shader's own +-10% band so the drift layers UNDER its patches and seams.
export const ROAD_BREAKUP: BreakupConfig = {
  period: 29.7,
  hueAmp: 0.1,
  valueAmp: 0.05,
  roughAmp: 0.22,
  roughFloor: 0.62,
  warm: 0xfff0dc,
  cool: 0xdce6ff,
  settleNear: 34,
  settleFar: 95,
  specAA: 1,
};

// Everything batched: kit facades, prisms, plinths, masonry, props. Period is
// incommensurate with the road period so street and city never share a beat.
// Floor 0.45 stays under the glass prisms' 0.55 roughness — it must catch
// aliased glitter, not repaint the one deliberate sheen family.
export const CITY_BREAKUP: BreakupConfig = {
  period: 23.0,
  hueAmp: 0.12,
  valueAmp: 0.06,
  roughAmp: 0.2,
  roughFloor: 0.45,
  warm: 0xffeed6,
  cool: 0xd6dfea,
  settleNear: 40,
  settleFar: 120,
  specAA: 1,
};

// GLSL float literal — String(0.1) has a dot, String(1) does not.
function f(n: number): string {
  const s = String(n);
  return s.includes(".") || s.includes("e") ? s : `${s}.0`;
}

// Hex -> per-channel ratio with the max channel rescaled to 1 (a pure hue
// shift, no energy change). Raw byte ratios on purpose, NOT THREE.Color: a
// transfer curve applied to a ratio is meaningless (0xb3 means "70% of
// whatever is there"; through 2.2 gamma it would mean 45%).
function hueRatio(hex: number): string {
  const r = ((hex >> 16) & 0xff) / 255;
  const g = ((hex >> 8) & 0xff) / 255;
  const b = (hex & 0xff) / 255;
  const m = Math.max(r, g, b, 1e-6);
  const p = (v: number): string => f(Math.round((v / m) * 1000) / 1000);
  return `vec3(${p(r)}, ${p(g)}, ${p(b)})`;
}

const FRAG_ANCHOR = "#include <lights_physical_fragment>";
const VERT_ANCHOR = "#include <project_vertex>";

const applied = new WeakSet<THREE.Material>();

/**
 * Inject the breakup into a lit opaque material. Safe to call on anything:
 * unlit, transparent and decal (polygon-offset paint) materials are skipped,
 * and a second call on the same material is a no-op — the batch builder runs
 * on both load paths and shares canonical kit materials across buckets.
 *
 * Chains any existing onBeforeCompile (the road base already carries the
 * asphalt speckle shader) and folds the config into customProgramCacheKey —
 * three cannot see inside onBeforeCompile, so without this two materials
 * differing only in breakup config would share one compiled program.
 */
export function applyMaterialBreakup(mat: THREE.Material, cfg: BreakupConfig): void {
  if (!(mat instanceof THREE.MeshStandardMaterial)) return;
  if (mat.transparent || mat.polygonOffset) return;
  if (applied.has(mat)) return;
  applied.add(mat);

  const prev = mat.onBeforeCompile;
  const prevKey = mat.customProgramCacheKey();
  const cfgKey = `kbreakup:${JSON.stringify(cfg)}`;

  mat.onBeforeCompile = (shader, renderer) => {
    prev.call(mat, shader, renderer);
    if (
      !shader.fragmentShader.includes(FRAG_ANCHOR) ||
      !shader.vertexShader.includes(VERT_ANCHOR)
    ) {
      // A shader injection that quietly does nothing is the most expensive
      // kind of bug — say so once, loudly.
      console.warn("[material-breakup] anchor missing, injection skipped:", mat.name || mat.uuid);
      return;
    }
    const full = !isCoarsePointer();
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vKbWorld;")
      .replace(
        VERT_ANCHOR,
        // Mirrors project_vertex's batching/instancing transforms — the city
        // renders through BatchedMesh, and a world position taken from
        // modelMatrix alone would sample every instance at the batch origin.
        `vec4 kbWorld = vec4(transformed, 1.0);
#ifdef USE_BATCHING
kbWorld = batchingMatrix * kbWorld;
#endif
#ifdef USE_INSTANCING
kbWorld = instanceMatrix * kbWorld;
#endif
vKbWorld = (modelMatrix * kbWorld).xyz;
${VERT_ANCHOR}`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        `#include <common>
${full ? "#define KB_MACRO_FULL 1" : ""}
varying vec3 vKbWorld;
float kbHash(vec2 p) { return fract(sin(dot(p, vec2(157.31, 269.53))) * 43758.5453); }
float kbNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 fp = p - i;
  vec2 u = fp * fp * (3.0 - 2.0 * fp);
  return mix(
    mix(kbHash(i), kbHash(i + vec2(1.0, 0.0)), u.x),
    mix(kbHash(i + vec2(0.0, 1.0)), kbHash(i + vec2(1.0, 1.0)), u.x),
    u.y);
}
// One 2D slice of world space that never smears on a vertical surface —
// facades get the same breakup language as the ground.
vec2 kbPlane(vec3 p, float period) { return (p.xz + p.y * 0.71) / period; }`,
      )
      .replace(
        FRAG_ANCHOR,
        // Runs after every upstream albedo op (vertex colours, atlas map, the
        // road surface shader) so the drift cannot shift the colour gates
        // those shaders key on. Derivatives stay in uniform control flow.
        `{
  float kbA = kbNoise(kbPlane(vKbWorld, ${f(cfg.period)})) - 0.5;
  diffuseColor.rgb *= mix(vec3(1.0), mix(${hueRatio(cfg.cool)}, ${hueRatio(cfg.warm)}, kbA + 0.5), ${f(cfg.hueAmp)});
#ifdef KB_MACRO_FULL
  float kbSettle = smoothstep(${f(cfg.settleNear)}, ${f(cfg.settleFar)}, distance(vKbWorld, cameraPosition));
  float kbB = kbNoise(kbPlane(vKbWorld, ${f(cfg.period * MACRO_PERIOD_RATIO)}) + vec2(0.19, 0.57)) - 0.5;
  diffuseColor.rgb *= 1.0 + kbB * ${f(cfg.valueAmp)} * (1.0 - kbSettle);
  float kbR = kbNoise(kbPlane(vKbWorld, ${f(cfg.period)}) + vec2(0.21, 0.83));
  roughnessFactor *= 1.0 - kbR * ${f(cfg.roughAmp)};
#endif
  roughnessFactor = max(roughnessFactor, ${f(cfg.roughFloor)});
  vec3 kbDxy = max(abs(dFdx(normal)), abs(dFdy(normal)));
  float kbVar = min(max(max(kbDxy.x, kbDxy.y), kbDxy.z) * ${f(SPEC_AA_GAIN * cfg.specAA)}, ${f(SPEC_AA_CAP)});
  roughnessFactor = min(roughnessFactor + kbVar, 1.0);
}
${FRAG_ANCHOR}`,
      );
  };
  mat.customProgramCacheKey = () => `${prevKey}|${cfgKey}|${isCoarsePointer() ? "lo" : "hi"}`;
  // A shared kit material may already have a compiled program (dynamic props
  // render during load); without the bump the renderer would keep it and the
  // injection would silently never run.
  mat.needsUpdate = true;
}
