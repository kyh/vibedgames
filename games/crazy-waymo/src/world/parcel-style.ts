import type { ParcelHint } from "./parcel-source";
import type { DistrictChar } from "./sf-map";

// The building VOCABULARY of the procedural parcel fabric — what a parcel of a
// given height in a given district IS, and the colours it wears. Pure data +
// arithmetic, shared by the plan (parcel-plan.ts), the mesh generator
// (parcel-mesh.ts) and the harness, so a style decision is made in exactly
// one place.
//
// The look is a kart racer's San Francisco, not a survey: chunky flat-roofed
// row houses with stacked bays and a white cornice, stucco boxes over a garage
// on the avenues, storefront-and-awning mid-rises on the commercial streets,
// punched-masonry and glass towers downtown, roll-up-door sheds in the yards.
// Residential roofs remain flat behind ornamental parapets and pediments;
// industrial northlights and stepped tower crowns provide their own silhouettes.
// The generic gabled kit house never appears here.

export type FabricChar = Exclude<DistrictChar, "park">;

export type ParcelKind =
  /** A utility box: garage, shed, kiosk. One door, no windows. */
  | "shed"
  /** Victorian / Edwardian terrace: stacked bay windows, double cornice, garage + stoop. */
  | "rowhouse"
  /** The Sunset / Richmond / Marina stucco box: wide window band over a garage. */
  | "stucco"
  /** Storefront + awning at the street, punched window grid above, roof plant. */
  | "midrise"
  /** Podium + shaft, window strips per storey, mechanical crown. */
  | "tower"
  /** Roll-up doors, clerestory band, vents on the roof. */
  | "warehouse";

/** World units per real storey (3.3 m at 4.46 m/u). */
const REAL_STOREY = 0.74;

/**
 * Real storey count of a parcel from its measured height. The source model's
 * heights are to the roof; a 1.8u median parcel is the two-storey house it is.
 */
export const storeysOf = (realHeight: number): number =>
  Math.max(1, Math.min(120, Math.round(realHeight / REAL_STOREY)));

/**
 * Visual height for a storey count. The city is at real scale in plan (the
 * streets are OSM) but the car is a ~2.75u kart, so a real-scale two-storey
 * house is a doll's house next to it. Low buildings are exaggerated ~2.4x —
 * a two-storey row house stands 3.5u, a three-storey Victorian 5u — and the
 * factor decays toward 1.3x with height so a tower stays in proportion to the
 * landmarks, which are drawn at true scale. Continuous in the storey count, so
 * a block of 5- and 6-storey neighbours never steps.
 */
export const visualHeight = (storeys: number): number => {
  const k = 1.3 + 1.2 * Math.exp(-(storeys - 1) / 8);
  return storeys * REAL_STOREY * k;
};

/** Ground floor never drops below this: the garage door has to clear the car. */
export const GROUND_MIN = 1.6;

/** Districts whose residential fabric is the stucco box rather than the Victorian terrace. */
const STUCCO_DISTRICTS: ReadonlySet<string> = new Set([
  "the Sunset",
  "the Richmond",
  "the Marina",
  "the Outer Mission",
  "the Excelsior",
  "Ingleside",
  "Sunnyside",
  "Lakeshore",
  "West Portal",
  "Miraloma Park",
  "Crocker-Amazon",
  "Visitacion Valley",
  "Daly City",
  "Bayview",
  "Silver Terrace",
  "the Portola",
  "Mission Bay",
]);

export interface StyleInput {
  readonly character: FabricChar;
  readonly district: string;
  /** What the map says the building is; "generic" for the survey. */
  readonly hint: ParcelHint;
  readonly storeys: number;
  /** Plan area, u². */
  readonly area: number;
  /** Length of the street-facing edge, u (0 when the parcel has none). */
  readonly frontage: number;
  /** Deterministic per-parcel hash, uniform in [0, 1). */
  readonly roll: number;
}

/** What the map's own word for a building says about its height; undefined when it says nothing. */
const hintStoreys = (character: FabricChar, hint: ParcelHint, roll: number): number | undefined => {
  switch (hint) {
    case "shed": {
      return 1;
    }
    case "apartments": {
      return 3 + (roll < 35 ? 1 : 0) + (roll < 8 ? 1 : 0);
    }
    case "industrial": {
      return roll < 70 ? 1 : 2;
    }
    case "public": {
      return 2 + (roll < 40 ? 1 : 0);
    }
    case "house": {
      const tall = character === "victorian" ? 55 : 25;
      return roll < tall ? 3 : 2;
    }
    case "commercial":
    case "generic": {
      return undefined;
    }
    default: {
      return hint satisfies never;
    }
  }
};

