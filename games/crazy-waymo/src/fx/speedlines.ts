import * as THREE from "three";

const COUNT = 36;
const RADIUS_MIN = 5;
const RADIUS_MAX = 10;
const AHEAD_MIN = 10;
const AHEAD_MAX = 25;
const BASE_ALPHA = 0.2;
const FADE_START = 0.75;
const FADE_FULL = 0.9;

const f = (n: number) => (Number.isInteger(n) ? `${n}.0` : String(n));

const VERT = `
  attribute vec4 aLine; // seed, spawn depth z0 (< 0), start phase (u), tail flag
  uniform float uDist;
  uniform float uStretch;
  #include <fog_pars_vertex>
  float hash(float n) { return fract(sin(n) * 43758.5453123); }
  void main() {
    float z0 = aLine.y;
    // spawn depth → 1u behind the camera, then wrap ahead
    float span = 1.0 - z0;
    float travel = uDist + aLine.z;
    float lap = floor(travel / span);
    float z = z0 + travel - lap * span;
    float k = aLine.x * 97.0 + lap * 13.0;
    float angle = hash(k + 1.0) * 6.2831853;
    float radius = mix(${f(RADIUS_MIN)}, ${f(RADIUS_MAX)}, hash(k + 2.0));
    float len = (0.8 + hash(k + 3.0) * 0.8) * uStretch;
    // tail trails toward the camera
    vec3 p = vec3(cos(angle) * radius, sin(angle) * radius, z + aLine.w * len);
    vec4 mvPosition = modelViewMatrix * vec4(p, 1.0);
    gl_Position = projectionMatrix * mvPosition;
    #include <fog_vertex>
  }
`;

const FRAG = `
  uniform float uOpacity;
  #include <fog_pars_fragment>
  void main() {
    gl_FragColor = vec4(1.0, 1.0, 1.0, uOpacity);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
    #include <fog_fragment>
  }
`;

export class SpeedLines {
  readonly object3D: THREE.Object3D;
  private readonly uDist = { value: 0 };
  private readonly uStretch = { value: 1 };
  private readonly uOpacity = { value: 0 };

  constructor() {
    const lines = new Float32Array(COUNT * 2 * 4);

    for (let i = 0; i < COUNT; i += 1) {
      const seed = Math.random();
      const z0 = -(AHEAD_MAX - Math.random() * 5);
      const phase = Math.random() * (AHEAD_MAX - AHEAD_MIN);

      for (let e = 0; e < 2; e += 1) {
        lines.set([seed, z0, phase, e], (i * 2 + e) * 4);
      }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(COUNT * 2 * 3), 3));
    geo.setAttribute("aLine", new THREE.BufferAttribute(lines, 4));
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);

    const mat = new THREE.ShaderMaterial({
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      fog: true,
      fragmentShader: FRAG,
      transparent: true,
      uniforms: {
        ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog),
        uDist: this.uDist,
        uOpacity: this.uOpacity,
        uStretch: this.uStretch,
      },
      vertexShader: VERT,
    });

    const segments = new THREE.LineSegments(geo, mat);
    segments.frustumCulled = false;
    segments.visible = false;
    segments.renderOrder = 10;
    this.object3D = segments;
  }

  update(dt: number, camera: THREE.PerspectiveCamera, speedFrac: number) {
    const fade = THREE.MathUtils.clamp((speedFrac - FADE_START) / (FADE_FULL - FADE_START), 0, 1);
    this.uOpacity.value = BASE_ALPHA * fade;
    this.object3D.visible = fade > 0;

    if (fade <= 0) {
      return;
    }

    this.object3D.position.copy(camera.position);
    this.object3D.quaternion.copy(camera.quaternion);

    this.uStretch.value = 1 + speedFrac * 3;
    this.uDist.value += (20 + speedFrac * 60) * dt;
  }
}
