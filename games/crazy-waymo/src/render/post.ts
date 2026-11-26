import * as THREE from "three";
import { N8AOPass } from "n8ao";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { ShaderPass } from "three/addons/postprocessing/ShaderPass.js";
import { SMAAPass } from "three/addons/postprocessing/SMAAPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";

import { CAMERA } from "../shared/constants";
import { gradeLens, gradeMotion, gradeNight, gradeWarmth } from "./grade";

const GradeShader = {
  fragmentShader: `
    uniform sampler2D tDiffuse;
    uniform float uVibrance;
    uniform float uNight;
    varying vec2 vUv;
    const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);
    void main() {
      vec4 c = texture2D(tDiffuse, vUv);
      // Vibrance: push saturation hardest where there is least of it, so the
      // already-loud paint doesn't clip while the drab mid-tones wake up.
      float l = dot(c.rgb, LUMA);
      float sat = max(c.r, max(c.g, c.b)) - min(c.r, min(c.g, c.b));
      c.rgb = mix(vec3(l), c.rgb, 1.0 + uVibrance * (1.0 - clamp(sat, 0.0, 1.0)));
      if (uNight > 0.002) {
        float nl = dot(c.rgb, LUMA);
        // Lit surface (0) vs light source (1). See the header: the split is a
        // value one because the night rig hands diffuse a much smaller budget
        // than the emissive passes get.
        float src = smoothstep(0.30, 1.05, nl);
        // Chroma out of the day albedos — but only out of the LIT ones. A
        // sodium pool and a TV-blue window are the only saturated things left
        // in the frame, and desaturating them alongside the city is what used
        // to leave a uniform blue-grey wash with no lights in it.
        // Toon pass: 0.62 -> 0.42 — a storybook night keeps some colour.
        c.rgb = mix(c.rgb, vec3(nl), 0.42 * uNight * (1.0 - src));
        // Split tone: shadows cool hard, sources sodium-warm. The cool end is
        // pushed further than before because the fills came down — a dimmer
        // shadow can take more blue before it reads as tinted rather than dark.
        float t = smoothstep(0.02, 0.55, nl);
        // Toon pass: the cool end leans indigo (R over G), not steel blue.
        vec3 shade = mix(vec3(0.76, 0.70, 1.34), vec3(1.24, 1.05, 0.72), t);
        c.rgb *= mix(vec3(1.0), shade, uNight);
        // MID-TONE DIP, not a crush and not a gamma. The one large surface that
        // stays too bright after dark is pale diffuse — kerb concrete, crosswalk
        // paint, white kit facades — and it lives in a narrow band of the night
        // range. A gamma or a plain multiply would take the SKY down with it
        // (it is darker still, so it loses proportionally more) and the value
        // order would come out exactly where it went in. Dipping only the middle
        // leaves the sky and the shadows where they are, holds the sources at
        // unity via the source mask, and drops the ribbons between them.
        float band = smoothstep(0.022, 0.11, nl) * (1.0 - smoothstep(0.40, 1.0, nl));
        c.rgb *= mix(1.0, mix(mix(1.0, 0.60, band), 1.0, src), uNight);
      }
      gl_FragColor = c;
    }
  `,
  name: "WaymoGradeShader",
  uniforms: {
    tDiffuse: { value: null },
    uNight: { value: 0 },
    uVibrance: { value: 0.14 },
  },
  vertexShader: `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
};

const FinalGradeShader = {
  fragmentShader: `
    uniform sampler2D tDiffuse;
    uniform float uExposure;
    uniform float uNight;
    uniform float uWarmth;
    uniform float uContrast;
    uniform float uSaturation;
    uniform vec2 uVignette;
    uniform float uCA;
    uniform float uGrain;
    uniform float uTime;
    uniform float uAspect;
    uniform vec2 uTexel;
    uniform vec3 uRush;
    uniform float uStreak;
    uniform float uKick;
    uniform vec3 uSubject;
    uniform mat4 uInvViewProj;
    uniform sampler2D tDepth;
    varying vec2 vUv;
    const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);
    const float TAU = 6.28318530718;
    // Shoulder: knee 0.9, exponent 0.72, desat 0.16 across a 30x span.
    const vec4 ROLLOFF = vec4(0.90, 0.72, 0.16, 30.0);
    // Radial rush: fewer than ~11 taps bands visibly at the travel cap. The
    // tap count is fixed; the High-tier gate lives CPU-side (uRush.x = 0).
    const int SMEAR_TAPS = 11;
    // Hero hold-out sphere, world units. The reference ran 2.05→3.40 around a
    // ~2 u kart; rescaled for this SUV's ~2.8 u half-diagonal (subject sits
    // SUBJECT_LIFT above the road-level car origin).
    const float HOLDOUT_CORE = 3.4;
    const float HOLDOUT_EDGE = 5.1;
    // Comb lattice frequencies: INTEGER cells per revolution so the lattice
    // wraps seam-free at the atan cut (reference authored per-radian: 26/63
    // base, 47/111 boost — ×2π, rounded to integers).
    const float BASE_COMB_A = 163.0;
    const float BASE_COMB_B = 396.0;
    const float BOOST_COMB_A = 295.0;
    const float BOOST_COMB_B = 697.0;
    const float BOOST_COMB_GAIN = 0.42;
    float hash12(vec2 p) {
      vec3 q = fract(vec3(p.x, p.y, p.x) * 0.1031);
      q += dot(q, q.yzx + 33.33);
      return fract((q.x + q.y) * q.z);
    }
    // 1D value noise on an angular lattice. The index wraps mod freq, so a
    // comb has no seam where atan cuts; freq doubles as the hash seed so the
    // four combs decorrelate.
    float combNoise(float turns, float freq, float drift) {
      float x = turns * freq + drift;
      float i = floor(x);
      float f = x - i;
      float h0 = hash12(vec2(mod(i, freq), freq));
      float h1 = hash12(vec2(mod(i + 1.0, freq), freq));
      return mix(h0, h1, f * f * (3.0 - 2.0 * f));
    }
    vec3 shoulder(vec3 c) {
      float m = max(max(c.r, c.g), c.b);
      float knee = ROLLOFF.x;
      if (m <= knee) return c;
      float mc = knee * pow(m / knee, ROLLOFF.y);
      vec3 scaled = c * (mc / max(m, 1e-5));
      float desat = smoothstep(knee, knee * ROLLOFF.w, m) * ROLLOFF.z;
      return mix(scaled, vec3(dot(scaled, LUMA)), desat);
    }
    vec3 rrtOdtFit(vec3 v) {
      vec3 a = v * (v + 0.0245786) - 0.000090537;
      vec3 b = v * (0.983729 * v + 0.4329510) + 0.238081;
      return a / b;
    }
    // three.js ACESFilmicToneMapping, exposure folded in (the 1/0.6 matches).
    vec3 acesToneMap(vec3 c) {
      c *= uExposure / 0.6;
      c = mat3(0.59719, 0.07600, 0.02840,
               0.35458, 0.90834, 0.13383,
               0.04823, 0.01566, 0.83777) * c;
      c = rrtOdtFit(c);
      c = mat3( 1.60475, -0.10208, -0.00327,
               -0.53108,  1.10813, -0.07276,
               -0.07367, -0.00605,  1.07602) * c;
      return clamp(c, 0.0, 1.0);
    }
    void main() {
      vec2 fromCentre = vUv - 0.5;
      // rad: 1.0 at the frame corner at any aspect.
      vec2 a = vec2(uAspect, 1.0);
      float rad = length(fromCentre * a) / (0.5 * length(a));
      // Chromatic aberration: edge-only (middle third bit-exact clean), shape
      // squared, offset capped in TEXELS — past ~2 texels the fringe
      // decorrelates specular aliasing into confetti; under 0.05 px it snaps
      // off and the branch is a single fetch.
      float caShape = smoothstep(0.34, 1.0, rad);
      vec2 fringe = fromCentre * (uCA * caShape * caShape);
      float fringePx = length(fringe / uTexel);
      vec3 c;
      if (fringePx < 0.05) {
        c = texture2D(tDiffuse, vUv).rgb;
      } else {
        fringe *= min(fringePx, 2.0) / fringePx;
        c = vec3(
          texture2D(tDiffuse, vUv + fringe).r,
          texture2D(tDiffuse, vUv).g,
          texture2D(tDiffuse, vUv - fringe).b);
      }
      // Radial rush: edge-weighted zoom smear on the linear side, so streaks
      // carry radiance into the tone map. Quadratic edge weighting keeps the
      // vanishing point sharp; the hold-out multiplies the fragment's OWN
      // velocity by a world-space sphere on the hero (never a depth band —
      // that cuts the car in half viewed end-on). The smear taps skip the CA
      // fringe: a sub-2-texel offset is invisible inside a 20+ px streak.
      if (uRush.x > 0.0002) {
        vec2 vel = fromCentre * (uRush.x * (0.30 + 0.70 * rad));
        float travel = length(vel);
        vel *= min(travel, uRush.y) / max(travel, 1e-6);
        float sceneDepth = texture2D(tDepth, vUv).x;
        vec4 wp = uInvViewProj * vec4(vUv * 2.0 - 1.0, sceneDepth * 2.0 - 1.0, 1.0);
        vel *= smoothstep(HOLDOUT_CORE, HOLDOUT_EDGE, distance(wp.xyz / wp.w, uSubject));
        if (length(vel) > 0.0004) {
          float jitter = hash12(vUv / uTexel + fract(uTime) * 311.0) - 0.5;
          vec3 acc = c;
          for (int i = 1; i < SMEAR_TAPS; i++) {
            float s = (float(i) + jitter) / float(SMEAR_TAPS) - 0.5;
            acc += texture2D(tDiffuse, vUv + vel * s).rgb;
          }
          c = acc / float(SMEAR_TAPS);
        }
      }
      float dayW = 1.0 - uNight;
      c = mix(c, shoulder(c), dayW);
      c = acesToneMap(c);
      // Midtone S-curve, day-weighted.
      c = mix(c, c * c * (3.0 - 2.0 * c), uContrast * dayW);
      // Golden hour swims in amber: a whole-frame white-balance lean, not just
      // a highlight tint — at this game's exposure most of a street frame
      // lives in the midtones, and warming only the highs left golden hour
      // reading dusky-blue.
      c *= mix(vec3(1.0), vec3(1.12, 1.0, 0.82), uWarmth * dayW);
      // Split tone. Violet shadows via a tiny additive lift (multiplies cannot
      // tint blacks) + a cool multiply — the cool side stands down as warmth
      // rises so the amber hour isn't fighting its own shadows; warm
      // highlights lean further and reach deeper into the midtones with
      // uWarmth.
      float lum = dot(c, LUMA);
      float shadowW = (1.0 - smoothstep(0.0, 0.55, lum)) * dayW;
      float highW = smoothstep(mix(0.40, 0.24, uWarmth), 1.0, lum) * dayW;
      c += vec3(0.0016, 0.0004, 0.0036) * shadowW;
      c *= mix(vec3(1.0), vec3(0.935, 0.930, 1.080), shadowW * (0.70 - 0.38 * uWarmth));
      vec3 warmTint = mix(vec3(1.115, 1.005, 0.878), vec3(1.16, 1.00, 0.80), uWarmth);
      c *= mix(vec3(1.0), warmTint, highW * (0.65 + 0.35 * uWarmth));
      c = max(c, 0.0);
      // Saturation lift with highlight rolloff, day-weighted (night owns its
      // own desaturation painting).
      lum = dot(c, LUMA);
      float satAmt = 1.0 + (uSaturation - 1.0) * dayW;
      c = max(mix(vec3(lum), c, satAmt * (1.0 - 0.40 * smoothstep(0.70, 1.0, lum))), 0.0);
      // Speed-line combs, display-referred (they paint on the finished image,
      // so the exposure delta vs the reference does not apply). uStreak is a
      // SWITCH driven from STREAK_REST = 0: a resting frame never enters.
      if (uStreak > 0.002) {
        vec2 p = fromCentre * a;
        float turns = atan(p.y, p.x) / TAU + 0.5;
        float baseN = combNoise(turns, BASE_COMB_A, uTime * 1.6) * 0.62
                    + combNoise(turns, BASE_COMB_B, -uTime * 2.4) * 0.38;
        // Outer third only; the inner edge walks in with boost.
        float baseBand = smoothstep(mix(0.55, 0.44, uKick), 0.98, rad)
                       * (1.0 - smoothstep(1.05, 1.50, rad));
        float lines = smoothstep(0.55, 0.93, baseN) * baseBand * uStreak;
        if (uRush.z > 0.004) {
          float boostN = combNoise(turns, BOOST_COMB_A, -uTime * 7.5) * 0.58
                       + combNoise(turns, BOOST_COMB_B, uTime * 11.0) * 0.42;
          float boostBand = smoothstep(0.42, 0.90, rad)
                          * (1.0 - smoothstep(1.10, 1.55, rad));
          lines += smoothstep(0.66, 0.99, boostN) * boostBand * uKick * uRush.z * BOOST_COMB_GAIN;
        }
        lum = dot(c, LUMA);
        // Safety 1: lines streak the light that is there — a tunnel or the
        // night cannot grow a starburst out of black (and this is why the
        // combs need no day-night weighting of their own).
        lines *= 0.42 + 0.58 * smoothstep(0.04, 0.42, lum);
        // Safety 2: headroom — bright frames take fewer lines, and the sum
        // itself rolls off so stacked combs asymptote instead of clipping.
        float head = 1.0 - 0.50 * smoothstep(0.60, 1.00, lum);
        c += (lines / (1.0 + lines * 1.2)) * head * vec3(1.0, 0.972, 0.918);
      }
      // Vignette: print-down on the finished image.
      c *= 1.0 - uVignette.x * smoothstep(uVignette.y, 1.02, rad);
      // Grain: monochrome, midtone-weighted, shadow-rolled-off.
      float g = hash12(vUv / uTexel * 1.37 + fract(uTime * 0.37) * 977.0) - 0.5;
      lum = dot(c, LUMA);
      c += g * uGrain * (1.15 - 0.75 * lum) * smoothstep(0.015, 0.14, lum);
      gl_FragColor = vec4(max(c, 0.0), 1.0);
      #include <colorspace_fragment>
    }
  `,
  name: "WaymoFinalGradeShader",
  uniforms: {
    tDepth: { value: null },
    tDiffuse: { value: null },
    uAspect: { value: 16 / 9 },
    uCA: { value: 0 },
    uContrast: { value: 0.12 },
    uExposure: { value: 0.62 },
    uGrain: { value: 0 },
    uInvViewProj: { value: new THREE.Matrix4() },
    uKick: { value: 0 },
    uNight: { value: 0 },
    uRush: { value: new THREE.Vector3() },
    uSaturation: { value: 1.16 },
    uStreak: { value: 0 },
    uSubject: { value: new THREE.Vector3() },
    uTexel: { value: new THREE.Vector2(1 / 1920, 1 / 1080) },
    uTime: { value: 0 },
    uVignette: { value: new THREE.Vector2(0.18, 0.3) },
    uWarmth: { value: 0 },
  },
  vertexShader: `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
};

