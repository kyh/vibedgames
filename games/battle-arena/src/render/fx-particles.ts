import * as THREE from "three";
import { Pool } from "./fx-particle-pool";
import type { ParticlePriority, SpawnOptions } from "./fx-particle-pool";

export type { ParticlePriority, SpawnOptions } from "./fx-particle-pool";

export type ParticleKind = "add" | "normal";

/** Standard HDR multiplier for bloom-worthy cores (bloom threshold is 0.82). */
export const HDR_BRIGHT = 2.2;

export interface BurstOptions {
  priority?: ParticlePriority;
  x: number;
  y: number;
  z: number;
  color: number;
  /** Base radial speed — each particle rolls 0.5–1.5×. */
  speed: number;
  /** Base life — each particle rolls 0.7–1.3×. */
  life: number;
  /** Base size — each particle rolls 0.7–1.3× (default 0.6). */
  size?: number;
  /** Vertical fraction of the rolled speed (default 0.6, matches fx.burst). */
  upBias?: number;
  gravity?: number;
  drag?: number;
  stretch?: boolean;
  bright?: number;
  alpha?: number;
}

const scratchBurst: SpawnOptions = { life: 0.3, size: 0.6, x: 0, y: 0, z: 0 };

const ADD_CAP = 512;
const NORMAL_CAP = 160;

export class ParticlePools {
  private readonly add: Pool;
  private readonly normal: Pool;
  private readonly addMat: THREE.MeshBasicMaterial;

  private readonly scene: THREE.Scene;

  constructor(scene: THREE.Scene) {
    this.scene = scene;
    const addGeo = new THREE.SphereGeometry(0.16, 6, 5);

    const addMat = new THREE.MeshBasicMaterial({
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      toneMapped: true,
      transparent: true,
    });

    this.addMat = addMat;
    this.add = new Pool(addGeo, addMat, ADD_CAP, 96, true, 11, null);

    const normalGeo = new THREE.SphereGeometry(0.16, 6, 5);
    const alphaAttr = new THREE.InstancedBufferAttribute(new Float32Array(NORMAL_CAP), 1);
    alphaAttr.setUsage(THREE.DynamicDrawUsage);
    normalGeo.setAttribute("aAlpha", alphaAttr);

    const normalMat = new THREE.MeshBasicMaterial({
      blending: THREE.NormalBlending,
      depthWrite: false,
      transparent: true,
    });

    normalMat.onBeforeCompile = (shader) => {
      shader.vertexShader = shader.vertexShader
        .replace(
          "#include <common>",
          "#include <common>\nattribute float aAlpha;\nvarying float vPAlpha;",
        )
        .replace("#include <begin_vertex>", "#include <begin_vertex>\nvPAlpha = aAlpha;");
      shader.fragmentShader = shader.fragmentShader
        .replace("#include <common>", "#include <common>\nvarying float vPAlpha;")
        .replace(
          "#include <color_fragment>",
          "#include <color_fragment>\ndiffuseColor.a *= vPAlpha;",
        );
    };

    normalMat.customProgramCacheKey = () => "fx-particles-alpha";
    this.normal = new Pool(normalGeo, normalMat, NORMAL_CAP, 32, false, 10, alphaAttr);

    scene.add(this.normal.mesh);
    scene.add(this.add.mesh);
  }

  /**
   * Scale every ADD particle at once (1 = untouched). The ADD material's own
   * color is a constant white that instanceColor multiplies, so it is the one
   * place a gain can ride without being clobbered by the next spawn — and under
   * additive blending a color scale IS an energy scale.
   *
   * Written only by Fx.setFlashGain (trailer-only); see the note there.
   */
  setAddGain(gain: number) {
    this.addMat.color.setScalar(gain);
  }

  /** Spawn one particle. Copies `o` immediately — callers may reuse a scratch. */
  spawn(kind: ParticleKind, o: SpawnOptions) {
    (kind === "add" ? this.add : this.normal).spawn(o);
  }

  /** Convenience: omnidirectional burst with fx.ts-style jitter (fire/magic pops). */
  burst(kind: ParticleKind, n: number, o: BurstOptions) {
    const upBias = o.upBias ?? 0.6;

    for (let i = 0; i < n; i += 1) {
      const a = Math.random() * Math.PI * 2;
      const up = Math.random() * 0.8 + 0.2;
      const sp = o.speed * (0.5 + Math.random());
      scratchBurst.x = o.x;
      scratchBurst.y = o.y;
      scratchBurst.z = o.z;
      scratchBurst.vx = Math.cos(a) * sp;
      scratchBurst.vz = Math.sin(a) * sp;
      scratchBurst.vy = up * sp * upBias;
      scratchBurst.color = o.color;
      scratchBurst.cr = undefined;
      scratchBurst.cg = undefined;
      scratchBurst.cb = undefined;
      scratchBurst.size = (o.size ?? 0.6) * (0.7 + Math.random() * 0.6);
      scratchBurst.life = o.life * (0.7 + Math.random() * 0.6);
      scratchBurst.gravity = o.gravity ?? -10;
      scratchBurst.drag = o.drag ?? 0;
      scratchBurst.stretch = o.stretch ?? true;
      scratchBurst.bright = o.bright ?? 1;
      scratchBurst.alpha = o.alpha ?? 1;
      scratchBurst.priority = o.priority ?? "impact";
      this.spawn(kind, scratchBurst);
    }
  }

  /** Step both pools. Zero allocations. 2 draw calls total regardless of load. */
  update(dt: number) {
    this.add.update(dt);
    this.normal.update(dt);
  }

  /** On-demand primitive telemetry; never scans pools during the render loop. */
  counts() {
    return { add: this.add.counts(), normal: this.normal.counts() };
  }

  clear() {
    this.add.clear();
    this.normal.clear();
  }

  dispose() {
    this.add.dispose(this.scene);
    this.normal.dispose(this.scene);
  }
}
