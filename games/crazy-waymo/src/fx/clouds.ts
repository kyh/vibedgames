import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";

import type { CloudQuality } from "../render/quality";
import { WORLD_H, WORLD_HALF_X, WORLD_W } from "../shared/constants";

// SF sky: sculpted cumulus above translucent marine fog.
//
// 1. High cumulus — puffy clusters way above the city, drifting east.
// 2. Karl the Fog — the low marine layer: huge, flat, near-white sheets that
//    roll in off the Pacific, spill over the western hills, and dissolve as
//    they push inland (exactly what the real fog does most afternoons).
//
// Each layer is one instanced draw. Cumulus use 500 triangles per cluster,
// smooth wrap lighting and real depth; Karl stays on soft billboards.
// No shadow casting, raymarching or additional render passes.

// 22 cumulus were scattered over 1.6 x 1.4 map widths of sky — about one cloud
// per two million square units — and painted pure white against a pale noon
// sky, so at noon the entire upper half of every frame was a featureless
// gradient with nothing in it. MK8 never ships an empty sky. The count is up,
// the spread is tighter (see the constructor) and the puffs are shaded.
const HIGH_COUNT = 64;
const FOG_COUNT = 26;
// Cumulus spawn in CLUSTERS — a hero puff with shoulder puffs overlapping it —
// because a lone billboard reads as a blob while an overlapped stack reads as
// massed cumulus (the reference sky is towers, not confetti). Members share
// one drift speed so a cluster holds together crossing the map.
const CLUSTER_PUFFS_MIN = 2;
const CLUSTER_PUFFS_MAX = 5;
/** Satellite lateral offset, as a fraction of the hero puff's width. */
const CLUSTER_SPREAD_X = 0.46;
/** Satellite depth offset (parallax between members), same units. */
const CLUSTER_SPREAD_Z = 0.14;
/** Satellites shoulder BELOW the hero — cumulus towers, not a flat row. */
const CLUSTER_DROP = 0.14;
/** Warm direct light on the cloud shoulders; diffuse sky fill stays neutral. */
const LINING_STRENGTH = 0.34;
// Sun-keyed terms hold through sunset (lamp opens at 0.62 there) and die
// across dusk, so the lit rims sweep dawn -> night without popping.
const SUN_FADE_LO = 0.62;
const SUN_FADE_HI = 1.0;
// Karl dissolves past this map fraction (u west→east); respawns over the ocean.
const FOG_DISSOLVE_U = 0.55;
const FOG_SPAWN_MIN_U = -0.25; // off-shore, over the open Pacific
const FOG_SPAWN_MAX_U = 0.1;
// Share of sheets that pour through the Golden Gate, and the map fraction
// (v north→south) of the strait they ride in on.
const GATE_SHARE = 0.4;
const GATE_V = 0.045;
// Reduced quality (mobile tiers): giant near-white sheets are pure overdraw —
// cap their width so a single sheet can't repaint the whole screen.
const FOG_WIDTH_CAP = 380;
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
function frag(discardLow: boolean, floorFade: boolean): string {
  return `
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
}

function cumulusGeometry(): THREE.BufferGeometry {
  const lobes = [
    { x: 0, y: 0.12, z: 0, sx: 0.28, sy: 0.4, sz: 0.27 },
    { x: -0.28, y: -0.04, z: 0.03, sx: 0.25, sy: 0.24, sz: 0.24 },
    { x: 0.26, y: -0.04, z: 0, sx: 0.28, sy: 0.3, sz: 0.26 },
    { x: -0.06, y: -0.21, z: 0.15, sx: 0.38, sy: 0.2, sz: 0.23 },
    { x: 0.1, y: -0.03, z: -0.19, sx: 0.33, sy: 0.3, sz: 0.25 },
  ];
  const pieces = lobes.map((lobe) => {
    const geometry = new THREE.SphereGeometry(1, 10, 6);
    geometry.scale(lobe.sx, lobe.sy, lobe.sz);
    geometry.translate(lobe.x, lobe.y, lobe.z);
    return geometry;
  });
  const geometry = mergeGeometries(pieces);
  for (const piece of pieces) piece.dispose();
  if (!geometry) throw new Error("Cloud lobe layouts must agree");
  return geometry;
}

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

// Translucent marine fog stays soft; it must never acquire a cumulus rim.
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
      const r = h * (0.34 + Math.random() * 0.22);
      // Keep the whole gradient inside the canvas: a lobe clipped by the
      // texture edge reads as a razor-straight cut across the cloud (invisible
      // at the old 0.42 alpha, glaring on the dense cumulus).
      const rawX = w * (0.2 + (0.6 * i) / Math.max(1, lobes - 1)) + (Math.random() - 0.5) * 24;
      const cx = Math.min(w - r - 2, Math.max(r + 2, rawX));
      const rawY = h * (0.52 + (Math.random() - 0.5) * 0.2);
      const cy = Math.max(r * squash + 2, rawY); // bottom clip is masked by the base fade
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

class CloudLayer {
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
      uniforms: {
        uMap: { value: opts.kind === "marine" ? opts.tex : null },
        uColor: { value: color },
        uDim: { value: 1 },
        uSunDir: this.sunDirU,
        uSunCol: this.sunColU,
        uSunW: this.sunWU,
      },
      vertexShader: sculpted ? CUMULUS_VERT : VERT,
      fragmentShader:
        opts.kind === "cumulus" ? CUMULUS_FRAG : frag(opts.discardLow, opts.floorFade),
      transparent: !sculpted,
      depthWrite: sculpted,
    });
    this.dimUniform = mat.uniforms.uDim ?? { value: 1 };
    this.tint = color;
    this.dayColor = new THREE.Color(opts.color);
    this.nightColor = new THREE.Color(opts.nightColor);
    this.nightDim = opts.nightDim;
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.frustumCulled = false; // instances span the map; cull is pointless
    this.mesh.renderOrder = opts.renderOrder;
  }

  readonly sizes: Float32Array;
  readonly seeds: Float32Array;
  dimUniform = { value: 1 };
  // Live sun feed (SkyClouds writes the high layer's each frame; the marine
  // layer keeps the defaults — its shader never reads them).
  readonly sunDirU = { value: new THREE.Vector3(0, 1, 0) };
  readonly sunColU = { value: new THREE.Color(0x000000) };
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

export class SkyClouds {
  readonly group = new THREE.Group();
  private high: CloudLayer;
  private fog: CloudLayer;
  // Per-fog-sheet drift speed + target alpha (dissolve is alpha-driven).
  private fogSpeed: Float32Array;
  private fogBase: Float32Array;
  // Weather clock for Karl's presence swell; random start so sessions differ.
  private karlT = Math.random() * 900;
  private fogWidth: Float32Array; // full (uncapped) width per sheet
  private highSpeed: Float32Array;
  private level: CloudQuality = 2;
  private highActive = HIGH_COUNT;
  private fogActive = FOG_COUNT;
  private nightF = 0;
  // The scene's shadow light, found once from the cumulus mesh's own render
  // callback. The update()/setNight() call sites only carry the night factor,
  // and widening the god object's wiring for one vec3 isn't worth the drift —
  // if a shared sun signal ever lands (render/grade.ts pattern), feed it there
  // and delete this lookup.
  private sunRef: THREE.DirectionalLight | null = null;
  private scrSunDir = new THREE.Vector3();

  constructor(discardLow = false) {
    // Night tints are the moonlit sky's own blues, NOT grey: a white cloud
    // merely dimmed still reads as a paper cutout against a near-black sky
    // because its hue never leaves the daylight neutral. The dim floors are
    // deliberately deep — at SF midnight the only thing lighting a cloud is
    // the moon and the city's own glow bouncing off its underside.
    this.high = new CloudLayer({
      count: HIGH_COUNT,
      color: 0xffffff,
      nightColor: 0x4a5a86,
      nightDim: 0.85,
      renderOrder: 4,
      kind: "cumulus",
    });
    this.fog = new CloudLayer({
      count: FOG_COUNT,
      color: 0xe8f1f7,
      nightColor: 0x4a5578,
      nightDim: 0.7,
      tex: cloudTexture(3, 0.45),
      renderOrder: 5,
      discardLow,
      floorFade: true,
      // Karl is a flat sheet lit from every side at once; a top-lit ramp on it
      // reads as a gradient error, not as volume.
      kind: "marine",
    });
    this.group.add(this.high.mesh);
    this.group.add(this.fog.mesh);

    // Feed the live sun to the cumulus shader (rim + occlusion tap). Runs on
    // the mesh's own draw so the data is same-frame; direction comes from the
    // light's position/target pair the way game-scene.updateSun writes them.
    this.high.mesh.onBeforeRender = (_renderer, scene) => {
      let sun = this.sunRef;
      if (sun === null || sun.parent !== scene) {
        sun = null;
        for (const child of scene.children) {
          if (child instanceof THREE.DirectionalLight) {
            sun = child;
            break;
          }
        }
        this.sunRef = sun;
      }
      if (sun === null) return;
      const dir = this.scrSunDir.copy(sun.position).sub(sun.target.position);
      if (dir.lengthSq() < 1e-6) return;
      this.high.sunDirU.value.copy(dir.normalize());
      const dayW = 1 - THREE.MathUtils.smoothstep(this.nightF, SUN_FADE_LO, SUN_FADE_HI);
      // The directional light becomes the moon after dusk. Keep its shading
      // across the lobes so night clouds retain volume instead of flat cutouts.
      this.high.sunWU.value = THREE.MathUtils.lerp(0.65, 1, dayW);
      this.high.sunColU.value
        .copy(sun.color)
        .multiplyScalar(
          Math.min(sun.intensity, 1.2) * LINING_STRENGTH * THREE.MathUtils.lerp(0.35, 1, dayW),
        );
    };

    // Cluster spawner (see CLUSTER_*): a hero puff plus overlapping shoulder
    // puffs per anchor. Members are contiguous in the instance buffer, so the
    // mobile instanceCount cut drops whole clusters instead of gutting each.
    this.highSpeed = new Float32Array(HIGH_COUNT);
    let i = 0;
    while (i < HIGH_COUNT) {
      const puffs = Math.min(
        HIGH_COUNT - i,
        CLUSTER_PUFFS_MIN + Math.floor(Math.random() * (CLUSTER_PUFFS_MAX - CLUSTER_PUFFS_MIN + 1)),
      );
      const cx = (Math.random() * 1.5 - 0.75) * WORLD_W;
      const cz = (Math.random() * 1.3 - 0.65) * WORLD_H;
      const cy = 175 + Math.random() * 130;
      const speed = 3.5 + Math.random() * 3;
      // Squared roll: mostly modest clusters with a few big anvils, which is
      // what gives a cumulus field its sense of scale (one uniform size reads
      // as wallpaper).
      const roll = Math.random();
      const heroW = 190 + roll * roll * 380;
      for (let k = 0; k < puffs; k++, i++) {
        const hero = k === 0;
        const w = hero ? heroW : heroW * (0.38 + Math.random() * 0.34);
        // Satellites scatter at random bearings — the old alternating left/
        // right pairs at growing reach drew a shrinking chain that read as a
        // generator signature from any angle (review pass).
        const ang = Math.random() * Math.PI * 2;
        const reach = 0.6 + Math.random() * 0.7 + k * 0.12;
        const dx = hero ? 0 : Math.cos(ang) * heroW * CLUSTER_SPREAD_X * reach;
        const dy = hero ? 0 : -heroW * CLUSTER_DROP * (0.4 + Math.random() * 0.6);
        const dz = hero ? 0 : Math.sin(ang) * heroW * CLUSTER_SPREAD_Z * 2 * reach;
        this.high.centers.set([cx + dx, cy + dy, cz + dz], i * 3);
        this.high.sizes.set([w, w * (0.42 + Math.random() * 0.16)], i * 2);
        this.high.alphas[i] = hero ? 0.85 + Math.random() * 0.15 : 0.55 + Math.random() * 0.35;
        this.high.seeds[i] = Math.random();
        this.highSpeed[i] = speed;
      }
    }
    this.fogSpeed = new Float32Array(FOG_COUNT);
    this.fogBase = new Float32Array(FOG_COUNT);
    this.fogWidth = new Float32Array(FOG_COUNT);
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
    // Karl does not arrive on a broad front: most of him funnels through the
    // Golden Gate. Two sheets in five ride the strait (the north edge of the
    // map), the rest spread down the open coast.
    const gate = Math.random() < GATE_SHARE;
    const v = gate ? GATE_V + (Math.random() - 0.5) * 0.12 : Math.random() * 1.3 - 0.65 + 0.5;
    const z = (v - 0.5) * WORLD_H;
    // Sheet centres stay under the shader's marine lid (render/aerial-fog.ts
    // MARINE_TOP) so cresting a hill lifts you clear of the billboards at the
    // same moment it lifts you clear of the fog volume. The GATE sheets sit
    // lower still, but their half-height is capped to keep the quad's underside
    // out of the water: a sheet reaching below the ocean plane is depth-cut by
    // it, and no amount of alpha fading hides a cut that straight. The
    // FLOOR_Y fade in the shader is the second line of defence.
    // GATE sheets ride OVER the bridge, not through it. A 600u-wide near-white
    // sheet centred at deck height crossing the strait erased the Golden Gate
    // completely — a landmark the player steers by, gone at random for as long
    // as the sheet took to pass. Sitting them above the deck with roughly half
    // the opacity gives the real thing instead: Karl pouring over the roadway
    // with the tower tops standing out of it.
    const y = gate ? 38 + Math.random() * 14 : 34 + Math.random() * 26;
    this.fog.centers.set([x, y, z], i * 3);
    const w = 320 + Math.random() * 320;
    this.fogWidth[i] = w;
    const h = gate ? 22 + Math.random() * 16 : 42 + Math.random() * 46;
    this.fog.sizes.set([this.level === 2 ? w : Math.min(w, FOG_WIDTH_CAP), h], i * 2);
    this.fog.sizeAttr.needsUpdate = true;
    this.fogBase[i] = gate ? 0.13 + Math.random() * 0.09 : 0.24 + Math.random() * 0.18;
    this.fog.alphas[i] = 0; // fades in
    this.fogSpeed[i] = 5 + Math.random() * 4;
  }

  // Mobile tiers step the sky down: 2 = full (desktop look, the default —
  // desktop never calls this with anything else), 1 = half the billboards and
  // width-capped fog sheets, 0 = no fog sheets at all.
  setQuality(level: CloudQuality): void {
    if (level === this.level) return;
    const prevFog = this.fogActive;
    this.level = level;
    this.highActive = level === 2 ? HIGH_COUNT : HIGH_COUNT >> 1;
    this.fogActive = level === 2 ? FOG_COUNT : level === 1 ? FOG_COUNT >> 1 : 0;
    this.high.geo.instanceCount = this.highActive;
    this.fog.geo.instanceCount = Math.max(1, this.fogActive);
    this.fog.mesh.visible = this.fogActive > 0;
    // Re-cap (or restore) the width of every live sheet.
    for (let i = 0; i < FOG_COUNT; i++) {
      const w = this.fogWidth[i] ?? FOG_WIDTH_CAP;
      this.fog.sizes[i * 2] = level === 2 ? w : Math.min(w, FOG_WIDTH_CAP);
    }
    this.fog.sizeAttr.needsUpdate = true;
    // Sheets that sat parked while inactive respawn mid-crossing (fade in
    // from alpha 0) instead of popping back where they froze.
    for (let i = prevFog; i < this.fogActive; i++) this.spawnFog(i, true);
    this.high.markDirty();
    this.fog.markDirty();
  }

  // Night factor (0 day .. 1 night): a white cloud over a near-black sky is a
  // paper cutout no matter how far you dim it, so each layer crossfades to its
  // own moonlit BLUE as well — see the tints on the layers above.
  setNight(f: number): void {
    this.nightF = f;
    this.high.setNight(f);
    this.fog.setNight(f);
  }

  update(dt: number): void {
    // High cumulus: constant drift, wrap around the extended sky box.
    for (let i = 0; i < this.highActive; i++) {
      let x = (this.high.centers[i * 3] ?? 0) + (this.highSpeed[i] ?? 0) * dt;
      if (x > WORLD_HALF_X * 1.7) x = -WORLD_HALF_X * 1.7;
      this.high.centers[i * 3] = x;
    }
    // Karl breathes as WEATHER, not a constant: two incommensurate sines
    // (~7 min swell + ~100 s ripple) sweep his presence between wisps (0.55)
    // and a bank half again heavier than the old constant (1.45) — and at the
    // peaks the dissolve line moves up to 0.1 U further inland, so a heavy
    // phase pours fog past Twin Peaks instead of always dying at the ridge.
    // The session starts at a random point in the cycle: some runs open socked
    // in, some clear. The volumetric bank (render/aerial-fog.ts) stays fixed —
    // the sheets are what reads as fog arriving and leaving.
    this.karlT += dt;
    const swell =
      Math.sin(this.karlT * ((Math.PI * 2) / 420)) * 0.5 +
      Math.sin(this.karlT * ((Math.PI * 2) / 97) + 1.7) * 0.18;
    const presence = THREE.MathUtils.clamp(1 + 0.9 * swell, 0.5, 1.75);
    const dissolveU = FOG_DISSOLVE_U + 0.26 * Math.max(0, presence - 1);
    // Karl: drift east, fade in over the ocean, dissolve crossing the ridge.
    for (let i = 0; i < this.fogActive; i++) {
      const x = (this.fog.centers[i * 3] ?? 0) + (this.fogSpeed[i] ?? 0) * dt;
      this.fog.centers[i * 3] = x;
      const u = x / WORLD_W + 0.5;
      const base = (this.fogBase[i] ?? 0.2) * presence;
      const fadeIn = Math.min(1, (this.fog.alphas[i] ?? 0) / base + dt * 0.6);
      // Dissolve band: full strength until the city line, then thins out.
      const dissolve = THREE.MathUtils.clamp(1 - (u - (dissolveU - 0.18)) / 0.18, 0, 1);
      this.fog.alphas[i] = Math.min(1, base * Math.min(fadeIn, 1) * dissolve);
      if (u > dissolveU) this.spawnFog(i, false);
    }
    this.high.markDirty();
    this.fog.markDirty();
  }
}
