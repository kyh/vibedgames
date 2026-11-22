import * as THREE from "three";

export interface DissolveHandle {
  /** Dissolve amount 0 (intact) → 1 (gone). Clamped. */
  set: (v: number) => void;
  /** Edge-glow color (hex). */
  setEdge: (color: number) => void;
}

const EDGE_BAND = 0.08;

/** Patch `materials` with a shared dissolve uniform. Safe on MeshStandard /
 *  MeshBasic (anything whose fragment shader has `#include <opaque_fragment>`).
 *  Skinned meshes work: the noise samples `modelMatrix × transformed`, the same
 *  world position three's own chunks use. */
export const applyDissolve = (materials: THREE.Material[]) => {
  const uDissolve: THREE.IUniform<number> = { value: 0 };
  const uEdge: THREE.IUniform<THREE.Color> = { value: new THREE.Color(0xcf_d8_e0) };

  for (const mat of materials) {
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uDissolve = uDissolve;
      shader.uniforms.uDissolveEdge = uEdge;
      shader.vertexShader = shader.vertexShader
        .replace("#include <common>", "#include <common>\nvarying vec3 vDslvWorld;")
        .replace(
          "#include <project_vertex>",
          "vDslvWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;\n#include <project_vertex>",
        );
      shader.fragmentShader = shader.fragmentShader
        .replace(
          "#include <common>",
          "#include <common>\nuniform float uDissolve;\nuniform vec3 uDissolveEdge;\nvarying vec3 vDslvWorld;",
        )
        .replace(
          "#include <opaque_fragment>",
          [
            "float dslvN = fract(sin(dot(vDslvWorld.xz * 7.13, vec2(12.9898, 78.233)) + vDslvWorld.y * 3.7) * 43758.5453);",
            "if (dslvN < uDissolve) discard;",
            `outgoingLight += uDissolveEdge * smoothstep(uDissolve + ${EDGE_BAND.toFixed(3)}, uDissolve, dslvN) * step(0.001, uDissolve);`,
            "#include <opaque_fragment>",
          ].join("\n"),
        );
    };

    mat.customProgramCacheKey = () => "ba-dissolve";
    mat.needsUpdate = true;
  }

  return {
    set(v: number) {
      uDissolve.value = Math.min(1, Math.max(0, v));
    },
    setEdge(color: number) {
      uEdge.value.setHex(color);
    },
  };
};
