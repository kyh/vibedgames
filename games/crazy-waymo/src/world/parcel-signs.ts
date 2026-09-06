/** Fictional storefront names. Atlas order is stable and shared by mesh and material. */
export const SHOP_SIGNS: readonly string[] = [
  "SUNSET MARKET",
  "FOGLINE BAKERY",
  "RICHMOND HARDWARE",
  "AVENUE FLOWERS",
  "NORTH BEACH DELI",
  "BAY BOOKS",
  "JADE TEA HOUSE",
  "GOLDEN WOK",
  "HAIGHT RECORDS",
  "HILLTOP GROCER",
  "MISSION PANADERIA",
  "CORNER CAFE",
  "DOCKSIDE COFFEE",
  "FOUNDRY GOODS",
  "BAY CYCLE WORKS",
  "MARKET FLORIST",
];

export const SIGN_ATLAS_WIDTH = 512;
export const SIGN_ATLAS_HEIGHT = 128;
export const SIGN_COLUMNS = 4;
export const SIGN_ROWS = 4;
/** UV crop around the lettering, excluding transparent cell gutters. */
export const SIGN_CROP_START = 0.2;
export const SIGN_CROP_END = 0.8;
export const SIGN_LABEL_ASPECT =
  SIGN_ATLAS_WIDTH /
  SIGN_COLUMNS /
  ((SIGN_ATLAS_HEIGHT / SIGN_ROWS) * (SIGN_CROP_END - SIGN_CROP_START));
/** RGBA8 plus complete mip chain. Accounted alongside geometry in the harness. */
export const SIGN_ATLAS_BYTES = (SIGN_ATLAS_WIDTH * SIGN_ATLAS_HEIGHT * 4 * 4) / 3;

/** District vocabulary, varied per shop without implying real business locations. */
export function shopSignIndex(district: string, seed: number, unit: number): number {
  const variant = ((seed >>> 6) + unit) % 2;
  switch (district) {
    case "the Sunset":
      return variant;
    case "the Richmond":
      return 2 + variant;
    case "North Beach":
    case "Russian Hill":
      return 4 + variant;
    case "Chinatown":
      return 6 + variant;
    case "the Haight":
    case "Hayes Valley":
    case "Alamo Square":
      return 8 + variant;
    case "the Mission":
    case "the Outer Mission":
      return 10 + variant;
    case "SoMa":
    case "Dogpatch":
    case "the Embarcadero":
      return 12 + variant;
    default:
      return 14 + variant;
  }
}
