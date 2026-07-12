import * as THREE from "three";

import { GRID_X, GRID_Z, ROAD_TILE, WORLD_HALF_X, WORLD_HALF_Z } from "../shared/constants";
import type { SurfaceDeck } from "../shared/types";
import { makeDriveSurfaceOffset, parkCellFloor, parkCellHeight } from "./ground";
import type { RoadNetwork } from "./network";
import { districtAt } from "./sf-map";
import type { Terrain } from "./terrain";
import type { CityPlan } from "./grid";

// The DRIVE SURFACE: what the car (and traffic, fares, camera floor) stands
// on. Composed, in priority order, of
//   1. decks — flat pier decks and Z-sloped bridge ramps floating over water,
//   2. park terraces — the KayKit park tiles seat FLAT at each cell's highest
//      corner, up to ~0.85 above the raw field,
//   3. the terrain height field, plus the street-depression offset beside
//      kerbs (the rendered ground drops −0.35 there; without the offset the
//      car hovers on the invisible raw field).
// Extracted from the 2k-line City god object — this is a self-contained
// domain with a two-method surface (heightAt / normalInto).
export class DriveSurface {
  private decks: SurfaceDeck[] = [];
  private driveOffset: ((x: number, z: number) => number) | null = null;
  private driveOffsetNet: RoadNetwork | null = null;
  private terraces: Map<number, number> | null = null;

  constructor(
    private readonly terrain: Terrain,
    private readonly plan: CityPlan,
    // Live street edits swap the network; lazy caches rebuild on change.
    private readonly currentNetwork: () => RoadNetwork,
  ) {}

  addDecks(decks: readonly SurfaceDeck[]): void {
    for (const d of decks) this.decks.push(d);
  }

  getDecks(): readonly SurfaceDeck[] {
    return this.decks;
  }

  private deckHeight(d: SurfaceDeck, z: number): number {
    if (d.y2 === undefined || d.maxZ <= d.minZ) return d.y;
    const t = (z - d.minZ) / (d.maxZ - d.minZ);
    return d.y + (d.y2 - d.y) * t;
  }

  // Drive-surface offset (street depression past the sidewalk's outer edge),
  // built lazily from the CURRENT network and rebuilt if the network is
  // swapped (live street edits).
  private driveOffsetAt(x: number, z: number): number {
    const network = this.currentNetwork();
    if (this.driveOffset === null || this.driveOffsetNet !== network) {
      this.driveOffset = makeDriveSurfaceOffset(network, this.terrain);
      this.driveOffsetNet = network;
    }
    return this.driveOffset(x, z);
  }

  // Park KayKit tiles are FLAT TERRACES seated at the cell's highest corner.
  // Driving into a park (the path entrances invite it) on the raw field sinks
  // the car into the tile. One O(1) lookup: cell index → terrace height,
  // computed lazily with the same flat-cell test the furniture tile pass uses
  // (park DISTRICT, spread ≤ 0.8; cells hugging asphalt got no tile).
  private terracesNet: RoadNetwork | null = null;
  private terraceAt(x: number, z: number): number | undefined {
    const liveNetwork = this.currentNetwork();
    // Rebuild alongside driveOffset when the editor swaps the network — the
    // near-asphalt suppression below queries it.
    if (!this.terraces || this.terracesNet !== liveNetwork) {
      this.terraces = new Map();
      this.terracesNet = liveNetwork;
      const network = liveNetwork;
      for (let gx = 0; gx < GRID_X; gx++) {
        for (let gz = 0; gz < GRID_Z; gz++) {
          if (this.plan.cells[gx]?.[gz] !== "lot") continue;
          if (districtAt(gx, gz).character !== "park") continue;
          const seatY = parkCellHeight(this.terrain, gx, gz);
          if (seatY - 0.05 - parkCellFloor(this.terrain, gx, gz) > 0.8) continue;
          const wx = (gx + 0.5) * ROAD_TILE - WORLD_HALF_X;
          const wz = (gz + 0.5) * ROAD_TILE - WORLD_HALF_Z;
          const hit = network.nearest(wx, wz, 30);
          if (hit && hit.dist <= hit.edge.half + ROAD_TILE * 0.55) continue;
          this.terraces.set(gx * GRID_Z + gz, seatY);
        }
      }
    }
    const gx = Math.floor((x + WORLD_HALF_X) / ROAD_TILE);
    const gz = Math.floor((z + WORLD_HALF_Z) / ROAD_TILE);
    if (gx < 0 || gz < 0 || gx >= GRID_X || gz >= GRID_Z) return undefined;
    return this.terraces.get(gx * GRID_Z + gz);
  }

  // Height of the RENDERED drivable surface: raw field on and beside streets
  // (asphalt/curb/sidewalk band), street-depressed ground past the kerb,
  // deck height on piers and bridge spans, terrace height on park tiles.
  heightAt(x: number, z: number): number {
    const ground = this.terrain.heightAt(x, z) + this.driveOffsetAt(x, z);
    for (const d of this.decks) {
      if (x >= d.minX && x <= d.maxX && z >= d.minZ && z <= d.maxZ) {
        return Math.max(this.deckHeight(d, z), ground);
      }
    }
    const terrace = this.terraceAt(x, z);
    return terrace !== undefined ? Math.max(terrace, ground) : ground;
  }

  normalInto(out: THREE.Vector3, x: number, z: number): THREE.Vector3 {
    for (const d of this.decks) {
      if (x >= d.minX && x <= d.maxX && z >= d.minZ && z <= d.maxZ) {
        // Only take the deck normal where the deck actually IS the surface.
        if (this.deckHeight(d, z) >= this.terrain.heightAt(x, z) - 0.05) {
          if (d.y2 === undefined || d.maxZ <= d.minZ) return out.set(0, 1, 0);
          const slope = (d.y2 - d.y) / (d.maxZ - d.minZ);
          return out.set(0, 1, -slope).normalize();
        }
      }
    }
    const terrace = this.terraceAt(x, z);
    if (terrace !== undefined && terrace >= this.terrain.heightAt(x, z) - 0.05) {
      return out.set(0, 1, 0); // park tiles are dead flat
    }
    return this.terrain.normalInto(out, x, z);
  }
}
