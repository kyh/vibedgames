import RAPIER from "@dimforge/rapier3d-compat";
import type { Solid } from "../shared/types";

const STATIC_HALF_HEIGHT = 6;

export type StaticSolidBox = {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly hx: number;
  readonly hy: number;
  readonly hz: number;
  readonly yaw: number;
};

/** Explicit wall spans follow the visible wall, including above-water decks.
 * Legacy solids retain their existing ground-anchored behavior. */
export function staticSolidBox(
  solid: Solid,
  groundAt: (x: number, z: number) => number,
): StaticSolidBox {
  const x = (solid.minX + solid.maxX) / 2;
  const z = (solid.minZ + solid.maxZ) / 2;
  const base = groundAt(x, z);
  const hy =
    solid.minY !== undefined
      ? (solid.maxY - solid.minY) / 2
      : solid.maxY !== undefined
        ? Math.min(STATIC_HALF_HEIGHT, Math.max(0.3, (solid.maxY - base) / 2))
        : STATIC_HALF_HEIGHT;
  if (!Number.isFinite(hy) || hy <= 0) throw new Error("Invalid static wall height");
  return {
    x,
    z,
    y: solid.minY !== undefined ? solid.minY + hy : base + hy - 1,
    hx: Math.max(0.1, (solid.maxX - solid.minX) / 2),
    hz: Math.max(0.1, (solid.maxZ - solid.minZ) / 2),
    hy,
    yaw: solid.yaw ?? 0,
  };
}

/** Shared by the streamed city and the real Rapier impact regression. */
export function staticSolidCollider(box: StaticSolidBox): RAPIER.ColliderDesc {
  return RAPIER.ColliderDesc.cuboid(box.hx, box.hy, box.hz)
    .setFriction(0.6)
    .setTranslation(box.x, box.y, box.z)
    .setRotation({ x: 0, y: Math.sin(box.yaw / 2), z: 0, w: Math.cos(box.yaw / 2) });
}
