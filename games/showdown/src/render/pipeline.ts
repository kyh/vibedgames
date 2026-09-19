// Renderer + post-processing chain: scene render -> NaN/Inf sanitize -> GTAO
// (high tiers) -> bloom -> colour grade -> output. Rebuilt whenever the
// quality tier changes, since MSAA sample count and AO are baked into the
// composer's render targets.
import * as THREE from "three";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { GTAOPass } from "three/addons/postprocessing/GTAOPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { ShaderPass } from "three/addons/postprocessing/ShaderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { isQualityName, QUALITIES } from "../config";
import type { Quality, QualityName } from "../config";
import { SceneAoPass } from "./ao-pass";
import { installPcssShadows } from "./pcss";

export interface PipelineToggles {
  ao: boolean;
  bloom: boolean;
}
export type ToggleName = keyof PipelineToggles;

const CLEAR_COLOR = 0x0b_0e_1a;

// A single NaN in the HDR buffer smears into a black rectangle once bloom
// blurs it, so scrub the scene colour before any pass reads it.
const SANITIZE_SHADER = {
  fragmentShader: `
    uniform sampler2D tDiffuse;
    varying vec2 vUv;
    void main() {
      vec4 c = texture2D( tDiffuse, vUv );
      bvec3 bad = bvec3( isnan( c.r ) || isinf( c.r ), isnan( c.g ) || isinf( c.g ), isnan( c.b ) || isinf( c.b ) );
      c.rgb = mix( c.rgb, vec3( 0.0 ), vec3( bad ) );
      gl_FragColor = vec4( clamp( c.rgb, 0.0, 120.0 ), 1.0 );
    }`,
  name: "SanitizeShader",
  uniforms: { tDiffuse: { value: null } },
  vertexShader: `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
    }`,
};

// Vignette, saturation and a night tint that only colours the dark end, so
// lamp-lit areas keep their warmth. The lighting rig drives the uniforms.
const GRADE_SHADER = {
  fragmentShader: `
    uniform sampler2D tDiffuse;
    uniform float uVignette;
    uniform float uSaturation;
    uniform vec3 uTint;
    varying vec2 vUv;
    void main() {
      vec4 c = texture2D( tDiffuse, vUv );
      vec2 d = ( vUv - 0.5 ) * vec2( 1.0, 1.12 );
      float v = smoothstep( 0.9, 0.3, length( d ) );
      c.rgb *= mix( 1.0 - uVignette, 1.0, v );
      float l = dot( c.rgb, vec3( 0.2126, 0.7152, 0.0722 ) );
      // split-tone: uTint colours the dark end only, so lamp-lit areas keep their warmth
      vec3 tint = mix( uTint, vec3( 1.0 ), smoothstep( 0.04, 0.75, l ) );
      c.rgb = max( mix( vec3( l ), c.rgb, uSaturation ), 0.0 ) * tint;
      gl_FragColor = c;
    }`,
  name: "GradeShader",
  uniforms: {
    tDiffuse: { value: null },
    uSaturation: { value: 1.1 },
    uTint: { value: new THREE.Color(1, 1, 1) },
    uVignette: { value: 0.32 },
  },
  vertexShader: `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
    }`,
};

// With PCSS spliced in, the shader does all the filtering itself and the
// hardware filter must stay off.
const shadowMapTypeFor = (pcss: boolean): THREE.ShadowMapType =>
  pcss ? THREE.BasicShadowMap : THREE.PCFShadowMap;

const buildAoPass = (
  scene: THREE.Scene,
  camera: THREE.Camera,
  size: THREE.Vector2,
  enabled: boolean,
): SceneAoPass => {
  const pass = new SceneAoPass(scene, camera, size.x, size.y);
  pass.output = GTAOPass.OUTPUT.Default;
  pass.blendIntensity = 0.85;
  pass.updateGtaoMaterial({
    distanceExponent: 1.4,
    distanceFallOff: 1,
    radius: 0.55,
    samples: 16,
    scale: 1.15,
    screenSpaceRadius: false,
    thickness: 1.2,
  });
  pass.updatePdMaterial({
    depthPhi: 2,
    lumaPhi: 10,
    normalPhi: 3,
    radius: 7,
    radiusExponent: 1.2,
    rings: 2,
    samples: 14,
  });
  pass.enabled = enabled;
  return pass;
};

