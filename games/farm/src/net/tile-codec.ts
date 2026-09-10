import { MAP_H, MAP_W } from "../config";
import { CROPS } from "../data/crops";
import type { CropId } from "../data/crops";
import { isJsonNumber, isJsonObject, isJsonString } from "../json";
import type { JsonObject, JsonValue } from "../json";

// Wire shapes for the co-op farm: a guest's farming intent (event) and the
// host's authoritative per-tile ledger (shared-state `tiles` blob).

/** A single tile's synced state: tilled, watered, crop id (or null), grow-days. */
export interface TileEdit {
  t: number;
  w: number;
  c: CropId | null;
  d: number;
}

/** A guest's farming action, parsed + validated at the wire boundary. */
export interface TileIntent {
  idx: number;
  action: "till" | "water" | "plant" | "harvest";
  crop?: CropId;
}

export type PackedTile = [number, number, string | null, number];

export const isCropId = (v: JsonValue | undefined): v is CropId => isJsonString(v) && v in CROPS;

export const parseTileIntent = (payload: JsonValue): TileIntent | null => {
  if (!isJsonObject(payload)) {
    return null;
  }
  const { idx } = payload;
  const { action } = payload;
  const { crop } = payload;
  if (!isJsonNumber(idx) || !Number.isInteger(idx) || idx < 0 || idx >= MAP_W * MAP_H) {
    return null;
  }
  if (action === "till" || action === "water" || action === "harvest") {
    return { action, idx };
  }
  // A planted crop id must be a real crop: a bogus one would crash rendering
  // on every client AND poison the save (black screen on every reload).
  if (action === "plant" && isCropId(crop)) {
    return { action, crop, idx };
  }
  return null;
};

/** The shared-state `tiles` ledger: cell index → packed edit. */
export const packTiles = (edits: ReadonlyMap<number, TileEdit>): JsonObject =>
  Object.fromEntries(
    Array.from(edits, ([idx, e]): [string, PackedTile] => [String(idx), [e.t, e.w, e.c, e.d]]),
  );

/** One ledger entry off the wire; null for a malformed key or shape. */
export const readPackedTile = (key: string, packed: JsonValue): [number, TileEdit] | null => {
  if (!Array.isArray(packed)) {
    return null;
  }
  const idx = Number(key);
  if (!Number.isInteger(idx) || idx < 0 || idx >= MAP_W * MAP_H) {
    return null;
  }
  const [t, w, cropRaw, d] = packed;
  // Validate at the boundary: an unknown crop id from the wire must not
  // enter the world (it would crash rendering AND poison the save).
  const c = isCropId(cropRaw) ? cropRaw : null;
  return [idx, { c, d: Number(d) || 0, t: Number(t) || 0, w: Number(w) || 0 }];
};

/** Compact change-signature for a synced tile (skip redundant re-renders). */
export const tileSig = (e: TileEdit): string => `${e.t}${e.w}${e.c ?? "-"}:${e.d}`;
