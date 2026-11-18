// Every surface in Glowline is drawn here, on a canvas, once at boot: albedo,
// a height field turned into a normal map, and roughness. No image files. The
// point is variation inside a surface — aggregate in the asphalt, stains and
// joints in the concrete, chips in the paint — so nothing reads as one colour.

import * as THREE from "three";

/** A deterministic 0–1 stream, so a surface looks the same on every client. */
export const seeded = (seed: number): (() => number) => {
  let state = seed % 2_147_483_647;
  if (state <= 0) {
    state += 2_147_483_646;
  }
  return () => {
    state = (state * 48_271) % 2_147_483_647;
    return (state - 1) / 2_147_483_646;
  };
};

export interface SurfaceMaps {
  map: THREE.CanvasTexture;
  normalMap: THREE.CanvasTexture;
  roughnessMap: THREE.CanvasTexture;
}

type Painter = (ctx: CanvasRenderingContext2D, size: number, random: () => number) => void;

const canvasOf = (size: number, height = size): [HTMLCanvasElement, CanvasRenderingContext2D] => {
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) {
    throw new Error("2D canvas unavailable");
  }
  return [canvas, ctx];
};

const tiled = (canvas: HTMLCanvasElement, srgb: boolean): THREE.CanvasTexture => {
  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.anisotropy = 8;
  if (srgb) {
    texture.colorSpace = THREE.SRGBColorSpace;
  }
  return texture;
};

/** Sobel over a greyscale height canvas (wrapping), as a tangent-space normal map. */
const normalFrom = (height: CanvasRenderingContext2D, size: number, strength: number) => {
  const src = height.getImageData(0, 0, size, size).data;
  const [canvas, ctx] = canvasOf(size);
  const out = ctx.createImageData(size, size);
  const at = (x: number, y: number): number =>
    (src[(((y + size) % size) * size + ((x + size) % size)) * 4] ?? 0) / 255;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const dx = (at(x + 1, y) - at(x - 1, y)) * strength;
      const dy = (at(x, y + 1) - at(x, y - 1)) * strength;
      const len = Math.hypot(dx, dy, 1);
      const o = (y * size + x) * 4;
      out.data[o] = (-dx / len) * 127 + 128;
      out.data[o + 1] = (dy / len) * 127 + 128;
      out.data[o + 2] = (1 / len) * 127 + 128;
      out.data[o + 3] = 255;
    }
  }
  ctx.putImageData(out, 0, 0);
  return tiled(canvas, false);
};

/** Scatter `count` soft dots; the base of every grainy surface. */
const speckle = (
  ctx: CanvasRenderingContext2D,
  size: number,
  random: () => number,
  count: number,
  shade: (r: number) => string,
  radius: (r: number) => number,
): void => {
  for (let i = 0; i < count; i += 1) {
    ctx.fillStyle = shade(random());
    const r = radius(random());
    const x = random() * size;
    const y = random() * size;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
    // Wrap the dot across the seam so the tile repeats cleanly.
    if (x < r || y < r) {
      ctx.beginPath();
      ctx.arc(x + size, y + size, r, 0, Math.PI * 2);
      ctx.arc(x + size, y, r, 0, Math.PI * 2);
      ctx.arc(x, y + size, r, 0, Math.PI * 2);
      ctx.fill();
    }
  }
};

/** Large soft blotches: stains, patches, wear. */
const blotches = (
  ctx: CanvasRenderingContext2D,
  size: number,
  random: () => number,
  count: number,
  color: string,
  alpha: number,
): void => {
  for (let i = 0; i < count; i += 1) {
    const x = random() * size;
    const y = random() * size;
    const r = size * (0.05 + random() * 0.16);
    const blot = ctx.createRadialGradient(x, y, 0, x, y, r);
    blot.addColorStop(0, color);
    blot.addColorStop(1, "rgba(0,0,0,0)");
    ctx.globalAlpha = alpha * (0.4 + random() * 0.6);
    ctx.fillStyle = blot;
    ctx.fillRect(x - r, y - r, r * 2, r * 2);
  }
  ctx.globalAlpha = 1;
};

