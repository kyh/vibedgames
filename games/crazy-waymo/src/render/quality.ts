// Mobile quality contract shared by main, the perf governor and the scene.
//
// Desktop is sacred: every feature here defaults to FULL_QUALITY and the
// desktop tier table never deviates from it, so a mouse-and-keyboard machine
// retains its full feature set. Phones (coarse primary pointer) have a
// tiered budget for resolution, geometry and lighting. Drivers without
// multi-draw also use instanced props to reduce submission cost.
//
import { DRAW_DISTANCE } from "../shared/constants";
import { safeMode } from "./safe-mode";

// Node tools import the world modules at load; there is no window there.
export const isCoarsePointer = (): boolean =>
  typeof window !== "undefined" && window.matchMedia("(pointer: coarse)").matches;

// Phones see a shorter world. Resident GPU memory scales with the AREA inside
// the draw distance, and a WebGL context lost to memory pressure is the one
// failure a phone cannot recover from — Chrome then blocks the domain for the
// session. 0.72 halves the resident tile ring (49 → 25 tiles) and the near
// fabric band; the skyline imposters keep their own reach, so the horizon
// still reads. Fog tracks the same scale so the cull edge stays hidden.
export const PHONE_REACH = 0.72;
// A device that already lost its context once holds a smaller world still.
export const SAFE_REACH = 0.55;
export const reachScale = (): number => {
  if (safeMode()) {
    return SAFE_REACH;
  }
  return isCoarsePointer() ? PHONE_REACH : 1;
};
export const drawDistance = (): number => Math.round(DRAW_DISTANCE * reachScale());

// The tier a phone may climb to. Tiers 0-1 are desktop resolution and the full
// model band; a phone that briefly measures fast enough would step into them,
// grow its resident set, and be the phone that loses its context ten minutes
// later. Boot starts below this and may rise to it, never past.
export const PHONE_TOP_TIER = 2;

// 2 = full sky (desktop look), 1 = halved counts + capped fog sheets,
// 0 = no marine-layer sheets at all (scene fog + sky still sell the haze).
export type CloudQuality = 0 | 1 | 2;

// NOTE on shadow sampling quality: three r184 removed PCFSoftShadowMap (the
// renderer coerces it to PCFShadowMap at render time), so every platform
// already runs plain PCF — there is no soft/hard sampling knob left to tier.
export interface QualityFeatures {
  // Render the shadow depth map every Nth frame (1 = every frame).
  readonly shadowEvery: number;
  // false = the sun casts no shadows at all (floor tier).
  readonly shadowCast: boolean;
  // Bake the Sky dome to a small cube texture instead of shading it per frame.
  readonly skyBake: boolean;
  readonly clouds: CloudQuality;
  // Fraction of the city's full-model band (city.ts DETAIL_DISTANCE) this tier
  // renders as MODELS; past it the box imposters take over. The one knob here
  // that cuts TRIANGLES instead of fill — and the one the mobile ladder was
  // missing entirely, which is how a phone at the floor tier still submitted
  // every triangle a desktop did.
  readonly detailScale: number;
}

export const FULL_QUALITY: QualityFeatures = {
  clouds: 2,
  detailScale: 1,
  shadowCast: true,
  shadowEvery: 1,
  skyBake: false,
};

// The live tier, published by the perf governor. The city streamer needs the
// geometry budget every frame from inside updateStreaming, which nothing hands
// a QualityFeatures — main.ts routes the tier to the SCENE (materials, sky,
// clouds), and the scene owns none of the world's LOD. Rather than thread a
// second parameter through the whole call chain, the contract module that
// already defines the tier shape also holds the current one.
let live: QualityFeatures = FULL_QUALITY;

export const setLiveQuality = (q: QualityFeatures): void => {
  live = q;
};

export const liveQuality = (): QualityFeatures => live;
