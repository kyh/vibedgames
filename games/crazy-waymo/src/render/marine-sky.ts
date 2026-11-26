import * as THREE from "three";

import { MARINE_COLOR_GLSL, MARINE_GLSL } from "./marine-profile";

const fogColorSpace = (renderer: THREE.WebGLRenderer, target: THREE.WebGLRenderTarget | null) => {
  if (target === null) {
    return renderer.outputColorSpace;
  }

  if ("isXRRenderTarget" in target && target.isXRRenderTarget === true) {
    return target.texture.colorSpace;
  }

  return THREE.ColorManagement.workingColorSpace;
};

/**
 * One horizon band, not stacked fog billboards. Ray integration runs only on
 * its coarse vertices; each covered pixel blends one interpolated fog value.
 * Far depth lets opaque city/terrain occlude it on both live and baked skies.
 */
export class MarineSky {
  readonly mesh: THREE.Mesh;
  private readonly fog = { value: new THREE.Color() };
  private readonly sourceFog = new THREE.Color();

  constructor() {
    const geometry = new THREE.SphereGeometry(
      1,
      96,
      24,
      0,
      Math.PI * 2,
      Math.PI / 6,
      Math.PI * 0.4,
    );

    const material = new THREE.ShaderMaterial({
      depthTest: true,
      depthWrite: false,
      fog: false,
      fragmentShader: `
        uniform vec3 uFog;
        varying float vBank;
        ${MARINE_COLOR_GLSL}
        void main() {
          gl_FragColor = vec4(sfMarineColor(uFog), vBank);
        }
      `,
      side: THREE.BackSide,
      toneMapped: false,
      transparent: true,
      uniforms: { uFog: this.fog },
      vertexShader: `
        varying float vBank;
        ${MARINE_GLSL}
        void main() {
          vec3 direction = normalize(position);
          vBank = sfMarineOpacity(cameraPosition, cameraPosition + direction * 3600.0);
          vBank *= 1.0 - smoothstep(0.65, 0.85, direction.y);
          vec4 projected = projectionMatrix * viewMatrix * vec4(cameraPosition + direction, 1.0);
          gl_Position = projected.xyww;
          gl_Position.z *= 0.999999;
        }
      `,
    });

    this.mesh = new THREE.Mesh(geometry, material);
    this.mesh.name = "coastal-marine-sky";
    this.mesh.frustumCulled = false;
    this.mesh.onBeforeRender = (renderer) => {
      const target = renderer.getRenderTarget();
      this.sourceFog.getRGB(this.fog.value, fogColorSpace(renderer, target));
    };

    this.mesh.renderOrder = -1;
  }

  update(fogColor: THREE.Color, enabled = true) {
    this.sourceFog.copy(fogColor);
    this.mesh.visible = enabled;
  }
}