const BLOOM_DAY_STRENGTH = 0.26;
const BLOOM_DAY_THRESHOLD = 2.1;
const BLOOM_DAY_KNEE = 0.33;
const BLOOM_NIGHT_KNEE = 0.02;
const BLOOM_NIGHT_STRENGTH = 0.5;
const BLOOM_NIGHT_THRESHOLD = 0.85;
const BLOOM_RADIUS = 0.55;
const BLOOM_NIGHT_RADIUS = 0.3;

const BLOOM_FAST_LIFT = 0.03;
const BLOOM_KICK_LIFT = 0.06;
const BLOOM_IGNITE_LIFT = 0.09;

const CA_REST = 0;
const CA_BOOST = 0.0019;
const VIGNETTE_BASE = 0.12;
const VIGNETTE_SPEED = 0.12;
const VIGNETTE_INNER_REST = 0.3;
const VIGNETTE_INNER_FAST = 0.18;

const RUSH_FAST = 0.0165;
const RUSH_SPEED_SQ = 0.0125;
const RUSH_KICK_SPEED = 0.015;
const RUSH_IGNITE = 0.0085;
const RUSH_CAP_BASE = 0.0125;
const RUSH_CAP_BOOST = 0.0105;
const BOOST_COMB_MAX = 1.25;
const BOOST_COMB_IGNITE = 0.55;
const STREAK_REST = 0;
const STREAK_BOOST = 0.46;
const STREAK_GATE_FAST = 0.42;

