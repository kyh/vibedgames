import * as THREE from "three";

import { MARINE_COLOR_GLSL, MARINE_GLSL } from "./marine-profile";

/**
 * One horizon band, not stacked fog billboards. Ray integration runs only on
 * its coarse vertices; each covered pixel blends one interpolated fog value.
 * Far depth lets opaque city/terrain occlude it on both live and baked skies.
 */
export class MarineSky {
  readonly mesh: THREE.Mesh;
  private fog = { value: new THREE.Color() };
  private sourceFog = new THREE.Color();

  constructor() {
    // Elevation -12..60 degrees. The upper edge fades before the geometry ends.
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
      uniforms: { uFog: this.fog },
      side: THREE.BackSide,
      transparent: true,
      depthTest: true,
      depthWrite: false,
      fog: false,
      toneMapped: false,
      vertexShader: /* glsl */ `
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
      fragmentShader: /* glsl */ `
        uniform vec3 uFog;
        varying float vBank;
        ${MARINE_COLOR_GLSL}
        void main() {
          gl_FragColor = vec4(sfMarineColor(uFog), vBank);
        }
      `,
    });
    this.mesh = new THREE.Mesh(geometry, material);
    this.mesh.name = "coastal-marine-sky";
    this.mesh.frustumCulled = false;
    this.mesh.onBeforeRender = (renderer) => {
      // Built-in fog is applied after output conversion. Match its public
      // Color.getRGB contract for the post target, direct phone and XR paths.
      const target = renderer.getRenderTarget();
      const colorSpace =
        target === null
          ? renderer.outputColorSpace
          : "isXRRenderTarget" in target && target.isXRRenderTarget === true
            ? target.texture.colorSpace
            : THREE.ColorManagement.workingColorSpace;
      this.sourceFog.getRGB(this.fog.value, colorSpace);
    };
    // Transparent objects render after opaque terrain. This draws before
    // cloud sheets and all gameplay transparencies, and never writes depth.
    this.mesh.renderOrder = -1;
  }

  update(fogColor: THREE.Color, enabled = true): void {
    this.sourceFog.copy(fogColor);
    this.mesh.visible = enabled;
  }
}
