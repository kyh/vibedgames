// Imported FX textures (public/fx/*, brought in by tools/import-fx-assets.mjs
// from the licensed Unity VFX packs — textures only, the Unity prefabs/shaders
// stay behind). Lazy-loaded + cached; call preloadFxTextures() once at Fx
// construction so nothing pops in mid-fight.
import * as THREE from "three";

const LOADER = new THREE.TextureLoader();
const cache = new Map<string, THREE.Texture>();

/** Options: `wrap` for tiling erosion/noise maps; `srgb` for COLORED sprites
 *  (grayscale masks sample raw — sRGB would gamma-crush the erosion ramps). */
export function fxTex(name: string, opts: { wrap?: boolean; srgb?: boolean } = {}): THREE.Texture {
  const cached = cache.get(name);
  if (cached) return cached;
  const t = LOADER.load(`./fx/${name}.png`);
  if (opts.wrap) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  if (opts.srgb) t.colorSpace = THREE.SRGBColorSpace;
  cache.set(name, t);
  return t;
}

/** Warm every texture the FX layer uses at runtime. */
export function preloadFxTextures(): void {
  fxTex("noise-streak", { wrap: true });
  fxTex("noise-caustic", { wrap: true });
  fxTex("shockwave");
  fxTex("slash-white");
  fxTex("slash-arc");
  fxTex("slash-spin");
  fxTex("slash-wind", { srgb: true });
  fxTex("flare-star");
  fxTex("impact-burst");
  fxTex("glow-soft");
}
