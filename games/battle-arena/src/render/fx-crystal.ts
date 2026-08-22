// The material every ground eruption is shaded with — frost-nova ice, bog
// thorns, stone teeth, ember spurs. One material, one draw call: the body hue
// arrives as the InstancedMesh's per-instance color, so a green vine and a blue
// icicle are the same program.
//
// Shading model ported from the Elemental Sandbox VFX sandbox (MIT, Copyright
// (c) 2026 mohamedachrefelouafi) —
// https://github.com/achrefelouafi/LinearAbiltyCastingThreeJS — and re-graded
// for our look. The sandbox is lit for photoreal translucent ice against a dark
// stage; our arena is bright and the characters are flat-shaded plastic, so the
// smooth terms are posterised into steps (see `bands`) and the noise runs at
// two octaves. Photoreal ice next to a KayKit knight reads as a bug.
//
// Built on MeshStandardMaterial rather than a raw ShaderMaterial so eruptions
// still take the arena's real lights and shadows; the stylisation is injected
// on top of the lit result.
import * as THREE from "three";
import { NOISE_GLSL } from "./fx-noise";

/** Shading controls. One literal — the sandbox's 90-odd live sliders, frozen. */
const ICE = {
  depthTint: 1.05, // how much a head-on facet darkens toward the deep tone
  fresnel: 1.9,
  fresnelPower: 2.2,
  translucency: 1.1,
  facetSharp: 0.72, // lift on facets pointing at the camera
  facetBands: 4, // posterise steps across the body — the toon term
  fracture: 0.6,
  fractureScale: 3.0, // low: at our camera distance the sandbox's 6.5 streaked
  veins: 0.45,
  veinScale: 3.0,
  sparkle: 1.3,
  sparkleScale: 18, // lower than the sandbox: our camera sits farther out and
  sparkleSpeed: 0.6, // its 34 aliased into moving grain at this distance
  frostLine: 0.55, // rime gathering where the crystal left the floor
  glow: 1.0,
  edgeGlow: 1.25,
  birthGlow: 3.0,
  opacity: 0.94,
} as const;

/**
 * @param clock the shared hit-stop-scaled FX clock, so eruptions freeze with
 *   everything else during a hard hit.
 */
