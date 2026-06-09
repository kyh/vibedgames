import type { Item } from "./items";

export type NpcId = "willow" | "finn" | "hazel";

export type GiftReaction = "love" | "like" | "neutral" | "dislike";

export type NpcDef = {
  id: NpcId;
  name: string;
  role: string;
  homeTile: { tx: number; ty: number };
  tint: number;
  greeting: string;
  lines: string[];
  react: (item: Item) => GiftReaction;
};

export const NPCS: Record<NpcId, NpcDef> = {
  willow: {
    id: "willow",
    name: "Willow",
    role: "the gardener",
    homeTile: { tx: 26, ty: 8 },
    tint: 0xffd2d2,
    greeting: "Oh, hello neighbour!",
    lines: [
      "Your crops are looking wonderful.",
      "Rain tomorrow, I reckon. Saves you watering!",
      "Sunflowers always cheer me up.",
      "Be sure to sleep — overworking ruins the harvest.",
    ],
    react: (it) =>
      it.kind === "forage"
        ? "love"
        : it.kind === "produce"
          ? "like"
          : it.kind === "fish"
            ? "dislike"
            : "neutral",
  },
  finn: {
    id: "finn",
    name: "Finn",
    role: "the angler",
    homeTile: { tx: 11, ty: 28 },
    tint: 0xcfe2ff,
    greeting: "Ahoy! Fish biting today?",
    lines: [
      "The big ones come out in the rain.",
      "Pufferfish in summer — tricky little things.",
      "Level up fishing and the reel gets way easier.",
      "Caught a Legend once. Nobody believes me.",
    ],
    react: (it) =>
      it.kind === "fish"
        ? "love"
        : it.kind === "animal_product"
          ? "like"
          : it.kind === "produce"
            ? "dislike"
            : "neutral",
  },
  hazel: {
    id: "hazel",
    name: "Hazel",
    role: "the miner",
    homeTile: { tx: 41, ty: 12 },
    tint: 0xd9d2b0,
    greeting: "Mind the skeletons down there.",
    lines: [
      "Deeper floors, better ore. And worse company.",
      "Crystals fetch a fine price at the store.",
      "Upgrade that combat skill before you go too deep.",
      "Coal keeps the forge going. Bring me some?",
    ],
    react: (it) =>
      it.kind === "resource" && (it.res === "crystal" || it.res === "copper" || it.res === "coal")
        ? "love"
        : it.kind === "fish"
          ? "like"
          : it.kind === "forage"
            ? "dislike"
            : "neutral",
  },
};

export const NPC_IDS = Object.keys(NPCS) as NpcId[];

export const REACTION_DELTA: Record<GiftReaction, number> = {
  love: 25,
  like: 12,
  neutral: 5,
  dislike: -8,
};
export const REACTION_LINE: Record<GiftReaction, string> = {
  love: "Oh, I LOVE this! Thank you!",
  like: "How thoughtful, thank you!",
  neutral: "Oh… thanks, I suppose.",
  dislike: "Hmph. Not really my thing.",
};

export function giftable(item: Item): boolean {
  return (
    item.kind === "produce" ||
    item.kind === "fish" ||
    item.kind === "forage" ||
    item.kind === "animal_product"
  );
}

export function hearts(friendship: number): number {
  return Math.min(10, Math.floor(friendship / 50)); // 0..10 hearts, 50 pts each
}
