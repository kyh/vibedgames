import * as THREE from "three";

import { reachScale } from "./quality";

import { setGradeNight, setGradeWarmth } from "./grade";
import { NightSky } from "./night-sky";
import type { Sky } from "./sky";

const SF_TZ = "America/Los_Angeles";
const CLOCK_RESYNC_S = 1;
const SHADOW_MIN_ELEV_Y = 0.09;
const SHADOW_MIN_INT = 0.6;

const dir = (elevDeg: number, azimDeg: number) =>
  new THREE.Vector3().setFromSphericalCoords(
    1,
    THREE.MathUtils.degToRad(90 - elevDeg),
    THREE.MathUtils.degToRad(azimDeg),
  );

const MOON = dir(42, -40);

interface Stop {
  readonly p: number;
  readonly sunDir: THREE.Vector3;
  readonly lightDir: THREE.Vector3;
  readonly lightColor: THREE.Color;
  readonly lightInt: number;
  readonly hemiSky: THREE.Color;
  readonly hemiGround: THREE.Color;
  readonly hemiInt: number;
  readonly ambInt: number;
  readonly ambColor: THREE.Color;
  readonly fog: THREE.Color;
  readonly fogNear: number;
  readonly fogFar: number;
  readonly env: number;
  readonly lamp: number;
  readonly exposure: number;
  readonly warmth: number;
  readonly sky: SkyPreset;
}

type SkyPreset = readonly [number, number, number, number, number];

const SKY_DAY: SkyPreset = [2, 0.5, 0.0018, 0.8, 1.7];
const SKY_GOLDEN: SkyPreset = [4, 0.45, 0.0022, 0.66, 1.2];
const SKY_SUNSET: SkyPreset = [3, 0.85, 0.0016, 0.68, 0.55];
const SKY_NIGHT: SkyPreset = [2, 0.5, 0.002, 0.8, 0.55];

const SUN_DISC_RADIANCE = 400;
const SUN_DISC_TERM = 19_000 * 0.04;
const SUN_CUTOFF_ANGLE = 1.6110731556870734;
const SUN_STEEPNESS = 1.5;
const SUN_EE = 1000;

const sunIntensity = (elevSin: number) => {
  const z = THREE.MathUtils.clamp(elevSin, -1, 1);

  return SUN_EE * Math.max(0, 1 - Math.exp(-(SUN_CUTOFF_ANGLE - Math.acos(z)) / SUN_STEEPNESS));
};

const sunDiscGain = (elevSin: number) => {
  const e = sunIntensity(elevSin);

  return e > 1 ? Math.min(1, SUN_DISC_RADIANCE / (e * SUN_DISC_TERM)) : 0;
};

const stop = (
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
) => ({
  ambColor: new THREE.Color(ambColor),
  ambInt,
  env,
  exposure,
  fog: new THREE.Color(fog),
  fogFar,
  fogNear,
  hemiGround: new THREE.Color(hemiGround),
  hemiInt,
  hemiSky: new THREE.Color(hemiSky),
  lamp,
  lightColor: new THREE.Color(lightColor),
  lightDir: light,
  lightInt,
  p,
  sky,
  sunDir: dir(sunElev, sunAzim),
  warmth,
});

