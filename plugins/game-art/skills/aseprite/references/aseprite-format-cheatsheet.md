# Aseprite file format (quick cheatsheet for inference)

This is a condensed, implementation-oriented map of `.ase` / `.aseprite` files.

## Mental model

An `.aseprite` file is:
- A **128-byte header** (global sprite settings)
- Followed by **N frames**
- Each frame is a list of **chunks** (layer defs, cels, tags, slices, tilesets, etc.)

Use little-endian for all numbers.

## Header highlights (128 bytes)

- `frames` (WORD): how many frame blocks follow.
- `width` / `height` (WORD)
- `colorDepth` (WORD): `32` RGBA, `16` grayscale (value+alpha), `8` indexed.
- `flags` (DWORD):
  - `1`: layer opacity is valid
  - `2`: group blend/opacity is valid
  - `4`: layers have UUIDs (layer chunk includes UUID)
- `speed` (WORD): deprecated global frame delay; use per-frame duration when available.
- `transparentIndex` (BYTE): indexed sprites only; palette index considered transparent in non-background layers.

## Frame header (16 bytes)

- `bytesInFrame` (DWORD) — can be used for skipping sanity checks.
- `magic` (WORD) must be `0xF1FA`
- `chunkCount` (old/new fields): if old is `0xFFFF`, use new field.
- `durationMs` (WORD) — per-frame duration; if 0, fall back to header speed.

## Chunk parsing rule

Each chunk begins with:
- `chunkSize` (DWORD) includes these 6 bytes
- `chunkType` (WORD)
- then `chunkSize-6` bytes of chunk data

**Rule:** If you don’t recognize `chunkType`, skip by `chunkSize` and continue. Don’t hard-fail.

## Chunk types you’ll infer from most often

- `0x2004` **Layer**: layer list + hierarchy via `childLevel`.
- `0x2005` **Cel**: per frame + per layer placement; can be compressed image, linked cel, or tilemap.
- `0x2018` **Tags**: named animation ranges (direction/repeat).
- `0x2022` **Slice**: frame-keyed rectangles; optionally 9-slice + pivot.
- `0x2019` **Palette**: indexed palette changes; may include per-entry names.
- `0x2023` **Tileset**: embedded or external tileset image; used by tilemap layers/cels.
- `0x2020` **User Data**: attaches text/color/properties to the previous object (special ordering after Tags).
- `0x2006` **Cel Extra**: precise bounds/position/scale hints.

## Cel types (from `0x2005`)

- `0`: Raw image (rare; mostly old files).
- `1`: Linked cel (references a cel in another frame).
- `2`: Compressed image (common): zlib-compressed raw pixel stream.
- `3`: Compressed tilemap: zlib-compressed tile stream + masks for ID/flips.

## Zlib decoding (when needed)

Decoded pixel stream is always **row-major**:
- rows: top → bottom
- cols: left → right
- bytes per pixel depends on `colorDepth`

For inference you often only need:
- expected decoded length: `w*h*bpp`
- bounds of non-transparent pixels (alpha>0, or index!=transparentIndex for indexed)

## Gotchas that break naive importers

- Frame duration can vary per frame; `header.speed` is only a fallback.
- Linked cels require a post-pass if you want bounds/pixels.
- Indexed sprites can have palettes missing/partial; don’t assume 256 colors are present in-file.
- Chunk count uses old/new fields; handle `0xFFFF` correctly.
- Tilemaps are not pixel images; don’t interpret tile payload as RGBA.
