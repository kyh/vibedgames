import * as THREE from "three";

import { setGradeNight, setGradeWarmth } from "./grade";
import { NightSky } from "./night-sky";
import { nightFillScale } from "./quality";
import type { Sky } from "./sky";

// Keyframed day-night lighting driven by REAL San Francisco time: the game
// clock IS the SF clock (America/Los_Angeles) — play at SF midnight and the
// city is night-lit, play at 7pm and you get the sunset. One phase value in
// [0,1) indexes hand-tuned stops; everything light-related interpolates
// between them: the Sky shader's sun, the shadow light (sun by day, a fixed
// moon direction by night), hemisphere/ambient fill, fog color and range,
// environment intensity, tone-mapping exposure, and the 0..1 lamp factor the
// streetlight glow / headlights ramp on.
//
// Directions are interpolated as VECTORS (lerp + normalize), never as
// elevation/azimuth pairs — angle lerping breaks at the 360° wrap when the
// light hands off from the setting sun to the moon.

const SF_TZ = "America/Los_Angeles";
const CLOCK_RESYNC_S = 1; // re-read the SF wall clock this often
const SHADOW_MIN_ELEV_Y = 0.09; // light dir y below this → shadows off (~5°)
const SHADOW_MIN_INT = 0.6;

function dir(elevDeg: number, azimDeg: number): THREE.Vector3 {
  return new THREE.Vector3().setFromSphericalCoords(
    1,
    THREE.MathUtils.degToRad(90 - elevDeg),
    THREE.MathUtils.degToRad(azimDeg),
  );
}

const MOON = dir(42, -40);

type Stop = {
  readonly p: number;
  readonly sunDir: THREE.Vector3; // the SKY's sun (goes below the horizon)
  readonly lightDir: THREE.Vector3; // the shadow light (sun, then moon)
  readonly lightColor: THREE.Color;
  readonly lightInt: number;
  readonly hemiSky: THREE.Color;
  readonly hemiGround: THREE.Color;
  readonly hemiInt: number;
  readonly ambInt: number;
  // Ambient TINT. White by day (an omnidirectional fill has no colour of its
  // own under the sun), cool blue after dark: a white fill preserves every
  // albedo's saturation exactly, which is why the parks and street trees used
  // to sit at full daylight green at midnight. Moonlight is the complement of
  // that green, so tinting the fill desaturates the foliage instead of
  // dimming the whole city to compensate.
  readonly ambColor: THREE.Color;
  readonly fog: THREE.Color;
  readonly fogNear: number;
  readonly fogFar: number;
  readonly env: number;
  readonly lamp: number; // streetlights/headlights 0 off .. 1 full
  readonly exposure: number;
  // Golden-hour warmth for the post grade (render/grade.ts setGradeWarmth):
  // 0 = neutral daylight, 1 = full gilded golden/sunset. Deliberately its own
  // channel — the lamp factor is 0 at golden hour BY DESIGN (lamps wait for
  // the horizon), so the warm grade cannot piggyback on it.
  readonly warmth: number;
  // Sky dome scattering:
  // [turbidity, rayleigh, mieCoefficient, mieDirectionalG, horizonRolloff].
  // These belong to the cycle, not to scene construction — how much air the sun
  // is shining through is exactly what the hour is. See the presets below.
  readonly sky: SkyPreset;
};

type SkyPreset = readonly [number, number, number, number, number];

