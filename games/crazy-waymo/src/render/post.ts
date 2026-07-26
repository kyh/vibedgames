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
        // Chroma out of the day albedos. Not to grey: 0.56 leaves enough hue
        // that a red car still reads red under its own tail lights.
        c.rgb = mix(c.rgb, vec3(nl), 0.56 * uNight);
        // Split tone. The ramp is deliberately low (a night frame lives in the
        // bottom of the range) so ordinary lit facades already count as the
        // warm end, not just the emissives.
        float t = smoothstep(0.015, 0.42, nl);
        vec3 shade = mix(vec3(0.74, 0.85, 1.20), vec3(1.20, 1.03, 0.76), t);
        c.rgb *= mix(vec3(1.0), shade, uNight);
        // Crush the near-blacks so the darks stop sitting at the same value as
        // the mid-tones — the "3-point spread" the night bands measured at.
        c.rgb *= mix(1.0, 0.62 + 0.38 * smoothstep(0.0, 0.09, nl), uNight);
      }
      vec2 d = vUv - 0.5;
      c.rgb *= 1.0 - uVignette * smoothstep(0.15, 0.5, dot(d, d));
      gl_FragColor = c;
    }
  `,
};

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
    // Threshold sits in PRE-tonemap linear HDR: the daylight horizon sky is
    // ~2+ there, so keep the cut high and the strength gentle — bloom should
    // kiss the emissives (lamps, windows, trails, sun glare), not flood the
    // frame. The vignette/vibrance grade does the daytime "pop", not bloom.
    //
    // 2.2 was under the daylight horizon, not over it: driving west into a
    // golden-hour sun put 30–32% of the frame above 92% luminance and the road
    // itself disappeared. 3.0 clears the lit sky and still catches lamps, lit
    // windows, trails and the sun disc, which sit well above it; strength comes
    // up a notch so those emissives lose nothing to the higher cut.
    this.bloom = new UnrealBloomPass(size, 0.22, 0.3, 3.0);
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
    const u = this.grade.uniforms.uNight;
    if (u) u.value = gradeNight();
    this.composer.render();
  }
}