/** Storeys the district builds when neither the survey nor the map's hint says. */
const characterStoreys = (character: FabricChar, roll: number): number => {
  switch (character) {
    case "highrise": {
      if (roll < 50) {
        return 6;
      }
      return roll < 85 ? 9 : 14;
    }
    case "downtown": {
      if (roll < 55) {
        return 4;
      }
      return roll < 90 ? 6 : 9;
    }
    case "commercial": {
      if (roll < 60) {
        return 2;
      }
      return roll < 92 ? 3 : 4;
    }
    case "industrial": {
      return roll < 75 ? 1 : 2;
    }
    case "wharf": {
      return roll < 70 ? 1 : 2;
    }
    case "victorian": {
      return roll < 55 ? 3 : 2;
    }
    case "residential": {
      return roll < 25 ? 3 : 2;
    }
    default: {
      return character satisfies never;
    }
  }
};

/**
 * Storeys for a footprint the map gives no height for: what the district
 * builds, nudged by the map's own word for it and one parcel's worth of
 * variety. Real SF is two and three storeys almost everywhere outside the
 * downtown core, and a citywide default of anything taller reads as Houston.
 */
export const fallbackStoreys = (character: FabricChar, hint: ParcelHint, seed: number): number => {
  const roll = Math.floor(seed / 256) % 100;
  return hintStoreys(character, hint, roll) ?? characterStoreys(character, roll);
};

/** The terrace or the stucco box, per district and one parcel's worth of variety. */
const houseKind = (s: StyleInput): ParcelKind => {
  if (s.character === "victorian") {
    return s.roll < 0.12 ? "stucco" : "rowhouse";
  }
  if (STUCCO_DISTRICTS.has(s.district)) {
    return s.roll < 0.15 ? "rowhouse" : "stucco";
  }
  return s.roll < 0.4 ? "stucco" : "rowhouse";
};

/** The kind the district's fabric builds at this size, once the map's hint has had its say. */
const characterKind = (s: StyleInput): ParcelKind => {
  switch (s.character) {
    case "industrial": {
      return s.storeys <= 3 ? "warehouse" : "midrise";
    }
    case "wharf": {
      return s.storeys <= 2 && s.area > 30 ? "warehouse" : "midrise";
    }
    case "highrise":
    case "downtown": {
      return s.storeys >= 6 && s.frontage > 10 ? "tower" : "midrise";
    }
    case "commercial": {
      return s.storeys <= 1 && s.area < 25 ? "shed" : "midrise";
    }
    case "victorian": {
      // A Victorian street has its corner store / flats-over-shops.
      return s.storeys >= 4 && s.frontage > 9 ? "midrise" : houseKind(s);
    }
    case "residential": {
      return s.storeys >= 5 && s.frontage > 9 ? "midrise" : houseKind(s);
    }
    default: {
      return s.character satisfies never;
    }
  }
};

export const resolveKind = (s: StyleInput): ParcelKind => {
  if (s.hint === "shed") {
    return "shed";
  }
  if (s.storeys <= 1 && (s.area < 9 || s.frontage < 1.6)) {
    return "shed";
  }
  if (s.storeys >= 8) {
    return "tower";
  }
  if (s.hint === "industrial") {
    return s.storeys <= 3 ? "warehouse" : "midrise";
  }
  if (s.hint === "commercial" || s.hint === "public" || s.hint === "apartments") {
    return "midrise";
  }
  return characterKind(s);
};

// --- Colour -----------------------------------------------------------------
// One dominant body colour per BLOCK (keyed by the same block hash the kit
// fabric used), the terrace neighbours stepping through the same family,
// white trim on the residential styles, a value-step trim on the masonry
// ones. Roofs are mid-value membrane, never black and never white: the
// aerials read the roof plane before anything else, and a white roof over a
// white parapet turned every block into a sugar cube.
//
// These are FLAT ALBEDOS, not the kit tints in sf-map.ts: those multiply a
// near-white atlas and had to sit close to white to leave the model any
// shading, which is why they could never read as a painted city. A vertex
// colour IS the paint, so the families here are the kart-racer's: one
// dominant hue per district, a value ramp through it, one accent.

