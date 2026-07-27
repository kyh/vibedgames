// Mobile quality contract shared by main, the perf governor and the scene.
//
// Desktop is sacred: every feature here defaults to FULL_QUALITY and the
// desktop tier table never deviates from it, so a mouse-and-keyboard machine
// renders exactly what it rendered before this module existed. Phones (coarse
// primary pointer) get a tiered feature ladder on top of the existing
// resolution stepper — fill rate and per-fragment lighting are what melt
// mobile GPUs, not draw calls.
//
// One deliberate exception, and it runs the other way: DESKTOP_NIGHT_FILL
// (below) makes the DESKTOP night darker than the phone's. It is not a cost
// tier — it is the one place the two device classes want a different picture
// rather than a different budget, and it is documented at the constant.

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
  // Fraction of the city's full-model band (city.ts DETAIL_DISTANCE) this tier
  // renders as MODELS; past it the box imposters take over. The one knob here
  // that cuts TRIANGLES instead of fill — and the one the mobile ladder was
  // missing entirely, which is how a phone at the floor tier still submitted
  // every triangle a desktop did.
  readonly detailScale: number;
};

export const FULL_QUALITY: QualityFeatures = {
  shadowEvery: 1,
  shadowCast: true,
  skyBake: false,
  clouds: 2,
  detailScale: 1,
};

// THE NIGHT FILL IS THE ONE THING DESKTOP AND PHONE GENUINELY DISAGREE ABOUT,
// and it is not a tier decision — it is a DEVICE-CLASS one, so it keys off the
// same coarse pointer the post chain does rather than off the governor's rung.
// Everything else in this module tiers GPU cost; this tiers the picture.
//
// The rung was measured and is the wrong axis. Walking the whole mobile ladder
// with `__perf.pin`, night, four street cameras and the bay vista, kit-facade
// median against sky median: FiDi 0.73 at every one of the five rungs, the
// Richmond 0.22 at every one, the Sunset 0.14–0.17, Market 0.35–0.38. The rungs
// differ in shadow cadence, sky bake, cloud sheets and model band — none of
// which touches an omnidirectional fill. A rung tracks how fast the GPU is;
// nothing in it tracks how bright the PANEL is.
//
// What the two branches do NOT share is the post chain: main.ts builds
// PostPipeline only for a fine pointer, so a phone renders the night with no
// bloom, no source mask, no split tone and no mid-tone dip (render/post.ts).
// That dip lands on the night SKY as well as on the pale facade band, which is
// why the same world measures a sky median of 4.3 on desktop and 14.5 on a
// phone — and why the phone's facades already sit UNDER its sky (0.73:1 at the
// worst camera) while the desktop's sat over it at 1.9:1. The criterion this
// constant exists for is already satisfied on the phone branch; cutting the
// phone's fill would buy nothing there and spend the readability floor for it.
// One number was serving two different paintings.
//
// 0.45 scales the night AMBIENT and the night ENVIRONMENT together (see
// day-night.ts for why those two and not the hemisphere). It is a night-only
// multiplier: it ramps in with the same below-horizon term that swaps in the
// night sky, so golden hour, sunset and dawn are untouched, and by day it is
// exactly 1 — the daylight frames are bit-identical, not merely close.
//
// HYPOTHESIS, STATED SO A DEVICE CHECK CAN FALSIFY IT: the phone floor exists
// because a dim phone outdoors cannot read a 0.45-fill scene, NOT because a
// phone needs more light than a desktop to look right. The experiment is a
// phone outdoors in daylight at half brightness, on a Richmond or Sunset street
// at night, with PHONE_NIGHT_FILL set to DESKTOP_NIGHT_FILL. If the kerbs, the
// near houses and oncoming traffic still separate, the floor is unnecessary and
// these two constants should collapse into one. If the street turns into an
// undifferentiated black field, the split is confirmed and PHONE_NIGHT_FILL
// stays 1 — which is today's shipped frame, unchanged to the bit. The number to
// watch is the share of near-facade pixels under luminance 2/100: 48% today on
// desktop in the Richmond, 66% at 0.45.
export const DESKTOP_NIGHT_FILL = 0.45;
export const PHONE_NIGHT_FILL = 1;

let nightFill: number | null = null;

/** Multiplier on the omnidirectional night fill for this device class. */
export function nightFillScale(): number {
  if (nightFill === null) {
    nightFill = isCoarsePointer() ? PHONE_NIGHT_FILL : DESKTOP_NIGHT_FILL;
  }
  return nightFill;
}

// The live tier, published by the perf governor. The city streamer needs the
// geometry budget every frame from inside updateStreaming, which nothing hands
// a QualityFeatures — main.ts routes the tier to the SCENE (materials, sky,
// clouds), and the scene owns none of the world's LOD. Rather than thread a
// second parameter through the whole call chain, the contract module that
// already defines the tier shape also holds the current one.
let live: QualityFeatures = FULL_QUALITY;

export function setLiveQuality(q: QualityFeatures): void {
  live = q;
}

export function liveQuality(): QualityFeatures {
  return live;
}
