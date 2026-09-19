import * as THREE from "three";
import { makeCanvas } from "../utils";

export interface LootBoxTextures {
  emissiveMap: THREE.CanvasTexture;
  map: THREE.CanvasTexture;
}

const SIZE = 128;

const context2d = (canvas: HTMLCanvasElement): CanvasRenderingContext2D => {
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    throw new Error("2D canvas context unavailable");
  }
  return ctx;
};

// The lightning bolt on every face reads as "power up" from any camera angle.
const drawBolt = (ctx: CanvasRenderingContext2D, emissive: boolean): void => {
  ctx.fillStyle = emissive ? "#7dffb0" : "#2fe07a";
  ctx.beginPath();
  ctx.moveTo(72, 22);
  ctx.lineTo(40, 70);
  ctx.lineTo(60, 70);
  ctx.lineTo(52, 106);
  ctx.lineTo(90, 54);
  ctx.lineTo(68, 54);
  ctx.closePath();
  ctx.fill();
};

// Purple plank stripes with a dark rim so the crate reads as a wooden box
// rather than a flat purple block.
const drawPlanks = (ctx: CanvasRenderingContext2D): void => {
  ctx.fillStyle = "#5d4a86";
  ctx.fillRect(0, 0, SIZE, SIZE);
  for (let row = 0; row < 4; row += 1) {
    ctx.fillStyle = row % 2 ? "#584480" : "#65518f";
    ctx.fillRect(0, row * 32, SIZE, 30);
  }
  ctx.strokeStyle = "#33264f";
  ctx.lineWidth = 16;
  ctx.strokeRect(8, 8, 112, 112);
};

const buildFace = (emissive: boolean): THREE.CanvasTexture => {
  const canvas = makeCanvas(SIZE, SIZE);
  const ctx = context2d(canvas);
  if (emissive) {
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, SIZE, SIZE);
  } else {
    drawPlanks(ctx);
  }
  drawBolt(ctx, emissive);
  if (emissive) {
    // A thin glowing frame keeps the crate visible at night.
    ctx.strokeStyle = "#2aff80";
    ctx.lineWidth = 3;
    ctx.strokeRect(17, 17, 94, 94);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
};

// Diffuse + emissive pair for the loot crates: the same bolt on both so the
// glow sits exactly on the painted shape.
export const buildLootBoxTextures = (): LootBoxTextures => ({
  emissiveMap: buildFace(true),
  map: buildFace(false),
});
