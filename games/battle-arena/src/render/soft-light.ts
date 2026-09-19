import * as THREE from "three";

/** Fade the existing open beam meshes at their silhouettes and height ends. */
export const softLightMaterial = (color: number, opacity: number): THREE.MeshBasicMaterial => {
  const material = new THREE.MeshBasicMaterial({
    blending: THREE.AdditiveBlending,
    color,
    depthWrite: false,
    opacity,
    side: THREE.DoubleSide,
    transparent: true,
  });
  material.onBeforeCompile = (shader) => {
    const varyings = "varying vec3 beamNormal; varying vec3 beamView; varying float beamHeight;\n";
    shader.vertexShader =
      varyings +
      shader.vertexShader.replace(
        "#include <project_vertex>",
        "#include <project_vertex>\nbeamNormal = normalize(normalMatrix * normal); beamView = -mvPosition.xyz; beamHeight = uv.y;",
      );
    shader.fragmentShader =
      varyings +
      shader.fragmentShader.replace(
        "#include <opaque_fragment>",
        `float edge = smoothstep(0.0, 0.65, abs(dot(normalize(beamNormal), normalize(beamView))));
       float ends = smoothstep(0.0, 0.20, beamHeight) * (1.0 - smoothstep(0.72, 1.0, beamHeight));
       diffuseColor.a *= edge * edge * ends;
       #include <opaque_fragment>`,
      );
  };
  material.customProgramCacheKey = () => "arena-soft-light-v1";
  return material;
};
