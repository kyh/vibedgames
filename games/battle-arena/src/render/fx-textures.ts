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
  for (const n of ["noise-streak", "noise-caustic"]) fxTex(n, { wrap: true });
  for (const n of [
    "shockwave",
    "slash-white",
    "slash-arc",
    "slash-spin",
    "flare-star",
    "impact-burst",
    "glow-soft",
    // spell-kit sprites (licensed pack)
    "lightning-arc",
    "ground-crack",
    "electric-splat",
    "scorch-decal",
    "fire-sprite",
    "shock-burst",
    "swirl-lines",
    "hex-shield",
    "electro-ball",
    "holy-wings",
    "trail-holy",
    "galaxy",
    "dark-shock",
    "rune-circle-a",
    "rune-circle-b",
  ])
    fxTex(n);
}
