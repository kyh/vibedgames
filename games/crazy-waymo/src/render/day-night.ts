import * as THREE from "three";
import type { Sky } from "three/addons/objects/Sky.js";

import { setGradeNight } from "./grade";
import { NightSky } from "./night-sky";

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
  // Sky dome scattering: [turbidity, rayleigh, mieCoefficient, mieDirectionalG].
  // These belong to the cycle, not to scene construction — how much air the sun
  // is shining through is exactly what the hour is. See the presets below.
  readonly sky: readonly [number, number, number, number];
};

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
const SKY_DAY: readonly [number, number, number, number] = [2.0, 0.5, 0.0018, 0.8];
const SKY_GOLDEN: readonly [number, number, number, number] = [2.2, 0.62, 0.001, 0.62];
const SKY_SUNSET: readonly [number, number, number, number] = [3.0, 0.85, 0.0016, 0.68];
const SKY_NIGHT: readonly [number, number, number, number] = [2.0, 0.5, 0.002, 0.8];

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
  sky: readonly [number, number, number, number],
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
  //    p     sunEl sunAz  lightDir       color     int   hemiSky   hemiGnd   hInt  amb   ambColor  fog      near far  env   lamp  exp
  stop(0.00,  35,   115,   dir(35, 115),  0xfff6e0, 1.75, 0xa9dcff, 0x6b6852, 0.52, 0.13, 0xffffff, 0x86b4e2, 460, 960, 0.32, 0,    0.72, SKY_DAY),
  stop(0.25,  50,   150,   dir(50, 150),  0xfff2d8, 1.85, 0xa9dcff, 0x6b6852, 0.52, 0.13, 0xffffff, 0x7fb2e4, 480, 980, 0.32, 0,    0.72, SKY_DAY),
  // Golden hour is DAYLIGHT: sun still 12° up, blue sky, full-strength key.
  // The lamp factor used to open at 0.25 here, which lit the player's night
  // rig (a 70-candela spot plus two head sprites) under a noon-blue sky — the
  // single loudest thing in the most flattering frame the game has. Lamps now
  // wait for the sun to reach the horizon.
  stop(0.40,  12,   235,   dir(12, 235),  0xffc27a, 1.7,  0xffd9b0, 0x655c44, 0.42, 0.12, 0xffffff, 0xbf9a83, 430, 940, 0.26, 0,    0.68, SKY_GOLDEN),
  stop(0.47,   2,   248,   dir(4, 248),   0xff9350, 1.25, 0xff9d70, 0x3e3a44, 0.36, 0.11, 0xe0dcf0, 0xac7160, 400, 900, 0.18, 0.62, 0.68, SKY_SUNSET),
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
  stop(0.53,  -3,   255,   MOON,          0x8d92c0, 0.28, 0x6e6398, 0x2a2d38, 0.17, 0.27, 0xc8b0c4, 0x35446a, 380, 900, 0.05, 1,    0.66, SKY_NIGHT),
  stop(0.62, -30,   270,   MOON,          0x9b9ed6, 0.32, 0x5b4a80, 0x20242e, 0.18, 0.30, 0xc2a3bd, 0x1f2c52, 360, 880, 0.05, 1,    0.66, SKY_NIGHT),
  stop(0.80, -30,    60,   MOON,          0x9b9ed6, 0.32, 0x5b4a80, 0x20242e, 0.18, 0.30, 0xc2a3bd, 0x1f2c52, 360, 880, 0.05, 1,    0.66, SKY_NIGHT),
  stop(0.88,  -3,    95,   MOON,          0xc087a0, 0.30, 0x84719a, 0x2a2d38, 0.17, 0.27, 0xc9aabf, 0x4a4668, 380, 920, 0.05, 1,    0.66, SKY_NIGHT),
  stop(0.94,   4,   105,   dir(6, 105),   0xffb27a, 1.3,  0xffc9a0, 0x4a443c, 0.28, 0.10, 0xffffff, 0xba8f7a, 450, 980, 0.20, 0.45, 0.66, SKY_SUNSET),
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

  constructor(private refs: DayNightRefs) {}

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
    ambient.intensity = THREE.MathUtils.lerp(a.ambInt, b.ambInt, t);
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
    const nightAmt = THREE.MathUtils.smoothstep(-this.scrSun.y, 0.02, 0.12);
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

    scene.environmentIntensity = THREE.MathUtils.lerp(a.env, b.env, t);
    if (this.renderer) {
      this.renderer.toneMappingExposure = THREE.MathUtils.lerp(a.exposure, b.exposure, t);
    }
    this.lamp = THREE.MathUtils.lerp(a.lamp, b.lamp, t);
    // The post grade needs the cycle too, and has no per-frame call site of its
    // own — see render/grade.ts for why this is a signal and not a parameter.
    setGradeNight(this.lamp);
  }
}