// Sky dome scattering presets, referenced by name from the stop table so the
// numbers stay readable there.
//
// The dome was built once at scene construction with turbidity 2.5 / rayleigh
// 1.1 / mie 0.003 and never touched again. Measured against three alternatives
// at noon, golden hour and street level, LOWERING the scattering is what the
// frame wanted in every one of them: at rayleigh 0.5 the noon sky went from
// L218 saturation 14 to L184 saturation 30 with the blown-highlight share
// falling 7% -> 1%, and the hero vista from L214/17 to L175/35 at 9% -> 5%.
// (Raising rayleigh, the intuitive move for "deeper blue", does the opposite:
// three's Sky scales TOTAL scattering with it, so the dome just gets brighter
// and clips.) Golden hour keeps more turbidity — that haze IS the hour.
//
// The fourth number is mieDirectionalG, the forward-scattering anisotropy, and
// it is the one that decides whether you can drive INTO the sun. At the 0.85 the
// dome was built with, the low golden-hour sun projects a tight, near-white
// halo: looking WSW down the strait at 17:00 the Golden Gate — the map's single
// most recognisable landmark, 250u away — was completely invisible, 43% of the
// frame above 92% luminance. Loosening g spreads the same energy over a much
// wider arc, which reads as glare you can see through instead of a hole.
//
// The fifth number is the GRAZING-ANGLE ROLLOFF (render/sky.ts, the one patch
// on the vendored Preetham dome): the optical depth of the missing boundary-
// layer extinction at the horizon, in nepers. It is on the cycle rather than
// fixed because the defect it fixes and the thing it endangers move in
// opposite directions with the sun. By day the whole horizon RING is blown at
// every azimuth and wants the full cut; at sunset the only bright sky left in
// the frame IS the low glow within a few degrees of the setting sun, and the
// same cut would take the hour with it. Modelled over the hemisphere (mean
// sRGB grey out of 100 in the bottom 8 degrees / the share of it at or over
// 88): noon 93.2/86.6% -> 84.2/30.8% at 1.7, golden 79.4/28.5% -> 66.5/8.8%
// at 1.2, sunset 38.2/0.5% -> 32.4/0.0% at 0.55 — sunset was never blown, so
// it only gives up the clipping that was washing out its own oranges (2°
// elevation, into the sun, goes from a cream (234,226,191) to (223,212,165)).
const SKY_DAY: SkyPreset = [2.0, 0.5, 0.0018, 0.8, 1.7];
const SKY_GOLDEN: SkyPreset = [2.2, 0.62, 0.001, 0.62, 1.2];
const SKY_SUNSET: SkyPreset = [3.0, 0.85, 0.0016, 0.68, 0.55];
const SKY_NIGHT: SkyPreset = [2.0, 0.5, 0.002, 0.8, 0.55];

// THE SUN DISC IS AN ENERGY BOMB, and it was the whole of the into-sun
// blowout. three's Sky paints the disc at `sunE * 19000 * Fex * 0.04` while the
// sky 0.6° off it sits at 1.4 (golden hour) — measured pre-tonemap linear, the
// space the post chain works in. The disc is therefore ~85,000 at golden hour
// and ~322,000 at noon: a 60,000:1 contrast step, and above the 65,504 ceiling
// of the composer's HalfFloat target, so at noon it is literally +Inf.
//
// On its own that would be harmless — ACES clips a 5 and a 300,000 to the same
// white pixel. What is NOT harmless is that the bloom pass then blurs it: with
// the day cut at 3.0 the pyramid gets ~85,000 of headroom energy from a
// half-degree disc and smears it over a third of the screen. Measured, chase
// cam, golden hour, driving into the sun: 37.3% of the frame over 88%
// luminance with bloom on, 3.0% with bloom off (same camera, same world) — and
// the road under the veil went from an asphalt-black 0.11 to a milky 0.38. The
// sky gradient was never the defect; the flare from the disc was.
//
// So the disc gets scaled into the range everything else lives in. It still
// ACES-clips to a white-hot dot (anything over ~8 does) and it still sits well
// over the day bloom cut (render/post.ts, 6.5), so it keeps a real flare —
// just a bounded one. Measured across the same three golden-hour cameras, the
// blown share goes 2.8% at radiance 8 (no flare at all, and the hour stops
// reading), 4.5% at 400, 6.6% at 2000 — where the veil starts eating the
// facades beside the sun again. 400 is that curve's knee.
//
// The gain is derived per frame from the CURRENT `sunE` rather than fixed, so
// the disc holds one radiance from dawn to dusk instead of quadrupling at
// noon; per-pixel Fex still reddens and dims it near the horizon, which is the
// part that should change with the hour.
const SUN_DISC_RADIANCE = 400;
// three's Sky.js applies `showSunDisc` as a plain multiplier on the disc term,
// so a fractional value is the supported way to scale it. These two constants
// mirror the shader's own: the disc term is `vSunE * 19000 * Fex * 0.04`, and
// `vSunE` comes from its vertex-stage `sunIntensity(dot(sunDir, up))`.
const SUN_DISC_TERM = 19000 * 0.04;
const SUN_CUTOFF_ANGLE = 1.6110731556870734;
const SUN_STEEPNESS = 1.5;
const SUN_EE = 1000;

