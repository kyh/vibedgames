import * as THREE from "three";

import { isCoarsePointer } from "./quality";

export interface BreakupConfig {
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
}

/** Non-integer period ratio between the two macro fields — they never re-phase. */
export const MACRO_PERIOD_RATIO = 0.319;

/** Extra gain on the dFdx normal-variance term, over three's own unit term. */
export const SPEC_AA_GAIN = 1.6;

/** Cap on the variance add — past this it is fog, not anti-aliasing. */
export const SPEC_AA_CAP = 0.42;

export const ROAD_BREAKUP: BreakupConfig = {
  cool: 0xdc_e6_ff,
  hueAmp: 0.15,
  period: 29.7,
  roughAmp: 0.3,
  roughFloor: 0.62,
  settleFar: 95,
  settleNear: 34,
  specAA: 1,
  valueAmp: 0.08,
  warm: 0xff_f0_dc,
};

export const CITY_BREAKUP: BreakupConfig = {
  cool: 0xd6_df_ea,
  hueAmp: 0.15,
  period: 23,
  roughAmp: 0.2,
  roughFloor: 0.45,
  settleFar: 120,
  settleNear: 40,
  specAA: 1,
  valueAmp: 0.09,
  warm: 0xff_ee_d6,
};

const f = (n: number) => {
  const s = String(n);

  return s.includes(".") || s.includes("e") ? s : `${s}.0`;
};

const hueRatio = (hex: number) => {
  /* oxlint-disable no-bitwise -- unpacking an 0xRRGGBB literal */
  const r = ((hex >> 16) & 0xff) / 255;
  const g = ((hex >> 8) & 0xff) / 255;
  const b = (hex & 0xff) / 255;
  /* oxlint-enable no-bitwise */
  const m = Math.max(r, g, b, 1e-6);
  const p = (v: number) => f(Math.round((v / m) * 1000) / 1000);

  return `vec3(${p(r)}, ${p(g)}, ${p(b)})`;
};

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
export const applyMaterialBreakup = (mat: THREE.Material, cfg: BreakupConfig) => {
  if (!(mat instanceof THREE.MeshStandardMaterial)) {
    return;
  }

  if (isCoarsePointer()) {
    return;
  }

  if (mat.transparent || mat.polygonOffset) {
    return;
  }

  if (applied.has(mat)) {
    return;
  }

  applied.add(mat);

  const prev = mat.onBeforeCompile.bind(mat);
  const prevKey = mat.customProgramCacheKey();
  const cfgKey = `kbreakup:${JSON.stringify(cfg)}`;

  mat.onBeforeCompile = (shader, renderer) => {
    prev(shader, renderer);

    if (
      !shader.fragmentShader.includes(FRAG_ANCHOR) ||
      !shader.vertexShader.includes(VERT_ANCHOR)
    ) {
      console.warn("[material-breakup] anchor missing, injection skipped:", mat.name || mat.uuid);

      return;
    }

    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vKbWorld;")
      .replace(
        VERT_ANCHOR,
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
        `{
  float kbA = kbNoise(kbPlane(vKbWorld, ${f(cfg.period)})) - 0.5;
  diffuseColor.rgb *= mix(vec3(1.0), mix(${hueRatio(cfg.cool)}, ${hueRatio(cfg.warm)}, kbA + 0.5), ${f(cfg.hueAmp)});
  float kbSettle = smoothstep(${f(cfg.settleNear)}, ${f(cfg.settleFar)}, distance(vKbWorld, cameraPosition));
  float kbB = kbNoise(kbPlane(vKbWorld, ${f(cfg.period * MACRO_PERIOD_RATIO)}) + vec2(0.19, 0.57)) - 0.5;
  diffuseColor.rgb *= 1.0 + kbB * ${f(cfg.valueAmp)} * (1.0 - kbSettle);
  float kbR = kbNoise(kbPlane(vKbWorld, ${f(cfg.period)}) + vec2(0.21, 0.83));
  roughnessFactor *= 1.0 - kbR * ${f(cfg.roughAmp)};
  roughnessFactor = max(roughnessFactor, ${f(cfg.roughFloor)});
  vec3 kbDxy = max(abs(dFdx(normal)), abs(dFdy(normal)));
  float kbVar = min(max(max(kbDxy.x, kbDxy.y), kbDxy.z) * ${f(SPEC_AA_GAIN * cfg.specAA)}, ${f(SPEC_AA_CAP)});
  roughnessFactor = min(roughnessFactor + kbVar, 1.0);
}
${FRAG_ANCHOR}`,
      );
  };

  mat.customProgramCacheKey = () => `${prevKey}|${cfgKey}`;
  mat.needsUpdate = true;
};
