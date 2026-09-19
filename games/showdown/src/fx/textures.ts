// Canvas-painted textures for the effect decals.
import * as THREE from "three";
import { makeCanvas } from "../utils";

const SIZE = 128;
const HALF = SIZE / 2;

/**
 * A soft dark blob with a ring of speckles around it — the scorch mark left
 * on the ground after an explosion or slam. Painted once at boot; the speckle
 * layout is random so every build reads slightly different.
 */
export const buildBlobShadowTexture = (): THREE.CanvasTexture => {
  const canvas = makeCanvas(SIZE, SIZE);
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    throw new Error("2d canvas context unavailable");
  }
  const gradient = ctx.createRadialGradient(HALF, HALF, 4, HALF, HALF, 62);
  gradient.addColorStop(0, "rgba(10,6,4,0.85)");
  gradient.addColorStop(0.45, "rgba(14,9,6,0.6)");
  gradient.addColorStop(0.8, "rgba(20,12,8,0.18)");
  gradient.addColorStop(1, "rgba(20,12,8,0)");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, SIZE, SIZE);
  for (let i = 0; i < 26; i += 1) {
    const angle = Math.random() * 6.28;
    const radius = 20 + Math.random() * 38;
    ctx.fillStyle = "rgba(8,5,3,0.35)";
    ctx.beginPath();
    ctx.arc(
      HALF + Math.cos(angle) * radius,
      HALF + Math.sin(angle) * radius,
      2 + Math.random() * 5,
      0,
      7,
    );
    ctx.fill();
  }
  return new THREE.CanvasTexture(canvas);
};