// prettier-ignore
const STOPS: readonly Stop[] = [
  stop(0,  35,   115,   dir(35, 115),  0xff_f6_e0, 1.75, 0xa9_dc_ff, 0x7a_6c_8c, 0.62, 0.15, 0xff_ff_ff, 0x86_b4_e2, 460, 960, 0.32, 0,    0.72, 0.15, SKY_DAY),
  stop(0.25,  50,   150,   dir(50, 150),  0xff_f2_d8, 1.85, 0xa9_dc_ff, 0x7a_6c_8c, 0.62, 0.15, 0xff_ff_ff, 0x7f_b2_e4, 480, 980, 0.32, 0,    0.72, 0.05, SKY_DAY),
  stop(0.4,   9,   235,   dir(9, 235),   0xff_a8_60, 1.9,  0xff_d6_a6, 0x6b_5c_40, 0.48, 0.12, 0xff_f2_e2, 0xc4_9a_80, 430, 940, 0.26, 0,    0.76, 1,  SKY_GOLDEN),
  stop(0.47,   2,   248,   dir(4, 248),   0xff_93_50, 1.25, 0xff_9d_70, 0x3e_3a_44, 0.36, 0.11, 0xe0_dc_f0, 0xac_71_60, 400, 900, 0.18, 0.62, 0.68, 1,  SKY_SUNSET),
  stop(0.53,  -3,   255,   MOON,          0x8d_92_c0, 0.48, 0x9d_ad_d4, 0x38_42_59, 0.52, 0.27, 0xc8_b0_c4, 0x35_44_6a, 380, 900, 0.055, 1,   0.75, 0.3,  SKY_NIGHT),
  stop(0.62, -30,   270,   MOON,          0x9b_9e_d6, 0.55, 0x9a_ad_d8, 0x38_42_59, 0.6, 0.3, 0xc2_a3_bd, 0x1f_2c_52, 360, 880, 0.055, 1,   0.78, 0,    SKY_NIGHT),
  stop(0.8, -30,    60,   MOON,          0x9b_9e_d6, 0.55, 0x9a_ad_d8, 0x38_42_59, 0.6, 0.3, 0xc2_a3_bd, 0x1f_2c_52, 360, 880, 0.055, 1,   0.78, 0,    SKY_NIGHT),
  stop(0.88,  -3,    95,   MOON,          0xc0_87_a0, 0.48, 0xaa_a4_d0, 0x38_42_59, 0.52, 0.27, 0xc9_aa_bf, 0x4a_46_68, 380, 920, 0.055, 1,   0.75, 0.1,  SKY_NIGHT),
  stop(0.94,   4,   105,   dir(6, 105),   0xff_b2_7a, 1.3,  0xff_c9_a0, 0x4a_44_3c, 0.28, 0.1, 0xff_ff_ff, 0xba_8f_7a, 450, 980, 0.2, 0.45, 0.66, 0.8,  SKY_SUNSET),
];

const SF_CLOCK = new Intl.DateTimeFormat("en-US", {
  hour: "numeric",
  hour12: false,
  minute: "numeric",
  second: "numeric",
  timeZone: SF_TZ,
});

const sfHourNow = () => {
  const parts = SF_CLOCK.formatToParts(new Date());
  let h = 0;
  let m = 0;
  let s = 0;

  for (const p of parts) {
    if (p.type === "hour") {
      h = Number(p.value);
    } else if (p.type === "minute") {
      m = Number(p.value);
    } else if (p.type === "second") {
      s = Number(p.value);
    }
  }

  return (h % 24) + m / 60 + s / 3600;
};

const HOUR_ANCHORS: readonly (readonly [number, number])[] = [
  [5, 0.84],
  [6, 0.88],
  [6.75, 0.94],
  [8, 1],
  [13, 1.25],
  [17, 1.4],
  [18.5, 1.47],
  [19.5, 1.53],
  [21, 1.62],
  [29, 1.8],
];

const hourToPhase = (hour: number) => {
  const h = hour < 5 ? hour + 24 : hour;

  for (let i = 0; i + 1 < HOUR_ANCHORS.length; i += 1) {
    const a = HOUR_ANCHORS[i];
    const b = HOUR_ANCHORS[i + 1];

    if (!a || !b || h > b[0]) {
      continue;
    }

    const t = (h - a[0]) / (b[0] - a[0]);

    return (a[1] + (b[1] - a[1]) * Math.min(1, Math.max(0, t))) % 1;
  }

  return 0.8;
};

const phaseToHour = (phase: number) => {
  const [first] = HOUR_ANCHORS;
  const q = first && phase < first[1] ? phase + 1 : phase;

  for (let i = 0; i + 1 < HOUR_ANCHORS.length; i += 1) {
    const a = HOUR_ANCHORS[i];
    const b = HOUR_ANCHORS[i + 1];

    if (!a || !b || q > b[1]) {
      continue;
    }

    const t = (q - a[1]) / (b[1] - a[1]);

    return (a[0] + (b[0] - a[0]) * Math.min(1, Math.max(0, t))) % 24;
  }

  return 12;
};

