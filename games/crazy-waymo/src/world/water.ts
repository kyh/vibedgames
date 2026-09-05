/** Shared fixed ocean plane; rendering and flotation use this exact level. */
export const SEA_Y = -0.5;

export type WaterSampler = {
  waterHeightAt(x: number, z: number): number | null;
};

/** Authored water surfaces publish their actual dimensions when built.
 * Local bodies are transformed alongside their mesh, never inferred from
 * shoreline walls or duplicated landmark positions. */
export type WaterBody = {
  readonly kind: "ellipse" | "rectangle";
  readonly x: number;
  readonly z: number;
  readonly y: number;
  readonly halfX: number;
  readonly halfZ: number;
  readonly yaw: number;
};

export function waterBodyContains(body: WaterBody, x: number, z: number): boolean {
  const dx = x - body.x,
    dz = z - body.z;
  const reach = body.halfX + body.halfZ;
  if (Math.abs(dx) > reach || Math.abs(dz) > reach) return false;
  const c = Math.cos(body.yaw),
    s = Math.sin(body.yaw);
  const lx = (dx * c - dz * s) / body.halfX;
  const lz = (dx * s + dz * c) / body.halfZ;
  return body.kind === "ellipse" ? lx * lx + lz * lz <= 1 : Math.abs(lx) <= 1 && Math.abs(lz) <= 1;
}

/** The visible authored pool replaces the ground inside its footprint.
 * Leave room below the hull and wheel rays; a painted water patch alone
 * leaves the taxi sitting on dry terrain instead of floating. */
export function waterBedHeight(
  bodies: readonly WaterBody[],
  x: number,
  z: number,
  ground: number,
): number {
  let height = ground;
  for (const body of bodies)
    if (waterBodyContains(body, x, z)) height = Math.min(height, body.y - 1.5);
  return height;
}
