import { MAP_H, MAP_W } from "../config";
import { CROP_ORDER, CROPS, isMature } from "../data/crops";
import type { CropId } from "../data/crops";
import { isJsonNumber, isJsonObject, isJsonString } from "../json";
import type { JsonValue } from "../json";
import type { World } from "../world/world";

// Wire shapes for the co-op farm's soil: a guest's farming intent (an event to
// the host) and the host's per-tile shared keys. Each farmed tile is its own
// primitive key, `t<idx>` → one packed number, so an action sends that one key
// and the SDK's per-key diff keeps everything else off the wire.

/** One tile's farm state — what the shared key packs. */
export interface TileState {
  tilled: boolean;
  watered: boolean;
  crop: CropId | null;
  daysGrown: number;
  /** Crops planted here so far: the current one's generation in claim keys. */
  gen: number;
}

export const BARE_TILE: Readonly<TileState> = {
  crop: null,
  daysGrown: 0,
  gen: 0,
  tilled: false,
  watered: false,
};

/**
 * A guest's farming action, parsed + validated at the wire boundary. A
 * planting names the generation it claimed; harvests and clears need no
 * intent — the host hears their claims' grants.
 */
export type TileIntent =
  | { idx: number; action: "till" | "water" }
  | { idx: number; action: "plant"; crop: CropId; gen: number };

const TILE_COUNT = MAP_W * MAP_H;
const WATERED = 2;
const CROP_UNIT = 4;
/** Crop codes run 1..CROP_SLOTS-1 (0 is no crop), leaving room for new crops
 *  without moving the days field. */
export const CROP_SLOTS = 32;
const DAY_UNIT = CROP_UNIT * CROP_SLOTS;
/** Far past any crop's growthDays; a larger value never reaches the wire. */
const MAX_DAYS = 255;
const GEN_UNIT = DAY_UNIT * (MAX_DAYS + 1);
/** A tile's generation counter (World.gens) holds up to this. */
export const MAX_GEN = 0xff_ff;

const KEY = /^t(?<idx>\d+)$/u;

export const tileKey = (idx: number): string => `t${idx}`;

/** The tile index a shared key names, or null for any other key. */
export const tileIdxOfKey = (key: string): number | null => {
  const digits = KEY.exec(key)?.groups?.idx;
  if (digits === undefined) {
    return null;
  }
  const idx = Number(digits);
  return idx < TILE_COUNT ? idx : null;
};

export const isCropId = (v: JsonValue | undefined): v is CropId =>
  isJsonString(v) && Object.hasOwn(CROPS, v);

const isGen = (v: JsonValue | undefined): v is number =>
  isJsonNumber(v) && Number.isInteger(v) && v >= 0 && v <= MAX_GEN;

const pack = (
  tilled: boolean,
  watered: boolean,
  crop: CropId | null,
  daysGrown: number,
  gen: number,
): number => {
  const code = crop === null ? 0 : CROP_ORDER.indexOf(crop) + 1;
  const days = Math.min(MAX_DAYS, Math.max(0, Math.trunc(daysGrown)));
  return (
    (tilled ? 1 : 0) + (watered ? WATERED : 0) + code * CROP_UNIT + days * DAY_UNIT + gen * GEN_UNIT
  );
};

export const packTile = (s: Readonly<TileState>): number =>
  pack(s.tilled, s.watered, s.crop, s.daysGrown, s.gen);

/** A packed tile off the wire; null when malformed, so it never reaches the
 *  world (an unknown crop would crash rendering and poison the save). */
export const unpackTile = (v: JsonValue | undefined): TileState | null => {
  if (!isJsonNumber(v) || !Number.isSafeInteger(v) || v < 0) {
    return null;
  }
  const gen = Math.floor(v / GEN_UNIT);
  const daysGrown = Math.floor(v / DAY_UNIT) % (MAX_DAYS + 1);
  const code = Math.floor(v / CROP_UNIT) % CROP_SLOTS;
  const crop = code === 0 ? null : CROP_ORDER[code - 1];
  if (!isGen(gen) || crop === undefined) {
    return null;
  }
  return {
    crop,
    daysGrown,
    gen,
    tilled: v % 2 === 1,
    watered: Math.floor(v / WATERED) % 2 === 1,
  };
};

/** The tile's packed state in `world`, allocation-free for whole-map scans. */
export const tileValue = (world: World, idx: number): number => {
  const cs = world.crops.get(idx);
  return pack(
    world.tilled[idx] === 1,
    world.watered[idx] === 1,
    cs ? cs.crop : null,
    cs ? cs.daysGrown : 0,
    world.gens[idx] ?? 0,
  );
};

export const writeTile = (world: World, idx: number, s: Readonly<TileState>): void => {
  world.tilled[idx] = s.tilled ? 1 : 0;
  world.watered[idx] = s.watered ? 1 : 0;
  world.gens[idx] = s.gen;
  if (s.crop === null) {
    world.crops.delete(idx);
  } else {
    world.crops.set(idx, { crop: s.crop, daysGrown: s.daysGrown });
  }
};

export const parseTileIntent = (payload: JsonValue): TileIntent | null => {
  if (!isJsonObject(payload)) {
    return null;
  }
  const { idx, action, crop, gen } = payload;
  if (!isJsonNumber(idx) || !Number.isInteger(idx) || idx < 0 || idx >= TILE_COUNT) {
    return null;
  }
  if (action === "till" || action === "water") {
    return { action, idx };
  }
  return action === "plant" && isCropId(crop) && isGen(gen) && gen > 0
    ? { action, crop, gen, idx }
    : null;
};

/**
 * Host: apply a guest's farming intent where the host's world allows it — the
 * same checks the guest made locally, so a refusal only happens when the two
 * worlds disagree, and the guest's tile then settles back to the host's. A
 * planting must also be the next generation of the tile, the one its claim
 * won. Returns whether the tile changed.
 */
export const applyTileIntent = (world: World, intent: TileIntent): boolean => {
  const { idx } = intent;
  const before = tileValue(world, idx);
  const tilled = world.tilled[idx] === 1;
  switch (intent.action) {
    case "till": {
      if (world.canTill(idx % MAP_W, Math.trunc(idx / MAP_W))) {
        world.tilled[idx] = 1;
      }
      break;
    }
    case "water": {
      if (tilled) {
        world.watered[idx] = 1;
      }
      break;
    }
    case "plant": {
      if (tilled && !world.crops.has(idx) && (world.gens[idx] ?? 0) + 1 === intent.gen) {
        world.crops.set(idx, { crop: intent.crop, daysGrown: 0 });
        world.gens[idx] = intent.gen;
      }
      break;
    }
    // no default
  }
  return tileValue(world, idx) !== before;
};

/**
 * The world's side of a granted harvest: crop `gen` of tile `idx` comes off,
 * its soil drying, if that crop still grows there ripe. Returns whether the
 * tile changed — false when the world already shows it (the harvester's own),
 * or never had that crop.
 */
export const harvestTile = (world: World, idx: number, gen: number): boolean => {
  const cs = world.crops.get(idx);
  if (!cs || world.gens[idx] !== gen || !isMature(CROPS[cs.crop], cs.daysGrown)) {
    return false;
  }
  world.crops.delete(idx);
  world.watered[idx] = 0;
  return true;
};
