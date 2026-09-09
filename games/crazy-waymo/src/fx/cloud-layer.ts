import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";

// Marine sheets hang low enough to reach the water, and a billboard that
// crosses the ocean plane is depth-cut by it in a dead-straight line along the
// horizon — the "hard-edged grey mass" read. Fade every sheet out below
// FLOOR_TOP and to nothing by FLOOR_Y so it dissolves into the bay instead of
// ending at a razor edge, and so grazing a hillside or a bridge tower thins the
// sheet rather than slicing it.
const FLOOR_Y = 4;
const FLOOR_TOP = 30;

const VERT = `
  attribute vec3 aCenter;
  attribute vec2 aSize;
  attribute float aAlpha;
  varying vec2 vUv;
  varying float vAlpha;
  varying float vWorldY;
  void main() {
    vUv = uv;
    vAlpha = aAlpha;
    // Yaw-only billboard: face the camera in the horizontal plane.
    vec3 toCam = cameraPosition - aCenter;
    float yaw = atan(toCam.x, toCam.z);
    float c = cos(yaw);
    float s = sin(yaw);
    vec3 local = vec3(position.x * aSize.x, position.y * aSize.y, 0.0);
    vec3 world = aCenter + vec3(local.x * c + local.z * s, local.y, -local.x * s + local.z * c);
    vWorldY = world.y;
    gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
  }
`;
// `discardLow` (mobile): most of each quad is fully transparent texels —
// skipping the blend write for them saves real ROP bandwidth on tile GPUs.
// `floorFade` gives the low marine sheets a soft world-space underside (see
// FLOOR_Y); the high cumulus sit 190u up and skip the extra work entirely.
const frag = (discardLow: boolean, floorFade: boolean): string =>
  `
  uniform sampler2D uMap;
  uniform vec3 uColor;
  uniform float uDim;
  varying vec2 vUv;
  varying float vAlpha;
  varying float vWorldY;
  void main() {
    float a = texture2D(uMap, vUv).a * vAlpha;
    ${floorFade ? `a *= smoothstep(${FLOOR_Y.toFixed(1)}, ${FLOOR_TOP.toFixed(1)}, vWorldY);` : ""}
    ${discardLow ? "if (a < 0.004) discard;" : ""}
    vec3 rgb = uColor * uDim;
    gl_FragColor = vec4(rgb, a);
  }
`;

const cumulusGeometry = (): THREE.BufferGeometry => {
  const lobes = [
    { sx: 0.28, sy: 0.4, sz: 0.27, x: 0, y: 0.12, z: 0 },
    { sx: 0.25, sy: 0.24, sz: 0.24, x: -0.28, y: -0.04, z: 0.03 },
    { sx: 0.28, sy: 0.3, sz: 0.26, x: 0.26, y: -0.04, z: 0 },
    { sx: 0.38, sy: 0.2, sz: 0.23, x: -0.06, y: -0.21, z: 0.15 },
    { sx: 0.33, sy: 0.3, sz: 0.25, x: 0.1, y: -0.03, z: -0.19 },
  ];
  const pieces = lobes.map((lobe) => {
    const geometry = new THREE.SphereGeometry(1, 10, 6);
    geometry.scale(lobe.sx, lobe.sy, lobe.sz);
    geometry.translate(lobe.x, lobe.y, lobe.z);
    return geometry;
  });
  const geometry = mergeGeometries(pieces);
  for (const piece of pieces) {
    piece.dispose();
  }
  if (!geometry) {
    throw new Error("Cloud lobe layouts must agree");
  }
  return geometry;
};

// oxlint-disable-next-line no-inline-comments -- the /* glsl */ tag must sit on the template line for editor shader highlighting
const CUMULUS_VERT = /* glsl */ `
  attribute vec3 aCenter;
  attribute vec2 aSize;
  attribute float aSeed;
  varying vec3 vCloudNormal;
  void main() {
    // Fixed world rotation, unlike a billboard: cloud shoulders keep their
    // sun-facing side while the camera turns and travels underneath them.
    float yaw = aSeed * 6.2831853;
    float c = cos(yaw);
    float s = sin(yaw);
    vec3 scale = vec3(aSize.x, aSize.y, aSize.x * 0.62);
    vec3 p = position * scale;
    vec3 world = aCenter + vec3(p.x * c + p.z * s, p.y, -p.x * s + p.z * c);
    vec3 n = normal / scale;
    vCloudNormal = normalize(vec3(n.x * c + n.z * s, n.y, -n.x * s + n.z * c));
    gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
  }
`;

