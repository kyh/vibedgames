import * as THREE from "three";

import { WORLD_H, WORLD_HALF_X, WORLD_W } from "../shared/constants";

// SF sky: two billboard layers on one shader.
//
// 1. High cumulus — puffy clusters way above the city, drifting east.
// 2. Karl the Fog — the low marine layer: huge, flat, near-white sheets that
//    roll in off the Pacific, spill over the western hills, and dissolve as
//    they push inland (exactly what the real fog does most afternoons).
//
// Each layer is ONE InstancedBufferGeometry draw call. Billboarding is
// cylindrical (yaw-only, done in the vertex shader) so the flat sheets never
// tilt with the chase camera. The soft blob texture is generated on a canvas
// at boot — no asset fetch.

const HIGH_COUNT = 22;
const FOG_COUNT = 26;
// Karl dissolves past this map fraction (u west→east); respawns over the ocean.
const FOG_DISSOLVE_U = 0.55;
const FOG_SPAWN_MIN_U = -0.25; // off-shore, over the open Pacific
const FOG_SPAWN_MAX_U = 0.1;

const VERT = `
  attribute vec3 aCenter;
  attribute vec2 aSize;
  attribute float aAlpha;
  attribute float aSeed;
  varying vec2 vUv;
  varying float vAlpha;
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
    gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
  }
`;
const FRAG = `
  uniform sampler2D uMap;
  uniform vec3 uColor;
  uniform float uDim;
  varying vec2 vUv;
  varying float vAlpha;
  void main() {
    float a = texture2D(uMap, vUv).a;
    gl_FragColor = vec4(uColor * uDim, a * vAlpha);
  }
`;

// A soft, lumpy cloud blob: overlapping radial gradients on a canvas.
function cloudTexture(lobes: number, squash: number): THREE.CanvasTexture {
  const w = 256;
  const h = 128;
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (ctx) {
    ctx.clearRect(0, 0, w, h);
    for (let i = 0; i < lobes; i++) {
      const cx = w * (0.2 + (0.6 * i) / Math.max(1, lobes - 1)) + (Math.random() - 0.5) * 24;
      const cy = h * (0.52 + (Math.random() - 0.5) * 0.2);
      const r = h * (0.34 + Math.random() * 0.22);
      const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
      g.addColorStop(0, "rgba(255,255,255,0.42)");
      g.addColorStop(0.55, "rgba(255,255,255,0.2)");
      g.addColorStop(1, "rgba(255,255,255,0)");
      ctx.save();
      ctx.translate(cx, cy);
      ctx.scale(1, squash);
      ctx.translate(-cx, -cy);
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, h);
      ctx.restore();
    }
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.NoColorSpace; // alpha-only lookup
  return tex;
}

type LayerOpts = {
  count: number;
  color: number;
  tex: THREE.CanvasTexture;
  renderOrder: number;
};

class CloudLayer {
  readonly mesh: THREE.Mesh;
  readonly centers: Float32Array;
  readonly alphas: Float32Array;
  private centerAttr: THREE.InstancedBufferAttribute;
  private alphaAttr: THREE.InstancedBufferAttribute;

  constructor(opts: LayerOpts) {
    const quad = new THREE.PlaneGeometry(1, 1);
    const geo = new THREE.InstancedBufferGeometry();
    geo.index = quad.index;
    geo.setAttribute("position", quad.getAttribute("position"));
    geo.setAttribute("uv", quad.getAttribute("uv"));
    geo.instanceCount = opts.count;

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
    geo.setAttribute("aSize", new THREE.InstancedBufferAttribute(sizes, 2));
    geo.setAttribute("aSeed", new THREE.InstancedBufferAttribute(seeds, 1));
    this.sizes = sizes;
    this.seeds = seeds;

    const mat = new THREE.ShaderMaterial({
      uniforms: {
        uMap: { value: opts.tex },
        uColor: { value: new THREE.Color(opts.color) },
        uDim: { value: 1 },
      },
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
    });
    this.dimUniform = mat.uniforms.uDim ?? { value: 1 };
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.frustumCulled = false; // instances span the map; cull is pointless
    this.mesh.renderOrder = opts.renderOrder;
  }

  readonly sizes: Float32Array;
  readonly seeds: Float32Array;
  dimUniform: { value: number } = { value: 1 };

  markDirty(): void {
    this.centerAttr.needsUpdate = true;
    this.alphaAttr.needsUpdate = true;
  }
}

