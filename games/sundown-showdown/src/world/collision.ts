// Circle-versus-tile collision: pushes a brawler's centre out of any solid
// tile it overlaps, along the shortest axis when it is fully inside one.
import { GRID_HALF } from "./grid";

export interface Position {
  x: number;
  z: number;
}

/** Moves `pos` so a circle of `radius` no longer overlaps tile (tx, ty). */
export const pushOutOfTile = (pos: Position, radius: number, tx: number, ty: number): void => {
  const minX = tx - GRID_HALF;
  const minZ = ty - GRID_HALF;
  const nearestX = Math.max(minX, Math.min(minX + 1, pos.x));
  const nearestZ = Math.max(minZ, Math.min(minZ + 1, pos.z));
  const dx = pos.x - nearestX;
  const dz = pos.z - nearestZ;
  const distSq = dx * dx + dz * dz;
  if (distSq >= radius * radius) {
    return;
  }
  if (distSq > 1e-8) {
    const dist = Math.sqrt(distSq);
    pos.x = nearestX + (dx / dist) * radius;
    pos.z = nearestZ + (dz / dist) * radius;
    return;
  }
  // Centre is inside the tile: leave through the closest face.
  const toWest = pos.x - minX;
  const toEast = minX + 1 - pos.x;
  const toNorth = pos.z - minZ;
  const toSouth = minZ + 1 - pos.z;
  const nearest = Math.min(toWest, toEast, toNorth, toSouth);
  if (nearest === toWest) {
    pos.x = minX - radius;
  } else if (nearest === toEast) {
    pos.x = minX + 1 + radius;
  } else if (nearest === toNorth) {
    pos.z = minZ - radius;
  } else {
    pos.z = minZ + 1 + radius;
  }
};