/** Body paint per character — a value ramp through one family plus an accent. */
export const FABRIC_PALETTES = {
  // Ochre to rust, sage accent.
  commercial: [0xdc_b2_6a, 0xc4_70_3f, 0xa6_4e_3c, 0xe7_d3_a8, 0x8f_ae_9e, 0xd8_93_5c],
  // Stone: warm limestone to cool grey, one pale brick.
  downtown: [0xcf_c4_ad, 0xbc_c0_c4, 0xd9_cb_ab, 0xb8_84_6a, 0xa6_b0_ba, 0xe0_d6_c2],
  // Glass and steel: a ramp of blues, one stone.
  highrise: [0x7f_9f_c0, 0x6e_8d_b0, 0x9a_b6_cc, 0x5f_7c_9a, 0xbf_c5_cb, 0x8a_a8_bf],
  // Oxide to slate.
  industrial: [0xa8_62_3e, 0x8a_6a_4c, 0xb0_89_68, 0x6f_7c_84, 0x9a_8f_7c, 0xc2_a3_7c],
  // The avenues' stucco: cream through peach, mint, sky, butter, lavender.
  residential: [
    0xf0_dc_c0, 0xe8_b4_8e, 0x9f_cf_b7, 0x8f_bf_d6, 0xf1_d4_78, 0xc8_b2_df, 0xe8_9a_88, 0xf3_ef_e6,
  ],
  // Painted ladies: teal, plum, ochre, brick, sage, cornflower, cream, rose.
  victorian: [
    0x3f_8f_8a, 0x7f_4a_6e, 0xd9_a4_41, 0xb8_4a_3c, 0x8f_ae_7e, 0x6c_8f_c4, 0xf1_e3_c8, 0xd9_8a_9a,
  ],
  // Salt-bleached boards, one signal red.
  wharf: [0xd6_cf_bf, 0xa8_a2_93, 0x8e_a0_ab, 0xb5_38_4a, 0xe8_ec_e9, 0x6f_83_91],
} satisfies Record<FabricChar, readonly number[]>;

/** Local paint traditions sit over the building type, not over its source dataset. */
const districtPalette = (character: FabricChar, district: string): readonly number[] => {
  switch (district) {
    case "Chinatown": {
      return [0xe6_d2_b0, 0xc4_b6_92, 0xb7_6d_51, 0xdb_ce_b7, 0xa4_b7_a2, 0xe7_ba_75];
    }
    case "North Beach":
    case "Russian Hill": {
      return [0xe8_d8_b7, 0xd1_ae_78, 0xb7_c5_ae, 0xe8_c5_a4, 0xbc_82_64, 0xe8_e3_cc];
    }
    case "the Richmond": {
      return [0xe6_d6_bf, 0xc6_d3_bf, 0xd5_c7_bd, 0xac_bf_cb, 0xe8_d8_a4, 0xc0_b7_c7];
    }
    case "SoMa":
    case "Dogpatch":
    case "Jackson Square": {
      return character === "highrise"
        ? FABRIC_PALETTES.highrise
        : [0xb7_7b_5f, 0xa8_62_49, 0xcb_99_75, 0xd9_c6_a7, 0x8f_92_94, 0xb2_9b_80];
    }
    default: {
      return FABRIC_PALETTES[character];
    }
  }
};

/** Historic masonry districts keep their iron escape stairs above the shops. */
export const hasFireEscape = (district: string, seed: number): boolean => {
  switch (district) {
    case "Chinatown":
    case "North Beach":
    case "the Tenderloin":
    case "Union Square":
    case "Nob Hill": {
      return seed % 3 !== 0;
    }
    default: {
      return false;
    }
  }
};

/** Flat-roof membrane per character: mid-value, one family per district. */
export const ROOF_PALETTES = {
  commercial: [0x9d_90_80, 0x8c_7f_70, 0xa8_9a_88, 0x77_85_7a],
  downtown: [0x9a_93_86, 0x8b_84_78, 0xa6_9f_92, 0x7e_78_6e],
  highrise: [0x8e_96_9c, 0x7f_88_8e, 0x9a_a2_a8, 0x74_80_7c],
  industrial: [0x7f_85_8a, 0x71_77_7c, 0x8d_93_98],
  residential: [0xb2_ab_a0, 0xa3_9c_92, 0xbd_b6_ab],
  victorian: [0xab_a4_9a, 0x9d_96_8c, 0xb6_af_a5],
  wharf: [0x96_8f_84, 0x84_7e_74, 0xa3_9c_90],
} satisfies Record<FabricChar, readonly number[]>;

/** The odd coloured roof that keeps a field of membrane from tiling: terracotta, copper green, red. */
const ROOF_ACCENTS: readonly number[] = [0xb5_65_4a, 0x6f_9a_86, 0xa8_43_3a];

