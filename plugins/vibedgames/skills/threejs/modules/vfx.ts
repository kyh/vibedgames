import {
  BufferAttribute,
  BufferGeometry,
  DepthFormat,
  DepthTexture,
  DynamicDrawUsage,
  FloatType,
  NearestFilter,
  Vector2,
  Vector3,
  WebGLRenderTarget,
} from "three";
import type { Camera, IUniform, Object3D, PerspectiveCamera, Scene, WebGLRenderer } from "three";

import { clamp01 } from "./math";

/** Beat boundaries of one signature effect, as fractions of its life (0..1, ascending). */
export interface EffectBeats {
  /** End of anticipation: energy gathers toward the socket. */
  telegraph: number;
  /** End of telegraph: the threat shape is fully drawn. */
  hold: number;
  /** End of the pre-impact hold dip; the peak starts here. */
  peak: number;
  /** End of the peak frames; the sustained payload starts here. */
  payload: number;
  /** End of the payload; the cooling aftermath runs to 1. */
  aftermath: number;
}

export const DEFAULT_BEATS: EffectBeats = {
  telegraph: 0.2,
  hold: 0.35,
  peak: 0.42,
  payload: 0.47,
  aftermath: 0.8,
};

const easeIn = (t: number) => t * t * t;
const easeOutExpo = (t: number) => (t >= 1 ? 1 : 1 - 2 ** (-10 * t));

/**
 * Intensity of a five-beat effect at `age` (fraction of its life). Rises through
 * anticipation and telegraph, dips during the hold, spikes to `peakGain` for the
 * peak, settles to 1 for the payload and cools to 0. A pure function of age, so
 * pause, hitstop, scrubbing and screenshots all agree.
 */
export const beatEnvelope = (age: number, beats: EffectBeats = DEFAULT_BEATS, peakGain = 2.8) => {
  const t = clamp01(age);

  if (t < beats.telegraph) {
    return 0.6 * easeIn(t / beats.telegraph);
  }

  if (t < beats.hold) {
    return 0.6 + 0.2 * ((t - beats.telegraph) / (beats.hold - beats.telegraph));
  }

  if (t < beats.peak) {
    return 0.8 * (1 - (t - beats.hold) / (beats.peak - beats.hold)) + 0.05;
  }

  if (t < beats.payload) {
    return peakGain;
  }

  if (t < beats.aftermath) {
    const k = (t - beats.payload) / (beats.aftermath - beats.payload);

    return peakGain + (1 - peakGain) * easeOutExpo(k);
  }

  return 1 - easeOutExpo((t - beats.aftermath) / (1 - beats.aftermath));
};

/** A one-shot cue on an effect's clock, in seconds from the effect's start. */
export interface TimedCue {
  id: string;
  at: number;
}

/**
 * Cues crossed between two readings of an effect clock. Returns nothing when the
 * clock went backwards or jumped by more than `maxStep` (pause, reset, scrub), so
 * scrubbing never stacks one-shots.
 */
export const crossedCues = <C extends TimedCue>(
  cues: readonly C[],
  previous: number,
  current: number,
  maxStep = 0.25,
) => {
  if (current <= previous || current - previous > maxStep) {
    return [];
  }

  return cues.filter((cue) => previous < cue.at && current >= cue.at);
};

/** Uniforms every depth-faded material shares, by reference, with the prepass. */
export interface DepthUniforms {
  tDepth: IUniform<DepthTexture | null>;
  uResolution: IUniform<Vector2>;
  uCameraNear: IUniform<number>;
  uCameraFar: IUniform<number>;
  uHasDepth: IUniform<number>;
}

/**
 * GLSL for soft particles and contact rims. Needs `#include <packing>` before it.
 * `sceneDepthGap()` is the view-space distance from this fragment to the opaque
 * surface behind it, or 99 when the prepass is off.
 */
export const DEPTH_FADE_GLSL = `
  uniform sampler2D tDepth;
  uniform vec2 uResolution;
  uniform float uCameraNear;
  uniform float uCameraFar;
  uniform float uHasDepth;

  float sceneDepthGap() {
    if (uHasDepth < 0.5) return 99.0;
    vec2 screenUv = gl_FragCoord.xy / max(uResolution, vec2(1.0));
    float sceneZ = perspectiveDepthToViewZ(texture2D(tDepth, screenUv).r, uCameraNear, uCameraFar);
    float fragZ = perspectiveDepthToViewZ(gl_FragCoord.z, uCameraNear, uCameraFar);
    return max(0.0, fragZ - sceneZ);
  }
`;

