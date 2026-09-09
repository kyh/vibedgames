import { MAP_H, MAP_W } from "../config";
import { CROPS, type CropId } from "../data/crops";
import { isJsonNumber, isJsonObject, isJsonString, type JsonObject, type JsonValue } from "../json";

// Wire shapes for the co-op farm: a guest's farming intent (event) and the
// host's authoritative per-tile ledger (shared-state `tiles` blob).

/** A single tile's synced state: tilled, watered, crop id (or null), grow-days. */
export type TileEdit = { t: number; w: number; c: CropId | null; d: number };

/** A guest's farming action, parsed + validated at the wire boundary. */
export type TileIntent = {
  idx: number;
  action: "till" | "water" | "plant" | "harvest";
  crop?: CropId;
};

export type PackedTile = [number, number, string | null, number];

export function isCropId(v: JsonValue | undefined): v is CropId {
  return isJsonString(v) && v in CROPS;
}

export function parseTileIntent(payload: JsonValue): TileIntent | null {
  if (!isJsonObject(payload)) return null;
  const idx = payload["idx"];
  const action = payload["action"];
  const crop = payload["crop"];
  if (!isJsonNumber(idx) || !Number.isInteger(idx) || idx < 0 || idx >= MAP_W * MAP_H) {
    return null;
  }
  if (action === "till" || action === "water" || action === "harvest") return { idx, action };
  // A planted crop id must be a real crop: a bogus one would crash rendering
  // on every client AND poison the save (black screen on every reload).
  if (action === "plant" && isCropId(crop)) return { idx, action, crop };
  return null;
}

/** The shared-state `tiles` ledger: cell index → packed edit. */
export function packTiles(edits: ReadonlyMap<number, TileEdit>): JsonObject {
  return Object.fromEntries(
    Array.from(edits, ([idx, e]): [string, PackedTile] => [String(idx), [e.t, e.w, e.c, e.d]]),
  );
}

/** One ledger entry off the wire; null for a malformed key or shape. */
export function readPackedTile(key: string, packed: JsonValue): [number, TileEdit] | null {
  if (!Array.isArray(packed)) return null;
  const idx = Number(key);
  if (!Number.isInteger(idx) || idx < 0 || idx >= MAP_W * MAP_H) return null;
  const cropRaw = packed[2];
  return [
    idx,
    {
      t: Number(packed[0]) || 0,
      w: Number(packed[1]) || 0,
      // Validate at the boundary: an unknown crop id from the wire must not
      // enter the world (it would crash rendering AND poison the save).
      c: isCropId(cropRaw) ? cropRaw : null,
      d: Number(packed[3]) || 0,
    },
  ];
}

/** Compact change-signature for a synced tile (skip redundant re-renders). */
export function tileSig(e: TileEdit): string {
  return `${e.t}${e.w}${e.c ?? "-"}:${e.d}`;
}
