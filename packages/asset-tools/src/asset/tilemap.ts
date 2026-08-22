import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";

import { drawDigits, drawLine, fillRect, strokeRect } from "../image/draw.js";
import { Bitmap, type RGBA, readImageSize } from "../image/raster.js";
import {
  isFiniteJsonNumber,
  isJsonObject,
  isJsonString,
  type JsonObject,
  type JsonValue,
  parseJsonText,
} from "./json.js";

/**
 * Headless tileset and tilemap exports, ported from the export half of
 * `asset_tilemap_editor.py`.
 *
 * These answer the question "is my tileset grid actually what the manifest
 * claims?" — the grid overlay shows where the tool thinks tile boundaries
 * are, the self-test map places every non-empty tile at its own coordinate,
 * and the map render composites a tilemap so a wrong `tileWidth` or `margin`
 * is visible at a glance rather than as garbled tiles in-game.
 */

export type TilesetMeta = {
  name: string;
  path: string;
  tileW: number;
  tileH: number;
  columns: number;
  rows: number;
  margin: number;
  spacing: number;
  imageW: number;
  imageH: number;
};

export const MANIFEST_JSON_CANDIDATES = [
  "assets_index.json",
  "asset_index.json",
  "assets/assets_index.json",
  "assets/asset_index.json",
];

/** A tileset entry that passed sanitizing: definitely has a string `path`. */
export type TilesetEntry = { [key: string]: JsonValue; path: string };

/** Coerce a manifest number the way the Python `_int` helper did. */
function asInt(value: JsonValue | undefined, fallback: number): number {
  return isFiniteJsonNumber(value) ? Math.trunc(value) : fallback;
}

export function loadManifestJson(path: string): JsonObject {
  const payload = parseJsonText(readFileSync(path, "utf8"));
  if (!isJsonObject(payload)) {
    throw new Error("Manifest JSON must be an object at top-level.");
  }
  return payload;
}

/** Tilesets that are usable: an object with a string `path`. */
export function sanitizeTilesets(manifest: JsonObject) {
  const tilesets = manifest.tilesets;
  if (!isJsonObject(tilesets)) {
    throw new Error("Manifest missing `tilesets` object.");
  }
  const out: Record<string, TilesetEntry> = {};
  for (const [name, entry] of Object.entries(tilesets)) {
    if (!isJsonObject(entry)) continue;
    const path = entry.path;
    if (!isJsonString(path)) continue;
    out[name] = { ...entry, path };
  }
  if (Object.keys(out).length === 0) {
    throw new Error("Manifest has no usable tilesets (each needs a string `path`).");
  }
  return out;
}

/**
 * Resolve an asset path against the manifest's `meta.root`, then the manifest
 * folder, then the cwd — first hit wins, and the `meta.root` candidate is the
 * fallback when nothing exists so the error names the expected location.
 */
function resolveAssetPath(manifestPath: string, manifest: JsonObject, rel: string): string {
  const manifestDir = resolve(dirname(manifestPath));
  const meta = manifest.meta;
  const root = isJsonObject(meta) && isJsonString(meta.root) ? meta.root : null;
  const base = root === null ? manifestDir : resolve(manifestDir, root);

  if (isAbsolute(rel)) return resolve(rel);
  const candidates = [resolve(base, rel), resolve(manifestDir, rel), resolve(process.cwd(), rel)];
  return candidates.find((c) => existsSync(c)) ?? candidates[0]!;
}

export function tilesetMetaFromManifest(
  manifestPath: string,
  manifest: JsonObject,
  name: string,
): TilesetMeta {
  const tilesets = sanitizeTilesets(manifest);
  const entry = tilesets[name];
  if (!entry) throw new Error(`Tileset not found in manifest: ${name}`);

  const path = resolveAssetPath(manifestPath, manifest, entry.path);
  if (!existsSync(path)) throw new Error(`Tileset file not found: ${path}`);

  const tileW = asInt(entry.tileWidth ?? entry.tileW, 16);
  const tileH = asInt(entry.tileHeight ?? entry.tileH, 16);
  const margin = asInt(entry.margin, 0);
  const spacing = asInt(entry.spacing, 0);

  const size = readImageSize(path);
  if (!size) throw new Error(`Could not read tileset dimensions: ${path}`);

  // A manifest may state the grid explicitly; otherwise derive it from the
  // image, accounting for the margin around the sheet and the gaps between.
  let columns = asInt(entry.columns, 0);
  let rows = asInt(entry.rows, 0);
  if (columns <= 0) {
    const denom = tileW + spacing;
    columns = denom > 0 ? Math.floor((size.width - 2 * margin + spacing) / denom) : 0;
  }
  if (rows <= 0) {
    const denom = tileH + spacing;
    rows = denom > 0 ? Math.floor((size.height - 2 * margin + spacing) / denom) : 0;
  }
  if (columns <= 0 || rows <= 0) {
    throw new Error(`Invalid tileset grid for ${name}: columns=${columns} rows=${rows}`);
  }

  return {
    name,
    path,
    tileW,
    tileH,
    columns,
    rows,
    margin,
    spacing,
    imageW: size.width,
    imageH: size.height,
  };
}