// Sky.js `sunIntensity`, given the sine of the sun's elevation. Zero once the
// sun is below the shader's cutoff — which is also where we want no disc at
// all, so the divide below is never near zero.
function sunIntensity(elevSin: number): number {
  const z = THREE.MathUtils.clamp(elevSin, -1, 1);
  return SUN_EE * Math.max(0, 1 - Math.exp(-(SUN_CUTOFF_ANGLE - Math.acos(z)) / SUN_STEEPNESS));
}

function sunDiscGain(elevSin: number): number {
  const e = sunIntensity(elevSin);
  return e > 1 ? Math.min(1, SUN_DISC_RADIANCE / (e * SUN_DISC_TERM)) : 0;
}

function stop(
  p: number,
  sunElev: number,
  sunAzim: number,
  light: THREE.Vector3,
  lightColor: number,
  lightInt: number,
  hemiSky: number,
  hemiGround: number,
  hemiInt: number,
  ambInt: number,
  ambColor: number,
  fog: number,
  fogNear: number,
  fogFar: number,
  env: number,
  lamp: number,
  exposure: number,
  warmth: number,
  sky: SkyPreset,
): Stop {
  return {
    p,
    sunDir: dir(sunElev, sunAzim),
    lightDir: light,
    lightColor: new THREE.Color(lightColor),
    lightInt,
    hemiSky: new THREE.Color(hemiSky),
    hemiGround: new THREE.Color(hemiGround),
    hemiInt,
    ambInt,
    ambColor: new THREE.Color(ambColor),
    fog: new THREE.Color(fog),
    fogNear,
    fogFar,
    env,
    lamp,
    exposure,
    warmth,
    sky,
  };
}

