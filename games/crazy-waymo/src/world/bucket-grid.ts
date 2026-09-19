import { ROAD_TILE, WORLD_H, WORLD_HALF_X, WORLD_HALF_Z, WORLD_W } from "../shared/constants";

// ~4 buildings per bucket
const CELL = ROAD_TILE * 2;
// border walls and bridge decks poke past the map edge
const MARGIN = 32;

// The bucket arithmetic both indexes share. One copy so a query and the build
// that filled it can never disagree about which cell a coordinate lands in.
export class BucketGrid {
  readonly nx = Math.ceil((WORLD_W + MARGIN * 2) / CELL);
  readonly nz = Math.ceil((WORLD_H + MARGIN * 2) / CELL);
  readonly count = this.nx * this.nz;
  private readonly minX = -WORLD_HALF_X - MARGIN;
  private readonly minZ = -WORLD_HALF_Z - MARGIN;

  cellX(x: number): number {
    return Math.min(this.nx - 1, Math.max(0, Math.floor((x - this.minX) / CELL)));
  }
  cellZ(z: number): number {
    return Math.min(this.nz - 1, Math.max(0, Math.floor((z - this.minZ) / CELL)));
  }
  bucketAt(x: number, z: number): number {
    return this.cellX(x) * this.nz + this.cellZ(z);
  }
}