const SMEAR_TIER_RATIO = 0.75;

const SUBJECT_EST_ARM = CAMERA.distance + 1.5;
const SUBJECT_EST_DROP = CAMERA.height - 1.1;
const SUBJECT_LIFT = 0.9;

const AO_RADIUS = 1.2;
const AO_INTENSITY = 3;
const AO_COLOR = 0x2a_18_40;
const AO_DENOISE_RADIUS = 4;

const FAST_TAU = 0.11;
const KICK_ATTACK = 0.05;
const KICK_RELEASE = 0.28;
const IGNITE_TAU = 0.42;
const IGNITE_GAIN = 2.1;

const sceneDepthOf = (pass: N8AOPass) => {
  const holder: object = pass;

  if (!("beautyRenderTarget" in holder)) {
    return null;
  }

  const target: unknown = holder.beautyRenderTarget;

  if (!(target instanceof THREE.WebGLRenderTarget)) {
    return null;
  }

  const depth = target.depthTexture;

  return depth instanceof THREE.DepthTexture ? depth : null;
};

const DOF_TAPS = 48;

const DofShader = {
  fragmentShader: `
    uniform sampler2D tDiffuse;
    uniform sampler2D tDepth;
    uniform vec2 uTexel;
    uniform float uNear;
    uniform float uFar;
    uniform float uFocus;
    uniform float uBlur;
    varying vec2 vUv;
    float viewZ(vec2 uv) {
      float d = texture2D(tDepth, uv).x * 2.0 - 1.0;
      return 2.0 * uNear * uFar / (uFar + uNear - d * (uFar - uNear));
    }
    float coc(float z) {
      return clamp(uBlur * abs(1.0 - uFocus / z), 0.0, uBlur);
    }
    void main() {
      vec3 base = texture2D(tDiffuse, vUv).rgb;
      float centreZ = viewZ(vUv);
      float centre = coc(centreZ);
      vec3 sum = base;
      float weight = 1.0;
      for (int i = 1; i < ${DOF_TAPS}; i++) {
        float f = float(i);
        float r = sqrt(f / float(${DOF_TAPS})) * uBlur;
        float a = f * 2.39996323;
        vec2 uv = vUv + vec2(cos(a), sin(a)) * r * uTexel;
        float sampleZ = viewZ(uv);
        // A tap behind the centre may not blur further than the centre does.
        float sampleCoc = sampleZ > centreZ ? min(coc(sampleZ), centre) : coc(sampleZ);
        float reach = smoothstep(r - 1.5, r + 0.5, sampleCoc);
        sum += texture2D(tDiffuse, uv).rgb * reach;
        weight += reach;
      }
      gl_FragColor = vec4(sum / weight, 1.0);
    }
  `,
  name: "WaymoDofShader",
  uniforms: {
    tDepth: { value: null },
    tDiffuse: { value: null },
    uBlur: { value: 0 },
    uFar: { value: 1000 },
    uFocus: { value: 10 },
    uNear: { value: 0.1 },
    uTexel: { value: new THREE.Vector2() },
  },
  vertexShader: `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
};

const InkShader = {
  fragmentShader: `
    uniform sampler2D tDiffuse;
    uniform sampler2D tDepth;
    uniform vec2 uTexel;
    uniform float uStep;
    uniform float uNear;
    uniform float uFar;
    uniform float uStrength;
    uniform vec3 uInk;
    uniform vec2 uFade;
    uniform float uDistSoft;
    varying vec2 vUv;
    float invZ(vec2 uv) {
      float d = texture2D(tDepth, uv).x * 2.0 - 1.0;
      return (uFar + uNear - d * (uFar - uNear)) / (2.0 * uNear * uFar);
    }
    void main() {
      vec4 col = texture2D(tDiffuse, vUv);
      float c = invZ(vUv);
      vec2 s = uTexel * uStep;
      float sum = invZ(vUv + vec2(s.x, 0.0)) + invZ(vUv - vec2(s.x, 0.0))
                + invZ(vUv + vec2(0.0, s.y)) + invZ(vUv - vec2(0.0, s.y));
      // Relative Laplacian, with the threshold widening with distance: far
      // terrain packs many small heightfield kinks into each pixel, and
      // without the falloff a hillside turns to hatching.
      float lap = (4.0 * c - sum) / max(c, 1e-6) / (1.0 + uDistSoft / c);
      float ridge = smoothstep(0.03, 0.08, lap);
      float valley = smoothstep(0.06, 0.16, -lap) * (1.0 - step(0.9, -lap)) * 0.55;
      float edge = max(ridge, valley) * smoothstep(uFade.y, uFade.x, 1.0 / c);
      col.rgb = mix(col.rgb, uInk, edge * uStrength);
      gl_FragColor = col;
    }
  `,
  name: "WaymoInkShader",
  uniforms: {
    tDepth: { value: null },
    tDiffuse: { value: null },
    uDistSoft: { value: 0.012 },
    uFade: { value: new THREE.Vector2(200, 450) },
    uFar: { value: 1000 },
    uInk: { value: new THREE.Color(0x1b_14_28).convertSRGBToLinear() },
    uNear: { value: 0.1 },
    uStep: { value: 1 },
    uStrength: { value: 0.9 },
    uTexel: { value: new THREE.Vector2(1 / 1920, 1 / 1080) },
  },
  vertexShader: `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
};