// AERIAL PERSPECTIVE, NOT BLEACH (grading pass 2026-07-26). The fog color used
// to be 0xbfdcf2 — luminance 0.86, barely a hue. Anything past the fog-near
// plane therefore lost its VALUE before it lost its detail, and the hero vistas
// measured a city band BRIGHTER than the sky above it (sky L84 / city L93 from
// the bay): the three-band read inverted, and no landmark survived. Distance
// now tints toward a SATURATED mid-value sky blue instead, so a far building
// goes blue-and-darker — it keeps its silhouette against a sky that stays the
// brightest thing in frame.
//
// The near plane also moved out (360 → ~470): at 600u the old grade was already
// 58% fog, which is two blocks downtown. The far plane deliberately stops just
// short of shared/constants DRAW_DISTANCE (900) — buildings are culled there, so
// pushing fogFar past it would trade a bleached city for a city with a visible
// edge. Fog color is the lever that mattered; range is only the assist.
// prettier-ignore
const STOPS: readonly Stop[] = [
  // Day stops (Mario-Kart pass 2026-07-10): brighter exposure, big blue-sky
  // hemisphere fill + warm ground bounce so shadow sides glow instead of
  // going grey. Sun eased down to keep the white sidewalks from clipping.
  //    p     sunEl sunAz  lightDir       color     int   hemiSky   hemiGnd   hInt  amb   ambColor  fog      near far  env   lamp  exp   warm
  stop(0.00,  35,   115,   dir(35, 115),  0xfff6e0, 1.75, 0xa9dcff, 0x6b6852, 0.52, 0.13, 0xffffff, 0x86b4e2, 460, 960, 0.32, 0,    0.72, 0.15, SKY_DAY),
  stop(0.25,  50,   150,   dir(50, 150),  0xfff2d8, 1.85, 0xa9dcff, 0x6b6852, 0.52, 0.13, 0xffffff, 0x7fb2e4, 480, 980, 0.32, 0,    0.72, 0.05, SKY_DAY),
  // Golden hour is DAYLIGHT: sun still 12° up, blue sky, full-strength key.
  // The lamp factor used to open at 0.25 here, which lit the player's night
  // rig (a 70-candela spot plus two head sprites) under a noon-blue sky — the
  // single loudest thing in the most flattering frame the game has. Lamps now
  // wait for the sun to reach the horizon.
  stop(0.40,  11,   235,   dir(11, 235),  0xffbe74, 1.9,  0xffd6a6, 0x6b5c40, 0.42, 0.12, 0xfff2e2, 0xc49a80, 430, 940, 0.26, 0,    0.70, 0.85, SKY_GOLDEN),
  stop(0.47,   2,   248,   dir(4, 248),   0xff9350, 1.25, 0xff9d70, 0x3e3a44, 0.36, 0.11, 0xe0dcf0, 0xac7160, 400, 900, 0.18, 0.62, 0.68, 1.0,  SKY_SUNSET),
  // Night floors are tuned for PHONES: a desktop panel at full brightness can
  // read a 0.3-fill scene, a dim phone outdoors cannot. Moonlight carries the
  // shape of the city; streetlight glow carries the color. The night ambient
  // intensities look large next to the daylight ones only because the tint
  // they multiply is dark — they hold the same LUMINANCE the white fill had.
  //
  // Every night tint has RED at or above GREEN. That is the whole trick behind
  // the desaturated parks: a plain blue moonlight (0x8aa0d0 and friends) still
  // carries more green than red, so it AMPLIFIES a green albedo and the
  // foliage stays as vivid at midnight as it is at noon — only darker. Sitting
  // the fills on the green's complement instead pulls the grass and the trees
  // toward a cool neutral while the hue of the scene stays night-blue.
  //
  // THE NIGHT FILLS ARE NOT A DIMMER, THEY ARE THE VALUE ORDER. Measured at
  // 1280x720 before this pass: a SoMa chase frame read sky L15 / facade band
  // L17 / ground band L23, and a Mission one sky L33 / L43 / L44. The largest
  // surfaces in the frame were also its brightest and nothing above them was —
  // the inversion the gate called out. A white kit facade is albedo ~0.85, so
  // an omnidirectional fill of 0.49 hands it 0.4 linear all by itself, which is
  // a LIT wall no matter what colour you tint it.
  //
  // The fills are therefore roughly halved: the unlit side of the city now
  // lands under the night sky, and what you see at 10 metres has to be a
  // SOURCE — a lit window, a lamp pool, a headlight, a shop front. Those got
  // brighter in the same pass (fx/night-windows.ts, fx/lamp-glow.ts) and the
  // bloom threshold now ramps down after dark (render/post.ts), so the frame
  // keeps its total energy; it just moved from diffuse to emissive.
  //
  // Every night tint still keeps RED at or above GREEN (see above) and the
  // moon stays the only directional — halving it costs shape, so it falls less
  // than the fills do.
  stop(0.53,  -3,   255,   MOON,          0x8d92c0, 0.28, 0x6e6398, 0x2a2d38, 0.17, 0.27, 0xc8b0c4, 0x35446a, 380, 900, 0.05, 1,    0.66, 0.3,  SKY_NIGHT),
  stop(0.62, -30,   270,   MOON,          0x9b9ed6, 0.32, 0x5b4a80, 0x20242e, 0.18, 0.30, 0xc2a3bd, 0x1f2c52, 360, 880, 0.05, 1,    0.66, 0,    SKY_NIGHT),
  stop(0.80, -30,    60,   MOON,          0x9b9ed6, 0.32, 0x5b4a80, 0x20242e, 0.18, 0.30, 0xc2a3bd, 0x1f2c52, 360, 880, 0.05, 1,    0.66, 0,    SKY_NIGHT),
  stop(0.88,  -3,    95,   MOON,          0xc087a0, 0.30, 0x84719a, 0x2a2d38, 0.17, 0.27, 0xc9aabf, 0x4a4668, 380, 920, 0.05, 1,    0.66, 0.1,  SKY_NIGHT),
  stop(0.94,   4,   105,   dir(6, 105),   0xffb27a, 1.3,  0xffc9a0, 0x4a443c, 0.28, 0.10, 0xffffff, 0xba8f7a, 450, 980, 0.20, 0.45, 0.66, 0.8,  SKY_SUNSET),
];