const cracks = (
  ctx: CanvasRenderingContext2D,
  size: number,
  random: () => number,
  count: number,
  color: string,
): void => {
  ctx.strokeStyle = color;
  for (let i = 0; i < count; i += 1) {
    let x = random() * size;
    let y = random() * size;
    let a = random() * Math.PI * 2;
    ctx.lineWidth = 0.6 + random() * 1.2;
    ctx.beginPath();
    ctx.moveTo(x, y);
    for (let step = 0; step < 14 + random() * 20; step += 1) {
      a += (random() - 0.5) * 0.9;
      x += Math.cos(a) * 6;
      y += Math.sin(a) * 6;
      ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
};

/** Draw one surface three times (albedo, height, roughness) from the same seed. */
const surface = (
  size: number,
  seed: number,
  albedo: Painter,
  height: Painter,
  rough: Painter,
  bump: number,
): SurfaceMaps => {
  const [colorCanvas, colorCtx] = canvasOf(size);
  albedo(colorCtx, size, seeded(seed));
  const [, heightCtx] = canvasOf(size);
  height(heightCtx, size, seeded(seed));
  const [roughCanvas, roughCtx] = canvasOf(size);
  rough(roughCtx, size, seeded(seed));
  return {
    map: tiled(colorCanvas, true),
    normalMap: normalFrom(heightCtx, size, bump),
    roughnessMap: tiled(roughCanvas, false),
  };
};

const grey = (v: number): string => {
  const c = Math.round(Math.min(255, Math.max(0, v)));
  return `rgb(${c},${c},${c})`;
};

/**
 * Road asphalt: dark binder and pale aggregate, nothing larger than a stone.
 * Anything bigger would line up into stripes once the tile repeats; patches
 * and wear are added in world space by the road shader instead.
 */
export const asphalt = (tint: string): SurfaceMaps =>
  surface(
    512,
    11,
    (ctx, size, random) => {
      ctx.fillStyle = tint;
      ctx.fillRect(0, 0, size, size);
      speckle(
        ctx,
        size,
        random,
        11_000,
        (r) => `rgba(${150 + r * 90},${150 + r * 90},${160 + r * 90},${0.08 + r * 0.2})`,
        (r) => 0.5 + r * 1.2,
      );
      speckle(
        ctx,
        size,
        random,
        3600,
        (r) => `rgba(0,0,0,${0.18 + r * 0.3})`,
        (r) => 0.6 + r * 1.5,
      );
    },
    (ctx, size, random) => {
      ctx.fillStyle = grey(120);
      ctx.fillRect(0, 0, size, size);
      speckle(
        ctx,
        size,
        random,
        11_000,
        (r) => `rgba(255,255,255,${0.25 + r * 0.4})`,
        (r) => 0.5 + r * 1.2,
      );
      speckle(
        ctx,
        size,
        random,
        3600,
        (r) => `rgba(0,0,0,${0.3 + r * 0.4})`,
        (r) => 0.6 + r * 1.5,
      );
    },
    (ctx, size, random) => {
      ctx.fillStyle = grey(215);
      ctx.fillRect(0, 0, size, size);
      speckle(
        ctx,
        size,
        random,
        5000,
        (r) => `rgba(255,255,255,${0.1 + r * 0.2})`,
        (r) => 0.6 + r * 1.2,
      );
    },
    2,
  );

/** Panel joints: a 2×2 grid of lines that tiles. */
const joints = (ctx: CanvasRenderingContext2D, size: number, color: string, width: number) => {
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  for (let i = 0; i <= 2; i += 1) {
    const p = (i * size) / 2;
    ctx.beginPath();
    ctx.moveTo(p, 0);
    ctx.lineTo(p, size);
    ctx.moveTo(0, p);
    ctx.lineTo(size, p);
    ctx.stroke();
  }
};

/** Poured concrete: panel joints, drip stains, pitting. */
export const concrete = (tint: string, seed = 23): SurfaceMaps =>
  surface(
    512,
    seed,
    (ctx, size, random) => {
      ctx.fillStyle = tint;
      ctx.fillRect(0, 0, size, size);
      blotches(ctx, size, random, 30, "rgba(0,0,0,0.9)", 0.09);
      blotches(ctx, size, random, 22, "rgba(255,240,220,0.9)", 0.06);
      speckle(
        ctx,
        size,
        random,
        5000,
        (r) => `rgba(0,0,0,${0.05 + r * 0.14})`,
        (r) => 0.5 + r * 1.4,
      );
      joints(ctx, size, "rgba(0,0,0,0.45)", 3);
      cracks(ctx, size, random, 4, "rgba(0,0,0,0.35)");
    },
    (ctx, size, random) => {
      ctx.fillStyle = grey(150);
      ctx.fillRect(0, 0, size, size);
      blotches(ctx, size, random, 30, "rgba(0,0,0,1)", 0.08);
      speckle(
        ctx,
        size,
        random,
        5000,
        (r) => `rgba(0,0,0,${0.2 + r * 0.4})`,
        (r) => 0.5 + r * 1.4,
      );
      joints(ctx, size, "rgba(0,0,0,1)", 4);
      cracks(ctx, size, random, 4, "rgba(0,0,0,0.8)");
    },
    (ctx, size, random) => {
      ctx.fillStyle = grey(225);
      ctx.fillRect(0, 0, size, size);
      blotches(ctx, size, random, 30, "rgba(120,120,120,1)", 0.12);
    },
    1.6,
  );

/** Mown grass: mottled greens, darker clumps, a few pale dry patches. */
export const grass = (): SurfaceMaps =>
  surface(
    512,
    37,
    (ctx, size, random) => {
      ctx.fillStyle = "#2d5a34";
      ctx.fillRect(0, 0, size, size);
      blotches(ctx, size, random, 36, "rgba(16,48,26,0.95)", 0.12);
      blotches(ctx, size, random, 26, "rgba(120,160,70,0.95)", 0.08);
      speckle(
        ctx,
        size,
        random,
        12_000,
        (r) => `rgba(${40 + r * 90},${100 + r * 90},${40 + r * 40},${0.18 + r * 0.25})`,
        (r) => 0.5 + r * 1.2,
      );
    },
    (ctx, size, random) => {
      ctx.fillStyle = grey(110);
      ctx.fillRect(0, 0, size, size);
      blotches(ctx, size, random, 36, "rgba(0,0,0,1)", 0.2);
      speckle(
        ctx,
        size,
        random,
        12_000,
        (r) => `rgba(255,255,255,${0.2 + r * 0.5})`,
        (r) => 0.5 + r * 1.2,
      );
    },
    (ctx, size) => {
      ctx.fillStyle = grey(240);
      ctx.fillRect(0, 0, size, size);
    },
    2.4,
  );

/** Painted metal or moulded plastic: mostly clean, scuffed and chipped at random. */
export const paintedPanel = (): SurfaceMaps =>
  surface(
    256,
    51,
    (ctx, size, random) => {
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, size, size);
      blotches(ctx, size, random, 14, "rgba(0,0,0,0.9)", 0.16);
      speckle(
        ctx,
        size,
        random,
        260,
        (r) => `rgba(20,20,24,${0.25 + r * 0.45})`,
        (r) => 0.6 + r * 2.4,
      );
      ctx.strokeStyle = "rgba(0,0,0,0.22)";
      ctx.lineWidth = 1;
      for (let i = 0; i < 26; i += 1) {
        const x = random() * size;
        const y = random() * size;
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x + (random() - 0.5) * 60, y + (random() - 0.5) * 8);
        ctx.stroke();
      }
    },
    (ctx, size, random) => {
      ctx.fillStyle = grey(140);
      ctx.fillRect(0, 0, size, size);
      speckle(
        ctx,
        size,
        random,
        260,
        (r) => `rgba(0,0,0,${0.4 + r * 0.5})`,
        (r) => 0.6 + r * 2.4,
      );
    },
    (ctx, size, random) => {
      ctx.fillStyle = grey(120);
      ctx.fillRect(0, 0, size, size);
      blotches(ctx, size, random, 14, "rgba(255,255,255,1)", 0.5);
    },
    1.2,
  );

