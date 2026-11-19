import * as THREE from "three";

const W = 512;
const H = 256;
const HORIZON_V = 0.5;
const ZENITH_MUL = 0.6;
const HORIZON_MUL = 0.78;
const STARS = 700;
const REBAKE_EPS = 0.012;
const DITHER_AMPLITUDE = 0.75;

/* oxlint-disable no-bitwise -- LCG: the uint32 wrap IS the algorithm */
const starRng = (seed: number) => {
  let s = seed >>> 0;

  return () => {
    s = (s * 1_664_525 + 1_013_904_223) >>> 0;

    return s / 4_294_967_296;
  };
};
/* oxlint-enable no-bitwise */

const scratch = new THREE.Color();
const hRGB = { b: 0, g: 0, r: 0 };
const zRGB = { b: 0, g: 0, r: 0 };

const paint = (ctx: CanvasRenderingContext2D, fog: THREE.Color) => {
  scratch.copy(fog).multiplyScalar(HORIZON_MUL);
  const hStyle = scratch.getStyle();
  scratch.getRGB(hRGB, THREE.SRGBColorSpace);
  scratch.copy(fog).multiplyScalar(HORIZON_MUL * ZENITH_MUL);
  scratch.b = Math.min(1, scratch.b * 1.5 + 0.004);
  scratch.r *= 0.72;
  scratch.g *= 0.86;
  scratch.getRGB(zRGB, THREE.SRGBColorSpace);

  const rows = Math.round(H * HORIZON_V);
  const img = ctx.createImageData(W, rows);
  const px = img.data;
  const ditherRnd = starRng(0x2b_9d_43);
  let i = 0;

  for (let y = 0; y < rows; y += 1) {
    const t = y / (rows - 1);
    const r = (zRGB.r + (hRGB.r - zRGB.r) * t) * 255;
    const g = (zRGB.g + (hRGB.g - zRGB.g) * t) * 255;
    const b = (zRGB.b + (hRGB.b - zRGB.b) * t) * 255;

    for (let x = 0; x < W; x += 1) {
      const n = (ditherRnd() + ditherRnd() - 1) * DITHER_AMPLITUDE;
      px[i] = r + n;
      i += 1;
      px[i] = g + n;
      i += 1;
      px[i] = b + n;
      i += 1;
      px[i] = 255;
      i += 1;
    }
  }

  ctx.putImageData(img, 0, 0);
  ctx.fillStyle = hStyle;
  ctx.fillRect(0, rows, W, H - rows);

  const rnd = starRng(0x5f_3a_11);

  for (let star = 0; star < STARS; star += 1) {
    const x = rnd() * W;
    const t = rnd();
    const y = H * HORIZON_V * (1 - t);
    const bright = rnd();
    const a = (0.18 + 0.72 * bright * bright) * (0.25 + 0.75 * t);
    let r = 0.7;

    if (bright > 0.94) {
      r = 1.5;
    } else if (bright > 0.75) {
      r = 1;
    }

    let tint = "255,255,255";

    if (bright > 0.9) {
      tint = rnd() > 0.5 ? "255,228,205" : "205,224,255";
    }

    ctx.fillStyle = `rgba(${tint},${a.toFixed(3)})`;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
};

/**
 * Equirectangular night dome, re-painted only when the fog colour it has to
 * meet has drifted. `null` on a canvas-less runtime (the gen worker) so the
 * caller falls back to the flat background.
 */
export class NightSky {
  private canvas: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;
  private tex: THREE.CanvasTexture | null = null;
  private bakedFor = new THREE.Color(-1, -1, -1);

  texture(fog: THREE.Color) {
    if (!this.canvas) {
      if (typeof document === "undefined") {
        return null;
      }

      this.canvas = document.createElement("canvas");
      this.canvas.width = W;
      this.canvas.height = H;
      this.ctx = this.canvas.getContext("2d");

      if (!this.ctx) {
        return null;
      }

      this.tex = new THREE.CanvasTexture(this.canvas);
      this.tex.mapping = THREE.EquirectangularReflectionMapping;
      this.tex.colorSpace = THREE.SRGBColorSpace;
    }

    const { ctx } = this;
    const { tex } = this;

    if (!ctx || !tex) {
      return null;
    }

    if (
      Math.abs(fog.r - this.bakedFor.r) > REBAKE_EPS ||
      Math.abs(fog.g - this.bakedFor.g) > REBAKE_EPS ||
      Math.abs(fog.b - this.bakedFor.b) > REBAKE_EPS
    ) {
      this.bakedFor.copy(fog);
      paint(ctx, fog);
      tex.needsUpdate = true;
    }

    return tex;
  }
}