// SF wall-clock hour (fractional, 0..24) right now. Intl handles DST; some
// engines report midnight as "24", hence the modulo. The formatter is hoisted:
// constructing Intl.DateTimeFormat is the expensive part (locale + tz data),
// and this runs once a second for the whole session.
const SF_CLOCK = new Intl.DateTimeFormat("en-US", {
  timeZone: SF_TZ,
  hour: "numeric",
  minute: "numeric",
  second: "numeric",
  hour12: false,
});

function sfHourNow(): number {
  const parts = SF_CLOCK.formatToParts(new Date());
  let h = 0;
  let m = 0;
  let s = 0;
  for (const p of parts) {
    if (p.type === "hour") h = Number(p.value);
    else if (p.type === "minute") m = Number(p.value);
    else if (p.type === "second") s = Number(p.value);
  }
  return (h % 24) + m / 60 + s / 3600;
}

// SF clock hour → cycle phase, piecewise-linear between anchors. A stylized
// fixed solar day (no seasonal sunset drift): sunset lands ~18:30–19:30,
// full night 21:00–05:00, dawn ~06:00, sunrise ~06:45.
// Phases are written monotonically over hours 5 → 29 (5am wrap) and taken
// mod 1, so interpolation never runs backwards through the cycle.
const HOUR_ANCHORS: readonly (readonly [number, number])[] = [
  [5.0, 0.84], // pre-dawn dark
  [6.0, 0.88], // dawn colors
  [6.75, 0.94], // sunrise
  [8.0, 1.0], // morning (phase 0)
  [13.0, 1.25], // afternoon
  [17.0, 1.4], // golden hour
  [18.5, 1.47], // sunset
  [19.5, 1.53], // dusk
  [21.0, 1.62], // night
  [29.0, 1.8], // 05:00 next day — late night holds
];

function hourToPhase(hour: number): number {
  const h = hour < 5 ? hour + 24 : hour;
  for (let i = 0; i + 1 < HOUR_ANCHORS.length; i++) {
    const a = HOUR_ANCHORS[i];
    const b = HOUR_ANCHORS[i + 1];
    if (!a || !b || h > b[0]) continue;
    const t = (h - a[0]) / (b[0] - a[0]);
    return (a[1] + (b[1] - a[1]) * Math.min(1, Math.max(0, t))) % 1;
  }
  return 0.8;
}

// ?time= override: pins the cycle to a chosen hour instead of the SF clock.
// Presets are HOURS (not phases) so `?time=sunset` and `?time=18:30` are the
// same thing by construction — both go through hourToPhase.
const TIME_PRESETS: Readonly<Record<string, number>> = {
  dawn: 6,
  sunrise: 6.75,
  morning: 8,
  noon: 12,
  afternoon: 15,
  golden: 17,
  sunset: 18.5,
  dusk: 19.5,
  night: 22,
  midnight: 0,
};

