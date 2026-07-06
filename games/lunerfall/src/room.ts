import Phaser from "phaser";

import { COLORS, TILE } from "./config";
import type { Grid } from "./sys/grid";

// Crops into the Luneblade tile sheet (env:tiles), measured from the source:
// the foreground stone block's solid body, its lit top surface, and its glowing
// side edge. Registered once as named frames so we can stamp them per cell.
const FRAMES: [string, number, number, number, number][] = [
  ["t-fill", 49, 60, TILE, TILE], // solid stone body
  ["t-top", 49, 30, TILE, TILE], // stone with the lit teal top rim
  ["t-side", 30, 60, TILE, TILE], // stone with a lit left edge (flip for right)
  ["t-plat", 49, 30, TILE, 6], // thin one-way platform (top rim only)
];

function registerFrames(scene: Phaser.Scene) {
  const tex = scene.textures.get("env:tiles");
  if (tex.has("t-fill")) return;
  for (const [name, x, y, w, h] of FRAMES) tex.add(name, 0, x, y, w, h);
}

// Renders a collision Grid with real stone tiles: solid body fill, a lit top rim
// on exposed surfaces, glowing side edges, and thin neon one-way platforms.
export function drawRoom(scene: Phaser.Scene, grid: Grid): Phaser.GameObjects.Container {
  registerFrames(scene);
  const c = scene.add.container(0, 0);
  for (let cy = 0; cy < grid.rows; cy++) {
    for (let cx = 0; cx < grid.cols; cx++) {
      const v = grid.cells[cy * grid.cols + cx];
      const x = cx * TILE;
      const y = cy * TILE;
      if (v === 1) {
        const surface = !grid.isSolidCell(cx, cy - 1);
        c.add(scene.add.image(x, y, "env:tiles", surface ? "t-top" : "t-fill").setOrigin(0));
        if (!grid.isSolidCell(cx - 1, cy)) c.add(scene.add.image(x, y, "env:tiles", "t-side").setOrigin(0));
        if (!grid.isSolidCell(cx + 1, cy)) c.add(scene.add.image(x, y, "env:tiles", "t-side").setOrigin(0).setFlipX(true));
        if (surface) c.add(scene.add.rectangle(x, y - 1, TILE, 2, COLORS.teal, 0.5).setOrigin(0)); // neon bloom
      } else if (v === 2) {
        c.add(scene.add.image(x, y, "env:tiles", "t-plat").setOrigin(0));
        c.add(scene.add.rectangle(x, y - 1, TILE, 2, COLORS.magenta, 0.7).setOrigin(0));
      }
    }
  }
  return c;
}
