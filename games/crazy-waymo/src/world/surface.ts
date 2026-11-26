import type * as THREE from "three";

import { GRID_X, GRID_Z, ROAD_TILE, WORLD_HALF_X, WORLD_HALF_Z } from "../shared/constants";
import type { SurfaceDeck } from "../shared/types";
import { makeDriveSurfaceOffset, parkCellFloor, parkCellHeight } from "./ground";
import type { RoadNetwork } from "./network";
import { districtAt } from "./sf-map";
import type { Terrain } from "./terrain";
import type { CityPlan } from "./grid";
import { surfaceDeckHeight } from "./surface-decks";
import { stowBasinOverlapsBox } from "./lake";

export class DriveSurface {
  private readonly decks: SurfaceDeck[] = [];
  private driveOffset: ((x: number, z: number) => number) | null = null;
  private driveOffsetNet: RoadNetwork | null = null;
  private terraces: Map<number, number> | null = null;

  private readonly terrain: Terrain;
  private readonly plan: CityPlan;
  private readonly currentNetwork: () => RoadNetwork;

  constructor(terrain: Terrain, plan: CityPlan, currentNetwork: () => RoadNetwork) {
    this.terrain = terrain;
    this.plan = plan;
    this.currentNetwork = currentNetwork;
  }

  addDecks(decks: readonly SurfaceDeck[]) {
    for (const d of decks) {
      this.decks.push(d);
    }
  }

  getDecks() {
    return this.decks;
  }

  /** Classify the wheel's actual contact plane, including a bridge over sand
   * or water. Ground beneath an elevated deck must keep its own treatment. */
  isDeckContact(x: number, z: number, y: number) {
    return this.decks.some(
      (deck) =>
        x >= deck.minX &&
        x <= deck.maxX &&
        z >= deck.minZ &&
        z <= deck.maxZ &&
        Math.abs(y - surfaceDeckHeight(deck, z)) <= 0.4,
    );
  }

  private driveOffsetAt(x: number, z: number) {
    const network = this.currentNetwork();

    if (this.driveOffset === null || this.driveOffsetNet !== network) {
      this.driveOffset = makeDriveSurfaceOffset(network, this.terrain);
      this.driveOffsetNet = network;
    }

    return this.driveOffset(x, z);
  }

  private groundHeightAt(x: number, z: number) {
    return this.terrain.heightAt(x, z) + this.driveOffsetAt(x, z);
  }

  private terracesNet: RoadNetwork | null = null;
  private terraceAt(x: number, z: number) {
    const liveNetwork = this.currentNetwork();

    if (!this.terraces || this.terracesNet !== liveNetwork) {
      this.terraces = new Map();
      this.terracesNet = liveNetwork;
      const network = liveNetwork;

      for (let gx = 0; gx < GRID_X; gx += 1) {
        for (let gz = 0; gz < GRID_Z; gz += 1) {
          if (this.plan.cells[gx]?.[gz] !== "lot") {
            continue;
          }

          if (districtAt(gx, gz).character !== "park") {
            continue;
          }

          const seatY = parkCellHeight(this.terrain, gx, gz);

          if (seatY - 0.05 - parkCellFloor(this.terrain, gx, gz) > 0.8) {
            continue;
          }

          const wx = (gx + 0.5) * ROAD_TILE - WORLD_HALF_X;
          const wz = (gz + 0.5) * ROAD_TILE - WORLD_HALF_Z;

          if (
            stowBasinOverlapsBox(
              wx - ROAD_TILE / 2,
              wx + ROAD_TILE / 2,
              wz - ROAD_TILE / 2,
              wz + ROAD_TILE / 2,
            )
          ) {
            continue;
          }

          const hit = network.nearest(wx, wz, 30);

          if (hit && hit.dist <= hit.edge.half + ROAD_TILE * 0.55) {
            continue;
          }

          this.terraces.set(gx * GRID_Z + gz, seatY);
        }
      }
    }

    const gx = Math.floor((x + WORLD_HALF_X) / ROAD_TILE);
    const gz = Math.floor((z + WORLD_HALF_Z) / ROAD_TILE);

    if (gx < 0 || gz < 0 || gx >= GRID_X || gz >= GRID_Z) {
      return null;
    }

    return this.terraces.get(gx * GRID_Z + gz) ?? null;
  }

  heightAt(x: number, z: number) {
    const ground = this.groundHeightAt(x, z);

    for (const d of this.decks) {
      if (x >= d.minX && x <= d.maxX && z >= d.minZ && z <= d.maxZ) {
        return Math.max(surfaceDeckHeight(d, z), ground);
      }
    }

    const terrace = this.terraceAt(x, z);

    return terrace === null ? ground : Math.max(terrace, ground);
  }

  /** Camera floor: an elevated deck above the viewer belongs to the ceiling. */
  floorBelow(x: number, z: number, referenceY: number) {
    let floor = this.groundHeightAt(x, z);
    const terrace = this.terraceAt(x, z);

    if (terrace !== null) {
      floor = Math.max(floor, terrace);
    }

    for (const deck of this.decks) {
      if (x < deck.minX || x > deck.maxX || z < deck.minZ || z > deck.maxZ) {
        continue;
      }

      const y = surfaceDeckHeight(deck, z);

      if (y <= referenceY + 0.3) {
        floor = Math.max(floor, y);
      }
    }

    return floor;
  }

  normalInto(out: THREE.Vector3, x: number, z: number) {
    for (const d of this.decks) {
      const inside = x >= d.minX && x <= d.maxX && z >= d.minZ && z <= d.maxZ;

      if (inside && surfaceDeckHeight(d, z) >= this.groundHeightAt(x, z) - 0.05) {
        if (d.y2 === undefined || d.maxZ <= d.minZ) {
          return out.set(0, 1, 0);
        }

        const slope = (d.y2 - d.y) / (d.maxZ - d.minZ);

        return out.set(0, 1, -slope).normalize();
      }
    }

    const terrace = this.terraceAt(x, z);

    if (terrace !== null && terrace >= this.groundHeightAt(x, z) - 0.05) {
      return out.set(0, 1, 0);
    }

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