// Accepts a preset name, "HH:MM", "7pm"/"7:30pm", or a fractional hour 0-24.
// Returns the hour, or null if the string parses as none of them.
export function parseTimeParam(raw: string): number | null {
  const s = raw.trim().toLowerCase();
  const preset = TIME_PRESETS[s];
  if (preset !== undefined) return preset;
  const ampm = /^(\d{1,2})(?::([0-5]\d))?(am|pm)$/.exec(s);
  if (ampm) {
    const [, hh = "", mm = "0", ap] = ampm;
    const h12 = Number(hh);
    if (h12 < 1 || h12 > 12) return null;
    return (h12 % 12) + (ap === "pm" ? 12 : 0) + Number(mm) / 60;
  }
  const clock = /^(\d{1,2}):([0-5]\d)$/.exec(s);
  if (clock) {
    const [, hh = "", mm = "0"] = clock;
    const h = Number(hh);
    return h <= 23 ? h + Number(mm) / 60 : null;
  }
  const n = Number(s);
  return s !== "" && Number.isFinite(n) && n >= 0 && n <= 24 ? n % 24 : null;
}

export type DayNightRefs = {
  readonly sky: Sky;
  readonly sun: THREE.DirectionalLight;
  readonly hemi: THREE.HemisphereLight;
  readonly ambient: THREE.AmbientLight;
  readonly fog: THREE.Fog;
  readonly scene: THREE.Scene;
};

export class DayNight {
  // Read by game-scene.updateSun each frame (replaces the old fixed offset).
  readonly sunOffset = new THREE.Vector3(0, 90, 0);
  // 0 day .. 1 full night-lighting (streetlights, headlights, cloud dimming).
  lamp = 0;
  // False when shadows are fully faded — the render loop skips the shadow
  // pass entirely (the last daylight depth map stays bound but invisible).
  shadowsActive = true;

  private phase = hourToPhase(sfHourNow());
  private override: number | null = null; // debug freeze (setPhase)
  private sinceSync = CLOCK_RESYNC_S;
  private renderer: THREE.WebGLRenderer | null = null;
  private prevShadowsActive = true; // renderer boots with autoUpdate on
  // Mobile tiers: a baked cube texture stands in for the live Sky dome
  // (owned by game-scene, which re-bakes as the phase drifts).
  private baked: THREE.Texture | null = null;
  private nightSky = new NightSky();
  // Scratch (update runs every frame — no allocation).
  private scrSun = new THREE.Vector3();
  private scrLight = new THREE.Vector3();
  private scrColor = new THREE.Color();
  private scrBg = new THREE.Color();

  // ?time= pins the cycle for the session (editor and trailer setPhase calls
  // still win — they run later). Invalid values fall back to the SF clock.
  constructor(private refs: DayNightRefs) {
    const raw = new URLSearchParams(window.location.search).get("time");
    if (raw === null) return;
    const hour = parseTimeParam(raw);
    if (hour !== null) {
      this.override = hourToPhase(hour);
    } else {
      console.warn(
        `?time=${raw}: expected a preset (${Object.keys(TIME_PRESETS).join(", ")}), "HH:MM", "7pm", or an hour 0-24`,
      );
    }
  }

  attachRenderer(renderer: THREE.WebGLRenderer): void {
    this.renderer = renderer;
  }

  // Baked-sky mode (mobile tiers): draw `tex` as the scene background and
  // keep the live dome out of the draw list. null returns to the live dome.
  // The full-night flat-navy swap below still wins while it lasts.
  setBakedBackground(tex: THREE.Texture | null): void {
    this.baked = tex;
  }

  // Debug: pin the cycle to a phase (breaks the SF-clock link for the session).
  setPhase(p: number): void {
    this.override = ((p % 1) + 1) % 1;
  }

  getPhase(): number {
    return this.phase;
  }