/** Awning / storefront accent: saturated, few, so a shopping street reads as a row of signs. */
export const AWNING_COLORS: readonly number[] = [
  0xc8_43_3a, 0x2f_7d_5b, 0x2c_5f_9e, 0xd9_96_2b, 0x7a_4e_8c, 0x1f_7f_86, 0xb8_33_2e, 0x3a_8a_3f,
];

export interface ParcelColors {
  readonly body: number;
  /** Cornice, window frames, bay edges. */
  readonly trim: number;
  /** Foundation band below the seat, the party-wall faces. */
  readonly base: number;
  readonly roof: number;
  readonly glass: number;
  readonly door: number;
  readonly garage: number;
  readonly awning: number;
}

const channel = (c: number, shift: number): number => Math.floor(c / 2 ** shift) % 256;
const clampByte = (v: number): number => Math.max(0, Math.min(255, Math.round(v)));
const rgb = (r: number, g: number, b: number): number =>
  clampByte(r) * 0x1_00_00 + clampByte(g) * 0x1_00 + clampByte(b);
/**
 * A lane of the block hash for one pick. The hash is a uint32 and this is the
 * SIGNED shift, so lanes with the high bit set go negative and the pick falls
 * through to the palette's fallback colour; Math.floor would recolour half the
 * city's blocks.
 */
// oxlint-disable-next-line no-bitwise -- signed shift of a uint32 hash is part of the observable pick (see above)
const hashLane = (blockHash: number, shift: number): number => blockHash >> shift;
/** Scale a colour's value; 1 = unchanged. */
export const shade = (c: number, k: number): number =>
  rgb(channel(c, 16) * k, channel(c, 8) * k, channel(c, 0) * k);
/** Lerp toward another colour. */
export const mix = (a: number, b: number, t: number): number =>
  rgb(
    channel(a, 16) + (channel(b, 16) - channel(a, 16)) * t,
    channel(a, 8) + (channel(b, 8) - channel(a, 8)) * t,
    channel(a, 0) + (channel(b, 0) - channel(a, 0)) * t,
  );

const WHITE_TRIM = 0xf3_ef_e6;
const CREAM_TRIM = 0xf1_e3_c8;
const GLASS_DAY = 0x34_42_4f;
// Matte and a step darker than any tower body (parcel-build.ts glass is
// roughness 0.78, metalness 0): the strips read as a darker band on the
// shaft, the kart-racer read, instead of a lighter one catching the sky.
const GLASS_TOWER = 0x45_58_6a;
const GLASS_SHOP = 0x2a_36_44;

/** Different construction eras keep the downtown skyline from repeating one curtain wall. */
export type TowerFacade = "curtain" | "ribbon" | "masonry";
export const towerFacadeFor = (blockHash: number): TowerFacade => {
  const era = Math.floor(blockHash / 16) % 3;
  if (era === 0) {
    return "curtain";
  }
  return era === 1 ? "ribbon" : "masonry";
};
/**
 * Trim per district, chosen per BLOCK: SF trim is not always white. The
 * painted ladies wear dark green, near-black or cream against the body as
 * often as white; the avenues' stucco takes cream; everything else takes a
 * value step off its own body.
 */
const VICTORIAN_TRIMS: readonly number[] = [
  WHITE_TRIM,
  WHITE_TRIM,
  0x2f_3a_36,
  0x2b_2b_2b,
  CREAM_TRIM,
];
const STUCCO_TRIMS: readonly number[] = [WHITE_TRIM, CREAM_TRIM, WHITE_TRIM];

/** Perceived lightness 0..1. */
const luma = (c: number): number =>
  (0.299 * channel(c, 16) + 0.587 * channel(c, 8) + 0.114 * channel(c, 0)) / 255;

/** The block's trim, unless the body is so pale the trim would vanish on it. */
const trimFor = (body: number, character: FabricChar, blockHash: number): number => {
  const trims = character === "victorian" ? VICTORIAN_TRIMS : STUCCO_TRIMS;
  const pick = trims[hashLane(blockHash, 9) % trims.length];
  const trim = pick ?? WHITE_TRIM;
  return Math.abs(luma(body) - luma(trim)) < 0.14 ? shade(body, 0.74) : trim;
};

/** Flat-roof membrane, or the odd accent roof on the low residential and shopping fabric. */
const roofFor = (character: FabricChar, blockHash: number): number => {
  const roofs = ROOF_PALETTES[character];
  const roofRoll = hashLane(blockHash, 7) % 100;
  if (
    roofRoll < 8 &&
    (character === "residential" || character === "victorian" || character === "commercial")
  ) {
    return ROOF_ACCENTS[hashLane(blockHash, 11) % ROOF_ACCENTS.length] ?? 0xb5_65_4a;
  }
  return roofs[hashLane(blockHash, 3) % roofs.length] ?? 0x9a_93_86;
};

