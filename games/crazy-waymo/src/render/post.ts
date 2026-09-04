import * as THREE from "three";
import { N8AOPass } from "n8ao";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { ShaderPass } from "three/addons/postprocessing/ShaderPass.js";
import { SMAAPass } from "three/addons/postprocessing/SMAAPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";

import { CAMERA } from "../shared/constants";
import { gradeMotion, gradeNight, gradeWarmth } from "./grade";

// Desktop-only post chain (kart-racer pass): contact AO so nothing floats,
// threshold bloom so the additive FX (drift trails, boost, lamp glow, lit
// windows) actually GLOW, a linear-HDR vibrance/night grade, SMAA, and a
// final display transform that owns tone mapping (highlight shoulder + ACES)
// plus the film look — S-curve, teal/warm split tone, saturation with
// highlight rolloff, speed-scaled chromatic aberration, vignette, grain.
// Mobile stays on the single forward pass — the tile-GPU bandwidth cost isn't
// worth it (and the governor already fights for frame time there).
//
// Chain: N8AOPass (renders the scene + multiplies AO) → UnrealBloom →
// WaymoGradeShader (pre-tonemap linear ops) → SMAA (three's pass wants
// linear input, pre tone map) → FinalGradeShader (tone map + look, writes
// sRGB to screen).
//
// TONE MAPPING NOW LIVES IN FinalGradeShader, not an OutputPass: it reads the
// renderer's toneMappingExposure every frame, so the day-night exposure ramp
// keeps working unchanged, and the mobile no-composer path (renderer ACES)
// stays the fallback reference look.
//
// N8AO TRADES MSAA FOR SMAA. N8AOPass renders the scene into its own
// non-multisampled HalfFloat target (it needs a sampleable depth texture), so
// the composer's MSAA buffer would never see geometry. SMAA takes over edge
// AA; thin-geometry crawl (wires, masts) is the thing to watch in pairs.

