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
// Every one of those is a flat roof with a parapet — the gabled kit house was
// the single loudest tell against SF, and it never appears here.

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
export function storeysOf(realHeight: number): number {
  return Math.max(1, Math.min(120, Math.round(realHeight / REAL_STOREY)));
}

/**
 * Visual height for a storey count. The city is at real scale in plan (the
 * streets are OSM) but the car is a ~2.75u kart, so a real-scale two-storey
 * house is a doll's house next to it. Low buildings are exaggerated ~2.4x —
 * a two-storey row house stands 3.5u, a three-storey Victorian 5u — and the
 * factor decays toward 1.3x with height so a tower stays in proportion to the
 * landmarks, which are drawn at true scale. Continuous in the storey count, so
 * a block of 5- and 6-storey neighbours never steps.
 */
export function visualHeight(storeys: number): number {
  const k = 1.3 + 1.2 * Math.exp(-(storeys - 1) / 8);
  return storeys * REAL_STOREY * k;
}

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

export type StyleInput = {
  readonly character: FabricChar;
  readonly district: string;
  readonly storeys: number;
  /** Plan area, u². */
  readonly area: number;
  /** Length of the street-facing edge, u (0 when the parcel has none). */
  readonly frontage: number;
  /** Deterministic per-parcel hash, uniform in [0, 1). */
  readonly roll: number;
};

export function resolveKind(s: StyleInput): ParcelKind {
  if (s.storeys <= 1 && (s.area < 9 || s.frontage < 1.6)) return "shed";
  if (s.storeys >= 8) return "tower";
  switch (s.character) {
    case "industrial":
      return s.storeys <= 3 ? "warehouse" : "midrise";
    case "wharf":
      return s.storeys <= 2 && s.area > 30 ? "warehouse" : "midrise";
    case "highrise":
    case "downtown":
      return s.storeys >= 6 && s.frontage > 10 ? "tower" : "midrise";
    case "commercial":
      return s.storeys <= 1 && s.area < 25 ? "shed" : "midrise";
    case "victorian":
      // A Victorian street has its corner store / flats-over-shops.
      return s.storeys >= 4 && s.frontage > 9 ? "midrise" : s.roll < 0.12 ? "stucco" : "rowhouse";
    case "residential":
      if (s.storeys >= 5 && s.frontage > 9) return "midrise";
      if (STUCCO_DISTRICTS.has(s.district)) return s.roll < 0.15 ? "rowhouse" : "stucco";
      return s.roll < 0.4 ? "stucco" : "rowhouse";
  }
}

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
  // Stone: warm limestone to cool grey, one pale brick.
  downtown: [0xcfc4ad, 0xbcc0c4, 0xd9cbab, 0xb8846a, 0xa6b0ba, 0xe0d6c2],
  // Glass and steel: a ramp of blues, one stone.
  highrise: [0x7f9fc0, 0x6e8db0, 0x9ab6cc, 0x5f7c9a, 0xbfc5cb, 0x8aa8bf],
  // Ochre to rust, sage accent.
  commercial: [0xdcb26a, 0xc4703f, 0xa64e3c, 0xe7d3a8, 0x8fae9e, 0xd8935c],
  // Salt-bleached boards, one signal red.
  wharf: [0xd6cfbf, 0xa8a293, 0x8ea0ab, 0xb5384a, 0xe8ece9, 0x6f8391],
  // The avenues' stucco: cream through peach, mint, sky, butter, lavender.
  residential: [0xf0dcc0, 0xe8b48e, 0x9fcfb7, 0x8fbfd6, 0xf1d478, 0xc8b2df, 0xe89a88, 0xf3efe6],
  // Painted ladies: teal, plum, ochre, brick, sage, cornflower, cream, rose.
  victorian: [0x3f8f8a, 0x7f4a6e, 0xd9a441, 0xb84a3c, 0x8fae7e, 0x6c8fc4, 0xf1e3c8, 0xd98a9a],
  // Oxide to slate.
  industrial: [0xa8623e, 0x8a6a4c, 0xb08968, 0x6f7c84, 0x9a8f7c, 0xc2a37c],
} satisfies Record<FabricChar, readonly number[]>;

/** Flat-roof membrane per character: mid-value, one family per district. */
export const ROOF_PALETTES = {
  highrise: [0x8e969c, 0x7f888e, 0x9aa2a8, 0x74807c],
  downtown: [0x9a9386, 0x8b8478, 0xa69f92, 0x7e786e],
  commercial: [0x9d9080, 0x8c7f70, 0xa89a88, 0x77857a],
  industrial: [0x7f858a, 0x71777c, 0x8d9398],
  wharf: [0x968f84, 0x847e74, 0xa39c90],
  residential: [0xb2aba0, 0xa39c92, 0xbdb6ab],
  victorian: [0xaba49a, 0x9d968c, 0xb6afa5],
} satisfies Record<FabricChar, readonly number[]>;

/** The odd coloured roof that keeps a field of membrane from tiling: terracotta, copper green, red. */
const ROOF_ACCENTS: readonly number[] = [0xb5654a, 0x6f9a86, 0xa8433a];

