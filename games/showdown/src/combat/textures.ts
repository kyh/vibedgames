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

// A warm sun medallion marks the arena's old reliquaries.
const drawCrest = (ctx: CanvasRenderingContext2D, emissive: boolean): void => {
  if (!emissive) {
    ctx.fillStyle = "#3c382e";
    ctx.beginPath();
    ctx.arc(64, 64, 28, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.strokeStyle = emissive ? "#9b7440" : "#d8b76c";
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.arc(64, 64, 14, 0, Math.PI * 2);
  ctx.stroke();
  for (let ray = 0; ray < 8; ray += 1) {
    const angle = (ray / 8) * Math.PI * 2;
    ctx.beginPath();
    ctx.moveTo(64 + Math.cos(angle) * 19, 64 + Math.sin(angle) * 19);
    ctx.lineTo(64 + Math.cos(angle) * 24, 64 + Math.sin(angle) * 24);
    ctx.stroke();
  }
};

const drawPlanks = (ctx: CanvasRenderingContext2D): void => {
  ctx.fillStyle = "#75563c";
  ctx.fillRect(0, 0, SIZE, SIZE);
  for (let row = 0; row < 4; row += 1) {
    ctx.fillStyle = row % 2 ? "#806246" : "#8c6a49";
    ctx.fillRect(0, row * 32, SIZE, 29);
    ctx.strokeStyle = "#6b5039";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(7, row * 32 + 11);
    ctx.bezierCurveTo(36, row * 32 + 5, 70, row * 32 + 19, 119, row * 32 + 13);
    ctx.stroke();
  }
  ctx.strokeStyle = "#4f4c3c";
  ctx.lineWidth = 14;
  ctx.strokeRect(8, 8, 112, 112);
  ctx.strokeStyle = "#b39558";
  ctx.lineWidth = 3;
  ctx.strokeRect(13, 13, 102, 102);
  ctx.fillStyle = "#d0b574";
  for (const x of [10, 118]) {
    for (const y of [10, 118]) {
      ctx.beginPath();
      ctx.arc(x, y, 3, 0, Math.PI * 2);
      ctx.fill();
    }
  }
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
  drawCrest(ctx, emissive);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
};

// Only the sun inlay glows; the timber and bronze stay matte.
export const buildLootBoxTextures = (): LootBoxTextures => ({
  emissiveMap: buildFace(true),
  map: buildFace(false),
});
