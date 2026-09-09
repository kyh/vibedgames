import { ColliderDesc } from "@dimforge/rapier3d-compat";
import type { Solid } from "../shared/types";

const STATIC_HALF_HEIGHT = 6;

export interface StaticSolidBox {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly hx: number;
  readonly hy: number;
  readonly hz: number;
  readonly yaw: number;
}

/** Explicit wall spans follow the visible wall, including above-water decks.
 * Legacy solids retain their existing ground-anchored behavior. */
export const staticSolidBox = (
  solid: Solid,
  groundAt: (x: number, z: number) => number,
): StaticSolidBox => {
  const x = (solid.minX + solid.maxX) / 2;
  const z = (solid.minZ + solid.maxZ) / 2;
  const base = groundAt(x, z);
  let hy = STATIC_HALF_HEIGHT;
  if (solid.minY !== undefined) {
    hy = (solid.maxY - solid.minY) / 2;
  } else if (solid.maxY !== undefined) {
    hy = Math.min(STATIC_HALF_HEIGHT, Math.max(0.3, (solid.maxY - base) / 2));
  }
  if (!Number.isFinite(hy) || hy <= 0) {
    throw new Error("Invalid static wall height");
  }
  return {
    hx: Math.max(0.1, (solid.maxX - solid.minX) / 2),
    hy,
    hz: Math.max(0.1, (solid.maxZ - solid.minZ) / 2),
    x,
    y: solid.minY === undefined ? base + hy - 1 : solid.minY + hy,
    yaw: solid.yaw ?? 0,
    z,
  };
};

/** Shared by the streamed city and the real Rapier impact regression. */
export const staticSolidCollider = (box: StaticSolidBox): ColliderDesc =>
  ColliderDesc.cuboid(box.hx, box.hy, box.hz)
    .setFriction(0.6)
    .setTranslation(box.x, box.y, box.z)
    .setRotation({ w: Math.cos(box.yaw / 2), x: 0, y: Math.sin(box.yaw / 2), z: 0 });
