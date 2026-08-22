// Burning rock — the meteor V-yx calls down, and anything else that should
// read as a lump of stone with something molten inside it.
//
// Shading model ported from the Elemental Sandbox VFX sandbox (MIT, Copyright
// (c) 2026 mohamedachrefelouafi) —
// https://github.com/achrefelouafi/LinearAbiltyCastingThreeJS — re-graded for
// our look: two noise octaves instead of three, harder facet contrast, and a
// finer, tighter crack network. Our rock is a fifth of the screen the sandbox's
// is, and at the sandbox's seam width it reads as a crust on a ball of lava
// rather than as stone with something molten inside it.
//
// The signature is the LAVA SEAM: a crack is the zero crossing of a noise
// field, cut into three bands — the open gap (no rock, kill the albedo), a much
// wider charred lip either side of it, and a white-hot core down the middle. A
// crack is a shadow first and a light second; without the lip the glow reads as
// painted onto the surface rather than coming out of a split in it.
//
// The field is sampled in LOCAL space, so the seams are welded to the rock and
// tumble with it. World space (as the crystals deliberately use, so a whole
// field looks quarried from one block) would make them swim across a spinning
// meteor and read as fake immediately.
import * as THREE from "three";
import { NOISE_GLSL } from "./fx-noise";

const ROCK = {
  crackScale: 2.7,
  crackWidth: 0.075, // dark stone stays the dominant read even at full charge
  crackBranches: 0.65,
  crackGlow: 2.6,
  flow: 0.7,
  flowSpeed: 0.9,
  rockScale: 3.0,
  facetTint: 0.42,
  cavity: 0.45,
  soot: 0.95,
  rimHeat: 1.0,
  lead: 1.5,
  leadSharp: 2.6,
  glow: 1.0,
} as const;

export type RockMaterial = THREE.MeshStandardMaterial & {
  /** 0..1 — how far into its run-up the rock is. Prises the seams open and
   *  lights the rim and leading facets, so the impact is something you saw
   *  coming rather than something that happened. */
  setCharge(charge: number): void;
  /** Unit direction of travel, world space — drives the compression heat on the
   *  facets that point along it. */
  setHeading(x: number, y: number, z: number): void;
};

