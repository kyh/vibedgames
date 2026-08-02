import * as THREE from "three";

import type { ModelCache } from "../assets/loader";
import { modelUrl, POLICE_CAR, SERVICE_CARS, TRAFFIC_CARS } from "../assets/manifest";

// Sun-rim kicker: outgoingLight += sun * fresnel^4 * lit^2 * strength, gated
// on the fragment's OWN lit luminance — needs no sun-direction uniform, can
// never light the shadow side, and dies in tunnels/at night by itself. The
// tint rides three's `directionalLights[0]` uniform (color x intensity, the
// day-night cycle writes it every frame), so golden-hour rims come out warm
// and the night moon (cool, 0.3-ish intensity) starves the rim before the
// luminance gate even bites.
//
// Strengths re-derived for waymo's exposure: the reference ran a unit warm
// tint (lum 0.73) at exposure 1.05; waymo's live sun uniform carries
// intensity too (lum ~1.13 at the golden stop) at exposure 0.70, so the same
// 0.72 lands within 2% of the reference's displayed rim.
export const RIM_HERO = 0.72;
export const RIM_TRAFFIC = 0.3;
// clamp(luma(outgoingLight) * gain): saturates on any sunlit fragment, floors
// out in shade — the gain sets where "lit" begins in pre-tonemap radiance.
export const RIM_LIT_GAIN = 2.4;

/**
 * Fragment replacement for `#include <opaque_fragment>` (strength baked as a
 * literal — pair every distinct strength with its own customProgramCacheKey).
 */
export function rimGlsl(strength: number): string {
  return /* glsl */ `
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
}

const rimApplied = new WeakSet<THREE.Material>();

/** Rim-only injection for materials that keep their own lighting model
 *  (traffic kit materials, generated-GLB player skins). Idempotent, and it
 *  chains any injection already on the shared material instead of clobbering
 *  it (three can't see inside onBeforeCompile — the cache key chains too). */
export function applySunRim(mat: THREE.MeshStandardMaterial, strength: number): void {
  if (rimApplied.has(mat)) return;
  rimApplied.add(mat);
  const key = `waymo-sun-rim:${strength.toFixed(2)}`;
  const prev = mat.onBeforeCompile;
  const prevKey = Object.prototype.hasOwnProperty.call(mat, "customProgramCacheKey")
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
}

// Traffic + parked cars share the deduped kit materials, so patching the
// materials reachable from each traffic model rims every fleet/curb instance
// at once. KayKit cars are deliberately absent: their colormap is shared with
// KayKit BUILDINGS, and a rimmed facade is the leak this list exists to avoid.
const TRAFFIC_RIM_MODELS: readonly string[] = [...TRAFFIC_CARS, ...SERVICE_CARS, POLICE_CAR];
const rimmedModels = new Set<string>();

/**
 * Patch the shared traffic-kit materials. Traffic GLBs stream behind the
 * title (late preload), so this is retried until every model resolves to a
 * real template — returns true once all are patched.
 */
export function applyTrafficSunRim(cache: ModelCache): boolean {
  for (const name of TRAFFIC_RIM_MODELS) {
    if (rimmedModels.has(name)) continue;
    const inst = cache.instance(modelUrl("cars", name));
    let loaded = false;
    inst.traverse((c) => {
      // instance() tags real template meshes with userData.src; the magenta
      // fallback box (model not loaded yet) carries no tag.
      if (!(c instanceof THREE.Mesh) || !("src" in c.userData)) return;
      loaded = true;
      const m = c.material;
      if (!Array.isArray(m) && m instanceof THREE.MeshStandardMaterial) {
        applySunRim(m, RIM_TRAFFIC);
      }
    });
    if (loaded) rimmedModels.add(name);
  }
  return rimmedModels.size === TRAFFIC_RIM_MODELS.length;
}
