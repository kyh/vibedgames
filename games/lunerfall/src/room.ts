import type Phaser from "phaser";

import { TILE } from "./config";
import { biomePalette } from "./data/biomes";
import type { BiomePalette } from "./data/biomes";
import type { Grid } from "./sys/grid";

const FRAMES: [string, number, number, number, number][] = [
  ["t-dirt", 49, 58, TILE, TILE],
  ["t-grass", 48, 25, TILE, 18],
  ["t-edge", 28, 55, TILE, TILE],
  ["t-plat", 49, 30, TILE, 6],
];

const registerFrames = (scene: Phaser.Scene) => {
  const tex = scene.textures.get("env:tiles");

  if (tex.has("t-dirt")) {
    return;
  }

  for (const [name, x, y, w, h] of FRAMES) {
    tex.add(name, 0, x, y, w, h);
  }
};

export const drawRoom = (scene: Phaser.Scene, grid: Grid, pal: BiomePalette = biomePalette(1)) => {
  registerFrames(scene);
  const c = scene.add.container(0, 0);

  const dirt = (x: number, y: number, frame: string, flip = false) =>
    scene.add.image(x, y, "env:tiles", frame).setOrigin(0).setFlipX(flip).setTint(pal.tile);

  const oneWayGlow: { x: number; y: number }[] = [];

  for (let cy = 0; cy < grid.rows; cy += 1) {
    for (let cx = 0; cx < grid.cols; cx += 1) {
      const v = grid.cells[cy * grid.cols + cx];
      const x = cx * TILE;
      const y = cy * TILE;

      if (v === 1) {
        c.add(dirt(x, y, "t-dirt"));

        if (!grid.isSolidCell(cx - 1, cy)) {
          c.add(dirt(x, y, "t-edge"));
        }

        if (!grid.isSolidCell(cx + 1, cy)) {
          c.add(dirt(x, y, "t-edge", true));
        }

        if (!grid.isSolidCell(cx, cy - 1)) {
          c.add(scene.add.image(x, y - 3, "env:tiles", "t-grass").setOrigin(0));
        }
      } else if (v === 2) {
        c.add(dirt(x, y, "t-plat"));
        oneWayGlow.push({ x, y });
      }
    }
  }

  for (const g of oneWayGlow) {
    c.add(scene.add.rectangle(g.x, g.y - 1, TILE, 2, pal.oneway, 0.7).setOrigin(0));
  }

  return c;
};
