import { STREET_SURFACE_MAX } from "../world/roads";

export const GROUND_RING_LIFT = STREET_SURFACE_MAX + 0.13;

export type FareTier = "short" | "medium" | "long";

const TIER_COLOR = {
  long: 0xff_5d_5d,
  medium: 0xff_b6_4d,
  short: 0x6b_ff_8e,
} satisfies Record<FareTier, number>;

const TIER_PAY = { long: 1.5, medium: 1.2, short: 1 } satisfies Record<FareTier, number>;

export const tierColor = (t: FareTier) => TIER_COLOR[t];
export const tierPayMult = (t: FareTier) => TIER_PAY[t];