// The grade runs BEFORE the display transform, i.e. on pre-tone-map linear
// HDR. Every operation below is therefore a linear-light one (mixes toward
// luminance, channel gains) — an sRGB-shaped curve here would fight the tone
// mapper. Display-referred ops (S-curve, split tone, vignette) live in
// FinalGradeShader instead.
//
// NIGHT IS A DIFFERENT PAINTING, NOT A DIMMED DAY. Lights can only ever
// MULTIPLY an albedo, so no amount of moonlight tinting can take the chroma out
// of a fully saturated day albedo: at midnight the Mission's red transit lanes
// still read as full-strength red and the park trees stay day-green, because
// their albedo is red and green and the fill just scales it. Only a grade can
// remove chroma. So the night pass here does the two things the lighting rig
// structurally cannot: it pulls global saturation down, then splits the
// remaining tone — shadows cool, highlights sodium-warm — so the lamps and lit
// windows read as the WARM pools the brief asks for against a cool city.
//
// THE SOURCE MASK is what makes it a painting rather than a filter. This pass
// sees PRE-TONEMAP LINEAR HDR, where a night frame separates cleanly by value:
// halved moon/ambient fills leave lit surfaces under ~0.3, while the additive
// emissives (windows, lamp pools, headlights, beacons) are authored to land
// over 1. `src` reads that split, and every night operation below is weighted
// by it — the city desaturates and cools, the sources keep their sodium and
// their chroma. Grading them together is what made the old night one flat
// blue-grey wash with no lights in it.
const GradeShader = {
  name: "WaymoGradeShader",
  uniforms: {
    tDiffuse: { value: null },
    uVibrance: { value: 0.14 },
    uNight: { value: 0 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
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
        c.rgb = mix(c.rgb, vec3(nl), 0.62 * uNight * (1.0 - src));
        // Split tone: shadows cool hard, sources sodium-warm. The cool end is
        // pushed further than before because the fills came down — a dimmer
        // shadow can take more blue before it reads as tinted rather than dark.
        float t = smoothstep(0.02, 0.55, nl);
        vec3 shade = mix(vec3(0.68, 0.82, 1.30), vec3(1.24, 1.05, 0.72), t);
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
};

// The display transform + film look, in one pass (ported from a kart-racer
// reference grade, adapted to this game's radiances). Order inside:
//   1. chromatic aberration gather (on linear — the offsets are sub-texel and
//      capped, so the HDR fringe risk the sun disc poses is bounded by the cap)
//   2. radial rush zoom smear (linear side, so streaks carry radiance into the
//      tone map): velocity = fromCentre * rush, quadratically edge-weighted so
//      the vanishing point stays sharp, travel-capped, and multiplied by a
//      WORLD-SPACE hold-out sphere around the player car (depth-reconstructed
//      — a depth band would cut the car in half viewed end-on). High tier
//      only; the whole gather is branch-skipped at rest.
//   3. exposure (renderer.toneMappingExposure, via the day-night ramp)
//   4. highlight shoulder — a power-law rolloff gated on max(rgb) BEFORE ACES
//      so a 4x sky and a 20x glint still separate instead of both slamming
//      into the ACES ceiling; includes highlight desaturation toward luma.
//      Faded out at night: the night painting's emissive values are measured
//      against plain ACES and must not soften.
//   5. ACES fit (bit-for-bit three.js ACESFilmicToneMapping)
//   6. midtone S-curve — smoothstep-toward-self keeps 0 and 1 pinned so it
//      adds snap without crushing the shadow detail the AO pass paid for.
//      Day-only: the night mid-tone dip already owns that range.
//   7. teal-shadow / warm-highlight split tone. The cool axis is TEAL (G with
//      B above unity), not blue — pure blue against a warm key reads violet.
//      Day-weighted, and the warm side leans harder with uWarmth so golden
//      hour reads gilded rather than merely bright.
//   8. saturation lift with a highlight rolloff so bloomed glints go white,
//      not neon.
//   9. speed-line combs — two angular value-noise combs (base + boost) in the
//      outer radial band, composited display-referred with two safety terms:
//      sceneLit (lines streak the light that is there — no tunnel/night
//      starburst, which is also why they need no uNight weighting) and a
//      headroom shoulder (bright frames take fewer lines, stacks asymptote).
//  10. vignette — post-tonemap print-down; amount and inner edge close in
//      with speed.
//  11. monochrome grain, midtone-weighted, rolled off in shadows.
//  12. sRGB encode (this pass writes the canvas — no OutputPass follows).
const FinalGradeShader = {
  name: "WaymoFinalGradeShader",
  uniforms: {
    tDiffuse: { value: null },
    uExposure: { value: 0.62 },
    uNight: { value: 0 },
    uWarmth: { value: 0 },
    uContrast: { value: 0.16 },
    uSaturation: { value: 1.08 },
    // x amount, y inner-edge radius
    uVignette: { value: new THREE.Vector2(0.18, 0.3) },
    uCA: { value: 0.0 },
    uGrain: { value: 0.009 },
    uTime: { value: 0 },
    uAspect: { value: 16 / 9 },
    uTexel: { value: new THREE.Vector2(1 / 1920, 1 / 1080) },
    // Speed subject. uRush: x smear amount (0 = branch closed), y uv travel
    // cap, z boost-comb strength. uStreak is the comb master gain, uKick the
    // eased boost signal, uSubject the hero hold-out centre (world space).
    uRush: { value: new THREE.Vector3() },
    uStreak: { value: 0 },
    uKick: { value: 0 },
    uSubject: { value: new THREE.Vector3() },
    uInvViewProj: { value: new THREE.Matrix4() },
    tDepth: { value: null },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
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
      // Split tone. Teal shadows via a tiny additive lift (multiplies cannot
      // tint blacks) + a cool multiply — the cool side stands down as warmth
      // rises so the amber hour isn't fighting its own shadows; warm
      // highlights lean further and reach deeper into the midtones with
      // uWarmth.
      float lum = dot(c, LUMA);
      float shadowW = (1.0 - smoothstep(0.0, 0.55, lum)) * dayW;
      float highW = smoothstep(mix(0.40, 0.24, uWarmth), 1.0, lum) * dayW;
      c += vec3(-0.0009, 0.0025, 0.0030) * shadowW;
      c *= mix(vec3(1.0), vec3(0.900, 1.010, 1.045), shadowW * (0.70 - 0.38 * uWarmth));
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
};

// Bloom is a DAY setting and a NIGHT setting, not one setting. The two ends of
// the ramp anchor to different budgets: the day gate to the sunlit-diffuse
// ceiling (below), the night gate to the authored emissive budget — a lit
// window peaks near 1.1 pre-tonemap, a lamp pool near 0.9, a headlight near
// 1.6. Both fields ramp with the cycle. `UnrealBloomPass.render` copies
// strength/threshold into its uniforms every frame, so writing the fields is
// the supported way to animate them; the knee is a uniform the pass never
// touches, written alongside them in render().
const BLOOM_DAY_STRENGTH = 0.26;
// THE DAY CUT SITS JUST ABOVE SUNLIT DIFFUSE WHITE. Pre-tonemap at this
// game's exposure (0.62), the brightest lit-diffuse surfaces — a white kit
// facade square to the noon key (1.85), sunlit kerb concrete, crosswalk
// paint — land at ~1.5-1.9. The cut sits at the bottom of that band with the
// knee reaching across it, so lit diffuse at most KISSES the pyramid while
// everything authored as a SOURCE clears it outright: spark cores under their
// per-emit gain, drift ribbons and boost flame near 2-3, the sun disc at 400
// (day-night.ts SUN_DISC_RADIANCE). That is the glow identity: by day the FX
// bloom, not the city.
//
// The Preetham horizon band (~5.4 pre-tonemap at noon) also crosses this cut,
// and harvesting it is measured-cheap at this strength: forcing the cut from
// 6.5 down to 2.5 across four cameras moved the >=88%-luminance share by at
// most +0.8pp (Ocean Beach golden — the sun's own glitter path) and under
// 0.05pp everywhere else, with same-camera pairs indistinguishable. The
// milky-veil failure mode lives in the DISC, not the cut: an unbounded disc
// hands the pyramid ~85,000 of headroom energy, and the disc is bounded at
// the source.
const BLOOM_DAY_THRESHOLD = 2.1;
// Gate softness (the high-pass material's smoothWidth), in the same radiance
// units as the cut. Day is a wide shoulder — the reference kart grade's shape
// — so sunlit white fades INTO the pyramid instead of popping across a hard
// edge as the camera swings. Night must stay near-hard: the lamp pools are
// authored to ~0.9 against the 0.85 cut, and a day-width knee would
// smoothstep them down to a few percent of their bloom, unlighting the night
// the budget below exists to keep.
const BLOOM_DAY_KNEE = 0.33;
const BLOOM_NIGHT_KNEE = 0.02;
// The night cut sits just under the dimmest thing that should glow — the lamp
// pools, authored to ~0.9 at their core (fx/lamp-glow.ts POOL_GAIN) — and no
// lower. Below ~0.7 it starts catching LIT SURFACES too, and the one surface
// that is genuinely blown after dark (a wall 5 metres in front of the player's
// 70-candela spot) turns into a frame-filling white blob.
const BLOOM_NIGHT_STRENGTH = 0.5;
const BLOOM_NIGHT_THRESHOLD = 0.85;
// Mip-composite spread. The night halo shape is insensitive to it (see the
// spill experiments below: radius 0.3 -> 0 moved the facade mean not at all),
// so one value serves both paintings; 0.55 widens the day glow toward the
// reference look's soft halation.
const BLOOM_RADIUS = 0.55;
const BLOOM_NIGHT_RADIUS = 0.3;
// THE NIGHT SPILL HAS NO SHAPE KNOB — four experiments, all measured on a FiDi
// and a Market chase frame at midnight, kit-facade mean through a per-camera
// stencil. Bloom does lift the facades it is supposed to be lighting: turning
// it off takes that mean 4.91 -> 3.80, a 29% wash. But
//   - `radius` 0.3 -> 0 moves it 4.91 -> 4.91 (the composite's mip weights),
//   - hand-zeroing the two widest mips (bloomFactors [1,.7,.3,.05,0]) 4.91 ->
//     4.76 — the wash is in mip1/mip2, not in the frame-scale blurs,
//   - `strength` 0.5 -> 0.4 takes facade AND sky down together (ratio 0.89 ->
//     0.86), i.e. it dims the lamps rather than tightening them,
//   - running the grade BEFORE the bloom (so the pass harvests dipped facades
//     and the grade's own source mask) makes it WORSE, 4.91 -> 5.62: the
//     vibrance and split tone land on the source first and the bloom then adds
//     on top of a lifted frame.
// So the residual halo is the SOURCE's own billboard skirt, not the pyramid:
// it is authored in fx/lamp-glow.ts and fx/street-luminaires.ts, and downtown it
// is the beacon layer's house gain (fx/beacon-lights.ts). Shrinking the two
// constants this side owns (MAST_HALO 1.5 -> 1.0, HALO_GAIN 3.4 -> 2.6) moved
// the facade mean 1.4% and the blown share 0.07pp and is invisible in a
// same-camera pair — do not spend those constants on it.

// Speed-reactive bloom: the lens brightens with pace, never with the clock.
// Additive on top of the day/night ramp; the transient ignite term buys the
// boost-release frame a halo without building a sustained veil.
// Half the pre-port lifts: at the 1.6-2.1 day gate the golden-hour mie veil
// already rides the bloom pyramid, and the old lift values pushed an into-sun
// boost frame to a full milky white-out (measured, SUPER MINI-TURBO at 17:00).
const BLOOM_FAST_LIFT = 0.03;
const BLOOM_KICK_LIFT = 0.06;
const BLOOM_IGNITE_LIFT = 0.09;

// Chromatic aberration bounds (per-channel uv offset at |fromCentre| = 1).
const CA_REST = 0.00045;
const CA_BOOST = 0.0019;
// Vignette speed language: amount rises, inner edge walks in.
const VIGNETTE_BASE = 0.18;
const VIGNETTE_SPEED = 0.12;
const VIGNETTE_INNER_REST = 0.3;
const VIGNETTE_INNER_FAST = 0.18;

// Radial rush drive (uv-space smear amount). Geometric, display-side numbers
// — ported verbatim from the reference grade; no exposure re-derivation
// applies. The two families combine with max, not +: the fast term owns
// full-throttle cruising, the speed²/kick pair owns boost, and ignite buys
// the onset frame an overshoot.
const RUSH_FAST = 0.0165;
const RUSH_SPEED_SQ = 0.0125;
const RUSH_KICK_SPEED = 0.015;
const RUSH_IGNITE = 0.0085;
// uv travel cap: base at gate-open, extra headroom under boost.
const RUSH_CAP_BASE = 0.0125;
const RUSH_CAP_BOOST = 0.0105;
// Boost-comb strength: kick plus a slug of ignite, capped ABOVE 1 so the
// ignition frame overshoots the sustained ceiling.
const BOOST_COMB_MAX = 1.25;
const BOOST_COMB_IGNITE = 0.55;
// Speed-line master gain. REST MUST STAY 0 — the combs are a switch, not a
// fade: a resting frame skips the branch and stays bit-identical to the
// pre-port grade.
const STREAK_REST = 0.0;
const STREAK_BOOST = 0.46;
// The comb gate opens across the first 42% of the eased fast signal.
const STREAK_GATE_FAST = 0.42;

// The ≥11-tap smear runs on the High tier only. The desktop governor encodes
// its tier as the pixel ratio it hands setSize, so "High" = still at ≥75% of
// native DPR; a machine stepped below that is already struggling and the rush
// zeroes out (the combs stay — four noise evals, no extra taps).
const SMEAR_TIER_RATIO = 0.75;

// Hero hold-out subject. Until the scene pins the car via setSpeedSubject the
// pipeline estimates it from the chase rig's FAST-end pose (rush only opens
// near top speed, so the estimate is calibrated there: camera-rig.ts lerps
// distance +1.5 and height -1.1 at speed). SUBJECT_LIFT raises the road-level
// car origin to the body centre the sphere is measured from.
const SUBJECT_EST_ARM = CAMERA.distance + 1.5;
const SUBJECT_EST_DROP = CAMERA.height - 1.1;
const SUBJECT_LIFT = 0.9;

// N8AO: tight contact AO, cool-tinted, half-res. The radius stays SHORT —
// large radii produce the flat grey haze that gives cheap AO away; the point
// is the last metre where a wheel meets asphalt and a plinth meets pavement.
// The reference kart recipe: shorter radius + harder intensity + a NARROW
// denoise — at radius*falloff the depth-rejection band sits under the car's
// ride height, intensity is an exponent on visibility (5.0 is where the
// under-chassis core reads), and a wide denoise blurs the contact band away,
// which is what a soft 6-radius blur was doing to the wheel patches.
const AO_RADIUS = 1.2;
const AO_INTENSITY = 4.2;
const AO_COLOR = 0x101c2a;
// 2 left the paint drape's z-offset seams as black speckle dashes along every
// painted line at speed (review pass); 4 + two iterations blurs the seam away
// while the wheel-contact core survives.
const AO_DENOISE_RADIUS = 4;

// The speed/boost signal easing (CPU side). `fast` is the eased top-speed
// ramp; `kick` eases the boost flag with a fast attack and slow release (the
// lens should not snap back when the boost expires); `ignite` is a
// leading-edge pulse that exists only while kick RISES — the eye reads
// onsets, not states, so every lens term may overshoot for a fraction of a
// second on ignition.
const FAST_TAU = 0.11;
const KICK_ATTACK = 0.05;
const KICK_RELEASE = 0.28;
const IGNITE_TAU = 0.42;
const IGNITE_GAIN = 2.1;

// n8ao's beauty target carries the frame's only sampleable depth, which the
// hold-out sphere needs for world reconstruction. It is not part of the
// pass's typed surface (render/n8ao.d.ts), so probe structurally: a package
// bump that moves the internal degrades to "no rush smear", never a crash.
// Caching the texture once is safe — three resizes an attached depth texture
// in place, the object identity survives setSize.
function sceneDepthOf(pass: N8AOPass): THREE.DepthTexture | null {
  const holder: object = pass;
  if (!("beautyRenderTarget" in holder)) return null;
  const target: unknown = holder.beautyRenderTarget;
  if (!(target instanceof THREE.WebGLRenderTarget)) return null;
  const depth = target.depthTexture;
  return depth instanceof THREE.DepthTexture ? depth : null;
}

export class PostPipeline {
  private composer: EffectComposer;
  // DEV probes reach in to A/B the AO contribution (debug/dev-hooks.ts).
  readonly ao: N8AOPass;
  private bloom: UnrealBloomPass;
  private bloomKnee: THREE.IUniform | undefined;
  private grade: ShaderPass;
  private finalGrade: ShaderPass;
  private renderer: THREE.WebGLRenderer;
  private camera: THREE.Camera;
  private lastTime = 0;
  private fast = 0;
  private kick = 0;
  private kickSlow = 0;
  private smearTier = true;
  private smearDepthOk = false;
  private subjectPinned = false;
  private readonly subject = new THREE.Vector3();
  private readonly camPos = new THREE.Vector3();
  private readonly camDir = new THREE.Vector3();

  constructor(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera) {
    this.renderer = renderer;
    this.camera = camera;
    // HDR target: bloom needs >8bit to find highlights. MSAA is intentionally
    // absent — N8AOPass renders the scene into its own half-float target with
    // a sampleable depth texture; SMAA at the end of the chain is the AA.
    const size = renderer.getDrawingBufferSize(new THREE.Vector2());
    const target = new THREE.WebGLRenderTarget(size.x, size.y, {
      type: THREE.HalfFloatType,
    });
    this.composer = new EffectComposer(renderer, target);
    const ao = new N8AOPass(scene, camera, size.x, size.y);
    ao.configuration.aoRadius = AO_RADIUS;
    ao.configuration.distanceFalloff = 1.0;
    ao.configuration.intensity = AO_INTENSITY;
    ao.configuration.color = new THREE.Color(AO_COLOR);
    ao.configuration.aoSamples = 16;
    ao.configuration.denoiseSamples = 8;
    ao.configuration.denoiseRadius = AO_DENOISE_RADIUS;
    ao.configuration.denoiseIterations = 2;
    ao.configuration.halfRes = true;
    ao.configuration.depthAwareUpsampling = true;
    ao.configuration.screenSpaceRadius = false;
    // Output must stay linear HDR for the bloom threshold to mean anything.
    ao.configuration.gammaCorrection = false;
    ao.configuration.autoDetectTransparency = false;
    this.ao = ao;
    this.composer.addPass(ao);
    // Threshold sits in PRE-tonemap linear HDR, so every number here is a
    // radiance, not a pixel value: the gate is authored against what the scene
    // draws (BLOOM_DAY_THRESHOLD / BLOOM_NIGHT_THRESHOLD above) and the sun
    // disc is bounded at the source (day-night.ts SUN_DISC_RADIANCE) — an
    // unbounded disc makes any cut unwinnable. The knee lives on the
    // high-pass material; the pass re-copies only `threshold` per frame, so
    // smoothWidth is safe to own from here.
    this.bloom = new UnrealBloomPass(size, BLOOM_DAY_STRENGTH, BLOOM_RADIUS, BLOOM_DAY_THRESHOLD);
    this.bloomKnee = this.bloom.materialHighPassFilter.uniforms.smoothWidth;
    if (this.bloomKnee) this.bloomKnee.value = BLOOM_DAY_KNEE;
    this.composer.addPass(this.bloom);
    this.grade = new ShaderPass(GradeShader);
    this.composer.addPass(this.grade);
    // SMAA runs on linear values by three's own contract (before tone map).
    this.composer.addPass(new SMAAPass());
    this.finalGrade = new ShaderPass(FinalGradeShader);
    this.composer.addPass(this.finalGrade);
    const depth = sceneDepthOf(ao);
    if (depth) {
      const d = this.finalGrade.uniforms.tDepth;
      if (d) d.value = depth;
      this.smearDepthOk = true;
    }
    this.syncViewportUniforms(size.x, size.y);
  }

  /**
   * Pin the hero hold-out sphere to the player car (world position, road-level
   * origin — the body-centre lift is applied here). Call once per frame from
   * the scene; until wired, render() estimates the subject from the chase
   * rig's fast-end pose.
   */
  setSpeedSubject(world: THREE.Vector3): void {
    this.subject.copy(world);
    this.subject.y += SUBJECT_LIFT;
    this.subjectPinned = true;
  }

  private syncViewportUniforms(width: number, height: number): void {
    const u = this.finalGrade.uniforms;
    const aspect = u.uAspect;
    if (aspect) aspect.value = width / Math.max(1, height);
    const texel = u.uTexel;
    if (texel && texel.value instanceof THREE.Vector2) {
      texel.value.set(1 / Math.max(1, width), 1 / Math.max(1, height));
    }
  }

  setSize(width: number, height: number, pixelRatio: number): void {
    this.composer.setPixelRatio(pixelRatio);
    this.composer.setSize(width, height);
    this.syncViewportUniforms(width * pixelRatio, height * pixelRatio);
    // The governor's tier reaches this pass only as the pixel ratio it picked
    // (desktop tiers ARE resolution steps) — read the tier back from it.
    const native = Math.min(window.devicePixelRatio || 1, 2);
    this.smearTier = pixelRatio >= native * SMEAR_TIER_RATIO;
  }

  render(): void {
    const now = performance.now() / 1000;
    const dt = this.lastTime > 0 ? Math.min(0.1, now - this.lastTime) : 1 / 60;
    this.lastTime = now;

    const night = gradeNight();
    const warmth = gradeWarmth();
    const motion = gradeMotion();

    // Signal easing. `fast` opens above ~62% of boost top speed.
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
    if (un) un.value = night;

    const fu = this.finalGrade.uniforms;
    const exp = fu.uExposure;
    if (exp) exp.value = this.renderer.toneMappingExposure;
    const fn = fu.uNight;
    if (fn) fn.value = night;
    const fw = fu.uWarmth;
    if (fw) fw.value = warmth;
    const ca = fu.uCA;
    if (ca) ca.value = CA_REST + (CA_BOOST - CA_REST) * Math.min(1.35, drive + ignite * 0.55);
    const vig = fu.uVignette;
    if (vig && vig.value instanceof THREE.Vector2) {
      vig.value.set(
        VIGNETTE_BASE + VIGNETTE_SPEED * drive + 0.07 * ignite,
        VIGNETTE_INNER_REST +
          (VIGNETTE_INNER_FAST - VIGNETTE_INNER_REST) * Math.min(1, drive + ignite * 0.6),
      );
    }
    const time = fu.uTime;
    if (time) time.value = now % 600;

    // Speed subject: comb master + boost comb + radial rush + hold-out.
    const gate = Math.max(
      THREE.MathUtils.smoothstep(this.fast, 0, STREAK_GATE_FAST),
      this.kick,
      ignite,
    );
    const streak = fu.uStreak;
    if (streak) streak.value = STREAK_REST + (STREAK_BOOST - STREAK_REST) * gate;
    const kickU = fu.uKick;
    if (kickU) kickU.value = this.kick;
    const boostComb = Math.min(BOOST_COMB_MAX, this.kick + BOOST_COMB_IGNITE * ignite);
    const speed = THREE.MathUtils.clamp(motion.speed, 0, 1);
    const rushAmt =
      Math.max(
        RUSH_FAST * Math.pow(this.fast, 1.5),
        RUSH_SPEED_SQ * speed * speed + RUSH_KICK_SPEED * this.kick * speed,
      ) +
      RUSH_IGNITE * ignite;
    const smearOn = this.smearTier && this.smearDepthOk;
    const rush = fu.uRush;
    if (rush && rush.value instanceof THREE.Vector3) {
      rush.value.set(smearOn ? rushAmt : 0, RUSH_CAP_BASE + RUSH_CAP_BOOST * boostComb, boostComb);
    }
    if (smearOn && rushAmt > 0.0002) {
      // The smear reconstructs world positions, so the matrices must be
      // current NOW — the composer's own render is too late. Camera's
      // updateMatrixWorld also refreshes matrixWorldInverse.
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
      if (subj && subj.value instanceof THREE.Vector3) subj.value.copy(this.subject);
    }

    // The cut falls on sqrt(night), not on night. `night` IS the lamp factor,
    // so at dusk it is still only ~0.6 when every streetlight in the city is
    // already burning. Square-rooting drops the gate toward the lamp budget
    // early, in step with the lamps — at dusk the cut is ~1.0, under the lamp
    // halos and the 1.6 headlights — and both ends of the ramp are unchanged.
    // The knee rides the same ramp so the gate hardens as the emissive budget
    // takes over from the sunlit-diffuse shoulder.
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
    // The wide day radius smears the authored point emissives (stars, lamp
    // pools) into cotton after dark — night keeps the pre-port tight kernel.
    this.bloom.radius = BLOOM_RADIUS + (BLOOM_NIGHT_RADIUS - BLOOM_RADIUS) * night;
    this.composer.render();
  }
}