const TIME_PRESETS: ReadonlyMap<string, number> = new Map([
  ["dawn", 6],
  ["sunrise", 6.75],
  ["morning", 8],
  ["noon", 12],
  ["afternoon", 15],
  ["golden", 17],
  ["sunset", 18.5],
  ["dusk", 19.5],
  ["night", 22],
  ["midnight", 0],
]);

export const parseTimeParam = (raw: string) => {
  const s = raw.trim().toLowerCase();
  const preset = TIME_PRESETS.get(s);

  if (preset !== undefined) {
    return preset;
  }

  const ampm = /^(?<hour>\d{1,2})(?::(?<minute>[0-5]\d))?(?<meridiem>am|pm)$/u.exec(s)?.groups;

  if (ampm) {
    const h12 = Number(ampm.hour ?? "");

    if (h12 < 1 || h12 > 12) {
      return null;
    }

    return (h12 % 12) + (ampm.meridiem === "pm" ? 12 : 0) + Number(ampm.minute ?? "0") / 60;
  }

  const clock = /^(?<hour>\d{1,2}):(?<minute>[0-5]\d)$/u.exec(s)?.groups;

  if (clock) {
    const h = Number(clock.hour ?? "");

    return h <= 23 ? h + Number(clock.minute ?? "0") / 60 : null;
  }

  const n = Number(s);

  return s !== "" && Number.isFinite(n) && n >= 0 && n <= 24 ? n % 24 : null;
};

export interface DayNightRefs {
  readonly sky: Sky;
  readonly sun: THREE.DirectionalLight;
  readonly hemi: THREE.HemisphereLight;
  readonly ambient: THREE.AmbientLight;
  readonly fog: THREE.Fog;
  readonly scene: THREE.Scene;
}

export class DayNight {
  readonly sunOffset = new THREE.Vector3(0, 90, 0);
  lamp = 0;
  shadowsActive = true;

  private phase = hourToPhase(sfHourNow());
  private override: number | null = null;
  private sinceSync = CLOCK_RESYNC_S;
  private renderer: THREE.WebGLRenderer | null = null;
  private prevShadowsActive = true;
  private baked: THREE.Texture | null = null;
  private nightSky = new NightSky();
  private scrSun = new THREE.Vector3();
  private scrLight = new THREE.Vector3();
  private scrColor = new THREE.Color();
  private scrBg = new THREE.Color();

  private refs: DayNightRefs;

  constructor(refs: DayNightRefs) {
    this.refs = refs;
    const raw = new URLSearchParams(window.location.search).get("time");

    if (raw === null) {
      return;
    }

    const hour = parseTimeParam(raw);

    if (hour === null) {
      console.warn(
        `?time=${raw}: expected a preset (${[...TIME_PRESETS.keys()].join(", ")}), "HH:MM", "7pm", or an hour 0-24`,
      );
    } else {
      this.override = hourToPhase(hour);
    }
  }

  attachRenderer(renderer: THREE.WebGLRenderer) {
    this.renderer = renderer;
  }

  setBakedBackground(tex: THREE.Texture | null) {
    this.baked = tex;
  }

  /** Clock hour (0-24) behind the current phase, pinned or live. */
  get hour() {
    return phaseToHour(this.phase);
  }

  setPhase(p: number) {
    this.override = ((p % 1) + 1) % 1;
  }

  getPhase() {
    return this.phase;
  }

