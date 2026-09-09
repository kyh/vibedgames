import Phaser from "phaser";

import { biomePalette } from "../data/biomes";
import type { BiomePalette } from "../data/biomes";

const KEY = "luner-pixel-sky";

function mix(a: number, b: number, t: number): number {
  const r = Math.round(((a >> 16) & 255) * (1 - t) + ((b >> 16) & 255) * t);
  const g = Math.round(((a >> 8) & 255) * (1 - t) + ((b >> 8) & 255) * t);
  const blue = Math.round((a & 255) * (1 - t) + (b & 255) * t);
  return (r << 16) | (g << 8) | blue;
}

/** Screen-pinned sky gradient painted into one half-resolution canvas texture
 * (two-pixel rows stay crisp at the game's logical size), repainted only when
 * the biome palette changes. The texture outlives the scene; each scene run
 * re-uses it and repaints on its first setPalette. */
export class PixelSky {
  readonly image: Phaser.GameObjects.Image;
  private readonly texture: Phaser.Textures.CanvasTexture;
  private paletteKey = "";

  constructor(scene: Phaser.Scene, width: number, height: number, pal = biomePalette(1)) {
    const existing = scene.textures.exists(KEY) ? scene.textures.get(KEY) : null;
    const texture =
      existing instanceof Phaser.Textures.CanvasTexture
        ? existing
        : scene.textures.createCanvas(
            KEY,
            Math.max(1, Math.ceil(width / 2)),
            Math.max(1, Math.ceil(height / 2)),
          );
    if (!texture) {
      throw new Error("Could not create Lunerfall sky texture");
    }
    this.texture = texture;
    texture.setFilter(Phaser.Textures.FilterMode.NEAREST);
    this.image = scene.add
      .image(0, 0, KEY)
      .setOrigin(0)
      .setDisplaySize(width, height)
      .setScrollFactor(0)
      .setDepth(-42);
    this.setPalette(pal);
  }

  setPalette(pal: BiomePalette): void {
    const key = pal.sky.join(":");
    if (key === this.paletteKey) {
      return;
    }
    this.paletteKey = key;
    const { width, height } = this.texture;
    const ctx = this.texture.context;
    for (let y = 0; y < height; y++) {
      const t = y / Math.max(1, height - 1);
      const color =
        t <= 0.5 ? mix(pal.sky[0], pal.sky[1], t * 2) : mix(pal.sky[1], pal.sky[2], (t - 0.5) * 2);
      ctx.fillStyle = `#${color.toString(16).padStart(6, "0")}`;
      ctx.fillRect(0, y, width, 1);
    }
    this.texture.refresh();
  }
}
