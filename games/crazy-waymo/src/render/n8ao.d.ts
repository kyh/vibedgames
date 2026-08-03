// n8ao ships no type declarations; this covers the surface the post chain
// uses. The pass is built for three's example EffectComposer (renders the
// scene itself into an internal half-float target — it REPLACES RenderPass).
declare module "n8ao" {
  import type * as THREE from "three";
  import { Pass } from "three/addons/postprocessing/Pass.js";

  export type N8AOConfiguration = {
    aoRadius: number;
    distanceFalloff: number;
    intensity: number;
    color: THREE.Color;
    aoSamples: number;
    denoiseSamples: number;
    denoiseRadius: number;
    denoiseIterations: number;
    halfRes: boolean;
    depthAwareUpsampling: boolean;
    screenSpaceRadius: boolean;
    gammaCorrection: boolean;
    autoDetectTransparency: boolean;
    transparencyAware: boolean;
    accumulate: boolean;
    renderMode: number;
  };

  export class N8AOPass extends Pass {
    constructor(scene: THREE.Scene, camera: THREE.Camera, width?: number, height?: number);
    readonly configuration: N8AOConfiguration;
    setSize(width: number, height: number): void;
  }
}