const INK_DAY = 0.9;
const INK_NIGHT = 0.45;
const INK_ROWS_PER_TEXEL = 540;

export class PostPipeline {
  private readonly composer: EffectComposer;
  readonly ao: N8AOPass;
  private readonly bloom: UnrealBloomPass;
  private readonly bloomKnee: THREE.IUniform | undefined;
  private readonly grade: ShaderPass;
  private readonly ink: ShaderPass;
  private readonly finalGrade: ShaderPass;
  private readonly dof: ShaderPass;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly camera: THREE.Camera;
  private lastTime = 0;
  private fast = 0;
  private kick = 0;
  private kickSlow = 0;
  private smearTier = true;
  private readonly smearDepthOk: boolean = false;
  private subjectPinned = false;
  private readonly subject = new THREE.Vector3();
  private readonly camPos = new THREE.Vector3();
  private readonly camDir = new THREE.Vector3();

  constructor(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera) {
    this.renderer = renderer;
    this.camera = camera;
    const size = renderer.getDrawingBufferSize(new THREE.Vector2());

    const target = new THREE.WebGLRenderTarget(size.x, size.y, {
      type: THREE.HalfFloatType,
    });

    this.composer = new EffectComposer(renderer, target);
    const ao = new N8AOPass(scene, camera, size.x, size.y);
    ao.configuration.aoRadius = AO_RADIUS;
    ao.configuration.distanceFalloff = 1;
    ao.configuration.intensity = AO_INTENSITY;
    ao.configuration.color = new THREE.Color(AO_COLOR);
    ao.configuration.aoSamples = 16;
    ao.configuration.denoiseSamples = 8;
    ao.configuration.denoiseRadius = AO_DENOISE_RADIUS;
    ao.configuration.denoiseIterations = 2;
    ao.configuration.halfRes = true;
    ao.configuration.depthAwareUpsampling = true;
    ao.configuration.screenSpaceRadius = false;
    ao.configuration.gammaCorrection = false;
    ao.configuration.autoDetectTransparency = false;
    this.ao = ao;
    this.composer.addPass(ao);
    this.ink = new ShaderPass(InkShader);
    this.composer.addPass(this.ink);
    this.dof = new ShaderPass(DofShader);
    this.dof.enabled = false;
    this.composer.addPass(this.dof);
    this.bloom = new UnrealBloomPass(size, BLOOM_DAY_STRENGTH, BLOOM_RADIUS, BLOOM_DAY_THRESHOLD);
    this.bloomKnee = this.bloom.materialHighPassFilter.uniforms.smoothWidth;

    if (this.bloomKnee) {
      this.bloomKnee.value = BLOOM_DAY_KNEE;
    }

    this.composer.addPass(this.bloom);
    this.grade = new ShaderPass(GradeShader);
    this.composer.addPass(this.grade);
    this.composer.addPass(new SMAAPass());
    this.finalGrade = new ShaderPass(FinalGradeShader);
    this.composer.addPass(this.finalGrade);
    const depth = sceneDepthOf(ao);

    if (depth) {
      for (const pass of [this.finalGrade, this.dof, this.ink]) {
        const d = pass.uniforms.tDepth;

        if (d) {
          d.value = depth;
        }
      }

      this.smearDepthOk = true;
    }

    this.ink.enabled = depth !== null;
    this.syncViewportUniforms(size.x, size.y);
  }

