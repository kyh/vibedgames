import * as THREE from "three";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { ShaderPass } from "three/addons/postprocessing/ShaderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";

import { gradeNight } from "./grade";

// Desktop-only post chain (Mario-Kart pass): threshold bloom so the additive
// FX (drift trails, boost, lamp glow, lit windows) actually GLOW, plus a
// gentle vibrance + vignette grade. Mobile stays on the single forward pass —
// the tile-GPU bandwidth cost isn't worth it (and the governor already fights
// for frame time there).
//
// Tone mapping moves to the OutputPass automatically: it reads the renderer's
// toneMapping/exposure every frame, so the day-night exposure ramp keeps
// working unchanged.

// The grade runs BEFORE OutputPass, i.e. on pre-tone-map linear HDR. Every
// operation below is therefore a linear-light one (mixes toward luminance,
// channel gains) — an sRGB-shaped curve here would fight the tone mapper.
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
    uVignette: { value: 0.18 },
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
    uniform float uVignette;
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
      vec2 d = vUv - 0.5;
      c.rgb *= 1.0 - uVignette * smoothstep(0.15, 0.5, dot(d, d));
      gl_FragColor = c;
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
const DAY_BLOOM_THRESHOLD = 6.5;
// The night cut sits just under the dimmest thing that should glow — the lamp
// pools, authored to ~0.9 at their core (fx/lamp-glow.ts POOL_GAIN) — and no
// lower. Below ~0.7 it starts catching LIT SURFACES too, and the one surface
// that is genuinely blown after dark (a wall 5 metres in front of the player's
// 70-candela spot) turns into a frame-filling white blob.
const NIGHT_BLOOM_STRENGTH = 0.5;
const NIGHT_BLOOM_THRESHOLD = 0.85;

export class PostPipeline {
  private composer: EffectComposer;
  private bloom: UnrealBloomPass;
  private grade: ShaderPass;

  constructor(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera) {
    // Explicit HDR + MSAA target: bloom needs >8bit to find highlights, and
    // the composer must not silently drop the context's antialiasing.
    const size = renderer.getDrawingBufferSize(new THREE.Vector2());
    const target = new THREE.WebGLRenderTarget(size.x, size.y, {
      type: THREE.HalfFloatType,
      samples: 4,
    });
    this.composer = new EffectComposer(renderer, target);
    this.composer.addPass(new RenderPass(scene, camera));
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
    this.composer.addPass(new OutputPass());
  }

  setSize(width: number, height: number, pixelRatio: number): void {
    this.composer.setPixelRatio(pixelRatio);
    this.composer.setSize(width, height);
  }

  render(): void {
    const night = gradeNight();
    const u = this.grade.uniforms.uNight;
    if (u) u.value = night;
    // The cut falls on sqrt(night), not on night. `night` IS the lamp factor,
    // so at dusk it is still only ~0.6 when every streetlight in the city is
    // already burning — and a linearly-interpolated cut is 3.0 there, above the
    // 3.4 lamp halo it exists to catch. The day end of that lerp used to be
    // 3.0, so the error was small; at 6.5 it would leave dusk with no glow at
    // all. Square-rooting drops the cut early, in step with the lamps, and both
    // ends of the ramp are unchanged.
    this.bloom.threshold =
      DAY_BLOOM_THRESHOLD + (NIGHT_BLOOM_THRESHOLD - DAY_BLOOM_THRESHOLD) * Math.sqrt(night);
    this.bloom.strength = DAY_BLOOM_STRENGTH + (NIGHT_BLOOM_STRENGTH - DAY_BLOOM_STRENGTH) * night;
    this.composer.render();
  }
}
