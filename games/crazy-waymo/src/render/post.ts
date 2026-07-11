import * as THREE from "three";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { ShaderPass } from "three/addons/postprocessing/ShaderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";

// Desktop-only post chain (Mario-Kart pass): threshold bloom so the additive
// FX (drift trails, boost, lamp glow, lit windows) actually GLOW, plus a
// gentle vibrance + vignette grade. Mobile stays on the single forward pass —
// the tile-GPU bandwidth cost isn't worth it (and the governor already fights
// for frame time there).
//
// Tone mapping moves to the OutputPass automatically: it reads the renderer's
// toneMapping/exposure every frame, so the day-night exposure ramp keeps
// working unchanged.

const GradeShader = {
  name: "WaymoGradeShader",
  uniforms: {
    tDiffuse: { value: null },
    uVibrance: { value: 0.14 },
    uVignette: { value: 0.18 },
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
    varying vec2 vUv;
    void main() {
      vec4 c = texture2D(tDiffuse, vUv);
      // Vibrance: push saturation hardest where there is least of it, so the
      // already-loud paint doesn't clip while the drab mid-tones wake up.
      float l = dot(c.rgb, vec3(0.2126, 0.7152, 0.0722));
      float sat = max(c.r, max(c.g, c.b)) - min(c.r, min(c.g, c.b));
      c.rgb = mix(vec3(l), c.rgb, 1.0 + uVibrance * (1.0 - clamp(sat, 0.0, 1.0)));
      vec2 d = vUv - 0.5;
      c.rgb *= 1.0 - uVignette * smoothstep(0.15, 0.5, dot(d, d));
      gl_FragColor = c;
    }
  `,
};

export class PostPipeline {
  private composer: EffectComposer;
  private bloom: UnrealBloomPass;

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
    this.bloom = new UnrealBloomPass(size, 0.18, 0.3, 2.2);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new ShaderPass(GradeShader));
    this.composer.addPass(new OutputPass());
  }

  setSize(width: number, height: number, pixelRatio: number): void {
    this.composer.setPixelRatio(pixelRatio);
    this.composer.setSize(width, height);
  }

  render(): void {
    this.composer.render();
  }
}