  /**
   * Pin the hero hold-out sphere to the player car (world position, road-level
   * origin — the body-centre lift is applied here). Call once per frame from
   * the scene; until wired, render() estimates the subject from the chase
   * rig's fast-end pose.
   */
  setSpeedSubject(world: THREE.Vector3) {
    this.subject.copy(world);
    this.subject.y += SUBJECT_LIFT;
    this.subjectPinned = true;
  }

  private syncViewportUniforms(width: number, height: number) {
    const dofTexel = this.dof.uniforms.uTexel;

    if (dofTexel && dofTexel.value instanceof THREE.Vector2) {
      dofTexel.value.set(1 / Math.max(1, width), 1 / Math.max(1, height));
    }

    const iu = this.ink.uniforms;
    const inkTexel = iu.uTexel;

    if (inkTexel && inkTexel.value instanceof THREE.Vector2) {
      inkTexel.value.set(1 / Math.max(1, width), 1 / Math.max(1, height));
    }

    const inkStep = iu.uStep;

    if (inkStep) {
      inkStep.value = Math.max(1, Math.round(height / INK_ROWS_PER_TEXEL));
    }

    const u = this.finalGrade.uniforms;
    const aspect = u.uAspect;

    if (aspect) {
      aspect.value = width / Math.max(1, height);
    }

    const texel = u.uTexel;

    if (texel && texel.value instanceof THREE.Vector2) {
      texel.value.set(1 / Math.max(1, width), 1 / Math.max(1, height));
    }
  }

