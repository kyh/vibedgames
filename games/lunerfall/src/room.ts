import Phaser from "phaser";

import { TILE } from "./config";
import { type BiomePalette, biomePalette } from "./data/biomes";
import type { Grid } from "./sys/grid";

// Crops into the Luneblade tile sheet (env:tiles), measured from the grass-bordered
// foreground block: the dark dirt body, the lush teal grass-top (tufts overhang the
// cell), and the grassy left edge. Registered once as named frames per cell.
const FRAMES: [string, number, number, number, number][] = [
  ["t-dirt", 49, 58, TILE, TILE], // dark dirt body fill
  ["t-grass", 48, 25, TILE, 18], // grass-tuft top (18px: tufts + body, overhangs up)
  ["t-edge", 28, 55, TILE, TILE], // dirt with the teal grass side fringe (flip for right)
  ["t-plat", 49, 30, TILE, 6], // thin one-way platform (top rim only)
];

function registerFrames(scene: Phaser.Scene) {
  const tex = scene.textures.get("env:tiles");
  if (tex.has("t-dirt")) return;
  for (const [name, x, y, w, h] of FRAMES) tex.add(name, 0, x, y, w, h);
}

// Renders a collision Grid with real Luneblade tiles: dirt-body fill, grass-tuft
// tops on exposed surfaces, grassy side fringes on open edges, and thin neon
// one-way platforms.
export function drawRoom(
  scene: Phaser.Scene,
  grid: Grid,
  pal: BiomePalette = biomePalette(1),
): Phaser.GameObjects.Container {
  registerFrames(scene);
  const c = scene.add.container(0, 0);
  // Dirt body + side fringes take the biome tint; the teal grass crown does not.
  const dirt = (x: number, y: number, frame: string, flip = false) =>
    scene.add.image(x, y, "env:tiles", frame).setOrigin(0).setFlipX(flip).setTint(pal.tile);
  // Every tile is one `env:tiles` texture, so emitting them all first keeps the
  // whole room in a single WebGL batch. The one-way neon lines (a different
  // pipeline) go in a second pass afterwards — interleaving them per-cell forced
  // a batch flush on every platform and tanked the scroll frame rate.
  const oneWayGlow: { x: number; y: number }[] = [];
  for (let cy = 0; cy < grid.rows; cy++) {
    for (let cx = 0; cx < grid.cols; cx++) {
      const v = grid.cells[cy * grid.cols + cx];
      const x = cx * TILE;
      const y = cy * TILE;
      if (v === 1) {
        c.add(dirt(x, y, "t-dirt"));
        if (!grid.isSolidCell(cx - 1, cy)) c.add(dirt(x, y, "t-edge"));
        if (!grid.isSolidCell(cx + 1, cy)) c.add(dirt(x, y, "t-edge", true));
        // Grass tufts crown any surface open to the sky; nudged up 3px so the
        // tufts overhang the platform lip.
        if (!grid.isSolidCell(cx, cy - 1)) c.add(scene.add.image(x, y - 3, "env:tiles", "t-grass").setOrigin(0));
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
}