  private applySky(sky: Sky, a: Stop, b: Stop, t: number) {
    this.scrSun.lerpVectors(a.sunDir, b.sunDir, t).normalize();
    const skyU = sky.material.uniforms;
    const sunU = skyU.sunPosition;

    if (sunU && sunU.value instanceof THREE.Vector3) {
      sunU.value.copy(this.scrSun);
    }

    const turb = skyU.turbidity;
    const rayl = skyU.rayleigh;
    const mieC = skyU.mieCoefficient;
    const mieG = skyU.mieDirectionalG;

    if (turb) {
      turb.value = THREE.MathUtils.lerp(a.sky[0], b.sky[0], t);
    }

    if (rayl) {
      rayl.value = THREE.MathUtils.lerp(a.sky[1], b.sky[1], t);
    }

    if (mieC) {
      mieC.value = THREE.MathUtils.lerp(a.sky[2], b.sky[2], t);
    }

    if (mieG) {
      mieG.value = THREE.MathUtils.lerp(a.sky[3], b.sky[3], t);
    }

    const roll = skyU.horizonRolloff;

    if (roll) {
      roll.value = THREE.MathUtils.lerp(a.sky[4], b.sky[4], t);
    }

    const disc = skyU.showSunDisc;

    if (disc) {
      disc.value = sunDiscGain(this.scrSun.y);
    }
  }

  update(dt: number) {
    if (this.override === null) {
      this.sinceSync += dt;

      if (this.sinceSync >= CLOCK_RESYNC_S) {
        this.sinceSync = 0;
        this.phase = hourToPhase(sfHourNow());
      }
    } else {
      this.phase = this.override;
    }

    const p = this.phase;

    let ai = STOPS.length - 1;

    for (let i = 0; i < STOPS.length; i += 1) {
      const s = STOPS[i];

      if (s && s.p <= p) {
        ai = i;
      }
    }

    const a = STOPS[ai];
    const b = STOPS[(ai + 1) % STOPS.length];

    if (!a || !b) {
      return;
    }

    const span = (b.p - a.p + 1) % 1 || 1;
    const raw = ((p - a.p + 1) % 1) / span;
    const t = THREE.MathUtils.smoothstep(raw, 0, 1);

    const { sky, sun, hemi, ambient, fog, scene } = this.refs;

    this.applySky(sky, a, b, t);

    const nightAmt = THREE.MathUtils.smoothstep(-this.scrSun.y, 0.02, 0.12);
    this.scrLight.lerpVectors(a.lightDir, b.lightDir, t).normalize();
    this.sunOffset.copy(this.scrLight).multiplyScalar(90);
    sun.color.lerpColors(a.lightColor, b.lightColor, t);
    const lightInt = THREE.MathUtils.lerp(a.lightInt, b.lightInt, t);
    sun.intensity = lightInt;

    const shadowRamp =
      THREE.MathUtils.smoothstep(lightInt, SHADOW_MIN_INT, SHADOW_MIN_INT + 0.4) *
      THREE.MathUtils.smoothstep(this.scrLight.y, SHADOW_MIN_ELEV_Y, SHADOW_MIN_ELEV_Y + 0.08);

    sun.shadow.intensity = shadowRamp * 0.82;
    this.shadowsActive = shadowRamp > 0.01;

    if (this.renderer && this.shadowsActive !== this.prevShadowsActive) {
      if (this.shadowsActive) {
        this.prevShadowsActive = true;
        this.renderer.shadowMap.autoUpdate = true;
        this.renderer.shadowMap.needsUpdate = true;
      } else if (this.refs.sun.shadow.map) {
        this.prevShadowsActive = false;
        this.renderer.shadowMap.autoUpdate = false;
      }
    }

    hemi.color.lerpColors(a.hemiSky, b.hemiSky, t);
    hemi.groundColor.lerpColors(a.hemiGround, b.hemiGround, t);
    hemi.intensity = THREE.MathUtils.lerp(a.hemiInt, b.hemiInt, t);
    ambient.intensity = THREE.MathUtils.lerp(a.ambInt, b.ambInt, t);
    ambient.color.lerpColors(a.ambColor, b.ambColor, t);

    fog.color.copy(this.scrColor.lerpColors(a.fog, b.fog, t));
    const reach = reachScale();
    fog.near = THREE.MathUtils.lerp(a.fogNear, b.fogNear, t) * reach;
    fog.far = THREE.MathUtils.lerp(a.fogFar, b.fogFar, t) * reach;

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
    setGradeNight(this.lamp);
    setGradeWarmth(THREE.MathUtils.lerp(a.warmth, b.warmth, t));
  }
}
