import { ROAD_TILE, WORLD_H, WORLD_W } from "../shared/constants";

/** Stow's footprint, water plane and basin share one authored definition. */
export const GGP_LAKE = Object.freeze({
  u: 0.22,
  v: 0.4,
  ru: ROAD_TILE * 1.15,
  rv: ROAD_TILE * 0.75,
});
export const STOW_WATER_Y = 3.4;
export const STOW_WATER_SEGMENTS = 48;
const CENTER_X = (GGP_LAKE.u - 0.5) * WORLD_W;
const CENTER_Z = (GGP_LAKE.v - 0.5) * WORLD_H;

export function stowRadius(x: number, z: number): number {
  return Math.hypot((x - CENTER_X) / GGP_LAKE.ru, (z - CENTER_Z) / GGP_LAKE.rv);
}

/** Whole-footprint exclusion shared by rendered park tiles and their terraces. */
export function stowBasinOverlapsBox(
  minX: number,
  maxX: number,
  minZ: number,
  maxZ: number,
): boolean {
  const x = Math.max(minX, Math.min(CENTER_X, maxX));
  const z = Math.max(minZ, Math.min(CENTER_Z, maxZ));
  return stowRadius(x, z) < 1.3;
}

export function inLake(x: number, z: number): boolean {
  return stowRadius(x, z) < 1;
}

export function stowWaterHeightAt(x: number, z: number): number | null {
  return inLake(x, z) ? STOW_WATER_Y : null;
}

function smooth(value: number, from: number, to: number): number {
  const t = Math.max(0, Math.min(1, (value - from) / (to - from)));
  return t * t * (3 - 2 * t);
}

/** Applied before the terrain cache, so the lake bed and gentle launch bank
 * reach every ground, road and collider consumer without a second surface. */
export function stowBasinHeight(x: number, z: number, naturalHeight: number): number {
  const r = stowRadius(x, z);
  if (r >= 2) return naturalHeight;
  const basin = STOW_WATER_Y - 2.2 + 3.15 * smooth(r, 0.35, 1.18);
  const blend = smooth(r, 1.18, 2);
  return basin + (naturalHeight - basin) * blend;
}
