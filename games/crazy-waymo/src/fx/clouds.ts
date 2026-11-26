import * as THREE from "three";

import type { CloudQuality } from "../render/quality";
import { WORLD_H, WORLD_HALF_X, WORLD_W } from "../shared/constants";
import { CloudLayer } from "./cloud-layer";

const HIGH_COUNT = 64;
const FOG_COUNT = 26;
const CLUSTER_PUFFS_MIN = 2;
const CLUSTER_PUFFS_MAX = 5;
const CLUSTER_SPREAD_X = 0.46;
const CLUSTER_SPREAD_Z = 0.14;
const CLUSTER_DROP = 0.14;
const LINING_STRENGTH = 0.34;
const SUN_FADE_LO = 0.62;
const SUN_FADE_HI = 1;
const FOG_DISSOLVE_U = 0.55;
const FOG_SPAWN_MIN_U = -0.25;
const FOG_SPAWN_MAX_U = 0.1;
const GATE_SHARE = 0.4;
const GATE_V = 0.045;
const FOG_WIDTH_CAP = 380;

const cloudTexture = (lobes: number, squash: number) => {
  const w = 256;
  const h = 128;
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");

  if (ctx) {
    ctx.clearRect(0, 0, w, h);

    for (let i = 0; i < lobes; i += 1) {
      const r = h * (0.34 + Math.random() * 0.22);
      const rawX = w * (0.2 + (0.6 * i) / Math.max(1, lobes - 1)) + (Math.random() - 0.5) * 24;
      const cx = Math.min(w - r - 2, Math.max(r + 2, rawX));
      const rawY = h * (0.52 + (Math.random() - 0.5) * 0.2);
      const cy = Math.max(r * squash + 2, rawY);
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
  tex.colorSpace = THREE.NoColorSpace;

  return tex;
};

export class SkyClouds {
  readonly group = new THREE.Group();
  private readonly high: CloudLayer;
  private readonly fog: CloudLayer;
  private fogSpeed: Float32Array;
  private fogBase: Float32Array;
  private karlT = Math.random() * 900;
  private fogWidth: Float32Array;
  private level: CloudQuality = 2;
  private highActive = HIGH_COUNT;
  private fogActive = FOG_COUNT;
  private nightF = 0;
  private sunRef: THREE.DirectionalLight | null = null;
  private readonly scrSunDir = new THREE.Vector3();

  constructor(discardLow = false) {
    this.high = new CloudLayer({
      color: 0xff_ff_ff,
      count: HIGH_COUNT,
      kind: "cumulus",
      nightColor: 0x4a_5a_86,
      nightDim: 0.85,
      renderOrder: 4,
    });
    this.fog = new CloudLayer({
      color: 0xe8_f1_f7,
      count: FOG_COUNT,
      discardLow,
      floorFade: true,
      kind: "marine",
      nightColor: 0x4a_55_78,
      nightDim: 0.7,
      renderOrder: 5,
      tex: cloudTexture(3, 0.45),
    });
    this.group.add(this.high.mesh);
    this.group.add(this.fog.mesh);

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

      if (sun === null) {
        return;
      }

      const dir = this.scrSunDir.copy(sun.position).sub(sun.target.position);

      if (dir.lengthSq() < 1e-6) {
        return;
      }

      this.high.sunDirU.value.copy(dir.normalize());
      const dayW = 1 - THREE.MathUtils.smoothstep(this.nightF, SUN_FADE_LO, SUN_FADE_HI);
      this.high.sunWU.value = THREE.MathUtils.lerp(0.65, 1, dayW);
      this.high.sunColU.value
        .copy(sun.color)
        .multiplyScalar(
          Math.min(sun.intensity, 1.2) * LINING_STRENGTH * THREE.MathUtils.lerp(0.35, 1, dayW),
        );
    };

    this.high.wrapU.value.set(-WORLD_HALF_X * 1.7, WORLD_HALF_X * 3.4);
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
      const roll = Math.random();
      const heroW = 190 + roll * roll * 380;

      for (let k = 0; k < puffs; k += 1, i += 1) {
        const hero = k === 0;
        const w = hero ? heroW : heroW * (0.38 + Math.random() * 0.34);
        const ang = Math.random() * Math.PI * 2;
        const reach = 0.6 + Math.random() * 0.7 + k * 0.12;
        const dx = hero ? 0 : Math.cos(ang) * heroW * CLUSTER_SPREAD_X * reach;
        const dy = hero ? 0 : -heroW * CLUSTER_DROP * (0.4 + Math.random() * 0.6);
        const dz = hero ? 0 : Math.sin(ang) * heroW * CLUSTER_SPREAD_Z * 2 * reach;
        this.high.centers.set([cx + dx, cy + dy, cz + dz], i * 3);
        this.high.sizes.set([w, w * (0.42 + Math.random() * 0.16)], i * 2);
        this.high.alphas[i] = hero ? 0.85 + Math.random() * 0.15 : 0.55 + Math.random() * 0.35;
        this.high.seeds[i] = Math.random();
        this.high.drifts[i] = speed;
      }
    }

    this.fogSpeed = new Float32Array(FOG_COUNT);
    this.fogBase = new Float32Array(FOG_COUNT);
    this.fogWidth = new Float32Array(FOG_COUNT);

    for (let sheet = 0; sheet < FOG_COUNT; sheet += 1) {
      this.spawnFog(sheet, true);
    }

    this.high.markDirty();
    this.fog.markDirty();
  }

  private spawnFog(i: number, anywhere: boolean) {
    const u = anywhere
      ? FOG_SPAWN_MIN_U + Math.random() * (FOG_DISSOLVE_U - FOG_SPAWN_MIN_U)
      : FOG_SPAWN_MIN_U + Math.random() * (FOG_SPAWN_MAX_U - FOG_SPAWN_MIN_U);

    const x = (u - 0.5) * WORLD_W;
    const gate = Math.random() < GATE_SHARE;
    const v = gate ? GATE_V + (Math.random() - 0.5) * 0.12 : Math.random() * 1.3 - 0.65 + 0.5;
    const z = (v - 0.5) * WORLD_H;
    const y = gate ? 38 + Math.random() * 14 : 34 + Math.random() * 26;
    this.fog.centers.set([x, y, z], i * 3);
    const w = 320 + Math.random() * 320;
    this.fogWidth[i] = w;
    const h = gate ? 22 + Math.random() * 16 : 42 + Math.random() * 46;
    this.fog.sizes.set([this.level === 2 ? w : Math.min(w, FOG_WIDTH_CAP), h], i * 2);
    this.fog.sizeAttr.needsUpdate = true;
    this.fogBase[i] = gate ? 0.13 + Math.random() * 0.09 : 0.24 + Math.random() * 0.18;
    this.fog.alphas[i] = 0;
    this.fogSpeed[i] = 5 + Math.random() * 4;
  }

  setQuality(level: CloudQuality) {
    if (level === this.level) {
      return;
    }

    const prevFog = this.fogActive;
    this.level = level;
    this.highActive = level === 2 ? HIGH_COUNT : Math.trunc(HIGH_COUNT / 2);

    if (level === 2) {
      this.fogActive = FOG_COUNT;
    } else if (level === 1) {
      this.fogActive = Math.trunc(FOG_COUNT / 2);
    } else {
      this.fogActive = 0;
    }

    this.high.geo.instanceCount = this.highActive;
    this.fog.geo.instanceCount = Math.max(1, this.fogActive);
    this.fog.mesh.visible = this.fogActive > 0;

    for (let i = 0; i < FOG_COUNT; i += 1) {
      const w = this.fogWidth[i] ?? FOG_WIDTH_CAP;
      this.fog.sizes[i * 2] = level === 2 ? w : Math.min(w, FOG_WIDTH_CAP);
    }

    this.fog.sizeAttr.needsUpdate = true;

    for (let i = prevFog; i < this.fogActive; i += 1) {
      this.spawnFog(i, true);
    }

    this.fog.markDirty();
  }

  setNight(f: number) {
    this.nightF = f;
    this.high.setNight(f);
    this.fog.setNight(f);
  }

  update(dt: number) {
    this.high.timeU.value += dt;
    this.karlT += dt;

    const swell =
      Math.sin(this.karlT * ((Math.PI * 2) / 420)) * 0.5 +
      Math.sin(this.karlT * ((Math.PI * 2) / 97) + 1.7) * 0.18;

    const presence = THREE.MathUtils.clamp(1 + 0.9 * swell, 0.5, 1.75);
    const dissolveU = FOG_DISSOLVE_U + 0.26 * Math.max(0, presence - 1);

    for (let i = 0; i < this.fogActive; i += 1) {
      const x = (this.fog.centers[i * 3] ?? 0) + (this.fogSpeed[i] ?? 0) * dt;
      this.fog.centers[i * 3] = x;
      const u = x / WORLD_W + 0.5;
      const base = (this.fogBase[i] ?? 0.2) * presence;
      const fadeIn = Math.min(1, (this.fog.alphas[i] ?? 0) / base + dt * 0.6);
      const dissolve = THREE.MathUtils.clamp(1 - (u - (dissolveU - 0.18)) / 0.18, 0, 1);
      this.fog.alphas[i] = Math.min(1, base * Math.min(fadeIn, 1) * dissolve);

      if (u > dissolveU) {
        this.spawnFog(i, false);
      }
    }

    if (this.fogActive > 0) {
      this.fog.markDirty(this.fogActive);
    }
  }
}
