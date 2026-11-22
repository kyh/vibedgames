import { SEASONS } from "../data/calendar";
import type { Season } from "../data/calendar";
import { CROPS, CROP_ORDER } from "../data/crops";
import type { CropId } from "../data/crops";
import { FISH, FISH_IDS } from "../data/fish";
import type { FishId } from "../data/fish";
import type { Item } from "../data/items";
import { isJsonObject } from "../json";
import type { JsonObject, JsonValue } from "../json";

export type CollectionItem = Extract<Item, { kind: "produce" | "fish" }>;

interface Discovery extends JsonObject {
  season: Season;
  item: CollectionItem;
}

export interface CollectionsJSON extends JsonObject {
  v: 1;
  discoveries: Discovery[];
}

export interface CollectionEntry {
  item: CollectionItem;
  name: string;
  discovered: boolean;
}

export interface CollectionPage {
  season: Season;
  entries: CollectionEntry[];
  discovered: number;
  total: number;
  complete: boolean;
}

export interface CollectionDiscovery {
  season: Season;
  item: CollectionItem;
  name: string;
  completedSeason: boolean;
}

const readItem: (value: JsonValue | undefined) => CollectionItem | null = (value) => {
  if (!isJsonObject(value)) {
    return null;
  }

  if (value.kind === "produce") {
    const crop = CROP_ORDER.find((id) => id === value.crop);

    return crop ? { crop, kind: "produce" } : null;
  }

  if (value.kind === "fish") {
    const fish = FISH_IDS.find((id) => id === value.fish);

    return fish ? { fish, kind: "fish" } : null;
  }

  return null;
};

const same = (a: CollectionItem, b: CollectionItem) =>
  a.kind === "produce"
    ? b.kind === "produce" && a.crop === b.crop
    : b.kind === "fish" && a.fish === b.fish;

const eligible = (item: CollectionItem, season: Season) => {
  if (item.kind === "produce") {
    return CROPS[item.crop].seasons.includes(season);
  }

  const { seasons } = FISH[item.fish];

  return seasons === "all" || seasons.includes(season);
};

const name = (item: CollectionItem) =>
  item.kind === "produce" ? CROPS[item.crop].name : FISH[item.fish].name;

/** Personal discoveries persist across years. No reward or inventory authority. */
export class Collections {
  private readonly discoveries: Discovery[] = [];

  static empty() {
    return new Collections();
  }

  /** Optional save fragment: reject bad entries, never infer from inventory. */
  static fromJSON(value: JsonValue | undefined) {
    const journal = Collections.empty();

    if (!isJsonObject(value) || value.v !== 1 || !Array.isArray(value.discoveries)) {
      return journal;
    }

    for (const raw of value.discoveries) {
      if (!isJsonObject(raw)) {
        continue;
      }

      const season = SEASONS.find((s) => s === raw.season);
      const item = readItem(raw.item);

      if (season && item && eligible(item, season) && !journal.has(item, season)) {
        journal.discoveries.push({ item, season });
      }
    }

    return journal;
  }

  toJSON() {
    return {
      discoveries: this.discoveries.map(({ season, item }) => ({ item: { ...item }, season })),
      v: 1,
    } satisfies CollectionsJSON;
  }

  private has(item: CollectionItem, season: Season) {
    return this.discoveries.some((d) => d.season === season && same(d.item, item));
  }

  page(season: Season) {
    const items: CollectionItem[] = [
      ...CROP_ORDER.map((crop) => ({ crop, kind: "produce" }) satisfies CollectionItem),
      ...FISH_IDS.map((fish) => ({ fish, kind: "fish" }) satisfies CollectionItem),
    ];

    const entries = items.flatMap((item) =>
      eligible(item, season)
        ? [{ discovered: this.has(item, season), item, name: name(item) }]
        : [],
    );

    const discovered = entries.filter((entry) => entry.discovered).length;

    return {
      complete: entries.length > 0 && discovered === entries.length,
      discovered,
      entries,
      season,
      total: entries.length,
    };
  }

  /** Call only after the local harvest's inventory.add reports acceptance. */
  recordHarvest(crop: CropId, season: Season, acceptedQty: number) {
    return this.record({ crop, kind: "produce" }, season, acceptedQty);
  }

  /** Call only after the local catch's inventory.add reports acceptance. */
  recordCatch(fish: FishId, season: Season, acceptedQty: number) {
    return this.record({ fish, kind: "fish" }, season, acceptedQty);
  }

  private record(item: CollectionItem, season: Season, acceptedQty: number) {
    if (
      !Number.isSafeInteger(acceptedQty) ||
      acceptedQty < 1 ||
      !eligible(item, season) ||
      this.has(item, season)
    ) {
      return null;
    }

    this.discoveries.push({ item, season });

    return {
      completedSeason: this.page(season).complete,
      item: { ...item },
      name: name(item),
      season,
    };
  }
}
