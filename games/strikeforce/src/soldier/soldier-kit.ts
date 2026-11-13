// The two kits a soldier wears. Every soldier is the same textured mesh
// (soldier-rig.ts) in black tactical gear; a kit dyes its fatigues and helmet
// and paints an armband on, so the two sides read apart at a glance:
// `operator` (coyote, an orange band: every deathmatch fighter) and
// `garrison` (urban grey, a red band: the dock's crew).
//
// Which vertices are cloth and which are band is worked out once, when the
// rig loads, into the `dye` and `band` attributes this material reads.
import { Color, MeshStandardMaterial } from "three";
import type { Texture } from "three";

export type Kit = "operator" | "garrison";

interface Dye {
  cloth: string;
  band: string;
  /** How far the cloth's own shading lifts the dye: black fabric has little to give. */
  gain: number;
  lift: number;
}

const DYES: Record<Kit, Dye> = {
  garrison: { band: "#d2281c", cloth: "#7d838c", gain: 3.2, lift: 0.16 },
  operator: { band: "#ff9a2e", cloth: "#b39a6a", gain: 3.6, lift: 0.24 },
};

export const kitMaterial = (kit: Kit, atlas: Texture): MeshStandardMaterial => {
  const dye = DYES[kit];
  const material = new MeshStandardMaterial({ map: atlas, metalness: 0, roughness: 0.82 });
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uCloth = { value: new Color(dye.cloth) };
    shader.uniforms.uBand = { value: new Color(dye.band) };
    shader.uniforms.uShade = { value: [dye.gain, dye.lift] };
    shader.vertexShader = shader.vertexShader
      .replace(
        "#include <common>",
        "#include <common>\nattribute float dye;\nattribute float band;\nvarying float vDye;\nvarying float vBand;",
      )
      .replace("#include <begin_vertex>", "#include <begin_vertex>\nvDye = dye;\nvBand = band;");
    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        "#include <common>\nvarying float vDye;\nvarying float vBand;\nuniform vec3 uCloth;\nuniform vec3 uBand;\nuniform vec2 uShade;",
      )
      .replace(
        "#include <map_fragment>",
        `#include <map_fragment>
        float kitLuma = dot(diffuseColor.rgb, vec3(0.2126, 0.7152, 0.0722));
        vec3 kitCloth = uCloth * min(0.72, kitLuma * uShade.x + uShade.y);
        diffuseColor.rgb = mix(diffuseColor.rgb, kitCloth, smoothstep(0.35, 0.65, vDye));
        diffuseColor.rgb = mix(diffuseColor.rgb, uBand * (0.55 + kitLuma * 2.0), step(0.5, vBand));`,
      );
  };
  material.customProgramCacheKey = () => "soldier-kit";
  return material;
};