  setSize(width: number, height: number, pixelRatio: number) {
    this.composer.setPixelRatio(pixelRatio);
    this.composer.setSize(width, height);
    this.syncViewportUniforms(width * pixelRatio, height * pixelRatio);
    const native = Math.min(window.devicePixelRatio || 1, 2);
    this.smearTier = pixelRatio >= native * SMEAR_TIER_RATIO;
  }

  render() {
    const now = performance.now() / 1000;
    const dt = this.lastTime > 0 ? Math.min(0.1, now - this.lastTime) : 1 / 60;
    this.lastTime = now;

    const night = gradeNight();
    const warmth = gradeWarmth();
    const motion = gradeMotion();

    const fastTarget = THREE.MathUtils.clamp((motion.speed - 0.45) / 0.55, 0, 1);
    this.fast += (fastTarget - this.fast) * Math.min(1, dt / FAST_TAU);
    const kickTarget = motion.boost ? 1 : 0;
    const kickTau = kickTarget > this.kick ? KICK_ATTACK : KICK_RELEASE;
    this.kick += (kickTarget - this.kick) * Math.min(1, dt / kickTau);
    this.kickSlow += (this.kick - this.kickSlow) * Math.min(1, dt / IGNITE_TAU);
    const ignite = THREE.MathUtils.clamp((this.kick - this.kickSlow) * IGNITE_GAIN, 0, 1);
    const drive = Math.max(this.fast, this.kick);

    const gu = this.grade.uniforms;
    const un = gu.uNight;

    if (un) {
      un.value = night;
    }

    const fu = this.finalGrade.uniforms;
    const exp = fu.uExposure;

    if (exp) {
      exp.value = this.renderer.toneMappingExposure;
    }

    const fn = fu.uNight;

    if (fn) {
      fn.value = night;
    }

    const fw = fu.uWarmth;

    if (fw) {
      fw.value = warmth;
    }

    const ca = fu.uCA;

    if (ca) {
      ca.value = CA_REST + (CA_BOOST - CA_REST) * Math.min(1.35, drive + ignite * 0.55);
    }

    const vig = fu.uVignette;

    if (vig && vig.value instanceof THREE.Vector2) {
      vig.value.set(
        VIGNETTE_BASE + VIGNETTE_SPEED * drive + 0.07 * ignite,
        VIGNETTE_INNER_REST +
          (VIGNETTE_INNER_FAST - VIGNETTE_INNER_REST) * Math.min(1, drive + ignite * 0.6),
      );
    }

    const time = fu.uTime;

    if (time) {
      time.value = now % 600;
    }

    this.updateInk(night);

    const lens = gradeLens();
    this.updateSpeedUniforms(motion.speed, ignite, lens?.streaks ?? 1);
    this.updateDof(lens);

    const gateRamp = Math.sqrt(night);
    this.bloom.threshold =
      BLOOM_DAY_THRESHOLD + (BLOOM_NIGHT_THRESHOLD - BLOOM_DAY_THRESHOLD) * gateRamp;

    if (this.bloomKnee) {
      this.bloomKnee.value = BLOOM_DAY_KNEE + (BLOOM_NIGHT_KNEE - BLOOM_DAY_KNEE) * gateRamp;
    }

    this.bloom.strength =
      BLOOM_DAY_STRENGTH +
      (BLOOM_NIGHT_STRENGTH - BLOOM_DAY_STRENGTH) * night +
      BLOOM_FAST_LIFT * this.fast +
      BLOOM_KICK_LIFT * this.kick +
      BLOOM_IGNITE_LIFT * ignite;
    this.bloom.radius = BLOOM_RADIUS + (BLOOM_NIGHT_RADIUS - BLOOM_RADIUS) * night;
    this.composer.render();
  }