/**
 * Renders the opaque scene's depth into a texture that transparent effects sample.
 * Effects live under `vfxRoot`, which is hidden for the prepass: a material that
 * samples `tDepth` while the prepass writes it is a WebGL feedback loop.
 *
 * Call `render(scene, camera)` before `composer.render()` every frame, `resize()`
 * after `renderer.setSize`, and `setEnabled(false)` on low tiers (depth-faded
 * materials fall back to hard edges). Spread `uniforms` into each depth-faded
 * material's uniforms; they share them by reference.
 */
export const createDepthPrepass = (renderer: WebGLRenderer, vfxRoot: Object3D, enabled = true) => {
  const size = renderer.getDrawingBufferSize(new Vector2());

  const target = new WebGLRenderTarget(size.x, size.y, {
    magFilter: NearestFilter,
    minFilter: NearestFilter,
  });

  const depth = new DepthTexture(size.x, size.y, FloatType);
  depth.format = DepthFormat;
  target.depthTexture = depth;

  const uniforms: DepthUniforms = {
    tDepth: { value: depth },
    uCameraFar: { value: 1000 },
    uCameraNear: { value: 0.1 },
    uHasDepth: { value: enabled ? 1 : 0 },
    uResolution: { value: size.clone() },
  };

  return {
    dispose: () => {
      depth.dispose();
      target.dispose();
    },

    render: (scene: Scene, camera: PerspectiveCamera) => {
      uniforms.uCameraNear.value = camera.near;
      uniforms.uCameraFar.value = camera.far;

      if (uniforms.uHasDepth.value < 0.5) {
        return;
      }

      const wasVisible = vfxRoot.visible;
      vfxRoot.visible = false;
      renderer.setRenderTarget(target);
      renderer.clear();
      renderer.render(scene, camera);
      renderer.setRenderTarget(null);
      vfxRoot.visible = wasVisible;
    },

    resize: () => {
      renderer.getDrawingBufferSize(size);
      target.setSize(size.x, size.y);
      uniforms.uResolution.value.copy(size);
    },

    setEnabled: (on: boolean) => {
      uniforms.uHasDepth.value = on ? 1 : 0;
    },

    uniforms,
  };
};

/**
 * A ribbon of quads that always faces the camera, for lightning, beams and trails.
 * Buffers are sized once; `update` rewrites them in place. Culling is off because
 * the bounds would be stale the moment the points move.
 */
export class CameraFacingStrip {
  readonly count: number;
  readonly geometry = new BufferGeometry();
  readonly points: Vector3[];
  widthEnd: number;
  widthStart: number;
  private readonly cameraPosition = new Vector3();
  private readonly positions: Float32Array;
  private readonly side = new Vector3();
  private readonly tangent = new Vector3();
  private readonly toCamera = new Vector3();

  constructor(count: number, widthStart = 0.2, widthEnd = 0) {
    this.count = count;
    this.widthStart = widthStart;
    this.widthEnd = widthEnd;
    this.points = Array.from({ length: count }, () => new Vector3());
    this.positions = new Float32Array(count * 2 * 3);
    const uvs = new Float32Array(count * 2 * 2);
    const indices: number[] = [];

    for (let i = 0; i < count; i += 1) {
      const u = count > 1 ? i / (count - 1) : 0;
      uvs.set([u, 0, u, 1], i * 4);

      if (i < count - 1) {
        const a = i * 2;
        indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
      }
    }

    const position = new BufferAttribute(this.positions, 3);
    position.setUsage(DynamicDrawUsage);
    this.geometry.setAttribute("position", position);
    this.geometry.setAttribute("uv", new BufferAttribute(uvs, 2));
    this.geometry.setIndex(indices);
  }

  /** Re-extrude around `points` toward the camera. U runs along the strip, V across it. */
  update(camera: Camera) {
    const last = this.count - 1;
    camera.getWorldPosition(this.cameraPosition);

    for (let i = 0; i <= last; i += 1) {
      const point = this.points[i];
      const ahead = this.points[Math.min(i + 1, last)];
      const behind = this.points[Math.max(i - 1, 0)];

      if (!(point && ahead && behind)) {
        continue;
      }

      this.tangent.subVectors(ahead, behind);
      this.toCamera.subVectors(this.cameraPosition, point);
      this.side.crossVectors(this.tangent, this.toCamera);
      const length = this.side.length();

      if (length < 1e-6) {
        this.side.set(0, 0, 0);
      } else {
        const u = last > 0 ? i / last : 0;
        this.side.multiplyScalar(
          (this.widthStart + (this.widthEnd - this.widthStart) * u) / 2 / length,
        );
      }

      const o = i * 6;
      this.positions[o] = point.x + this.side.x;
      this.positions[o + 1] = point.y + this.side.y;
      this.positions[o + 2] = point.z + this.side.z;
      this.positions[o + 3] = point.x - this.side.x;
      this.positions[o + 4] = point.y - this.side.y;
      this.positions[o + 5] = point.z - this.side.z;
    }

    const position = this.geometry.getAttribute("position");
    position.needsUpdate = true;
  }

