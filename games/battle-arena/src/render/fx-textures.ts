// Imported FX textures (public/fx/*, brought in by tools/import-fx-assets.mjs
// from the licensed Unity VFX packs — textures only, the Unity prefabs/shaders
// stay behind). Lazy-loaded + cached; call preloadFxTextures() once at Fx
// construction so nothing pops in mid-fight, then uploadFxTextures() once a
// renderer exists so nothing STALLS mid-fight either.
import * as THREE from "three";

const LOADER = new THREE.TextureLoader();
const cache = new Map<string, THREE.Texture>();
/** One entry per texture still decoding — see whenFxTexturesReady. */
const pending: Promise<void>[] = [];

/** Options: `wrap` for tiling erosion/noise maps; `srgb` for COLORED sprites
 *  (grayscale masks sample raw — sRGB would gamma-crush the erosion ramps). */
export const fxTex = (
  name: string,
  opts: { wrap?: boolean; srgb?: boolean } = {},
): THREE.Texture => {
  // Keyed on the options, not just the name: three's own texture cache keys on
  // wrapS/wrapT, so a wrapped and an unwrapped copy are two GPU textures. One
  // cache slot per name handed whichever variant loaded first to every caller.
  const key = `${name}|${opts.wrap ? "w" : ""}${opts.srgb ? "s" : ""}`;
  const cached = cache.get(key);
  if (cached) {
    return cached;
  }
  let settle: (() => void) | undefined;
  pending.push(
    // oxlint-disable-next-line promise/avoid-new -- bridges TextureLoader's load/error callbacks, which have no promise form that also resolves on error
    new Promise<void>((resolve) => {
      settle = resolve;
    }),
  );
  // Resolve on error too: one missing sprite must not hold the upload pass
  // hostage for every other texture.
  const t = LOADER.load(
    `./fx/${name}.png`,
    () => settle?.(),
    undefined,
    () => settle?.(),
  );
  if (opts.wrap) {
    t.wrapS = THREE.RepeatWrapping;
    t.wrapT = THREE.RepeatWrapping;
  }
  if (opts.srgb) {
    t.colorSpace = THREE.SRGBColorSpace;
  }
  cache.set(key, t);
  return t;
};

/** Resolves once every texture requested so far has decoded (or failed). */
export const whenFxTexturesReady = async (): Promise<void> => {
  await Promise.all(pending);
};

/**
 * Push every loaded FX texture to the GPU.
 *
 * `preloadFxTextures` only starts the HTTP fetch and decode — the upload still
 * happens on the frame a texture is first drawn. For a meteor, that is eight
 * 512px sprites landing on the same frame as the ultimate, and it cost a ~270ms
 * freeze exactly when the payoff should read (measured, tools/fx-perf.mjs).
 *
 * Safe to call repeatedly and safe to call early: a texture whose image has not
 * decoded yet is skipped and will upload lazily as before.
 */
export const uploadFxTextures = (renderer: THREE.WebGLRenderer): void => {
  for (const t of cache.values()) {
    if (t.image) {
      renderer.initTexture(t);
    }
  }
};

/** Warm every texture the FX layer uses at runtime. */
export const preloadFxTextures = (): void => {
  for (const n of ["noise-streak", "noise-caustic"]) {
    fxTex(n, { wrap: true });
  }
  // texShell clones these with RepeatWrapping, and wrap mode IS part of three's
  // texture cache key — so the wrapped copy is a second GPU texture and needs
  // warming in its own right.
  for (const n of ["hex-shield", "electro-ball"]) {
    fxTex(n, { wrap: true });
  }
  for (const n of [
    "shockwave",
    "slash-white",
    "slash-arc",
    "slash-spin",
    "flare-star",
    "impact-burst",
    "glow-soft",
    // spell-kit sprites (licensed pack)
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
  ]) {
    fxTex(n);
  }
};
