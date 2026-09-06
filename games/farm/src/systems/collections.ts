import { SEASONS, type Season } from "../data/calendar";
import { CROPS, CROP_ORDER, type CropId } from "../data/crops";
import { FISH, FISH_IDS, type FishId } from "../data/fish";
import type { Item } from "../data/items";
import { isJsonObject, type JsonValue } from "../json";

export type CollectionItem = Extract<Item, { kind: "produce" | "fish" }>;
type Discovery = { season: Season; item: CollectionItem };
export type CollectionsJSON = { v: 1; discoveries: Discovery[] };
export type CollectionEntry = { item: CollectionItem; name: string; discovered: boolean };
export type CollectionPage = {
  season: Season;
  entries: CollectionEntry[];
  discovered: number;
  total: number;
  complete: boolean;
};
export type CollectionDiscovery = {
  season: Season;
  item: CollectionItem;
  name: string;
  completedSeason: boolean;
};

function readItem(value: JsonValue | undefined): CollectionItem | null {
  if (!isJsonObject(value)) return null;
  if (value.kind === "produce") {
    const crop = CROP_ORDER.find((id) => id === value.crop);
    return crop ? { kind: "produce", crop } : null;
  }
  if (value.kind === "fish") {
    const fish = FISH_IDS.find((id) => id === value.fish);
    return fish ? { kind: "fish", fish } : null;
  }
  return null;
}

function same(a: CollectionItem, b: CollectionItem): boolean {
  return a.kind === "produce"
    ? b.kind === "produce" && a.crop === b.crop
    : b.kind === "fish" && a.fish === b.fish;
}

function eligible(item: CollectionItem, season: Season): boolean {
  if (item.kind === "produce") return CROPS[item.crop].seasons.includes(season);
  const seasons = FISH[item.fish].seasons;
  return seasons === "all" || seasons.includes(season);
}

function name(item: CollectionItem): string {
  return item.kind === "produce" ? CROPS[item.crop].name : FISH[item.fish].name;
}

/** Personal discoveries persist across years. No reward or inventory authority. */
export class Collections {
  private readonly discoveries: Discovery[] = [];

  static empty(): Collections {
    return new Collections();
  }

  /** Optional save fragment: reject bad entries, never infer from inventory. */
  static fromJSON(value: JsonValue | undefined): Collections {
    const journal = Collections.empty();
    if (!isJsonObject(value) || value.v !== 1 || !Array.isArray(value.discoveries)) return journal;
    for (const raw of value.discoveries) {
      if (!isJsonObject(raw)) continue;
      const season = SEASONS.find((s) => s === raw.season);
      const item = readItem(raw.item);
      if (season && item && eligible(item, season) && !journal.has(item, season))
        journal.discoveries.push({ season, item });
    }
    return journal;
  }

  toJSON(): CollectionsJSON {
    return {
      v: 1,
      discoveries: this.discoveries.map(({ season, item }) => ({ season, item: { ...item } })),
    };
  }

  private has(item: CollectionItem, season: Season): boolean {
    return this.discoveries.some((d) => d.season === season && same(d.item, item));
  }

  page(season: Season): CollectionPage {
    const items: CollectionItem[] = [
      ...CROP_ORDER.map((crop): CollectionItem => ({ kind: "produce", crop })),
      ...FISH_IDS.map((fish): CollectionItem => ({ kind: "fish", fish })),
    ];
    const entries = items
      .filter((item) => eligible(item, season))
      .map((item) => ({ item, name: name(item), discovered: this.has(item, season) }));
    const discovered = entries.filter((entry) => entry.discovered).length;
    return {
      season,
      entries,
      discovered,
      total: entries.length,
      complete: entries.length > 0 && discovered === entries.length,
    };
  }

  /** Call only after the local harvest's inventory.add reports acceptance. */
  recordHarvest(crop: CropId, season: Season, acceptedQty: number): CollectionDiscovery | null {
    return this.record({ kind: "produce", crop }, season, acceptedQty);
  }

  /** Call only after the local catch's inventory.add reports acceptance. */
  recordCatch(fish: FishId, season: Season, acceptedQty: number): CollectionDiscovery | null {
    return this.record({ kind: "fish", fish }, season, acceptedQty);
  }

  private record(
    item: CollectionItem,
    season: Season,
    acceptedQty: number,
  ): CollectionDiscovery | null {
    if (
      !Number.isSafeInteger(acceptedQty) ||
      acceptedQty < 1 ||
      !eligible(item, season) ||
      this.has(item, season)
    )
      return null;
    this.discoveries.push({ season, item });
    return {
      season,
      item: { ...item },
      name: name(item),
      completedSeason: this.page(season).complete,
    };
  }
}