export function tileCount(meta: TilesetMeta): number {
  return meta.columns * meta.rows;
}

/** Tile IDs are 1-based in row-major order; 0 means "no tile". */
export function tileIdFromColRow(meta: TilesetMeta, col: number, row: number): number {
  if (col < 0 || row < 0 || col >= meta.columns || row >= meta.rows) return 0;
  return row * meta.columns + col + 1;
}

function colRowFromTileId(meta: TilesetMeta, tileId: number): [number, number] {
  if (tileId <= 0) return [0, 0];
  const index = tileId - 1;
  const row = Math.floor(index / meta.columns);
  return [index - row * meta.columns, row];
}

/** Source rectangle of a tile within the sheet, honouring margin and spacing. */
export function cropBox(meta: TilesetMeta, tileId: number) {
  const [col, row] = colRowFromTileId(meta, tileId);
  const left = meta.margin + col * (meta.tileW + meta.spacing);
  const top = meta.margin + row * (meta.tileH + meta.spacing);
  return { left, top, right: left + meta.tileW, bottom: top + meta.tileH };
}

function trimTransparent(image: Bitmap): Bitmap {
  const bbox = image.getBBox();
  return bbox ? image.crop(bbox) : image;
}

/** Overlay the assumed tile grid on the tileset, optionally labelling IDs. */
export function exportTilesetGrid(
  meta: TilesetMeta,
  outPath: string,
  options: { scale: number; labelIds: boolean; trim: boolean },
): void {
  const scale = Math.max(1, Math.trunc(options.scale));
  let image = Bitmap.fromFile(meta.path);
  if (scale !== 1) image = image.resize(image.width * scale, image.height * scale, "nearest");

  const line: RGBA = [255, 255, 255, 80];
  const bold: RGBA = [47, 230, 255, 180];
  const x0 = meta.margin * scale;
  const y0 = meta.margin * scale;
  const stepX = (meta.tileW + meta.spacing) * scale;
  const stepY = (meta.tileH + meta.spacing) * scale;
  const width =
    meta.columns * meta.tileW * scale + Math.max(0, (meta.columns - 1) * meta.spacing * scale);
  const height =
    meta.rows * meta.tileH * scale + Math.max(0, (meta.rows - 1) * meta.spacing * scale);

  for (let c = 0; c <= meta.columns; c += 1) {
    const x = x0 + c * stepX;
    drawLine(image, x, y0, x, y0 + height, line);
  }
  for (let r = 0; r <= meta.rows; r += 1) {
    const y = y0 + r * stepY;
    drawLine(image, x0, y, x0 + width, y, line);
  }
  strokeRect(image, x0, y0, x0 + width, y0 + height, bold, 2);

  if (options.labelIds) {
    for (let r = 0; r < meta.rows; r += 1) {
      for (let c = 0; c < meta.columns; c += 1) {
        const id = String(tileIdFromColRow(meta, c, r));
        const tx = x0 + c * stepX + 2;
        const ty = y0 + r * stepY + 2;
        // Shadow first, then the light face, so IDs stay readable over both
        // dark and light tiles.
        drawDigits(image, tx + 1, ty + 1, id, [0, 0, 0, 180]);
        drawDigits(image, tx, ty, id, [255, 255, 255, 200]);
      }
    }
  }

  (options.trim ? trimTransparent(image) : image).toFile(outPath);
}

export type FillRect = { x: number; y: number; w: number; h: number; color: RGBA };

/** Composite a tilemap into a PNG using the tileset it names. */
export function exportMapRender(
  meta: TilesetMeta,
  outPath: string,
  options: {
    mapPayload: JsonObject;
    scale: number;
    background: RGBA | null;
    fills: FillRect[];
    trim: boolean;
  },
): void {
  const scale = Math.max(1, Math.trunc(options.scale));
  const data = options.mapPayload.data;
  if (!Array.isArray(data)) throw new Error("Map JSON must have `data` as a 2D array.");

  const mapMeta = options.mapPayload.meta;
  let width = isJsonObject(mapMeta) ? asInt(mapMeta.width, 0) : 0;
  let height = isJsonObject(mapMeta) ? asInt(mapMeta.height, 0) : 0;
  if (width <= 0) {
    width = data.reduce<number>(
      (max, row) => (Array.isArray(row) ? Math.max(max, row.length) : max),
      0,
    );
  }
  if (height <= 0) height = data.length;
  if (width <= 0 || height <= 0) throw new Error("Invalid map dimensions.");

  const grid = normalizeMapData(data, width, height);
  const sheet = Bitmap.fromFile(meta.path);
  let out = Bitmap.create(
    width * meta.tileW,
    height * meta.tileH,
    options.background ?? [0, 0, 0, 0],
  );

  for (const fill of options.fills) {
    fillRect(
      out,
      fill.x * meta.tileW,
      fill.y * meta.tileH,
      (fill.x + fill.w) * meta.tileW,
      (fill.y + fill.h) * meta.tileH,
      fill.color,
    );
  }

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const id = grid[y]![x]!;
      if (id <= 0) continue;
      out.alphaComposite(sheet.crop(cropBox(meta, id)), x * meta.tileW, y * meta.tileH);
    }
  }

  if (scale !== 1) out = out.resize(out.width * scale, out.height * scale, "nearest");
  (options.trim ? trimTransparent(out) : out).toFile(outPath);
}