export interface FacadeMaps {
  map: THREE.CanvasTexture;
  emissiveMap: THREE.CanvasTexture;
}

/**
 * A building face: wall, floor bands, a grid of windows. Some windows are lit,
 * in the warm and cool whites a real street mixes; the emissive map carries
 * only those, so the wall still takes the sun. `rows` is the storey count the
 * texture is drawn with, chosen to suit how tall the buildings wearing it are.
 */
export const facade = (wall: string, lit: string, seed: number, rows: number): FacadeMaps => {
  const random = seeded(seed);
  const [canvas, ctx] = canvasOf(256, 512);
  const [glowCanvas, glow] = canvasOf(256, 512);
  ctx.fillStyle = wall;
  ctx.fillRect(0, 0, 256, 512);
  blotches(ctx, 256, random, 10, "rgba(0,0,0,0.9)", 0.25);
  glow.fillStyle = "#000";
  glow.fillRect(0, 0, 256, 512);
  const cols = 6 + Math.floor(random() * 3);
  const cw = 256 / cols;
  const rh = 512 / rows;
  for (let row = 0; row < rows; row += 1) {
    ctx.fillStyle = "rgba(0,0,0,0.28)";
    ctx.fillRect(0, row * rh, 256, 2);
    ctx.fillStyle = "rgba(255,255,255,0.06)";
    ctx.fillRect(0, row * rh + 2, 256, 1.5);
    for (let col = 0; col < cols; col += 1) {
      const x = col * cw + cw * 0.18;
      const y = row * rh + rh * 0.24;
      const w = cw * 0.64;
      const h = rh * 0.56;
      const on = random() < 0.2;
      ctx.fillStyle = on ? lit : "#243049";
      ctx.fillRect(x, y, w, h);
      // Blinds, mullions: no two windows quite the same.
      ctx.fillStyle = "rgba(0,0,0,0.35)";
      ctx.fillRect(x + w / 2 - 0.75, y, 1.5, h);
      ctx.fillRect(x, y, w, h * random() * 0.5);
      if (on) {
        glow.fillStyle = random() < 0.25 ? "#bfe4ff" : lit;
        glow.globalAlpha = 0.45 + random() * 0.55;
        glow.fillRect(x, y, w, h);
        glow.globalAlpha = 1;
      } else {
        ctx.fillStyle = "rgba(120,160,220,0.12)";
        ctx.fillRect(x, y, w, h * 0.4);
      }
    }
  }
  // Weathering: rain streaks down from sills, a darker base, a lighter top.
  for (let i = 0; i < 46; i += 1) {
    const x = random() * 256;
    const y = random() * 440;
    const streak = ctx.createLinearGradient(0, y, 0, y + 30 + random() * 70);
    streak.addColorStop(0, "rgba(30,24,20,0.3)");
    streak.addColorStop(1, "rgba(30,24,20,0)");
    ctx.fillStyle = streak;
    ctx.fillRect(x, y, 2 + random() * 5, 100);
  }
  const wash = ctx.createLinearGradient(0, 0, 0, 512);
  wash.addColorStop(0, "rgba(255,250,235,0.14)");
  wash.addColorStop(0.7, "rgba(0,0,0,0)");
  wash.addColorStop(1, "rgba(20,16,14,0.42)");
  ctx.fillStyle = wash;
  ctx.fillRect(0, 0, 256, 512);
  const map = new THREE.CanvasTexture(canvas);
  map.colorSpace = THREE.SRGBColorSpace;
  map.anisotropy = 4;
  const emissiveMap = new THREE.CanvasTexture(glowCanvas);
  emissiveMap.colorSpace = THREE.SRGBColorSpace;
  return { emissiveMap, map };
};

