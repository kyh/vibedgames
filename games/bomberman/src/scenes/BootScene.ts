import Phaser from "phaser";

import { TILE } from "../shared/constants";

export class BootScene extends Phaser.Scene {
  constructor() {
    super("Boot");
  }

  preload(): void {
    this.makeTextures();
    this.load.image("player", "assets/player.png");
    this.load.image("bomb", "assets/bomb.png");
  }

  create(): void {
    this.scene.start("Game");
  }

  // Built-in DynamicTexture sprites so the game runs without any image assets.
  // Replaced later by sprites generated via `vg media`.
  private makeTextures(): void {
    const g = this.add.graphics();

    // wall: dark stone
    g.fillStyle(0x393b59).fillRect(0, 0, TILE, TILE);
    g.fillStyle(0x4b4f7a).fillRect(2, 2, TILE - 4, TILE - 4);
    g.generateTexture("wall", TILE, TILE);
    g.clear();

    // crate: warm wood
    g.fillStyle(0x6d4426).fillRect(0, 0, TILE, TILE);
    g.fillStyle(0x9b6a3a).fillRect(3, 3, TILE - 6, TILE - 6);
    g.lineStyle(2, 0x6d4426).strokeRect(3, TILE / 2 - 1, TILE - 6, 2);
    g.generateTexture("crate", TILE, TILE);
    g.clear();

    // floor: subtle checker
    g.fillStyle(0x222040).fillRect(0, 0, TILE, TILE);
    g.fillStyle(0x2a2848).fillRect(0, 0, TILE / 2, TILE / 2);
    g.fillStyle(0x2a2848).fillRect(TILE / 2, TILE / 2, TILE / 2, TILE / 2);
    g.generateTexture("floor", TILE, TILE);
    g.clear();

    // bomb: black sphere + fuse
    const r = TILE / 2 - 4;
    g.fillStyle(0x121212).fillCircle(TILE / 2, TILE / 2 + 2, r);
    g.fillStyle(0x2a2a2a).fillCircle(TILE / 2 - r / 3, TILE / 2 - 1, r / 4);
    g.lineStyle(2, 0xffaa44).beginPath();
    g.moveTo(TILE / 2, TILE / 2 - r);
    g.lineTo(TILE / 2 + 4, TILE / 2 - r - 6);
    g.strokePath();
    g.generateTexture("bomb", TILE, TILE);
    g.clear();

    // explosion: bright cross sprite for a single tile
    g.fillStyle(0xffe14a).fillCircle(TILE / 2, TILE / 2, TILE / 2 - 2);
    g.fillStyle(0xff7a1a).fillCircle(TILE / 2, TILE / 2, TILE / 2 - 8);
    g.fillStyle(0xffffff).fillCircle(TILE / 2, TILE / 2, TILE / 2 - 14);
    g.generateTexture("blast", TILE, TILE);
    g.clear();

    // player: circle (color tinted at runtime)
    g.fillStyle(0xffffff).fillCircle(TILE / 2, TILE / 2, TILE / 2 - 6);
    g.fillStyle(0x000000).fillCircle(TILE / 2 - 5, TILE / 2 - 4, 2);
    g.fillStyle(0x000000).fillCircle(TILE / 2 + 5, TILE / 2 - 4, 2);
    g.generateTexture("player", TILE, TILE);
    g.destroy();
  }
}