  dispose() {
    this.geometry.dispose();
  }
}

const basisSide = new Vector3();
const basisUp = new Vector3();
const span = new Vector3();

/**
 * Lay a lightning spine from `start` to `end` into `out`. Interior points jitter
 * across the bolt, scaled by `sin(u * PI)` so both ends stay pinned to their
 * sockets. `random` must be seeded from a stepped clock (`Math.floor(t * 24)`), so
 * the bolt snaps at 24 fps however fast the screen refreshes.
 */
export const layLightning = (
  out: Vector3[],
  start: Vector3,
  end: Vector3,
  jitter: number,
  random: () => number,
) => {
  span.subVectors(end, start);
  basisSide.set(0, 1, 0).cross(span);

  if (basisSide.lengthSq() < 1e-8) {
    basisSide.set(1, 0, 0).cross(span);
  }

  basisSide.normalize();
  basisUp.crossVectors(span, basisSide).normalize();
  const last = out.length - 1;

  for (let i = 0; i <= last; i += 1) {
    const point = out[i];

    if (!point) {
      continue;
    }

    const u = last > 0 ? i / last : 0;
    const envelope = Math.sin(u * Math.PI) * jitter;
    point
      .copy(start)
      .addScaledVector(span, u)
      .addScaledVector(basisSide, (random() * 2 - 1) * envelope)
      .addScaledVector(basisUp, (random() * 2 - 1) * envelope);
  }
};

const projected = new Vector3();

/**
 * Screen UV (0..1) of a world point, for a screen-space pass's `uTarget`.
 * Returns false when the point is behind the camera: fade the effect out then,
 * or its distortion lands mirrored on screen.
 */
export const worldToScreenUv = (world: Vector3, camera: Camera, out: Vector2) => {
  projected.copy(world).project(camera);
  out.set(projected.x * 0.5 + 0.5, projected.y * 0.5 + 0.5);

  return projected.z <= 1;
};

/**
 * Screen-space shockwave and heat haze in one pass. Put it after `OutputPass`
 * (`new ShaderPass(SHOCKWAVE_SHADER)`). Both strengths at 0 cost one texture read.
 */
export const SHOCKWAVE_SHADER = {
  fragmentShader: `
    uniform sampler2D tDiffuse;
    uniform vec2 uTarget;
    uniform float uAspect;
    uniform float uTime;
    uniform float uWaveProgress;
    uniform float uWaveStrength;
    uniform float uHaze;
    varying vec2 vUv;

    void main() {
      if (uWaveStrength < 0.001 && uHaze < 0.001) {
        gl_FragColor = texture2D(tDiffuse, vUv);
        return;
      }
      vec2 offset = vUv - uTarget;
      offset.x *= uAspect;
      float radius = length(offset);
      vec2 direction = offset / max(radius, 1e-4);
      direction.x /= uAspect;

      float band = (radius - uWaveProgress * 0.6) / 0.065;
      float ring = exp(-(band * band)) * uWaveStrength * (1.0 - uWaveProgress);
      vec2 uv = vUv - direction * ring * 0.04;

      float hazeMask = exp(-radius * radius * 5.2) * uHaze;
      uv.x += sin(vUv.y * 90.0 - uTime * 6.0) * 0.003 * hazeMask;
      uv.y += sin(vUv.x * 70.0 + uTime * 4.0) * 0.002 * hazeMask;

      vec4 color = texture2D(tDiffuse, uv);
      color.r = texture2D(tDiffuse, uv + direction * ring * 0.006).r;
      gl_FragColor = color;
    }
  `,
  uniforms: {
    tDiffuse: { value: null },
    uAspect: { value: 16 / 9 },
    uHaze: { value: 0 },
    uTarget: { value: new Vector2(0.5, 0.5) },
    uTime: { value: 0 },
    uWaveProgress: { value: 0 },
    uWaveStrength: { value: 0 },
  },
  vertexShader: `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
};
