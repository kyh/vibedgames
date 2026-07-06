import Phaser from "phaser";

import { COLORS, TILE } from "./config";
import type { Grid } from "./sys/grid";

// Gray-box render of a collision Grid: stone blocks with a lit neon top edge;
// one-ways as thin magenta bars. (Swapped for real tileset art later.)
export function drawRoom(scene: Phaser.Scene, grid: Grid): Phaser.GameObjects.Container {
  const c = scene.add.container(0, 0);
  for (let cy = 0; cy < grid.rows; cy++) {
    for (let cx = 0; cx < grid.cols; cx++) {
      const v = grid.cells[cy * grid.cols + cx];
      const x = cx * TILE;
      const y = cy * TILE;
      if (v === 1) {
        c.add(scene.add.rectangle(x, y, TILE, TILE, COLORS.stone).setOrigin(0));
        if (!grid.isSolidCell(cx, cy - 1)) c.add(scene.add.rectangle(x, y, TILE, 2, COLORS.teal, 0.85).setOrigin(0));
      } else if (v === 2) {
        c.add(scene.add.rectangle(x, y, TILE, 3, COLORS.magenta, 0.8).setOrigin(0));
      }
    }
  }
  return c;
}