export function createCrystalMaterial(clock: { value: number }): THREE.MeshStandardMaterial {
  const material = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.18,
    metalness: 0.0,
    flatShading: true,
    transparent: true,
    // A crystal is translucent, so the far wall is part of what you see through
    // the near one. Culling it leaves the interior empty and thin shards read
    // as hollow shells.
    side: THREE.DoubleSide,
    // Kept on: these are near-opaque, and writing depth is what stops a field
    // from sorting through itself.
    depthWrite: true,
    opacity: ICE.opacity,
  });

  const uniforms = {
    uTime: clock,
    uDeep: { value: new THREE.Color(0x2f6f9e) },
    uRim: { value: new THREE.Color(0xdff2ff) },
    uCore: { value: new THREE.Color(0xa8e6ff) },
    uDensity: { value: ICE.depthTint },
    uFresnel: { value: ICE.fresnel },
    uFresnelPower: { value: ICE.fresnelPower },
    uTranslucency: { value: ICE.translucency },
    uFacetSharp: { value: ICE.facetSharp },
    uFacetBands: { value: ICE.facetBands },
    uFracture: { value: ICE.fracture },
    uFractureScale: { value: ICE.fractureScale },
    uVeins: { value: ICE.veins },
    uVeinScale: { value: ICE.veinScale },
    uSparkle: { value: ICE.sparkle },
    uSparkleScale: { value: ICE.sparkleScale },
    uSparkleSpeed: { value: ICE.sparkleSpeed },
    uFrostLine: { value: ICE.frostLine },
    uGlow: { value: ICE.glow },
    uEdgeGlow: { value: ICE.edgeGlow },
    uBirthGlow: { value: ICE.birthGlow },
  };

  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);

    shader.vertexShader = shader.vertexShader
      .replace(
        "#include <common>",
        /* glsl */ `#include <common>
        attribute float aSeed;
        attribute float aBirth;
        varying vec3  vCrystalLocal;
        varying vec3  vCrystalWorld;
        varying float vCrystalSeed;
        varying float vCrystalBirth;`,
      )
      .replace(
        "#include <begin_vertex>",
        /* glsl */ `#include <begin_vertex>
        vCrystalLocal = transformed;
        vCrystalSeed = aSeed;
        vCrystalBirth = aBirth;
        #ifdef USE_INSTANCING
          vCrystalWorld = (modelMatrix * instanceMatrix * vec4(transformed, 1.0)).xyz;
        #else
          vCrystalWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;
        #endif`,
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        /* glsl */ `#include <common>
        uniform float uTime;
        uniform vec3  uDeep;
        uniform vec3  uRim;
        uniform vec3  uCore;
        uniform float uDensity;
        uniform float uFresnel;
        uniform float uFresnelPower;
        uniform float uTranslucency;
        uniform float uFacetSharp;
        uniform float uFacetBands;
        uniform float uFracture;
        uniform float uFractureScale;
        uniform float uVeins;
        uniform float uVeinScale;
        uniform float uSparkle;
        uniform float uSparkleScale;
        uniform float uSparkleSpeed;
        uniform float uFrostLine;
        uniform float uGlow;
        uniform float uEdgeGlow;
        uniform float uBirthGlow;
        varying vec3  vCrystalLocal;
        varying vec3  vCrystalWorld;
        varying float vCrystalSeed;
        varying float vCrystalBirth;
        ${NOISE_GLSL}`,
      )
      // Injected once the normal is resolved: with `flatShading` there is no
      // `vNormal` varying, so every view-dependent term has to read the face
      // normal that <normal_fragment_begin> derives from derivatives.
      .replace(
        "#include <emissivemap_fragment>",
        /* glsl */ `#include <emissivemap_fragment>
        {
          vec3  N   = normalize(normal);
          float ndv = clamp(dot(N, normalize(vViewPosition)), 0.0, 1.0);

          // Facing a facet you look down the long axis of the crystal; at a
          // grazing angle you are only clipping its edge.
          float thickness = clamp(ndv * uDensity, 0.0, 1.0);
          float rimAmount = pow(1.0 - ndv, uFresnelPower);
          float fres = rimAmount * uFresnel;

          // World space: crack planes keep a fixed physical scale, so a small
          // shard and a tall spike look cut from the same block.
          vec3  fp     = vCrystalWorld * uFractureScale + vCrystalSeed * 37.0;
          float cracks = smoothstep(0.58, 0.95, ridged(fp));

          // Local space: veining follows each crystal's own axis whatever the
          // instance scale did to it.
          float veins = smoothstep(0.45, 0.9, fbm2(vCrystalLocal * uVeinScale * 4.0 + vCrystalSeed * 11.0) * 0.5 + 0.5);

          // The toon step. diffuseColor.rgb already carries the instance tint,
          // so shading here is a multiplier and one material serves every hue.
          vec3 body = mix(vec3(1.0), uDeep, bands(thickness, uFacetBands) * 0.85);
          body = mix(body, uRim, veins * uVeins * 0.5);
          body = mix(body, uRim, cracks * uFracture * 0.4);

          // Rime gathers where the crystal left the floor.
          float rime = smoothstep(0.55, 0.0, vCrystalLocal.y) *
                       (0.55 + 0.45 * fbm2(vCrystalLocal * 7.0 + vCrystalSeed * 5.0));
          body = mix(body, uRim, clamp(rime, 0.0, 1.0) * uFrostLine);

          // Lift facets that point at the camera, in steps, so the silhouette
          // reads as a bundle of planes rather than one smooth mass.
          body *= mix(1.0, 0.6 + 0.85 * bands(ndv, uFacetBands), uFacetSharp);

          // Pinpoint glints, biased to the grazing angles where ice catches.
          float sp = snoise(vCrystalWorld * uSparkleScale +
                            vec3(0.0, uTime * uSparkleSpeed, 0.0) + vCrystalSeed * 23.0);
          sp = pow(clamp(sp, 0.0, 1.0), 14.0) * smoothstep(0.0, 0.7, fres + 0.3);

          diffuseColor.rgb *= body;

          // The rim glow rides the normalised fresnel, not fres — that one
          // carries uFresnel because it also drives opacity, and folding the
          // gain in here too pushes the silhouette past white before any of the
          // other terms land.
          vec3 glow = uRim * rimAmount * uEdgeGlow;
          glow += uCore * (cracks * uFracture * 0.8 + veins * uVeins * 0.35) * uTranslucency;
          glow += uRim * sp * uSparkle * 1.5;
          glow += uCore * vCrystalBirth * uBirthGlow;
          glow *= uGlow;

          // Soft ceiling. Those terms are independent and all peak at a grazing
          // angle, so they stack; without this a silhouette facet sums past 10
          // and the bloom pass smears the crystal into a white blob. Reinhard
          // leaves anything under ~1 alone and asymptotes at 1/0.22.
          glow /= 1.0 + glow * 0.22;

          totalEmissiveRadiance += glow * diffuseColor.rgb;

          // Thin at the edges, denser through the body and along the cracks.
          diffuseColor.a = clamp(diffuseColor.a * (0.7 + 0.42 * fres) + cracks * 0.1, 0.0, 1.0);
        }`,
      );
  };

  return material;
}
