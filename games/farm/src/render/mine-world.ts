import type Phaser from "phaser";
import { DEPTH, TILE } from "../config";

// Original atlas cells: plain stone, small loose stones, continuous masonry.
// All three fill their 16px cells; partial arch/corner tiles are not floor tiles.
const STONE = 1032;
const GRIT = 1037;
const MASONRY = 961;

/** Static dressing only. The caller retains the untouched collision grid. */
export function buildMineWorld(
  scene: Phaser.Scene,
  walls: Uint8Array,
  width: number,
  height: number,
): void {
  const blocked = (x: number, y: number): boolean =>
    x < 0 || y < 0 || x >= width || y >= height || walls[y * width + x] === 1;
  const floor: number[][] = [];
  const stone: number[][] = [];
  for (let y = 0; y < height; y++) {
    const floorRow: number[] = [];
    const wallRow: number[] = [];
    for (let x = 0; x < width; x++) {
      // A coordinate hash keeps dressing independent of map and loot RNG.
      const pattern = (Math.imul(x + 17, 73856093) ^ Math.imul(y + 31, 19349663)) >>> 0;
      floorRow.push(!blocked(x, y) && pattern % 13 === 0 ? GRIT : STONE);
      wallRow.push(blocked(x, y) ? MASONRY : -1);
    }
    floor.push(floorRow);
    stone.push(wallRow);
  }

  const layer = (data: number[][], depth: number, tint: number): void => {
    const map = scene.make.tilemap({ data, tileWidth: TILE, tileHeight: TILE });
    const atlas = map.addTilesetImage("atlas");
    if (!atlas) {
      map.destroy();
      return;
    }
    const tiles = map.createLayer(0, atlas, 0, 0);
    if (!tiles) {
      map.destroy();
      return;
    }
    tiles.setDepth(depth);
    tiles.forEachTile((tile) => {
      tile.tint = tint;
    });
  };
  layer(floor, DEPTH.ground, 0x5e5960);
  layer(stone, DEPTH.entityBase, 0x8d8290);

  // Faces stay inside solid cells; shallow cast shadows sit below ladders/ore.
  // Shared wall edges receive neither a seam nor a second shadow.
  const shadow = scene.add.graphics().setDepth(DEPTH.ground + 0.5);
  const edge = scene.add.graphics().setDepth(DEPTH.entityBase + 0.1);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!blocked(x, y)) continue;
      const px = x * TILE;
      const py = y * TILE;
      if (!blocked(x, y - 1)) edge.fillStyle(0x50566c).fillRect(px, py, TILE, 1);
      if (!blocked(x - 1, y)) edge.fillStyle(0x41485e).fillRect(px, py, 1, TILE);
      if (!blocked(x + 1, y)) {
        edge.fillStyle(0x151923).fillRect(px + TILE - 1, py, 1, TILE);
        shadow.fillStyle(0x0c101a, 0.3).fillRect(px + TILE, py + 2, 2, TILE - 2);
      }
      if (!blocked(x, y + 1)) {
        edge.fillStyle(0x202534).fillRect(px, py + TILE - 5, TILE, 5);
        edge.fillStyle(0x454d64).fillRect(px, py + TILE - 5, TILE, 1);
        edge.fillStyle(0x111520).fillRect(px, py + TILE - 1, TILE, 1);
        shadow.fillStyle(0x0c101a, 0.4).fillRect(px, py + TILE, TILE, 3);
      }
    }
  }
}