// oxlint-disable-next-line no-inline-comments -- the /* glsl */ tag must sit on the template line for editor shader highlighting
const CUMULUS_FRAG = /* glsl */ `
  uniform vec3 uColor;
  uniform float uDim;
  uniform vec3 uSunDir;
  uniform vec3 uSunCol;
  uniform float uSunW;
  varying vec3 vCloudNormal;
  void main() {
    vec3 n = normalize(vCloudNormal);
    float skyFill = 0.72 + 0.28 * (n.y * 0.5 + 0.5);
    float key = smoothstep(-0.75, 1.0, dot(n, uSunDir));
    vec3 rgb = uColor * uDim * skyFill;
    float dayKey = mix(0.55, key, uSunW);
    rgb *= mix(vec3(0.72, 0.84, 1.0), vec3(1.0), dayKey);
    rgb *= mix(0.82, 1.22, dayKey);
    rgb += uSunCol * key * 0.16;
    gl_FragColor = vec4(rgb, 1.0);
  }
`;

type LayerOpts = {
  count: number;
  /** Daylight tint. */
  color: number;
  /** Tint at full night — clouds keep the sky's hue instead of going grey. */
  nightColor: number;
  /** How much of the daylight brightness survives full night (0..1). */
  nightDim: number;
  renderOrder: number;
} & (
  | { readonly kind: "cumulus" }
  | {
      readonly kind: "marine";
      readonly tex: THREE.Texture;
      readonly discardLow: boolean;
      readonly floorFade: boolean;
    }
);

export class CloudLayer {
  readonly mesh: THREE.Mesh;
  readonly geo: THREE.InstancedBufferGeometry;
  readonly centers: Float32Array;
  readonly alphas: Float32Array;
  readonly sizeAttr: THREE.InstancedBufferAttribute;
  private centerAttr: THREE.InstancedBufferAttribute;
  private alphaAttr: THREE.InstancedBufferAttribute;

  constructor(opts: LayerOpts) {
    const sculpted = opts.kind === "cumulus";
    const quad = sculpted ? cumulusGeometry() : new THREE.PlaneGeometry(1, 1);
    const geo = new THREE.InstancedBufferGeometry();
    geo.index = quad.index;
    geo.setAttribute("position", quad.getAttribute("position"));
    geo.setAttribute("uv", quad.getAttribute("uv"));
    geo.setAttribute("normal", quad.getAttribute("normal"));
    geo.instanceCount = opts.count;
    this.geo = geo;

    this.centers = new Float32Array(opts.count * 3);
    this.alphas = new Float32Array(opts.count);
    const sizes = new Float32Array(opts.count * 2);
    const seeds = new Float32Array(opts.count);
    this.centerAttr = new THREE.InstancedBufferAttribute(this.centers, 3);
    this.alphaAttr = new THREE.InstancedBufferAttribute(this.alphas, 1);
    this.centerAttr.setUsage(THREE.DynamicDrawUsage);
    this.alphaAttr.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute("aCenter", this.centerAttr);
    geo.setAttribute("aAlpha", this.alphaAttr);
    this.sizeAttr = new THREE.InstancedBufferAttribute(sizes, 2);
    geo.setAttribute("aSize", this.sizeAttr);
    geo.setAttribute("aSeed", new THREE.InstancedBufferAttribute(seeds, 1));
    this.sizes = sizes;
    this.seeds = seeds;

    const color = new THREE.Color(opts.color);
    const mat = new THREE.ShaderMaterial({
      depthWrite: sculpted,
      fragmentShader:
        opts.kind === "cumulus" ? CUMULUS_FRAG : frag(opts.discardLow, opts.floorFade),
      transparent: !sculpted,
      uniforms: {
        uColor: { value: color },
        uDim: { value: 1 },
        uMap: { value: opts.kind === "marine" ? opts.tex : null },
        uSunCol: this.sunColU,
        uSunDir: this.sunDirU,
        uSunW: this.sunWU,
      },
      vertexShader: sculpted ? CUMULUS_VERT : VERT,
    });
    this.dimUniform = mat.uniforms.uDim ?? { value: 1 };
    this.tint = color;
    this.dayColor = new THREE.Color(opts.color);
    this.nightColor = new THREE.Color(opts.nightColor);
    this.nightDim = opts.nightDim;
    this.mesh = new THREE.Mesh(geo, mat);
    // instances span the map; cull is pointless
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = opts.renderOrder;
  }

  readonly sizes: Float32Array;
  readonly seeds: Float32Array;
  dimUniform = { value: 1 };
  // Live sun feed (SkyClouds writes the high layer's each frame; the marine
  // layer keeps the defaults — its shader never reads them).
  readonly sunDirU = { value: new THREE.Vector3(0, 1, 0) };
  readonly sunColU = { value: new THREE.Color(0x00_00_00) };
  readonly sunWU = { value: 0 };
  private tint: THREE.Color;
  private dayColor: THREE.Color;
  private nightColor: THREE.Color;
  private nightDim: number;

  /** `f` = 0 broad daylight .. 1 full night. */
  setNight(f: number): void {
    this.dimUniform.value = 1 - (1 - this.nightDim) * f;
    this.tint.lerpColors(this.dayColor, this.nightColor, f);
  }

  markDirty(): void {
    this.centerAttr.needsUpdate = true;
    this.alphaAttr.needsUpdate = true;
  }
}