  private updateInk(night: number) {
    const { camera } = this;

    if (!(camera instanceof THREE.PerspectiveCamera)) {
      return;
    }

    const u = this.ink.uniforms;
    const near = u.uNear;
    const far = u.uFar;
    const strength = u.uStrength;

    if (near && far && strength) {
      near.value = camera.near;
      far.value = camera.far;
      strength.value = INK_DAY + (INK_NIGHT - INK_DAY) * night;
    }
  }

  private updateDof(lens: ReturnType<typeof gradeLens>) {
    const { camera } = this;
    this.dof.enabled =
      lens !== null &&
      lens.blur > 0 &&
      this.smearDepthOk &&
      camera instanceof THREE.PerspectiveCamera;

    if (!lens || !(camera instanceof THREE.PerspectiveCamera)) {
      return;
    }

    const u = this.dof.uniforms;
    const texel: unknown = u.uTexel?.value;
    const scale = texel instanceof THREE.Vector2 && texel.y > 0 ? 1 / texel.y / 1080 : 1;

    const set = (name: string, value: number) => {
      const uniform = u[name];

      if (uniform) {
        uniform.value = value;
      }
    };

    set("uNear", camera.near);
    set("uFar", camera.far);
    set("uFocus", lens.focus);
    set("uBlur", lens.blur * scale);
  }