/** Tile IDs whose cell contains at least one non-transparent pixel. */
export function nonEmptyTileIds(meta: TilesetMeta): Set<number> {
  const image = Bitmap.fromFile(meta.path);
  const out = new Set<number>();
  for (let id = 1; id <= tileCount(meta); id += 1) {
    if (image.crop(cropBox(meta, id)).getBBox()) out.add(id);
  }
  return out;
}

/** Bounds on a map's dimensions, so a malformed file can't allocate wildly. */
export const MAP_MIN = 1;
export const MAP_MAX = 512;

export type TilemapDoc = {
  meta: {
    version: number;
    tileset: string;
    tileWidth: number;
    tileHeight: number;
    width: number;
    height: number;
  };
  data: number[][];
};

/** An all-empty map of the given size. */
export function newMap(width: number, height: number): number[][] {
  return Array.from({ length: height }, () => new Array<number>(width).fill(0));
}

/**
 * Coerce loaded `data` to exactly width × height of integers.
 *
 * A hand-edited or engine-written map can be ragged, short, or carry
 * non-numbers; rather than reject it, pad and truncate to the declared size so
 * the file stays openable and the damage is visible on screen.
 */
export function normalizeMapData(data: JsonValue, width: number, height: number): number[][] {
  const rows = Array.isArray(data) ? data : [];
  const out = newMap(width, height);
  for (let y = 0; y < height; y += 1) {
    const row = rows[y];
    if (!Array.isArray(row)) continue;
    for (let x = 0; x < width; x += 1) {
      const cell = row[x];
      out[y]![x] = isFiniteJsonNumber(cell) ? Math.trunc(cell) : 0;
    }
  }
  return out;
}

/** The on-disk shape a map is saved in. */
export function tilemapPayload(
  meta: TilesetMeta,
  width: number,
  height: number,
  data: number[][],
): TilemapDoc {
  return {
    meta: {
      version: 1,
      tileset: meta.name,
      tileWidth: meta.tileW,
      tileHeight: meta.tileH,
      width,
      height,
    },
    data,
  };
}

/**
 * Read a saved map, clamped to sane dimensions.
 *
 * `tileset` is passed through when the file names one, so the editor can
 * follow a map back to the tileset it was drawn with.
 */
export function parseTilemap(payload: JsonValue, fallback: { width: number; height: number }) {
  if (!isJsonObject(payload)) {
    throw new Error("Map JSON must be an object.");
  }
  const meta = payload.meta;
  if (!isJsonObject(meta) || !Array.isArray(payload.data)) {
    throw new Error("Map JSON must have a `meta` object and a `data` array.");
  }
  const clamp = (value: number) => Math.max(MAP_MIN, Math.min(MAP_MAX, value));
  const width = clamp(asInt(meta.width, fallback.width));
  const height = clamp(asInt(meta.height, fallback.height));
  return {
    width,
    height,
    data: normalizeMapData(payload.data, width, height),
    tileset: isJsonString(meta.tileset) ? meta.tileset : null,
  };
}

/**
 * A tilemap that places every non-empty tile at its own grid coordinate.
 * Rendering it should reproduce the tileset exactly — if it doesn't, the
 * grid metadata is wrong.
 */
export function makeSelftestMap(meta: TilesetMeta) {
  const nonEmpty = nonEmptyTileIds(meta);
  const data: number[][] = [];
  for (let r = 0; r < meta.rows; r += 1) {
    const row: number[] = [];
    for (let c = 0; c < meta.columns; c += 1) {
      const id = tileIdFromColRow(meta, c, r);
      row.push(nonEmpty.has(id) ? id : 0);
    }
    data.push(row);
  }

  return {
    meta: {
      version: 1,
      tileset: meta.name,
      tileWidth: meta.tileW,
      tileHeight: meta.tileH,
      width: meta.columns,
      height: meta.rows,
      generatedFrom: meta.path.split(/[/\\]/).join("/"),
      generator: "asset-tilemap-editor.mjs --make-selftest-map",
    },
    data,
  };
}
