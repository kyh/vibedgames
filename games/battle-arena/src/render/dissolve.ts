// Death-dissolve shader patch — injects a world-position hash-noise discard +
// edge glow into a unit's (already per-instance-cloned) materials via the typed
// `onBeforeCompile` hook. Zero extra draw calls; the shared `{ value }` uniform
// objects live in this closure, so one handle drives every patched material.
//
// Usage (Wave 2, world-view.ts death path):
//   const d = applyDissolve(view.mats);        // once, at UnitView construction
//   d.setEdge(0xcfd8e0);                       // bone-white for creeps, team color for heroes
//   d.set(k);                                  // 0 → 1 over 600ms (heroes cap at 0.55)
import * as THREE from "three";

export type DissolveHandle = {
  /** Dissolve amount 0 (intact) → 1 (gone). Clamped. */
  set(v: number): void;
  /** Edge-glow color (hex). */
  setEdge(color: number): void;
};

const EDGE_BAND = 0.08;

/** Patch `materials` with a shared dissolve uniform. Safe on MeshStandard /
 *  MeshBasic (anything whose fragment shader has `#include <opaque_fragment>`).
 *  Skinned meshes work: the noise samples `modelMatrix × transformed`, the same
 *  world position three's own chunks use. */
export function applyDissolve(materials: THREE.Material[]): DissolveHandle {
  const uDissolve: THREE.IUniform<number> = { value: 0 };
  const uEdge: THREE.IUniform<THREE.Color> = { value: new THREE.Color(0xcfd8e0) };

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
            // stable per-fragment hash from the world position (no texture, no time)
            "float dslvN = fract(sin(dot(vDslvWorld.xz * 7.13, vec2(12.9898, 78.233)) + vDslvWorld.y * 3.7) * 43758.5453);",
            "if (dslvN < uDissolve) discard;",
            `outgoingLight += uDissolveEdge * smoothstep(uDissolve + ${EDGE_BAND.toFixed(3)}, uDissolve, dslvN) * step(0.001, uDissolve);`,
            "#include <opaque_fragment>",
          ].join("\n"),
        );
    };
    // one shared program for every dissolve-patched material (distinct from unpatched)
    mat.customProgramCacheKey = () => "ba-dissolve";
    mat.needsUpdate = true;
  }

  return {
    set(v: number): void {
      uDissolve.value = Math.min(1, Math.max(0, v));
    },
    setEdge(color: number): void {
      uEdge.value.setHex(color);
    },
  };
}
