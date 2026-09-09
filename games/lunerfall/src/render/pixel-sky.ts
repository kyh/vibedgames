import type Phaser from "phaser";
import { Textures } from "phaser";

import { biomePalette } from "../data/biomes";
import type { BiomePalette } from "../data/biomes";

const KEY = "luner-pixel-sky";

const channel = (color: number, shift: number): number => Math.floor(color / shift) % 256;

const mix = (a: number, b: number, t: number): number => {
  const r = Math.round(channel(a, 0x1_00_00) * (1 - t) + channel(b, 0x1_00_00) * t);
  const g = Math.round(channel(a, 0x1_00) * (1 - t) + channel(b, 0x1_00) * t);
  const blue = Math.round(channel(a, 1) * (1 - t) + channel(b, 1) * t);
  return r * 0x1_00_00 + g * 0x1_00 + blue;
};

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
      existing instanceof Textures.CanvasTexture
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
    texture.setFilter(Textures.FilterMode.NEAREST);
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
    for (let y = 0; y < height; y += 1) {
      const t = y / Math.max(1, height - 1);
      const color =
        t <= 0.5 ? mix(pal.sky[0], pal.sky[1], t * 2) : mix(pal.sky[1], pal.sky[2], (t - 0.5) * 2);
      ctx.fillStyle = `#${color.toString(16).padStart(6, "0")}`;
      ctx.fillRect(0, y, width, 1);
    }
    this.texture.refresh();
  }
}
