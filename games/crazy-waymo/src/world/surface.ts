import * as THREE from "three";

import { GRID_X, GRID_Z, ROAD_TILE, WORLD_HALF_X, WORLD_HALF_Z } from "../shared/constants";
import type { SurfaceDeck } from "../shared/types";
import { makeDriveSurfaceOffset, parkCellFloor, parkCellHeight } from "./ground";
import type { RoadNetwork } from "./network";
import { districtAt } from "./sf-map";
import type { Terrain } from "./terrain";
import type { CityPlan } from "./grid";
import { surfaceDeckHeight } from "./surface-decks";
import { stowBasinOverlapsBox } from "./lake";

// The DRIVE SURFACE: what the car (and traffic, fares, camera floor) stands
// on. Composed, in priority order, of
//   1. decks — flat pier decks and Z-sloped bridge ramps floating over water,
//   2. park terraces — the KayKit park tiles seat FLAT at each cell's highest
//      corner, up to ~0.85 above the raw field,
//   3. the terrain height field, plus the street-depression offset beside
//      kerbs (the rendered ground drops −0.35 there; without the offset the
//      car hovers on the invisible raw field).
// Vehicle queries use heightAt / normalInto; the camera uses floorBelow to
// distinguish the road beneath it from an overhead deck.
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

  /** Classify the wheel's actual contact plane, including a bridge over sand
   * or water. Ground beneath an elevated deck must keep its own treatment. */
  isDeckContact(x: number, z: number, y: number): boolean {
    return this.decks.some(
      (deck) =>
        x >= deck.minX &&
        x <= deck.maxX &&
        z >= deck.minZ &&
        z <= deck.maxZ &&
        Math.abs(y - surfaceDeckHeight(deck, z)) <= 0.4,
    );
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

  private groundHeightAt(x: number, z: number): number {
    return this.terrain.heightAt(x, z) + this.driveOffsetAt(x, z);
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
          // Same whole-cell exclusion as furniture: no invisible terrace can
          // remain in the dry part of a tile omitted beside the lake basin.
          if (
            stowBasinOverlapsBox(
              wx - ROAD_TILE / 2,
              wx + ROAD_TILE / 2,
              wz - ROAD_TILE / 2,
              wz + ROAD_TILE / 2,
            )
          )
            continue;
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

  // Height of the RENDERED drivable surface: street terraces within pavement,
  // tessellated ground past the kerb,
  // deck height on piers and bridge spans, terrace height on park tiles.
  heightAt(x: number, z: number): number {
    const ground = this.groundHeightAt(x, z);
    for (const d of this.decks) {
      if (x >= d.minX && x <= d.maxX && z >= d.minZ && z <= d.maxZ) {
        return Math.max(surfaceDeckHeight(d, z), ground);
      }
    }
    const terrace = this.terraceAt(x, z);
    return terrace !== undefined ? Math.max(terrace, ground) : ground;
  }

  /** Camera floor: an elevated deck above the viewer belongs to the ceiling. */
  floorBelow(x: number, z: number, referenceY: number): number {
    let floor = this.groundHeightAt(x, z);
    const terrace = this.terraceAt(x, z);
    if (terrace !== undefined) floor = Math.max(floor, terrace);
    for (const deck of this.decks) {
      if (x < deck.minX || x > deck.maxX || z < deck.minZ || z > deck.maxZ) continue;
      const y = surfaceDeckHeight(deck, z);
      if (y <= referenceY + 0.3) floor = Math.max(floor, y);
    }
    return floor;
  }

  normalInto(out: THREE.Vector3, x: number, z: number): THREE.Vector3 {
    for (const d of this.decks) {
      if (x >= d.minX && x <= d.maxX && z >= d.minZ && z <= d.maxZ) {
        // Only take the deck normal where the deck actually IS the surface.
        if (surfaceDeckHeight(d, z) >= this.groundHeightAt(x, z) - 0.05) {
          if (d.y2 === undefined || d.maxZ <= d.minZ) return out.set(0, 1, 0);
          const slope = (d.y2 - d.y) / (d.maxZ - d.minZ);
          return out.set(0, 1, -slope).normalize();
        }
      }
    }
    const terrace = this.terraceAt(x, z);
    if (terrace !== undefined && terrace >= this.groundHeightAt(x, z) - 0.05) {
      return out.set(0, 1, 0); // park tiles are dead flat
    }
    // The rendered street terrace and exposed ground corrections both differ
    // from the raw terrain. Their height and slope must describe one surface
    // or traffic, camera banking and tyre FX tilt into a hill the car cleared.
    const eps = 1.6;
    return out
      .set(
        this.groundHeightAt(x - eps, z) - this.groundHeightAt(x + eps, z),
        2 * eps,
        this.groundHeightAt(x, z - eps) - this.groundHeightAt(x, z + eps),
      )
      .normalize();
  }
}
