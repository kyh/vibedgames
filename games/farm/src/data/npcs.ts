import type { Item } from "./items";

export type NpcId = "willow" | "finn" | "hazel";

export type GiftReaction = "love" | "like" | "neutral" | "dislike";

export interface NpcDef {
  id: NpcId;
  name: string;
  role: string;
  homeTile: { tx: number; ty: number };
  tint: number;
  greeting: string;
  lines: string[];
  react: (item: Item) => GiftReaction;
}

export type NpcTable = { [K in NpcId]: NpcDef };

// Gifts of an unlisted kind get a polite shrug.
const taste =
  (by: Partial<Record<Item["kind"], GiftReaction>>) =>
  (it: Item): GiftReaction =>
    by[it.kind] ?? "neutral";

const HAZEL_ORES: ReadonlySet<string> = new Set(["crystal", "copper", "coal"]);
const hazelTaste = taste({ fish: "like", forage: "dislike" });

export const NPCS: NpcTable = {
  finn: {
    greeting: "Ahoy! Fish biting today?",
    homeTile: { tx: 70, ty: 33 },
    id: "finn",
    lines: [
      "The big ones come out in the rain.",
      "Pufferfish in summer — tricky little things.",
      "Level up fishing and the reel gets way easier.",
      "Caught a Legend once. Nobody believes me.",
    ],
    name: "Finn",
    react: taste({ animal_product: "like", fish: "love", produce: "dislike" }),
    role: "the angler",
    tint: 0xcf_e2_ff,
  },
  hazel: {
    greeting: "Mind the skeletons down there.",
    homeTile: { tx: 47, ty: 42 },
    id: "hazel",
    lines: [
      "Deeper floors, better ore. And worse company.",
      "Crystals fetch a fine price at the store.",
      "Upgrade that combat skill before you go too deep.",
      "Coal keeps the forge going. Bring me some?",
    ],
    name: "Hazel",
    react: (it) => (it.kind === "resource" && HAZEL_ORES.has(it.res) ? "love" : hazelTaste(it)),
    role: "the miner",
    tint: 0xd9_d2_b0,
  },
  willow: {
    greeting: "Oh, hello neighbour!",
    homeTile: { tx: 13, ty: 14 },
    id: "willow",
    lines: [
      "Your crops are looking wonderful.",
      "Rain tomorrow, I reckon. Saves you watering!",
      "Sunflowers always cheer me up.",
      "Be sure to sleep — overworking ruins the harvest.",
    ],
    name: "Willow",
    react: taste({ fish: "dislike", forage: "love", produce: "like" }),
    role: "the gardener",
    tint: 0xff_d2_d2,
  },
};

export const NPC_IDS = ["willow", "finn", "hazel"] as const satisfies readonly NpcId[];

export const REACTION_DELTA = {
  dislike: -8,
  like: 12,
  love: 25,
  neutral: 5,
} satisfies Record<GiftReaction, number>;
export const REACTION_LINE = {
  dislike: "Hmph. Not really my thing.",
  like: "How thoughtful, thank you!",
  love: "Oh, I LOVE this! Thank you!",
  neutral: "Oh… thanks, I suppose.",
} satisfies Record<GiftReaction, string>;

export const giftable = (item: Item): boolean =>
  item.kind === "produce" ||
  item.kind === "fish" ||
  item.kind === "forage" ||
  item.kind === "animal_product";

export const hearts = (friendship: number): number =>
  // 0..10 hearts, 50 pts each
  Math.min(10, Math.floor(friendship / 50));
