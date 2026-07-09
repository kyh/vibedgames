// Mobile quality contract shared by main, the perf governor and the scene.
//
// Desktop is sacred: every feature here defaults to FULL_QUALITY and the
// desktop tier table never deviates from it, so a mouse-and-keyboard machine
// renders exactly what it rendered before this module existed. Phones (coarse
// primary pointer) get a tiered feature ladder on top of the existing
// resolution stepper — fill rate and per-fragment lighting are what melt
// mobile GPUs, not draw calls.

export function isCoarsePointer(): boolean {
  return window.matchMedia("(pointer: coarse)").matches;
}

// 2 = full sky (desktop look), 1 = halved counts + capped fog sheets,
// 0 = no marine-layer sheets at all (scene fog + sky still sell the haze).
export type CloudQuality = 0 | 1 | 2;

// NOTE on shadow sampling quality: three r184 removed PCFSoftShadowMap (the
// renderer coerces it to PCFShadowMap at render time), so every platform
// already runs plain PCF — there is no soft/hard sampling knob left to tier.
export type QualityFeatures = {
  // Render the shadow depth map every Nth frame (1 = every frame).
  readonly shadowEvery: number;
  // false = the sun casts no shadows at all (floor tier).
  readonly shadowCast: boolean;
  // Bake the Sky dome to a small cube texture instead of shading it per frame.
  readonly skyBake: boolean;
  readonly clouds: CloudQuality;
};

export const FULL_QUALITY: QualityFeatures = {
  shadowEvery: 1,
  shadowCast: true,
  skyBake: false,
  clouds: 2,
};