export class SkyClouds {
  readonly group = new THREE.Group();
  private high: CloudLayer;
  private fog: CloudLayer;
  // Per-fog-sheet drift speed + target alpha (dissolve is alpha-driven).
  private fogSpeed: Float32Array;
  private fogBase: Float32Array;
  private highSpeed: Float32Array;

  constructor() {
    this.high = new CloudLayer({
      count: HIGH_COUNT,
      color: 0xffffff,
      tex: cloudTexture(4, 0.9),
      renderOrder: 4,
    });
    this.fog = new CloudLayer({
      count: FOG_COUNT,
      color: 0xe8f1f7,
      tex: cloudTexture(3, 0.45),
      renderOrder: 5,
    });
    this.group.add(this.high.mesh);
    this.group.add(this.fog.mesh);

    this.highSpeed = new Float32Array(HIGH_COUNT);
    for (let i = 0; i < HIGH_COUNT; i++) {
      const x = (Math.random() * 1.6 - 0.8) * WORLD_W;
      const z = (Math.random() * 1.4 - 0.7) * WORLD_H;
      const y = 190 + Math.random() * 130;
      this.high.centers.set([x, y, z], i * 3);
      const w = 190 + Math.random() * 240;
      this.high.sizes.set([w, w * (0.3 + Math.random() * 0.12)], i * 2);
      this.high.alphas[i] = 0.5 + Math.random() * 0.3;
      this.highSpeed[i] = 3.5 + Math.random() * 3;
    }
    this.fogSpeed = new Float32Array(FOG_COUNT);
    this.fogBase = new Float32Array(FOG_COUNT);
    for (let i = 0; i < FOG_COUNT; i++) this.spawnFog(i, true);
    this.high.markDirty();
    this.fog.markDirty();
  }

  // A fresh marine-layer sheet over (or west of) the ocean. `anywhere` seeds
  // the boot state with sheets already mid-crossing.
  private spawnFog(i: number, anywhere: boolean): void {
    const u = anywhere
      ? FOG_SPAWN_MIN_U + Math.random() * (FOG_DISSOLVE_U - FOG_SPAWN_MIN_U)
      : FOG_SPAWN_MIN_U + Math.random() * (FOG_SPAWN_MAX_U - FOG_SPAWN_MIN_U);
    const x = (u - 0.5) * WORLD_W;
    const z = (Math.random() * 1.3 - 0.65) * WORLD_H;
    const y = 26 + Math.random() * 46; // hugs the hills, tops of Sutro/Twin Peaks
    this.fog.centers.set([x, y, z], i * 3);
    const w = 320 + Math.random() * 320;
    this.fog.sizes.set([w, 42 + Math.random() * 46], i * 2);
    this.fogBase[i] = 0.24 + Math.random() * 0.18;
    this.fog.alphas[i] = 0; // fades in
    this.fogSpeed[i] = 5 + Math.random() * 4;
  }

  // Night factor (0 day .. 1 night): white clouds over a night sky must dim
  // toward moonlit gray or they read as paper cutouts.
  setNight(f: number): void {
    this.high.dimUniform.value = 1 - 0.62 * f;
    this.fog.dimUniform.value = 1 - 0.5 * f;
  }

  update(dt: number): void {
    // High cumulus: constant drift, wrap around the extended sky box.
    for (let i = 0; i < HIGH_COUNT; i++) {
      let x = (this.high.centers[i * 3] ?? 0) + (this.highSpeed[i] ?? 0) * dt;
      if (x > WORLD_HALF_X * 1.7) x = -WORLD_HALF_X * 1.7;
      this.high.centers[i * 3] = x;
    }
    // Karl: drift east, fade in over the ocean, dissolve crossing the ridge.
    for (let i = 0; i < FOG_COUNT; i++) {
      const x = (this.fog.centers[i * 3] ?? 0) + (this.fogSpeed[i] ?? 0) * dt;
      this.fog.centers[i * 3] = x;
      const u = x / WORLD_W + 0.5;
      const base = this.fogBase[i] ?? 0.2;
      const fadeIn = Math.min(1, (this.fog.alphas[i] ?? 0) / base + dt * 0.6);
      // Dissolve band: full strength until the city line, then thins out.
      const dissolve = THREE.MathUtils.clamp(
        1 - (u - (FOG_DISSOLVE_U - 0.18)) / 0.18,
        0,
        1,
      );
      this.fog.alphas[i] = base * Math.min(fadeIn, 1) * dissolve;
      if (u > FOG_DISSOLVE_U) this.spawnFog(i, false);
    }
    this.high.markDirty();
    this.fog.markDirty();
  }
}
