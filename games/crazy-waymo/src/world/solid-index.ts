import type { Solid } from "./city";
import { SolidBuckets } from "./solid-buckets";

export { CeilingIndex, deckCeilings, harvestCeilingSpans } from "./ceiling-index";
export type { CeilingSpan } from "./ceiling-index";

// Uniform-grid spatial index over the static city solids. The city carries
// ~10k collision boxes (buildings, seawalls, railings, border walls); the car
// resolves against them every sub-step and the chase camera marches a clip
// ray through them every frame — a linear scan made both O(n). Bucketing by
// world cell (bucket-grid.ts, solid-buckets.ts) turns each lookup into a
// handful of nearby boxes.

/**
 * The index the game queries. The base set (map borders, seawalls, landmarks,
 * furniture — meta.bin) is there from load; the parcel walls arrive and leave
 * with their world tile (world-tiles.ts), each tile bucketed on its own, so a
 * tile swap never rebuilds the city-wide table.
 */
export class SolidIndex {
  private readonly base: SolidBuckets;
  private readonly tiles = new Map<number, SolidBuckets>();

  constructor(base: readonly Solid[]) {
    this.base = new SolidBuckets(base);
  }

  addTile(key: number, solids: readonly Solid[]): void {
    this.tiles.set(key, new SolidBuckets(solids));
  }

  removeTile(key: number): void {
    this.tiles.delete(key);
  }

  forEachIn(minX: number, maxX: number, minZ: number, maxZ: number, fn: (s: Solid) => void): void {
    this.base.forEachIn(minX, maxX, minZ, maxZ, fn);
    for (const t of this.tiles.values()) {
      t.forEachIn(minX, maxX, minZ, maxZ, fn);
    }
  }

  hitAt(x: number, z: number, y?: number): boolean {
    if (this.base.hitAt(x, z, y)) {
      return true;
    }
    for (const t of this.tiles.values()) {
      if (t.hitAt(x, z, y)) {
        return true;
      }
    }
    return false;
  }
}
