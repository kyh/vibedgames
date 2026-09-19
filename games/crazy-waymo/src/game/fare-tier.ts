import { STREET_SURFACE_MAX } from "../world/roads";

// Flat ground rings (fare beacons, garage pads) sit on terrain height but
// span street layers: they must clear the worst draped street surface, plus
// slack for terrain slope across the ring's radius.
// 0.4
export const GROUND_RING_LIFT = STREET_SURFACE_MAX + 0.13;

// Trip tiers: how far the customer wants to go — pay and beacon color follow.
export type FareTier = "short" | "medium" | "long";

const TIER_COLOR = {
  // red $$$
  long: 0xff_5d_5d,
  // amber $$
  medium: 0xff_b6_4d,
  // green $
  short: 0x6b_ff_8e,
} satisfies Record<FareTier, number>;
const TIER_PAY = { long: 1.5, medium: 1.2, short: 1 } satisfies Record<FareTier, number>;

export const tierColor = (t: FareTier): number => TIER_COLOR[t];
export const tierPayMult = (t: FareTier): number => TIER_PAY[t];
