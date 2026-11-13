// The two kits a soldier wears. Every soldier is the same textured mesh
// (soldier-rig.ts), modelled in urban grey; a kit recolours its whole
// loadout in the shader and paints an armband on, so the two sides read
// apart at a glance: `garrison` (the grey it came in, a red band: the dock's
// crew) and `operator` (coyote, an orange band: every deathmatch fighter).
//
// Recolouring keeps each texel's shading and swaps its hue, so a darker vest
// stays a darker vest and nothing needs a mask. Which vertices are band is
// worked out once, when the rig loads, into the `band` attribute.
import { Color } from "three";
import type { MeshStandardMaterial } from "three";

export type Kit = "operator" | "garrison";

interface Dye {
  /** What mid-grey cloth becomes; null leaves the mesh as modelled. */
  cloth: string | null;
  band: string;
}

const DYES: Record<Kit, Dye> = {
  garrison: { band: "#d2281c", cloth: null },
  operator: { band: "#ff9a2e", cloth: "#a48d68" },
};

/** `base` in a kit's colours. The maps are shared; only the program differs. */
export const kitMaterial = (kit: Kit, base: MeshStandardMaterial): MeshStandardMaterial => {
  const dye = DYES[kit];
  const material = base.clone();
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uCloth = { value: new Color(dye.cloth ?? "#808080") };
    shader.uniforms.uDye = { value: dye.cloth ? 1 : 0 };
    shader.uniforms.uBand = { value: new Color(dye.band) };
    shader.vertexShader = shader.vertexShader
      .replace(
        "#include <common>",
        "#include <common>\nattribute float band;\nvarying float vBand;",
      )
      .replace("#include <begin_vertex>", "#include <begin_vertex>\nvBand = band;");
    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        "#include <common>\nvarying float vBand;\nuniform vec3 uCloth;\nuniform vec3 uBand;\nuniform float uDye;",
      )
      .replace(
        "#include <map_fragment>",
        `#include <map_fragment>
        float kitLuma = dot(diffuseColor.rgb, vec3(0.2126, 0.7152, 0.0722));
        // Mid-grey lands on the cloth colour; shadows and highlights keep their depth.
        vec3 kitDyed = uCloth * kitLuma / 0.2;
        // Already-coloured texels (boots, skin) keep some of themselves.
        float kitGrey = 1.0 - smoothstep(0.04, 0.2, length(diffuseColor.rgb - vec3(kitLuma)));
        diffuseColor.rgb = mix(diffuseColor.rgb, min(kitDyed, vec3(1.0)), uDye * (0.35 + 0.65 * kitGrey));
        diffuseColor.rgb = mix(diffuseColor.rgb, uBand * (0.5 + kitLuma * 2.5), step(0.5, vBand));`,
      );
  };
  material.customProgramCacheKey = () => "soldier-kit";
  return material;
};