  update(dt: number): void {
    if (this.override !== null) {
      this.phase = this.override;
    } else {
      // The phase moves ~1e-5 per real second — re-reading the wall clock
      // once a second is smooth AND survives tab suspends for free.
      this.sinceSync += dt;
      if (this.sinceSync >= CLOCK_RESYNC_S) {
        this.sinceSync = 0;
        this.phase = hourToPhase(sfHourNow());
      }
    }
    const p = this.phase;

    // Bracketing stops (cyclic).
    let ai = STOPS.length - 1;
    for (let i = 0; i < STOPS.length; i++) {
      const s = STOPS[i];
      if (s && s.p <= p) ai = i;
    }
    const a = STOPS[ai];
    const b = STOPS[(ai + 1) % STOPS.length];
    if (!a || !b) return;
    const span = (b.p - a.p + 1) % 1 || 1;
    const raw = ((p - a.p + 1) % 1) / span;
    const t = THREE.MathUtils.smoothstep(raw, 0, 1);

    const { sky, sun, hemi, ambient, fog, scene } = this.refs;

    // Sky sun (below-horizon values give the Sky shader real twilight) and the
    // dome's own scattering for this hour.
    this.scrSun.lerpVectors(a.sunDir, b.sunDir, t).normalize();
    const skyU = sky.material.uniforms;
    const sunU = skyU.sunPosition;
    if (sunU && sunU.value instanceof THREE.Vector3) sunU.value.copy(this.scrSun);
    const turb = skyU.turbidity;
    const rayl = skyU.rayleigh;
    const mieC = skyU.mieCoefficient;
    const mieG = skyU.mieDirectionalG;
    if (turb) turb.value = THREE.MathUtils.lerp(a.sky[0], b.sky[0], t);
    if (rayl) rayl.value = THREE.MathUtils.lerp(a.sky[1], b.sky[1], t);
    if (mieC) mieC.value = THREE.MathUtils.lerp(a.sky[2], b.sky[2], t);
    if (mieG) mieG.value = THREE.MathUtils.lerp(a.sky[3], b.sky[3], t);
    const roll = skyU.horizonRolloff;
    if (roll) roll.value = THREE.MathUtils.lerp(a.sky[4], b.sky[4], t);
    const disc = skyU.showSunDisc;
    if (disc) disc.value = sunDiscGain(this.scrSun.y);

    // How far past the horizon the sun is, 0..1 — the "after dark" term. It
    // swaps in the night sky dome (below) and scales the night fill (see
    // NIGHT IS NOT A DIMMER, further down). Deliberately NOT the lamp factor:
    // lamps come on at sunset, while a fill cut applied to a sunset would take
    // the hour's own light with it.
    const nightAmt = THREE.MathUtils.smoothstep(-this.scrSun.y, 0.02, 0.12);
    // Device-class night fill (render/quality.ts). 1 by day at every hour and
    // on every phone, so this multiplication is an identity everywhere except
    // a desktop after dark.
    const fill = 1 + (nightFillScale() - 1) * nightAmt;

    // Shadow light: direction, color, intensity. Shadows FADE via
    // shadow.intensity instead of toggling castShadow — flipping castShadow
    // at runtime (with shadowMap.autoUpdate managed manually) rebinds a stale
    // depth texture and floods GL_INVALID_OPERATION sampler-mismatch warnings.
    this.scrLight.lerpVectors(a.lightDir, b.lightDir, t).normalize();
    this.sunOffset.copy(this.scrLight).multiplyScalar(90);
    sun.color.lerpColors(a.lightColor, b.lightColor, t);
    const lightInt = THREE.MathUtils.lerp(a.lightInt, b.lightInt, t);
    sun.intensity = lightInt;
    const shadowRamp =
      THREE.MathUtils.smoothstep(lightInt, SHADOW_MIN_INT, SHADOW_MIN_INT + 0.4) *
      THREE.MathUtils.smoothstep(this.scrLight.y, SHADOW_MIN_ELEV_Y, SHADOW_MIN_ELEV_Y + 0.08);
    // 0.82 cap: full-black contact shadows read photographic; MK shadows stay
    // colorful because sky fill leaks in.
    sun.shadow.intensity = shadowRamp * 0.82;
    this.shadowsActive = shadowRamp > 0.01;
    // Faded out (night): stop re-rendering the depth map every frame — the
    // last daylight map stays bound (castShadow stays true, see above) but
    // intensity 0 makes it invisible. One forced update on the dawn flip.
    // The OFF flip is gated on a real depth map existing: pausing the pass
    // before the FIRST shadow render (night boots) leaves receive-shadow
    // programs bound to a texture that never materializes — the exact
    // GL_INVALID_OPERATION sampler mismatch described above, which silently
    // kills every draw that samples it.
    if (this.renderer && this.shadowsActive !== this.prevShadowsActive) {
      if (this.shadowsActive) {
        this.prevShadowsActive = true;
        this.renderer.shadowMap.autoUpdate = true;
        this.renderer.shadowMap.needsUpdate = true;
      } else if (this.refs.sun.shadow.map) {
        this.prevShadowsActive = false;
        this.renderer.shadowMap.autoUpdate = false;
      }
      // else: no map rendered yet — keep the pass running until one exists.
    }

    hemi.color.lerpColors(a.hemiSky, b.hemiSky, t);
    hemi.groundColor.lerpColors(a.hemiGround, b.hemiGround, t);
    hemi.intensity = THREE.MathUtils.lerp(a.hemiInt, b.hemiInt, t);
    // NIGHT IS NOT A DIMMER, PART TWO: the fill that survived the halving is
    // still what paints a near wall. Measured through per-camera stencils
    // (kit facades vs sky) on a FiDi chase frame at 1280x720: facade median
    // 8.24 against a sky median of 4.71 — 1.75:1 the wrong way round, while
    // the Richmond control reads 0.60:1. Zeroing the AmbientLight takes that
    // 8.24 to 2.75; zeroing the environment takes it to 5.10; zeroing the
    // hemisphere takes it to 7.84 and the moon moves it not at all. So the
    // omnidirectional pair is the whole defect, and the environment half is
    // literally a dimmed day — the env cube is a DAYLIGHT sky (game-scene
    // applyEnvironment: #7fb2e0 zenith, #dde6ea horizon) still shining at
    // midnight. Both get the same multiplier; the hemisphere keeps its full
    // value because it is worth 0.4 of the 8.24 and it is the only fill that
    // carries an up/down gradient at all.
    //
    // At quality.ts's desktop 0.45 the same frame reads 3.53 against 4.31 —
    // 0.82:1, the inversion — Market goes 0.88:1 -> 0.39:1, and the two
    // residential controls that were already right only get righter (Richmond
    // 0.60 -> 0.20, Sunset 1.00 -> 0.45). The moon still carries the shape:
    // what the cut takes away is the part of a wall that no light source in
    // the frame accounts for.
    ambient.intensity = THREE.MathUtils.lerp(a.ambInt, b.ambInt, t) * fill;
    ambient.color.lerpColors(a.ambColor, b.ambColor, t);

    fog.color.copy(this.scrColor.lerpColors(a.fog, b.fog, t));
    fog.near = THREE.MathUtils.lerp(a.fogNear, b.fogNear, t);
    fog.far = THREE.MathUtils.lerp(a.fogFar, b.fogFar, t);

    // Night sky: the physical Sky shader is plain BLACK once the sun sets —
    // the horizon used to read as a hole in the world. Below the horizon,
    // swap to the night dome (render/night-sky.ts): a zenith-darkening gradient
    // and a star field painted onto the CALLER's fog color, so the fog line
    // still meets it seamlessly while the upper half of the frame stops being
    // one dead value. Falls back to that flat navy where there is no canvas.
    if (nightAmt >= 1) {
      sky.visible = false;
      scene.background =
        this.nightSky.texture(fog.color) ?? this.scrBg.copy(fog.color).multiplyScalar(0.72);
    } else if (this.baked) {
      sky.visible = false;
      scene.background = this.baked;
    } else {
      sky.visible = true;
      scene.background = null;
    }

    scene.environmentIntensity = THREE.MathUtils.lerp(a.env, b.env, t) * fill;
    if (this.renderer) {
      this.renderer.toneMappingExposure = THREE.MathUtils.lerp(a.exposure, b.exposure, t);
    }
    this.lamp = THREE.MathUtils.lerp(a.lamp, b.lamp, t);
    // The post grade needs the cycle too, and has no per-frame call site of its
    // own — see render/grade.ts for why these are signals and not parameters.
    setGradeNight(this.lamp);
    setGradeWarmth(THREE.MathUtils.lerp(a.warmth, b.warmth, t));
  }
}