  private updateSpeedUniforms(motionSpeed: number, ignite: number, streaks: number) {
    const fu = this.finalGrade.uniforms;

    const gate = Math.max(
      THREE.MathUtils.smoothstep(this.fast, 0, STREAK_GATE_FAST),
      this.kick,
      ignite,
    );

    const streak = fu.uStreak;

    if (streak) {
      streak.value = (STREAK_REST + (STREAK_BOOST - STREAK_REST) * gate) * streaks;
    }

    const kickU = fu.uKick;

    if (kickU) {
      kickU.value = this.kick;
    }

    const boostComb = Math.min(BOOST_COMB_MAX, this.kick + BOOST_COMB_IGNITE * ignite) * streaks;
    const speed = THREE.MathUtils.clamp(motionSpeed, 0, 1);

    const rushAmt =
      streaks *
      (Math.max(
        RUSH_FAST * this.fast ** 1.5,
        RUSH_SPEED_SQ * speed * speed + RUSH_KICK_SPEED * this.kick * speed,
      ) +
        RUSH_IGNITE * ignite);

    const smearOn = this.smearTier && this.smearDepthOk;
    const rush = fu.uRush;

    if (rush && rush.value instanceof THREE.Vector3) {
      rush.value.set(smearOn ? rushAmt : 0, RUSH_CAP_BASE + RUSH_CAP_BOOST * boostComb, boostComb);
    }

    if (smearOn && rushAmt > 0.0002) {
      this.camera.updateMatrixWorld();
      const ivp = fu.uInvViewProj;

      if (ivp && ivp.value instanceof THREE.Matrix4) {
        ivp.value
          .multiplyMatrices(this.camera.projectionMatrix, this.camera.matrixWorldInverse)
          .invert();
      }

      if (!this.subjectPinned) {
        this.camera.getWorldPosition(this.camPos);
        this.camera.getWorldDirection(this.camDir);
        const planar = Math.hypot(this.camDir.x, this.camDir.z);

        if (planar > 1e-4) {
          const arm = SUBJECT_EST_ARM / planar;
          this.subject.set(
            this.camPos.x + this.camDir.x * arm,
            this.camPos.y - SUBJECT_EST_DROP + SUBJECT_LIFT,
            this.camPos.z + this.camDir.z * arm,
          );
        }
      }

      const subj = fu.uSubject;

      if (subj && subj.value instanceof THREE.Vector3) {
        subj.value.copy(this.subject);
      }
    }
  }
}
