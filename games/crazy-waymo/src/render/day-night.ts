import * as THREE from "three";
import type { Sky } from "three/addons/objects/Sky.js";

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
  readonly fog: THREE.Color;
  readonly fogNear: number;
  readonly fogFar: number;
  readonly env: number;
  readonly lamp: number; // streetlights/headlights 0 off .. 1 full
  readonly exposure: number;
};

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
  fog: number,
  fogNear: number,
  fogFar: number,
  env: number,
  lamp: number,
  exposure: number,
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
    fog: new THREE.Color(fog),
    fogNear,
    fogFar,
    env,
    lamp,
    exposure,
  };
}

// prettier-ignore
const STOPS: readonly Stop[] = [
  //    p     sunEl sunAz  lightDir       color     int   hemiSky   hemiGnd   hInt  amb   fog      near far  env   lamp  exp
  stop(0.00,  35,   115,   dir(35, 115),  0xfff6e0, 1.9,  0xbfe0ff, 0x4a4a3e, 0.35, 0.08, 0xbcd7ea, 360, 800, 0.32, 0,    0.62),
  stop(0.25,  50,   150,   dir(50, 150),  0xfff2d8, 2.0,  0xbfe0ff, 0x4a4a3e, 0.35, 0.08, 0xbcd7ea, 360, 800, 0.32, 0,    0.62),
  stop(0.40,  12,   235,   dir(12, 235),  0xffc27a, 1.8,  0xffd9b0, 0x57503e, 0.30, 0.09, 0xe3c19b, 330, 760, 0.26, 0.25, 0.68),
  stop(0.47,   2,   248,   dir(4, 248),   0xff9350, 1.25, 0xff9d70, 0x3e3a44, 0.28, 0.10, 0xcf9077, 300, 700, 0.18, 0.7,  0.70),
  stop(0.53,  -3,   255,   MOON,          0x7d8fc0, 0.18, 0x5a6f9e, 0x232630, 0.24, 0.13, 0x55688c, 300, 740, 0.10, 1,    0.64),
  stop(0.62, -30,   270,   MOON,          0x8aa0d0, 0.32, 0x35486b, 0x191d26, 0.22, 0.15, 0x2c3a57, 280, 700, 0.06, 1,    0.56),
  stop(0.80, -30,    60,   MOON,          0x8aa0d0, 0.32, 0x35486b, 0x191d26, 0.22, 0.15, 0x2c3a57, 280, 700, 0.06, 1,    0.56),
  stop(0.88,  -3,    95,   MOON,          0xc087a0, 0.20, 0x7a6f95, 0x232630, 0.24, 0.13, 0x6d6787, 300, 760, 0.10, 1,    0.62),
  stop(0.94,   4,   105,   dir(6, 105),   0xffb27a, 1.3,  0xffc9a0, 0x4a443c, 0.28, 0.10, 0xdbb090, 360, 860, 0.20, 0.5,  0.66),
];

// SF wall-clock hour (fractional, 0..24) right now. Intl handles DST; some
// engines report midnight as "24", hence the modulo.
function sfHourNow(): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: SF_TZ,
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
    hour12: false,
  }).formatToParts(new Date());
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
  // Scratch (update runs every frame — no allocation).
  private scrSun = new THREE.Vector3();
  private scrLight = new THREE.Vector3();
  private scrColor = new THREE.Color();

  constructor(private refs: DayNightRefs) {}

  attachRenderer(renderer: THREE.WebGLRenderer): void {
    this.renderer = renderer;
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

    // Sky sun (below-horizon values give the Sky shader real twilight).
    this.scrSun.lerpVectors(a.sunDir, b.sunDir, t).normalize();
    const sunU = sky.material.uniforms.sunPosition;
    if (sunU && sunU.value instanceof THREE.Vector3) sunU.value.copy(this.scrSun);

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
    sun.shadow.intensity = shadowRamp;
    this.shadowsActive = shadowRamp > 0.01;

    hemi.color.lerpColors(a.hemiSky, b.hemiSky, t);
    hemi.groundColor.lerpColors(a.hemiGround, b.hemiGround, t);
    hemi.intensity = THREE.MathUtils.lerp(a.hemiInt, b.hemiInt, t);
    ambient.intensity = THREE.MathUtils.lerp(a.ambInt, b.ambInt, t);

    fog.color.copy(this.scrColor.lerpColors(a.fog, b.fog, t));
    fog.near = THREE.MathUtils.lerp(a.fogNear, b.fogNear, t);
    fog.far = THREE.MathUtils.lerp(a.fogFar, b.fogFar, t);

    scene.environmentIntensity = THREE.MathUtils.lerp(a.env, b.env, t);
    if (this.renderer) {
      this.renderer.toneMappingExposure = THREE.MathUtils.lerp(a.exposure, b.exposure, t);
    }
    this.lamp = THREE.MathUtils.lerp(a.lamp, b.lamp, t);
  }
}
