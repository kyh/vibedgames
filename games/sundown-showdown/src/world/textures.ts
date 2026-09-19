// Procedural canvas textures and vertex-colour bakes for the arena props.
// Everything here is deterministic and cheap enough to rebuild per match.
import * as THREE from "three";

import { clamp, makeCanvas } from "../utils";
import { GRID } from "./grid";

/** 2D context of a fresh canvas; a missing context means no canvas support at all. */
export const context2d = (canvas: HTMLCanvasElement): CanvasRenderingContext2D => {
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    throw new Error("2D canvas context unavailable");
  }
  return ctx;
};

/**
 * Bakes a height gradient into the vertex colours: `floor` at the geometry's
 * lowest point rising to white at the top, shaped by `power`. Cheap fake
 * ambient occlusion for props that sit on the ground.
 */
export const bakeHeightTint = (
  geometry: THREE.BufferGeometry,
  floor = 0.6,
  power = 1,
): THREE.BufferGeometry => {
  geometry.computeBoundingBox();
  const box = geometry.boundingBox ?? new THREE.Box3();
  const { min, max } = box;
  const { position } = geometry.attributes;
  if (!position) {
    return geometry;
  }
  const colors = new Float32Array(position.count * 3);
  for (let i = 0; i < position.count; i += 1) {
    const t = clamp((position.getY(i) - min.y) / (max.y - min.y || 1), 0, 1);
    const tint = floor + (1 - floor) * t ** power;
    colors[i * 3] = tint;
    colors[i * 3 + 1] = tint;
    colors[i * 3 + 2] = tint;
  }
  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  return geometry;
};

const CRATE_NAIL_HEADS: readonly (readonly [number, number])[] = [
  [14, 14],
  [114, 14],
  [14, 114],
  [114, 114],
];

/** Plank crate with a metal-banded frame and a diagonal brace. */
export const makeCrateTexture = (): THREE.CanvasTexture => {
  const canvas = makeCanvas(128, 128);
  const ctx = context2d(canvas);
  ctx.fillStyle = "#b07a3c";
  ctx.fillRect(0, 0, 128, 128);
  for (let row = 0; row < 4; row += 1) {
    ctx.fillStyle = row % 2 ? "#a9743a" : "#b98446";
    ctx.fillRect(0, row * 32, 128, 31);
    ctx.fillStyle = "rgba(60,35,12,0.55)";
    ctx.fillRect(0, row * 32 + 30, 128, 2);
  }
  ctx.strokeStyle = "#7a4d20";
  ctx.lineWidth = 14;
  ctx.strokeRect(7, 7, 114, 114);
  ctx.lineWidth = 12;
  ctx.beginPath();
  ctx.moveTo(10, 10);
  ctx.lineTo(118, 118);
  ctx.stroke();
  ctx.fillStyle = "#4a3014";
  for (const [x, y] of CRATE_NAIL_HEADS) {
    ctx.beginPath();
    ctx.arc(x, y, 3.5, 0, 7);
    ctx.fill();
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  return texture;
};

/** Vertical staves with two steel hoops; wraps around a cylinder. */
export const makeBarrelTexture = (): THREE.CanvasTexture => {
  const canvas = makeCanvas(128, 64);
  const ctx = context2d(canvas);
  for (let stave = 0; stave < 8; stave += 1) {
    ctx.fillStyle = stave % 2 ? "#9a5f2e" : "#a86a34";
    ctx.fillRect(stave * 16, 0, 16, 64);
    ctx.fillStyle = "rgba(50,28,10,0.5)";
    ctx.fillRect(stave * 16 + 15, 0, 1.5, 64);
  }
  ctx.fillStyle = "#4c4f58";
  ctx.fillRect(0, 9, 128, 7);
  ctx.fillRect(0, 48, 128, 7);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
};

// Superimposed sine waves: [xFreq, yFreq, phase, amplitude].
const WATER_WAVES: readonly (readonly [number, number, number, number])[] = [
  [1, 2, 0, 1],
  [3, -1, 1.3, 0.6],
  [-2, 3, 2.1, 0.5],
  [5, 2, 0.7, 0.28],
  [-4, -5, 4, 0.22],
  [7, -3, 2.9, 0.14],
];

const waterHeight = (x: number, y: number): number => {
  let height = 0;
  for (const [fx, fy, phase, amp] of WATER_WAVES) {
    height += Math.sin(((x * fx + y * fy) / 256) * Math.PI * 2 + phase) * amp;
  }
  return height;
};

/** Tiling normal map of gentle overlapping ripples for the water plane. */
export const makeWaterNormalTexture = (): THREE.CanvasTexture => {
  const canvas = makeCanvas(256, 256);
  const ctx = context2d(canvas);
  const image = ctx.createImageData(256, 256);
  for (let y = 0; y < 256; y += 1) {
    for (let x = 0; x < 256; x += 1) {
      const dx = (waterHeight(x + 1, y) - waterHeight(x - 1, y)) * 3.2;
      const dy = (waterHeight(x, y + 1) - waterHeight(x, y - 1)) * 3.2;
      const inv = 1 / Math.hypot(dx, dy, 1);
      const o = (y * 256 + x) * 4;
      image.data[o] = (-dx * inv * 0.5 + 0.5) * 255;
      image.data[o + 1] = (-dy * inv * 0.5 + 0.5) * 255;
      image.data[o + 2] = (inv * 0.5 + 0.5) * 255;
      image.data[o + 3] = 255;
    }
  }
  ctx.putImageData(image, 0, 0);
  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(GRID / 5, GRID / 5);
  return texture;
};
