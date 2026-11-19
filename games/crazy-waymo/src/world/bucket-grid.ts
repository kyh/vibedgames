import { ROAD_TILE, WORLD_H, WORLD_HALF_X, WORLD_HALF_Z, WORLD_W } from "../shared/constants";

const CELL = ROAD_TILE * 2;
const MARGIN = 32;

export class BucketGrid {
  readonly nx = Math.ceil((WORLD_W + MARGIN * 2) / CELL);
  readonly nz = Math.ceil((WORLD_H + MARGIN * 2) / CELL);
  readonly count = this.nx * this.nz;
  private readonly minX = -WORLD_HALF_X - MARGIN;
  private readonly minZ = -WORLD_HALF_Z - MARGIN;

  cellX(x: number) {
    return Math.min(this.nx - 1, Math.max(0, Math.floor((x - this.minX) / CELL)));
  }
  cellZ(z: number) {
    return Math.min(this.nz - 1, Math.max(0, Math.floor((z - this.minZ) / CELL)));
  }
  bucketAt(x: number, z: number) {
    return this.cellX(x) * this.nz + this.cellZ(z);
  }
}