/** Awning / storefront accent: saturated, few, so a shopping street reads as a row of signs. */
export const AWNING_COLORS: readonly number[] = [
  0xc8433a, 0x2f7d5b, 0x2c5f9e, 0xd9962b, 0x7a4e8c, 0x1f7f86, 0xb8332e, 0x3a8a3f,
];

export type ParcelColors = {
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
};

function channel(c: number, shift: number): number {
  return (c >> shift) & 0xff;
}
const clampByte = (v: number): number => Math.max(0, Math.min(255, Math.round(v)));
function rgb(r: number, g: number, b: number): number {
  return (clampByte(r) << 16) | (clampByte(g) << 8) | clampByte(b);
}
/** Scale a colour's value; 1 = unchanged. */
export function shade(c: number, k: number): number {
  return rgb(channel(c, 16) * k, channel(c, 8) * k, channel(c, 0) * k);
}
/** Lerp toward another colour. */
export function mix(a: number, b: number, t: number): number {
  return rgb(
    channel(a, 16) + (channel(b, 16) - channel(a, 16)) * t,
    channel(a, 8) + (channel(b, 8) - channel(a, 8)) * t,
    channel(a, 0) + (channel(b, 0) - channel(a, 0)) * t,
  );
}

const WHITE_TRIM = 0xf3efe6;
const GLASS_DAY = 0x34424f;
const GLASS_TOWER = 0x6d8ba3;
const GLASS_SHOP = 0x2a3644;

/** Perceived lightness 0..1. */
function luma(c: number): number {
  return (0.299 * channel(c, 16) + 0.587 * channel(c, 8) + 0.114 * channel(c, 0)) / 255;
}

/** White trim on a coloured body; on a body already near white, a darker step so the frames still read. */
function trimFor(body: number): number {
  return luma(body) > 0.86 ? shade(body, 0.74) : WHITE_TRIM;
}

export function colorsFor(
  kind: ParcelKind,
  character: FabricChar,
  blockHash: number,
  unitRoll: number,
): ParcelColors {
  const palette = FABRIC_PALETTES[character];
  const dominant = palette[blockHash % palette.length] ?? 0xcccccc;
  // A terrace steps through its family: half the units wear the block's
  // colour, the rest one of its neighbours in the ramp.
  const accent = palette[(blockHash + 1 + Math.floor(unitRoll * 7)) % palette.length] ?? dominant;
  const body = unitRoll < 0.5 ? dominant : accent;
  const roofs = ROOF_PALETTES[character];
  const roofRoll = (blockHash >> 7) % 100;
  const roof =
    roofRoll < 8 &&
    (character === "residential" || character === "victorian" || character === "commercial")
      ? (ROOF_ACCENTS[(blockHash >> 11) % ROOF_ACCENTS.length] ?? 0xb5654a)
      : (roofs[(blockHash >> 3) % roofs.length] ?? 0x9a9386);
  const awning =
    AWNING_COLORS[(blockHash + Math.floor(unitRoll * 5)) % AWNING_COLORS.length] ?? 0xc8433a;
  switch (kind) {
    case "rowhouse":
    case "stucco":
      return {
        body,
        trim: trimFor(body),
        base: shade(body, 0.72),
        roof,
        glass: GLASS_DAY,
        door: shade(mix(body, 0x3a2f2a, 0.7), 0.9),
        garage: mix(body, 0x8a8d90, 0.75),
        awning,
      };
    case "midrise":
      return {
        body,
        trim: luma(body) > 0.7 ? shade(body, 0.78) : shade(body, 1.22),
        base: shade(body, 0.7),
        roof,
        glass: GLASS_SHOP,
        door: 0x3a3532,
        garage: 0x6b6f73,
        awning,
      };
    case "tower": {
      const glassTower = character === "highrise" || unitRoll > 0.45;
      const tb = glassTower ? mix(GLASS_TOWER, body, 0.35) : body;
      return {
        body: tb,
        trim: glassTower ? shade(tb, 1.25) : shade(body, 0.82),
        base: shade(tb, 0.72),
        roof,
        glass: glassTower ? shade(GLASS_TOWER, 0.8) : GLASS_DAY,
        door: 0x2f3438,
        garage: 0x6b6f73,
        awning,
      };
    }
    case "warehouse":
      return {
        body,
        trim: shade(body, 0.8),
        base: shade(body, 0.7),
        roof,
        glass: 0x8fa3b2,
        door: 0x4a4f54,
        garage: mix(body, 0x5c6165, 0.8),
        awning,
      };
    case "shed":
      return {
        body: shade(body, 0.92),
        trim: shade(body, 0.8),
        base: shade(body, 0.7),
        roof,
        glass: GLASS_DAY,
        door: 0x4a4f54,
        garage: 0x6b6f73,
        awning,
      };
  }
}

/** Lit-window share at night per kind: towers with the cleaners in, dark terraces. */
export function litShare(kind: ParcelKind): number {
  switch (kind) {
    case "tower":
      return 0.38;
    case "midrise":
      return 0.3;
    case "rowhouse":
    case "stucco":
      return 0.22;
    case "warehouse":
      return 0.1;
    case "shed":
      return 0;
  }
}
