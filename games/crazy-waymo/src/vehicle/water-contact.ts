export type FloatingWaterContact = {
  readonly kind: "floating";
  readonly waterY: number;
  readonly immersion: number;
  /** Magnitudes at entry, latched until the next dry interval. */
  readonly entrySpeed: number;
  readonly entryVerticalSpeed: number;
};

export type WaterContact = { readonly kind: "dry" } | FloatingWaterContact;
export const DRY_WATER_CONTACT = { kind: "dry" } satisfies WaterContact;
