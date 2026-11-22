import * as THREE from "three";

import type { ModelCache } from "../assets/loader";
import { modelUrl, POLICE_CAR, SERVICE_CARS, TRAFFIC_CARS } from "../assets/manifest";

export const RIM_HERO = 0.72;
export const RIM_TRAFFIC = 0.3;
export const RIM_LIT_GAIN = 2.4;

/**
 * Fragment replacement for `#include <opaque_fragment>` (strength baked as a
 * literal — pair every distinct strength with its own customProgramCacheKey).
 */
export const rimGlsl = (strength: number) => `
#if NUM_DIR_LIGHTS > 0
{
	float rimNdv = abs( dot( normalize( vViewPosition ), normal ) );
	float rimFres = pow( 1.0 - clamp( rimNdv, 0.0, 1.0 ), 4.0 );
	float rimLit = clamp( dot( outgoingLight, vec3( 0.2126, 0.7152, 0.0722 ) ) * ${RIM_LIT_GAIN.toFixed(2)}, 0.0, 1.0 );
	outgoingLight += directionalLights[ 0 ].color * ( rimFres * rimLit * rimLit * ${strength.toFixed(2)} );
}
#endif
#include <opaque_fragment>
`;

const rimApplied = new WeakSet<THREE.Material>();

/** Rim-only injection for materials that keep their own lighting model
 *  (traffic kit materials, generated-GLB player skins). Idempotent, and it
 *  chains any injection already on the shared material instead of clobbering
 *  it (three can't see inside onBeforeCompile — the cache key chains too). */
export const applySunRim = (mat: THREE.MeshStandardMaterial, strength: number) => {
  if (rimApplied.has(mat)) {
    return;
  }

  rimApplied.add(mat);
  const key = `waymo-sun-rim:${strength.toFixed(2)}`;
  const prev = mat.onBeforeCompile;

  const prevKey = Object.hasOwn(mat, "customProgramCacheKey")
    ? mat.customProgramCacheKey.bind(mat)
    : null;

  mat.onBeforeCompile = (shader, renderer) => {
    prev(shader, renderer);
    shader.fragmentShader = shader.fragmentShader.replace(
      "#include <opaque_fragment>",
      rimGlsl(strength),
    );
  };

  mat.customProgramCacheKey = () => (prevKey ? `${prevKey()}|` : "") + key;
  mat.needsUpdate = true;
};

const TRAFFIC_RIM_MODELS: readonly string[] = [...TRAFFIC_CARS, ...SERVICE_CARS, POLICE_CAR];
const rimmedModels = new Set<string>();

/**
 * Patch the shared traffic-kit materials. Traffic GLBs stream behind the
 * title (late preload), so this is retried until every model resolves to a
 * real template — returns true once all are patched.
 */
export const applyTrafficSunRim = (cache: ModelCache) => {
  for (const name of TRAFFIC_RIM_MODELS) {
    if (rimmedModels.has(name)) {
      continue;
    }

    const inst = cache.instance(modelUrl("cars", name));
    let loaded = false;
    inst.traverse((c) => {
      if (!(c instanceof THREE.Mesh) || !("src" in c.userData)) {
        return;
      }

      loaded = true;
      const m = c.material;

      if (!Array.isArray(m) && m instanceof THREE.MeshStandardMaterial) {
        applySunRim(m, RIM_TRAFFIC);
      }
    });

    if (loaded) {
      rimmedModels.add(name);
    }
  }

  return rimmedModels.size === TRAFFIC_RIM_MODELS.length;
};
