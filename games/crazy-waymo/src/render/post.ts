import * as THREE from "three";
import { N8AOPass } from "n8ao";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { ShaderPass } from "three/addons/postprocessing/ShaderPass.js";
import { SMAAPass } from "three/addons/postprocessing/SMAAPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";

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
//   2. exposure (renderer.toneMappingExposure, via the day-night ramp)
//   3. highlight shoulder — a power-law rolloff gated on max(rgb) BEFORE ACES
//      so a 4x sky and a 20x glint still separate instead of both slamming
//      into the ACES ceiling; includes highlight desaturation toward luma.
//      Faded out at night: the night painting's emissive values are measured
//      against plain ACES and must not soften.
//   4. ACES fit (bit-for-bit three.js ACESFilmicToneMapping)
//   5. midtone S-curve — smoothstep-toward-self keeps 0 and 1 pinned so it
//      adds snap without crushing the shadow detail the AO pass paid for.
//      Day-only: the night mid-tone dip already owns that range.
//   6. teal-shadow / warm-highlight split tone. The cool axis is TEAL (G with
//      B above unity), not blue — pure blue against a warm key reads violet.
//      Day-weighted, and the warm side leans harder with uWarmth so golden
//      hour reads gilded rather than merely bright.
//   7. saturation lift with a highlight rolloff so bloomed glints go white,
//      not neon.
//   8. vignette — post-tonemap print-down; amount and inner edge close in
//      with speed.
//   9. monochrome grain, midtone-weighted, rolled off in shadows.
//  10. sRGB encode (this pass writes the canvas — no OutputPass follows).
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
    varying vec2 vUv;
    const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);
    // Shoulder: knee 0.9, exponent 0.72, desat 0.16 across a 30x span.
    const vec4 ROLLOFF = vec4(0.90, 0.72, 0.16, 30.0);
    float hash12(vec2 p) {
      vec3 q = fract(vec3(p.x, p.y, p.x) * 0.1031);
      q += dot(q, q.yzx + 33.33);
      return fract((q.x + q.y) * q.z);
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
      float dayW = 1.0 - uNight;
      c = mix(c, shoulder(c), dayW);
      c = acesToneMap(c);
      // Midtone S-curve, day-weighted.
      c = mix(c, c * c * (3.0 - 2.0 * c), uContrast * dayW);
      // Golden hour swims in amber: a whole-frame white-balance lean, not just
      // a highlight tint — at this game's exposure most of a street frame
      // lives in the midtones, and warming only the highs left golden hour
      // reading dusky-blue.
      c *= mix(vec3(1.0), vec3(1.05, 1.0, 0.93), uWarmth * dayW * 0.65);
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
      c *= mix(vec3(1.0), warmTint, highW * (0.55 + 0.30 * uWarmth));
      c = max(c, 0.0);
      // Saturation lift with highlight rolloff, day-weighted (night owns its
      // own desaturation painting).
      lum = dot(c, LUMA);
      float satAmt = 1.0 + (uSaturation - 1.0) * dayW;
      c = max(mix(vec3(lum), c, satAmt * (1.0 - 0.40 * smoothstep(0.70, 1.0, lum))), 0.0);
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

// Bloom is a DAY setting and a NIGHT setting, not one setting. The cut has to
// clear the lit sky by day (see the constructor note) — but that same 3.0 sits
// far above every night emissive the game draws: a lit window peaks near 1.1
// pre-tonemap, a lamp pool near 0.9, a headlight near 1.6. At a fixed 3.0
// NOTHING blooms after dark, which is why the night frame had no glow in it at
// all and every source read as a flat decal. Both numbers therefore ramp with
// the cycle: after dark the cut drops under the emissives and the strength
// comes up, so lamps, windows and headlights bleed the way a real night camera
// makes them. `UnrealBloomPass.render` copies both fields into its uniforms
// every frame, so writing the fields is the supported way to animate them.
const DAY_BLOOM_STRENGTH = 0.22;
// THE DAY CUT MUST CLEAR THE HORIZON, NOT JUST THE LIT SKY. Preetham's dome
// saturates at grazing angles — measured pre-tonemap, the bottom ~8° of sky
// sits at luminance 5.4 in EVERY azimuth at noon, well over the old 3.0 — so
// the whole horizon ring was being harvested and blurred back over the far
// city. That is the "milky mid-ground" in the Twin Peaks vista: with the cut
// moved above the band, that frame's >=88%-luminance share falls 11.3% -> 8.3%
// and its mean saturation RISES (16.2 -> 17.7), because what the veil was doing
// was washing chroma out of everything behind it.
//
// 6.5 clears the band with margin and still sits far under the sun disc
// (day-night.ts SUN_DISC_RADIANCE, 400), which is the one thing that should
// flare by day. Nothing else is lost: the additive FX (trails, boost rings,
// sparks) peak near 1-2 over a lit road, so they never crossed 3.0 either.
//
// AND THERE IS NO CUT THAT GIVES THEM ONE — but not because a lower cut costs
// anything. That was asserted from an analytic re-integration of the rolled-off
// dome (noon peaks 2.76 in the aureole, 1.9 along the horizon; golden 1.92) and
// the gate measured it instead: with the cut FORCED to 3.0 and then 2.5 at four
// cameras, the >=88%-luminance share moves by at most +0.8pp (Ocean Beach
// golden 9.68 -> 10.49, i.e. the sun's own glitter path) and by under 0.05pp at
// Twin Peaks noon, skyline-from-bay noon and a Nob Hill golden chase — and the
// same-camera pairs are indistinguishable. The veil does NOT come back at 2.5.
//
// The real reason is the arithmetic on the other side: the additive FX peak
// near 1-2, so a cut at 2.5 cannot bloom them either. To glow a drift trail you
// would need ~1.0, under the entire lit sky — THAT is where the veil lives. So
// 6.5 -> 3.0 is close to free and close to pointless; the FX glow and the clean
// horizon really are the same knob, just further apart than 3.0.
//
// If daytime FX glow is ever wanted, it is a second additive pass keyed off the
// FX layer, not a move of this constant.
const DAY_BLOOM_THRESHOLD = 6.5;
// The night cut sits just under the dimmest thing that should glow — the lamp
// pools, authored to ~0.9 at their core (fx/lamp-glow.ts POOL_GAIN) — and no
// lower. Below ~0.7 it starts catching LIT SURFACES too, and the one surface
// that is genuinely blown after dark (a wall 5 metres in front of the player's
// 70-candela spot) turns into a frame-filling white blob.
const NIGHT_BLOOM_STRENGTH = 0.5;
const NIGHT_BLOOM_THRESHOLD = 0.85;
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
// it is authored in fx/lamp-glow.ts and fx/night-windows.ts, and downtown it
// is the beacon layer's house gain (fx/beacon-lights.ts). Shrinking the two
// constants this side owns (MAST_HALO 1.5 -> 1.0, HALO_GAIN 3.4 -> 2.6) moved
// the facade mean 1.4% and the blown share 0.07pp and is invisible in a
// same-camera pair — do not spend those constants on it.

// Speed-reactive bloom: the lens brightens with pace, never with the clock.
// Additive on top of the day/night ramp; the transient ignite term buys the
// boost-release frame a halo without building a sustained veil.
const BLOOM_FAST_LIFT = 0.06;
const BLOOM_KICK_LIFT = 0.14;
const BLOOM_IGNITE_LIFT = 0.18;

// Chromatic aberration bounds (per-channel uv offset at |fromCentre| = 1).
const CA_REST = 0.00045;
const CA_BOOST = 0.0019;
// Vignette speed language: amount rises, inner edge walks in.
const VIGNETTE_BASE = 0.18;
const VIGNETTE_SPEED = 0.12;
const VIGNETTE_INNER_REST = 0.3;
const VIGNETTE_INNER_FAST = 0.18;

// N8AO: tight contact AO, cool-tinted, half-res. The radius stays SHORT —
// large radii produce the flat grey haze that gives cheap AO away; the point
// is the last metre where a wheel meets asphalt and a plinth meets pavement.
const AO_RADIUS = 1.6;
const AO_INTENSITY = 3.5;
const AO_COLOR = 0x101c2a;

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

export class PostPipeline {
  private composer: EffectComposer;
  // DEV probes reach in to A/B the AO contribution (debug/dev-hooks.ts).
  readonly ao: N8AOPass;
  private bloom: UnrealBloomPass;
  private grade: ShaderPass;
  private finalGrade: ShaderPass;
  private renderer: THREE.WebGLRenderer;
  private lastTime = 0;
  private fast = 0;
  private kick = 0;
  private kickSlow = 0;

  constructor(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera) {
    this.renderer = renderer;
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
    ao.configuration.denoiseRadius = 6;
    ao.configuration.halfRes = true;
    ao.configuration.depthAwareUpsampling = true;
    ao.configuration.screenSpaceRadius = false;
    // Output must stay linear HDR for the bloom threshold to mean anything.
    ao.configuration.gammaCorrection = false;
    ao.configuration.autoDetectTransparency = false;
    this.ao = ao;
    this.composer.addPass(ao);
    // Threshold sits in PRE-tonemap linear HDR, so every number here is a
    // radiance, not a pixel value: keep the cut high and the strength gentle —
    // bloom should kiss the emissives (lamps, windows, trails, sun glare), not
    // flood the frame. The vignette/vibrance grade does the daytime "pop".
    //
    // The cut has been chased upward twice by the same class of bug, and both
    // times the frame it ruined was a driver looking west into the sun: 2.2 put
    // 30-32% of the frame over 92% luminance, and 3.0 — which does clear the
    // LIT sky — still sat under the horizon ring and under a sun disc three
    // orders of magnitude over it. See DAY_BLOOM_THRESHOLD for what 6.5 clears
    // and day-night.ts SUN_DISC_RADIANCE for the disc that made the cut
    // unwinnable at any value.
    this.bloom = new UnrealBloomPass(size, DAY_BLOOM_STRENGTH, 0.3, DAY_BLOOM_THRESHOLD);
    this.composer.addPass(this.bloom);
    this.grade = new ShaderPass(GradeShader);
    this.composer.addPass(this.grade);
    // SMAA runs on linear values by three's own contract (before tone map).
    this.composer.addPass(new SMAAPass());
    this.finalGrade = new ShaderPass(FinalGradeShader);
    this.composer.addPass(this.finalGrade);
    this.syncViewportUniforms(size.x, size.y);
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
  }

  render(): void {
    const now = performance.now() / 1000;
    const dt = this.lastTime > 0 ? Math.min(0.1, now - this.lastTime) : 1 / 60;
    this.lastTime = now;

    const night = gradeNight();
    const warmth = gradeWarmth();
    const motion = gradeMotion();

    // Signal easing. `fast` opens above ~62% of boost top speed.
    const fastTarget = THREE.MathUtils.clamp((motion.speed - 0.62) / 0.38, 0, 1);
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

    // The cut falls on sqrt(night), not on night. `night` IS the lamp factor,
    // so at dusk it is still only ~0.6 when every streetlight in the city is
    // already burning — and a linearly-interpolated cut is 3.0 there, above the
    // 3.4 lamp halo it exists to catch. The day end of that lerp used to be
    // 3.0, so the error was small; at 6.5 it would leave dusk with no glow at
    // all. Square-rooting drops the cut early, in step with the lamps, and both
    // ends of the ramp are unchanged.
    this.bloom.threshold =
      DAY_BLOOM_THRESHOLD + (NIGHT_BLOOM_THRESHOLD - DAY_BLOOM_THRESHOLD) * Math.sqrt(night);
    this.bloom.strength =
      DAY_BLOOM_STRENGTH +
      (NIGHT_BLOOM_STRENGTH - DAY_BLOOM_STRENGTH) * night +
      BLOOM_FAST_LIFT * this.fast +
      BLOOM_KICK_LIFT * this.kick +
      BLOOM_IGNITE_LIFT * ignite;
    this.composer.render();
  }
}
