import type { SurfaceDeck } from "../shared/types";

export function surfaceDeckHeight(deck: SurfaceDeck, z: number): number {
  if (deck.y2 === undefined || deck.maxZ <= deck.minZ) return deck.y;
  const t = Math.max(0, Math.min(1, (z - deck.minZ) / (deck.maxZ - deck.minZ)));
  return deck.y + (deck.y2 - deck.y) * t;
}

/** First matching deck owns overlap, just as DriveSurface does. */
export function surfaceDeckAt(
  decks: readonly SurfaceDeck[],
  x: number,
  z: number,
  margin = 0,
): SurfaceDeck | undefined {
  return decks.find(
    (deck) =>
      x >= deck.minX - margin &&
      x <= deck.maxX + margin &&
      z >= deck.minZ - margin &&
      z <= deck.maxZ + margin,
  );
}

/** Exact planar support under pier/bridge wheels. Splitting on every rectangle
 * boundary preserves first-deck priority even where a ramp overlaps a span.
 * An actual collision floor prevents rail impacts ejecting a chassis through
 * the coarse heightfield's interpolated deck edge. */
export function surfaceDeckPhysics(decks: readonly SurfaceDeck[]): Float32Array {
  // ES2022 target; both arrays are new, privately owned boundary lists.
  // oxlint-disable-next-line unicorn/no-array-sort
  const xs = [...new Set(decks.flatMap((deck) => [deck.minX, deck.maxX]))].sort((a, b) => a - b);
  // oxlint-disable-next-line unicorn/no-array-sort
  const zs = [...new Set(decks.flatMap((deck) => [deck.minZ, deck.maxZ]))].sort((a, b) => a - b);
  const vertices: number[] = [];
  for (let ix = 0; ix + 1 < xs.length; ix++) {
    const ax = xs[ix],
      bx = xs[ix + 1];
    if (ax === undefined || bx === undefined) continue;
    for (let iz = 0; iz + 1 < zs.length; iz++) {
      const az = zs[iz],
        bz = zs[iz + 1];
      if (az === undefined || bz === undefined) continue;
      const deck = surfaceDeckAt(decks, (ax + bx) / 2, (az + bz) / 2);
      if (!deck) continue;
      const ay = surfaceDeckHeight(deck, az),
        by = surfaceDeckHeight(deck, bz);
      // Both triangles face up. Coplanar shared edges are exact, without a lip.
      vertices.push(ax, ay, az, ax, by, bz, bx, ay, az, bx, ay, az, ax, by, bz, bx, by, bz);
    }
  }
  return new Float32Array(vertices);
}