// ONE accent per block for doors and awnings — a street reads as a set
// when its shops share a sign colour, and as a paint chart when they don't.
const awningFor = (district: string, blockHash: number): number => {
  if (district === "Chinatown") {
    return blockHash % 3 === 0 ? 0x28_65_5b : 0xb7_35_2b;
  }
  if (district === "North Beach") {
    return blockHash % 2 === 0 ? 0x39_73_59 : 0xb4_4b_39;
  }
  return AWNING_COLORS[hashLane(blockHash, 5) % AWNING_COLORS.length] ?? 0xc8_43_3a;
};

const towerBody = (facade: TowerFacade, body: number): number => {
  switch (facade) {
    case "masonry": {
      return mix(body, 0xd4_c4_a6, 0.7);
    }
    case "ribbon": {
      return mix(body, 0x7b_79_6f, 0.65);
    }
    case "curtain": {
      return mix(GLASS_TOWER, body, 0.35);
    }
    default: {
      return facade satisfies never;
    }
  }
};

const TOWER_GLASS: Readonly<Record<TowerFacade, number>> = {
  curtain: GLASS_TOWER,
  masonry: GLASS_DAY,
  ribbon: 0x39_4e_50,
};

export const colorsFor = (
  kind: ParcelKind,
  character: FabricChar,
  blockHash: number,
  unitRoll: number,
  district = "",
): ParcelColors => {
  const palette = districtPalette(character, district);
  const dominant = palette[blockHash % palette.length] ?? 0xcc_cc_cc;
  // A terrace steps through its family: half the units wear the block's
  // colour, the rest one of its neighbours in the ramp.
  const accent = palette[(blockHash + 1 + Math.floor(unitRoll * 7)) % palette.length] ?? dominant;
  const body = unitRoll < 0.5 ? dominant : accent;
  const roof = roofFor(character, blockHash);
  const awning = awningFor(district, blockHash);
  switch (kind) {
    case "rowhouse":
    case "stucco": {
      return {
        awning,
        base: shade(body, 0.72),
        body,
        // A painted front door in the block's accent — the Victorian's one
        // saturated note; the stucco box keeps a plain dark door.
        door: kind === "rowhouse" ? shade(awning, 0.85) : shade(mix(body, 0x3a_2f_2a, 0.7), 0.9),
        garage: mix(body, 0x8a_8d_90, 0.75),
        glass: GLASS_DAY,
        roof,
        trim: trimFor(body, character, blockHash),
      };
    }
    case "midrise": {
      return {
        awning,
        base: shade(body, 0.7),
        body,
        door: 0x3a_35_32,
        garage: 0x6b_6f_73,
        glass: GLASS_SHOP,
        roof,
        trim: luma(body) > 0.7 ? shade(body, 0.78) : shade(body, 1.22),
      };
    }
    case "tower": {
      const facade = towerFacadeFor(blockHash);
      const tb = towerBody(facade, body);
      return {
        awning,
        base: shade(tb, 0.72),
        body: tb,
        door: 0x2f_34_38,
        garage: 0x6b_6f_73,
        glass: TOWER_GLASS[facade],
        roof,
        trim: facade === "masonry" ? shade(tb, 0.83) : shade(tb, 1.18),
      };
    }
    case "warehouse": {
      return {
        awning,
        base: shade(body, 0.7),
        body,
        door: 0x4a_4f_54,
        garage: mix(body, 0x5c_61_65, 0.8),
        glass: 0x8f_a3_b2,
        roof,
        trim: shade(body, 0.8),
      };
    }
    case "shed": {
      return {
        awning,
        base: shade(body, 0.7),
        body: shade(body, 0.92),
        door: 0x4a_4f_54,
        garage: 0x6b_6f_73,
        glass: GLASS_DAY,
        roof,
        trim: shade(body, 0.8),
      };
    }
    default: {
      return kind satisfies never;
    }
  }
};

/** Lit-window share at night per kind: towers with the cleaners in, dark terraces. */
const LIT_SHARE: Readonly<Record<ParcelKind, number>> = {
  midrise: 0.3,
  rowhouse: 0.22,
  shed: 0,
  stucco: 0.22,
  tower: 0.38,
  warehouse: 0.1,
};
export const litShare = (kind: ParcelKind): number => LIT_SHARE[kind];
