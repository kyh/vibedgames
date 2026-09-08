import Phaser from "phaser";

import { type BiomePalette, biomePalette } from "../data/biomes";

let nextSky = 0;

function mix(a: number, b: number, t: number): number {
  const r = Math.round(((a >> 16) & 255) * (1 - t) + ((b >> 16) & 255) * t);
  const g = Math.round(((a >> 8) & 255) * (1 - t) + ((b >> 8) & 255) * t);
  const blue = Math.round((a & 255) * (1 - t) + (b & 255) * t);
  return (r << 16) | (g << 8) | blue;
}

/** One room-independent texture, repainted only when the biome changes. The
 * two-pixel rows stay crisp at the game's logical resolution. */
export class PixelSky {
  readonly image: Phaser.GameObjects.Image;
  private readonly texture: Phaser.Textures.CanvasTexture;
  private readonly key = `luner-pixel-sky-${nextSky++}`;
  private paletteKey = "";
  private released = false;

  constructor(
    private readonly scene: Phaser.Scene,
    width: number,
    height: number,
    pal: BiomePalette = biomePalette(1),
  ) {
    const texture = scene.textures.createCanvas(
      this.key,
      Math.max(1, Math.ceil(width / 2)),
      Math.max(1, Math.ceil(height / 2)),
    );
    if (!texture) throw new Error("Could not create Lunerfall sky texture");
    this.texture = texture;
    texture.setFilter(Phaser.Textures.FilterMode.NEAREST);
    this.image = scene.add
      .image(0, 0, this.key)
      .setOrigin(0)
      .setDisplaySize(width, height)
      .setScrollFactor(0)
      .setDepth(-42);
    this.setPalette(pal);
    scene.events.once(Phaser.Scenes.Events.SHUTDOWN, this.destroy);
    scene.events.once(Phaser.Scenes.Events.DESTROY, this.destroy);
  }

  setPalette(pal: BiomePalette): void {
    const key = pal.sky.join(":");
    if (this.released || key === this.paletteKey) return;
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

  destroy = (): void => {
    if (this.released) return;
    this.released = true;
    this.scene.events.off(Phaser.Scenes.Events.SHUTDOWN, this.destroy);
    this.scene.events.off(Phaser.Scenes.Events.DESTROY, this.destroy);
    if (this.image.scene) this.image.destroy();
    this.scene.textures.remove(this.key);
  };
}