export function createBurningRockMaterial(clock: { value: number }): RockMaterial {
  const material = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.94,
    metalness: 0.0,
    // Faceted, like the crystals: it is what makes a low-poly rock read as rock
    // rather than as a smooth ball with a texture on it.
    flatShading: true,
  });

  const uniforms = {
    uTime: clock,
    uRock: { value: new THREE.Color(0x4a3a34) },
    uChar: { value: new THREE.Color(0x14100f) },
    uCrack: { value: new THREE.Color(0xff5a1e) },
    uHot: { value: new THREE.Color(0xffd9a0) },
    uCrackScale: { value: ROCK.crackScale },
    uCrackWidth: { value: ROCK.crackWidth },
    uCrackBranches: { value: ROCK.crackBranches },
    uCrackGlow: { value: ROCK.crackGlow },
    uFlow: { value: ROCK.flow },
    uFlowSpeed: { value: ROCK.flowSpeed },
    uRockScale: { value: ROCK.rockScale },
    uFacetTint: { value: ROCK.facetTint },
    uCavity: { value: ROCK.cavity },
    uSoot: { value: ROCK.soot },
    uRimHeat: { value: ROCK.rimHeat },
    uLead: { value: ROCK.lead },
    uLeadSharp: { value: ROCK.leadSharp },
    uHeading: { value: new THREE.Vector3(0, -1, 0) },
    uCharge: { value: 0 },
    uGlow: { value: ROCK.glow },
  };

  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);

    shader.vertexShader = shader.vertexShader
      .replace(
        "#include <common>",
        /* glsl */ `#include <common>
        varying vec3  vRockLocal;
        varying vec3  vRockNormalW;`,
      )
      // objectNormal is declared by <beginnormal_vertex>, which runs before
      // this chunk; three only ever takes it into VIEW space, and the
      // leading-face term needs it in world space.
      .replace(
        "#include <begin_vertex>",
        /* glsl */ `#include <begin_vertex>
        vRockLocal = transformed;
        #ifdef USE_INSTANCING
          vRockNormalW = normalize(mat3(modelMatrix) * (instanceMatrix * vec4(objectNormal, 0.0)).xyz);
        #else
          vRockNormalW = normalize(mat3(modelMatrix) * objectNormal);
        #endif`,
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        /* glsl */ `#include <common>
        uniform float uTime;
        uniform vec3  uRock;
        uniform vec3  uChar;
        uniform vec3  uCrack;
        uniform vec3  uHot;
        uniform float uCrackScale;
        uniform float uCrackWidth;
        uniform float uCrackBranches;
        uniform float uCrackGlow;
        uniform float uFlow;
        uniform float uFlowSpeed;
        uniform float uRockScale;
        uniform float uFacetTint;
        uniform float uCavity;
        uniform float uSoot;
        uniform float uRimHeat;
        uniform float uLead;
        uniform float uLeadSharp;
        uniform vec3  uHeading;
        uniform float uCharge;
        uniform float uGlow;
        varying vec3  vRockLocal;
        varying vec3  vRockNormalW;
        ${NOISE_GLSL}`,
      )
      .replace(
        "#include <emissivemap_fragment>",
        /* glsl */ `#include <emissivemap_fragment>
        {
          vec3  N   = normalize(normal);
          float ndv = clamp(dot(N, normalize(vViewPosition)), 0.0, 1.0);
          float rim = pow(1.0 - ndv, 2.2);

          vec3  p  = vRockLocal * uCrackScale;
          float f1 = fbm2(p);
          float f2 = fbm2(p * 2.7 + 11.3);

          // The charge prises the seams open as the rock heats up.
          float width = max(0.004, uCrackWidth * (1.0 + uCharge * 0.8));
          float dist = min(abs(f1), abs(f2) / max(uCrackBranches, 0.05));

          float fissure = 1.0 - smoothstep(width * 0.35, width, dist);
          float lip     = 1.0 - smoothstep(width, width * 2.0, dist);
          float core    = 1.0 - smoothstep(0.0, width * 0.45, dist);

          // Magma is not static: brightness crawls along the inside of a seam.
          float pulse = snoise(vRockLocal * 4.0 + vec3(0.0, uTime * uFlowSpeed, 0.0));
          float flow  = mix(1.0, 0.45 + 0.75 * (pulse * 0.5 + 0.5), uFlow);

          float mottle = fbm2(vRockLocal * uRockScale) * 0.5 + 0.5;
          vec3  rock   = mix(uRock, uChar, smoothstep(0.3, 0.85, mottle));

          // Per-facet value break-up. The geometric normal in OBJECT space is
          // constant across a triangle, so hashing it gives every flat face its
          // own shade — the thing that separates cut stone from a noise-painted
          // ball, and it costs two derivatives.
          vec3  faceN = normalize(cross(dFdx(vRockLocal), dFdy(vRockLocal)));
          rock *= 1.0 + (nhash13(faceN * 37.0 + 0.5) - 0.5) * uFacetTint;

          // Cheap curvature occlusion: craters and cut faces sit closer to the
          // centre than the lumps do, so radius doubles as a cavity term.
          rock *= mix(1.0 - uCavity, 1.0, smoothstep(0.55, 1.0, length(vRockLocal)));

          // Charred around every seam, and gone entirely inside one.
          rock = mix(rock, uChar, lip * uSoot);
          rock *= 1.0 - fissure * 0.92;
          rock *= mix(0.5, 1.2, ndv);
          diffuseColor.rgb *= rock;

          // The gap is the only thing that emits, and only its middle runs
          // white. Everything else is rock.
          vec3 glow = mix(uCrack, uHot, core * core) * fissure * flow * uCrackGlow;

          // A sheath of heat around the silhouette, and compression heat on the
          // leading facets. Both squared against the charge: at launch this is a
          // cold rock with lit cracks, and only on the way down does the whole
          // thing start to burn.
          float charge2 = uCharge * uCharge;
          glow += uCrack * rim * uRimHeat * charge2;
          float lead = pow(clamp(dot(normalize(vRockNormalW), uHeading), 0.0, 1.0), uLeadSharp);
          glow += uHot * lead * uLead * charge2;
          glow *= uGlow;

          // Same soft ceiling the crystals use: these terms are independent and
          // stack, and without it a seam crossing the rim sums past 10 and the
          // bloom pass smears the rock into a white blob.
          glow /= 1.0 + glow * 0.22;

          totalEmissiveRadiance += glow;
        }`,
      );
  };

  return Object.assign(material, {
    setCharge: (charge: number) => {
      uniforms.uCharge.value = Math.min(1, Math.max(0, charge));
    },
    setHeading: (x: number, y: number, z: number) => {
      uniforms.uHeading.value.set(x, y, z).normalize();
    },
  });
}