/** A lit trackside sign: a slab of colour, a chevron band, big italic lettering. */
export const signTexture = (text: string, background: string, ink: string): THREE.CanvasTexture => {
  const [canvas, ctx] = canvasOf(512, 160);
  const fill = ctx.createLinearGradient(0, 0, 0, 160);
  fill.addColorStop(0, background);
  fill.addColorStop(1, "#000000");
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, 512, 160);
  ctx.globalAlpha = 0.28;
  ctx.fillStyle = fill;
  ctx.fillRect(0, 0, 512, 160);
  ctx.globalAlpha = 1;
  ctx.fillStyle = ink;
  for (let i = -1; i < 12; i += 1) {
    ctx.beginPath();
    ctx.moveTo(i * 48, 160);
    ctx.lineTo(i * 48 + 24, 160);
    ctx.lineTo(i * 48 + 44, 132);
    ctx.lineTo(i * 48 + 20, 132);
    ctx.fill();
  }
  ctx.font = "italic 900 84px 'Chakra Petch', 'Arial Black', sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, 256, 68, 480);
  ctx.strokeStyle = ink;
  ctx.lineWidth = 6;
  ctx.strokeRect(3, 3, 506, 154);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 8;
  return texture;
};

/** Black and white checks, for the gantry banner and the finish strip. */
export const checker = (cols: number, rows: number): THREE.CanvasTexture => {
  const cell = 32;
  const [canvas, ctx] = canvasOf(cols * cell, rows * cell);
  for (let y = 0; y < rows; y += 1) {
    for (let x = 0; x < cols; x += 1) {
      ctx.fillStyle = (x + y) % 2 === 0 ? "#f4f4f4" : "#101014";
      ctx.fillRect(x * cell, y * cell, cell, cell);
    }
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.magFilter = THREE.NearestFilter;
  return texture;
};

/** A soft round falloff, for lamp pools on the ground and glow sprites. */
export const softDisc = (): THREE.CanvasTexture => {
  const [canvas, ctx] = canvasOf(128);
  const fall = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
  fall.addColorStop(0, "rgba(255,255,255,1)");
  fall.addColorStop(0.35, "rgba(255,255,255,0.45)");
  fall.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = fall;
  ctx.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(canvas);
};

/** A square that fades out towards its edges: the shade round a building's foot. */
export const softSquare = (): THREE.CanvasTexture => {
  const [canvas, ctx] = canvasOf(128);
  ctx.clearRect(0, 0, 128, 128);
  ctx.filter = "blur(11px)";
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(26, 26, 76, 76);
  return new THREE.CanvasTexture(canvas);
};

/** Thin cloud bands for the sky dome, alpha only. */
export const cloudBands = (seed: number): THREE.CanvasTexture => {
  const random = seeded(seed);
  const [canvas, ctx] = canvasOf(1024, 256);
  ctx.clearRect(0, 0, 1024, 256);
  for (let i = 0; i < 46; i += 1) {
    const x = random() * 1024;
    const y = 90 + random() * 150;
    const w = 50 + random() * 150;
    const h = 8 + random() * 26;
    const band = ctx.createRadialGradient(x, y, 0, x, y, w);
    band.addColorStop(0, `rgba(255,255,255,${0.1 + random() * 0.2})`);
    band.addColorStop(1, "rgba(255,255,255,0)");
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(1, h / w);
    ctx.translate(-x, -y);
    ctx.fillStyle = band;
    ctx.fillRect(x - w, y - w, w * 2, w * 2);
    ctx.restore();
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  return texture;
};