export class Pipeline {
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  readonly pcssAvailable: boolean;
  readonly renderer: THREE.WebGLRenderer;
  qualityName: QualityName;
  quality: Quality;
  toggles: PipelineToggles;
  // >0 forces this pixel ratio (the `?ss=` param); 0 follows the quality tier
  superSample: number;
  composer: EffectComposer | null;
  gtao: SceneAoPass | null;
  bloom: UnrealBloomPass | null;
  grade: ShaderPass | null;
  width: number;
  height: number;

  constructor(canvas: HTMLCanvasElement, scene: THREE.Scene, camera: THREE.PerspectiveCamera) {
    this.scene = scene;
    this.camera = camera;
    this.pcssAvailable = installPcssShadows();
    const renderer = new THREE.WebGLRenderer({
      antialias: false,
      canvas,
      powerPreference: "high-performance",
      stencil: false,
    });
    this.renderer = renderer;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = shadowMapTypeFor(this.pcssAvailable);
    // The composer renders the scene more than once per frame (GTAO's
    // normal/depth pre-pass), so render() arms the shadow maps by hand and only
    // the first scene render redraws them.
    renderer.shadowMap.autoUpdate = false;
    renderer.setClearColor(CLEAR_COLOR, 1);
    this.qualityName = "high";
    this.quality = QUALITIES.high;
    this.toggles = { ao: true, bloom: true };
    this.superSample = 0;
    this.composer = null;
    this.gtao = null;
    this.bloom = null;
    this.grade = null;
    this.width = 1;
    this.height = 1;
  }

  get usingPCSS(): boolean {
    return this.pcssAvailable && this.quality.pcss;
  }

  setQuality(name: string): void {
    if (!isQualityName(name)) {
      return;
    }
    this.qualityName = name;
    this.quality = QUALITIES[name];
    const shadowType = shadowMapTypeFor(this.usingPCSS);
    if (this.renderer.shadowMap.type !== shadowType) {
      this.renderer.shadowMap.type = shadowType;
    }
    this.build();
  }

  build(): void {
    const { quality, renderer } = this;
    const width = Math.max(2, window.innerWidth);
    const height = Math.max(2, window.innerHeight);
    const pixelRatio =
      this.superSample > 0 ? this.superSample : Math.min(window.devicePixelRatio || 1, quality.dpr);
    renderer.setPixelRatio(pixelRatio);
    renderer.setSize(width, height, false);
    this.width = width;
    this.height = height;
    if (this.composer) {
      for (const pass of this.composer.passes) {
        pass.dispose();
      }
      this.composer.dispose();
    }
    const bufferSize = renderer.getDrawingBufferSize(new THREE.Vector2());
    const composer = new EffectComposer(
      renderer,
      new THREE.WebGLRenderTarget(bufferSize.x, bufferSize.y, {
        samples: quality.msaa,
        type: THREE.HalfFloatType,
      }),
    );
    composer.setPixelRatio(pixelRatio);
    composer.setSize(width, height);
    this.composer = composer;
    composer.addPass(new RenderPass(this.scene, this.camera));
    composer.addPass(new ShaderPass(SANITIZE_SHADER));
    this.gtao = null;
    if (quality.ao) {
      const gtao = buildAoPass(this.scene, this.camera, bufferSize, this.toggles.ao);
      composer.addPass(gtao);
      this.gtao = gtao;
    }
    const bloom = new UnrealBloomPass(
      new THREE.Vector2(bufferSize.x, bufferSize.y),
      0.5,
      0.72,
      1.2,
    );
    bloom.enabled = quality.bloom && this.toggles.bloom;
    this.bloom = bloom;
    composer.addPass(bloom);
    this.grade = new ShaderPass(GRADE_SHADER);
    composer.addPass(this.grade);
    composer.addPass(new OutputPass());
  }

  setToggle(name: ToggleName, on: boolean): void {
    this.toggles[name] = on;
    if (name === "ao" && this.gtao) {
      this.gtao.enabled = on;
    }
    if (name === "bloom" && this.bloom) {
      this.bloom.enabled = on && this.quality.bloom;
    }
  }

  resize(): void {
    const width = Math.max(2, window.innerWidth);
    const height = Math.max(2, window.innerHeight);
    if (width === this.width && height === this.height) {
      return;
    }
    this.width = width;
    this.height = height;
    this.renderer.setSize(width, height, false);
    this.requireComposer().setSize(width, height);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }

  render(dt: number): void {
    this.renderer.shadowMap.needsUpdate = true;
    this.requireComposer().render(dt);
  }

  private requireComposer(): EffectComposer {
    if (!this.composer) {
      throw new Error("Pipeline.build() must run before the first frame");
    }
    return this.composer;
  }
}
