import { walkFor } from "./roads";

// Facade to kerb: the sidewalk plus a stoop. Was a flat 2.4u regardless of
// street class, which left ~1.1u of bare ground past a minor street's 1.3u walk
// and pushed facade-to-facade to 11.2u (~50 m) against SF's ~25 m.
const FACADE_MARGIN = 0.45;

/**
 * Distance from a street's CENTRELINE to the front wall of its frontage row.
 * furniture.ts hangs awnings, murals, fire escapes and shutters on that plane
 * without being able to see the buildings, so this is the one definition of it —
 * import it there rather than restating the arithmetic (its `FRONT_PLANE = 2.4`
 * predates per-class sidewalks and now floats those props off every minor
 * street's wall).
 */
export const facadeOffset = (half: number): number => half + walkFor(half) + FACADE_MARGIN;

/**
 * Per SECTION, after stepping: a genuine cliff face, left green. Shared
 * because furniture.ts's `steepLot` has to skip lot dressing on exactly the
 * lots the building pass refuses to build — it was still using the OLD
 * pre-stepping delete threshold (5u), so every hillside lot the stepper now
 * builds stood with no fence, path or yard.
 */
export const STEEP_CLIFF = 6.5;
